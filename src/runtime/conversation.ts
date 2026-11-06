import { prepareMcpStartup, clearStartupCredentials } from "./mcp-startup.js";
/**
 * 宿主上的连续对话管理。
 * open取得会话锁；run执行一轮；close关闭环境并释放锁。
 * 正常回合与确认完成的用户中断保留Runner；超时、异常及关闭确认整个容器停止。
 */
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Controller,
  Conversation,
  ConversationOptions,
  RunOptions,
} from "./controller.js";
import { exists, lockSession } from "./storage.js";
import { RunnerChannel } from "./runner-channel.js";
import type { RunnerEvent } from "../shared/runner-protocol.js";
import type { Event, Session, Task } from "../shared/types.js";

/** 一轮执行中需要随身携带的信息；取消标记只影响这一轮。 */
interface Turn {
  stopReason?: Session["stopReason"];
  task: Task;
  directory: string;
  onEvent: (event: Event) => void;
  cancelled: boolean;
  submitted: boolean;
  forceStop: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
}

/** 持有会话锁、常驻 Runner 和本轮状态的宿主对象；正常回合可复用环境，异常或关闭必须确认停止。 */
export class ResidentConversation implements Conversation {
  // 环境资源：正常回合结束后继续保留；确认关闭后清空。
  private runnerChannel?: RunnerChannel;
  private containerId?: string;
  private runnerId?: string;
  private readonly leaseId = randomUUID();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  // 宿主会话状态：isRunning防止并发提交，needsReconciliation阻止未知环境继续写入。
  private isRunning = false;
  private isClosed = false;
  private needsReconciliation = false;
  private heartbeatError?: unknown;
  private session!: Session;
  private activeTurn?: Turn;
  private tasksByAttempt = new Map<string, Task>();

  // 下面保存的是异步工作的完成凭据，不是额外的业务状态。
  // 取消和故障共用一次清理；新建Runner时才重置environmentCleanup。
  private environmentCleanup?: Promise<void>;
  // 空闲期间也可能崩溃；下一轮必须先等清理和状态落盘完成。
  private idleRecovery?: Promise<void>;
  // 日志与元数据分别顺序写，关闭时等日志消费完成。
  private stderrWrites = Promise.resolve();
  private sessionWrites = Promise.resolve();

  /** 保存已取得的会话锁及固定运行配置；由 open 完成旧环境核对和心跳后才交给调用方。 */
  private constructor(
    private controller: Controller,
    private sessionId: string,
    private token: string,
    private directory: string,
    private releaseSessionLock: () => Promise<void>,
    private options: ConversationOptions,
  ) {}

  /** 准备会话目录并持有独占锁，确认旧写入者停止后建立心跳；初始化失败释放锁。 */
  static async open(
    controller: Controller,
    sessionId: string,
    token: string,
    options: ConversationOptions = {},
  ) {
    const directory = await controller.store.prepare(sessionId);
    const releaseLock = await lockSession(directory);
    const conversation = new ResidentConversation(
      controller,
      sessionId,
      token,
      directory,
      releaseLock,
      options,
    );

    try {
      // 锁只证明旧宿主不再持锁，不证明旧容器已停止。不能先给旧环境续心跳。
      await conversation.reconcilePreviousEnvironment();
      await conversation.startHeartbeat();
      return conversation;
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  /** 先确认旧写入者停止，再整理遗留状态和凭证；不重放未完成的输入。 */
  private async reconcilePreviousEnvironment() {
    for (const containerId of await this.controller.backend.forSession(
      this.sessionId,
    )) {
      await this.controller.backend.stop(containerId);
      await this.controller.backend.destroy(containerId);
    }

    this.session = await this.controller.store.load(this.sessionId);
    const previousAttempts = new Set([
      this.session.runnerId,
      this.session.attemptId,
    ]);
    for (const attemptId of previousAttempts) {
      if (!attemptId) continue;
      await clearStartupCredentials(
        join(this.directory, "attempts", attemptId),
      );
    }

    if (
      this.session.stopped === false ||
      this.session.status === "reconciling"
    ) {
      this.session.stopped = true;
      this.session.environment = "closed";
      if (
        ["starting", "running", "finalizing"].includes(
          this.session.status ?? "",
        )
      ) {
        this.session.status = "failed";
        this.session.error =
          "Previous owner exited before turn completion; input was not replayed";
      }
      await this.saveSession();
    }
  }

  /** 每次open有独立租约；Keeper只观察属于这次所有权的文件。 */
  private async startHeartbeat() {
    await chmod(this.directory, 0o700);
    await chmod(join(this.directory, "attempts"), 0o755);
    const leasesDirectory = join(this.directory, "attempts", ".leases");
    await mkdir(leasesDirectory, { recursive: true, mode: 0o755 });

    /** 为当前租约写入宿主存活凭据，供恢复流程判断环境是否仍被有效持有。 */
    const writeHeartbeat = () =>
      writeFile(join(leasesDirectory, this.leaseId), "lease\n", {
        mode: 0o644,
      });
    await writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void writeHeartbeat().catch((error) => {
        this.heartbeatError = error;
        this.handleRunnerFailure(error);
      });
    }, 5_000);
  }

  /** 在当前会话锁内执行一轮，拒绝并发运行并保证收尾；复用已有 Runner 或按需创建新环境。 */
  async run(
    prompt: string,
    onEvent: (event: Event) => void = () => {},
    signal?: AbortSignal,
    options: RunOptions = {},
  ): Promise<Session> {
    if (this.isClosed || this.isRunning) {
      throw new Error("Conversation closed or already running");
    }
    if (/^\/(clear|reset|new)(?:\s|$)/i.test(prompt.trim())) {
      throw new Error(
        "Native session reset commands are unavailable; use another session ID",
      );
    }

    this.isRunning = true;
    try {
      const turn = await this.prepareTurn(prompt, onEvent, signal, options);
      /** 把外层 AbortSignal 转为本轮取消请求，异常交给本轮失败与停止确认流程处理。 */
      const cancel = () => this.cancelTurn(turn);
      const timeout = turn.task.timeoutMs > 0
        ? setTimeout(() => this.cancelTurn(turn, true, "task_timeout"), turn.task.timeoutMs)
        : undefined;
      signal?.addEventListener("abort", cancel, { once: true });

      try {
        // 名称必须在create前落盘，创建响应丢失时仍能找到并清理容器。
        await this.saveSession();
        if (turn.cancelled) throw new Error("Cancelled before start");
        await this.ensureRunnerStarted(turn);

        this.session.status = "running";
        this.session.environment = "ready";
        await this.saveSession();
        if (turn.cancelled) throw new Error("Cancelled before input");

        const result = await this.runnerChannel!.run(turn.task, () => {
          turn.submitted = true;
          if (turn.cancelled) this.cancelTurn(turn);
        });
        this.session.result = result.payload as Session["result"];
      } catch (error) {
        this.session.error = String(error);
      } finally {
        clearTimeout(timeout);
        clearTimeout(turn.interruptTimer);
        signal?.removeEventListener("abort", cancel);
        await this.finishTurn(turn);
      }

      // 返回快照，避免下一轮修改同一个对象，让上一轮结果跟着变化。
      return { ...this.session };
    } finally {
      this.activeTurn = undefined;
      this.isRunning = false;
    }
  }

  /** 检查恢复条件并建立本轮记录；此时还没向Runner发送用户输入。 */
  private async prepareTurn(
    prompt: string,
    onEvent: (event: Event) => void,
    signal?: AbortSignal,
    options: RunOptions = {},
  ): Promise<Turn> {
    await this.idleRecovery;
    if (this.needsReconciliation) {
      throw new Error(
        "Conversation requires reconciliation before another turn",
      );
    }
    if (this.heartbeatError) throw this.heartbeatError;

    if (this.containerId) {
      const environment = await this.controller.backend.inspect(
        this.containerId,
      );
      if (!environment?.running) await this.stopEnvironment();
    }
    const previous = this.session;
    // 旧会话可能没有能力快照，恢复时仍沿用原生对话首次运行记录的镜像 ID。
    const pinnedImage = this.options.capabilities?.imageId ??
      (previous.sdkSessionId ? previous.imageId : undefined);
    const imageId = await this.controller.backend.imageId(
      pinnedImage ?? this.controller.profile.image,
    );
    if (
      previous.sdkSessionId &&
      previous.capabilityDigest !== this.options.capabilities?.digest
    )
      throw new Error("Session capabilities changed; use a new conversation");
    if (
      previous.sdkSessionId &&
      previous.imageId &&
      previous.imageId !== imageId
    ) {
      throw new Error(
        "The runtime image changed; verify resume compatibility before upgrading this session",
      );
    }

    if (
      previous.sdkSessionId &&
      // 指令发生变化时不能静默接在旧原生对话后；调用方应创建新会话。
      previous.expertDigest !== this.options.expert?.digest
    )
      throw new Error("Session expert changed; use a new conversation");

    const task: Task = {
      dependencyCacheKey: this.options.dependencyCacheKey,
      networkDomains: this.options.networkDomains,
      hasLocalMcp: !!this.options.localMcp?.length,
      // 将固定专家快照写入 task.json，容器内 Runner 再转换成 SDK 选项。
      expert: this.options.expert,
      capabilities: this.options.capabilities,
      sessionId: this.sessionId,
      attemptId: options.attemptId ?? randomUUID(),
      generation: previous.generation + 1,
      prompt,
      model: this.options.gateway?.model ?? this.controller.profile.model,
      resumeId: previous.sdkSessionId,
      maxTurns: options.modelProbe ? Math.min(this.controller.profile.maxTurns || 3, 3) : this.controller.profile.maxTurns || undefined,
      maxBudgetUsd: this.controller.profile.maxBudgetUsd || undefined,
      timeoutMs: options.modelProbe ? Math.min(this.controller.profile.timeoutMs || 60_000, 60_000) : this.controller.profile.timeoutMs,
    };
    const directory = join(this.directory, "attempts", task.attemptId);
    await mkdir(directory, { mode: 0o755 });
    await writeFile(join(directory, "task.json"), JSON.stringify(task));

    const turn: Turn = {
      task,
      directory,
      onEvent,
      cancelled: signal?.aborted ?? false,
      submitted: false,
      forceStop: false,
    };
    this.tasksByAttempt.set(task.attemptId, task);
    this.activeTurn = turn;
    this.session = {
      expertDigest: this.options.expert?.digest,
      capabilityDigest: this.options.capabilities?.digest,
      sessionId: this.sessionId,
      generation: task.generation,
      attemptId: task.attemptId,
      sdkSessionId: previous.sdkSessionId,
      imageId,
      status: "starting",
      stopped: false,
      containerId: this.containerId ?? `ah-${task.attemptId}`,
      runnerId: this.runnerId ?? task.attemptId,
    };
    return turn;
  }

  /** 只有首轮或环境重建才启动进程，正常后续轮次直接复用管道。 */
  private async ensureRunnerStarted(turn: Turn) {
    if (this.runnerChannel) return;

    this.environmentCleanup = undefined;
    this.stderrWrites = Promise.resolve();
    this.containerId = this.session.containerId;
    this.runnerId = turn.task.attemptId;
    const mcpServers = await prepareMcpStartup(
      this.directory,
      turn.directory,
      this.options.localMcp,
      this.options.mcpServers,
    );
    const connection = {
      url: this.options.gateway?.url ?? this.controller.profile.gatewayUrl,
      token: this.options.gateway?.token ?? this.token,
      mcpServers,
      observeToolContent: this.options.observeToolContent === true,
    };
    await writeFile(
      join(turn.directory, "connection.json"),
      JSON.stringify(connection),
      { mode: 0o600 },
    );
    await this.controller.backend.create(
      turn.task,
      { ...this.controller.profile, image: this.session.imageId! },
      this.directory,
      turn.directory,
      true,
      this.leaseId,
    );
    if (turn.cancelled) throw new Error("Cancelled during create");
    await this.controller.backend.startSession(this.containerId!);
    if (turn.cancelled) throw new Error("Cancelled during start");

    const child = this.controller.backend.connect(
      this.containerId!,
      this.runnerId,
    );
    const channel = new RunnerChannel(
      child,
      this.sessionId,
      this.runnerId,
      (event) => this.recordEvent(event),
      (error) => {
        // 已经关闭的旧管道不能触发下一份环境的清理。
        if (this.runnerChannel === channel) this.handleRunnerFailure(error);
      },
    );
    this.runnerChannel = channel;
    child.stderr.on("data", (chunk) => {
      this.stderrWrites = this.stderrWrites.then(() =>
        appendFile(join(turn.directory, "stderr.log"), chunk, { mode: 0o600 }),
      );
      void this.stderrWrites.catch((error) => this.handleRunnerFailure(error));
    });
  }

  /** 用户停止先中断本轮；超时和明确关闭直接清理整个环境。 */
  private cancelTurn(turn: Turn, force = false, reason: Session["stopReason"] = "user_cancelled") {
    turn.stopReason ??= reason;
    turn.cancelled = true;
    turn.forceStop ||= force;
    // create尚未返回时不能并行stop；finishTurn会清理迟到的创建结果。
    if (!this.runnerChannel) return;
    if (force || this.options.localMcp?.length) {
      turn.forceStop = true;
      void this.stopEnvironment().catch(() => {});
      return;
    }
    if (!turn.submitted || turn.interruptTimer) return;
    try {
      this.runnerChannel.send({
        type: "interrupt",
        attemptId: turn.task.attemptId,
      });
      // 回执只表示请求已处理。必须等本轮result，超时则关闭容器兜底。
      turn.interruptTimer = setTimeout(
        () => this.cancelTurn(turn, true),
        this.controller.profile.interruptTimeoutMs ?? 5_000,
      );
    } catch {
      this.cancelTurn(turn, true);
    }
  }

  /** 强制结束当前执行环境，供明确关闭、超时或故障清理使用；不等同于仅中断当前消息。 */
  async terminate() {
    if (this.environmentCleanup) {
      try {
        await this.environmentCleanup;
      } catch {
        this.environmentCleanup = undefined;
      }
    }
    try {
      if (this.activeTurn) {
        const connected = Boolean(this.runnerChannel);
        this.cancelTurn(this.activeTurn, true, "environment_closed");
        // 创建尚未返回时只留强制停止意图；run收尾后再确认，不能抢在create前stop。
        if (!connected) return;
      }
      await this.stopEnvironment();
    } catch (error) {
      // Engine不可达时不再给旧环境续命；Keeper兜底，仍不能据此宣称已停止。
      clearInterval(this.heartbeatTimer);
      this.needsReconciliation = true;
      throw error;
    }
  }

  /** 成功或原生中断完成保留环境；强制停止或失败则清理。持久化失败同样不能留下无人管理的写入者。 */
  private async finishTurn(turn: Turn) {
    this.session.stopReason = turn.stopReason;
    try {
      const cancelFile = join(turn.directory, "cancel");
      if (turn.cancelled)
        await writeFile(cancelFile, "cancel\n", { mode: 0o600 });
      const externallyCancelled = await exists(cancelFile);
      const succeeded =
        !turn.cancelled &&
        !externallyCancelled &&
        !this.session.error &&
        this.session.result?.subtype === "success";

      const interrupted =
        turn.cancelled &&
        turn.submitted &&
        !turn.forceStop &&
        !this.session.error &&
        Boolean(this.session.result);
      if (
        (succeeded || interrupted) &&
        this.runnerChannel &&
        !this.environmentCleanup
      ) {
        const environment = await this.controller.backend.inspect(
          this.containerId!,
        );
        if (!environment?.running) {
          throw new Error("Session container stopped before turn completion");
        }
        // inspect期间管道也可能退出；不能只看刚取得的容器状态。
        if (!this.runnerChannel || this.environmentCleanup) {
          throw new Error("Resident Runner ended before turn completion");
        }
        this.session.status = interrupted ? "cancelled" : "succeeded";
        this.session.environment = "ready";
        this.session.stopped = false;
      } else {
        await this.stopEnvironment();
        this.session.stopped = true;
        this.session.environment = "closed";
        this.session.status =
          turn.stopReason === "task_timeout" ? "failed"
            : turn.cancelled || externallyCancelled ? "cancelled" : "failed";
      }
      await this.saveSession();
    } catch (error) {
      try {
        await this.stopEnvironment();
        this.session.stopped = true;
      } catch {
        // 停止仍未知，下面保存reconciling，下一轮不会继续执行。
      }
      this.needsReconciliation = true;
      clearInterval(this.heartbeatTimer);
      this.session.status = "reconciling";
      this.session.environment = "unknown";
      this.session.error = String(error);
      await this.saveSession();
    }
  }

  /** 后台事件保留创建轮次；没有归属的环境事件只进Runner总日志。 */
  private async recordEvent(received: RunnerEvent) {
    const { toolContent, ...event } = received;
    if (toolContent && this.options.observeToolContent && event.attemptId &&
        event.generation !== undefined && this.tasksByAttempt.get(event.attemptId)?.generation === event.generation &&
        (event.type === "tool.finished" || event.type === "tool.failed")) {
      // The side channel is stripped before either diagnostic log or the product stream.
      this.options.onToolContent?.(event, toolContent);
    }
    const runnerLog = join(
      this.directory,
      "attempts",
      this.runnerId!,
      "runner-events.jsonl",
    );
    await appendFile(runnerLog, JSON.stringify(event) + "\n", { mode: 0o600 });
    if (event.type === "sdk.session") {
      this.session.sdkSessionId = String(event.payload.id);
      await this.saveSession();
    }

    // 服务需要全部事件，包括空闲后台通知；不能放在本轮过滤之后。
    await this.options.onRuntimeNotice?.({ type: "runner.event", event });

    let task: Task | undefined;
    if (event.attemptId) {
      task = this.tasksByAttempt.get(event.attemptId);
      if (!task) throw new Error("Unknown Runner turn identity");
    } else if (
      ["runner.ready", "sdk.spawned", "runner.failed"].includes(event.type)
    ) {
      task = this.tasksByAttempt.get(this.runnerId!);
    }
    if (!task) return;
    if (event.attemptId && event.generation !== task.generation) {
      throw new Error("Invalid Runner turn generation");
    }

    const turnEvent: Event = {
      seq: event.seq,
      type: event.type,
      sessionId: this.sessionId,
      attemptId: task.attemptId,
      generation: task.generation,
      payload: event.payload,
    };
    const turnLog = join(
      this.directory,
      "attempts",
      task.attemptId,
      "events.jsonl",
    );
    await appendFile(turnLog, JSON.stringify(turnEvent) + "\n", {
      mode: 0o600,
    });
    if (this.activeTurn?.task.attemptId === task.attemptId) {
      this.activeTurn.onEvent(turnEvent);
    }
  }

  /** SDK事件和宿主收尾都可能保存状态，必须依次写同一份元数据文件。 */
  private saveSession() {
    const snapshot = structuredClone(this.session);
    const write = this.sessionWrites.then(async () => {
      await this.controller.store.save(snapshot);
      await this.options.onRuntimeNotice?.({
        type: "environment.changed",
        session: snapshot,
      });
    });
    // 调用方仍会收到write的错误；链尾恢复只是允许后续保存协调状态。
    this.sessionWrites = write.catch(() => {});
    return write;
  }

  /** 同一环境共用一次清理；无论谁触发，都等待相同的停止事实。 */
  private stopEnvironment(): Promise<void> {
    if (this.environmentCleanup) return this.environmentCleanup;

    const channel = this.runnerChannel;
    channel?.close();
    this.runnerChannel = undefined;
    const containerId = this.containerId;
    const runnerId = this.runnerId;
    this.environmentCleanup = (async () => {
      if (containerId) {
        await this.controller.backend.stop(containerId);
        await this.controller.backend.destroy(containerId);
      }
      // 先确认容器停止，再关闭宿主CLI连接、等事件消费结束，最后清凭证。
      channel?.child.kill();
      await channel?.drained;
      if (runnerId) {
        await clearStartupCredentials(
          join(this.directory, "attempts", runnerId),
        );
      }
      await this.stderrWrites;
      this.containerId = undefined;
      this.runnerId = undefined;
    })();
    return this.environmentCleanup;
  }

  /** 事件回调立即触发清理；执行中由finishTurn记结果，空闲时在此单独记结果。 */
  private handleRunnerFailure(error: unknown) {
    const cleanup = this.stopEnvironment();
    if (this.isRunning) {
      void cleanup.catch(() => {});
      return;
    }
    // Keeper只观察宿主心跳；Runner自身崩溃必须由宿主发现并处理。
    this.idleRecovery = this.finishIdleRecovery(error, cleanup);
    void this.idleRecovery.catch(() => {
      this.needsReconciliation = true;
    });
  }

  /** 处理空闲 Runner 故障后的清理与状态持久化；停止不明确则保留待核对，禁止下一轮直接复用。 */
  private async finishIdleRecovery(error: unknown, cleanup: Promise<void>) {
    this.session.error = String(error);
    this.session.status = "failed";
    try {
      await cleanup;
      this.session.stopped = true;
      this.session.environment = "closed";
    } catch (stopError) {
      this.needsReconciliation = true;
      clearInterval(this.heartbeatTimer);
      this.session.status = "reconciling";
      this.session.environment = "unknown";
      this.session.error = String(stopError);
    }
    await this.saveSession();
  }

  /** 等待活动轮次及异步收尾，确认环境停止、保存状态并释放会话锁；重复关闭不创建新的清理流程。 */
  async close() {
    if (this.isClosed) return;
    if (this.isRunning)
      throw new Error("Wait for the active turn before closing");
    this.isClosed = true;
    clearInterval(this.heartbeatTimer);
    try {
      await this.idleRecovery;
      // close是显式协调入口，允许重新核实上一次失败的停止操作。
      if (this.environmentCleanup) {
        try {
          await this.environmentCleanup;
        } catch {
          this.environmentCleanup = undefined;
        }
      }
      await this.stopEnvironment();
      // 也覆盖create成功但响应丢失的容器；DockerBackend核对环境归属。
      for (const containerId of await this.controller.backend.forSession(
        this.sessionId,
      )) {
        await this.controller.backend.stop(containerId);
        await this.controller.backend.destroy(containerId);
      }
      this.session.stopped = true;
      this.session.environment = "closed";
      await this.saveSession();
    } catch (error) {
      this.isClosed = false; // 停止未知时保留所有权，允许明确close重试。
      this.session.status = "reconciling";
      this.session.environment = "unknown";
      this.session.error = String(error);
      await this.saveSession();
      throw error;
    } finally {
      if (this.isClosed) await this.releaseSessionLock();
    }
  }
}
