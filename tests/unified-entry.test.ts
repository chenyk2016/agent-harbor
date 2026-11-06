/** 总入口状态回归：标题派生、创建后发送、失败保留草稿、应用会话映射。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserApi } from "../apps/web/src/state/api.js";
import { LocalState } from "../apps/web/src/state/local-state.js";
import {
  Workspace,
  draftTitle,
} from "../apps/web/src/state/workspace.js";
import type { SessionDetail } from "../src/clients/service-client.js";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

class EntryApi extends BrowserApi {
  apps: {
    id: string;
    title: string;
    status: string;
    developmentSessionId: string | null;
  }[] = [];
  created: {
    title: string;
    template: string;
    modelId?: string;
    clientRequestId?: string;
  }[] = [];
  sent: {
    id: string;
    clientMessageId: string;
    text: string;
    modelId?: string;
  }[] = [];
  failSend?: unknown;
  failList?: unknown;

  override async create(
    title: string,
    template: string,
    _skills?: string[],
    modelId?: string,
    clientRequestId?: string,
  ) {
    this.created.push({ title, template, modelId, clientRequestId });
    return {
      id: "session-1",
      ownerId: "user",
      title,
      createdAt: 1,
      updatedAt: 1,
      environment: "closed",
      lastMessageId: null,
      lastEventId: 0,
    } as SessionDetail;
  }

  override async send(
    id: string,
    clientMessageId: string,
    text: string,
    modelId?: string,
  ) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ id, clientMessageId, text, modelId });
    return {
      message: {
        id: "message-1",
        sessionId: id,
        clientMessageId,
        text,
        status: "accepted",
        cancelRequested: 0,
        createdEventId: 1,
        startedAt: null,
        finishedAt: null,
        result: null,
      },
    } as never;
  }

  override async request<T>(
    path: string,
    method = "GET",
    _body?: unknown,
    _signal?: AbortSignal,
  ): Promise<T> {
    if (path === "/applications" && method === "GET") {
      if (this.failList) throw this.failList;
      return this.apps as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

function workspace(api: EntryApi) {
  return new Workspace(
    api,
    new LocalState("user", storage()),
    "user",
    () => {},
    () => {},
    () => {},
  );
}

test("标题取第一个非空行，压缩空白并限制 40 字", () => {
  assert.equal(draftTitle("\n  整理   调研资料  \n第二行", "兜底"), "整理 调研资料");
  assert.equal(draftTitle("   ", "兜底"), "兜底");
  assert.equal(draftTitle("字".repeat(60), "兜底").length, 40);
});

test("发送即创建：只建一个会话、只发一条消息", async () => {
  const api = new EntryApi();
  const work = workspace(api);
  const id = await work.startConversation(
    "  整理调研资料\n补充数据",
    "model-a",
    "req-1",
  );
  assert.equal(id, "session-1");
  assert.deepEqual(api.created, [
    {
      title: "整理调研资料",
      template: "empty",
      modelId: "model-a",
      clientRequestId: "req-1",
    },
  ]);
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].id, "session-1");
  assert.equal(api.sent[0].text, "  整理调研资料\n补充数据");
  assert.equal(api.sent[0].modelId, "model-a");
  assert.equal(work.sessions.get("session-1")?.message?.id, "message-1");
});

test("首条消息失败仍返回会话，并把原文留作草稿", async () => {
  const api = new EntryApi();
  api.failSend = new Error("offline");
  const work = workspace(api);
  const id = await work.startConversation("继续这项任务");
  assert.equal(id, "session-1");
  assert.equal(work.local.draft("session-1"), "继续这项任务");
});

test("应用列表回填 developmentSessionId 映射，失败静默降级", async () => {
  const api = new EntryApi();
  const work = workspace(api);
  api.apps = [
    {
      id: "app-1",
      title: "报名页",
      status: "active",
      developmentSessionId: "session-app",
    },
  ];
  await work.loadApplications();
  assert.equal(work.appsLoaded, true);
  assert.equal(work.applicationFor("session-app")?.id, "app-1");

  const failed = new EntryApi();
  failed.failList = new Error("404");
  const fallback = workspace(failed);
  await fallback.loadApplications();
  assert.equal(fallback.appsLoaded, true);
  assert.equal(fallback.applicationFor("session-app"), undefined);
});

test("删除会话清理草稿、待发请求、置顶和模型，旧编辑器实例不能重新写回", () => {
  const saved=storage(),first=new LocalState("user",saved);
  first.setDraft("gone","private draft");first.prepare("gone",{clientMessageId:"request",text:"private draft"});first.togglePin("gone");first.setModel("gone","model");first.select("gone");
  const stale=new LocalState("user",saved);
  first.forget("gone");stale.setDraft("other","keep");
  const checked=new LocalState("user",saved);
  assert.equal(checked.draft("gone"),"");assert.equal(checked.pending("gone"),undefined);assert.equal(checked.model("gone"),undefined);assert.equal(checked.pinned("gone"),false);assert.equal(checked.selectedId,undefined);assert.equal(checked.draft("other"),"keep");
});

test("删除后的迟到列表不会复活会话，读取期间新建的其他会话不会被误删", async () => {
  const api=new EntryApi(),work=workspace(api);
  const old={id:"gone",ownerId:"user",title:"gone",createdAt:1,updatedAt:1,environment:"closed",lastMessageId:null,lastEventId:0,message:null} as SessionDetail;
  work.sessions.set(old.id,old);
  let finish!: (value:SessionDetail[])=>void;
  api.sessions=async()=>new Promise<SessionDetail[]>(resolve=>{finish=resolve;});
  const pending=work.refreshList();
  work.forgetSession(old.id);
  work.sessions.set("new",{...old,id:"new"});finish([old]);await pending;
  assert.equal(work.sessions.has("gone"),false);assert.equal(work.sessions.has("new"),true);
  work.dispose();
});
