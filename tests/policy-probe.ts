/** 容器内的文件权限探针：保留正式管理员策略，只测文件工具，不启动 Bash。 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { containerPaths } from "../src/shared/paths.js";

const connection = JSON.parse(
  await readFile(`${containerPaths.run}/connection.json`, "utf8"),
);
const resolved = await resolveSettings({
  cwd: containerPaths.workspace,
  settingSources: [],
});
const mounts: Record<string, boolean> = {};
for (const [name, file] of [
  ["runtimeReadOnly", `${containerPaths.runtime}/package.json`],
  ["runReadOnly", `${containerPaths.run}/secret.txt`],
]) {
  try {
    await writeFile(file, "must not overwrite");
    mounts[name] = false;
  } catch (error) {
    mounts[name] = (error as NodeJS.ErrnoException).code === "EROFS";
  }
}
await writeFile(
  `${containerPaths.state}/parent-state.txt`,
  "state writable by trusted parent",
);
await writeFile(
  `${containerPaths.workspace}/parent-output.txt`,
  "workspace writable",
);
const oldPaths: Record<string, boolean> = {};
for (const path of ["/opt/agent", "/agent-config", "/platform-private"]) {
  try {
    await stat(path);
    oldPaths[path] = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    oldPaths[path] = false;
  }
}
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 30_000);
let result;
try {
  for await (const message of query({
    prompt: "Run the fixed local file-permission probe.",
    options: {
      cwd: containerPaths.workspace,
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write"],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      permissionMode: "default",
      persistSession: false,
      maxTurns: 10,
      maxBudgetUsd: 1,
      abortController: abort,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: containerPaths.state,
        CLAUDE_CONFIG_DIR: containerPaths.state,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_BASE_URL: connection.url,
        ANTHROPIC_AUTH_TOKEN: connection.token,
      },
      // 即使上层回调愿意放行，管理员 deny 仍应拒绝私有路径。
      canUseTool: async (_name, input) => ({
        behavior: "allow",
        updatedInput: input,
      }),
    },
  }))
    if (message.type === "result") result = { subtype: message.subtype };
} finally {
  clearTimeout(timer);
}
process.stdout.write(JSON.stringify({ resolved, mounts, oldPaths, result }));
