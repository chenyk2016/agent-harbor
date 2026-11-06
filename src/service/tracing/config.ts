/** Only this trusted configuration selects a telemetry destination; no independent enabled flag. */
import { createHash } from "node:crypto";
export interface LangfuseConfig {
  state: "disabled" | "invalid" | "enabled";
  issues: string[];
  host?: string;
  publicKey?: string;
  secretKey?: string;
  destination?: string;
  contentMode?: "metadata" | "redacted";
}
export const digest = (value: string, length = 32) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
export function langfuseConfig(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig {
  const names = [
    "AH_LANGFUSE_HOST",
    "AH_LANGFUSE_PUBLIC_KEY",
    "AH_LANGFUSE_SECRET_KEY",
  ];
  const [rawHost, publicKey, secretKey] = names.map((n) =>
    (env[n] ?? "").trim(),
  );
  let host = rawHost;
  if (![host, publicKey, secretKey].some(Boolean))
    return { state: "disabled", issues: [] };
  const issues = names.filter((_, i) => ![host, publicKey, secretKey][i]);
  const mode = (env.AH_LANGFUSE_CONTENT_MODE ?? "").trim() || "metadata";
  if (mode !== "metadata" && mode !== "redacted")
    issues.push("AH_LANGFUSE_CONTENT_MODE");
  try {
    const u = new URL(host);
    if (
      (u.pathname !== "/" && u.pathname !== "") ||
      u.search ||
      u.hash ||
      u.username ||
      u.password ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "host.docker.internal"].includes(
            u.hostname,
          ))
      )
    )
      issues.push("AH_LANGFUSE_HOST");
    else host = u.origin;
  } catch {
    if (host) issues.push("AH_LANGFUSE_HOST");
  }
  for (const [i, value] of [
    [1, publicKey],
    [2, secretKey],
  ] as const)
    if (value && (!/^[\x21-\x7e]{1,512}$/.test(value) || value.includes(":")))
      issues.push(names[i]);
  if (issues.length) return { state: "invalid", issues: [...new Set(issues)] };
  return {
    state: "enabled",
    issues: [],
    contentMode: mode === "redacted" ? "redacted" : "metadata",
    host,
    publicKey,
    secretKey,
    destination: digest(host + ":" + publicKey),
  };
}
export function publicTracingConfig(config: LangfuseConfig) {
  return {
    state: config.state,
    issues: config.issues,
    contentMode: config.contentMode,
  };
}
