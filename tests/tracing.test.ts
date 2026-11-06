import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./pg.js";
import { langfuseConfig } from "../src/service/tracing/config.js";
import { TracingService } from "../src/service/tracing/service.js";
import { ServiceStore } from "../src/service/service-store.js";
import { IdentityStore } from "../src/service/identity/store.js";

const env = {
  AH_LANGFUSE_HOST: "https://jp.cloud.langfuse.com",
  AH_LANGFUSE_PUBLIC_KEY: "fixture-public",
  AH_LANGFUSE_SECRET_KEY: "fixture-secret",
};
test("tracing configuration: absent, blank, partial, invalid, complete; no independent switch", () => {
  assert.equal(langfuseConfig({}).state, "disabled");
  assert.equal(
    langfuseConfig({ AH_LANGFUSE_HOST: "  ", AH_LANGFUSE_PUBLIC_KEY: "" })
      .state,
    "disabled",
  );
  assert.equal(
    langfuseConfig({ AH_LANGFUSE_HOST: env.AH_LANGFUSE_HOST }).state,
    "invalid",
  );
  for (const host of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?secret=x",
  ])
    assert.equal(
      langfuseConfig({ ...env, AH_LANGFUSE_HOST: host }).state,
      "invalid",
    );
  assert.equal(
    langfuseConfig({ ...env, AH_LANGFUSE_HOST: env.AH_LANGFUSE_HOST + "/" })
      .host,
    env.AH_LANGFUSE_HOST,
  );
  assert.equal(
    langfuseConfig({ ...env, AH_LANGFUSE_SECRET_KEY: "secret\nvalue" }).state,
    "invalid",
  );
  assert.equal(
    langfuseConfig({ ...env, AH_LANGFUSE_ENABLED: "false" }).state,
    "enabled",
  );
  assert(
    !JSON.stringify(
      langfuseConfig({ ...env, AH_LANGFUSE_HOST: "bad" }),
    ).includes("fixture-secret"),
  );
});

test("tracing disabled/invalid does not access database or network", async () => {
  for (const config of [
    langfuseConfig({}),
    langfuseConfig({ AH_LANGFUSE_HOST: "bad" }),
  ]) {
    let calls = 0;
    const service = new TracingService(
      {
        execute() {
          calls++;
          throw Error("unexpected database");
        },
      } as any,
      config,
      (async () => {
        calls++;
        throw Error("unexpected network");
      }) as typeof fetch,
    );
    await service.initialize();
    service.start();
    await service.tick();
    assert.equal(await service.prepare(randomUUID(), "s", "u"), undefined);
    assert.equal((await service.evidence("r")).url, null);
    assert.equal((await service.status()).state, config.state);
    await service.close();
    assert.equal(calls, 0);
  }
});

test("tracing: durable events, late origins, retry/restart, idempotent spans, private metadata and target isolation", async () => {
  const db = await testDatabase();
  let mode = "fail",
    requests = 0;
  const batches: any[] = [];
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests++;
    if (String(url).endsWith("/projects"))
      return Response.json({ data: [{ id: "fixture-project" }] });
    const body = JSON.parse(String(init?.body));
    batches.push(body);
    if (mode === "fail") return Response.json({}, { status: 503 });
    if (mode === "partial")
      return Response.json({ partialSuccess: { rejectedSpans: "1" } });
    return Response.json({});
  }) as typeof fetch;
  let tracer = new TracingService(db.db, langfuseConfig(env), transport);
  try {
    const identity = new IdentityStore(db.db),
      store = new ServiceStore(db.db);
    await identity.ensure("owner");
    const old = randomUUID(),
      session = randomUUID(),
      message = randomUUID();
    const now = Date.now();
    await db.pool.query(
      'INSERT INTO sessions(id,"ownerId",title,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$4)',
      [old, "owner", "PRIVATE_OLD_TITLE", now],
    );
    await store.event(old, null, "tool.started", {
      detail: "PRIVATE_OLD_TEXT",
    });
    await tracer.initialize();
    await db.pool.query(
      'INSERT INTO sessions(id,"ownerId",title,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$4)',
      [session, "owner", "PRIVATE_SESSION_TITLE", now],
    );
    await db.pool.query(
      'INSERT INTO messages(id,"sessionId","clientMessageId",text,status,"startedAt") VALUES($1,$2,$1,$3,$4,$5)',
      [message, session, "PRIVATE_PROMPT", "running", now],
    );
    await store.event(session, message, "tool.started", {
      toolUseId: "t",
      name: "Bash",
      at: now,
      detail: "PRIVATE_COMMAND",
    });
    await store.event(session, null, "agent.finished", {
      agentId: "unknown",
      detail: "PRIVATE_UNKNOWN",
    });
    await store.event(session, message, "tool.finished", {
      toolUseId: "t",
      name: "Bash",
      at: now + 3,
      durationMs: 3,
      output: "PRIVATE_RESULT",
    });
    await store.transition(message, "succeeded", { text: "PRIVATE_ANSWER" });
    const headers = await tracer.prepare(randomUUID(), session, "owner");
    assert.match(headers!.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert(!JSON.stringify(headers).includes("owner"));
    await tracer.tick();
    const status = await tracer.status();
    assert(status.pending! > 0);
    assert.equal(status.lastError, "LANGFUSE_HTTP_503");
    const raw = JSON.stringify(batches);
    assert(!raw.includes("PRIVATE_"));
    assert(!raw.includes("fixture-secret"));
    assert(!raw.includes("unknown"));
    await tracer.close();
    // Same persistent schema, new service process: rows and cursor survive, spans retain IDs.
    mode = "ok";
    tracer = new TracingService(db.db, langfuseConfig(env), transport);
    await tracer.initialize();
    await db.db.execute(sql`UPDATE tracing_outbox SET "nextAttemptAt"=0`);
    await tracer.tick();
    assert.equal((await tracer.status()).pending, 0);
    const ids = (await db.pool.query("SELECT id FROM tracing_outbox")).rows.map(
      (r) => r.id,
    );
    await tracer.tick();
    assert.deepEqual(
      (await db.pool.query("SELECT id FROM tracing_outbox")).rows.map(
        (r) => r.id,
      ),
      ids,
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int n FROM tracing_outbox"))
        .rows[0].n,
      3,
    );
    const before = requests;
    const disabled = new TracingService(db.db, langfuseConfig({}), transport);
    await disabled.initialize();
    await disabled.tick();
    await disabled.close();
    assert.equal(
      requests,
      before,
      "removing configuration makes no delivery attempts",
    );
    const other = new TracingService(
      db.db,
      langfuseConfig({ ...env, AH_LANGFUSE_PUBLIC_KEY: "other-project" }),
      transport,
    );
    await other.initialize();
    await other.tick();
    await other.close();
    assert.equal(
      requests,
      before,
      "old target queue is not forwarded to a new project",
    );
    // Late event explicitly retains its original message, even after another turn exists.
    await store.event(session, message, "agent.finished", {
      agentId: "late",
      at: now + 30,
    });
    await tracer.tick();
    const spans = (
      await db.pool.query("SELECT span FROM tracing_outbox")
    ).rows.map((r) => r.span);
    const root = spans.find((s) => s.name === "harbor.task");
    const late = spans.find((s) => s.name === "agent.finished");
    assert.equal(root.status.code, 1);
    assert.equal(late.traceId, root.traceId);
    assert.equal(late.parentSpanId, root.spanId);
    assert.equal((await tracer.evidence("old-request")).status, "historical");
  } finally {
    await tracer.close();
    await db.close();
  }
});

test("tracing: network failures and partial rejection never acknowledge the durable batch", async () => {
  const db = await testDatabase();
  let mode = "partial";
  const send = (async (url: any) =>
    String(url).endsWith("/projects")
      ? Response.json({ data: [{ id: "test" }] })
      : mode === "partial"
        ? Response.json({ partialSuccess: { rejectedSpans: 1 } })
        : Promise.reject(Error("PRIVATE_EXCEPTION"))) as typeof fetch;
  const tracer = new TracingService(db.db, langfuseConfig(env), send);
  try {
    await tracer.initialize();
    await db.pool.query(
      'INSERT INTO tracing_outbox(destination,id,span,"createdAt") VALUES($1,$2,$3,$4)',
      [tracer.config.destination, "span", {}, Date.now()],
    );
    await tracer.tick();
    assert.equal(
      (await tracer.status()).lastError,
      "LANGFUSE_PARTIAL_REJECTION",
    );
    assert.equal(
      (await db.pool.query('SELECT "sentAt" FROM tracing_outbox')).rows[0]
        .sentAt,
      null,
    );
    mode = "network";
    await db.pool.query('UPDATE tracing_outbox SET "nextAttemptAt"=0');
    await tracer.tick();
    assert.equal((await tracer.status()).lastError, "LANGFUSE_UNREACHABLE");
    assert(
      !JSON.stringify(await tracer.status()).includes("PRIVATE_EXCEPTION"),
    );
  } finally {
    await tracer.close();
    await db.close();
  }
});

test("tracing replay: missing timestamps stay stable; expired request projections are not resurrected", async () => {
  const db = await testDatabase();
  const tracer = new TracingService(db.db, langfuseConfig(env), (async (
    url: any,
  ) =>
    String(url).endsWith("/projects")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({}, { status: 503 })) as typeof fetch);
  try {
    await new IdentityStore(db.db).ensure("owner");
    await tracer.initialize();
    const session = randomUUID(),
      message = randomUUID(),
      now = Date.now();
    await db.pool.query(
      'INSERT INTO sessions(id,"ownerId",title,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$4)',
      [session, "owner", "private", now],
    );
    await db.pool.query(
      'INSERT INTO messages(id,"sessionId","clientMessageId",text,status) VALUES($1,$2,$1,$3,$4)',
      [message, session, "private", "accepted"],
    );
    await new ServiceStore(db.db).event(
      session,
      message,
      "message.stopping",
      {},
    );
    await tracer.tick();
    const before = (await db.pool.query("SELECT span FROM tracing_outbox"))
      .rows[0].span;
    await db.pool.query('UPDATE tracing_cursors SET "eventId"=0');
    await tracer.tick();
    assert.deepEqual(
      (await db.pool.query("SELECT span FROM tracing_outbox")).rows[0].span,
      before,
    );
    const request = randomUUID(),
      old = now - 31 * 86400_000;
    await db.pool.query(
      'INSERT INTO wallet_requests(id,"userId","sessionId","deploymentId","versionId","priceVersionId","modelName",price,reserved,state,"createdAt","finishedAt","durationMs") VALUES($1,$2,$3,$4,$4,$4,$4,$5,0,$6,$7,$7,0)',
      [request, "owner", session, "fixture", {}, "settled", old],
    );
    await tracer.prepare(request, session, "owner");
    await db.pool.query(
      'UPDATE tracing_requests SET "createdAt"=$1 WHERE "requestId"=$2',
      [old, request],
    );
    await tracer.tick();
    assert.equal(
      (await db.pool.query("SELECT count(*)::int n FROM tracing_outbox"))
        .rows[0].n,
      1,
    );
  } finally {
    await tracer.close();
    await db.close();
  }
});

test("content opt-in projects a tool result and late artifact, with message-owned storage", async () => {
  const db = await testDatabase();
  const store = new ServiceStore(db.db);
  const config = langfuseConfig({
    ...env,
    AH_LANGFUSE_CONTENT_MODE: "redacted",
  });
  const tracer = new TracingService(db.db, config, (async (url) =>
    String(url).endsWith("/projects")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({})) as typeof fetch);
  try {
    assert.equal(langfuseConfig(env).contentMode, "metadata");
    assert.equal(
      langfuseConfig({ ...env, AH_LANGFUSE_CONTENT_MODE: "typo" }).state,
      "invalid",
    );
    await new IdentityStore(db.db).ensure("owner");
    const sessionId = randomUUID(),
      messageId = randomUUID(),
      runnerId = randomUUID();
    const appId = randomUUID(),
      revisionId = randomUUID(),
      now = Date.now();
    await tracer.initialize();
    await db.pool.query(
      'INSERT INTO sessions(id,"ownerId",title,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$4)',
      [sessionId, "owner", "fixture", now],
    );
    await db.pool.query(
      'INSERT INTO messages(id,"sessionId","clientMessageId",text,status,"startedAt") VALUES($1,$2,$1,$3,$4,$5)',
      [messageId, sessionId, "fixture", "running", now],
    );
    const payload = {
      name: "Bash",
      toolUseId: "call",
      outcome: "completed",
      durationMs: 10,
      at: now,
    };
    const event = {
      type: "tool.finished",
      runnerId,
      sessionId,
      attemptId: messageId,
      seq: 1,
      payload,
    };
    tracer.observeToolContent(sessionId, event, {
      input: { command: "echo synthetic fixture-secret" },
      output: { stdout: "synthetic output", exitCode: 0 },
    });
    await store.event(
      sessionId,
      messageId,
      event.type,
      payload,
      runnerId + ":1",
    );
    await store.transition(messageId, "succeeded");
    await tracer.tick();
    await db.pool.query(
      'INSERT INTO applications(id,"ownerId",title,"developmentSessionId","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$5)',
      [appId, "owner", "fixture", sessionId, now],
    );
    await db.pool.query(
      'INSERT INTO app_revisions(id,"appId",number,"sourceMessageId",source,manifest,summary,"createdAt") VALUES($1,$2,1,$3,$4,$4,$5,$6)',
      [revisionId, appId, messageId, "{}", "fixture", now],
    );
    await tracer.observeArtifact(revisionId, messageId);
    await tracer.tick();
    const spans = (
      await db.pool.query('SELECT span,"contentMessageId" FROM tracing_outbox')
    ).rows;
    const tool = spans.find((row) => row.span.name === "tool.finished");
    const artifact = spans.find((row) => row.span.name === "harbor.artifact");
    const task = spans.find((row) => row.span.name === "harbor.task");
    assert(tool && artifact && task);
    assert.equal(artifact.span.parentSpanId, task.span.spanId);
    assert.equal(tool.contentMessageId, messageId);
    assert(JSON.stringify(tool.span).includes("synthetic output"));
    assert(JSON.stringify(tool.span).includes("exitCode"));
    assert(!JSON.stringify(spans).includes("fixture-secret"));
    assert(JSON.stringify(task.span).includes("unrecorded"));
    assert(JSON.stringify(artifact.span).includes(revisionId));
    // Replaying the public cursor after a crash must preserve the durable content.
    await db.pool.query("DELETE FROM tracing_cursors");
    await tracer.tick();
    const replayed = (
      await db.pool.query("SELECT span FROM tracing_outbox WHERE id=$1", [
        tool.span.spanId,
      ])
    ).rows[0];
    assert(JSON.stringify(replayed.span).includes("synthetic output"));
    await db.pool.query("DELETE FROM messages WHERE id=$1", [messageId]);
    assert.equal(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM tracing_outbox WHERE "contentMessageId"=$1',
          [messageId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await tracer.close();
    await db.close();
  }
});
