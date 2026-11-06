/**
 * Skill 版本库：源包、不可变版本、导入作业与个人启用意图。
 * 文件本身放在数据根下，数据库只保存相对路径与摘要。
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    // 内置技能没有个人拥有者；数据库约束确保私有技能必须有拥有者。
    ownerId: text("ownerId").references(() => users.id),
    source: text("source").$type<"private" | "builtin">().notNull(),
    slug: text("slug").notNull(),
    // 包内技能归某个专家修订，不出现在个人默认技能列表。
    packageScope: text("packageScope"),
    displayName: text("displayName").notNull(),
    status: text("status")
      .$type<"active" | "disabled" | "deleted">()
      .notNull()
      .default("active"),
    draftRevision: bigint("draftRevision", { mode: "number" })
      .notNull()
      .default(0),
    draftPath: text("draftPath"),
    currentVersionId: text("currentVersionId"),
    creationRequestId: text("creationRequestId"),
    creationRequestHash: text("creationRequestHash"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    // 私有技能在本人范围内slug唯一；内置技能在平台范围内唯一。
    uniqueIndex("skills_owner_slug_unique")
      .on(table.ownerId, table.slug, sql`coalesce(${table.packageScope}, '')`)
      .where(sql`${table.ownerId} is not null`),
    uniqueIndex("skills_builtin_slug_unique")
      .on(table.slug)
      .where(sql`${table.source} = 'builtin'`),
    uniqueIndex("skills_creation_request_unique").on(
      table.ownerId,
      table.creationRequestId,
    ),
    check(
      "skills_source_owner_check",
      sql`(${table.source} = 'private' AND ${table.ownerId} IS NOT NULL) OR (${table.source} = 'builtin' AND ${table.ownerId} IS NULL)`,
    ),
    index("skills_owner_updated").on(table.ownerId, table.updatedAt.desc()),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    skillId: text("skillId")
      .notNull()
      .references(() => skills.id),
    versionNumber: integer("versionNumber").notNull(),
    sourceHash: text("sourceHash").notNull(),
    manifest: jsonb("manifest").notNull(),
    fileCount: integer("fileCount").notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
    sourcePath: text("sourcePath").notNull(),
    publishRequestId: text("publishRequestId").notNull(),
    publishRequestHash: text("publishRequestHash").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("skill_versions_number_unique").on(
      table.skillId,
      table.versionNumber,
    ),
    unique("skill_versions_request_unique").on(
      table.skillId,
      table.publishRequestId,
    ),
  ],
);

export const skillImports = pgTable(
  "skill_imports",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    clientRequestId: text("clientRequestId").notNull(),
    clientRequestHash: text("clientRequestHash").notNull(),
    fileName: text("fileName").notNull(),
    expectedSize: bigint("expectedSize", { mode: "number" }).notNull(),
    expectedSha256: text("expectedSha256").notNull(),
    status: text("status")
      .$type<
        "pending" | "uploaded" | "checked" | "applied" | "failed" | "cancelled"
      >()
      .notNull()
      .default("pending"),
    stagingPath: text("stagingPath"),
    report: jsonb("report"),
    targetSkillId: text("targetSkillId").references(() => skills.id),
    resultVersionId: text("resultVersionId"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    // 同一用户的同一请求ID只建一条导入记录；响应丢失后重发返回原记录。
    unique("skill_imports_user_request_unique").on(
      table.userId,
      table.clientRequestId,
    ),
  ],
);

export const userSkills = pgTable(
  "user_skills",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    skillId: text("skillId")
      .notNull()
      .references(() => skills.id),
    enabled: integer("enabled").notNull().default(0),
    activeVersionId: text("activeVersionId"),
    desiredVersionId: text("desiredVersionId"),
    desiredEnabled: integer("desiredEnabled").notNull().default(0),
    pendingRequestId: text("pendingRequestId"),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.skillId] })],
);

/** 一份构建可供多个独立请求等待；取消一个请求不会拆掉其他使用者的产物。 */
export const skillBuilds = pgTable(
  "skill_builds",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    versionId: text("versionId")
      .notNull()
      .references(() => skillVersions.id),
    buildKey: text("buildKey").notNull(),
    imageId: text("imageId").notNull(),
    state: text("state")
      .$type<
        | "queued"
        | "downloading"
        | "building"
        | "ready"
        | "failed"
        | "cancelling"
        | "cancelled"
        | "reconciling"
      >()
      .notNull(),
    attempt: integer("attempt").notNull().default(1),
    containerName: text("containerName"),
    artifactPath: text("artifactPath"),
    artifactHash: text("artifactHash"),
    error: text("error"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("skill_build_key_unique").on(table.userId, table.buildKey),
  ],
);

export const skillBuildRequests = pgTable(
  "skill_build_requests",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    buildId: text("buildId")
      .notNull()
      .references(() => skillBuilds.id),
    clientRequestId: text("clientRequestId").notNull(),
    requestHash: text("requestHash").notNull(),
    state: text("state")
      .$type<"waiting" | "ready" | "failed" | "cancelled">()
      .notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("skill_build_request_unique").on(
      table.userId,
      table.clientRequestId,
    ),
  ],
);
