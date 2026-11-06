/** 用量按消息ID去重，按会话基线求差；只覆盖主循环累计估算，不是账单。 */
import { bigint, doublePrecision, integer, pgTable, text } from "drizzle-orm/pg-core";

export const usageEntries = pgTable("usage_entries", {
  messageId: text("messageId").primaryKey(),
  sessionId: text("sessionId").notNull(),
  userId: text("userId").notNull(),
  runnerId: text("runnerId").notNull(),
  cumulativeUsd: doublePrecision("cumulativeUsd").notNull(),
  estimatedUsd: doublePrecision("estimatedUsd"),
  inputTokens: integer("inputTokens"),
  outputTokens: integer("outputTokens"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});

export const usageBaselines = pgTable("usage_baselines", {
  sessionId: text("sessionId").primaryKey(),
  cumulativeUsd: doublePrecision("cumulativeUsd").notNull(),
});
