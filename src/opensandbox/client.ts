import { ConnectionConfig, Sandbox, SandboxManager } from "@alibaba-group/opensandbox";
import type { OpenSandboxPreviewClient } from "./preview-provider.js";

/** Fixed image entrypoint. Only the application configuration file is mounted. */
export function applicationPreviewClient(origin: URL, apiKey: string, strictScope?: string) {
  if (strictScope) {
    const api = async (path: string, method: string, body?: object) => {
      const response = await fetch(new URL(path, origin), {
        method, headers: { "OPEN-SANDBOX-API-KEY": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok && !(method === "DELETE" && response.status === 404)) {
        await response.body?.cancel();
        throw new Error(`OpenSandbox application request failed (${response.status})`);
      }
      if (method !== "DELETE") return response.json();
      await response.body?.cancel();
    };
    return {
      async create({ image, configPath, metadata }) {
        const profile = await api(`/harbor-runner/v1/${strictScope}`, "GET");
        if (!profile?.features?.includes("app-runtime")) throw new Error("Strict OpenSandbox application profile unavailable");
        const result = await api("/v1/sandboxes", "POST", {
          image: { uri: image }, metadata,
          entrypoint: ["node", "/app/harbor-runtime.mjs"], resourceLimits: { cpu: "1", memory: "512Mi" },
          volumes: [{ name: "harbor-config", host: { path: configPath }, mountPath: "/run/harbor-app.json", readOnly: true }],
        });
        return result.id;
      },
      async kill(id) { await api("/v1/sandboxes/" + id, "DELETE"); },
      async endpoint(id, port) { return new URL(`/v1/sandboxes/${id}/proxy/${port}`, origin); },
      async close() {},
    } satisfies OpenSandboxPreviewClient & { close(): Promise<void> };
  }
  const connectionConfig = new ConnectionConfig({
    domain: origin.host, apiKey, useServerProxy: true,
    endpointCacheDisabled: true, requestTimeoutSeconds: 8, disableMetrics: true,
  });
  const manager = SandboxManager.create({ connectionConfig });
  return {
    async create({ image, configPath, metadata }) {
      const sandbox = await Sandbox.create({
        connectionConfig, image, metadata, entrypoint: ["node", "/app/harbor-runtime.mjs"],
        resource: { cpu: "1", memory: "512Mi" }, timeoutSeconds: 3600,
        volumes: [{ name: "harbor-config", host: { path: configPath },
          mountPath: "/run/harbor-app.json", readOnly: true }],
      });
      try { return sandbox.id; } finally { await sandbox.close(); }
    },
    kill: id => manager.killSandbox(id),
    async endpoint(id, port) {
      const sandbox = await Sandbox.connect({ sandboxId: id, connectionConfig });
      try { return new URL(await sandbox.getEndpointUrl(port)); } finally { await sandbox.close(); }
    },
    close: () => manager.close(),
  } satisfies OpenSandboxPreviewClient & { close(): Promise<void> };
}
