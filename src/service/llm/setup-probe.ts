import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Store } from "../../runtime/storage.js";
import type { ModelProbeStatus } from "../../shared/llm.js";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";
import { requireId } from "../skills/service.js";
import { fail, modelProbePrefix, ServiceError, type ServiceEvent } from "../types.js";
import type { SessionManager } from "../session-manager.js";
import type { ResourceDeletions } from "../deletions/service.js";
import type { LlmService } from "./service.js";

const file = "/workspace/harbor-model-check.txt";
const prompt = `Use the Read tool exactly once to read ${file}. Reply with only the text in the file. Do not use other tools.`;

export function modelProbeEvidence(events: ServiceEvent[], marker: string) {
  const read = events.find(event => event.type === "tool.started" &&
    event.payload.name === "Read" && event.payload.detail === file &&
    typeof event.payload.toolUseId === "string");
  const finished = read && events.find(event => event.type === "tool.finished" &&
    event.eventId > read.eventId && event.payload.name === "Read" &&
    event.payload.toolUseId === read.payload.toolUseId);
  const answer = finished && events.filter(event => event.type === "assistant.text.delta" &&
    event.eventId > finished.eventId).map(event => event.payload.text).join("");
  return { tool: Boolean(finished), stream: answer?.includes(marker) === true };
}

/** An explicit test uses the same managed credentials, wallet and native runner as a normal turn. */
export function modelProbeRouter(llm: LlmService, manager: SessionManager, store: Store, deletions: ResourceDeletions) {
  const router = Router();
  const jobs = new Map<string, ModelProbeStatus>();
  const recovery = manager.store.modelProbeSessions().then(async rows => {
    for (const row of rows) await deletions.request(row.ownerId, "session", row.id);
  }).catch(() => {
    console.error("Model setup test recovery requires retry");
  });

  router.get("/admin/llm/setup/probe/:id", (req, res) => {
    const job = jobs.get(principal(res).userId);
    if (!job || job.id !== parameter(req, "id")) fail(404, "MODEL_PROBE_NOT_FOUND");
    res.json(job);
  });
  router.post("/admin/llm/setup/probe/:id", ...jsonBody(), async (req, res) => {
    await recovery;
    const user = principal(res).userId;
    const id = requireId(parameter(req, "id"));
    const deploymentId = requireId(jsonInput(req).deploymentId);
    const old = jobs.get(user);
    if (old?.id === id) {
      if (old.deploymentId !== deploymentId) fail(409, "REQUEST_ID_CONFLICT");
      res.json(old);
      return;
    }
    if (old?.status === "running") fail(409, "MODEL_PROBE_BUSY");
    // Keep a failed or interrupted test from starting a second runner while cleanup is unresolved.
    const previous = (await manager.store.modelProbeSessions()).filter(row => row.ownerId === user);
    if (previous.length) {
      for (const row of previous) await deletions.request(user, "session", row.id);
      fail(409, "MODEL_PROBE_CLEANUP_PENDING");
    }
    if (jobs.get(user) !== old) fail(409, "MODEL_PROBE_BUSY");
    const job: ModelProbeStatus = {
      id, deploymentId, status: "running", synced: false, tool: false, stream: false,
    };
    jobs.set(user, job);
    void run(user, job);
    res.status(202).json(job);
  });

  async function run(user: string, job: ModelProbeStatus) {
    const sessionId = randomUUID();
    const started = Date.now();
    let stage = "MODEL_PROBE_SYNC_FAILED";
    let cleanupPending = false;
    try {
      const detail = await llm.syncDeployment(job.deploymentId);
      job.synced = true;
      job.versionId = detail.deployment.currentVersionId;
      stage = "MODEL_PROBE_FAILED";
      const marker = randomBytes(10).toString("hex");
      await manager.createPrepared(user, "模型接入测试", sessionId, async () => {
        const directory = await store.prepare(sessionId);
        await writeFile(join(directory, "workspace", "harbor-model-check.txt"), marker + "\n", { mode: 0o644 });
      }, { deploymentId: job.deploymentId, requestId: modelProbePrefix + job.id, modelProbe: true });
      const { message } = await manager.submit(user, sessionId, job.id, prompt, job.deploymentId, false, true);
      if (message.modelSnapshot?.versionId !== job.versionId) fail(409, "MODEL_PROBE_VERSION_CHANGED");

      // The runner has its own deadline; the service also bounds how long it waits for startup and events.
      const deadline = Date.now() + 80_000;
      const events: ServiceEvent[] = [];
      let cursor = 0;
      for (;;) {
        const batch = await manager.store.events(sessionId, cursor);
        cursor = batch.at(-1)?.eventId ?? cursor;
        events.push(...batch.filter(event => event.messageId === message.id));
        Object.assign(job, modelProbeEvidence(events, marker));
        // Stop early on a definitive provider rejection. The SDK may still be retrying.
        const last = events.findLast(event => event.type === "message.finished");
        if (llm.settings.walletProxyUrl && (!job.tool || last?.payload.status !== "succeeded")) {
          const failures = await manager.store.db.execute(sql`SELECT "failureCode" FROM wallet_requests
            WHERE "sessionId"=${sessionId} AND "failureCode" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`);
          const code = String(failures.rows[0]?.failureCode ?? "");
          if (code === "UPSTREAM_HTTP_401" || code === "UPSTREAM_HTTP_403")
            fail(502, "MODEL_PROBE_UPSTREAM_AUTH");
          if (code === "UPSTREAM_HTTP_404") fail(502, "MODEL_PROBE_UPSTREAM_MODEL");
        }
        if (last && batch.length < 100) {
          if (last.payload.status !== "succeeded" || !job.tool || !job.stream) {
            const result = last.payload.result as { error?: string } | undefined;
            if (result?.error === "TASK_TIMEOUT") fail(504, "MODEL_PROBE_TIMEOUT");
            if (last.payload.status === "succeeded") fail(502, job.tool ? "MODEL_PROBE_STREAM_FAILED" : "MODEL_PROBE_TOOL_FAILED");
            fail(502, "MODEL_PROBE_FAILED");
          }
          break;
        }
        if (Date.now() >= deadline) fail(504, "MODEL_PROBE_TIMEOUT");
        await delay(350);
      }
    } catch (error) {
      job.error = error instanceof ServiceError ? error.code : stage;
    } finally {
      try {
        const session = await manager.store.session(sessionId);
        if (session) {
          const deletion = await deletions.request(user, "session", sessionId);
          const deadline = Date.now() + 20_000;
          for (let current = deletion; current.state !== "completed"; current = await deletions.job(user, deletion.id)) {
            if (current.state === "failed" || Date.now() >= deadline) {
              cleanupPending = true;
              break;
            }
            await delay(350);
          }
        } else {
          await rm(store.directory(sessionId), { recursive: true, force: true });
        }
      } catch {
        cleanupPending = true;
      }
      if (cleanupPending) job.error ??= "MODEL_PROBE_CLEANUP_PENDING";
      if (!job.error && job.versionId) {
        try {
          await llm.completeSetup(job.deploymentId, job.versionId, user);
        } catch (error) {
          job.error = error instanceof ServiceError ? error.code : "MODEL_PROBE_FAILED";
        }
      }
      job.durationMs = Date.now() - started;
      job.status = job.error ? "failed" : "passed";
    }
  }
  return router;
}
