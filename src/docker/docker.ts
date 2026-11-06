import { mcpSandboxPolicy } from "../shared/sandbox-policy.js";
/**
 * 宿主机上的 Docker 操作封装，供 Controller 调用。
 * 负责固定规格的创建、启动、查询、停止与删除；会话状态由 Controller 保存。
 * 统一通过 Docker CLI 操作；参数数组直接传给进程，避免拼接 shell 字符串。
 */
import { cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Profile, Task } from "../shared/types.js";
import { fileURLToPath } from "node:url";
import { containerPaths } from "../shared/paths.js";
import { applicationExpertId, applicationSkillPluginPath } from "../shared/application-skills.js";

const exec = promisify(execFile);
const project = "agent-harbor";
export function dockerSessionName(attemptId: string) {
  return `ah-${attemptId}`;
}

export class DockerBackend {
  readonly owner: string;
  constructor(readonly root: string) {
    // 用数据根区分同一项目的不同实例，防止清理另一个测试/运行目录的容器。
    this.owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
  }
  /** 短时 Docker 管理命令；持续输出的 Runner 使用下面的 start()。 */
  async command(args: string[]) {
    const { stdout } = await exec("docker", args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  }
  /** 把可能变化的镜像标签解析为本次实际使用的镜像内容 ID。 */
  async imageId(image: string) {
    return this.command(["image", "inspect", "--format", "{{.Id}}", image]);
  }
  /**
   * 返回当前容器状态；明确不存在时返回 undefined。
   * 引擎不可达、归属不符或状态不完整时抛错，交给 Controller 协调。
   */
  async inspect(id: string) {
    let data;
    try {
      data = JSON.parse(await this.command(["inspect", id]))[0];
    } catch (error) {
      if (
        /no such (object|container)/i.test(
          String((error as { stderr?: string }).stderr),
        )
      )
        return undefined;
      throw error; // 查询失败表示未知，不能据此认定容器已经停止。
    }
    if (
      data.Config.Labels["io.agent-harbor.project"] !== project ||
      data.Config.Labels["harbor.owner"] !== this.owner
    ) {
      throw new Error("Container does not belong to this project/store");
    }
    if (typeof data.State.Running !== "boolean")
      throw new Error("Docker returned no running state");
    return {
      running: data.State.Running as boolean,
      exitCode: data.State.ExitCode as number,
      labels: data.Config.Labels,
    };
  }
  /** 按数据根和会话标签查找容器，包括已停止但还没删除的环境。 */
  async forSession(sessionId: string) {
    const ids = await this.command([
      "ps",
      "-aq",
      "--filter",
      `label=harbor.owner=${this.owner}`,
      "--filter",
      `label=harbor.session=${sessionId}`,
    ]);
    return ids ? ids.split("\n") : [];
  }
  /** 服务启动还要发现数据库之外的遗留环境，不只扫描已登记会话。 */
  async ownedSessions(): Promise<string[]> {
    const ids = await this.command([
      "ps",
      "-aq",
      "--filter",
      `label=harbor.owner=${this.owner}`,
    ]);
    const sessions = new Set<string>();
    for (const id of ids.split("\n").filter(Boolean)) {
      const state = await this.inspect(id);
      if (state?.labels["harbor.session"])
        sessions.add(state.labels["harbor.session"]);
    }
    return [...sessions];
  }
  /** 创建固定运行环境，同一 attempt 重试复用同名容器；此方法尚不启动进程。 */
  async create(
    task: Task,
    profile: Profile,
    directory: string,
    attemptDirectory: string,
    persistent = false,
    leaseId?: string,
  ) {
    // 旧镜像会忽略新的 expert 字段；明确拒绝，避免专家会话悄悄退化成普通会话。
    if (
      task.expert?.workbuddy &&
      (await this.command([
        "image",
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.agent-harbor.workbuddy" }}',
        profile.image,
      ])) !== "1"
    )
      throw new Error(
        "WORKBUDDY_RUNTIME_UNSUPPORTED: use a WorkBuddy-capable runtime image",
      );
    if (
      task.expert &&
      (await this.command([
        "image",
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.agent-harbor.experts" }}',
        profile.image,
      ])) !== "1"
    )
      throw new Error(
        "EXPERT_RUNTIME_UNSUPPORTED: use an expert-capable runtime image",
      );
    if (
      (task.hasLocalMcp || task.mcpProbe) &&
      (await this.command([
        "image",
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.agent-harbor.mcp-native" }}',
        profile.image,
      ])) !== "1"
    )
      throw new Error(
        "MCP_NATIVE_RUNTIME_UNSUPPORTED: select a native MCP runtime image",
      );
    const name = dockerSessionName(task.attemptId);
    const existing = await this.inspect(name);
    if (existing) return name;
    // 先保存确定名称再请求创建（由 Controller 完成）；CLI 超时不代表创建失败，
    // 后续仍可按此名称核对归属并停止/清理，不能直接假定容器不存在。
    const seccompPath = fileURLToPath(
      new URL("../../../infra/seccomp.json", import.meta.url),
    );
    // 用户键只由服务端生成；独立CLI没有用户身份时退回会话私有缓存。
    const cacheKey =
      task.dependencyCacheKey ??
      createHash("sha256").update(`session:${task.sessionId}`).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(cacheKey))
      throw new Error("Invalid dependency cache key");
    const cacheDirectory = join(this.root, ".dependency-caches", cacheKey);
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "dependency-env", "home"), {
      recursive: true,
      mode: 0o700,
    });
    // 每次创建均挂载当前管理员策略；下载域名与专家获准网络取并集。
    const policy = JSON.parse(
      await readFile(
        new URL("../../../infra/managed-settings.json", import.meta.url),
        "utf8",
      ),
    );
    policy.sandbox.network.allowedDomains = [
      ...new Set([
        ...policy.sandbox.network.allowedDomains,
        ...(task.networkDomains ?? []),
      ]),
    ];
    const policyFile = join(attemptDirectory, "managed-settings.json");
    await writeFile(policyFile, JSON.stringify(policy), { mode: 0o644 });
    if (task.hasLocalMcp)
      await writeFile(
        join(attemptDirectory, "mcp-sandbox.json"),
        JSON.stringify(mcpSandboxPolicy(policy, "/session-env/mcp")),
        { mode: 0o644 },
      );
    // 平台按应用专家快照装载技能包。它留在只读挂载内，与可发布源码分离。
    const applicationPlugin = task.expert?.expertId === applicationExpertId
      ? join(attemptDirectory, "application-skills")
      : undefined;
    if (applicationPlugin)
      await cp(
        fileURLToPath(new URL("../../../templates/platform-skills/harbor-app", import.meta.url)),
        applicationPlugin,
        { recursive: true },
      );
    await this.command([
      "create",
      "--name",
      name,
      "--init",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--interactive",
      "--label",
      `io.agent-harbor.project=${project}`,
      "--label",
      `harbor.owner=${this.owner}`,
      "--label",
      `harbor.session=${task.sessionId}`,
      "--label",
      `harbor.attempt=${task.attemptId}`,
      // 非 root、去掉 capabilities、禁止获取新权限；继续保留容器外层隔离。
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      // 保留收窄的 syscall 策略，只为可信 bwrap/helper 的初始化放行必要调用。
      // 必须配合 SDK 0.3.306 + managed allowNestedUserNamespaces=false：
      // 原生 helper 初始化后、执行项目命令前追加 namespace/mount 禁令，后代继承。
      "--security-opt",
      `seccomp=${seccompPath}`,
      // CLI 无法逐项设置 MaskedPaths/ReadonlyPaths。此选项同时取消两类路径保护，
      // 让原生沙箱能挂载新 /proc；代价是 /sys/firmware 和 powercap 也不再遮蔽。
      // firmware 可能暴露硬件信息；powercap 在受影响硬件上有功耗侧信道风险。
      // 这不是 seccomp=unconfined，也不自动授予写权限；但比只放开 /proc 更宽。
      // 当前为用户选择的本地开发取舍；来源、范围及后续复验见 infra/seccomp.md。
      "--security-opt",
      "systempaths=unconfined",
      "--read-only",
      // 资源初值沿用原配置；持久目录的磁盘配额不由这里实现。
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m,mode=1777",
      // 工作区与原生状态持久化，本次任务/连接文件只读挂载。
      "--mount",
      `type=bind,src=${directory}/workspace,dst=${containerPaths.workspace}`,
      "--mount",
      `type=bind,src=${directory}/dependency-env,dst=${containerPaths.dependencyEnv}`,
      "--mount",
      `type=bind,src=${cacheDirectory},dst=${containerPaths.dependencyCache}`,
      "--mount",
      `type=bind,src=${directory}/claude-state,dst=${containerPaths.state}`,
      "--mount",
      `type=bind,src=${persistent || task.mcpProbe ? `${directory}/attempts` : attemptDirectory},dst=${containerPaths.run},readonly`,
      ...(task.capabilities
        ? [
            "--mount",
            `type=bind,src=${directory}/capabilities/${task.capabilities.digest},dst=/opt/harbor-skills,readonly`,
          ]
        : []),
      ...(applicationPlugin
        ? ["--mount", `type=bind,src=${applicationPlugin},dst=${applicationSkillPluginPath},readonly`]
        : []),
      ...(policyFile
        ? [
            "--mount",
            `type=bind,src=${policyFile},dst=/etc/claude-code/managed-settings.json,readonly`,
          ]
        : []),
      ...(persistent || task.mcpProbe ? ["--entrypoint", "node"] : []),
      profile.image,
      ...(task.mcpProbe
        ? [
            `${containerPaths.runtime}/dist/src/agent/mcp-probe.js`,
            `${containerPaths.run}/${task.attemptId}/connection.json`,
          ]
        : persistent
          ? [
              `${containerPaths.runtime}/dist/src/agent/keeper.js`,
              ...(leaseId ? [leaseId] : []),
            ]
          : []),
    ]);
    return name;
  }
  /** 启动 Runner 并连接输出流；调用方消费 stdout 事件和 stderr 诊断。 */
  start(id: string) {
    return spawn("docker", ["start", "--attach", id], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  /** 常驻容器先启动keeper；Runner通过单独后端管道接入。 */
  async startSession(id: string) {
    await this.command(["start", id]);
    if (!(await this.inspect(id))?.running)
      throw new Error("Session container failed to start");
  }
  /** 常驻Runner必须保持stdin；一段对话只建立一次exec连接。 */
  connect(id: string, runnerId: string) {
    return spawn(
      "docker",
      [
        "exec",
        "-i",
        id,
        "node",
        `${containerPaths.runtime}/dist/src/agent/resident-runner.js`,
        runnerId,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }
  /** 向容器主进程发送终止信号；主进程可能是Runner或Keeper，仍须确认整容器停止。 */
  async requestCancel(id: string) {
    if ((await this.inspect(id))?.running)
      await this.command(["kill", "--signal", "SIGTERM", id]);
  }
  /** Docker 先发终止信号，5 秒宽限后强停；再查询确认，不只看命令返回。 */
  async stop(id: string) {
    if ((await this.inspect(id))?.running)
      await this.command(["stop", "--time", "5", id]);
    if ((await this.inspect(id))?.running)
      throw new Error("Container is still running");
  }
  /** 只移除已停止的容器，工作目录和 Claude 状态所在的宿主目录不删除。 */
  async destroy(id: string) {
    const state = await this.inspect(id);
    if (state?.running)
      throw new Error("Stop the container before removing it");
    if (state) await this.command(["rm", id]);
  }
}
