/** Operator-owned gateway policy. Supplier USD costs stay separate from RMB selling prices. */
import { readFileSync } from "node:fs";

export interface GatewayModelPolicy {
  timeoutSeconds: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
}
export interface GatewayPolicy {
  userRpmLimit: number;
  models: Record<string, GatewayModelPolicy>;
}
export function readGatewayPolicy(path?: string): GatewayPolicy | undefined {
  if (!path) return;
  const value = JSON.parse(readFileSync(path, "utf8")) as GatewayPolicy;
  if (!Number.isSafeInteger(value.userRpmLimit) || value.userRpmLimit < 1 || !value.models || typeof value.models !== "object")
    throw new Error("Invalid gateway policy");
  for (const model of Object.values(value.models)) {
    if (!Number.isSafeInteger(model.timeoutSeconds) || model.timeoutSeconds < 1 || model.timeoutSeconds > 3600 ||
      [model.inputCostPerToken, model.outputCostPerToken, model.cacheReadCostPerToken, model.cacheWriteCostPerToken]
        .some(rate => typeof rate !== "number" || !Number.isFinite(rate) || rate < 0))
      throw new Error("Invalid gateway model policy");
  }
  return value;
}
export const gatewayUserId = (owner: string) => `harbor:${owner}`;
export function modelPolicyFields(model: GatewayModelPolicy) {
  return {
    input_cost_per_token: model.inputCostPerToken,
    output_cost_per_token: model.outputCostPerToken,
    cache_read_input_token_cost: model.cacheReadCostPerToken,
    cache_creation_input_token_cost: model.cacheWriteCostPerToken,
  };
}
