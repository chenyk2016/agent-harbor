/** 生命周期单元测试：模拟引擎，真实运行exec事件子进程和宿主flock。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Controller } from "../src/runtime/controller.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ah-conversation-"));
  const c = new Controller(root);
  let creates = 0;
  let connects = 0;
  const children: ReturnType<typeof spawn>[] = [];
  let current = "";
  let running = false;
  c.backend.forSession = async () => current ? [current] : [];
  c.backend.imageId = async () => "sha256:test";
  c.backend.inspect = async () => current ? { running, exitCode: 0, labels: {} } : undefined;
  c.backend.create = async task => { creates++; current = `ah-${task.attemptId}`; return current; };
  c.backend.startSession = async () => { running = true; };
  c.backend.stop = async () => { running = false; for (const child of children) child.kill(); };
  c.backend.destroy = async () => { current = ""; };
  c.backend.connect = (_id, attempt) => {
    connects++;
    // 只模拟后端协议，不导入SDK；一个真实子进程接收多条输入。
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {readFile} from 'node:fs/promises';
      import {createInterface} from 'node:readline';
      const boot=JSON.parse(await readFile(process.argv[1],'utf8'));
      let seq=0;
      const emit=(type,payload={},task)=>console.log(JSON.stringify({
        sessionId:boot.sessionId,runnerId:boot.attemptId,seq:++seq,type,
        attemptId:task?.attemptId,generation:task?.generation,payload
      }));
      emit('runner.ready',{runnerPid:process.pid});
      const input=createInterface({input:process.stdin});
      input.on('close',()=>process.exit(0));
      let active;
      input.on('line',line=>{
        const command=JSON.parse(line);
        if(command.type==='close'){input.close();return;}
        if(command.type==='interrupt' && active?.prompt==='interruptible'){emit('agent.result',{subtype:'cancelled'},active);active=undefined;return;}
        if(command.type!=='message')return;
        const t=command.task;active=t;
        emit('input.accepted',{},t);
        if(t.prompt==='long'||t.prompt==='interruptible')return;
        if(t.prompt==='bad'){console.log('not-json');return;}
        if(t.prompt==='wrong'){console.log(JSON.stringify({sessionId:boot.sessionId,runnerId:'wrong',seq:++seq}));return;}
        if(t.prompt==='crash'){process.exit(1);return;}
        emit('sdk.session',{id:'native-id',runnerPid:process.pid,nativePid:123},t);
        emit('agent.result',{subtype:'success',costUsd:t.generation*.001},t);
        if(t.prompt==='idle-crash')setTimeout(()=>process.exit(1),100);
        if(t.prompt==='background')setTimeout(()=>emit('sdk.task',{task_id:'background-id',subtype:'task_notification'},t),100);
      });
    `, join(root, "one/attempts", attempt, "task.json")], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
  return { c, count: () => creates, connects: () => connects, clean: () => rm(root, { recursive: true, force: true }) };
}

test("chat reuses one Runner, owns idle lock and clears startup credentials only at close", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "test-token");
  try {
    await assert.rejects(f.c.run("one", "competing", "token"), /already running/);
    const first = await conversation.run("first");
    const second = await conversation.run("second");
    assert.equal(f.count(), 1);
    assert.equal(f.connects(), 1);
    assert.equal(second.containerId, first.containerId);
    assert.equal(second.sdkSessionId, first.sdkSessionId);
    assert.equal(second.generation, 2);
    assert.equal(second.environment, "ready");
    assert.equal(second.stopped, false);
    assert.equal(second.runnerId, first.attemptId);
    const startup = join(f.c.store.directory("one"), "attempts", first.attemptId!, "connection.json");
    assert.match(await readFile(startup, "utf8"), /test-token/);
    await assert.rejects(f.c.run("one", "competing idle", "token"), /already running/);
  } finally { await conversation.close(); }
  const closed = await f.c.store.load("one");
  assert.equal(closed.stopped, true);
  assert.equal(await readFile(join(f.c.store.directory("one"), "attempts", closed.runnerId!, "connection.json"), "utf8"), "{}");
  const reopened = await f.c.open("one", "token");
  await reopened.close();
  await f.clean();
});

test("cancel before execution closes environment; next turn rebuilds without replay", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    await conversation.run("first");
    const signal = AbortSignal.abort();
    const cancelled = await conversation.run("cancel", undefined, signal);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.stopped, true);
    const next = await conversation.run("next");
    assert.equal(next.status, "succeeded");
    assert.equal(f.count(), 2);
  } finally { await conversation.close(); await f.clean(); }
});

test("legacy resident sessions resume on their stored image after the default changes", async () => {
  const f = await fixture();
  try {
    const initial = await f.c.open("one", "token");
    try {
      assert.equal((await initial.run("first")).imageId, "sha256:test");
    } finally { await initial.close(); }

    const resolved: string[] = [];
    f.c.profile.image = "harbor:new-default";
    f.c.backend.imageId = async (image) => {
      resolved.push(image);
      return image === "sha256:test" ? image : "sha256:new";
    };
    const reopened = await f.c.open("one", "token");
    try {
      const result = await reopened.run("second");
      assert.equal(result.status, "succeeded");
      assert.equal(result.imageId, "sha256:test");
      assert.equal(result.sdkSessionId, "native-id");
      assert.deepEqual(resolved, ["sha256:test"]);
    } finally { await reopened.close(); }
  } finally { await f.clean(); }
});

test("environment becomes ready while a turn is waiting for the model, including reused turns", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    for (let i = 0; i < 2; i++) {
      const abort = new AbortController();
      let accepted!: () => void;
      const input = new Promise<void>(resolve => { accepted = resolve; });
      const result = conversation.run("interruptible", event => {
        if (event.type === "input.accepted") accepted();
      }, abort.signal);
      await input;
      const session = await f.c.store.load("one");
      assert.equal(session.status, "running");
      assert.equal(session.environment, "ready");
      abort.abort();
      assert.equal((await result).status, "cancelled");
    }
    assert.equal(f.count(), 1);
  } finally { await conversation.close(); await f.clean(); }
});

test("unknown stop blocks further turns until close/reconciliation", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    await conversation.run("first");
    const stop = f.c.backend.stop;
    f.c.backend.stop = async () => { throw new Error("engine unreachable"); };
    const result = await conversation.run("cancel", undefined, AbortSignal.abort());
    assert.equal(result.status, "reconciling");
    await assert.rejects(conversation.run("must not run"), /reconciliation/);
    f.c.backend.stop = stop;
  } finally { await conversation.close(); await f.clean(); }
});

test("lost persistent create response stops deterministic name, then next input may rebuild", async () => {
  const f = await fixture();
  const create = f.c.backend.create;
  let stopped = "";
  const stop = f.c.backend.stop;
  f.c.backend.create = async (...args) => { await create(...args); throw new Error("response lost"); };
  f.c.backend.stop = async id => { stopped = id; await stop(id); };
  const conversation = await f.c.open("one", "token");
  try {
    const failed = await conversation.run("first");
    assert.equal(failed.status, "failed");
    assert.equal(stopped, failed.containerId);
    assert.equal(failed.stopped, true);
    f.c.backend.create = create;
    assert.equal((await conversation.run("next")).status, "succeeded");
  } finally { await conversation.close(); await f.clean(); }
});

test("malformed exec events stop environment rather than mark it reusable", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    const failed = await conversation.run("bad");
    assert.equal(failed.status, "failed");
    assert.equal(failed.environment, "closed");
    assert.equal(failed.stopped, true);
  } finally { await conversation.close(); await f.clean(); }
});


test("container stopped while idle is confirmed and recreated before submitting next prompt", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    const first = await conversation.run("first");
    await f.c.backend.stop(first.containerId!);
    const next = await conversation.run("next");
    assert.equal(next.status, "succeeded");
    assert.notEqual(next.containerId, first.containerId);
    assert.equal(next.sdkSessionId, first.sdkSessionId);
    assert.equal(f.count(), 2);
  } finally { await conversation.close(); await f.clean(); }
});

async function waitFor(test: () => boolean | Promise<boolean>) {
  // Docker清理在并行跑全量时会排队；等待上限只影响测试，不放宽产品断言。
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not settle");
}

test("background event is recorded under its creating turn, never sent to the next caller", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    const first = await conversation.run("background");
    const events: string[] = [];
    const abort = new AbortController();
    const next = conversation.run("long", e => events.push(e.type), abort.signal);
    const path = join(f.c.store.directory("one"), "attempts", first.attemptId!, "events.jsonl");
    await waitFor(async () => (await readFile(path, "utf8")).includes('background-id'));
    assert.equal(events.includes("sdk.task"), false);
    abort.abort();
    assert.equal((await next).status, "cancelled");
  } finally { await conversation.close(); await f.clean(); }
});

test("idle Runner crash immediately cleans its container and a new input starts a new Runner", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    const first = await conversation.run("idle-crash");
    await waitFor(async () => (await f.c.store.load("one")).stopped === true);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
    const next = await conversation.run("next");
    assert.equal(next.status, "succeeded");
    assert.notEqual(next.runnerId, first.runnerId);
    assert.equal(next.sdkSessionId, first.sdkSessionId);
  } finally { await conversation.close(); await f.clean(); }
});

test("wrong Runner identity stops environment and never succeeds", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  try {
    const result = await conversation.run("wrong");
    assert.equal(result.status, "failed");
    assert.equal(result.stopped, true);
  } finally { await conversation.close(); await f.clean(); }
});

test("new owner reconciles before a new unique lease and never refreshes the old heartbeat", async () => {
  const f = await fixture();
  const directory = await f.c.store.prepare("one");
  const oldHeartbeat = join(directory, "attempts", ".heartbeat");
  await writeFile(oldHeartbeat, "old-lease");
  const before = (await stat(oldHeartbeat)).mtimeMs;
  const original = f.c.backend.forSession;
  let coordinated = false;
  f.c.backend.forSession = async id => { coordinated = true; return original(id); };
  const conversation = await f.c.open("one", "token");
  try {
    assert.equal(coordinated, true);
    assert.equal((await stat(oldHeartbeat)).mtimeMs, before);
    const leases = await readdir(join(directory, "attempts", ".leases"));
    assert.equal(leases.length, 1);
    await assert.rejects(conversation.run("/clear"), /reset commands/);
  } finally { await conversation.close(); await f.clean(); }
});


test("cancel during create waits for the lost-or-late result before stopping its deterministic name", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const create = f.c.backend.create;
  let createsFinished = false;
  f.c.backend.create = async (...args) => {
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    const id = await create(...args);
    createsFinished = true;
    return id;
  };
  const stop = f.c.backend.stop;
  f.c.backend.stop = async id => {
    assert.equal(createsFinished, true);
    await stop(id);
  };
  const conversation = await f.c.open("one", "token");
  try {
    const result = await conversation.run("cancel during create", undefined, abort.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopped, true);
    assert.equal(f.connects(), 0);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
  } finally { await conversation.close(); await f.clean(); }
});

test("chat metadata failure after a result still stops the live environment", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  const save = f.c.store.save.bind(f.c.store);
  f.c.store.save = async session => {
    if (session.status === "succeeded" && session.environment === "ready") throw new Error("metadata volume full");
    await save(session);
  };
  try {
    const result = await conversation.run("first");
    assert.equal(result.status, "reconciling");
    assert.equal(result.stopped, true);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
    await assert.rejects(conversation.run("another"), /reconciliation/);
  } finally { await conversation.close(); await f.clean(); }
});


test("native interrupt finishes only the turn, preserves the exact Runner and accepts a new message", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  const abort = new AbortController();
  try {
    const first = await conversation.run("first");
    const pending = conversation.run("interruptible", event => {
      if (event.type === "input.accepted") abort.abort();
    }, abort.signal);
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.environment, "ready");
    assert.equal(cancelled.stopped, false);
    const next = await conversation.run("next");
    assert.equal(next.runnerId, first.runnerId);
    assert.equal(f.connects(), 1);
  } finally { await conversation.close(); await f.clean(); }
});

test("missing native completion escalates to confirmed container stop; timeout remains a hard stop", async () => {
  const f = await fixture();
  f.c.profile.interruptTimeoutMs = 40;
  const conversation = await f.c.open("one", "token");
  try {
    const abort = new AbortController();
    const result = await conversation.run("long", event => {
      if (event.type === "input.accepted") abort.abort();
    }, abort.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopped, true);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
    f.c.profile.timeoutMs = 50;
    const timed = await conversation.run("long");
    assert.equal(timed.stopped, true);
    assert.equal(timed.status, "failed");
    assert.equal(timed.stopReason, "task_timeout");
  } finally { await conversation.close(); await f.clean(); }
});

test("service observer sees idle events and messageId is used as attemptId", async () => {
  const f = await fixture();
  const notices: import("../src/runtime/controller.js").RuntimeNotice[] = [];
  const conversation = await f.c.open("one", "token", { onRuntimeNotice: async notice => { notices.push(notice); } });
  try {
    const id = (await import("node:crypto")).randomUUID();
    const result = await conversation.run("background", undefined, undefined, { attemptId: id });
    assert.equal(result.attemptId, id);
    await waitFor(async () => notices.some(notice => notice.type === "runner.event" && notice.event.type === "sdk.task"));
    assert.ok(notices.some(notice => notice.type === "environment.changed" && notice.session.environment === "ready"));
  } finally { await conversation.close(); await f.clean(); }
});

test("explicit environment termination during create waits for late create before stop", async () => {
  const f = await fixture();
  const conversation = await f.c.open("one", "token");
  const create = f.c.backend.create;
  const stop = f.c.backend.stop;
  let created = false;
  f.c.backend.create = async (...args) => {
    await conversation.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    const id = await create(...args);
    created = true;
    return id;
  };
  f.c.backend.stop = async id => { assert.equal(created, true); await stop(id); };
  try {
    const result = await conversation.run("closed during create");
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopped, true);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
  } finally { await conversation.close(); await f.clean(); }
});

test("zero total timeout waits for user cancellation and confirms stop", async () => {
  const f = await fixture();
  f.c.profile.timeoutMs = 0;
  f.c.profile.interruptTimeoutMs = 40;
  const conversation = await f.c.open("one", "token");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await conversation.run("long", event => {
      if (event.type === "input.accepted") timer = setTimeout(() => abort.abort(), 100);
    }, abort.signal);
    assert.equal(abort.signal.aborted, true, "zero must not create an immediate timeout");
    assert.equal(result.stopReason, "user_cancelled");
    assert.equal(result.status, "cancelled");
    assert.equal(result.stopped, true);
    assert.deepEqual(await f.c.backend.forSession("one"), []);
  } finally { clearTimeout(timer); await conversation.close(); await f.clean(); }
});
