/** 连接保存个人配置和密文凭据；旧Binding/选择/审计表仅保留历史，不再用于运行。 */
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { sessions } from "./sessions.js";
export interface McpDefinition {
  name: string;
  kind: "remote" | "local" | "script";
  schemaVersion?: 2;
  scriptId?: string;
  scriptScope?: "admin" | "user";
  migrationPending?: boolean;
  url?: string;
  templateId?: string;
  templateDigest?: string;
  allowedTools?: string[];
}
export const mcpConnections = pgTable("mcp_connections", {
  id: text("id").primaryKey(),
  ownerId: text("ownerId")
    .notNull()
    .references(() => users.id),
  definition: jsonb("definition").$type<McpDefinition>().notNull(),
  sealed: text("sealed").notNull(),
  hasCredentials: integer("hasCredentials").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  enabled: integer("enabled").notNull().default(1),
  deleted: integer("deleted").notNull().default(0),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});
export const mcpSelections = pgTable("mcp_selections", {
  sessionId: text("sessionId")
    .primaryKey()
    .references(() => sessions.id),
  ownerId: text("ownerId")
    .notNull()
    .references(() => users.id),
});
export const mcpBindings = pgTable(
  "mcp_bindings",
  {
    id: text("id").primaryKey(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id),
    ownerId: text("ownerId")
      .notNull()
      .references(() => users.id),
    connectionId: text("connectionId")
      .notNull()
      .references(() => mcpConnections.id),
    revision: integer("revision").notNull(),
    definition: jsonb("definition").$type<McpDefinition>().notNull(),
  },
  (t) => [
    unique("mcp_bindings_session_connection_unique").on(
      t.sessionId,
      t.connectionId,
    ),
  ],
);
export const mcpCalls = pgTable("mcp_calls", {
  id: text("id").primaryKey(),
  ownerId: text("ownerId")
    .notNull()
    .references(() => users.id),
  sessionId: text("sessionId")
    .notNull()
    .references(() => sessions.id),
  bindingId: text("bindingId").notNull(),
  tool: text("tool").notNull(),
  status: text("status").notNull(),
  startedAt: bigint("startedAt", { mode: "number" }).notNull(),
  finishedAt: bigint("finishedAt", { mode: "number" }),
});
