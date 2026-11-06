import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { Controller } from "../src/runtime/controller.js";
import { Auth, tokenHash } from "../src/service/auth.js";
import { createApi } from "../src/service/http-api.js";
import { WorkspaceFiles } from "../src/service/files/workspace-files.js";
import { IdentityStore } from "../src/service/identity/store.js";
import { BrowserSessions } from "../src/service/browser-sessions.js";
import { UsageStore } from "../src/service/usage/store.js";
import { defaultLimits } from "../src/service/limits/policy.js";
import { WalletService } from "../src/service/wallet/service.js";
import { walletRequests } from "../src/service/db/schema/index.js";
import { testDatabase } from "./pg.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationOptions } from "../src/runtime/controller.js";
import type { Session } from "../src/shared/types.js";
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
async function wait(check: () => boolean | Promise<boolean>) { for (let i=0;i<150;i++) { if (await check()) return; await sleep(10); } throw new Error("timeout"); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ah-users-"));
  const database = await testDatabase();
  const store = new ServiceStore(database.db), real = new Controller(root);
  const gates = new Map<string, () => void>(); let closes = 0;
  let failClose = false;
  const controller = { async open(id: string, _token: string, options: ConversationOptions = {}) {
    return {
      async run(_text: string, _events?: unknown, signal?: AbortSignal, input?: { attemptId?: string }): Promise<Session> {
        await new Promise<void>(resolve => { gates.set(input!.attemptId!, resolve); if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
        const result: Session = { sessionId: id, generation: 1, status: "succeeded", environment: "ready", stopped: false };
        await options.onRuntimeNotice?.({ type: "environment.changed", session: result }); return result;
      }, async terminate() {}, async close() { closes++; if (failClose) throw new Error("fixture unknown stop"); },
    };
  } };
  const manager = new SessionManager(store, controller, "fixture", 900000, 10), files = new WorkspaceFiles(root);
  const auth = new Auth(["a","b","admin"].map(userId => ({ userId, tokenHash: tokenHash(`key-${userId}`) })));
  await manager.identity.adoptSessionOwners();
  await manager.identity.importKeys(auth.keys);
  const server = createApi(manager, real, files, { adminUsers: ["admin"] });
  await new Promise<void>(done => server.listen(0,"127.0.0.1",done));
  const origin = `http://127.0.0.1:${(server.address() as { port:number }).port}`;
  const request = (path: string, method = "GET", data?: unknown, token = "key-a") => fetch(origin+"/api"+path, { method, headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body:data === undefined ? undefined : JSON.stringify(data) });
  return { root, store, database, manager, files, auth, real, origin, request, gates, failClose: () => { failClose=true; }, closes: () => closes,
    async clean() { failClose=false; manager.stopping=true; await files.close(); await manager.shutdown(); server.closeAllConnections(); await new Promise<void>(done=>server.close(()=>done())); await database.close(); await rm(root,{recursive:true,force:true}); } };
}

test("per-user task limit holds before the next turn is accepted; duplicate ID precedes limit; users have independent slots", async () => {
  const f=await fixture(); try {
    const a=await f.manager.create("a","one"), a2=await f.manager.create("a","two"), b=await f.manager.create("b","other");
    const key=randomUUID(), first=await f.manager.submit("a",a.id,key,"one");
    assert.equal((await f.manager.submit("a",a.id,key,"one")).message.id,first.message.id);
    await assert.rejects(f.manager.submit("a",a2.id,randomUUID(),"blocked"),code("TASK_LIMIT"));
    await f.manager.submit("b",b.id,randomUUID(),"allowed");
    await wait(()=>f.gates.has(first.message.id)); f.gates.get(first.message.id)!();
    await wait(async()=>(await f.store.message(first.message.id))!.status==="succeeded");
    await f.manager.submit("a",a2.id,randomUUID(),"next"); assert.equal((await f.manager.counts("a")).environments,2);
  } finally { await f.clean(); }
});

test("idle environments count separately; unconfirmed stop retains slot; successful cleanup releases it", async()=>{
  const f=await fixture();try{
    await f.manager.identity.update("a",{limits:{...defaultLimits,environments:1}});
    const a=await f.manager.create("a","one"),b=await f.manager.create("a","two");
    const first=(await f.manager.submit("a",a.id,randomUUID(),"one")).message;
    await wait(()=>f.gates.has(first.id));f.gates.get(first.id)!();await wait(async()=>(await f.store.message(first.id))!.status==="succeeded");
    assert.equal((await f.manager.counts("a")).tasks,0);
    await assert.rejects(f.manager.submit("a",b.id,randomUUID(),"blocked"),code("ENVIRONMENT_LIMIT"));
    f.failClose(); await assert.rejects(f.manager.closeUser("a"),code("USER_CLEANUP_UNCONFIRMED"));
    assert.equal((await f.manager.counts("a")).environments,1);assert.equal((await f.store.session(a.id))!.environment,"reconciling");
  }finally{await f.clean();}
});

test("session creation reserves before asynchronous preparation; failed preparation releases reservation",async()=>{
  const f=await fixture();try{
    await f.manager.identity.update("a",{limits:{...defaultLimits,sessions:1}});
    let release!:()=>void;
    const first=f.manager.createPrepared("a","one",randomUUID(),()=>new Promise<void>(resolve=>{release=resolve;}));
    await assert.rejects(f.manager.createPrepared("a","two",randomUUID(),async()=>{}),code("SESSION_LIMIT"));
    release();await first;assert.equal((await f.manager.counts("a")).sessions,1);
    await assert.rejects(f.manager.createPrepared("b","bad",randomUUID(),async()=>{throw new Error("bad prepare");}));
    await f.manager.create("b","good");
  }finally{await f.clean();}
});

test("keys expire/revoke persistently; import cannot resurrect; external subjects never merge by name",async()=>{
  const f=await fixture();try{
    const key=await f.manager.identity.createKey("a","laptop");assert.equal((await f.manager.identity.key(key.token)).userId,"a");
    await f.manager.identity.revokeKey("a",key.id);await assert.rejects(f.manager.identity.key(key.token),code("UNAUTHORIZED"));
    await assert.rejects(f.manager.identity.revokeKey("b",key.id),code("KEY_NOT_FOUND"));
    const imported=(await f.manager.identity.keys("a")).find(k=>k.name==="Imported development key")!;
    await f.manager.identity.revokeKey("a",String(imported.id)); await f.manager.identity.importKeys(f.auth.keys);
    await assert.rejects(f.manager.identity.key("key-a"),code("UNAUTHORIZED"));
    const expired=await f.manager.identity.createKey("a","expired");
    await f.database.pool.query('UPDATE "user_keys" SET "expiresAt"=0 WHERE id=$1',[expired.id]);
    await assert.rejects(f.manager.identity.key(expired.token),code("UNAUTHORIZED"));
    const one=await f.manager.identity.external("https://issuer","1","admin"),two=await f.manager.identity.external("https://issuer","2","admin");
    assert.notEqual(one.id,"admin");assert.notEqual(one.id,two.id);
    assert.equal((await f.manager.identity.external("https://issuer","1","renamed")).id,one.id);
  }finally{await f.clean();}
});

test("persistent browser session survives new connection manager; Secure configured and logout/disable revoke",async()=>{
  const f=await fixture();let first:BrowserSessions|undefined,second:BrowserSessions|undefined;
  try{
    const headers:string[]=[];
    const response={appendHeader(_name:string,value:string){headers.push(value);},setHeader(_name:string,value:string){headers.push(value);}} as unknown as ServerResponse;
    const request={headers:{}} as IncomingMessage;
    first=new BrowserSessions(f.manager.identity,"https://harbor.example");await first.login(request,response,"a");
    assert.match(headers[0],/Secure/);const cookie=headers[0].split(";")[0];
    first.close(); second=new BrowserSessions(new IdentityStore(f.store.db),"https://harbor.example");
    const browser={headers:{cookie}} as IncomingMessage;const principal=await second.user(browser);assert.equal(principal.userId,"a");
    await second.logout(browser,response);assert.equal(principal.signal.aborted,true);await assert.rejects(second!.user(browser),code("UNAUTHORIZED"));
  }finally{first?.close();second?.close();await f.clean();}
});

test("HTTP keys are private; revoke closes Bearer SSE; admin disable closes task/environment and refuses account",async()=>{
  const f=await fixture();try{
    const session=await f.manager.create("a","one"), message=(await f.manager.submit("a",session.id,randomUUID(),"work")).message;
    await wait(()=>f.gates.has(message.id));
    assert.equal((await f.request("/admin/users")).status,403);
    const key=await(await f.request("/account/keys","POST",{name:"laptop"})).json() as {id:string;token:string};
    assert.equal((await f.request(`/account/keys/${key.id}`,"DELETE",undefined,"key-b")).status,404);
    const response=await f.request(`/sessions/${session.id}/events`,"GET",undefined,key.token),reader=response.body!.getReader();await reader.read();
    assert.equal((await f.request(`/account/keys/${key.id}`,"DELETE")).status,200);
    try{while(!(await reader.read()).done){}}catch{}finally{reader.releaseLock();}
    assert.equal((await f.store.message(message.id))!.status,"running");
    assert.equal((await f.request("/admin/users/a","PATCH",{disabled:true},"key-admin")).status,200);
    assert.equal((await f.store.session(session.id))!.environment,"closed");assert.ok(f.closes()>0);
    assert.equal((await f.request("/account")).status,401);
    assert.equal((await f.request("/admin/users/a","PATCH",{disabled:false},"key-admin")).status,200);
    assert.equal((await f.request("/account")).status,401); // 重新启用也不会复活已撤销的密钥。

    assert.equal((await f.request("/admin/users/admin","PATCH",{disabled:true},"key-admin")).status,409);
  }finally{await f.clean();}
});

test("wallet API is owner scoped and admin gifts/settings are protected", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/admin/wallet")).status, 403);
    assert.equal((await f.request("/admin/wallet/settings", "PUT", { signupYuan: 20, plusYuan: 15 })).status, 403);
    assert.equal((await f.request("/admin/wallet/settings", "PUT", { signupYuan: 20, plusYuan: 15 }, "key-admin")).status, 200);
    const before = await (await f.request("/wallet")).json();
    assert.equal(before.available, 10_000_000);
    const gift = { id: randomUUID(), userIds: ["a"], amountYuan: "2.5", note: "fixture gift" };
    assert.equal((await f.request("/admin/wallet/gifts", "POST", gift)).status, 403);
    assert.equal((await f.request("/admin/wallet/gifts", "POST", gift, "key-admin")).status, 200);
    assert.equal((await f.request("/admin/wallet/gifts", "POST", gift, "key-admin")).status, 200);
    assert.equal((await (await f.request("/wallet")).json()).available, 12_500_000);
    assert.equal((await (await f.request("/wallet", "GET", undefined, "key-b")).json()).available, 10_000_000);
    assert.equal((await f.request("/admin/wallet/users/b")).status, 403);
  } finally { await f.clean(); }
});

test("workspace soft limit uses real bytes and no symlink following; upload retries remain idempotent at limit",async()=>{
  const f=await fixture();try{
    const session=await f.manager.create("a","files");await f.real.store.prepare(session.id);
    const text="hello", hash=createHash("sha256").update(text).digest("hex"),id=randomUUID();
    await f.manager.identity.update("a",{limits:{...defaultLimits,workspaceBytes:5}});
    const upload=()=>fetch(`${f.origin}/api/sessions/${session.id}/files/uploads/${id}?name=a.txt`,{method:"PUT",headers:{Authorization:"Bearer key-a","Content-Type":"application/octet-stream","X-Content-Sha256":hash},body:text});
    assert.equal((await upload()).status,201);assert.equal((await upload()).status,200);
    await writeFile(join(f.root,"secret"),"x".repeat(10000));await symlink(join(f.root,"secret"),join(f.root,session.id,"workspace/secret"));
    assert.equal(await f.files.bytes([session.id],AbortSignal.timeout(5000)),5);
    assert.equal((await f.request(`/sessions/${session.id}/messages`,"POST",{clientMessageId:randomUUID(),text:"blocked"})).status,413);
    const account=await(await f.request("/account")).json() as {workspaceBytes:number};assert.equal(account.workspaceBytes,5);
  }finally{await f.clean();}
});

test("cumulative estimates deduplicate and survive reopen; legacy history/zeroed failure never fabricate delta",async()=>{
  const f=await fixture();try{
    const s=await f.manager.create("a","cost"),store=f.manager.usage;
    await store.record("a",s.id,"one","runner1",1,{input_tokens:10,output_tokens:20});
    await store.record("a",s.id,"one","runner1",1);await store.record("a",s.id,"two","runner1",1.5);
    await new UsageStore(f.store.db).record("a",s.id,"three","runner2",2);
    assert.equal((await store.summary("a")).estimatedUsd,2);assert.equal((await store.summary("a")).mainInputTokens,10);
    await store.record("a",s.id,"error","runner2",0);await store.record("a",s.id,"four","runner2",2.2);
    assert.equal((await store.summary("a")).estimatedUsd,2.2);assert.equal((await store.summary("a")).observedResults,5);
    const old=await f.manager.create("b","legacy"),{message:msg}=await f.store.accept(old.id,randomUUID(),"old");await f.store.transition(msg.id,"succeeded");
    await store.record("b",old.id,"new","runner",10);await store.record("b",old.id,"next","runner",11);
    assert.equal((await store.summary("b")).estimatedUsd,1);assert.equal((await store.summary("b")).measuredMessages,1);
  }finally{await f.clean();}
});

test("existing owners and keys stay usable after restart; restored manager keeps active recovery occupancy",async()=>{
  const f=await fixture();try{
    const s=await f.manager.create("a","old"),{message:m}=await f.store.accept(s.id,randomUUID(),"original");await f.store.environment(s.id,"reconciling");
    const reopened=new SessionManager(f.store,{open:async()=>{throw new Error("must not execute");}},"fixture");
    assert.equal((await reopened.identity.user("a"))!.id,"a");assert.equal((await reopened.counts("a")).tasks,1);assert.equal((await reopened.counts("a")).environments,1);
    assert.equal((await f.store.message(m.id))!.text,"original");
    await f.store.transition(m.id,"interrupted");await f.store.environment(s.id,"closed");assert.equal((await reopened.counts("a")).tasks,0);
  }finally{await f.clean();}
});

test("fixed HTTPS origin controls browser writes and Secure cookies without trusting forwarded headers", async()=>{
  const f=await fixture();let server:ReturnType<typeof createApi>|undefined;
  try{
    server=createApi(f.manager,f.real,f.files,{origin:"https://harbor.example"});
    await new Promise<void>(done=>server!.listen(0,"127.0.0.1",done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const login=await fetch(url+"/api/auth/login",{method:"POST",headers:{Origin:"https://harbor.example","X-Harbor-Client":"web","Content-Type":"application/json"},body:JSON.stringify({accessKey:"key-a"})});
    assert.equal(login.status,200);assert.match(login.headers.get("set-cookie")!,/Secure/);
    assert.equal((await fetch(url+"/api/auth/login",{method:"POST",headers:{Origin:"https://attacker.example","X-Forwarded-Host":"attacker.example","X-Forwarded-Proto":"https","X-Harbor-Client":"web","Content-Type":"application/json"},body:JSON.stringify({accessKey:"key-a"})})).status,403);
  }finally{if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}await f.clean();}
});

test("identity records and Cookie survive actual database close/reopen; revoked key stays revoked",async()=>{
  const database=await testDatabase();
  try{
    let identities=new IdentityStore(database.db);
    await identities.ensure("person");await identities.login(tokenHash("cookie-token"),"person",Date.now()+60000);
    const key=await identities.createKey("person","cli");await identities.revokeKey("person",key.id);
    // 关闭连接池后再建立新连接，确认状态在数据库而不是进程内存。
    await database.pool.end();
    const reopened=await database.reopen();
    identities=new IdentityStore(reopened.db);
    assert.equal((await identities.session(tokenHash("cookie-token"))).userId,"person");await assert.rejects(identities.key(key.token),code("UNAUTHORIZED"));
    await identities.update("person",{disabled:true});await assert.rejects(identities.session(tokenHash("cookie-token")),code("UNAUTHORIZED"));
    await reopened.pool.end();
  }finally{await database.close();}
});


test("admin capabilities come from authenticated identity; pending queue includes old unknowns and resolves only once", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await (await f.request("/auth/me")).json()).capabilities, { managePlatform: false });
    assert.deepEqual((await (await f.request("/auth/me", "GET", undefined, "key-admin")).json()).capabilities, { managePlatform: true });
    const forged = await fetch(f.origin + "/api/admin/wallet/requests?userId=admin", { headers: { Authorization: "Bearer key-a", "X-Harbor-User": "admin" } });
    assert.equal(forged.status, 403);
    assert.equal((await f.request("/admin/wallet/requests")).status, 403);
    const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    // Old unknowns must remain discoverable even after 100 newer settled calls.
    await f.database.db.insert(walletRequests).values(Array.from({ length: 160 }, (_, i) => ({
      id: randomUUID(), userId: "a", sessionId: "fixture", deploymentId: "fixture", versionId: "fixture", priceVersionId: "fixture", modelName: "Fixture",
      price, reserved: 0, state: i < 55 ? "unknown" : "settled", note: "fixture metadata", createdAt: i + 1,
    })));
    const wallet = new WalletService(f.database.db);
    assert.equal((await wallet.summary("a")).requests.some(r => r.state === "unknown"), false);
    const first = await (await f.request("/admin/wallet/requests", "GET", undefined, "key-admin")).json();
    assert.equal(first.total, 55); assert.equal(first.requests.length, 50); assert.equal(first.nextOffset, 50);
    assert.equal(first.requests[0].createdAt, 1);
    assert.deepEqual(Object.keys(first.requests[0]).sort(), ["createdAt", "id", "modelName", "note", "reserved", "userId"]);
    const second = await (await f.request("/admin/wallet/requests?offset=50", "GET", undefined, "key-admin")).json();
    assert.equal(second.requests.length, 5); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.requests, ...second.requests].map(r => r.id)).size, 55);
    assert.equal((await f.request("/admin/wallet/requests?offset=-1", "GET", undefined, "key-admin")).status, 400);
    const reserved = await wallet.reserve("b", "fixture", { deploymentId: "fixture", versionId: "fixture", priceVersionId: "fixture", name: "Fixture", price });
    await wallet.unknown(reserved.id);
    const path = `/admin/wallet/requests/${reserved.id}/resolve`;
    assert.equal((await f.request(path, "POST", { amountYuan: 0, note: "checked" })).status, 403);
    assert.equal((await f.request(path, "POST", { amountYuan: 11, note: "too much" }, "key-admin")).status, 400);
    assert.equal((await f.request(path, "POST", { amountYuan: 0, note: "" }, "key-admin")).status, 400);
    assert.equal((await f.request(path, "POST", { amountYuan: 1, note: "fixture checked" }, "key-admin")).status, 200);
    assert.equal((await f.request(path, "POST", { amountYuan: 1, note: "fixture checked" }, "key-admin")).status, 200);
    assert.equal((await wallet.summary("b")).available, 9_000_000);
    assert.equal((await wallet.summary("b")).reserved, 0);
    for (const page of ["/admin", "/admin/models", "/admin/users", "/admin/requests", "/settings/account"]) {
      const response = await fetch(f.origin + page); assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/);
    }
    assert.equal((await fetch(f.origin + "/admin/secrets")).status, 404);
  } finally { await f.clean(); }
});
