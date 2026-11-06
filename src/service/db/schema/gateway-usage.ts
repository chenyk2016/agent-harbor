import { pgTable, text, bigint, doublePrecision, jsonb, boolean } from "drizzle-orm/pg-core";
import type { TokenUsage } from "../../wallet/service.js";
export const gatewayUsageEvents = pgTable("gateway_usage_events", {
  id: text("id").primaryKey(), callId: text("callId").notNull(), requestId: text("requestId"),
  ownerId: text("ownerId").notNull(), sessionId: text("sessionId").notNull(),
  model: text("model").notNull(), status: text("status").notNull(), spendUsd: doublePrecision("spendUsd"),
  deploymentId: text("deploymentId"), versionId: text("versionId"),
  pricingKnown: boolean("pricingKnown").notNull(),
  usage: jsonb("usage").$type<TokenUsage | null>(), costBreakdown: jsonb("costBreakdown"),
  startedAt: bigint("startedAt", { mode: "number" }).notNull(),
  observedAt: bigint("observedAt", { mode: "number" }).notNull(),
});
export const gatewaySyncState = pgTable("gateway_sync_state", {
  id: text("id").primaryKey(), scannedUntil: bigint("scannedUntil", { mode: "number" }).notNull(),
  lastSuccessAt: bigint("lastSuccessAt", { mode: "number" }).notNull(),
});
