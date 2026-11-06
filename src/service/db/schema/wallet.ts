import { pgTable, text, bigint, integer, jsonb } from "drizzle-orm/pg-core";
const amount = (name: string) => bigint(name, { mode: "number" });
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }
export const walletSettings = pgTable("wallet_settings", {
  id: text("id").primaryKey(), signupMicro: amount("signupMicro").notNull(), plusMicro: amount("plusMicro").notNull(),
});
export const wallets = pgTable("wallets", {
  userId: text("userId").primaryKey(), balance: amount("balance").notNull(), reserved: amount("reserved").notNull(),
  plusSince: amount("plusSince"), plusUntil: amount("plusUntil"),
});
export const walletLedger = pgTable("wallet_ledger", {
  id: text("id").primaryKey(), userId: text("userId").notNull(), amount: amount("amount").notNull(),
  kind: text("kind").notNull(), note: text("note").notNull(), balanceAfter: amount("balanceAfter").notNull(), createdAt: amount("createdAt").notNull(),
});
export const walletGifts = pgTable("wallet_gifts", {
  id: text("id").primaryKey(), actor: text("actor").notNull(), amount: amount("amount").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull(), note: text("note").notNull(), createdAt: amount("createdAt").notNull(),
});
export const walletRequests = pgTable("wallet_requests", {
  id: text("id").primaryKey(), userId: text("userId").notNull(), sessionId: text("sessionId").notNull(),
  deploymentId: text("deploymentId").notNull(), versionId: text("versionId").notNull(), priceVersionId: text("priceVersionId").notNull(),
  modelName: text("modelName").notNull(), price: jsonb("price").$type<ModelPrice>().notNull(),
  reserved: amount("reserved").notNull(), actual: amount("actual"), charged: amount("charged"), waived: amount("waived"),
  inputTokens: amount("inputTokens"), outputTokens: amount("outputTokens"), cacheReadTokens: amount("cacheReadTokens"), cacheWriteTokens: amount("cacheWriteTokens"),
  state: text("state").notNull(), note: text("note").notNull(), createdAt: amount("createdAt").notNull(), finishedAt: amount("finishedAt"),
  gatewayCallId: text("gatewayCallId"),
  messageId: text("messageId"), httpStatus: integer("httpStatus"),
  durationMs: amount("durationMs"), failureCode: text("failureCode"),
});
