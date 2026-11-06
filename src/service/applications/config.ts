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
  const address = process.env.AH_APP_OPENSANDBOX_ORIGIN?.trim();
  const apiKey = process.env.AH_APP_OPENSANDBOX_API_KEY?.trim();
  const appIds = new Set((process.env.AH_APP_OPENSANDBOX_PREVIEW_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean));
  if (address || apiKey || appIds.size) {
    const origin = URL.parse(address ?? "");
    if (origin?.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port &&
        origin.href === origin.origin + "/" && apiKey &&
        visitorAuth?.workbenchOrigin && upstream === "127.0.0.1" &&
        appIds.size <= 1 && [...appIds].every(id => appIdPattern.test(id))) {
      openSandboxPreview = { origin, apiKey, appIds };
    } else {
      // Preserve the explicit selection so an invalid setup fails closed on those apps.
      openSandboxPreview = { appIds };
      report("applications", "OpenSandbox preview requires a loopback origin, API key, same-site visitor authentication and at most one pilot app UUID");
    }
  }
  let edge: CaddyApplicationEdge;
  try {
    edge = new CaddyApplicationEdge(caddyAdmin, publicOrigin, upstream, undefined, visitorAuth,
      openSandboxPreview?.origin ? Number(openSandboxPreview.origin.port) : undefined);
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
