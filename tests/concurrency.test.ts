/** PG异步交错回归：真实数据库负责状态，受控执行器让任务停在指定位置，不调用模型。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { uniqueViolation } from "../src/service/db/client.js";
import { defaultLimits } from "../src/service/limits/policy.js";
import { ServiceError } from "../src/service/types.js";
import type { Session } from "../src/shared/types.js";
import { testDatabase } from "./pg.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function wait(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(10); }
  throw new Error("Fixture did not reach expected state");
}
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
async function fixture(capacity = 4, idleMs = 60_000) {
  const database = await testDatabase(), store = new ServiceStore(database.db);
  const runs = new Map<string, { finish(): void; signal?: AbortSignal }>();
  const controller = { async open(sessionId: string) {
    let finish: (() => void) | undefined;
    return {
      async run(_text: string, _event?: unknown, signal?: AbortSignal, input?: { attemptId?: string }): Promise<Session> {
        const done = gate(); finish = done.release;
        runs.set(input!.attemptId!, { finish, signal });
        if (signal?.aborted) done.release(); else signal?.addEventListener("abort", done.release, { once: true });
        await done.promise;
        signal?.removeEventListener("abort", done.release);
        return { sessionId, generation: 1, status: signal?.aborted ? "cancelled" : "succeeded", environment: "ready", stopped: false };
      },
      async terminate() { finish?.(); }, async close() {},
    };
  } };
  const manager = new SessionManager(store, controller, "fixture-only", idleMs, capacity);
  await manager.identity.ensure("a"); await manager.identity.ensure("b");
  return { database, store, manager, runs,
    async running(id: string) { await wait(async () => runs.has(id)); },
    async close() { await manager.shutdown(); await database.close(); },
  };
}

test("Drizzle unique conflicts remain business conflicts and do not disable the service", async () => {
  const f = await fixture();
  try {
    await f.store.create("a", "first", "same-session");
    await assert.rejects(f.store.create("a", "duplicate", "same-session"), error => {
      assert.equal(uniqueViolation(error), "sessions_pkey"); return true;
    });
    assert.equal(f.manager.ready, true);
    await f.manager.create("a", "still writable");
  } finally { await f.close(); }
});

test("simultaneous retries return one message; a reused ID with another body is rejected", async () => {
  const f = await fixture();
  try {
    const session = await f.manager.create("a", "retry"), key = randomUUID();
    const pair = await Promise.all([
      f.manager.submit("a", session.id, key, "same"), f.manager.submit("a", session.id, key, "same"),
    ]);
    assert.equal(pair[0].message.id, pair[1].message.id);
    assert.equal(pair.filter(result => !result.duplicate).length, 1);
    // Test the transaction itself too: manager-level serialization must not hide its contract.
    const [old, again] = await Promise.all([f.store.accept(session.id, key, "same"), f.store.accept(session.id, key, "same")]);
    assert.equal(old.message.id, again.message.id); assert.equal(again.duplicate, true);
    await assert.rejects(f.store.accept(session.id, key, "different"), code("MESSAGE_ID_CONFLICT"));
    assert.equal((await f.store.messages(session.id)).length, 1);
  } finally { await f.close(); }
});

test("concurrent sessions cannot exceed the user's task limit", async () => {
  const f = await fixture();
  try {
    const a = await f.manager.create("a", "one"), b = await f.manager.create("a", "two");
    const results = await Promise.allSettled([
      f.manager.submit("a", a.id, randomUUID(), "one"), f.manager.submit("a", b.id, randomUUID(), "two"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.some(result => result.status === "rejected" && code("TASK_LIMIT")(result.reason)));
    assert.equal((await f.manager.counts("a")).tasks, 1);
  } finally { await f.close(); }
});

test("global capacity applies across users, and failed admission leaves the next request usable", async () => {
  const f = await fixture(1);
  try {
    const a = await f.manager.create("a", "one"), b = await f.manager.create("b", "two");
    const results = await Promise.allSettled([
      f.manager.submit("a", a.id, randomUUID(), "one"), f.manager.submit("b", b.id, randomUUID(), "two"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.some(result => result.status === "rejected" && code("CAPACITY_REACHED")(result.reason)));
    const winner = results.find(result => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing winner");
    const owner = winner.value.message.sessionId === a.id ? "a" : "b";
    await f.manager.cancel(owner, winner.value.message.sessionId, winner.value.message.id);
    await wait(async () => (await f.store.message(winner.value.message.id))!.status === "cancelled");
    await f.manager.close(owner, winner.value.message.sessionId, winner.value.message.id);
    await wait(async () => (await f.store.session(winner.value.message.sessionId))!.environment === "closed");
    const loser = owner === "a" ? b : a;
    await f.manager.submit(owner === "a" ? "b" : "a", loser.id, randomUUID(), "after release");
  } finally { await f.close(); }
});

test("concurrent sessions cannot exceed the user's environment limit", async () => {
  const f = await fixture();
  try {
    await f.manager.identity.update("a", { limits: { ...defaultLimits, tasks: 3, environments: 1 } });
    const a = await f.manager.create("a", "one"), b = await f.manager.create("a", "two");
    const results = await Promise.allSettled([
      f.manager.submit("a", a.id, randomUUID(), "one"), f.manager.submit("a", b.id, randomUUID(), "two"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.some(result => result.status === "rejected" && code("ENVIRONMENT_LIMIT")(result.reason)));
  } finally { await f.close(); }
});

test("session creation reserves quota during preparation, including competing direct creates", async () => {
  const f = await fixture(), started = gate(), prepared = gate(); let first: Promise<unknown> | undefined;
  try {
    await f.manager.identity.update("a", { limits: { ...defaultLimits, sessions: 1 } });
    first = f.manager.createPrepared("a", "one", randomUUID(), async () => { started.release(); await prepared.promise; });
    await started.promise;
    await assert.rejects(f.manager.create("a", "other"), code("SESSION_LIMIT"));
    await assert.rejects(f.manager.createPrepared("a", "other", randomUUID(), async () => {}), code("SESSION_LIMIT"));
    prepared.release(); await first;
    assert.equal((await f.manager.counts("a")).sessions, 1);
  } finally { prepared.release(); await first?.catch(() => {}); await f.close(); }
});

test("simultaneous direct creates respect session quota", async () => {
  const f = await fixture();
  try {
    await f.manager.identity.update("a", { limits: { ...defaultLimits, sessions: 1 } });
    const results = await Promise.allSettled([f.manager.create("a", "one"), f.manager.create("a", "two")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.some(result => result.status === "rejected" && code("SESSION_LIMIT")(result.reason)));
  } finally { await f.close(); }
});

test("an upload cannot enter while task acceptance waits for a real PostgreSQL row lock", async () => {
  const f = await fixture(), locker = await f.database.pool.connect(), uploadDone = gate();
  let submit: ReturnType<SessionManager["submit"]> | undefined, upload: Promise<unknown> | undefined;
  try {
    const session = await f.manager.create("a", "lock race");
    await locker.query("BEGIN");
    await locker.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [session.id]);
    submit = f.manager.submit("a", session.id, randomUUID(), "task");
    await wait(async () => (await f.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%for update%' AND state='active'")).rowCount! > 0);
    let entered = false;
    upload = f.manager.withFileWrite("a", session.id, async () => { entered = true; await uploadDone.promise; });
    // Attach the rejection observer before unblocking acceptance.
    const rejected = assert.rejects(upload, code("SESSION_BUSY"));
    await sleep(20); assert.equal(entered, false);
    await locker.query("COMMIT"); await submit; await rejected;
    assert.equal(entered, false);
  } finally {
    await locker.query("ROLLBACK"); locker.release(); uploadDone.release();
    await submit?.catch(() => {}); await upload?.catch(() => {}); await f.close();
  }
});

test("a delayed cancel never aborts the next turn or appends stopping to a finished message", async () => {
  const f = await fixture(), entered = gate(), resume = gate(); let cancellation: ReturnType<SessionManager["cancel"]> | undefined;
  try {
    const session = await f.manager.create("a", "cancel race");
    const first = await f.manager.submit("a", session.id, randomUUID(), "first"); await f.running(first.message.id);
    const requestCancel = f.store.requestCancel.bind(f.store);
    f.store.requestCancel = async id => { entered.release(); await resume.promise; return requestCancel(id); };
    cancellation = f.manager.cancel("a", session.id, first.message.id); await entered.promise;
    f.runs.get(first.message.id)!.finish();
    await wait(async () => (await f.store.message(first.message.id))!.status === "succeeded");
    const second = await f.manager.submit("a", session.id, randomUUID(), "second"); await f.running(second.message.id);
    resume.release(); const result = await cancellation;
    assert.equal(result.terminal, true);
    assert.equal(f.runs.get(second.message.id)!.signal!.aborted, false);
    assert.equal((await f.store.message(second.message.id))!.cancelRequested, 0);
    assert.equal((await f.store.events(session.id, 0)).filter(event => event.messageId === first.message.id && event.type === "message.stopping").length, 0);
  } finally { resume.release(); await cancellation?.catch(() => {}); await f.close(); }
});

test("a failed preparation releases its reservation and a long upload does not block another session", async () => {
  const f = await fixture(), started = gate(), done = gate(); let upload: Promise<unknown> | undefined;
  try {
    await f.manager.identity.update("a", { limits: { ...defaultLimits, sessions: 1 } });
    await assert.rejects(f.manager.createPrepared("a", "failed", randomUUID(), async () => { throw new Error("prepare failed"); }), /prepare failed/);
    const a = await f.manager.create("a", "upload"), b = await f.manager.create("b", "task");
    upload = f.manager.withFileWrite("a", a.id, async () => { started.release(); await done.promise; });
    await started.promise;
    await assert.rejects(f.manager.submit("a", a.id, randomUUID(), "blocked"), code("FILE_TRANSFER_BUSY"));
    const other = await f.manager.submit("b", b.id, randomUUID(), "independent");
    await f.running(other.message.id);
    assert.equal(f.runs.get(other.message.id)!.signal!.aborted, false);
    done.release(); await upload;
  } finally { done.release(); await upload?.catch(() => {}); await f.close(); }
});

test("an idle timeout queued behind acceptance cannot close the newly accepted task", async () => {
  const f = await fixture(4, 100), locker = await f.database.pool.connect();
  let second: ReturnType<SessionManager["submit"]> | undefined;
  try {
    const session = await f.manager.create("a", "idle race");
    const first = await f.manager.submit("a", session.id, randomUUID(), "first"); await f.running(first.message.id);
    f.runs.get(first.message.id)!.finish();
    await wait(async () => (await f.store.message(first.message.id))!.status === "succeeded");
    await locker.query("BEGIN"); await locker.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [session.id]);
    second = f.manager.submit("a", session.id, randomUUID(), "second");
    await wait(async () => (await f.database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%for update%' AND state='active'")).rowCount! > 0);
    await sleep(150); // Expire the old idle timer while admission owns the short lock.
    await locker.query("COMMIT"); const accepted = await second; await f.running(accepted.message.id);
    await sleep(20);
    assert.equal(f.runs.get(accepted.message.id)!.signal!.aborted, false);
  } finally { await locker.query("ROLLBACK"); locker.release(); await second?.catch(() => {}); await f.close(); }
});

test("legacy monthly message limits no longer restrict accepted messages", async () => {
  const f = await fixture();
  try {
    await f.manager.identity.update("a", { limits: { ...defaultLimits, monthlyMessages: 0 } });
    const one = await f.manager.create("a", "one"), two = await f.manager.create("a", "two");
    const results = await Promise.all([f.store.accept(one.id, "one", "one"), f.store.accept(two.id, "two", "two")]);
    assert.equal(results.length, 2);
  } finally { await f.close(); }
});
