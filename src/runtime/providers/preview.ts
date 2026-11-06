import type { AppBuild } from "../../service/applications/docker.js";
import type { EnvironmentRef, SandboxProvider } from "./contracts.js";

export interface PreviewLaunch {
  build: AppBuild;
  deploymentId: string;
  databaseUrl: string;
}

/** Server-side target. The proxy must never expose the upstream URL or credentials to clients. */
export interface PrivateEndpoint {
  url: URL;
}

export interface PreviewProvider extends SandboxProvider<PreviewLaunch> {
  resolvePrivateEndpoint(ref: EnvironmentRef): Promise<PrivateEndpoint>;
}

export async function verifyPreview(
  endpoint: PrivateEndpoint, launch: PreviewLaunch,
) {
  const url = new URL(endpoint.url);
  url.pathname = url.pathname.replace(/\/$/, "") + launch.build.basePath + "__harbor/health";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      redirect: "error", signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    if (response?.ok) {
      const identity = await response.json();
      if (identity.deploymentId !== launch.deploymentId || identity.buildId !== launch.build.id)
        throw new Error("PREVIEW_HEALTH_IDENTITY_MISMATCH");
      return;
    }
    await response?.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("PREVIEW_HEALTH_UNCONFIRMED");
}
