import { applicationDataRoot, observationDatabaseUrl } from "../observability/database.js";
import { CaddyApplicationEdge } from "./edge.js";
import { visitorAuthOptions } from "./visitor-auth/config.js";
import type { ApplicationOptions } from "./service.js";

/** 默认关闭；开启时必须显式配置管理能力和受信创作者。 */
export async function applicationOptions(
  dataRoot: string,
): Promise<ApplicationOptions | undefined> {
  if (process.env.AH_APPLICATIONS_ENABLED !== "1") return;
  /** 读取启用应用功能时的必填环境变量；缺失时明确报配置错误，避免以空配置启动。 */
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} before enabling applications`);
    return value;
  };
  const origin = new URL(required("AH_APP_PUBLIC_ORIGIN"));
  if (
    origin.origin !== origin.href.replace(/\/$/, "") ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("Invalid AH_APP_PUBLIC_ORIGIN");
  const creators = new Set(
    required("AH_APP_CREATOR_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!creators.size) throw new Error("Set AH_APP_CREATOR_IDS");
  const visitorAuth = visitorAuthOptions();
  const root = applicationDataRoot(dataRoot);
  const dataAdminUrl = required("AH_APP_DATABASE_ADMIN_URL");
  let observation: ApplicationOptions["observation"];
  try {
    const databaseUrl = await observationDatabaseUrl(root);
    if (databaseUrl) observation = observationOptions(databaseUrl);
    else if (process.env.AH_OBSERVATION_ENABLED !== "0")
      console.error("OBSERVATION_SETUP_REQUIRED: run npm run observability:migrate");
  } catch {
    console.error("OBSERVATION_CONFIGURATION_INVALID");
  }
  return {
    visitorAuth,
    root,
    nodeBase:
      process.env.AH_APP_NODE_BASE ??
      "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
    dataAdminUrl,
    databaseHost: process.env.AH_APP_DATABASE_HOST,
    edge: new CaddyApplicationEdge(
      required("AH_APP_CADDY_ADMIN"),
      origin.origin,
      process.env.AH_APP_EDGE_UPSTREAM_HOST ?? "127.0.0.1",
      undefined,
      visitorAuth,
    ),
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
