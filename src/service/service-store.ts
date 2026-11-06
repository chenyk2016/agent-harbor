/** 控制面存储：接收、去重、状态和事件在同一事务提交；事务内不调用Docker或模型。 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { Database, Tx } from "./db/client.js";
import { uniqueViolation } from "./db/client.js";
import { events, messages, sessions, users, monthlyMessageUsage } from "./db/schema/index.js";
import { activeStatuses, fail, type ServiceSession, type Message, type MessageStatus, type ServiceEvent, type Environment } from "./types.js";

import { messagePeriod } from "./limits/policy.js";
import { lockDeploymentForUse } from "./llm/deletion.js";

const terminalStatuses: MessageStatus[] = ["succeeded", "failed", "cancelled", "interrupted"];
/** 识别带 HTTP 业务状态的异常，避免把正常的权限或并发冲突当成存储不可用。 */
const isServiceError = (error: unknown) => error instanceof Error && "status" in error;

/** 服务会话的持久化入口，负责消息去重、状态和顺序事件；只保存数据，不拥有模型或容器生命周期。 */
export class ServiceStore {
  onFailure?: (error: unknown) => void;
  /** 注入控制面数据库，存储故障回调由 SessionManager 安装。 */
  constructor(readonly db: Database) {}

  /** SQL错误触发服务停止接收执行；业务冲突（409/404）不被当作磁盘故障。 */
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (!isServiceError(error) && !uniqueViolation(error)) this.onFailure?.(error);
      throw error;
    }
  }

  /** 锁会话行，让同一会话的接收、事件编号与状态变更串行；跨会话仍可并发。 */
  private async lockSession(tx: Tx, id: string) {
    const [row] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).for("update");
    if (!row) fail(404, "SESSION_NOT_FOUND");
  }

  /** 按编号读取服务会话及创建时固定的专家、技能和模型快照；本方法不检查访问者归属。 */
  async session(id: string) {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row as ServiceSession | undefined;
  }
  /** 传入用户时读取其最近会话；内部管理流程省略用户时读取全部，调用方负责访问控制。 */
  async sessions(ownerId?: string, limit = 100, includeAnalysis = true) {
    const rows = ownerId === undefined
      ? await this.db.select().from(sessions).orderBy(desc(sessions.updatedAt))
      : await this.db.select().from(sessions).where(and(eq(sessions.ownerId, ownerId), includeAnalysis ? undefined : sql`${sessions.analysisAppId} IS NULL`)).orderBy(desc(sessions.updatedAt)).limit(limit);
    return rows as ServiceSession[];
  }
  /** 网页全量列表按不会随执行变化的创建时间分页；展示时再按最近更新排序。 */
  async sessionPage(ownerId: string, limit: number, after?: ServiceSession) {
    const where = after
      ? and(eq(sessions.ownerId, ownerId), or(
        sql`${sessions.createdAt} < ${after.createdAt}`,
        and(eq(sessions.createdAt, after.createdAt), sql`${sessions.id} < ${after.id}`),
      ))
      : eq(sessions.ownerId, ownerId);
    const rows = await this.db.select().from(sessions).where(and(where, sql`${sessions.analysisAppId} IS NULL`))
      .orderBy(desc(sessions.createdAt), desc(sessions.id)).limit(limit);
    return rows as ServiceSession[];
  }
  async analysisSessions(appId: string) {
    return await this.db.select().from(sessions).where(eq(sessions.analysisAppId, appId)) as ServiceSession[];
  }
  async createAnalysisSession(ownerId: string, appId: string, environment: "preview" | "production") {
    const now = Date.now();
    const [session] = await this.db.insert(sessions).values({
      id: randomUUID(), ownerId, title: "应用问数", analysisAppId: appId, analysisEnvironment: environment,
      createdAt: now, updatedAt: now,
    }).returning();
    return session as ServiceSession;
  }
  async recentAnalysisHistory(id: string) {
    const rows = await this.db.select().from(messages)
      .where(and(eq(messages.sessionId, id), eq(messages.status, "succeeded")))
      .orderBy(desc(messages.createdEventId)).limit(3);
    return rows.reverse();
  }
  async analysisAnswer(sessionId: string, messageId: string) {
    const rows = await this.db.select({ payload: events.payload }).from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.messageId, messageId), eq(events.type, "assistant.text.delta")))
      .orderBy(asc(events.eventId));
    return rows.map(row => JSON.parse(row.payload).text).join("");
  }
  async analysisMessages(id: string) {
    const rows = await this.db.select().from(messages).where(eq(messages.sessionId, id))
      .orderBy(desc(messages.createdEventId)).limit(20);
    return rows.reverse() as Message[];
  }
  async analysisEvents(id: string, ids: string[], through: number) {
    if (!ids.length) return [];
    const rows = await this.db.select().from(events).where(and(eq(events.sessionId, id),
      inArray(events.messageId, ids), lte(events.eventId, through),
      inArray(events.type, ["assistant.text.delta", "analysis.report"]))).orderBy(asc(events.eventId));
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) })) as ServiceEvent[];
  }
  /** 按内部消息编号读取一条消息，供执行轮询和状态转换使用。 */
  async message(id: string) {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row as Message | undefined;
  }
  /** 批量读取消息快照，供事件回放或客户端状态补齐使用。 */
  async messagesByIds(ids: string[]) {
    if (!ids.length) return [] as Message[];
    return await this.db.select().from(messages).where(inArray(messages.id, ids)) as Message[];
  }
  /** 按会话和客户端消息编号查找已接收消息，网络重试沿用同一执行记录。 */
  async duplicate(sessionId: string, clientMessageId: string) {
    const [row] = await this.db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientMessageId, clientMessageId))).limit(1);
    return row as Message | undefined;
  }
  /** 读取会话当前未结束消息；包括待核对状态，防止故障后接收第二个写入者。 */
  async active(sessionId: string) {
    const [row] = await this.db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.status, activeStatuses))).limit(1);
    return row as Message | undefined;
  }
  /** 一次取回多个会话的活动消息归属，额度统计不必逐会话往返。 */
  async activeSessionIds(sessionIds: string[]) {
    if (!sessionIds.length) return new Set<string>();
    const rows = await this.db.select({ sessionId: messages.sessionId }).from(messages)
      .where(and(inArray(messages.sessionId, sessionIds), inArray(messages.status, activeStatuses)));
    return new Set(rows.map(row => row.sessionId));
  }
  /** 从创建事件游标后按顺序读取消息，供历史对话分页加载。 */
  async messages(sessionId: string, after = 0, limit = 50) {
    return await this.db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), gt(messages.createdEventId, after)))
      .orderBy(asc(messages.createdEventId)).limit(limit) as Message[];
  }
  /** 按创建请求编号查找用户已有会话，供创建重试恢复原结果。 */
  async creation(ownerId: string, requestId: string) {
    const [row] = await this.db.select().from(sessions).where(and(eq(sessions.ownerId, ownerId), eq(sessions.creationRequestId, requestId)));
    return row as ServiceSession | undefined;
  }
  /** 事务创建会话并保存创建时的 model、expert 和技能快照；其中 expert 成为后续执行读取的 expertSnapshot。 */
  async create(ownerId: string, title: string, id: string = randomUUID(), creation: { model?: import("../shared/llm.js").ModelSnapshot; deploymentId?: string; expert?: import("../shared/experts.js").ExpertSnapshot; snapshot?: import("../shared/skills.js").CapabilitySnapshot; requestId?: string; hash?: string } = {}) {
    const now = Date.now();
    return this.transaction(async tx => {
      if (creation.model) await lockDeploymentForUse(tx, creation.model.deploymentId);
      await tx.insert(sessions).values({ id, ownerId, title, modelSnapshot: creation.model, expertSnapshot: creation.expert, capabilitySnapshot: creation.snapshot, creationRequestId: creation.requestId, creationRequestHash: creation.hash, createdAt: now, updatedAt: now });
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, id));
      return row as ServiceSession;
    });
  }
  /** 当前周期只读摘要，不因读取或重建环境重置。 */
  async messageQuota(userId: string) {
    const period = messagePeriod();
    const [row] = await this.db.select().from(monthlyMessageUsage)
      .where(and(eq(monthlyMessageUsage.userId, userId), eq(monthlyMessageUsage.period, period)));
    return { period, used: row?.used ?? 0 };
  }
  /** 返回duplicate表示并发重复提交命中了已有记录，调用方不得再次启动执行。 */
  async accept(sessionId: string, clientMessageId: string, text: string, modelSnapshot?: import("../shared/llm.js").ModelSnapshot, requestedDeploymentId?: string): Promise<{ message: Message; duplicate: boolean }> {
    try {
      return await this.transaction(async tx => {
        // 与append共用同一把会话行锁：活动消息检查与事件编号之间没有并发窗口。
        await this.lockSession(tx, sessionId);
        // 排队等锁期间可能已有相同请求提交；重复检查必须在忙判断之前。
        const [old] = await tx.select().from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.clientMessageId, clientMessageId))).limit(1);
        if (old) {
          if (old.text !== text || (old.requestedDeploymentId ?? null) !== (requestedDeploymentId ?? null)) fail(409, "MESSAGE_ID_CONFLICT");
          return { message: old as Message, duplicate: true };
        }
        const [active] = await tx.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.sessionId, sessionId), inArray(messages.status, activeStatuses))).limit(1);
        if (active) fail(409, "SESSION_BUSY");
        if (modelSnapshot) await lockDeploymentForUse(tx, modelSnapshot.deploymentId);
        const id = randomUUID();
        await tx.insert(messages).values({ id, sessionId, clientMessageId, text, status: "accepted", modelSnapshot, requestedDeploymentId });
        await tx.update(sessions).set({ lastMessageId: id }).where(eq(sessions.id, sessionId));
        const eventId = await this.append(tx, sessionId, id, "message.accepted", {});
        await tx.update(messages).set({ createdEventId: eventId }).where(eq(messages.id, id));
        const [row] = await tx.select().from(messages).where(eq(messages.id, id));
        return { message: row as Message, duplicate: false };
      });
    } catch (error) {
      const constraint = uniqueViolation(error);
      // 同一clientMessageId的并发提交：返回已存在的那条，不产生第二个任务。
      if (constraint === "messages_session_client_unique") {
        const old = await this.duplicate(sessionId, clientMessageId);
        if (old) {
          if (old.text !== text || (old.requestedDeploymentId ?? null) !== (requestedDeploymentId ?? null)) fail(409, "MESSAGE_ID_CONFLICT");
          return { message: old, duplicate: true };
        }
      }
      // 部分唯一索引兜住“检查后、插入前”被另一请求抢先的情况。
      if (constraint === "one_active_message") fail(409, "SESSION_BUSY");
      throw error;
    }
  }
  /** The gateway route has been read back; this does not claim the upstream has answered yet. */
  async activateModel(message: Message, model: import("../shared/llm.js").ModelSnapshot) {
    return this.transaction(async tx => {
      await this.lockSession(tx, message.sessionId);
      const [session] = await tx
        .select({ modelSnapshot: sessions.modelSnapshot })
        .from(sessions)
        .where(eq(sessions.id, message.sessionId));
      await tx.update(messages).set({ activatedModelSnapshot: model }).where(eq(messages.id, message.id));
      await tx.update(sessions).set({ modelSnapshot: model }).where(eq(sessions.id, message.sessionId));
      // 稳定别名下，部署指针可能在其他轮次被移动；显式记录版本替换，避免静默变化。
      if (
        session?.modelSnapshot &&
        session.modelSnapshot.deploymentId === model.deploymentId &&
        session.modelSnapshot.versionId !== model.versionId
      )
        await this.append(tx, message.sessionId, message.id, "model.replaced", {
          from: session.modelSnapshot,
          to: model,
        });
      await this.append(tx, message.sessionId, message.id, "model.activated", { model });
    });
  }
  /** 在会话锁内分配递增事件编号并按来源去重，与调用方状态变更在同一事务提交。 */
  private async append(tx: Tx, sessionId: string, messageId: string | null, type: string, payload: Record<string, unknown>, source?: string) {
    await this.lockSession(tx, sessionId);
    if (source) {
      const [old] = await tx.select({ eventId: events.eventId }).from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.sourceEventKey, source))).limit(1);
      if (old) return Number(old.eventId);
    }
    // 原子自增后插入：事件编号由数据库分配，不依赖读取再写回。
    const [updated] = await tx.update(sessions)
      .set({ lastEventId: sql`${sessions.lastEventId} + 1`, updatedAt: Date.now() })
      .where(eq(sessions.id, sessionId)).returning({ lastEventId: sessions.lastEventId });
    const id = Number(updated.lastEventId);
    await tx.insert(events).values({ sessionId, eventId: id, messageId, type, payload: JSON.stringify(payload), sourceEventKey: source ?? null });
    return id;
  }
  /** 开启短事务追加服务事件，供运行器进度和状态提示进入产品消息流。 */
  async event(sessionId: string, messageId: string | null, type: string, payload: Record<string, unknown>, source?: string) {
    return this.transaction(tx => this.append(tx, sessionId, messageId, type, payload, source));
  }
  /** 更新消息状态和开始、结束时间，并原子追加对应事件；返回最新消息快照。 */
  async transition(id: string, status: MessageStatus, result?: unknown) {
    return this.transaction(async tx => {
      const [locked] = await tx.select({ id: messages.id, sessionId: messages.sessionId }).from(messages)
        .where(eq(messages.id, id)).for("update");
      if (!locked) fail(404, "MESSAGE_NOT_FOUND");
      const terminal = terminalStatuses.includes(status);
      const now = Date.now();
      await tx.update(messages).set({
        status,
        startedAt: status === "running" ? sql`coalesce(${messages.startedAt}, ${now})` : messages.startedAt,
        finishedAt: terminal ? now : null,
        result: result === undefined ? null : JSON.stringify(result),
      }).where(eq(messages.id, id));
      await this.append(tx, locked.sessionId, id,
        terminal ? "message.finished" : status === "running" ? "message.started" : "message.state",
        { status, ...(status === "running" ? { startedAt: now } : {}), ...(terminal ? { finishedAt: now } : {}), ...(result === undefined ? {} : { result }) });
      const [row] = await tx.select().from(messages).where(eq(messages.id, id));
      return row as Message;
    });
  }
  /** 只给仍活动且未请求取消的消息写取消标记与事件；重复取消或已结束请求不再改状态。 */
  async requestCancel(id: string) {
    return this.transaction(async tx => {
      const [locked] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
      if (!locked) fail(404, "MESSAGE_NOT_FOUND");
      // 等待数据库期间任务可能已结束；终态和重复取消都不再追加stopping。
      if (!activeStatuses.includes(locked.status) || locked.cancelRequested) return locked as Message;
      await tx.update(messages).set({ cancelRequested: 1 }).where(eq(messages.id, id));
      await this.append(tx, locked.sessionId, id, "message.stopping", {});
      const [row] = await tx.select().from(messages).where(eq(messages.id, id));
      return row as Message;
    });
  }
  /** 仅在环境状态发生变化时写回并发出事件，区分本轮消息完成和整个执行环境关闭。 */
  async environment(id: string, environment: Environment) {
    return this.transaction(async tx => {
      await this.lockSession(tx, id);
      const [row] = await tx.select({ environment: sessions.environment }).from(sessions).where(eq(sessions.id, id));
      if (row.environment === environment) return;
      await tx.update(sessions).set({ environment }).where(eq(sessions.id, id));
      await this.append(tx, id, null, "environment.changed", { environment });
    });
  }
  /** 从指定事件游标后顺序读取并解析负载，支持断线后的继续观看。 */
  async events(sessionId: string, after: number, limit = 100): Promise<ServiceEvent[]> {
    const rows = await this.db.select().from(events)
      .where(and(eq(events.sessionId, sessionId), gt(events.eventId, after)))
      .orderBy(asc(events.eventId)).limit(limit);
    return rows.map(row => ({ sessionId, eventId: Number(row.eventId), messageId: row.messageId,
      type: row.type, payload: JSON.parse(row.payload) }));
  }
  /** 补看历史时事件与消息取同一快照，避免读到事件之后才提交的消息状态。 */
  async history(sessionId: string, after: number, through: number, limit: number) {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(events)
        .where(and(eq(events.sessionId, sessionId), gt(events.eventId, after), lte(events.eventId, through)))
        .orderBy(asc(events.eventId)).limit(limit);
      const ids = [...new Set(rows.flatMap(row => row.messageId ? [row.messageId] : []))];
      const messageRows = ids.length ? await tx.select().from(messages).where(inArray(messages.id, ids)) : [];
      return {
        events: rows.map(row => ({ sessionId, eventId: Number(row.eventId), messageId: row.messageId,
          type: row.type, payload: JSON.parse(row.payload) })) as ServiceEvent[],
        messages: messageRows as Message[],
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  /** 按用户归属统计全部消息数量，供额度或管理展示使用。 */
  async messageCount(userId: string) {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(eq(sessions.ownerId, userId));
    return Number(row.n);
  }
}
