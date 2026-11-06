/** Native discovery without sending a user prompt or making a model request. Runs only in a disposable probe container. */
import { readFile } from "node:fs/promises";
import {
  query,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
const connection = JSON.parse(await readFile(process.argv[2], "utf8"));
let release!: () => void;
async function* idle(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((r) => (release = r));
}
const session = query({
  prompt: idle(),
  options: {
    cwd: "/workspace",
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    mcpServers: Object.fromEntries(
      Object.entries(connection.mcpServers).map(([k, v]) => [
        k,
        { ...(v as McpServerConfig), alwaysLoad: true },
      ]),
    ),
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/platform/state",
      CLAUDE_CONFIG_DIR: "/platform/state",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_AUTH_TOKEN: "NO_MODEL_REQUEST",
    },
    stderr: () => {},
  },
});
try {
  await session.initializationResult();
  let status = await session.mcpServerStatus();
  for (let i = 0; i < 40 && status.some((s) => s.status === "pending"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = await session.mcpServerStatus();
  }
  if (!status.length || status.some((s) => s.status !== "connected"))
    throw new Error("MCP_CONNECTION_FAILED");
  const tools = status
    .flatMap((s) =>
      (s.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      })),
    )
    .slice(0, 200);
  console.log(JSON.stringify({ tools }));
} catch {
  console.log(JSON.stringify({ error: "MCP_CONNECTION_FAILED" }));
  process.exitCode = 1;
} finally {
  release?.();
  session.close();
}
