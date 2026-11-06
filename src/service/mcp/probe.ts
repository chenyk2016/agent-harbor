/** Discovery uses the same container/launcher/policy as a session; never executes user code on the Harbor host. */
import { randomUUID, createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerBackend } from "../../docker/docker.js";
import { Store } from "../../runtime/storage.js";
import { prepareMcpStartup } from "../../runtime/mcp-startup.js";
import { profileFromEnvironment } from "../config.js";
import type { McpService } from "./service.js";
import type { Task } from "../../shared/types.js";
import { fail } from "../types.js";
const active = new Set<string>();
export async function probeMcp(service: McpService, user: string, id: string) {
  if (active.has(user) || active.size >= 4) fail(429, "MCP_PROBE_BUSY");
  active.add(user);
  const root = service.scripts.root,
    sessionId = randomUUID(),
    store = new Store(root),
    backend = new DockerBackend(root);
  const directory = store.directory(sessionId),
    attempt = join(directory, "attempts", sessionId);
  let container: string | undefined,
    cleaned = false;
  try {
    await store.prepare(sessionId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(attempt, { recursive: true });
    const runtime = await service.runtime(user, id),
      profile = profileFromEnvironment();
    const mcpServers = await prepareMcpStartup(
      directory,
      attempt,
      runtime.localMcp,
      runtime.mcpServers,
    );
    await writeFile(
      join(attempt, "connection.json"),
      JSON.stringify({ mcpServers }),
      { mode: 0o600 },
    );
    const task: Task = {
      sessionId,
      attemptId: sessionId,
      generation: 1,
      prompt: "",
      model: profile.model,
      maxTurns: 1,
      maxBudgetUsd: 0,
      timeoutMs: 30000,
      mcpProbe: true,
      dependencyCacheKey: createHash("sha256")
        .update("user:" + user)
        .digest("hex"),
      hasLocalMcp: !!runtime.localMcp?.length,
    };
    container = await backend.create(task, profile, directory, attempt);
    // The deterministic container ID is known before create; catch/finally also recovers a late Docker result.
    // A probe may exit successfully before `docker start` returns; it is not a resident keeper.
    await backend.command(["start", container]);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("docker", ["wait", container], {
      timeout: 35000,
    });
    const state = JSON.parse(await backend.command(["inspect", container]))[0];
    if (state.State.ExitCode !== 0) fail(502, "MCP_CONNECTION_FAILED");
    const output = await backend.command(["logs", container]);
    const result = JSON.parse(output.trim());
    if (result.error) fail(502, "MCP_CONNECTION_FAILED");
    return result;
  } catch {
    fail(502, "MCP_CONNECTION_FAILED");
  } finally {
    try {
      const name = container ?? "ah-" + sessionId;
      await backend.stop(name);
      await backend.destroy(name);
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    } finally {
      if (cleaned) active.delete(user);
    }
  }
}
