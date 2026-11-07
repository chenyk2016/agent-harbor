import type { EnvironmentRef } from "../../runtime/providers/contracts.js";
/** 应用容器独立于Agent Runner：实际镜像/归属核验后才能启停，未知状态不当作已删除。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VisitorDeployment } from "./visitor-auth/config.js";
import type { AppEnvironment } from "./data.js";
import { requireAppId } from "./source-store.js";

const exec = promisify(execFile);
/** 一次成功构建的固定产物引用：源码版本、目标环境、访问前缀和镜像内容编号共同确定部署输入。 */
export interface AppBuild {
  id: string;
  appId: string;
  revisionId: string;
  target: AppEnvironment;
  basePath: string;
  imageId: string;
  visitorAuthVersion?: 1;
}
/** 一个应用运行实例的描述；hostPort 由启动后查询 Docker 得到，重启后需要重新核对。 */
export interface AppDeployment {
  id: string;
  appId: string;
  build: AppBuild;
  container: string;
  hostPort: number;
  environment: AppEnvironment;
  visitorAuth?: VisitorDeployment;
  previewParentOrigin?: string;
  /** Legacy rows use the existing Docker container name. */
  runtime?: EnvironmentRef;
  ownerOnly?: true;
}
/** 封装应用构建和运行容器的 Docker 操作，以实例归属标签约束资源，和 Agent 开发容器分开管理。 */
export class AppDockerDriver {
  readonly owner: string;
  /** 从规范化存储根生成实例归属标签，防止操作另一个 Harbor 实例的容器。 */
  constructor(readonly root: string) {
    this.owner = createHash("sha256")
      .update(resolve(root))
      .digest("hex")
      .slice(0, 16);
  }
  /** 使用参数数组执行 Docker 命令，统一超时、输出上限和中止信号；调用失败向上抛出。 */
  async command(args: string[], timeout = 30000, signal?: AbortSignal) {
    return (
      await exec("docker", args, {
        timeout,
        signal,
        maxBuffer: 12 * 1024 * 1024,
      })
    ).stdout.trim();
  }
  /** 把镜像名称解析为不可变的 sha256 内容编号，避免部署时跟随可移动标签发生漂移。 */
  async imageId(image: string) {
    const id = await this.command([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_IMAGE_ID");
    return id;
  }
  /** 查询容器并校验平台归属和状态形状；只有 Docker 明确报告不存在时才返回 undefined。 */
  async inspect(container: string) {
    let result;
    try {
      result = JSON.parse(await this.command(["inspect", container]))[0];
    } catch (error) {
      if (
        /no such (object|container)/i.test(
          String((error as { stderr?: string }).stderr),
        )
      )
        return undefined;
      throw error;
    }
    if (result.Config?.Labels?.["harbor.app.store"] !== this.owner)
      throw new Error("APP_CONTAINER_OWNERSHIP_MISMATCH");
    if (typeof result.State?.Running !== "boolean")
      throw new Error("UNKNOWN_APP_CONTAINER_STATE");
    return result;
  }
  /** 校验固定产物与访问前缀，写入仅含本应用能力的私有配置，再创建受限容器；此时尚未启动。 */
  async create(
    build: AppBuild,
    deploymentId: string,
    databaseUrl: string,
    observation?: { url: string; token: string },
    visitorAuth?: VisitorDeployment,
    previewParentOrigin?: string,
  ): Promise<AppDeployment> {
    requireAppId(build.appId);
    requireAppId(deploymentId);
    if (
      !["preview", "production"].includes(build.target) ||
      build.basePath !==
        `/${build.target === "preview" ? "preview" : "apps"}/${build.appId}/`
    )
      throw new Error("APP_BUILD_PATH_MISMATCH");
    if (!/^sha256:[a-f0-9]{64}$/.test(build.imageId))
      throw new Error("INVALID_IMAGE_ID");
    const name = "ah-app-" + deploymentId;
    const directory = join(this.root, "deployments", deploymentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const configuration = {
      appId: build.appId,
      revisionId: build.revisionId,
      buildId: build.id,
      deploymentId,
      basePath: build.basePath,
      databaseUrl,
      environment: build.target,
      ...(visitorAuth ? { visitorAuth } : {}),
      ...(build.target === "preview" && previewParentOrigin ? { previewParentOrigin } : {}),
      ...(observation ? { observation } : {}),
    };
    // 配置只含本应用的DML能力，不含平台/模型/MCP秘密；父目录0700不开放给其他宿主用户。
    const configPath = join(directory, "runtime.json");
    const contents = JSON.stringify(configuration);
    try {
      await writeFile(configPath, contents, { flag: "wx", mode: 0o444 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const { readFile } = await import("node:fs/promises");
      if ((await readFile(configPath, "utf8")) !== contents)
        throw new Error("APP_DEPLOYMENT_CONFIGURATION_CHANGED");
    }
    await chmod(configPath, 0o444);
    const existing = await this.inspect(name);
    if (
      existing &&
      (existing.Image !== build.imageId ||
        existing.Config.Labels["harbor.app.deployment"] !== deploymentId)
    )
      throw new Error("APP_CONTAINER_SPEC_MISMATCH");
    if (!existing)
      await this.command([
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
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,nosuid,noexec,size=32m",
        "--restart",
        "no",
        "--label",
        `harbor.app.store=${this.owner}`,
        "--label",
        `harbor.app.id=${build.appId}`,
        "--label",
        `harbor.app.deployment=${deploymentId}`,
        "--label",
        `harbor.app.environment=${build.target}`,
        "--publish",
        "127.0.0.1::3000",
        "--mount",
        `type=bind,src=${configPath},dst=/run/harbor-app.json,readonly`,
        build.imageId,
      ]);
    const result = await this.inspect(name);
    if (!result) throw new Error("APP_CONTAINER_CREATE_UNCONFIRMED");
    return {
      id: deploymentId,
      appId: build.appId,
      build,
      container: name,
      hostPort: 0,
      environment: build.target,
      ...(visitorAuth ? { visitorAuth } : {}),
      ...(build.target === "preview" && previewParentOrigin ? { previewParentOrigin } : {}),
    };
  }
  /** 启动候选容器并回读实际端口和身份，更新传入的部署描述。 */
  async start(deployment: AppDeployment) {
    await this.command(["start", deployment.container]);
    return this.refresh(deployment);
  }
  /** Docker重启可能重新分配端口；仅信任当前引擎状态与完整归属，不沿用数据库旧端口。 */
  async refresh(deployment: AppDeployment) {
    const state = await this.inspect(deployment.container);
    if (!state?.State.Running) throw new Error("APP_START_UNCONFIRMED");
    if (
      state.Image !== deployment.build.imageId ||
      state.Config.Labels["harbor.app.deployment"] !== deployment.id ||
      state.Config.Labels["harbor.app.id"] !== deployment.appId ||
      state.Config.Labels["harbor.app.environment"] !== deployment.environment
    )
      throw new Error("APP_CONTAINER_SPEC_MISMATCH");
    const ports = state.NetworkSettings.Ports?.["3000/tcp"];
    if (
      !Array.isArray(ports) ||
      ports.length !== 1 ||
      ports[0].HostIp !== "127.0.0.1"
    )
      throw new Error("APP_PORT_BINDING_MISMATCH");
    const port = Number(ports[0].HostPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("APP_PORT_BINDING_MISMATCH");
    deployment.hostPort = port;
    return deployment;
  }
  /** 在时限内请求直连健康入口，同时核对部署和构建编号，避免把端口上另一个服务当成本实例。 */
  async healthy(deployment: AppDeployment, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let error: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${deployment.hostPort}${deployment.build.basePath}__harbor/health`,
          { signal: AbortSignal.timeout(1500) },
        );
        const value = (await response.json()) as {
          deploymentId?: string;
          buildId?: string;
        };
        if (
          response.ok &&
          value.deploymentId === deployment.id &&
          value.buildId === deployment.build.id
        )
          return value;
        throw new Error("APP_HEALTH_IDENTITY_MISMATCH");
      } catch (failure) {
        error = failure;
      }
      await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error("APP_HEALTH_FAILED", { cause: error });
  }
  /** 确认实例存活后设置重启策略：正式环境随 Docker 恢复，预览实例不自动重启。 */
  async activate(deployment: AppDeployment) {
    const state = await this.inspect(deployment.container);
    if (!state?.State.Running || state.Image !== deployment.build.imageId)
      throw new Error("APP_ACTIVATION_MISMATCH");
    await this.command([
      "update",
      "--restart",
      deployment.environment === "production" ? "unless-stopped" : "no",
      deployment.container,
    ]);
  }
  /** 先取消自动重启，再请求停止并回读确认；停止不明确时抛错，调用者不能提前释放占位。 */
  async stop(container: string) {
    const state = await this.inspect(container);
    if (!state) return;
    await this.command(["update", "--restart", "no", container]);
    if (state.State.Running)
      await this.command(["stop", "--time", "5", container]);
    if ((await this.inspect(container))?.State.Running)
      throw new Error("APP_STOP_UNCONFIRMED");
  }
  /** 确认归属并停止容器后删除，再回读确认不存在；不删除源码版本或业务数据。 */
  async destroy(container: string) {
    await this.stop(container);
    const state = await this.inspect(container);
    if (state) await this.command(["rm", container]);
    if (await this.inspect(container))
      throw new Error("APP_DELETE_UNCONFIRMED");
  }
}
