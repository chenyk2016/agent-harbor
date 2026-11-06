/** 服务持有活的Conversation；客户端连接只负责提交和观看，不拥有执行生命周期。 */
import { createHash } from "node:crypto";
import type { Controller, Conversation, RuntimeNotice } from "../runtime/controller.js";
import type { ServiceStore } from "./service-store.js";
import { IdentityStore } from "./identity/store.js";
import { UsageStore } from "./usage/store.js";
import { sql } from "drizzle-orm";
import { AnalysisCleanupError } from "../runtime/app-analysis.js";
import type { AnalysisEnvironment } from "./observability/report-snapshots.js";
import { activeStatuses, fail, isModelProbe, type Message, type MessageStatus, type ServiceSession } from "./types.js";

/** 服务进程内持有的会话资源与异步完成凭据；浏览器断线不会移交或结束这里的执行所有权。 */
interface LiveSession {
  conversation?: Conversation;
  connectionDigest?:string;
  backgroundTasks?: Set<string>;
  active?: { id: string; abort: AbortController; done: Promise<void> };
  closing?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
}
/** 管理服务端会话的接收、执行、文件互斥及关闭；把持久记录与 Controller 的实际环境生命周期连接起来。 */
export class SessionManager {
  tracing?: import("./tracing/service.js").TracingService;
  deletions?: import("./deletions/service.js").ResourceDeletions;
  /** 应用模块只补写入门；普通会话不配置该钩子，原行为保持。 */
  applicationWriteGuard?: (sessionId: string, message?: { id: string; text: string }) => Promise<void>;
  onUserClose?: (userId: string) => Promise<void>;
  onRoundCancel?: (sessionId:string)=>Promise<void>;
  onEnvironmentClose?: (sessionId:string)=>Promise<void>;
  modelSelection?: (userId:string, deploymentId?:string, setupTest?:boolean)=>Promise<import("../shared/llm.js").ModelSnapshot>;
  modelConnection?: (session:ServiceSession)=>Promise<import("../shared/llm.js").GatewayConnection>;
  runtimeConnections?: (session:ServiceSession)=>Promise<import("../shared/mcp.js").McpRuntime>;
  analysisScope?: (owner: string, appId: string) => Promise<void>;
  analysisRun?: (session: ServiceSession, message: Message, gateway: import("../shared/llm.js").GatewayConnection, signal: AbortSignal) => Promise<void>;
  readonly identity: IdentityStore;
  readonly usage: UsageStore;
  private creations = new Map<string, number>();
  private admission = Promise.resolve();
  private userUploads = new Set<string>();
  private live = new Map<string, LiveSession>();
  private fileWrites = new Map<string, Promise<unknown>>();
  stopping = false;
  storageUnavailable = false;
  recoveryFailed = false;
  /** 接入存储、Controller、网关凭据与容量限制，并将存储故障绑定为停止接收和清理环境的信号。 */
  constructor(
    readonly store: ServiceStore,
    readonly controller: Pick<Controller, "open">,
    private gatewayToken: string,
    private idleMs = 15 * 60_000,
    private capacity = 4,
  ) {
    this.identity = new IdentityStore(store.db);
    this.usage = new UsageStore(store.db);
    store.onFailure = error => this.storageFailure(error);
  }
  /** 表示本进程是否能继续接收执行；不代表模型供应商或每个既有容器已通过健康检查。 */
  get ready() { return !this.stopping && !this.storageUnavailable && !this.recoveryFailed; }
  /** 读取用户拥有且未被删除流程占用的会话，作为管理和文件入口的归属检查。 */
  async owned(userId: string, id: string, analysis = false, modelProbe = false): Promise<ServiceSession> {
    const session = await this.store.session(id);
    if (!session || session.ownerId !== userId || !!session.analysisAppId !== analysis || isModelProbe(session) !== modelProbe) fail(404, "SESSION_NOT_FOUND");
    await this.deletions?.guardSession(id);
    return session;
  }
  /** 删除占位与消息/上传接收使用同一短锁；停止和文件清理不持有这个锁。 */
  async admitDeletion<T>(userId: string, id: string | null, register: () => Promise<T>, duplicate?: () => Promise<T | undefined>) {
    return this.withAdmission(async () => {
      this.writable(); await this.identity.require(userId);
      const old = await duplicate?.(); if (old) return old;
      if (id) {
        const session = await this.store.session(id);
        if (!session || session.ownerId !== userId) fail(404, "SESSION_NOT_FOUND");
        if (this.fileWrites.has(id)) fail(409, "FILE_TRANSFER_BUSY");
      }
      return register();
    });
  }
  /** 在接收锁内登记关闭，锁外等待实际环境停止，再通知关联运行资源清理。 */
  async stopForDeletion(userId: string, id: string) {
    const { done } = await this.withAdmission(async () => {
      const session = await this.store.session(id);
      if (!session || session.ownerId !== userId) fail(404, "SESSION_NOT_FOUND");
      const live = this.live.get(id);
      return { done: live ? this.startClose(id, live) : Promise.resolve() };
    });
    await done;
    await this.onEnvironmentClose?.(id);
  }
  /** 统一拒绝停服、存储失效或启动恢复未完成时的新写入。 */
  private writable() {
    if (this.stopping) fail(503, "SERVICE_STOPPING");
    if (this.storageUnavailable) fail(503, "STORAGE_UNAVAILABLE");
    if (this.recoveryFailed) fail(503, "RECONCILING");
  }
  /**
   * 单执行服务的短接收锁：把异步检查和占位连在一起。
   * 只串行接收/登记，不等待模型执行、文件传输或模板复制。
   */
  private async withAdmission<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  /** 在接收锁内检查账号和会话额度后创建普通会话；不会准备应用模板。 */
  async create(userId: string, title: string, id?: string) {
    const model=await this.modelSelection?.(userId);
    return this.withAdmission(async () => {
      this.writable(); await this.identity.ensure(userId); await this.identity.require(userId);
      const pending = this.creations.get(userId) ?? 0;
      if ((await this.counts(userId)).sessions + pending >= (await this.identity.policy(userId)).sessions) fail(409, "SESSION_LIMIT");
      this.writable();
      return this.store.create(userId, title, id, {model});
    });
  }
  /** 先预约会话额度，在锁外准备模板等文件，再持久化模型、expert 和技能快照；失败也释放预约。 */
  async createPrepared(userId: string, title: string, id: string, prepare: () => Promise<void>, creation: { model?: import("../shared/llm.js").ModelSnapshot; deploymentId?: string; expert?: import("../shared/experts.js").ExpertSnapshot; snapshot?: import("../shared/skills.js").CapabilitySnapshot; requestId?: string; hash?: string; modelProbe?: boolean } = {}) {
    await this.withAdmission(async () => {
      this.writable(); await this.identity.require(userId);
      const pending = this.creations.get(userId) ?? 0;
      if ((await this.counts(userId)).sessions + pending >= (await this.identity.policy(userId)).sessions) fail(409, "SESSION_LIMIT");
      this.creations.set(userId, pending + 1);
    });
    try {
      if(this.modelSelection) creation.model=await this.modelSelection(userId,creation.deploymentId,creation.modelProbe);
      else if(creation.deploymentId) fail(409,"LLM_DISABLED");
      await prepare();
      return await this.withAdmission(async () => {
        this.writable(); await this.identity.require(userId);
        // 准备期间管理员可能调低额度；提交前再核对，但不重复占自己的预约。
        if ((await this.counts(userId)).sessions >= (await this.identity.policy(userId)).sessions) fail(409, "SESSION_LIMIT");
        return this.store.create(userId, title, id, creation);
      });
    } finally {
      await this.withAdmission(async () => {
        const remaining = this.creations.get(userId)! - 1;
        if (remaining) this.creations.set(userId, remaining); else this.creations.delete(userId);
      });
    }
  }
  /** 合并持久消息和本进程资源，统计用户的会话、执行中任务及占用环境数量。 */
  async counts(userId: string) {
    const sessions = await this.store.sessions(userId, Number.MAX_SAFE_INTEGER);
    const active = await this.store.activeSessionIds(sessions.map(session => session.id));
    return { sessions: sessions.length,
      tasks: sessions.filter(session => !!this.live.get(session.id)?.active || active.has(session.id)).length,
      environments: sessions.filter(session => this.live.has(session.id) || session.environment !== "closed").length };
  }
  /** 停用先写身份记录、撤销连接，再调用这里停止其全部环境；失败仍保留占位。 */
  async closeUser(userId: string) {
    const sessions = await this.store.sessions(userId, Number.MAX_SAFE_INTEGER);
    const results = await Promise.allSettled(sessions.map(async session => {
      const live = this.live.get(session.id);
      if (live) await this.closeLive(session.id, live);
      else if (session.environment !== "closed") throw new Error("Environment requires reconciliation");
    }));
    const apps = await Promise.allSettled([this.onUserClose?.(userId)]);
    if ([...results, ...apps].some(r => r.status === "rejected")) fail(503, "USER_CLEANUP_UNCONFIRMED");
  }

  /** 读文件不启动容器；状态未知或服务关闭时不再接收新文件操作。 */
  async fileAccess(userId: string, id: string) {
    const session = await this.owned(userId, id);
    this.writable();
    if (["stopping", "reconciling"].includes(session.environment)) fail(503, "RECONCILING");
    return session;
  }
  /** 接收时占用会话文件写入和用户上传名额，阻止与生成并发写文件；实际传输在接收锁外完成。 */
  async withFileWrite<T>(userId: string, id: string, work: () => Promise<T>) {
    const { operation } = await this.withAdmission(async () => {
      await this.fileAccess(userId, id);
      await this.applicationWriteGuard?.(id);
      if (this.live.get(id)?.active || await this.store.active(id)) fail(409, "SESSION_BUSY");
      if (this.userUploads.has(userId) || this.fileWrites.has(id)) fail(409, "FILE_TRANSFER_BUSY");
      const operation = Promise.resolve().then(work);
      this.fileWrites.set(id, operation); this.userUploads.add(userId);
      // 用对象返回Promise，接收锁在传输结束前释放，其他会话仍可工作。
      return { operation };
    });
    try { return await operation; } finally { this.fileWrites.delete(id); this.userUploads.delete(userId); }
  }

  async analysisSession(owner: string, appId: string, environment: AnalysisEnvironment) {
    return this.withAdmission(async () => {
      this.writable();
      if (!this.analysisScope || !this.analysisRun || !this.modelConnection) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
      await this.analysisScope(owner, appId);
      const existing = (await this.store.analysisSessions(appId)).find(session => session.analysisEnvironment === environment);
      if (existing) {
        if (existing.ownerId !== owner) fail(404, "SESSION_NOT_FOUND");
        return existing;
      }
      const pending = this.creations.get(owner) ?? 0;
      if ((await this.counts(owner)).sessions + pending >= (await this.identity.policy(owner)).sessions)
        fail(409, "SESSION_LIMIT");
      return this.store.createAnalysisSession(owner, appId, environment);
    });
  }

  /** 去重先于忙判断；最终并发窗口由数据库行锁和唯一约束兜住。 */
  async submit(userId: string, sessionId: string, clientMessageId: string, text: string, deploymentId?: string, analysis = false, modelProbe = false) {
    return this.withAdmission(async () => {
      const session = await this.owned(userId, sessionId, analysis, modelProbe);
      if (session.analysisAppId) {
        if (!this.analysisScope || !this.analysisRun) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
        await this.analysisScope(userId, session.analysisAppId);
      }
      const old = await this.store.duplicate(sessionId, clientMessageId);
      if (old) {
        if (old.text !== text || (old.requestedDeploymentId ?? null) !== (deploymentId ?? null)) fail(409, "MESSAGE_ID_CONFLICT");
        return { duplicate: true, message: old };
      }
      this.writable();
      await this.identity.require(userId);
      const limits = await this.identity.policy(userId), counts = await this.counts(userId);
      if (this.userUploads.has(userId)) fail(409, "FILE_TRANSFER_BUSY");
      if (this.fileWrites.has(sessionId)) fail(409, "FILE_TRANSFER_BUSY");
      const existing = this.live.get(sessionId);
      if (existing?.closing) fail(409, "SESSION_CLOSING");
      if (session.environment === "reconciling") fail(503, "RECONCILING");
      // 以数据库为准：上一条已终止时，内存里的执行句柄可能还在收尾，不能把新消息挡在外面。
      if (await this.store.active(sessionId)) fail(409, "SESSION_BUSY");
      if (!existing && this.live.size >= this.capacity) fail(503, "CAPACITY_REACHED");
      if (counts.tasks >= limits.tasks) fail(429, "TASK_LIMIT");
      if (!existing && counts.environments >= limits.environments) fail(429, "ENVIRONMENT_LIMIT");
      await this.applicationWriteGuard?.(sessionId, { id: clientMessageId, text });
      // 稳定别名：每轮都按部署的当前指针解析版本；消息快照记录本轮实际版本。
      const model = this.modelSelection
        ? await this.modelSelection(userId, deploymentId ?? session.modelSnapshot?.deploymentId, modelProbe)
        : undefined;
      if (deploymentId && !this.modelSelection) fail(409, "LLM_DISABLED");
      if (model && model.deploymentId !== session.modelSnapshot?.deploymentId && existing?.backgroundTasks?.size)
        fail(409, "MODEL_BACKGROUND_BUSY");
      const accepted = await this.store.accept(sessionId, clientMessageId, text, model, deploymentId);
      if (accepted.duplicate) return { duplicate: true, message: accepted.message };
      const message = accepted.message;
      const live = existing ?? {};
      clearTimeout(live.idleTimer);
      this.live.set(sessionId, live);
      const abort = new AbortController();
      // 先登记active再启动异步执行，accepted立即取消也能找到它。
      const done = Promise.resolve().then(() => this.execute(sessionId, live, message, abort, !!session.analysisAppId));
      live.active = { id: message.id, abort, done };
      void done.catch(error => this.storageFailure(error));
      return { duplicate: false, message };
    });
  }

  /** 应用写操作在与上传/消息相同的短接收门内占位，不能把模型或Docker执行放在这里。 */
  async admitApplicationChange<T>(userId: string, sessionId: string, register: () => Promise<T>, lookupDuplicate?: () => Promise<T | undefined>): Promise<T> {
    return this.withAdmission(async () => {
      await this.owned(userId, sessionId); this.writable(); await this.identity.require(userId);
      const duplicate = await lookupDuplicate?.();
      if (duplicate) return duplicate;
      if (this.fileWrites.has(sessionId) || this.userUploads.has(userId) || await this.store.active(sessionId)) fail(409, "SESSION_BUSY");
      if (this.live.get(sessionId)?.closing) fail(409, "SESSION_CLOSING");
      return register();
    });
  }

  /** 由应用收尾执行器在execute外部等待，避免close等待自己的active.done。 */
  async awaitApplicationMessage(sessionId: string, messageId: string) {
    const active = this.live.get(sessionId)?.active;
    if (active?.id === messageId) await active.done;
  }

  /** 根据消息固定模型和会话 expertSnapshot 打开或复用 Conversation，执行本轮并保存状态；最后安排空闲回收。 */
  private async execute(id: string, live: LiveSession, message: Message, abort: AbortController, analysis: boolean) {
    try {
      if (abort.signal.aborted) {
        await this.store.transition(message.id, "cancelled");
        return;
      }
      const currentSession=(await this.store.session(id))!;
      // The accepted message owns its model, never a mutable personal default.
      const targetSession = message.modelSnapshot ? { ...currentSession, modelSnapshot: message.modelSnapshot } : currentSession;
      if (message.modelSnapshot && message.modelSnapshot.deploymentId !== currentSession.modelSnapshot?.deploymentId && live.backgroundTasks?.size)
        fail(409, "MODEL_BACKGROUND_BUSY");
      const gateway=await this.modelConnection?.(targetSession);
      if (message.modelSnapshot && gateway) await this.store.activateModel(message, message.modelSnapshot);
      if(currentSession.modelSnapshot&&!gateway)fail(503,"LLM_DISABLED");
      if (analysis) {
        if (!gateway || !this.analysisRun) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
        await this.store.environment(id, "starting");
        await this.store.transition(message.id, "running");
        await this.analysisRun(currentSession, message, gateway, abort.signal);
        await this.onEnvironmentClose?.(id);
        abort.signal.throwIfAborted();
        await this.store.environment(id, "closed");
        await this.store.transition(message.id, "succeeded", { environment: "closed" });
        return;
      }
      const probe = isModelProbe(currentSession);
      const runtime = probe ? undefined : await this.runtimeConnections?.(currentSession);
      const mcpServers=runtime?.mcpServers,networkDomains=runtime?.networkDomains;
      const connectionDigest=createHash('sha256').update(JSON.stringify({runtime,gateway})).digest('hex');
      // 凭据更新或连接被撤回时不能继续用旧进程的MCP配置。
      if(live.conversation&&live.connectionDigest!==connectionDigest){await live.conversation.close();live.conversation=undefined;live.backgroundTasks?.clear();}
      live.connectionDigest=connectionDigest;
      const previousEnvironment = currentSession.environment;
      await this.store.environment(id, "starting");
      live.conversation ??= await this.controller.open(id, gateway?.token ?? this.gatewayToken, {
        gateway,
        dependencyCacheKey: createHash("sha256").update(`user:${currentSession.ownerId}`).digest("hex"),
        mcpServers,networkDomains,
        localMcp: runtime?.localMcp,
        // 从持久化会话读取创建时的专家，而非读取可随时编辑的专家定义。
        expert: (await this.store.session(id))!.expertSnapshot ?? undefined,
        capabilities: (await this.store.session(id))!.capabilitySnapshot ?? undefined,
        observeToolContent: this.tracing?.capturesContent,
        onToolContent: (event, content) => this.tracing?.observeToolContent(id, event, content),
        onRuntimeNotice: notice => this.notice(id, live, notice),
      });
      if (this.storageUnavailable) throw new Error("Storage unavailable during open");
      if (abort.signal.aborted) {
        await this.store.environment(id, previousEnvironment);
        await this.store.transition(message.id, "cancelled");
        return;
      }
      await this.store.transition(message.id, "running");
      const result = await live.conversation.run(message.text, undefined, abort.signal, { attemptId: message.id, modelProbe: probe });
      if (this.storageUnavailable) return;
      const status: MessageStatus = result.status === "reconciling" ? "reconciling"
        : result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
      if(result.environment==='closed'||result.environment==='unknown')await this.onEnvironmentClose?.(id);
      const storedMessage = await this.store.message(message.id);
      const reason = result.stopReason === "user_cancelled" && !storedMessage?.cancelRequested
        ? "environment_closed" : result.stopReason;
      await this.store.transition(message.id, status, {
        status: result.status, environment: result.environment, result: result.result, reason,
        ...(result.stopReason === "task_timeout" ? { error: "TASK_TIMEOUT" }
          : status === "failed" ? { error: "EXECUTION_FAILED" } : {}),
      });
    } catch (error) {
      if (!analysis) console.error("Session execution failed", error);
      if (!this.storageUnavailable) {
        let status: MessageStatus = abort.signal.aborted ? "cancelled" : "failed";
        const stops=await Promise.allSettled([this.onEnvironmentClose?.(id),live.conversation?.terminate()]);
        if(error instanceof AnalysisCleanupError || stops.some(stop=>stop.status==="rejected"))status="reconciling";
        await this.store.environment(id, status === "reconciling" ? "reconciling" : "closed");
        await this.store.transition(message.id, status, { error: error instanceof Error && "code" in error ? String(error.code) : analysis ? "APPLICATION_ANALYSIS_FAILED" : "EXECUTION_PREPARE_FAILED" });
      }
    } finally {
      // 只有仍是本轮的执行句柄才能清空；上一轮收尾不能覆盖下一轮已登记的active。
      if (live.active?.id === message.id) live.active = undefined;
      if (this.storageUnavailable) {
        await this.cleanup(id, live).catch(error => console.error("Storage failure cleanup failed", error));
      } else if (analysis && !live.active && !live.closing) {
        this.live.delete(id);
      } else if (!live.active && !live.closing && !this.stopping) {
        live.idleTimer = setTimeout(() => {
          void this.closeLive(id, live, true).catch(error => console.error("Idle cleanup failed", error));
        }, this.idleMs);
        live.idleTimer.unref();
      }
    }
  }

  /** 将运行器通知转成受筛选的产品事件，关联模型请求与消息、记录工具进度，并在结果阶段处理用量。 */
  private async notice(id: string, live: LiveSession, notice: RuntimeNotice) {
    // 故障清理仍会通知环境变化；此时不能递归依赖已经失败的数据库。
    if (this.storageUnavailable) return;
    if (notice.type === "environment.changed") {
      const session = notice.session;
      await this.store.environment(id, session.environment === "unknown" ? "reconciling"
        : session.environment ?? (session.stopped === true ? "closed" : "starting"));
      return;
    }
    const event = notice.event;
    // 服务仅转发对用户有意义的字段；原始SDK、配置、诊断继续留在运行目录。
    const source = `${event.runnerId}:${event.seq}`;
    const messageId = event.attemptId ?? null;
    if (event.type === "assistant.text.delta") {
      await this.store.event(id, messageId, event.type, { text: event.payload.text }, source);
    } else if (event.type === "model.request.link") {
      const requestId = event.payload.requestId;
      if (messageId && typeof requestId === "string") {
        // 只允许同会话的SDK回执绑定一次；同ID的碎片事件可重放。
        await this.store.db.execute(sql`UPDATE wallet_requests SET "messageId"=${messageId} WHERE id=${requestId} AND "sessionId"=${id} AND ("messageId" IS NULL OR "messageId"=${messageId})`);
        await this.store.event(id, messageId, event.type, { requestId }, source);
      }
    } else if (["tool.finished", "tool.failed", "tool.denied", "agent.started", "agent.finished"].includes(event.type)) {
      const allowed = new Set(["toolUseId", "name", "agentId", "promptId", "durationMs", "outcome", "at"]);
      await this.store.event(id, messageId, event.type, Object.fromEntries(Object.entries(event.payload).filter(([key]) => allowed.has(key))), source);
    } else if (event.type === "tool.started") {
      const detail =
        typeof event.payload.detail === "string"
          ? event.payload.detail
          : undefined;
      await this.store.event(id, messageId, event.type, {
        name: event.payload.name,
        toolUseId: event.payload.toolUseId, agentId: event.payload.agentId,
        promptId: event.payload.promptId, at: event.payload.at,
        ...(detail ? { detail } : {}),
      }, source);
    } else if (event.type === "sdk.task") {
      const { task_id, subtype, status } = event.payload;
      live.backgroundTasks ??= new Set();
      if (subtype === "task_started" || subtype === "task_progress") live.backgroundTasks.add(String(task_id));
      if (subtype === "task_notification") live.backgroundTasks.delete(String(task_id));
      await this.store.event(id, messageId, "task.updated", { taskId: task_id, subtype, status }, source);
    } else if (event.type === "agent.result" && live.active?.id === messageId) {
      try {
        const session = await this.store.session(id);
        await this.usage.record(session!.ownerId, id, messageId, event.runnerId, event.payload.costUsd, event.payload.usage);
      } catch (error) { this.storageFailure(error); throw error; }
      await this.store.transition(messageId, "finalizing");
    }
  }

  /** 关闭指定用户使用 WorkBuddy 专家配置的活环境，使连接撤回后不能继续使用旧进程配置。 */
  async disconnectExpertConnections(user:string) {
    for(const [id,live] of this.live) {
      const session=await this.store.session(id);
      if(session?.ownerId===user&&session.expertSnapshot?.workbuddy){
        let unavailable=false;try{await this.runtimeConnections?.(session);}catch{unavailable=true;}
        if(unavailable)await this.closeLive(id,live);
      }
    }
  }
  /** 限定到指定活动消息发出本轮中断；已结束消息直接返回终态，不误取消后续轮次。 */
  async cancel(userId: string, id: string, messageId: string, analysis = false) {
    await this.owned(userId, id, analysis);
    const message = await this.store.message(messageId);
    if (!message || message.sessionId !== id) fail(404, "MESSAGE_NOT_FOUND");
    if (!activeStatuses.includes(message.status)) return { terminal: true, message };
    this.writable();
    if (message.status === "reconciling") fail(503, "RECONCILING");
    const active = this.live.get(id)?.active;
    if (!active || active.id !== messageId) fail(503, "RECONCILING");
    const updated = await this.store.requestCancel(messageId);
    if (!activeStatuses.includes(updated.status)) return { terminal: true, message: updated };
    // 固定原消息的控制器；await期间live.active可能已换成下一轮或被清空。
    active.abort.abort();
    await this.onRoundCancel?.(id);
    return { terminal: false, message: updated };
  }

  /** close绑定客户端看到的最新消息，旧请求不会关闭后来的一轮。 */
  async close(userId: string, id: string, expectedMessageId: string | null) {
    return this.withAdmission(async () => {
      const session = await this.owned(userId, id);
      if (session.lastMessageId !== expectedMessageId) fail(409, "STALE_CLOSE");
      this.writable();
      const live = this.live.get(id);
      if (!live && session.environment === "closed") return { closed: true };
      if (!live) fail(503, "RECONCILING");
      void this.startClose(id, live).catch(error => console.error("Close failed", error));
      return { closed: false };
    });
  }

  /** 在接收锁内检查活资源是否仍属于原会话，再在锁外等待关闭；空闲回收不会误关新任务。 */
  private async closeLive(id: string, live: LiveSession, onlyIfIdle = false): Promise<void> {
    const { done } = await this.withAdmission(async () => {
      // 定时器可能在接收等待期间已触发；取得锁后不能再关闭刚开始的新任务。
      if (this.live.get(id) !== live || onlyIfIdle && live.active) return { done: Promise.resolve() };
      return { done: this.startClose(id, live) };
    });
    await done;
  }
  /** 只登记关闭；实际停止不持有接收锁，避免一个慢容器挡住其他会话。 */
  private startClose(id: string, live: LiveSession): Promise<void> {
    if (live.closing) return live.closing;
    clearTimeout(live.idleTimer);
    // Promise微任务让closing在任何await/回调之前完成占位。
    live.closing = Promise.resolve().then(async () => {
      if (!this.storageUnavailable) await this.store.environment(id, "stopping");
      try {
        await this.cleanup(id, live);
        if (!this.storageUnavailable) {
          await this.store.environment(id, "closed");
          const unfinished = await this.store.active(id);
          if (unfinished) await this.store.transition(unfinished.id, "interrupted");
        }
        this.live.delete(id);
      } catch (error) {
        if (!this.storageUnavailable) await this.store.environment(id, "reconciling");
        live.closing = undefined; // 允许明确close重试清理。
        throw error;
      }
    });
    return live.closing;
  }
  /** 中断活动消息并尝试停止关联资源和 Conversation；汇总失败，任一停止不明都不能宣称环境关闭。 */
  private async cleanup(_id: string, live: LiveSession) {
    live.active?.abort.abort();
    // 一个执行器停止失败时仍停止另一个；未知状态保持占位，不能提前宣称closed。
    const stops=await Promise.allSettled([this.onEnvironmentClose?.(_id),live.conversation?.terminate()]);
    if(stops[1].status==="fulfilled")await live.active?.done;
    const closed=await Promise.allSettled([live.conversation?.close()]);
    const failure=[...stops,...closed].find(result=>result.status==="rejected");
    if(failure?.status==="rejected")throw failure.reason;
  }
  /** 写库失败后立即阻止新执行；直接清理，不要求故障日志还能写入同一DB。 */
  storageFailure(error: unknown) {
    if (this.storageUnavailable) return;
    this.storageUnavailable = true;
    console.error("Service storage unavailable", error);
    for (const [id,live] of this.live.entries()) {
      clearTimeout(live.idleTimer);
      live.active?.abort.abort();
      void this.onEnvironmentClose?.(id).catch(()=>{});
      void live.conversation?.terminate().catch(error => console.error("Emergency stop failed", error));
    }
  }
  /** 停止接收，等待删除和文件写入，再关闭所有活会话；存在未确认清理时向调用方报错。 */
  async shutdown() {
    this.stopping = true;
    await this.deletions?.close();
    await Promise.allSettled(this.fileWrites.values());
    const results = await Promise.allSettled([...this.live].map(([id, live]) => this.closeLive(id, live)));
    if (results.some(result => result.status === "rejected")) throw new Error("Environment cleanup unconfirmed");
  }
}
