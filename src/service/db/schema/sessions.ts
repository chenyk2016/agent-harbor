/** 会话、消息与事件：字段名沿用SQLite时期的业务名称，迁移时不做无意义重命名。 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { Environment, MessageStatus } from "../../types.js";

/** 产品会话及其固定配置；开发容器停止后，消息和这些快照仍然保留。 */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  ownerId: text("ownerId").notNull(),
  title: text("title").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  environment: text("environment").$type<Environment>().notNull().default("closed"),
  lastMessageId: text("lastMessageId"),
  modelSnapshot: jsonb("modelSnapshot").$type<import("../../../shared/llm.js").ModelSnapshot>(),
  /** 会话创建时保存完整专家正文；执行不再查询可变的专家定义。 */
  expertSnapshot: jsonb("expertSnapshot").$type<import("../../../shared/experts.js").ExpertSnapshot>(),
  capabilitySnapshot: jsonb("capabilitySnapshot").$type<import("../../../shared/skills.js").CapabilitySnapshot>(),
  analysisAppId: text("analysisAppId"),
  analysisEnvironment: text("analysisEnvironment").$type<"preview" | "production">(),
  creationRequestId: text("creationRequestId"),
  creationRequestHash: text("creationRequestHash"),
  lastEventId: bigint("lastEventId", { mode: "number" }).notNull().default(0),
}, table => [
  uniqueIndex("sessions_analysis_scope_unique").on(table.analysisAppId, table.analysisEnvironment).where(sql`"analysisAppId" IS NOT NULL`),
  unique("sessions_creation_request_unique").on(table.ownerId, table.creationRequestId),
  index("sessions_owner_updated").on(table.ownerId, table.updatedAt.desc()),
  index("sessions_owner_created").on(table.ownerId, table.createdAt.desc(), table.id.desc()),
]);

/** 用户需求及单轮状态，通过客户端消息编号和活动消息唯一约束保证接收互斥。 */
export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("sessionId").notNull().references(() => sessions.id),
  clientMessageId: text("clientMessageId").notNull(),
  text: text("text").notNull(),
  requestedDeploymentId: text("requestedDeploymentId"),
  modelSnapshot: jsonb("modelSnapshot").$type<import("../../../shared/llm.js").ModelSnapshot>(),
  activatedModelSnapshot: jsonb("activatedModelSnapshot").$type<import("../../../shared/llm.js").ModelSnapshot>(),
  status: text("status").$type<MessageStatus>().notNull(),
  cancelRequested: integer("cancelRequested").notNull().default(0),
  createdEventId: bigint("createdEventId", { mode: "number" }).notNull().default(0),
  startedAt: bigint("startedAt", { mode: "number" }),
  finishedAt: bigint("finishedAt", { mode: "number" }),
  result: text("result"),
}, table => [
  // 同一会话同一客户端消息ID只接收一次；并发重复提交靠这条约束兜底。
  unique("messages_session_client_unique").on(table.sessionId, table.clientMessageId),
  // 每会话最多一条活动消息。部分唯一索引直接表达这条业务规则。
  uniqueIndex("one_active_message").on(table.sessionId)
    .where(sql`status in ('accepted','running','finalizing','reconciling')`),
  index("messages_session_created_event").on(table.sessionId, table.createdEventId),
]);

/** 可续读的会话事件流；来源键去重运行器重放事件，事件编号在会话内递增。 */
export const events = pgTable("events", {
  sessionId: text("sessionId").notNull().references(() => sessions.id),
  eventId: bigint("eventId", { mode: "number" }).notNull(),
  messageId: text("messageId"),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  sourceEventKey: text("sourceEventKey"),
}, table => [
  primaryKey({ columns: [table.sessionId, table.eventId] }),
  // PostgreSQL的唯一约束允许多个NULL，与SQLite时期“仅去重已标注来源”一致。
  unique("events_session_source_unique").on(table.sessionId, table.sourceEventKey),
]);
