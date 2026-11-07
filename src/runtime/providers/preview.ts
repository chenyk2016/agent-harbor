import { createHmac } from "node:crypto";
import type { VisitorDeployment } from "../../service/applications/visitor-auth/config.js";
import type { AppBuild } from "../../service/applications/docker.js";
import type { EnvironmentRef, SandboxProvider } from "./contracts.js";

export interface PreviewLaunch {
  build: AppBuild;
  deploymentId: string;
  databaseUrl: string;
  visitorAuth?: VisitorDeployment;
  previewParentOrigin?: string;
  observation?: { url: string; token: string };
}

/** Server-side target. The proxy must never expose the upstream URL or credentials to clients. */
export interface PrivateEndpoint {
  url: URL;
  headers?: Record<string, string>;
}

export const applicationRuntimeHeader = "X-App-Runtime-Access";
export function applicationRuntimeAccess(key: string, deploymentId: string) {
  return createHmac("sha256", key).update("harbor-app-runtime-v1:" + deploymentId).digest("base64url");
}

export interface PreviewProvider extends SandboxProvider<PreviewLaunch> {
  resolvePrivateEndpoint(ref: EnvironmentRef): Promise<PrivateEndpoint>;
}

export async function verifyPreview(
  endpoint: PrivateEndpoint, launch: Omit<PreviewLaunch, "databaseUrl">, timeout = 20_000,
) {
  const url = new URL(endpoint.url);
  url.pathname = url.pathname.replace(/\/$/, "") + launch.build.basePath + "__harbor/health";
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      headers: endpoint.headers, redirect: "error", signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    if (response?.ok) {
      const identity = await response.json();
      if (identity.deploymentId !== launch.deploymentId || identity.buildId !== launch.build.id ||
          (launch.visitorAuth && identity.visitorAuthVersion !== 1))
        throw new Error("PREVIEW_HEALTH_IDENTITY_MISMATCH");
      return;
    }
    await response?.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("PREVIEW_HEALTH_UNCONFIRMED");
}
