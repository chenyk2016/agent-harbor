/** 网页状态用真实事件约定验证；不把DOM外观快照当业务正确性。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalState } from "../apps/web/src/state/local-state.js";
import { ConversationState, isActive } from "../apps/web/src/state/conversation-state.js";
import { Markdown } from "../apps/web/src/shared/Markdown.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../src/service/types.js";
import type { SessionDetail } from "../src/clients/service-client.js";

import { Workspace } from "../apps/web/src/state/workspace.js";
import { BrowserApi } from "../apps/web/src/state/api.js";
import type { ClientEvent } from "../src/clients/service-client.js";
import { setTimeout as sleep } from "node:timers/promises";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const session = (): SessionDetail => ({ id: "a", ownerId: "u", title: "one", environment: "closed", createdAt: 1, updatedAt: 1, lastEventId: 0, lastMessageId: null, message: null });
const message = (id = "m"): Message => ({ id, sessionId: "a", clientMessageId: "request", text: "第一行\n第二行", status: "succeeded", cancelRequested: 0, createdEventId: 1, startedAt: null, finishedAt: null, result: null });
test("drafts and pending IDs survive refresh, remain user scoped, and acceptance preserves newly edited text", () => {
  const saved = storage();
  const first = new LocalState("alice", saved);
  first.select("a"); first.setDraft("a", "original\ntext"); first.prepare("a", { clientMessageId: "same-id", text: "original\ntext" });
  const refreshed = new LocalState("alice", saved);
  assert.equal(refreshed.selectedId, "a"); assert.equal(refreshed.pending("a")!.clientMessageId, "same-id");
  refreshed.setDraft("a", "new draft"); refreshed.accepted("a");
  assert.equal(refreshed.draft("a"), "new draft"); assert.equal(refreshed.pending("a"), undefined);
  assert.equal(new LocalState("bob", saved).draft("a"), "");
  refreshed.clear(); assert.equal(new LocalState("alice", saved).draft("a"), "");
});
test("history retains message ownership and multiline text; duplicate events do not duplicate output", () => {
  const state = new ConversationState(session()); state.add(message());
  const emit = (id: number, type: string, data = {}) => state.apply({ id, type, data: { messageId: "m", ...data } });
  emit(1, "message.accepted"); emit(2, "message.started"); emit(3, "assistant.text.delta", { text: "答\n复" }); emit(3, "assistant.text.delta", { text: "答\n复" });
  assert.equal(state.ordered[0].text, "答\n复"); assert.equal(state.latest!.text, "第一行\n第二行");
  emit(4, "message.state", { status: "finalizing" }); assert.equal(isActive(state.latest), true);
  emit(5, "message.finished", { status: "cancelled" }); assert.equal(isActive(state.latest), false);
  state.add(message("next")); state.apply({ id: 6, type: "message.accepted", data: { messageId: "next" } });
  assert.equal(state.latest!.id, "next"); assert.equal(state.messages.get("m")!.record.status, "cancelled");
});
test("reconnect remains unavailable until saved cursor catches the current snapshot", () => {
  const state = new ConversationState(session()); state.add(message());
  state.beginSync({ ...session(), lastEventId: 3, lastMessageId: "m", message: message(), environment: "ready" });
  assert.equal(state.connection, "synchronizing");
  state.apply({ id: 1, type: "message.accepted", data: { messageId: "m" } });
  state.apply({ id: 2, type: "message.started", data: { messageId: "m" } });
  assert.equal(state.connection, "synchronizing");
  state.apply({ id: 3, type: "message.finished", data: { messageId: "m", status: "succeeded" } });
  assert.equal(state.connection, "connected"); assert.equal(state.detail.environment, "ready");
});
test("Markdown is readable while user/model HTML and code remain inert text", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: '# 标题\n**重点**\n- 列表\n```html\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))' }));
  assert.match(html, /<h1>标题<\/h1>/); assert.match(html, /<strong>重点<\/strong>/); assert.match(html, /<ul>/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class TestApi extends BrowserApi {
  records = [session(), { ...session(), id: "b", title: "two" }];
  slowHistory?: ReturnType<typeof deferred<Awaited<ReturnType<BrowserApi["history"]>>>>;
  sendResult?: ReturnType<typeof deferred<{ message: Message }>>;
  sent: { id: string; request: string; text: string; modelId?: string }[] = [];
  lost = false;
  async history(id: string) {
    if (id === "a" && this.slowHistory) { const gate = this.slowHistory; this.slowHistory = undefined; return gate.promise; }
    return { session: this.records.find(s => s.id === id)!, through: 0, events: [], messages: [] };
  }
  async request<T>(path: string): Promise<T> { return this.records.find(s => path.endsWith(s.id)) as T; }
  async *events(_id: string, _after: number, signal: AbortSignal, connected: (state: "connecting" | "connected" | "disconnected") => void | Promise<void> = () => {}): AsyncGenerator<ClientEvent> {
    await connected("connected");
    if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
  }
  async send(id: string, request: string, text: string, modelId?: string) {
    this.sent.push({ id, request, text, modelId });
    if (this.lost) throw new TypeError("response unknown");
    return this.sendResult ? this.sendResult.promise : { message: { ...message(), sessionId: id, clientMessageId: request, text } };
  }
}
async function ready(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await sleep(1); } throw new Error("UI state did not settle"); }
function workspace(api: TestApi) {
  const local = new LocalState("user", storage());
  const work = new Workspace(api, local, "user", () => {}, () => {}, () => {});
  api.records.forEach(record => work.sessions.set(record.id, { ...record }));
  return work;
}
test("A→B→A ignores the first A response; late sends only clear their original draft", async () => {
  const api = new TestApi(); const gate = api.slowHistory = deferred(); const work = workspace(api);
  try {
    const first = work.select("a"); void work.select("b"); void work.select("a");
    await ready(() => work.current?.connection === "connected");
    gate.resolve({ session: session(), through: 99, events: [{ sessionId: "a", eventId: 99, messageId: null, type: "environment.changed", payload: { environment: "reconciling" } }], messages: [] });
    await first;
    assert.equal(work.current!.cursor, 0); assert.equal(work.current!.detail.environment, "closed");
    work.setDraft("original A"); api.sendResult = deferred(); const sending = work.send();
    void work.select("b"); await ready(() => work.current?.id === "b" && work.current.connection === "connected"); work.setDraft("B draft");
    api.sendResult.resolve({ message: { ...message(), clientMessageId: api.sent[0].request, text: "original A" } });
    await sending;
    assert.equal(work.draft, "B draft"); assert.equal(work.local.draft("a"), ""); assert.equal(api.sent[0].id, "a");
  } finally { work.dispose(); }
});
test("unknown submission blocks new sends and explicit retry preserves the original ID and body", async () => {
  const api = new TestApi(); const work = workspace(api);
  try {
    void work.select("a"); await ready(() => work.current?.connection === "connected");
    work.setDraft("original\ntext"); api.lost = true; await work.send();
    const request = work.pending!.clientMessageId;
    work.setDraft("new draft"); await work.send(); assert.equal(api.sent.length, 1);
    api.lost = false; await work.send(true);
    assert.equal(api.sent.length, 2); assert.equal(api.sent[1].request, request); assert.equal(api.sent[1].text, "original\ntext");
    assert.equal(work.draft, "new draft"); assert.equal(work.pending, undefined);
  } finally { work.dispose(); }
});

test("route-owned startup reads sessions without restoring an unrelated conversation", async () => {
  const api = new TestApi(), work = workspace(api);
  api.sessions = async () => api.records;
  work.local.select("a");
  try {
    await work.start(false);
    assert.equal(work.selectedId, undefined);
    assert.equal(work.sessions.size, 2);
    void work.select("b");
    await ready(() => work.current?.connection === "connected");
    assert.equal(work.selectedId, "b");
    assert.equal(work.local.selectedId, "b");
  } finally { work.dispose(); }
});

test("application workspace uses the outer list and only fetches its session on a cache miss", async () => {
  const api = new TestApi();
  const outer = workspace(api);
  const request = api.request.bind(api);
  const history = api.history.bind(api);
  const calls: string[] = [];
  api.request = async <T>(path: string) => {
    calls.push(path);
    return request<T>(path);
  };
  api.history = async (id) => {
    calls.push("history:" + id);
    return history(id);
  };
  api.sessions = async () => {
    calls.push("session-list");
    return api.records;
  };
  const scoped = new Workspace(api, outer.local, "user", () => {}, () => {}, () => {}, outer);
  try {
    await scoped.start(false);
    void scoped.select("a");
    await ready(() => scoped.current?.connection === "connected");
    assert.deepEqual(calls, ["history:a", "/sessions/a"]);

    calls.length = 0;
    outer.sessions.delete("b");
    void scoped.select("b");
    await ready(() => scoped.current?.id === "b" && scoped.current.connection === "connected");
    assert.deepEqual(calls, ["/sessions/b", "history:b", "/sessions/b"]);
    assert.equal(outer.selectedId, undefined);

    calls.length = 0;
    scoped.reconnect();
    await ready(() => scoped.current?.connection === "connected");
    assert.deepEqual(calls, ["history:b", "/sessions/b"]);
  } finally {
    scoped.dispose();
    outer.dispose();
  }
});

test("MCP reload on an already closed session leaves the composer usable without waiting for a nonexistent event",async()=>{
  const api=new TestApi(), work=workspace(api);
  const request=api.request.bind(api);
  api.request=async<T>(path:string):Promise<T>=>path.endsWith("/mcp/reload")?{closed:true} as T:request<T>(path);
  try {
    void work.select("a"); await ready(()=>work.current?.connection==="connected");
    await work.reloadMcp("a",null);
    assert.equal(work.current?.control,undefined);
    work.setDraft("Continue after reload"); await work.send();
    assert.equal(api.sent.length,1);
  } finally {work.dispose();}
});


test("model draft stays per conversation and uncertain retries freeze the original model", async () => {
  const api = new TestApi(), work = workspace(api);
  try {
    void work.select("a"); await ready(() => work.current?.connection === "connected");
    work.setModel("model-a"); work.setDraft("one request"); api.lost = true;
    await work.send(); const original = api.sent[0];
    work.setModel("model-b");
    await work.send(true);
    assert.equal(api.sent[1].request, original.request);
    assert.equal(api.sent[1].modelId, "model-a");
    assert.equal(work.modelId, "model-b");
    void work.select("b"); await ready(() => work.current?.connection === "connected");
    assert.equal(work.modelId, undefined);
    work.setModel("model-c");
    void work.select("a"); await ready(() => work.current?.connection === "connected");
    assert.equal(work.modelId, "model-b");
  } finally { work.dispose(); }
});
