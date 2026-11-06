/** 服务契约测试：真实HTTP/SSE/PostgreSQL，受控执行器单独验证服务状态与连接生命周期。 */
import { test } from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Controller, type ConversationOptions } from "../src/runtime/controller.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { Auth, tokenHash } from "../src/service/auth.js";
import { createApi } from "../src/service/http-api.js";
import { ServiceClient, ApiError } from "../src/clients/service-client.js";
import { recover } from "../src/service/recovery.js";
import { lockSession } from "../src/runtime/storage.js";
import { testDatabase } from "./pg.js";
import type { Session } from "../src/shared/types.js";

async function fixture(idleMs = 1000, capacity = 4) {
  const root = await mkdtemp(join(tmpdir(), "ah-service-"));
  const database = await testDatabase();
  const store = new ServiceStore(database.db);
  const real = new Controller(root);
  let runs = 0, opens = 0, closes = 0;
  const gates = new Map<string, () => void>();
  const received: string[] = [];
  const runtimeOptions: ConversationOptions[] = [];
  let openHold: Promise<void> | undefined;
  const controller = {
    async open(id: string, _token: string, options: ConversationOptions = {}) {
      opens++; runtimeOptions.push(options);
      const hold = openHold; if (hold) await hold;
      let active: (() => void) | undefined;
      return {
        async run(text: string, _event?: unknown, signal?: AbortSignal, input?: { attemptId?: string }): Promise<Session> {
          runs++; received.push(text);
          const attemptId = input!.attemptId!;
          const done = new Promise<void>(resolve => { active = resolve; gates.set(attemptId, resolve); });
          const cancel = () => active?.();
          signal?.addEventListener("abort", cancel, { once: true });
          await options.onRuntimeNotice?.({ type: "runner.event", event: { sessionId: id, runnerId: id, seq: runs, type: "assistant.text.delta", attemptId, generation: runs, payload: { text: "第一行\n第二行" } } });
          if (!signal?.aborted) await done;
          signal?.removeEventListener("abort", cancel);
          const result: Session = { sessionId: id, generation: runs, status: signal?.aborted ? "cancelled" : "succeeded", environment: "ready", stopped: false };
          await options.onRuntimeNotice?.({ type: "environment.changed", session: result });
          return result;
        },
        async terminate() { active?.(); },
        async close() { closes++; },
      };
    },
  };
  const manager = new SessionManager(store, controller, "fixture-only", idleMs, capacity);
  const auth = new Auth([{ userId: "a", tokenHash: tokenHash("a-test-key") }, { userId: "b", tokenHash: tokenHash("b-test-key") }]);
  await manager.identity.adoptSessionOwners();
  await manager.identity.importKeys(auth.keys);
  const server = createApi(manager, real);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const a = new ServiceClient(url, "a-test-key"), b = new ServiceClient(url, "b-test-key");
  return { root, store, database, manager, a, b, real, url, gates, received, runtimeOptions, counts: () => ({ runs, opens, closes }),
    liveSize: () => (manager as unknown as { live: Map<string, unknown> }).live.size,
    holdOpen() { let release!: () => void; openHold = new Promise<void>(resolve => { release = resolve; }); return () => { openHold = undefined; release(); }; },
    async clean() { await manager.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await database.close(); await rm(root, { recursive: true, force: true }); },
  };
}
async function wait(check: () => unknown | Promise<unknown>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await sleep(10); }
  throw new Error("Timed out");
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("HTTP ownership covers list, history, events, cancel and close; template and input boundaries", async () => {
  const f = await fixture();
  try {
    const session = await f.a.request<{ id: string }>("/sessions", "POST", { title: "sample", template: "fix-project", ownerId: "b" });
    assert.match(await readFile(join(f.root, session.id, "workspace/sum.js"), "utf8"), /sum/);
    assert.deepEqual(await f.b.request("/sessions"), []);
    for (const [path, method, body] of [
      [`/sessions/${session.id}`, "GET", undefined],
      [`/sessions/${session.id}/messages`, "GET", undefined],
      [`/sessions/${session.id}/events`, "GET", undefined],
      [`/sessions/${session.id}/messages`, "POST", { clientMessageId: randomUUID(), text: "attack" }],
      [`/sessions/${session.id}/messages/${randomUUID()}/cancel`, "POST", undefined],
      [`/sessions/${session.id}/close`, "POST", { expectedMessageId: null }],
    ] as const) await assert.rejects(f.b.request(path, method, body), code("SESSION_NOT_FOUND"));
    await assert.rejects(new ServiceClient(f.url, "bad").request("/sessions"), code("UNAUTHORIZED"));
    await assert.rejects(f.a.request(`/sessions/${session.id}/events?after=1`), code("CURSOR_AHEAD"));
    await assert.rejects(f.a.request(`/sessions/${session.id}/messages`, "POST", { clientMessageId: randomUUID(), text: "x".repeat(270_000) }), code("BODY_TOO_LARGE"));
    await assert.rejects(f.a.request(`/sessions/${session.id}/close`, "POST", {}), code("EXPECTED_MESSAGE_REQUIRED"));
  } finally { await f.clean(); }
});

test("accepted is durable, retries deduplicate before busy, multiline and disconnect preserve execution; SSE resumes", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const session = await f.manager.create("a", "one");
    const requestId = randomUUID();
    const first = await f.a.send(session.id, requestId, "保留\n  缩进\n");
    const again = await f.a.send(session.id, requestId, "保留\n  缩进\n");
    assert.equal(first.message.id, again.message.id);
    await assert.rejects(f.a.send(session.id, requestId, "changed"), code("MESSAGE_ID_CONFLICT"));
    await assert.rejects(f.a.send(session.id, randomUUID(), "second"), code("SESSION_BUSY"));
    await wait(() => f.counts().runs === 1);
    assert.deepEqual(f.received, ["保留\n  缩进\n"]);
    const iterator = f.a.events(session.id, 0, abort.signal);
    const event = (await iterator.next()).value!;
    abort.abort(); await iterator.return(undefined);
    assert.equal((await f.store.message(first.message.id))!.status, "running");
    f.gates.get(first.message.id)!();
    await wait(async () => (await f.store.message(first.message.id))!.status === "succeeded");
    const reconnect = new AbortController();
    const ids: number[] = [];
    let output = "";
    try {
      for await (const next of f.a.events(session.id, event.id, reconnect.signal)) {
        ids.push(next.id);
        if (next.type === "assistant.text.delta") output += next.data.text;
        if (next.type === "message.finished") break;
      }
    } finally { reconnect.abort(); }
    assert.equal(output, "第一行\n第二行");
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => id > event.id));
    assert.equal(f.counts().runs, 1);
  } finally { abort.abort(); await f.clean(); }
});

test("cancel targets one message, preserves live conversation, stale cancel/close never affects a later turn", async () => {
  const f = await fixture();
  try {
    const session = await f.manager.create("a", "one");
    const first = (await f.a.send(session.id, randomUUID(), "first")).message;
    await wait(() => f.counts().runs === 1);
    await f.a.cancel(session.id, first.id);
    await wait(async () => (await f.store.message(first.id))!.status === "cancelled");
    assert.equal((await f.store.session(session.id))!.environment, "ready");
    const second = (await f.a.send(session.id, randomUUID(), "second")).message;
    await wait(() => f.counts().runs === 2);
    await f.a.cancel(session.id, first.id);
    assert.equal((await f.store.message(second.id))!.cancelRequested, 0);
    await assert.rejects(f.a.close(session.id, first.id), code("STALE_CLOSE"));
    await f.a.close(session.id, second.id);
    await wait(async () => (await f.store.session(session.id))!.environment === "closed");
    assert.equal(f.counts().opens, 1);
    assert.equal(f.counts().closes, 1);
  } finally { await f.clean(); }
});

test("cancel while the environment is starting prevents the model run; capacity releases after idle cleanup", async () => {
  const f = await fixture(40, 1);
  try {
    const one = await f.manager.create("a", "one"), two = await f.manager.create("a", "two");
    // 卡住open，确定性地把cancel放在“已接收、尚未调用模型”之间。
    const release = f.holdOpen();
    const { message } = await f.manager.submit("a", one.id, randomUUID(), "never submitted");
    await wait(() => f.counts().opens === 1);
    await assert.rejects(f.manager.submit("a", two.id, randomUUID(), "capacity"), /CAPACITY_REACHED/);
    await f.manager.cancel("a", one.id, message.id);
    release();
    await wait(async () => (await f.store.message(message.id))!.status === "cancelled");
    assert.equal(f.counts().runs, 0);
    await wait(async () => (await f.store.session(one.id))!.environment === "closed" && f.liveSize() === 0);
    assert.equal(f.counts().closes, 1);
    const second = (await f.manager.submit("a", two.id, randomUUID(), "after reclaim")).message;
    await wait(() => f.counts().runs === 1);
    f.gates.get(second.id)!();
    await wait(async () => (await f.store.message(second.id))!.status === "succeeded");
    await wait(async () => (await f.store.session(two.id))!.environment === "closed");
    assert.equal(f.counts().closes, 2);
  } finally { await f.clean(); }
});

test("restart restores event cursor, marks interrupted after cleanup, never auto-replays; live lock blocks recovery", async () => {
  const f = await fixture();
  try {
    const session = await f.manager.create("a", "one");
    const { message } = await f.store.accept(session.id, randomUUID(), "unfinished");
    const before = (await f.store.session(session.id))!.lastEventId;
    f.real.backend.ownedSessions = async () => [];
    f.real.backend.forSession = async () => [];
    await mkdir(join(f.root,"users"),{recursive:true});
    await mkdir(join(f.root,"mcp-scripts/admin"),{recursive:true});
    const attempt=randomUUID(), startup=join(f.real.store.directory(session.id),"attempts",attempt);
    await mkdir(startup,{recursive:true});
    await writeFile(join(startup,"mcp-"+randomUUID()+".json"),"FIXTURE_SECRET");
    await f.real.store.save({sessionId:session.id,generation:1,runnerId:attempt});
    assert.equal(await recover(f.store, f.real), true);
    assert.equal(await access(join(f.root,"users","session.json")).then(()=>true,()=>false),false);
    assert.equal(await access(join(f.root,"mcp-scripts","workspace")).then(()=>true,()=>false),false);
    const {readdir}=await import("node:fs/promises");
    assert.equal(await readFile(join(startup,(await readdir(startup))[0]),"utf8"),"{}");
    assert.equal((await f.store.message(message.id))!.status, "interrupted");
    assert.ok((await f.store.session(session.id))!.lastEventId > before);
    assert.equal(f.counts().runs, 0);
    const release = await lockSession(f.real.store.directory(session.id));
    try { await assert.rejects(recover(f.store, f.real), /DATA_DIR_IN_USE/); }
    finally { await release(); }
    f.real.backend.forSession = async () => ["owned-container"];
    f.real.backend.stop = async () => { throw new Error("fixture engine unreachable"); };
    assert.equal(await recover(f.store, f.real), false);
    assert.equal((await f.store.session(session.id))!.environment, "reconciling");
  } finally { await f.clean(); }
});

test("database write failure stops accepting, terminates execution and does not fabricate success", async () => {
  const f = await fixture();
  try {
    const session = await f.manager.create("a", "one");
    const message = (await f.a.send(session.id, randomUUID(), "write failure")).message;
    await wait(() => f.counts().runs === 1);
    // 与磁盘故障等价的写入失败：让events表暂时不可写，不改用户数据。
    await f.database.pool.query("ALTER TABLE events RENAME TO events_unavailable");
    try { await assert.rejects(f.store.event(session.id, message.id, "fault", {}), /events/); }
    finally { await f.database.pool.query("ALTER TABLE events_unavailable RENAME TO events"); }
    assert.equal(f.manager.storageUnavailable, true);
    await wait(() => f.counts().closes >= 1);
    assert.notEqual((await f.store.message(message.id))!.status, "succeeded");
    await assert.rejects(f.a.send(session.id, randomUUID(), "must refuse"), code("STORAGE_UNAVAILABLE"));
  } finally { await f.clean(); }
});

test("lost HTTP response retries the same message without a second execution", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let lost = false;
  try {
    const session = await f.manager.create("a", "one");
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      if (!lost && String(input).endsWith("/messages")) {
        lost = true;
        await response.arrayBuffer();
        throw new TypeError("Injected response loss after acceptance");
      }
      return response;
    };
    const { message } = await f.a.send(session.id, randomUUID(), "one execution");
    await wait(() => f.counts().runs === 1);
    assert.equal((await f.store.messages(session.id)).length, 1);
    f.gates.get(message.id)!();
    await wait(async () => (await f.store.message(message.id))!.status === "succeeded");
    assert.equal(f.counts().runs, 1);
  } finally { globalThis.fetch = originalFetch; await f.clean(); }
});

test("service chat sends consecutive messages, Ctrl+C cancels one turn, EOF detaches without closing environment", async () => {
  const f = await fixture();
  const { spawn } = await import("node:child_process");
  const session = await f.manager.create("a", "one");
  const child = spawn(process.execPath, ["dist/src/clients/cli/main.js", "chat", session.id], {
    env: { ...process.env, AH_SERVICE_URL: f.url, AH_SERVICE_TOKEN: "a-test-key" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const exited = once(child, "exit");
  try {
    await wait(() => output.includes("/exit"), 10_000);
    child.stdin.write("first\n");
    await wait(() => f.counts().runs === 1, 10_000);
    const first = (await f.store.active(session.id))!;
    f.gates.get(first.id)!();
    await wait(async () => (await f.store.message(first.id))!.status === "succeeded" && output.includes("[succeeded]"), 10_000);
    child.stdin.write("second\n");
    await wait(() => f.counts().runs === 2, 10_000);
    const second = (await f.store.active(session.id))!;
    // send响应可能尚未回到CLI；等它显示输入请求后，额外查询状态让HTTP轮次完成。
    await sleep(100);
    child.kill("SIGINT");
    await wait(async () => (await f.store.message(second.id))!.status === "cancelled", 10_000);
    assert.equal((await f.store.session(session.id))!.environment, "ready");
    await wait(() => output.includes("[cancelled]"), 10_000);
    child.stdin.write("third\n");
    try { await wait(() => f.counts().runs === 3, 10_000); }
    catch (error) { console.error("CLI output before timeout:\n" + output); throw error; }
    const third = (await f.store.active(session.id))!;
    child.stdin.end();
    assert.equal((await exited)[0], 0, output);
    assert.equal((await f.store.message(third.id))!.status, "running");
    assert.equal(f.counts().closes, 0);
    f.gates.get(third.id)!();
    await wait(async () => (await f.store.message(third.id))!.status === "succeeded", 10_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await f.clean();
  }
});

test("web login uses HttpOnly cookie, enforces Origin and ownership; logout drops watchers without stopping tasks", async () => {
  const f = await fixture();
  const headers: Record<string, string> = { Origin: f.url, "X-Harbor-Client": "web", "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(`${f.url}/api/auth/me`)).status, 401);
    const login = await fetch(`${f.url}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ accessKey: "a-test-key" }) });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { userId: "a" });
    assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    headers.Cookie = login.headers.get("set-cookie")!.split(";")[0];
    const request = (path: string, method = "GET", data?: unknown, custom = headers) => fetch(`${f.url}/api${path}`, { method, headers: custom, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal((await request("/auth/me")).status, 200);
    assert.equal((await request("/sessions", "POST", { title: "wrong tab" }, { ...headers, "X-Harbor-User": "b" })).status, 401);
    for (const bad of ([{ ...headers, Origin: "https://untrusted.invalid" }, { Cookie: headers.Cookie, "Content-Type": "application/json" }] as Record<string, string>[])) {
      assert.equal((await request("/sessions", "POST", { title: "blocked" }, bad)).status, 403);
    }
    const session = await (await request("/sessions", "POST", { title: "web" })).json() as { id: string };
    const foreign = await f.manager.create("b", "private");
    for (const path of [`/sessions/${foreign.id}/history`, `/sessions/${foreign.id}/messages/${randomUUID()}`, `/sessions?order=created&after=${foreign.id}`]) assert.equal((await request(path)).status, 404);
    const message = (await f.a.send(session.id, randomUUID(), "multiline\nmessage")).message;
    await wait(() => f.counts().runs === 1);
    const stream = await request(`/sessions/${session.id}/events`);
    const reader = stream.body!.getReader();
    await reader.read();
    assert.equal((await request("/auth/logout", "POST")).status, 200);
    await wait(async () => { try { return (await reader.read()).done; } catch { return true; } });
    reader.releaseLock();
    assert.equal((await request("/auth/me")).status, 401);
    assert.equal((await f.store.message(message.id))!.status, "running");
    assert.equal(f.counts().closes, 0);
    f.gates.get(message.id)!();
    await wait(async () => (await f.store.message(message.id))!.status === "succeeded");
  } finally { await f.clean(); }
});

test("web history pages use fixed event cutoff and join original messages; immutable session pagination", async () => {
  const f = await fixture();
  try {
    const first = await f.manager.create("a", "one");
    const { message } = await f.store.accept(first.id, randomUUID(), "first\nsecond");
    for (let i = 0; i < 110; i++) await f.store.event(first.id, message.id, "assistant.text.delta", { text: String(i) });
    const page = await f.a.request<{ through: number; events: { eventId: number }[]; messages: { text: string }[] }>(`/sessions/${first.id}/history?limit=100`);
    assert.equal(page.events.length, 100);
    assert.equal(page.messages[0].text, "first\nsecond");
    await f.store.event(first.id, message.id, "assistant.text.delta", { text: "later" });
    const rest = await f.a.request<{ events: { eventId: number }[] }>(`/sessions/${first.id}/history?after=${page.events.at(-1)!.eventId}&through=${page.through}`);
    assert.equal(rest.events.at(-1)!.eventId, page.through);
    assert.ok(rest.events.every(e => e.eventId <= page.through));
    await assert.rejects(f.a.request(`/sessions/${first.id}/history?through=9999`), code("CURSOR_AHEAD"));
    const record = await f.a.request<{ text: string }>(`/sessions/${first.id}/messages/${message.id}`);
    assert.equal(record.text, "first\nsecond");
    await f.manager.create("a", "two"); await f.manager.create("a", "three");
    const top = await f.a.request<{ id: string }[]>("/sessions?order=created&limit=2");
    const tail = await f.a.request<{ id: string }[]>(`/sessions?order=created&limit=2&after=${top.at(-1)!.id}`);
    assert.equal(new Set([...top, ...tail].map(s => s.id)).size, 3);
  } finally { await f.clean(); }
});

test("web serves built assets only with CSP; credentials, source and runtime files are unavailable", async () => {
  const f = await fixture();
  try {
    const page = await fetch(f.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
    const html = await page.text();
    assert.match(html, /id="root"/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
    assert.ok(assets.some(path => path.endsWith(".js")));
    for (const path of assets) assert.equal((await fetch(f.url + path)).status, 200, path);
    for (const path of ["/.env", "/src/service/server.ts", "/var/service-sessions/.service/access-keys.json", "/assets/%2e%2e/package.json", "/assets/clients/web/prototype/app.js"]) assert.equal((await fetch(f.url + path)).status, 404, path);
    assert.equal((await fetch(f.url, { method: "HEAD" })).status, 200);
  } finally { await f.clean(); }
});


test("dependency cache identity comes from authenticated owner, never request fields", async () => {
  const f = await fixture();
  try {
    for (const [client, owner] of [[f.a, "a"], [f.b, "b"]] as const) {
      const session = await client.request<{id:string}>("/sessions", "POST", {title:"cache owner", dependencyCacheKey:"injected", ownerId:"other"});
      await client.request(`/sessions/${session.id}/messages`, "POST", {clientMessageId:randomUUID(),text:"hold",dependencyCacheKey:"injected"});
      await wait(()=>f.runtimeOptions.length === (owner === "a" ? 1 : 2));
      assert.equal(f.runtimeOptions.at(-1)?.dependencyCacheKey, createHash("sha256").update(`user:${owner}`).digest("hex"));
    }
    assert.notEqual(f.runtimeOptions[0].dependencyCacheKey, f.runtimeOptions[1].dependencyCacheKey);
  } finally { await f.clean(); }
});

test("current MCP config changes rebuild before the next turn, without changing an active turn or unchanged configuration", async () => {
  const f=await fixture(60_000);
  try {
    const session=await f.manager.create("a","MCP current config");
    let current={mcpServers:{first:{type:"http" as const,url:"https://example.com/mcp"}}};
    f.manager.runtimeConnections=async row=>{assert.equal(row.ownerId,"a");return current;};
    const first=await f.a.send(session.id,randomUUID(),"first");
    await wait(()=>f.counts().runs===1);
    current={mcpServers:{first:{type:"http",url:"https://example.com/new"}}};
    assert.equal(f.counts().opens,1);
    assert.equal(f.runtimeOptions[0].mcpServers!.first.type,"http");
    assert.equal((f.runtimeOptions[0].mcpServers!.first as {url:string}).url,"https://example.com/mcp");
    f.gates.get(first.message.id)!();
    await wait(async()=> (await f.store.message(first.message.id))!.status==="succeeded");
    for(let round=2;round<=3;round++) {
      const sent=await f.a.send(session.id,randomUUID(),"round "+round);
      await wait(()=>f.counts().runs===round);
      assert.equal(f.counts().opens,2);
      assert.equal(f.counts().closes,1);
      assert.equal((f.runtimeOptions[1].mcpServers!.first as {url:string}).url,"https://example.com/new");
      f.gates.get(sent.message.id)!();
      await wait(async()=> (await f.store.message(sent.message.id))!.status==="succeeded");
    }
  } finally {await f.clean();}
});
