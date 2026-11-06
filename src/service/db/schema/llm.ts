import { pgTable, text, boolean, bigint, integer, doublePrecision, jsonb } from "drizzle-orm/pg-core";
import type { ModelPrice } from "./wallet.js";
export const llmProviders = pgTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  format: text("format").notNull(),
  apiBase: text("apiBase").notNull(),
  deletedAt: bigint("deletedAt", { mode: "number" }),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});
export const llmProviderSecrets = pgTable("llm_provider_secrets", {
  id: text("id").primaryKey(),
  providerId: text("providerId").notNull().references(() => llmProviders.id),
  version: integer("version").notNull(),
  secret: text("secret").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  retiredAt: bigint("retiredAt", { mode: "number" }),
});
export const llmModelVersions = pgTable("llm_model_versions", {
  id: text("id").primaryKey(),
  deploymentId: text("deploymentId").notNull(),
  providerId: text("providerId").notNull().references(() => llmProviders.id),
  upstreamModel: text("upstreamModel").notNull(),
  routeName: text("routeName").notNull().unique(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  tools: boolean("tools").notNull(),
  streaming: boolean("streaming").notNull(),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull(),
  digest: text("digest").notNull(),
  state: text("state").notNull(),
  lastSyncedAt: bigint("lastSyncedAt", { mode: "number" }),
  createdBy: text("createdBy").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});
export const llmDeployments = pgTable("llm_deployments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  currentVersionId: text("currentVersionId").notNull(),
  enabled: boolean("enabled").notNull(),
  allowedUsers: jsonb("allowedUsers").$type<string[]>().notNull(),
  archivedAt: bigint("archivedAt", { mode: "number" }),
  deletionState: text("deletionState").$type<"deleting" | "deleted">(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});
export const llmDeploymentPrices = pgTable("llm_deployment_prices", {
  id: text("id").primaryKey(),
  deploymentId: text("deploymentId").notNull().references(() => llmDeployments.id),
  input: bigint("input", { mode: "number" }).notNull(),
  output: bigint("output", { mode: "number" }).notNull(),
  cacheRead: bigint("cacheRead", { mode: "number" }).notNull(),
  cacheWrite: bigint("cacheWrite", { mode: "number" }).notNull(),
  effectiveFrom: bigint("effectiveFrom", { mode: "number" }).notNull(),
  createdBy: text("createdBy").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});
export const llmBindings = pgTable("llm_bindings", {
  id: text("id").primaryKey(),
  sessionId: text("sessionId").notNull(),
  ownerId: text("ownerId").notNull(),
  deploymentId: text("deploymentId").notNull().references(() => llmDeployments.id),
  versionId: text("versionId").notNull().references(() => llmModelVersions.id),
  secret: text("secret").notNull(),
  walletTokenHash: text("walletTokenHash"),
  state: text("state").notNull(),
  expiresAt: bigint("expiresAt", { mode: "number" }),
});
export const llmPreferences = pgTable("llm_preferences", {
  ownerId: text("ownerId").primaryKey(),
  deploymentId: text("deploymentId").references(() => llmDeployments.id),
});
export const llmModelCosts = pgTable("llm_model_costs", {
  id: text("id").primaryKey(),
  providerId: text("providerId").notNull().references(() => llmProviders.id),
  upstreamModel: text("upstreamModel").notNull(),
  inputUsdPerToken: doublePrecision("inputUsdPerToken").notNull(),
  outputUsdPerToken: doublePrecision("outputUsdPerToken").notNull(),
  cacheReadUsdPerToken: doublePrecision("cacheReadUsdPerToken").notNull(),
  cacheWriteUsdPerToken: doublePrecision("cacheWriteUsdPerToken").notNull(),
  timeoutSeconds: integer("timeoutSeconds").notNull(),
  effectiveFrom: bigint("effectiveFrom", { mode: "number" }).notNull(),
  createdBy: text("createdBy").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});
export const llmConfigAudit = pgTable("llm_config_audit", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  reason: text("reason"),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});
export type DeploymentPrice = typeof llmDeploymentPrices.$inferSelect;
export type LlmDeployment = typeof llmDeployments.$inferSelect;
export type LlmModelVersion = typeof llmModelVersions.$inferSelect;
export type LlmPrice = ModelPrice;
