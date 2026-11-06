/** Isolated experiment for the proposed queue. Probe-only columns live in a temporary schema. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import express from "express";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { testDatabase, testDatabaseUrl } from "../dist/tests/pg.js";
import { openDatabase } from "../dist/src/service/db/client.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { IdentityStore } from "../dist/src/service/identity/store.js";
import { createInferenceRouter } from "../dist/src/service/wallet/proxy.js";
import { WalletService } from "../dist/src/service/wallet/service.js";
import { DockerBackend } from "../dist/src/docker/docker.js";
import { lockSession } from "../dist/src/runtime/storage.js";

const price = { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 };
const model = { deploymentId: "fixture-model", versionId: "fixture-version", priceVersionId: "fixture-price", name: "Fixture", price };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const url = new URL(testDatabaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/harbor_queue_probe");

function claim(pool, sessionId, owner) {
  return pool.query(`
    WITH candidate AS (
      SELECT id FROM messages
      WHERE "sessionId"=$1 AND status='accepted' AND "cancelRequested"=0
        AND (probe_until IS NULL OR probe_until <= clock_timestamp())
      ORDER BY "createdEventId" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE messages AS m SET probe_owner=$2, probe_generation=probe_generation+1,
      probe_until=clock_timestamp()+interval '5 minutes'
    FROM candidate WHERE m.id=candidate.id
    RETURNING m.id, m.probe_generation AS generation`, [sessionId, owner]);
}

function permitDispatch(pool, id, generation) {
  return pool.query(`
    UPDATE messages SET status='running', probe_dispatched=clock_timestamp()
    WHERE id=$1 AND probe_generation=$2 AND status='accepted'
      AND probe_until > clock_timestamp() AND "cancelRequested"=0 AND probe_dispatched IS NULL
    RETURNING id`, [id, generation]);
}

async function modelSend(database, args) {
  // Unique logical call key. In this conservative probe the send intent is committed first.
  const gate = await database.pool.query(`
    WITH active_claim AS (
      SELECT id FROM messages WHERE id=$2 AND probe_generation=$3
        AND probe_until > clock_timestamp() AND status='running' AND "cancelRequested"=0
      FOR UPDATE
    )
    INSERT INTO probe_calls (id, message_id) SELECT $1, id FROM active_claim
    ON CONFLICT (id) DO NOTHING RETURNING id`, [args.callId, args.messageId, args.generation]);
  if (!gate.rowCount) return false;
  const wallet = new WalletService(database.db);
  const request = await wallet.reserve(args.userId, args.sessionId, model, 1000);
  await database.pool.query("UPDATE probe_calls SET wallet_id=$2 WHERE id=$1", [args.callId, request.id]);
  // The only model endpoint allowed by the probe is its loopback fixture.
  assert.equal(new URL(args.upstream).hostname, "127.0.0.1");
  const response = await fetch(args.upstream, { method: "POST", body: args.callId, signal: AbortSignal.timeout(8000) });
  assert(response.ok);
  await response.text();
  await wallet.settle(request.id, usage);
  return true;
}

async function childMain(args) {
  const childUrl = new URL(url);
  childUrl.searchParams.set("options", "-c search_path=" + args.schema);
  const database = openDatabase(childUrl.href);
  try {
    if (args.mode === "accept") {
      const accepted = await new ServiceStore(database.db).accept(args.sessionId, args.clientId, args.text);
      process.send(accepted.message.id);
      // Keep the process alive so the parent can SIGKILL after commit and before work starts.
      await once(process, "disconnect");
    } else {
      process.send("starting");
      await modelSend(database, args);
    }
  } finally { await database.close(); }
}

async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for fault injection checkpoint");
}

async function run() {
  const database = await testDatabase();
  const { db, pool, schema } = database;
  const store = new ServiceStore(db);
  const wallet = new WalletService(db);
  const userId = "queue-probe-user";
  const root = await mkdtemp(join(tmpdir(), "harbor-queue-writer-"));
  const backend = new DockerBackend(root);
  const writerIds = new Set();
  const children = new Set();
  const upstreamHits = new Map();
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const id = request.url === "/v1/messages" ? "existing-proxy" : Buffer.concat(chunks).toString();
    upstreamHits.set(id, (upstreamHits.get(id) ?? 0) + 1);
    if (id === "lost-response") return; // Simulate an upstream receipt never reaching the caller.
    if (id === "existing-proxy") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }));
    } else {
      response.end("fixture");
    }
  });
  let proxy;
  const startChild = async (args) => {
    const child = fork(fileURLToPath(import.meta.url), ["child"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const exit = once(child, "exit");
    children.add(child);
    const first = Promise.race([once(child, "message").then(([value]) => value), exit.then(() => { throw new Error("Probe child exited before checkpoint"); })]);
    child.send({ ...args, schema });
    const checkpoint = await first;
    return { checkpoint, async crash() { child.kill("SIGKILL"); assert.equal((await exit)[1], "SIGKILL"); children.delete(child); } };
  };
  try {
    await new IdentityStore(db).ensure(userId);
    await pool.query(`
      ALTER TABLE messages ADD COLUMN probe_owner text, ADD COLUMN probe_generation integer NOT NULL DEFAULT 0,
        ADD COLUMN probe_until timestamptz, ADD COLUMN probe_dispatched timestamptz;
      CREATE TABLE probe_calls (id text PRIMARY KEY, message_id text NOT NULL, wallet_id text)`);
    const session = await store.create(userId, "Queue probe");
    const clientId = randomUUID();
    const committed = await startChild({ mode: "accept", sessionId: session.id, clientId, text: "write an artifact" });
    await committed.crash();
    const replay = await store.accept(session.id, clientId, "write an artifact");
    assert.equal(replay.message.id, committed.checkpoint);
    assert.equal(replay.duplicate, true);
    assert.equal((await store.events(session.id, 0)).filter(e => e.type === "message.accepted").length, 1);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(pool, session.id, "worker-" + i)));
    assert.equal(claims.reduce((sum, result) => sum + result.rowCount, 0), 1);
    const job = claims.flatMap(result => result.rows)[0];
    assert.equal(job.id, replay.message.id);
    console.log("PASS committed accept survived SIGKILL, same request recovered, 8 competing claimers got 1 job");

    const cancelSession = await store.create(userId, "Cancel probe");
    const cancelled = (await store.accept(cancelSession.id, randomUUID(), "cancel before dispatch")).message;
    const [cancelClaim] = (await claim(pool, cancelSession.id, "cancel-worker")).rows;
    await store.requestCancel(cancelled.id);
    await store.requestCancel(cancelled.id);
    assert.equal((await permitDispatch(pool, cancelled.id, cancelClaim.generation)).rowCount, 0);
    assert.equal((await store.events(cancelSession.id, 0)).filter(e => e.type === "message.stopping").length, 1);
    await store.transition(cancelled.id, "cancelled");
    console.log("PASS cancel after claim but before dispatch prevented dispatch; repeat did not add a stop event");

    const marker = join(root, "writer.log");
    const contents = () => readFile(marker, "utf8").catch(() => "");
    const image = process.env.AH_QUEUE_PROBE_IMAGE ?? "postgres:18-alpine";
    const writer = await backend.command([
      "run", "--pull=never", "--detach", "--network=none", "--label", "io.agent-harbor.project=agent-harbor",
      "--label", "harbor.owner=" + backend.owner, "--label", "harbor.session=" + session.id,
      "--mount", "type=bind,src=" + root + ",dst=/probe", "--user", String(process.getuid()) + ":" + String(process.getgid()),
      "--entrypoint", "/bin/sh", image, "-c", "while true; do printf 'old\n' >> /probe/writer.log; sleep 0.08; done"
    ]);
    writerIds.add(writer);
    await waitFor(async () => (await contents()).includes("old"));
    await pool.query("UPDATE messages SET probe_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    const [newClaim] = (await claim(pool, session.id, "successor")).rows;
    assert.equal(newClaim.generation, job.generation + 1);
    assert.equal((await permitDispatch(pool, job.id, job.generation)).rowCount, 0);
    const expiredContents = await contents();
    await waitFor(async () => (await contents()).length > expiredContents.length);
    const release = await lockSession(root);
    try {
      await assert.rejects(lockSession(root));
      const confirmAndDispatch = async () => {
        for (const id of await backend.forSession(session.id)) {
          await backend.stop(id);
          await backend.destroy(id);
        }
        return permitDispatch(pool, job.id, newClaim.generation);
      };
      const ids = await backend.forSession(session.id);
      assert.deepEqual(ids.map(id => id.slice(0, 12)), [writer.slice(0, 12)]);
      const realCommand = backend.command.bind(backend);
      backend.command = args => args[0] === "inspect" ? Promise.reject(new Error("injected engine unavailable")) : realCommand(args);
      await assert.rejects(confirmAndDispatch(), /engine unavailable/);
      backend.command = realCommand;
      assert.equal((await store.message(job.id)).status, "accepted");
      assert((await backend.inspect(writer)).running);
      assert.equal((await confirmAndDispatch()).rowCount, 1);
      assert.equal(await backend.inspect(writer), undefined);
      writerIds.delete(writer);
      const stoppedContents = await contents();
      await delay(300);
      assert.equal(await contents(), stoppedContents);
      assert.deepEqual(await backend.forSession(session.id), []);
    } finally { await release(); }
    console.log("PASS stale SQL generation rejected, lease alone left real Docker writer alive, confirmed stop removed writer before dispatch");

    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const call = { userId, sessionId: session.id, messageId: job.id, generation: newClaim.generation,
      upstream: "http://127.0.0.1:" + upstream.address().port };
    const lost = await startChild({ ...call, mode: "send", callId: "lost-response" });
    await waitFor(() => upstreamHits.has("lost-response"));
    await lost.crash();
    await wallet.recover();
    assert.equal(await modelSend(database, { ...call, callId: "lost-response" }), false);
    assert.equal(upstreamHits.get("lost-response"), 1);
    const lostRequest = (await wallet.summary(userId)).requests[0];
    assert.equal(lostRequest.state, "unknown");
    assert.equal(lostRequest.charged, null);
    assert.equal((await wallet.summary(userId)).ledger.filter(row => row.kind === "usage").length, 0);
    await pool.query("UPDATE messages SET probe_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    assert.equal((await claim(pool, session.id, "restart")).rowCount, 0);
    assert.equal(await modelSend(database, { ...call, callId: "stale-generation-call" }), false);
    assert.equal(upstreamHits.has("stale-generation-call"), false);
    console.log("PASS fake upstream saw 1 call before SIGKILL; redispatch refused, hold unknown, 0 debit");

    const nextSession = await store.create(userId, "Settlement probe");
    const next = (await store.accept(nextSession.id, randomUUID(), "legitimate new round")).message;
    const [nextClaim] = (await claim(pool, nextSession.id, "billing-worker")).rows;
    assert.equal((await permitDispatch(pool, next.id, nextClaim.generation)).rowCount, 1);
    const validCall = { ...call, sessionId: nextSession.id, messageId: next.id, generation: nextClaim.generation, callId: "known-usage" };
    const results = await Promise.all([modelSend(database, validCall), modelSend(database, validCall)]);
    assert.equal(results.filter(Boolean).length, 1);
    const { wallet_id } = (await pool.query("SELECT wallet_id FROM probe_calls WHERE id=$1", [validCall.callId])).rows[0];
    await Promise.all([wallet.settle(wallet_id, usage), wallet.settle(wallet_id, usage)]);
    const usageLedger = (await wallet.summary(userId)).ledger.filter(row => row.kind === "usage");
    assert.equal(upstreamHits.get("known-usage"), 1);
    assert.equal(usageLedger.length, 1);
    assert.equal(usageLedger[0].amount, -20);
    console.log("PASS duplicate call contenders: 1 upstream send; repeated receipts: 1 debit of 20 test units");

    // Establish the gap in the current production inference route with the same fake upstream.
    const baselineUser = "queue-proxy-baseline";
    await new IdentityStore(db).ensure(baselineUser);
    const baselineSession = await store.create(baselineUser, "Existing inference route");
    const app = express();
    app.use(createInferenceRouter({
      settings: { managementUrl: call.upstream },
      walletConnection: async () => ({
        binding: { ownerId: baselineUser, sessionId: baselineSession.id },
        deployment: { id: model.deploymentId, name: model.name },
        version: { id: model.versionId, routeName: "fixture-upstream" },
        price: { ...price, id: model.priceVersionId },
        upstreamToken: "fixture-only", logicalModel: "fixture-logical"
      })
    }, wallet));
    proxy = app.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const sendSame = () => fetch("http://127.0.0.1:" + proxy.address().port + "/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-only" },
      body: JSON.stringify({ model: "fixture-logical", messages: [{ role: "user", content: "same HTTP request" }] })
    });
    for (let i = 0; i < 2; i++) {
      const response = await sendSame();
      assert.equal(response.status, 200, await response.clone().text());
      await response.text();
    }
    assert.equal(upstreamHits.get("existing-proxy"), 2);
    assert.equal((await wallet.summary(baselineUser)).ledger.filter(row => row.kind === "usage").length, 2);
    console.log("BASELINE current inference route forwarded 2 identical POSTs and made 2 debits; no stable call key yet");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    proxy?.closeAllConnections();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    for (const id of writerIds) await backend.command(["rm", "-f", id]).catch(error => console.error("Probe writer cleanup failed", error.message));
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "child") {
  process.once("message", args => { void childMain(args).catch(error => { console.error(error); process.exit(1); }); });
} else {
  await run();
}
