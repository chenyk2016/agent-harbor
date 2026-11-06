/** 仅服务进程读取凭证和规格；HTTP客户端不能覆盖这些受信配置。 */
import type { OidcSettings } from "./identity/oidc.js";
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

export function residentFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const backend = env.AH_RESIDENT_BACKEND ?? "docker";
  if (backend === "docker") return;
  if (backend !== "opensandbox") throw new Error("Invalid AH_RESIDENT_BACKEND");
  if (process.platform !== "linux" || process.getuid?.() !== 1000)
    throw new Error("OpenSandbox Runner requires a local Linux host and service UID 1000");
  const origin = URL.parse(env.AH_OPENSANDBOX_RUNNER_ORIGIN ?? "");
  if (!origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
      !origin.port || origin.origin !== env.AH_OPENSANDBOX_RUNNER_ORIGIN)
    throw new Error("Invalid AH_OPENSANDBOX_RUNNER_ORIGIN");
  const key = env.AH_OPENSANDBOX_RUNNER_KEY;
  if (!key?.trim() || key.length < 32) throw new Error("Invalid AH_OPENSANDBOX_RUNNER_KEY");
  return { origin, key };
}

/** 固定公开origin用于回调、CSRF和Secure Cookie；永不从X-Forwarded-*推断。 */
export function identityFromEnvironment(env: NodeJS.ProcessEnv = process.env, managedWallet = false) {
  const origin = env.AH_PUBLIC_ORIGIN;
  if (origin) {
    const url = URL.parse(origin);
    if (!url || url.origin !== origin || url.username || url.password ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid AH_PUBLIC_ORIGIN");
  }
  if (env.AH_KEY_LOGIN && !["true", "false"].includes(env.AH_KEY_LOGIN)) throw new Error("Invalid AH_KEY_LOGIN");
  const keyLogin = env.AH_KEY_LOGIN !== "false";
  const issues: string[] = [];

  let oidc: OidcSettings | undefined;
  const issuer = env.AH_OIDC_ISSUER?.trim(), clientId = env.AH_OIDC_CLIENT_ID?.trim(), clientSecret = env.AH_OIDC_CLIENT_SECRET;
  if (issuer || clientId || clientSecret) {
    if (!issuer || !clientId || !clientSecret?.trim() || !origin) {
      issues.push("OIDC requires AH_OIDC_ISSUER, AH_OIDC_CLIENT_ID, AH_OIDC_CLIENT_SECRET and AH_PUBLIC_ORIGIN");
    } else {
      const url = URL.parse(issuer);
      if (!url || url.protocol !== "https:" || url.username || url.password)
        issues.push("AH_OIDC_ISSUER must be an HTTPS URL without embedded credentials");
      else oidc = { issuer, clientId, clientSecret, origin };
    }
  }

  const secret = env.AH_WORKBENCH_AUTH_SECRET?.trim();
  const passwordLogin = origin && secret && secret.length >= 32 ? { origin, secret } : undefined;
  if (secret && !passwordLogin)
    issues.push("Workbench password login requires AH_PUBLIC_ORIGIN and an AH_WORKBENCH_AUTH_SECRET of at least 32 characters");
  const registrationMode = env.AH_WORKBENCH_REGISTRATION;
  const registrationReady = !!passwordLogin?.origin.startsWith("https:") && managedWallet;
  if (registrationMode === "true" && !registrationReady)
    issues.push("AH_WORKBENCH_REGISTRATION requires workbench password login, an HTTPS public origin and the managed wallet gateway");
  if (registrationMode !== undefined && registrationMode !== "true" && registrationMode !== "false")
    issues.push("AH_WORKBENCH_REGISTRATION must be true or false");
  const registration = registrationReady && (registrationMode === undefined || registrationMode === "true");
  const workbench: WorkbenchSettings | undefined = passwordLogin && { ...passwordLogin, registration };
  if (!keyLogin && !oidc && !workbench)
    issues.push("Browser login is unavailable because AH_KEY_LOGIN is false and no alternate login is configured");
  return { origin, keyLogin, workbench, adminUsers: (env.AH_ADMIN_USERS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    oidc, issues };
}

/** SDK预算允许小数美元；0关闭估算限额，真实钱包仍独立结算。 */
function budgetFromEnvironment() {
  const value = Number(process.env.AH_MAX_BUDGET_USD ?? defaultProfile.maxBudgetUsd);
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid AH_MAX_BUDGET_USD");
  return value;
}
