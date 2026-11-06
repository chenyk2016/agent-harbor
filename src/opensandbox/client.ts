import { ConnectionConfig, Sandbox, SandboxManager } from "@alibaba-group/opensandbox";
import type { OpenSandboxPreviewClient } from "./preview-provider.js";

/** Fixed image entrypoint. Only the application configuration file is mounted. */
export function applicationPreviewClient(origin: URL, apiKey: string) {
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
