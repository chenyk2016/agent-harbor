import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../shared/types.js";
import { mcpSandboxPolicy } from "../shared/sandbox-policy.js";

export async function prepareRunnerMounts(root: string, task: Task, directory: string, attemptDirectory: string) {
  // 用户键只由服务端生成；独立CLI没有用户身份时退回会话私有缓存。
  const cacheKey =
    task.dependencyCacheKey ??
    createHash("sha256").update(`session:${task.sessionId}`).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(cacheKey))
    throw new Error("Invalid dependency cache key");
  const cacheDirectory = join(root, ".dependency-caches", cacheKey);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "dependency-env", "home"), {
    recursive: true,
    mode: 0o700,
  });
  // 每次创建均挂载当前管理员策略；下载域名与专家获准网络取并集。
  const policy = JSON.parse(
    await readFile(
      new URL("../../../infra/managed-settings.json", import.meta.url),
      "utf8",
    ),
  );
  policy.sandbox.network.allowedDomains = [
    ...new Set([
      ...policy.sandbox.network.allowedDomains,
      ...(task.networkDomains ?? []),
    ]),
  ];
  const policyFile = join(attemptDirectory, "managed-settings.json");
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o644 });
  if (task.hasLocalMcp)
    await writeFile(
      join(attemptDirectory, "mcp-sandbox.json"),
      JSON.stringify(mcpSandboxPolicy(policy, "/session-env/mcp")),
      { mode: 0o644 },
    );
  return { cacheDirectory, policyFile };
}
