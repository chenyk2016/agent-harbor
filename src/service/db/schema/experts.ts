/** 专家定义/版本与安装批次；实际安装作业仍归 Skill 模块。 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { skillVersions, skillBuildRequests } from "./skills.js";
import type { ExpertDefinition } from "../../../shared/experts.js";
export const experts = pgTable(
  "experts",
  {
    id: text("id").primaryKey(),
    ownerId: text("ownerId").references(() => users.id),
    source: text("source").$type<"private" | "builtin">().notNull(),
    status: text("status")
      .$type<"active" | "deleted">()
      .notNull()
      .default("active"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    currentVersionId: text("currentVersionId").notNull(),
    creationRequestId: text("creationRequestId"),
    creationRequestHash: text("creationRequestHash"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("experts_creation_unique").on(t.ownerId, t.creationRequestId),
    check(
      "experts_owner_check",
      sql`(${t.source}='private' AND ${t.ownerId} IS NOT NULL) OR (${t.source}='builtin' AND ${t.ownerId} IS NULL)`,
    ),
  ],
);
export const expertVersions = pgTable(
  "expert_versions",
  {
    id: text("id").primaryKey(),
    expertId: text("expertId")
      .notNull()
      .references(() => experts.id),
    versionNumber: integer("versionNumber").notNull(),
    definition: jsonb("definition").$type<ExpertDefinition>().notNull(),
    instructions: text("instructions").notNull(),
    contentHash: text("contentHash").notNull(),
    clientRequestId: text("clientRequestId").notNull(),
    requestHash: text("requestHash").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("expert_versions_number_unique").on(t.expertId, t.versionNumber),
    unique("expert_versions_request_unique").on(t.expertId, t.clientRequestId),
  ],
);
export const expertInstalls = pgTable(
  "expert_installs",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id),
    versionId: text("versionId")
      .notNull()
      .references(() => expertVersions.id),
    imageId: text("imageId").notNull(),
    status: text("status")
      .$type<"active" | "cancelling" | "cancelled">()
      .notNull()
      .default("active"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("expert_installs_live_unique")
      .on(t.userId, t.versionId, t.imageId)
      .where(sql`${t.status} <> 'cancelled'`),
  ],
);
export const expertInstallSkills = pgTable(
  "expert_install_skills",
  {
    id: text("id").primaryKey(),
    installId: text("installId")
      .notNull()
      .references(() => expertInstalls.id),
    versionId: text("versionId")
      .notNull()
      .references(() => skillVersions.id),
    requestId: text("requestId")
      .notNull()
      .references(() => skillBuildRequests.id),
  },
  (t) => [unique("expert_install_skill_unique").on(t.installId, t.versionId)],
);

/** 凭据密文不进入专家包、会话快照或公开接口。 */
export const expertConnections = pgTable("expert_connections",{
  id:text("id").primaryKey(),userId:text("userId").notNull().references(()=>users.id),
  definitionHash:text("definitionHash").notNull(),name:text("name").notNull(),sealed:text("sealed").notNull(),
  updatedAt:bigint("updatedAt",{mode:"number"}).notNull(),
},t=>[unique("expert_connections_user_definition_name_unique").on(t.userId,t.definitionHash,t.name)]);
