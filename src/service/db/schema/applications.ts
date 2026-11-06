/** 应用控制面。业务数据在独立数据库；此处只记录归属、固定产物及发布事实。 */
import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { sessions } from "./sessions.js";
import type { SourceRevision } from "../../applications/source-store.js";
import type { AppBuild, AppDeployment } from "../../applications/docker.js";
import type { AppManifest } from "../../applications/manifest.js";

/** 应用主记录：用户归属、开发会话和最新源码头；不代表某个版本已经运行。 */
export const applications = pgTable(
  "applications",
  {
    id: text("id").primaryKey(),
    ownerId: text("ownerId")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    status: text("status").notNull().default("provisioning"),
    developmentSessionId: text("developmentSessionId").references(
      () => sessions.id,
    ),
    headRevisionId: text("headRevisionId"),
    nextRevisionNumber: integer("nextRevisionNumber").notNull().default(1),
    stateVersion: integer("stateVersion").notNull().default(0),
    lastEventId: bigint("lastEventId", { mode: "number" }).notNull().default(0),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("applications_development_session_unique").on(
      table.developmentSessionId,
    ),
  ],
);

/** 不可变源码版本记录，关联固定 Git 快照、数据声明和来源消息。 */
export const appRevisions = pgTable(
  "app_revisions",
  {
    id: text("id").primaryKey(),
    appId: text("appId")
      .notNull()
      .references(() => applications.id),
    number: integer("number").notNull(),
    parentId: text("parentId"),
    restoredFromId: text("restoredFromId"),
    sourceMessageId: text("sourceMessageId"),
    source: jsonb("source").$type<SourceRevision>().notNull(),
    manifest: jsonb("manifest").$type<AppManifest>().notNull(),
    summary: text("summary").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("app_revisions_number_unique").on(table.appId, table.number),
  ],
);

/** 固定源码到镜像的构建台账；成功产物可被后续部署或历史镜像回滚复用。 */
export const appBuilds = pgTable("app_builds", {
  id: text("id").primaryKey(),
  appId: text("appId")
    .notNull()
    .references(() => applications.id),
  revisionId: text("revisionId")
    .notNull()
    .references(() => appRevisions.id),
  target: text("target").notNull(),
  status: text("status").notNull(),
  artifact: jsonb("artifact").$type<AppBuild>(),
  error: text("error"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

/** 某次运行实例的台账，分别记录希望达到的状态与实际观测到的状态。 */
export const appDeployments = pgTable("app_deployments", {
  id: text("id").primaryKey(),
  appId: text("appId")
    .notNull()
    .references(() => applications.id),
  buildId: text("buildId")
    .notNull()
    .references(() => appBuilds.id),
  environment: text("environment").notNull(),
  desiredState: text("desiredState").notNull(),
  observedState: text("observedState").notNull(),
  spec: jsonb("spec").$type<AppDeployment>(),
  epoch: integer("epoch").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

/** 应用每个环境的入口意图和已确认事实；generation 用于拒绝过时切换。 */
export const appEndpoints = pgTable(
  "app_endpoints",
  {
    appId: text("appId")
      .notNull()
      .references(() => applications.id),
    environment: text("environment").notNull(),
    generation: integer("generation").notNull().default(0),
    desiredDeploymentId: text("desiredDeploymentId"),
    appliedDeploymentId: text("appliedDeploymentId"),
    state: text("state").notNull().default("offline"),
    checkedAt: bigint("checkedAt", { mode: "number" }),
  },
  (table) => [primaryKey({ columns: [table.appId, table.environment] })],
);

/** 数据资源摘要，仅保存库名、角色和已应用声明；密码由私有文件加密保存。 */
export const appDataEnvironments = pgTable(
  "app_data_environments",
  {
    appId: text("appId")
      .notNull()
      .references(() => applications.id),
    environment: text("environment").notNull(),
    databaseName: text("databaseName").notNull(),
    role: text("role").notNull(),
    schema: jsonb("schema").$type<AppManifest>().notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.environment] })],
);

/** 持久化异步操作、幂等请求及资源占位，进程重启后仍可发现未完成步骤。 */
export const appOperations = pgTable(
  "app_operations",
  {
    id: text("id").primaryKey(),
    appId: text("appId")
      .notNull()
      .references(() => applications.id),
    ownerId: text("ownerId")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    clientRequestId: text("clientRequestId").notNull(),
    requestHash: text("requestHash").notNull(),
    resourceKey: text("resourceKey").notNull(),
    state: text("state").notNull(),
    phase: text("phase").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("app_operations_request_unique").on(
      table.ownerId,
      table.kind,
      table.clientRequestId,
    ),
    uniqueIndex("app_operations_one_writer")
      .on(table.appId, table.resourceKey)
      .where(sql`state in ('queued','running','cancelling','reconciling')`),
  ],
);

/** 应用内有序事件流水，和操作状态一起提交，供进度展示及追溯使用。 */
export const appEvents = pgTable(
  "app_events",
  {
    appId: text("appId")
      .notNull()
      .references(() => applications.id),
    eventId: bigint("eventId", { mode: "number" }).notNull(),
    operationId: text("operationId"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.eventId] })],
);
