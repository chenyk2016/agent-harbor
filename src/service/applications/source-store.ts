/** 平台拥有Git历史。调用方先持有App写入门并确认开发写入者停止，再调用snapshot。 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  writeFile,
  rm,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { readAppMigration } from "./migrations.js";
import { fail } from "../types.js";
import { lockSession } from "../../runtime/storage.js";

const exec = promisify(execFile);
export const appIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** 校验用于源码目录的应用编号，防止无效标识或路径内容进入平台存储路径。 */
export function requireAppId(id: string) {
  if (!appIdPattern.test(id)) throw new Error("INVALID_APP_ID");
  return id;
}
/** 固定源码快照的引用与指纹；commit 用于重建同一输入，sourceHash 用于判断文件内容是否变化。 */
export interface SourceRevision {
  appId: string;
  commit: string;
  sourceHash: string;
  files: number;
  bytes: number;
  createdAt: number;
}
const rootFiles = new Set([
  "harbor-app.json",
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.ts",
  "vite.config.mjs",
  "tsconfig.json",
  "tsconfig.server.json",
]);
const roots = new Set(["src", "server", "public", "migrations"]);
const forbidden =
  /^(?:\.git|\.env(?:\..*)?|node_modules|dist|dist-server|\.cache)$/;

/** 管理平台拥有的应用 bare Git 仓库，按允许的源码范围保存和导出版本，Agent 不直接持有历史仓库。 */
export class ApplicationSources {
  readonly root: string;
  /** 规范化源码存储根目录；每个应用在该根目录下拥有独立仓库和快照元信息。 */
  constructor(root: string) {
    this.root = resolve(root);
  }
  /** 返回指定应用的源码历史目录，并在拼接路径前验证应用编号。 */
  directory(appId: string) {
    return join(this.root, "sources", requireAppId(appId));
  }
  /** 对平台仓库执行受控 Git 命令，禁用 hooks 和用户全局配置，并固定提交身份及执行上限。 */
  private async git(
    appId: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    return exec(
      "git",
      [
        "--git-dir",
        join(this.directory(appId), "repository.git"),
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: options.cwd,
        timeout: 30000,
        maxBuffer: 25 * 1024 * 1024,
        encoding: "buffer",
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Agent Harbor",
          GIT_AUTHOR_EMAIL: "harbor@localhost",
          GIT_COMMITTER_NAME: "Agent Harbor",
          GIT_COMMITTER_EMAIL: "harbor@localhost",
          ...options.env,
        },
      },
    );
  }
  /** 调用方确认开发写入者停止后，在仓库锁内筛选源码、校验读取稳定性并保存 Git 提交与内容指纹。 */
  async snapshot(appId: string, source: string): Promise<SourceRevision> {
    const directory = this.directory(appId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockSession(directory);
    const staging = join(directory, "staging-" + randomUUID());
    try {
      try {
        await lstat(join(directory, "repository.git"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await exec(
          "git",
          [
            "init",
            "--template=",
            "--bare",
            "--object-format=sha1",
            join(directory, "repository.git"),
          ],
          {
            env: {
              PATH: process.env.PATH,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        );
      }
      await mkdir(staging, { mode: 0o700 });
      const hash = createHash("sha256");
      let files = 0,
        bytes = 0;
      const sampled: {
        path: string;
        size: number;
        mtimeMs: number;
        ino: number;
      }[] = [];
      const sourceRoot = resolve(source);
      if (
        !(await lstat(sourceRoot)).isDirectory() ||
        (await lstat(sourceRoot)).isSymbolicLink()
      )
        throw new Error("INVALID_SOURCE_ROOT");
      /** 递归收集允许的源码文件，检查层级、体积和文件类型，复制时记录内容与文件元信息供稳定性核对。 */
      const walk = async (relative: string, depth: number): Promise<void> => {
        if (depth > 24) throw new Error("SOURCE_DEPTH_LIMIT");
        for (const name of (await readdir(join(sourceRoot, relative))).sort()) {
          if (/[\x00-\x1f\\]/.test(name))
            throw new Error("INVALID_SOURCE_PATH");
          if (forbidden.test(name)) continue;
          const child = relative ? relative + "/" + name : name;
          if (!relative && !rootFiles.has(name) && !roots.has(name)) continue;
          const path = join(sourceRoot, child),
            before = await lstat(path);
          if (before.isSymbolicLink()) throw new Error("SOURCE_SYMLINK_DENIED");
          if (before.isDirectory()) {
            await mkdir(join(staging, child), { recursive: true });
            await walk(child, depth + 1);
          } else {
            if (!before.isFile() || before.nlink !== 1)
              throw new Error("SOURCE_SPECIAL_FILE_DENIED");
            if (++files > 2000 || (bytes += before.size) > 20 * 1024 * 1024)
              throw new Error("SOURCE_LIMIT");
            const data = await readFile(path),
              after = await lstat(path);
            if (
              before.ino !== after.ino ||
              before.size !== after.size ||
              before.mtimeMs !== after.mtimeMs ||
              data.length !== before.size
            )
              throw new Error("SOURCE_CHANGED");
            sampled.push({
              path,
              size: after.size,
              mtimeMs: after.mtimeMs,
              ino: after.ino,
            });
            await writeFile(join(staging, child), data, { mode: 0o644 });
            hash
              .update(child + "\0")
              .update(String(data.length) + "\0")
              .update(data);
          }
        }
      };
      await walk("", 0);
      for (const entry of sampled) {
        const stat = await lstat(entry.path);
        if (
          stat.size !== entry.size ||
          stat.ino !== entry.ino ||
          stat.mtimeMs !== entry.mtimeMs
        )
          throw new Error("SOURCE_CHANGED");
      }
      for (const name of [
        "harbor-app.json",
        "package.json",
        "package-lock.json",
        "index.html",
      ])
        await lstat(join(staging, name));
      const index = join(directory, "index-" + randomUUID());
      try {
        const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: staging };
        await this.git(appId, ["read-tree", "--empty"], { env });
        await this.git(appId, ["add", "--all", "--", "."], {
          cwd: staging,
          env,
        });
        const tree = (await this.git(appId, ["write-tree"], { env })).stdout
          .toString()
          .trim();
        let parent = "";
        try {
          parent = (
            await this.git(appId, ["rev-parse", "--verify", "refs/heads/main"])
          ).stdout
            .toString()
            .trim();
        } catch {
          /* 新仓库没有head。 */
        }
        const commit = (
          await this.git(appId, [
            "commit-tree",
            tree,
            ...(parent ? ["-p", parent] : []),
            "-m",
            "Application source snapshot",
          ])
        ).stdout
          .toString()
          .trim();
        await this.git(appId, [
          "update-ref",
          "refs/heads/main",
          commit,
          ...(parent ? [parent] : []),
        ]);
        await this.git(appId, [
          "update-ref",
          `refs/harbor/revisions/${commit}`,
          commit,
        ]);
        const revision = {
          appId,
          commit,
          sourceHash: hash.digest("hex"),
          files,
          bytes,
          createdAt: Date.now(),
        };
        await writeFile(
          join(directory, commit + ".json"),
          JSON.stringify(revision),
          { mode: 0o600 },
        );
        return revision;
      } finally {
        await rm(index, { force: true });
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
      await release();
    }
  }
  /** 从固定提交读取迁移，避免构建期间的工作区编辑改变已批准脚本。 */
  async migrations(revision: SourceRevision) {
    if (!/^[0-9a-f]{40}$/.test(revision.commit)) fail(409, "INVALID_APP_REVISION");
    const { stdout } = await this.git(revision.appId, [
      "ls-tree", "-rz", "--name-only", revision.commit, "--", "migrations/",
    ]);
    const paths = stdout.toString().split("\0").filter(Boolean).sort();
    if (paths.length > 100) fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
    const files = [];
    let previous = -1;
    for (const path of paths) {
      const match = /^migrations\/(\d{3})_[a-z0-9_]{1,48}\.sql$/.exec(path);
      if (!match || Number(match[1]) <= previous) fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
      previous = Number(match[1]);
      const result = await this.git(revision.appId, ["show", revision.commit + ":" + path]);
      files.push(readAppMigration(path.slice("migrations/".length), result.stdout.toString()));
    }
    return files;
  }

  /** 从固定提交及对应指纹重建目录并核验内容，供构建或下载使用；不从仍可变化的开发工作区取文件。 */
  async export(revision: SourceRevision, destination: string) {
    if (!/^[a-f0-9]{40}$/.test(revision.commit))
      throw new Error("INVALID_SOURCE_REVISION");
    const registered = JSON.parse(
      await readFile(
        join(this.directory(revision.appId), revision.commit + ".json"),
        "utf8",
      ),
    ) as SourceRevision;
    if (
      registered.sourceHash !== revision.sourceHash ||
      registered.appId !== revision.appId
    )
      throw new Error("SOURCE_REVISION_MISMATCH");
    await mkdir(destination, { recursive: true });
    const tree = (
      await this.git(revision.appId, ["ls-tree", "-r", "-z", revision.commit])
    ).stdout.toString();
    for (const entry of tree.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (
        !match ||
        match[3].split("/").some((part) => ["", ".", ".."].includes(part)) ||
        /[\\\x00-\x1f]/.test(match[3])
      )
        throw new Error("INVALID_SOURCE_TREE");
      const path = join(destination, match[3]);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        (await this.git(revision.appId, ["cat-file", "blob", match[2]])).stdout,
        { flag: "wx", mode: 0o644 },
      );
    }
    await chmod(destination, 0o755);
  }
}
