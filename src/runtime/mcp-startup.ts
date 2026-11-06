/** Called with the session lock held, after the previous environment stopped. Never overwrite a live script app. */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { type LocalMcpLaunch, mcpServerName } from "../shared/mcp.js";
/** Only after confirmed container stop, including recovery after a service crash. */
export async function clearStartupCredentials(attemptDirectory: string) {
  const files = await readdir(attemptDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const file of files)
    if (file === "connection.json" || /^mcp-[a-f0-9-]{36}\.json$/.test(file))
      await writeFile(join(attemptDirectory, file), "{}", { mode: 0o600 });
}
export async function prepareMcpStartup(
  directory: string,
  attemptDirectory: string,
  launches: LocalMcpLaunch[] = [],
  servers: Record<string, McpServerConfig> = {},
) {
  const result = { ...servers },
    attempt = attemptDirectory.split("/").at(-1)!;
  for (const launch of launches) {
    if (!/^[a-f0-9-]{36}$/.test(launch.id))
      throw new Error("Invalid MCP connection ID");
    if (launch.script) {
      const app = join(directory, "dependency-env", "mcp", launch.id, "app");
      await rm(app, { recursive: true, force: true });
      await mkdir(app, { recursive: true });
      for (const [path, content] of Object.entries(launch.script.files)) {
        if (
          path.startsWith("/") ||
          path.split("/").some((p) => !p || p === "." || p === "..") ||
          path.includes("\\") ||
          path.includes("\0")
        )
          throw new Error("Invalid MCP script path");
        await mkdir(join(app, path, ".."), { recursive: true });
        await writeFile(join(app, path), content, { mode: 0o644 });
      }
    }
    const file = "mcp-" + launch.id + ".json";
    await writeFile(join(attemptDirectory, file), JSON.stringify(launch), {
      mode: 0o600,
    });
    result[mcpServerName(launch.id)] = {
      command: "/usr/local/bin/node",
      args: [
        "/opt/harbor-runtime/agent/mcp-launcher.js",
        "/platform/run/" + attempt + "/" + file,
      ],
    };
  }
  return result;
}
