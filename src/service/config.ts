/** 仅服务进程读取凭证和规格；HTTP客户端不能覆盖这些受信配置。 */
import type { WorkbenchSettings } from "./identity/workbench.js";
import { defaultProfile } from "../shared/types.js";
export function numberFromEnvironment(name: string, fallback: number, minimum = 1) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}
export function profileFromEnvironment() {
  return { ...defaultProfile,
    image: process.env.AH_IMAGE ?? defaultProfile.image,
    gatewayUrl: process.env.AH_GATEWAY_URL ?? defaultProfile.gatewayUrl,
    model: process.env.AH_MODEL ?? defaultProfile.model,
    timeoutMs: numberFromEnvironment("AH_TASK_TIMEOUT_MS", defaultProfile.timeoutMs, 0),
    maxTurns: numberFromEnvironment("AH_MAX_TURNS", defaultProfile.maxTurns, 0),
    maxBudgetUsd: budgetFromEnvironment(),
    interruptTimeoutMs: numberFromEnvironment("AH_INTERRUPT_TIMEOUT_MS", 5_000),
  };
}

/** 固定公开origin用于回调、CSRF和Secure Cookie；永不从X-Forwarded-*推断。 */
export function identityFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const origin = env.AH_PUBLIC_ORIGIN;
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid AH_PUBLIC_ORIGIN");
  }
  const issuer = env.AH_OIDC_ISSUER, clientId = env.AH_OIDC_CLIENT_ID, clientSecret = env.AH_OIDC_CLIENT_SECRET;
  if ([issuer, clientId, clientSecret].some(Boolean) && !(issuer && clientId && clientSecret && origin)) throw new Error("OIDC requires issuer, client ID, secret and public origin");
  if (issuer && (new URL(issuer).protocol !== "https:" || new URL(issuer).username || new URL(issuer).password)) throw new Error("OIDC issuer requires HTTPS");
  if (env.AH_KEY_LOGIN && !["true", "false"].includes(env.AH_KEY_LOGIN)) throw new Error("Invalid AH_KEY_LOGIN");
  const keyLogin = env.AH_KEY_LOGIN !== "false";
  const secret = env.AH_WORKBENCH_AUTH_SECRET?.trim();
  if (secret && (!origin || secret.length < 32)) throw new Error("Workbench auth requires a public origin and a secret of at least 32 characters");
  if (env.AH_WORKBENCH_REGISTRATION && !["true", "false"].includes(env.AH_WORKBENCH_REGISTRATION))
    throw new Error("Invalid AH_WORKBENCH_REGISTRATION");
  const registration = env.AH_WORKBENCH_REGISTRATION === "true";
  if (registration && !secret) throw new Error("Workbench registration requires workbench auth");
  if (registration && !origin?.startsWith("https:")) throw new Error("Workbench registration requires HTTPS");
  const workbench: WorkbenchSettings | undefined = secret && origin ? { origin, secret, registration } : undefined;
  if (!keyLogin && !issuer && !workbench) throw new Error("Disabling key login requires configured browser authentication");
  return { origin, keyLogin, workbench, adminUsers: (env.AH_ADMIN_USERS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    oidc: issuer ? { issuer, clientId: clientId!, clientSecret: clientSecret!, origin: origin! } : undefined };
}

/** SDK预算允许小数美元；0关闭估算限额，真实钱包仍独立结算。 */
function budgetFromEnvironment() {
  const value = Number(process.env.AH_MAX_BUDGET_USD ?? defaultProfile.maxBudgetUsd);
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid AH_MAX_BUDGET_USD");
  return value;
}
