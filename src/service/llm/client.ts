import { createHash } from "node:crypto";
import { readGatewayPolicy, type GatewayPolicy } from "./policy.js";
/** 管理API仅宿主调用，错误不带URL、响应体或认证头，避免凭据进诊断。 */
export class LiteLLMError extends Error {
  constructor(readonly status: number) {
    super("LiteLLM management request failed");
  }
}
export class LiteLLMClient {
  constructor(
    private base: string,
    private masterKey: string,
  ) {}
  keyInfo<T>(token: string): Promise<T> {
    return this.request<T>(
      `/key/info?key=${createHash("sha256").update(token).digest("hex")}`,
    );
  }
  async request<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const response = await fetch(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.masterKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new LiteLLMError(response.status);
      return (await response.json()) as T;
    } catch (error) {
      throw error instanceof LiteLLMError ? error : new LiteLLMError(0);
    }
  }
}
export interface LlmSettings {
  managementUrl: string;
  inferenceUrl: string;
  walletProxyUrl?: string;
  masterKey: string;
  defaultDeploymentId?: string;
  sessionBudgetUsd?: number;
  policy?: GatewayPolicy;
}
export function llmSettings(env = process.env): LlmSettings | undefined {
  if (env.AH_LLM_ENABLED !== "true") return undefined;
  const url = (name: string) => {
    const raw = env[name];
    if (!raw) throw new Error(`Set ${name}`);
    const parsed = new URL(raw);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(`Invalid ${name}`);
    return raw.replace(/\/$/, "");
  };
  if (!env.AH_LITELLM_MASTER_KEY) throw new Error("Set AH_LITELLM_MASTER_KEY");
  const budget =
    env.AH_LLM_SESSION_BUDGET_USD === undefined
      ? undefined
      : Number(env.AH_LLM_SESSION_BUDGET_USD);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
    throw new Error("Invalid AH_LLM_SESSION_BUDGET_USD");
  return {
    managementUrl: url("AH_LITELLM_MANAGEMENT_URL"),
    inferenceUrl: url("AH_LITELLM_INFERENCE_URL"),
    masterKey: env.AH_LITELLM_MASTER_KEY,
    walletProxyUrl: env.AH_WALLET_ENABLED === "true" ? url("AH_WALLET_INFERENCE_URL") : undefined,
    defaultDeploymentId: env.AH_LLM_DEFAULT_DEPLOYMENT_ID,
    sessionBudgetUsd: budget,
    policy: readGatewayPolicy(env.AH_LLM_POLICY_FILE),
  };
}
