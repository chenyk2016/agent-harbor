/** Recoverable metadata-only projection of LiteLLM facts. This module never debits wallets. */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LlmService } from "./service.js";
import { gatewaySyncState, gatewayUsageEvents } from "../db/schema/gateway-usage.js";
import type { TokenUsage } from "../wallet/service.js";

export function gatewayTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, any>;
  const prompt = u.prompt_tokens, output = u.completion_tokens;
  const cacheRead = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  if (![prompt, output, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0) || cacheRead + cacheWrite > prompt) return null;
  return { input: prompt - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
}
const utc = (time: number) => new Date(time).toISOString().slice(0, 19).replace("T", " ");

export class GatewayUsageSync {
  private busy = false;
  private readonly source: string;
  constructor(private llm: LlmService) {
    this.source = createHash("sha256").update(llm.settings.managementUrl).digest("hex").slice(0, 16);
  }
  async run(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const db = this.llm.db;
      const [state] = await db.select().from(gatewaySyncState).where(eq(gatewaySyncState.id, this.source));
      // A checkpoint advances only after a full window. A failed scan replays safely.
      const from = state ? Math.max(0, state.scannedUntil - 10 * 60_000) : now - 24 * 3600_000;
      const until = Math.min(now, from + 24 * 3600_000);
      const identities = new Map((await this.llm.gatewayIdentities()).map(row => [row.hash, row]));
      const routeRows = await this.llm.gatewayVersions();
      const routes = new Map(routeRows.map(row => [row.routeName, row]));
      const targets = new Map<string, (typeof routeRows)[number]>();
      for (const row of routeRows) {
        const prefix = row.format === "anthropic" ? "anthropic" : row.format === "openai_chat" ? "custom_openai" : "openai";
        targets.set(row.upstreamModel, row);
        targets.set(`${prefix}/${row.upstreamModel}`, row);
      }
      const versionsById = new Map(routeRows.map(row => [row.versionId, row]));
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ start_date: utc(from), end_date: utc(until), page: String(page), page_size: "100" });
        const response = await this.llm.client.request<{ data: Array<Record<string, any>> }>(`/spend/logs/v2?${query}`);
        if (!Array.isArray(response.data)) throw new Error("Invalid gateway spend page");
        for (const row of response.data) {
          const identity = identities.get(row.api_key ?? row.metadata?.user_api_key);
          const version = routes.get(String(row.model ?? "")) ??
            targets.get(String(row.model ?? "")) ??
            (identity ? versionsById.get(identity.versionId) : undefined);
          const callId = row.litellm_call_id ?? row.metadata?.litellm_call_id ?? row.request_id;
          const startedAt = Date.parse(row.startTime);
          if (!identity || typeof callId !== "string" || callId.length > 200 || !Number.isFinite(startedAt)) continue;
          const usage = gatewayTokenUsage(row.metadata?.usage_object);
          const rawCost = row.metadata?.cost_breakdown ?? {};
          const costBreakdown = Object.fromEntries(["input_cost", "output_cost", "cache_read_cost", "total_cost", "original_cost", "margin_total_amount"]
            .filter(key => typeof rawCost[key] === "number" && Number.isFinite(rawCost[key])).map(key => [key, rawCost[key]]));
          // Old missing-rate logs can contain a nonzero cache cost but zero input/output.
          const cost = version
            ? await this.llm.costForIdentity(version.providerId, version.upstreamModel, startedAt)
            : undefined;
          const pricingKnown = !!usage && !!cost &&
            !(usage.input > 0 && cost.inputCostPerToken > 0 && !(costBreakdown.input_cost > 0)) &&
            !(usage.output > 0 && cost.outputCostPerToken > 0 && !(costBreakdown.output_cost > 0)) &&
            !(usage.cacheRead > 0 && cost.cacheReadCostPerToken > 0 && !(costBreakdown.cache_read_cost > 0));
          const event = {
            // A logical call can have more than one provider attempt/spend row.
            id: `${this.source}:${callId}:${row.request_id ?? callId}`, callId, requestId: typeof row.request_id === "string" ? row.request_id : null,
            ownerId: identity.ownerId, sessionId: identity.sessionId,
            model: String(row.model ?? "unknown"), status: String(row.status ?? row.metadata?.status ?? "unknown"),
            deploymentId: version?.deploymentId ?? identity?.deploymentId ?? null,
            versionId: version?.versionId ?? identity?.versionId ?? null,
            spendUsd: typeof row.spend === "number" && Number.isFinite(row.spend) && row.spend >= 0 ? row.spend : null,
            usage, costBreakdown, pricingKnown,
            startedAt, observedAt: now,
          };
          await db.insert(gatewayUsageEvents).values(event).onConflictDoUpdate({ target: gatewayUsageEvents.id, set: event });
        }
        // Do not stop at the API's capped total_pages; exhaust actual rows.
        if (response.data.length < 100) break;
      }
      await db.insert(gatewaySyncState).values({ id: this.source, scannedUntil: until, lastSuccessAt: now })
        .onConflictDoUpdate({ target: gatewaySyncState.id, set: { scannedUntil: until, lastSuccessAt: now } });
    } finally { this.busy = false; }
  }
}
