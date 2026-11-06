import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { VisitorProvider } from "./policy.js";

/** Harbor 私有配置。包含 PocketBase 管理凭据、Google 凭据和网关证明。 */
export interface VisitorAuthOptions {
  authOrigin: string;
  /** 同站 HTTPS 工作台，可选；只用于嵌入受保护的测试环境。 */
  workbenchOrigin?: string;
  appDomain: string;
  pocketbase: string;
  pocketbaseToken: string;
  googleId?: string;
  googleSecret?: string;
  betterAuth?: {
    secret: string;
    google: Partial<Record<"preview" | "production", { clientId: string; clientSecret: string }>>;
  };
  defaultBackend?: "pocketbase" | "better_auth";
  edgeDial: string;
  edgeToken: string;
  signingKey: KeyObject;
  publicKey: string;
}

/** 随部署版本固定的公开材料。只将公钥交给应用运行器。 */
export interface VisitorDeployment {
  origin: string;
  publicKey: string;
  previewParentOrigin?: string;
  /** 旧部署未记录方式，按原有两种方式处理。 */
  providers?: VisitorProvider[];
}

/** The application origin is allocated by Harbor, independent of source or browser input. */
export function visitorOrigin(
  domain: string,
  appId: string,
  environment: string,
) {
  return `https://${appId}-${environment === "preview" ? "preview" : "prod"}.${domain}`;
}

export const visitorPath = "/__harbor/visitor";

/** 安装者显式启用后核对域名、网关和签名配置，发现缺项时阻止启动。 */
export function visitorAuthOptions(): VisitorAuthOptions | undefined {
  if (process.env.AH_APP_AUTH_ENABLED !== "1") return;
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const auth = new URL(required("AH_APP_AUTH_ORIGIN"));
  const appDomain = required("AH_APP_AUTH_DOMAIN");
  const pocketbase = new URL(required("AH_APP_AUTH_POCKETBASE"));
  const edgeDial = required("AH_APP_AUTH_EDGE_DIAL");
  const edgeToken = required("AH_APP_AUTH_EDGE_TOKEN");
  const signingKey = createPrivateKey({
    key: Buffer.from(required("AH_APP_AUTH_SIGNING_KEY"), "base64"),
    format: "der",
    type: "pkcs8",
  });
  const management = new URL(required("AH_APP_PUBLIC_ORIGIN"));
  const workbenchOrigin = process.env.AH_APP_AUTH_WORKBENCH_ORIGIN?.trim() || undefined;
  if (workbenchOrigin) {
    const studio = new URL(workbenchOrigin);
    const site = appDomain.split(".").slice(1).join(".");
    const appLabel = studio.hostname.endsWith("." + appDomain)
      ? studio.hostname.slice(0, -(appDomain.length + 1)) : "";
    // 保留由平台分配的应用域名；工作台只允许同站、独立的 HTTPS origin。
    if (studio.protocol !== "https:" || studio.origin !== workbenchOrigin ||
        !site.includes(".") || !studio.hostname.endsWith("." + site) ||
        studio.hostname === auth.hostname || studio.hostname === appDomain ||
        /^[a-f0-9-]+-(preview|prod)$/.test(appLabel))
      throw new Error("Invalid AH_APP_AUTH_WORKBENCH_ORIGIN");
  }
  const defaultBackend = process.env.AH_APP_AUTH_BACKEND?.trim() || "pocketbase";
  const betterSecret = process.env.AH_APP_AUTH_BETTER_SECRET?.trim();
  if (!["pocketbase", "better_auth"].includes(defaultBackend) ||
      (betterSecret && betterSecret.length < 32) || (defaultBackend === "better_auth" && !betterSecret))
    throw new Error("Invalid application visitor backend configuration");
  const google: NonNullable<VisitorAuthOptions["betterAuth"]>["google"] = {};
  for (const environment of ["preview", "production"] as const) {
    const prefix = "AH_APP_AUTH_BETTER_GOOGLE_" + environment.toUpperCase();
    const clientId = process.env[prefix + "_ID"]?.trim();
    const clientSecret = process.env[prefix + "_SECRET"]?.trim();
    if (!!clientId !== !!clientSecret || (clientId && !betterSecret)) throw new Error("Invalid Better Auth Google configuration");
    if (clientId && clientSecret) google[environment] = { clientId, clientSecret };
  }
  if (google.preview && google.preview.clientId === google.production?.clientId)
    throw new Error("Preview and production require distinct Google clients");
  const googleId = process.env.AH_APP_AUTH_GOOGLE_ID?.trim() || undefined;
  const googleSecret =
    process.env.AH_APP_AUTH_GOOGLE_SECRET?.trim() || undefined;
  if (
    !!googleId !== !!googleSecret ||
    auth.protocol !== "https:" ||
    auth.href !== auth.origin + "/" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(appDomain) ||
    [auth.hostname, management.hostname].some(
      (host) => host === appDomain || host.endsWith("." + appDomain),
    ) ||
    auth.hostname === management.hostname ||
    !["http:", "https:"].includes(pocketbase.protocol) ||
    pocketbase.href !== pocketbase.origin + "/" ||
    !/^(?:127\.0\.0\.1|host\.docker\.internal):\d{1,5}$/.test(edgeDial) ||
    Number(edgeDial.split(":")[1]) < 1 ||
    Number(edgeDial.split(":")[1]) > 65535 ||
    !/^[a-zA-Z0-9_-]{32,128}$/.test(edgeToken) ||
    signingKey.asymmetricKeyType !== "ed25519"
  )
    throw new Error("Invalid application visitor authentication configuration");
  return {
    authOrigin: auth.origin,
    workbenchOrigin,
    appDomain,
    pocketbase: pocketbase.origin,
    edgeDial,
    edgeToken,
    pocketbaseToken: required("AH_APP_AUTH_POCKETBASE_TOKEN"),
    defaultBackend: defaultBackend as VisitorAuthOptions["defaultBackend"],
    betterAuth: betterSecret ? { secret: betterSecret, google } : undefined,
    googleId,
    googleSecret,
    signingKey,
    publicKey: createPublicKey(signingKey)
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}
