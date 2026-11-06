/** Discovery uses the same container/launcher/policy as a session; never executes user code on the Harbor host. */
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerBackend } from "../../docker/docker.js";
import { Store } from "../../runtime/storage.js";
import { prepareMcpStartup } from "../../runtime/mcp-startup.js";
import { profileFromEnvironment } from "../config.js";
import type { McpService } from "./service.js";
import type { Task } from "../../shared/types.js";
import { fail } from "../types.js";
import type { ResidentProvider } from "../../runtime/providers/resident.js";
import { runResidentJob } from "../../runtime/providers/run-job.js";
const active = new Set<string>();
export async function probeMcp(service: McpService, user: string, id: string, resident?: ResidentProvider) {
  if (active.has(user) || active.size >= 4) fail(429, "MCP_PROBE_BUSY");
  active.add(user);
  const root = service.scripts.root,
    sessionId = randomUUID(),
    store = new Store(root),
    backend = new DockerBackend(root);
  const directory = store.directory(sessionId),
    attempt = join(directory, "attempts", sessionId);
  const useOpenSandbox = resident?.backendId === "opensandbox-strict-runner";
  let container: string | undefined,
    cleaned = false;
  try {
    await store.prepare(sessionId);
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
    if (useOpenSandbox) {
      const signal = AbortSignal.timeout(35000);
      const image = await resident.resolveImage(profile.image);
      const result = await runResidentJob(resident, { task, profile: { ...profile, image }, directory, attemptDirectory: attempt },
        signal, async transport => {
          transport.diagnostics.resume();
          const output: Buffer[] = [];
          let size = 0;
          for await (const chunk of transport.output) {
            size += chunk.length;
            if (size > 512 * 1024) fail(502, "MCP_CONNECTION_FAILED");
            output.push(chunk);
          }
          if (await transport.completion !== 0 || signal.aborted) fail(502, "MCP_CONNECTION_FAILED");
          const result = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (!Array.isArray(result.tools)) fail(502, "MCP_CONNECTION_FAILED");
          return result;
        });
      cleaned = true;
      return result;
    }
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
      if (!useOpenSandbox) {
        const name = container ?? "ah-" + sessionId;
        await backend.stop(name);
        await backend.destroy(name);
        cleaned = true;
      } else if (!cleaned) {
        cleaned = !(await resident.findOwned(sessionId)).length;
      }
      if (cleaned) await rm(directory, { recursive: true, force: true });
    } finally {
      if (cleaned) active.delete(user);
    }
  }
}
