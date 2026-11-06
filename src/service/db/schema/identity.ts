/** 身份记录只保存哈希与外部subject，不保存供应商token或密钥明文。 */
import { bigint, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  disabled: integer("disabled").notNull().default(0),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  limits: text("limits"),
});

export const externalIdentities = pgTable("external_identities", {
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  userId: text("userId").notNull().references(() => users.id),
}, table => [
  primaryKey({ columns: [table.issuer, table.subject] }),
]);

export const loginSessions = pgTable("login_sessions", {
  hash: text("hash").primaryKey(),
  userId: text("userId").notNull().references(() => users.id),
  expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
});

export const userKeys = pgTable("user_keys", {
  id: text("id").primaryKey(),
  hash: text("hash").notNull(),
  userId: text("userId").notNull().references(() => users.id),
  name: text("name").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  expiresAt: bigint("expiresAt", { mode: "number" }),
  revoked: integer("revoked").notNull().default(0),
}, table => [
  unique("user_keys_hash_unique").on(table.hash),
]);

/** 已接收的消息数，独立于会话环境和消息执行结果。 */
export const monthlyMessageUsage = pgTable("monthly_message_usage", {
  userId: text("userId").notNull().references(() => users.id),
  period: text("period").notNull(),
  used: integer("used").notNull().default(0),
}, table => [primaryKey({ columns: [table.userId, table.period] })]);
