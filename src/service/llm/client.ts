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
export interface LlmConfiguration {
  settings?: LlmSettings;
  missing: string[];
  allowLegacyGateway: boolean;
}
export function resolveLlmSettings(env = process.env): LlmConfiguration {
  const mode = env.AH_LLM_ENABLED?.trim();
  if (mode && mode !== "true" && mode !== "false")
    throw new Error("Invalid AH_LLM_ENABLED");
  if (mode === "false") return { missing: [], allowLegacyGateway: true };

  const walletMode = env.AH_WALLET_ENABLED?.trim();
  if (walletMode && walletMode !== "true" && walletMode !== "false")
    throw new Error("Invalid AH_WALLET_ENABLED");
  const managementUrl = env.AH_LITELLM_MANAGEMENT_URL?.trim();
  const inferenceUrl = env.AH_LITELLM_INFERENCE_URL?.trim();
  const masterKey = env.AH_LITELLM_MASTER_KEY?.trim();
  const walletUrl = walletMode === "false" ? undefined : env.AH_WALLET_INFERENCE_URL?.trim();
  const requested = mode === "true" || walletMode === "true" ||
    Boolean(managementUrl || inferenceUrl || masterKey || walletUrl);
  if (!requested) return { missing: [], allowLegacyGateway: true };

  const missing = [
    !managementUrl && "AH_LITELLM_MANAGEMENT_URL",
    !inferenceUrl && "AH_LITELLM_INFERENCE_URL",
    !masterKey && "AH_LITELLM_MASTER_KEY",
    walletMode === "true" && !walletUrl && "AH_WALLET_INFERENCE_URL",
  ].filter((field): field is string => Boolean(field));
  // A partially configured managed gateway must not accidentally bypass the wallet.
  if (!managementUrl || !inferenceUrl || !masterKey || missing.length)
    return { missing, allowLegacyGateway: false };

  const url = (name: string, raw: string) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid ${name}`);
    }
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
  const budget =
    env.AH_LLM_SESSION_BUDGET_USD === undefined
      ? undefined
      : Number(env.AH_LLM_SESSION_BUDGET_USD);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
    throw new Error("Invalid AH_LLM_SESSION_BUDGET_USD");
  let policy: GatewayPolicy | undefined;
  try {
    policy = readGatewayPolicy(env.AH_LLM_POLICY_FILE);
  } catch {
    throw new Error("Invalid AH_LLM_POLICY_FILE");
  }
  return {
    missing: [],
    allowLegacyGateway: false,
    settings: {
      managementUrl: url("AH_LITELLM_MANAGEMENT_URL", managementUrl),
      inferenceUrl: url("AH_LITELLM_INFERENCE_URL", inferenceUrl),
      masterKey,
      walletProxyUrl: walletUrl ? url("AH_WALLET_INFERENCE_URL", walletUrl) : undefined,
      defaultDeploymentId: env.AH_LLM_DEFAULT_DEPLOYMENT_ID,
      sessionBudgetUsd: budget,
      policy,
    },
  };
}
export function llmSettings(env = process.env): LlmSettings | undefined {
  return resolveLlmSettings(env).settings;
}
