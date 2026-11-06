/** A resolved local launch belongs to one user and one environment; never expose it in API responses. */
export interface LocalMcpLaunch {
  id: string;
  command: string[];
  env: Record<string, string>;
  script?: {
    entry: string;
    runtime: "node" | "python";
    install: "none" | "npm" | "uv";
    files: Record<string, string>;
  };
}
export interface McpRuntime {
  mcpServers: Record<
    string,
    import("@anthropic-ai/claude-agent-sdk").McpServerConfig
  >;
  localMcp?: LocalMcpLaunch[];
  networkDomains?: string[];
}
export const mcpServerName = (id: string) => "harbor_" + id.replace(/-/g, "");


export const offlineTextMcpCommand = [
  "/usr/local/bin/node",
  "/opt/harbor-runtime/service/mcp/builtin.js",
] as const;

/** Only the image's offline, credential-free MCP is qualified on both backends. */
export function isOfflineTextMcp(launch: LocalMcpLaunch) {
  return !launch.script && Object.keys(launch.env).length === 0 &&
    launch.command.length === offlineTextMcpCommand.length &&
    offlineTextMcpCommand.every((part, index) => part === launch.command[index]);
}
