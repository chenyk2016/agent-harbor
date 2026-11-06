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
