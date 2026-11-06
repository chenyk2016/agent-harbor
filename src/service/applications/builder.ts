/** 从固定Git输入构建镜像；Builder与应用容器分开，宿主不执行来源npm脚本。 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  lstat,
  readlink,
  realpath,
  chmod,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AppEnvironment } from "./data.js";
import { AppDockerDriver, type AppBuild } from "./docker.js";
import { ApplicationSources, type SourceRevision } from "./source-store.js";
import type { ResidentProvider } from "../../runtime/providers/resident.js";
import { runBuildJob, stopBuildJobs } from "../../runtime/providers/build-job.js";
import { parseManifest } from "./manifest.js";

/** 把平台保存的固定源码版本构建成可运行镜像；构建容器和运行容器分离，宿主不执行应用的 npm 脚本。 */
export class ApplicationBuilder {
  readonly driver: AppDockerDriver;
  /** 保存构建根目录、固定基础镜像和平台运行时代码位置，并创建共享的 Docker 驱动。 */
  constructor(
    readonly root: string,
    readonly sources: ApplicationSources,
    readonly nodeBase: string,
    readonly runtimeDirectory = resolve("infra/app-runtime"),
    readonly downloadProxy?: string,
    private readonly sandbox?: { root: string; provider: ResidentProvider },
  ) {
    this.driver = new AppDockerDriver(root);
  }
  /** 导出指定版本，在受限构建容器中生成产物、校验后打包镜像；支持中止，退出前必须确认构建容器已清理。 */
  async build(
    revision: SourceRevision,
    target: AppEnvironment,
    applicationRevisionId = revision.commit,
    id = randomUUID(),
    signal?: AbortSignal,
  ): Promise<AppBuild> {
    signal?.throwIfAborted();
    if (!["preview", "production"].includes(target))
      throw new Error("INVALID_APP_ENVIRONMENT");
    const directory = join(this.root, "builds", id);
    const input = join(directory, "input"),
      output = join(directory, "output");
    const name = "ah-app-build-" + id;
    await mkdir(output, { recursive: true, mode: 0o777 });
    await chmod(output, 0o777); // 父目录属于平台；容器内非root用户只获授此输出目录。
    await this.sources.export(revision, input);
    const manifest = parseManifest(
      JSON.parse(await readFile(join(input, "harbor-app.json"), "utf8")),
    );
    const image = await this.driver.imageId(this.nodeBase);
    const basePath = `/${target === "preview" ? "preview" : "apps"}/${revision.appId}/`;
    await writeFile(
      join(directory, "operation.json"),
      JSON.stringify({
        id,
        name,
        appId: revision.appId,
        revisionId: revision.commit,
        image,
        basePath,
        status: "building",
      }),
    );
    let success = false;
    try {
      signal?.throwIfAborted();
      if (this.sandbox?.provider.backendId === "opensandbox-strict-runner") {
        const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
        const builderImage = await this.nonRootImage(image, directory, timeout);
        const env = { APP_BASE_PATH: basePath, APP_REVISION: applicationRevisionId, ...(this.downloadProxy ? {
          HTTP_PROXY: this.downloadProxy, HTTPS_PROXY: this.downloadProxy,
          npm_config_proxy: this.downloadProxy, npm_config_https_proxy: this.downloadProxy,
        } : {}) };
        let log = "";
        try {
          await runBuildJob(this.sandbox.provider, this.sandbox.root, {
            id, image: builderImage, input, output, work: { type: "app-build", builder: this.runtimeDirectory, env },
          }, timeout, async text => { if (log.length < 1024 * 1024) log += text; });
        } finally {
          await writeFile(join(directory, "build.log"), log);
        }
      } else {
        await this.driver.command([
          "create",
          "--name",
          name,
          "--init",
          "--user",
          "1000:1000",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          // Vite/Rolldown要加载原生绑定，只有受限构建工作区允许exec映射；临时目录保持noexec。
          "--memory",
          "2g",
          "--cpus",
          "2",
          "--pids-limit",
          "128",
          "--tmpfs",
          "/work:rw,exec,nosuid,nodev,size=1200m,mode=1777",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
          "--label",
          `harbor.app.store=${this.driver.owner}`,
          "--label",
          `harbor.app.build=${id}`,
          "--mount",
          `type=bind,src=${input},dst=/input,readonly`,
          "--mount",
          `type=bind,src=${output},dst=/output`,
          "--mount",
          `type=bind,src=${this.runtimeDirectory},dst=/platform,readonly`,
          "--env",
          "HOME=/tmp",
          "--env",
          `APP_BASE_PATH=${basePath}`,
          "--env",
          `APP_REVISION=${applicationRevisionId}`,
          ...(this.downloadProxy
            ? [
                "--env",
                `HTTP_PROXY=${this.downloadProxy}`,
                "--env",
                `HTTPS_PROXY=${this.downloadProxy}`,
                "--env",
                `npm_config_proxy=${this.downloadProxy}`,
                "--env",
                `npm_config_https_proxy=${this.downloadProxy}`,
              ]
            : []),
          image,
          "node",
          "/platform/launch.mjs",
        ]);
        signal?.throwIfAborted();
        const log = await this.driver.command(
          ["start", "--attach", name],
          300000,
          signal,
        );
        await writeFile(join(directory, "build.log"), log);
        const state = await this.driver.inspect(name);
        if (!state || state.State.Running || state.State.ExitCode !== 0)
          throw new Error("APP_BUILD_FAILED");
        await this.driver.destroy(name);
      }
      signal?.throwIfAborted();
      await validateArtifact(output);
      await copyFile(
        join(this.runtimeDirectory, "server.mjs"),
        join(output, "harbor-runtime.mjs"),
      );
      await copyFile(
        join(this.runtimeDirectory, "observe.mjs"),
        join(output, "harbor-observe.mjs"),
      );
      // 写入平台规范化manifest，忽略来源多余属性，运行端只消费校验后的契约。
      await writeFile(
        join(output, "harbor-app.json"),
        JSON.stringify(manifest),
      );
      await copyFile(
        join(this.runtimeDirectory, "Dockerfile"),
        join(output, "Dockerfile"),
      );
      const tag = "agent-harbor-app:" + id;
      const baseReference = this.nodeBase.includes("@sha256:")
        ? this.nodeBase
        : image;
      const imageLog = await this.driver.command(
        [
          "build",
          "--pull=false",
          "--network=none",
          "--build-arg",
          `APP_NODE_BASE=${baseReference}`,
          "--tag",
          tag,
          "--label", `harbor.app.store=${this.driver.owner}`,
          "--label", `harbor.app.id=${revision.appId}`,
          "--label", `harbor.app.build=${id}`,
          output,
        ],
        120000,
        signal,
      );
      await writeFile(join(directory, "image.log"), imageLog);
      const build = {
        visitorAuthVersion: 1 as const,
        id,
        appId: revision.appId,
        revisionId: applicationRevisionId,
        target,
        basePath,
        imageId: await this.driver.imageId(tag),
      };
      await writeFile(join(directory, "build.json"), JSON.stringify(build));
      await writeFile(
        join(directory, "operation.json"),
        JSON.stringify({ ...build, status: "succeeded" }),
      );
      success = true;
      return build;
    } catch (error) {
      await writeFile(
        join(directory, "failure.log"),
        String((error as { stderr?: string }).stderr ?? error),
      );
      throw error;
    } finally {
      // 清理不明时抛错而非宣称失败产物已释放；确定名字支持后续人工/启动核对。
      try {
        if (this.sandbox) await stopBuildJobs(this.sandbox.provider, id);
        await this.driver.destroy(name);
      } catch (error) {
        await writeFile(
          join(directory, "operation.json"),
          JSON.stringify({
            id,
            name,
            status: "reconciling",
            buildSucceeded: success,
          }),
        );
        throw error;
      }
      await chmod(output, 0o700);
    }
  }

  /** OCI assembly only. Application code is executed later by the selected sandbox. */
  private async nonRootImage(image: string, directory: string, signal: AbortSignal) {
    const user = await this.driver.command(["image", "inspect", "--format", "{{.Config.User}}", image]);
    if (["node", "1000", "1000:1000"].includes(user)) return image;
    const suffix = image.slice("sha256:".length);
    const base = `agent-harbor-builder-base:${suffix}`;
    const tag = `agent-harbor-builder-unprivileged:${suffix}`;
    const cached = await this.driver.imageId(tag).catch(() => undefined);
    if (cached) return cached;
    const context = join(directory, "builder-base");
    await mkdir(context, { recursive: true });
    await this.driver.command(["tag", image, base]);
    await writeFile(join(context, "Dockerfile"), `FROM ${base}\nUSER 1000:1000\n`);
    await this.driver.command(["build", "--pull=false", "--network=none", "-t", tag, context], 120000, signal);
    return this.driver.imageId(tag);
  }

}

/** Builder输出仍不可信：不接受特殊文件、越界软链接或无限产物。 */
export async function validateArtifact(root: string) {
  const base = await realpath(root);
  let count = 0,
    bytes = 0;
  /** 递归校验产物的深度、文件数、大小和软链接目标，拒绝越界路径及特殊文件。 */
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 40) throw new Error("ARTIFACT_DEPTH_LIMIT");
    for (const entry of await readdir(path)) {
      if (++count > 30000) throw new Error("ARTIFACT_FILE_LIMIT");
      const child = join(path, entry),
        stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const target = await readlink(child);
        if (target.startsWith("/")) throw new Error("ARTIFACT_SYMLINK_DENIED");
        const resolved = await realpath(child);
        if (!resolved.startsWith(base + sep))
          throw new Error("ARTIFACT_SYMLINK_DENIED");
      } else if (stat.isDirectory()) await walk(child, depth + 1);
      else if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("ARTIFACT_SPECIAL_FILE_DENIED");
      else if ((bytes += stat.size) > 500 * 1024 * 1024)
        throw new Error("ARTIFACT_SIZE_LIMIT");
    }
  };
  await walk(base, 0);
  for (const file of ["site/index.html", "server/index.mjs", "package.json"])
    if (!(await lstat(join(base, file))).isFile())
      throw new Error("ARTIFACT_INCOMPLETE");
}
