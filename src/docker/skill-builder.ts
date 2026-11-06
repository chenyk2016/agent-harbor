/** 依赖准备只在离线容器安装。下载是平台限定HTTPS源的字节传输，不在宿主执行用户包管理器。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  chmod,
  readdir,
  lstat,
  readlink,
  rename,
  readFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fetch, ProxyAgent } from "undici";
import { DockerBackend } from "./docker.js";
import type { SkillManifest } from "../service/skills/manifest.js";
import type { SourceFile } from "../service/skills/package-store.js";

const quote = (text: string) => "'" + text.replace(/'/g, "'\"'\"'") + "'";
export class SkillBuilder {
  readonly backend: DockerBackend;
  private readonly proxy = process.env.AH_PACKAGE_PROXY
    ? new ProxyAgent(process.env.AH_PACKAGE_PROXY)
    : undefined;
  async close() {
    await this.proxy?.close();
  }
  constructor(
    readonly root: string,
    readonly image = process.env.AH_SKILL_IMAGE ?? "agent-harbor:0.5.5",
  ) {
    this.backend = new DockerBackend(root);
  }
  imageId() {
    return this.backend.imageId(this.image);
  }
  async stop(name: string) {
    await this.backend.stop(name);
    await this.backend.destroy(name);
  }
  /** 主机只读取固定包源：URL/重定向均检查，完整性来自发布锁文件，不从自然语言猜依赖。 */
  private async download(
    url: string,
    hosts: string[],
    signal: AbortSignal,
    expected?: string,
  ) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password ||
      !hosts.includes(target.hostname)
    )
      throw new Error("Package source is not supported");
    const response = await fetch(target, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
      dispatcher: this.proxy,
    });
    if (!response.ok || !response.body)
      throw new Error(`Package download failed (${response.status})`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024)
        throw new Error("Dependency file exceeds 100MiB");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (expected) {
      const [algorithm, encoded] = expected.split("-", 2);
      if (
        !["sha256", "sha512"].includes(algorithm) ||
        createHash(algorithm).update(bytes).digest("base64") !== encoded
      )
        throw new Error("Dependency integrity mismatch");
    }
    return bytes;
  }
  async materials(
    files: SourceFile[],
    manifest: SkillManifest,
    destination: string,
    signal: AbortSignal,
  ) {
    await mkdir(destination, { recursive: true });
    const file = (path: string) => {
      const found = files.find((file) => file.path === path);
      if (!found) throw new Error("Dependency lock is missing");
      return found.content.toString("utf8");
    };
    let downloaded = 0,
      count = 0;
    const save = async (name: string, bytes: Buffer) => {
      downloaded += bytes.length;
      if (++count > 200 || downloaded > 512 * 1024 * 1024)
        throw new Error("Dependency materials exceed limit");
      await writeFile(join(destination, name), bytes);
    };
    const dependencies = manifest.harbor?.dependencies;
    if (dependencies?.python) {
      // 首版要求每条依赖固定版本及至少一个SHA256；传递依赖也必须显式锁定。
      const lines = file(dependencies.python.lockFile)
        .replace(/\\\r?\n/g, " ")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (lines.length > 100) throw new Error("Too many Python dependencies");
      for (const line of lines) {
        const match =
          /^([a-zA-Z0-9][a-zA-Z0-9._-]*)==([a-zA-Z0-9.+_-]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)$/.exec(
            line,
          );
        if (!match)
          throw new Error(
            "Python lock requires exact versions and SHA256 hashes; indexes, URLs and markers are not supported",
          );
        const hashes = [...match[3].matchAll(/sha256:([a-f0-9]{64})/g)].map(
          (match) => match[1],
        );
        const metadata = JSON.parse(
          (
            await this.download(
              `https://pypi.org/pypi/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/json`,
              ["pypi.org"],
              signal,
            )
          ).toString("utf8"),
        );
        const wheels = metadata.urls.filter(
          (item: any) =>
            item.packagetype === "bdist_wheel" &&
            hashes.includes(item.digests?.sha256),
        );
        if (!wheels.length || wheels.length > 20)
          throw new Error("No supported locked wheel found");
        for (const wheel of wheels) {
          if (!/^[a-zA-Z0-9_.+-]+\.whl$/.test(wheel.filename))
            throw new Error("Invalid wheel name");
          await save(
            wheel.filename,
            await this.download(
              wheel.url,
              ["files.pythonhosted.org"],
              signal,
              "sha256-" +
                Buffer.from(wheel.digests.sha256, "hex").toString("base64"),
            ),
          );
        }
      }
    }
    if (dependencies?.node) {
      const lock = JSON.parse(file(dependencies.node.lockFile));
      if (
        ![2, 3].includes(lock.lockfileVersion) ||
        !lock.packages ||
        typeof lock.packages !== "object"
      )
        throw new Error("Node requires package-lock version 2 or 3");
      const seen = new Set<string>();
      for (const [path, item] of Object.entries(lock.packages) as [
        string,
        any,
      ][]) {
        if (!path) continue;
        if (
          item.link ||
          typeof item.resolved !== "string" ||
          typeof item.integrity !== "string" ||
          !/^sha(256|512)-[A-Za-z0-9+/]+=*$/.test(item.integrity)
        )
          throw new Error(
            "Node dependency needs a registry URL and integrity; local/git links are unavailable",
          );
        if (seen.has(item.integrity)) continue;
        seen.add(item.integrity);
        await save(
          `node-${seen.size}.tgz`,
          await this.download(
            item.resolved,
            ["registry.npmjs.org"],
            signal,
            item.integrity,
          ),
        );
      }
    }
    return { files: count, bytes: downloaded };
  }
  async build(
    input: {
      name: string;
      imageId: string;
      source: string;
      output: string;
      materials: string;
      manifest: SkillManifest;
      namespace: string;
    },
    signal: AbortSignal,
    log: (text: string) => Promise<void>,
  ) {
    const { manifest } = input,
      commands: string[] = [
        "set -eu",
        "cp -R /source/. /artifact/",
        "mkdir -p /artifact/.harbor-runtime/bin",
      ];
    const dependencies = manifest.harbor?.dependencies;
    if (dependencies?.python)
      commands.push(
        `python3 -m pip install --no-index --find-links=/downloads --only-binary=:all: --require-hashes --no-compile --target /artifact/.harbor-runtime/python-libs -r ${quote("/source/" + dependencies.python.lockFile)}`,
      );
    if (dependencies?.node)
      commands.push(
        'for file in /downloads/node-*.tgz; do [ ! -e "$file" ] || npm cache add "$file" --offline --ignore-scripts --cache /tmp/npm-cache; done',
        "cd /artifact",
        "npm ci --offline --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache",
      );
    await mkdir(input.output, { recursive: true });
    await this.backend.command([
      "create",
      "--name",
      input.name,
      "--label",
      "io.agent-harbor.project=agent-harbor",
      "--label",
      `harbor.owner=${this.backend.owner}`,
      "--label",
      "harbor.purpose=skill-build",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,size=512m,mode=1777",
      "--mount",
      `type=bind,src=${input.source},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${input.materials},dst=/downloads,readonly`,
      "--mount",
      `type=bind,src=${input.output},dst=/artifact`,
      "--env",
      "HOME=/tmp",
      "--env",
      "PIP_DISABLE_PIP_VERSION_CHECK=1",
      "--entrypoint",
      "sh",
      input.imageId,
      "-c",
      commands.join("\n"),
    ]);
    let writes = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["start", "--attach", input.name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const abort = () => {
        child.kill();
        reject(new Error("Build cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          writes = writes.then(() => log(String(chunk).slice(0, 16_000)));
        });
      child.on("error", reject);
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        code === 0
          ? resolve()
          : reject(new Error(`Offline preparation exited ${code}`));
      });
      if (signal.aborted) abort();
    });
    await writes;
    const prefix = `/opt/harbor-skills/${input.namespace}/skills/${manifest.name}`;
    const instructions: string[] = [];
    for (const entry of manifest.harbor?.entrypoints ?? []) {
      const target = `${prefix}/${entry.script}`;
      const command =
        entry.language === "python"
          ? `export PYTHONPATH=${quote(prefix + "/.harbor-runtime/python-libs")}\nexec python3 ${quote(target)} "$@"`
          : `exec node ${quote(target)} "$@"`;
      await writeFile(
        join(input.output, ".harbor-runtime/bin", entry.name),
        `#!/bin/sh\n${command}\n`,
        { mode: 0o755 },
      );
      instructions.push(
        `${entry.name}: ${prefix}/.harbor-runtime/bin/${entry.name}`,
      );
    }
    if (instructions.length)
      await writeFile(
        join(input.output, "SKILL.md"),
        (await readFile(join(input.output, "SKILL.md"), "utf8")) +
          "\n\n## 平台运行入口\n使用下面的入口运行脚本，参数原样传递；成果写入/workspace。\n" +
          instructions.join("\n") +
          "\n",
      );
    await writeFile(
      join(input.output, ".harbor-runtime/runtime.json"),
      JSON.stringify({
        imageId: input.imageId,
        namespace: input.namespace,
        name: manifest.name,
      }),
    );
    return this.artifactHash(input.output);
  }
  /** npm生成的相对链接可保留，但不能越出产物；遍历与哈希不跟随链接。 */
  async artifactHash(root: string) {
    const hash = createHash("sha256");
    let files = 0,
      bytes = 0;
    const visit = async (directory: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name),
          info = await lstat(path);
        hash.update(
          JSON.stringify([
            path.slice(root.length),
            info.isDirectory()
              ? "directory"
              : info.isSymbolicLink()
                ? "link"
                : "file",
            info.isFile() ? info.size : 0,
            info.isFile() ? info.mode & 0o111 : 0,
          ]) + "\0",
        );
        if (++files > 100_000) throw new Error("Build has too many files");
        if (info.isSymbolicLink()) {
          const target = await readlink(path),
            resolved = resolve(dirname(path), target);
          if (!resolved.startsWith(resolve(root) + "/"))
            throw new Error("Build link escapes artifact");
          hash.update(JSON.stringify(target));
        } else if (info.isDirectory()) await visit(path);
        else if (info.isFile()) {
          bytes += info.size;
          if (bytes > 2 * 1024 ** 3) throw new Error("Build exceeds 2GiB");
          await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
          for await (const chunk of createReadStream(path)) hash.update(chunk);
          hash.update("\0");
        } else throw new Error("Unsupported build file type");
      }
    };
    await visit(root);
    return hash.digest("hex");
  }
}
