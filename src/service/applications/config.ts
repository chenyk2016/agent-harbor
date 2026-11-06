import { appIdPattern } from "./source-store.js";
import { applicationDataRoot, observationDatabaseUrl, observationEnabled } from "../observability/database.js";
import { CaddyApplicationEdge } from "./edge.js";
import { visitorAuthOptions, type VisitorFeatureReporter } from "./visitor-auth/config.js";
import type { ApplicationOptions } from "./service.js";

type ApplicationFeature = "applications" | "applicationObservation" | Parameters<VisitorFeatureReporter>[0];
export type ApplicationFeatureReporter = (feature: ApplicationFeature, reason: string) => void;
const logUnavailable: ApplicationFeatureReporter = (feature, reason) => console.error(`${feature}: ${reason}`);

/** 配置完整时自动启用。只报告配置名，避免泄漏地址里的私密内容。 */
export function applicationConfiguration(report = logUnavailable, env: NodeJS.ProcessEnv = process.env) {
  if (["0", "false"].includes(env.AH_APPLICATIONS_ENABLED ?? "")) {
    report("applications", "Disabled by AH_APPLICATIONS_ENABLED");
    return;
  }
  const required = ["AH_APP_PUBLIC_ORIGIN", "AH_APP_CREATOR_IDS", "AH_APP_DATABASE_ADMIN_URL", "AH_APP_CADDY_ADMIN"] as const;
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) {
    report("applications", `Missing ${missing.join(", ")}`);
    return;
  }
  const [publicOrigin, creatorIds, dataAdminUrl, caddyAdmin] = required.map(name => env[name]!.trim());
  const creators = new Set(creatorIds.split(",").map(value => value.trim()).filter(Boolean));
  if (!creators.size) {
    report("applications", "Invalid AH_APP_CREATOR_IDS");
    return;
  }
  try {
    const origin = new URL(publicOrigin);
    if (origin.origin !== origin.href.replace(/\/$/, "") || !["http:", "https:"].includes(origin.protocol))
      throw new Error();
    return { publicOrigin: origin.origin, creators, dataAdminUrl, caddyAdmin };
  } catch {
    report("applications", "Invalid AH_APP_PUBLIC_ORIGIN");
    return;
  }
}

export async function applicationOptions(
  dataRoot: string,
  report = logUnavailable,
): Promise<ApplicationOptions | undefined> {
  const configuration = applicationConfiguration(report);
  if (!configuration) return;
  const { publicOrigin, creators, dataAdminUrl, caddyAdmin } = configuration;
  const visitorAuth = visitorAuthOptions(report);
  const upstream = process.env.AH_APP_EDGE_UPSTREAM_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "host.docker.internal"].includes(upstream)) {
    report("applications", "Invalid AH_APP_EDGE_UPSTREAM_HOST");
    return;
  }
  let openSandboxPreview: ApplicationOptions["openSandboxPreview"];
  const backend = process.env.AH_APP_RUNTIME_BACKEND;
  if (backend && backend !== "docker" && backend !== "opensandbox") {
    report("applications", "Invalid AH_APP_RUNTIME_BACKEND");
    return;
  }
  const all = backend === "opensandbox";
  const address = (process.env.AH_APP_OPENSANDBOX_ORIGIN ?? (all ? process.env.AH_OPENSANDBOX_RUNNER_ORIGIN : undefined))?.trim();
  const apiKey = (process.env.AH_APP_OPENSANDBOX_API_KEY ?? (all ? process.env.AH_OPENSANDBOX_RUNNER_KEY : undefined))?.trim();
  const appIds = new Set((process.env.AH_APP_OPENSANDBOX_PREVIEW_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean));
  if (all || address || apiKey || appIds.size) {
    const origin = URL.parse(address ?? "");
    if (origin?.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port &&
        origin.href === origin.origin + "/" && apiKey && (!all || apiKey.length >= 32) &&
        (all || (visitorAuth?.workbenchOrigin && upstream === "127.0.0.1" &&
          appIds.size <= 1 && [...appIds].every(id => appIdPattern.test(id))))) {
      openSandboxPreview = { origin, apiKey, appIds, ...(all ? { all } : {}) };
    } else {
      openSandboxPreview = { appIds, ...(all ? { all } : {}) };
      report("applications", "OpenSandbox application runtime requires a loopback origin and API key");
    }
  }
  let edge: CaddyApplicationEdge;
  try {
    edge = new CaddyApplicationEdge(caddyAdmin, publicOrigin, upstream, undefined, visitorAuth,
      openSandboxPreview?.origin ? Number(openSandboxPreview.origin.port) : undefined, all ? openSandboxPreview?.apiKey : undefined);
  } catch {
    report("applications", "Invalid AH_APP_CADDY_ADMIN");
    return;
  }
  const root = applicationDataRoot(dataRoot);
  let observation: ApplicationOptions["observation"];
  try {
    const databaseUrl = await observationDatabaseUrl(root);
    if (databaseUrl) observation = observationOptions(databaseUrl);
    else report("applicationObservation", !observationEnabled()
      ? "Disabled by AH_OBSERVATION_ENABLED"
      : "Observation database is not ready; run npm run observability:migrate");
  } catch {
    report("applicationObservation", "Invalid observation database or collector configuration");
  }
  return {
    visitorAuth,
    openSandboxPreview,
    root,
    nodeBase:
      process.env.AH_APP_NODE_BASE ??
      "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
    dataAdminUrl,
    databaseHost: process.env.AH_APP_DATABASE_HOST,
    edge,
    creators,
    downloadProxy: process.env.AH_APP_BUILD_PROXY,
    observation,
  };
}

/** 校验采集地址和监听端口，避开同实例 LiteLLM 的默认端口。 */
function observationOptions(databaseUrl: string) {
  const defaultPort = process.env.AH_OBSERVATION_DATABASE_URL ? 4320 : 4324;
  const port = Number(process.env.AH_OBSERVATION_PORT ?? defaultPort);
  const publicUrl = process.env.AH_OBSERVATION_COLLECTOR_URL ?? `http://host.docker.internal:${port}`;
  const url = new URL(publicUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid observation collector URL");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid observation port");
  return {
    databaseUrl,
    edgeLog: process.env.AH_OBSERVATION_EDGE_LOG,
    publicUrl: url.origin,
    bindHost: process.env.AH_OBSERVATION_BIND_HOST ?? "127.0.0.1",
    port,
  };
}
