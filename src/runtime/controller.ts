/**
 * 会话运行控制器，运行在宿主机。
 * 接收任务与短期凭证，通过 Docker 启动 Runner，保存执行事件和会话状态。
 * 主线：取得会话锁 → 协调环境 → 启动 Runner → 接收事件 → 结束本轮或关闭会话。
 * Claude 的推理与工具循环由容器内的 SDK 完成。
 */
import { appendFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { clearStartupCredentials } from "./mcp-startup.js";
import { ResidentConversation } from "./conversation.js";
import { DockerBackend } from "../docker/docker.js";
import { Store, exists, lockSession } from "./storage.js";
import {
  defaultProfile,
  type Event,
  type Profile,
  type Session,
  type Task,
} from "../shared/types.js";

/** 运行层通知服务层的两类事实：运行器事件和环境状态变化；供服务端筛选、持久化及展示。 */
export type RuntimeNotice =
  | { type: "runner.event"; event: import("../shared/runner-protocol.js").RunnerEvent }
  | { type: "environment.changed"; session: Session };
/** 一次运行环境固定的网关、专家、技能与连接配置；expert 是快照，恢复旧原生会话时不能静默改变。 */
export interface ConversationOptions {
  gateway?: import("../shared/llm.js").GatewayConnection;
  dependencyCacheKey?: string;
  networkDomains?:string[];
  localMcp?: import("../shared/mcp.js").LocalMcpLaunch[];
  mcpServers?: Record<string,import("@anthropic-ai/claude-agent-sdk").McpServerConfig>;
  expert?: import("../shared/experts.js").ExpertSnapshot;
  capabilities?: import("../shared/skills.js").CapabilitySnapshot;
  observeToolContent?: boolean;
  onToolContent?: (event: import("../shared/runner-protocol.js").RunnerEvent, content: NonNullable<import("../shared/runner-protocol.js").RunnerEvent["toolContent"]>) => void;
  onRuntimeNotice?: (notice: RuntimeNotice) => Promise<void>;
}
/** 单轮执行附加标识；attemptId 可由服务消息编号指定，以便关联产品消息和容器事件。 */
export interface RunOptions { attemptId?: string; modelProbe?: boolean }

/** 服务层持有的对话资源接口；run 执行一轮，terminate 停止环境，close 负责完整关闭和资源释放。 */
export interface Conversation {
  /** 在持有的会话环境中执行一轮需求，返回运行事实，调用者仍需检查终态。 */
  run(prompt: string, onEvent?: (event: Event) => void, signal?: AbortSignal, options?: RunOptions): Promise<Session>;
  /** 强制关闭执行环境；用于明确关闭、超时或服务故障，不是普通用户中断。 */
  terminate(): Promise<void>;
  /** 等待收尾、关闭环境并释放会话资源；资源停止失败时不能提前视为关闭完成。 */
  close(): Promise<void>;
}

/** 宿主执行入口，协调会话存储和 Docker；提供单次运行及可持续对话两种调用方式。 */
export class Controller {
  readonly store: Store;
  readonly backend: DockerBackend;
  /** 创建会话存储与 Docker 后端，并固定受信运行配置。 */
  constructor(
    root: string,
    readonly profile: Profile = { ...defaultProfile },
  ) {
    this.store = new Store(root);
    this.backend = new DockerBackend(this.store.root);
  }
  /**
   * 可由另一个CLI进程调用：先留下取消标记，再终止并确认整个容器停止。
   * 正在执行 run() 的 Controller 会读取此标记，完成最终状态的保存。
   */
  async cancel(sessionId: string) {
    const session = await this.store.load(sessionId);
    if (!session.containerId || session.stopped) return;
    await writeFile(
      join(
        this.store.directory(sessionId),
        "attempts",
        session.attemptId!,
        "cancel",
      ),
      "cancel\n",
    );
    await this.backend.requestCancel(session.containerId);
    await this.backend.stop(session.containerId);
  }
  /**
   * 在一个会话中执行任务；已有 SDK 会话 ID 时继续原对话。
   * token 是本次运行的短期网关凭证，onEvent 接收执行进度。
   * 同一会话正在运行时拒绝第二个写入者；退出本方法时释放宿主锁。
   * 返回会话状态，调用者需检查 status/stopped；初始化或协调失败也可能抛错。
   */
  async run(
    sessionId: string,
    prompt: string,
    token: string,
    onEvent: (event: Event) => void = () => {},
    signal?: AbortSignal,
  ): Promise<Session> {
    const directory = await this.store.prepare(sessionId);
    const release = await lockSession(directory);
    try {
      return await this.execute(
        directory,
        sessionId,
        prompt,
        token,
        onEvent,
        signal,
      );
    } finally {
      await release();
    }
  }
  /** chat由宿主持有长期Runner管道；先协调旧环境，再建立本次独立租约。 */
  async open(sessionId: string, token: string, options: ConversationOptions = {}): Promise<Conversation> {
    return ResidentConversation.open(this, sessionId, token, options);
  }
  /** 在已持有会话锁的前提下，完成一次容器运行及收尾。 */
  private async execute(
    directory: string,
    sessionId: string,
    prompt: string,
    token: string,
    onEvent: (event: Event) => void,
    signal?: AbortSignal,
  ) {
    // 单次run也必须先确认旧写入者停止，再创建环境。
    for (const id of await this.backend.forSession(sessionId)) {
      await this.backend.stop(id);
      await this.backend.destroy(id);
    }
    const previous = await this.store.load(sessionId);
    const imageId = await this.backend.imageId(this.profile.image);
    // 对话状态与运行版本需要配套；镜像变更后先验证兼容性，再继续旧会话。
    if (
      previous.sdkSessionId &&
      previous.imageId &&
      previous.imageId !== imageId
    ) {
      throw new Error(
        "The runtime image changed; verify resume compatibility before upgrading this session",
      );
    }
    if (previous.status === "reconciling" || previous.stopped === false) {
      // 上次可能在创建容器后、保存结果前退出。上面的标签查询已处理其环境，
      // 此处补记停止事实并清空旧凭证，保留对话与实际工作文件。
      previous.stopped = true;
      for (const id of new Set([previous.runnerId, previous.attemptId])) if (id)
        await clearStartupCredentials(join(directory, "attempts", id));
      await this.store.save(previous);
    }
    // 2. 准备本次任务：沿用会话 ID，生成新的 attempt ID 和执行代次。
    const task: Task = {
      sessionId,
      attemptId: randomUUID(),
      generation: previous.generation + 1,
      prompt,
      model: this.profile.model,
      resumeId: previous.sdkSessionId,
      maxTurns: this.profile.maxTurns || undefined,
      maxBudgetUsd: this.profile.maxBudgetUsd || undefined,
      timeoutMs: this.profile.timeoutMs,
    };
    const attemptDirectory = join(directory, "attempts", task.attemptId);
    await mkdir(attemptDirectory, { mode: 0o700 });
    // Runner 用户需要读此挂载；项目工具对该路径的限制由原生策略负责，
    // 实际保密效果仍需目标环境验收；V2由宿主会话目录保护运行资料。
    await chmod(attemptDirectory, 0o755);
    await writeFile(join(attemptDirectory, "task.json"), JSON.stringify(task));
    const session: Session = {
      sessionId,
      generation: task.generation,
      attemptId: task.attemptId,
      sdkSessionId: previous.sdkSessionId,
      imageId,
      status: "starting",
      stopped: false,
      containerId: `ah-${task.attemptId}`,
    };
    await this.store.save(session);
    let cancelled = signal?.aborted ?? false;
    let stopError: unknown;
    let cancellation: Promise<void> | undefined;
    let child: ReturnType<DockerBackend["start"]> | undefined;
    /** 绑定当前单次执行的取消回调，写取消标记并停止本轮容器；异步失败保留给收尾检查。 */
    const cancel = () => {
      cancelled = true;
      // 超时和调用方取消共用此路径；SDK 卡在子进程时，也由宿主停止整个环境。
      // 绑定本轮名称并等待取消收尾，避免迟到的取消读到下一轮状态。
      cancellation ??= (async () => {
        await writeFile(join(attemptDirectory, "cancel"), "cancel\n");
        await this.backend.requestCancel(session.containerId!);
        await this.backend.stop(session.containerId!);
      })().catch((error) => {
        stopError = error;
        child?.kill();
      });
    };
    const timer = task.timeoutMs > 0 ? setTimeout(cancel, task.timeoutMs) : undefined;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await writeFile(
        join(attemptDirectory, "connection.json"),
        JSON.stringify({ url: this.profile.gatewayUrl, token }),
        { mode: 0o644 },
      );
      // 3. 创建并启动容器。上面已提前保存确定的容器名，
      // 即使 Docker 创建成功但响应丢失，收尾时仍能找到并停止它。
      session.containerId = await this.backend.create(
        task, { ...this.profile, image: imageId }, directory, attemptDirectory,
      );
      await this.store.save(session);
      if (signal?.aborted || cancelled) throw new Error("Cancelled before start");
      child = this.backend.start(session.containerId!);
      const exited = once(child, "exit");
      const stderrWrites: Promise<void>[] = [];
      child.stderr.on("data", (chunk) => {
        stderrWrites.push(
          appendFile(join(attemptDirectory, "stderr.log"), chunk, {
            mode: 0o600,
          }),
        );
      });
      session.status = "running";
      await this.store.save(session);
      // 4. 按行接收 Runner 协议；stdout 是事件，stderr 单独保留为内部诊断。
      let seq = 0;
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        const event: Event = JSON.parse(line);
        if (
          event.sessionId !== sessionId ||
          event.attemptId !== task.attemptId ||
          event.generation !== task.generation ||
          event.seq <= seq
        )
          throw new Error("Invalid runner event sequence/identity");
        seq = event.seq;
        await appendFile(join(attemptDirectory, "events.jsonl"), line + "\n", {
          mode: 0o600,
        });
        if (event.type === "sdk.session") {
          // 尽早保存原生会话 ID，供下次明确 resume；工作文件由持久挂载保留。
          session.sdkSessionId = String(event.payload.id);
          await this.store.save(session);
        }
        if (event.type === "agent.result")
          session.result = event.payload as Session["result"];
        onEvent(event);
      }
      const [exitCode] = await exited;
      await Promise.all(stderrWrites);
      if (stopError) throw stopError;
      if (exitCode !== 0)
        throw new Error(
          `Runner exited with ${exitCode}; see attempt stderr.log`,
        );
    } catch (error) {
      session.error = String(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      await cancellation;
      // 单次run始终停止环境；常驻chat的生命周期在conversation.ts中。
      try {
        const externallyCancelled = await exists(join(attemptDirectory, "cancel"));
        const success = !cancelled && !externallyCancelled && !session.error &&
          session.result?.subtype === "success";
        session.status = "finalizing";
        if (session.containerId) await this.backend.stop(session.containerId);
        session.stopped = true;
        session.environment = "closed";
        await this.store.save(session);
        session.status = cancelled || externallyCancelled ? "cancelled" : success ? "succeeded" : "failed";
        await this.store.save(session);
        if (session.containerId) await this.backend.destroy(session.containerId);
      } catch (error) {
        session.status = "reconciling";
        session.environment = "unknown";
        session.error = String(error);
        await this.store.save(session);
      }
      // 本次连接凭证不用于下一次恢复；保留的会话状态和事件继续留在各自目录。
      await writeFile(join(attemptDirectory, "connection.json"), "{}", {
        mode: 0o600,
      });
    }
    return session;
  }
}
