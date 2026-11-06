import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import { IdentityStore } from "../src/service/identity/store.js";
import { WalletService } from "../src/service/wallet/service.js";
import { createInferenceRouter } from "../src/service/wallet/proxy.js";
import { LlmService } from "../src/service/llm/service.js";
import { McpSecrets } from "../src/service/mcp/secrets.js";
import { llmBindings, llmDeployments, llmDeploymentPrices, llmModelVersions } from "../src/service/db/schema/index.js";
import type { TracingService } from "../src/service/tracing/service.js";

test("wallet proxy hides gateway keys, forwards SSE, bills each call and preserves unknown charges", async () => {
  const d = await testDatabase(), root = await mkdtemp(join(tmpdir(), "ah-wallet-proxy-"));
  const identity = new IdentityStore(d.db), wallet = new WalletService(d.db);
  let calls = 0, mode = "ok";
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, "Bearer real-gateway-key"); assert.equal(body.model, "fixture-alias");
    assert.equal(req.headers.langfuse_trace_user_id, "trusted-owner");
    assert.equal(body.litellm_metadata, undefined);
    assert.equal(body["no-log"], undefined);
    assert.deepEqual(body.metadata, { user_id: "native-user" });
    calls++;
    if (mode === "budget") { res.writeHead(422, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Budget has been exceeded! User=fixture" } })); return; }
    if (mode === "rate") { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } })); return; }
    if (mode === "json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}\n\n');
    if (mode === "hold") return;
    if (mode === "ok") {
      res.write('data: {"type":"message_delta","usage":{"output_tokens":20}}\n\n');
      res.write('data: {"type":"message_stop"}\n\n');
    }
    res.end();
  });
  await new Promise<void>(r => upstream.listen(0,"127.0.0.1",r));
  const url = 'http://127.0.0.1:'+(upstream.address() as any).port;
  const llm = new LlmService(d.db, root, { managementUrl: url, inferenceUrl: url, masterKey: "master", walletProxyUrl: "http://example.invalid/inference" });
  const tracing = { async prepare(_requestId: string, sessionId: string, ownerId: string) {
    assert.equal(sessionId, "session"); assert.equal(ownerId, "a");
    return { traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01", langfuse_trace_user_id: "trusted-owner" };
  } } as TracingService;
  const app = express(); app.use('/inference', createInferenceRouter(llm, wallet, tracing));
  const server = createServer(app); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  try {
    await identity.ensure('a');
    const p = await llm.addProvider({ name:'fixture', apiBase:url, apiKey:'fixture', format:'anthropic' }, 'admin');
    const deploymentId=randomUUID(), versionId=randomUUID(), priceId=randomUUID(), bindingId=randomUUID(), token='ahw-'+randomUUID();
    const now=Date.now();
    const secret=await new McpSecrets(join(root,'llm')).seal({token:'real-gateway-key',walletToken:token,logicalModel:'ah-session-model'});
    await d.db.transaction(async tx => {
      await tx.insert(llmModelVersions).values({id:versionId,deploymentId,providerId:p.id,upstreamModel:'fixture',routeName:'fixture-alias',params:{},tools:true,streaming:true,capabilities:{},digest:'fixture',state:'ready',lastSyncedAt:now,createdBy:'test',createdAt:now});
      await tx.insert(llmDeployments).values({id:deploymentId,name:'Fixture',description:'',currentVersionId:versionId,enabled:true,allowedUsers:['a'],archivedAt:null,createdAt:now,updatedAt:now});
      await tx.insert(llmDeploymentPrices).values({id:priceId,deploymentId,input:1000000,output:2000000,cacheRead:1000000,cacheWrite:1000000,effectiveFrom:now,createdBy:'test',createdAt:now});
      await tx.insert(llmBindings).values({id:bindingId,sessionId:'session',ownerId:'a',deploymentId,versionId,secret,state:'active',expiresAt:null,walletTokenHash:createHash('sha256').update(token).digest('hex')});
    });
    const invoke=(key=token,model='ah-session-model',signal?: AbortSignal)=>fetch(origin+'/inference/v1/messages',{method:'POST',signal,headers:{Authorization:'Bearer '+key,'content-type':'application/json',langfuse_trace_user_id:'forged-owner',traceparent:'forged'},body:JSON.stringify({model,max_tokens:20,stream:true,messages:[{role:'user',content:'hi'}],metadata:{user_id:'native-user',trace_user_id:'forged-owner'},litellm_metadata:{langfuse_host:'https://forged.invalid'},'no-log':true})});
    assert.equal((await invoke('real-gateway-key')).status,401);
    assert.equal((await invoke(token,'another-model')).status,400);
    assert.equal(calls,0);
    await d.db.delete(llmDeploymentPrices).where(eq(llmDeploymentPrices.id,priceId));
    await assert.rejects(llm.select('a',deploymentId), (e: any) => e.code === 'PRICE_REQUIRED');
    const missingPrice = await invoke();
    assert.equal(missingPrice.status,400, 'missing configuration must not trigger native HTTP 409 retries');
    assert.match(await missingPrice.text(), /管理员尚未设置/);
    assert.equal(calls,0);
    assert.equal((await wallet.summary('a')).reserved,0);
    await d.db.insert(llmDeploymentPrices).values({id:randomUUID(),deploymentId,input:0,output:0,cacheRead:0,cacheWrite:0,effectiveFrom:now,createdBy:'test',createdAt:now});
    assert.equal((await llm.select('a',deploymentId)).deploymentId,deploymentId, 'explicit free prices are valid');
    await d.db.insert(llmDeploymentPrices).values({id:randomUUID(),deploymentId,input:1000000,output:2000000,cacheRead:1000000,cacheWrite:1000000,effectiveFrom:now+1,createdBy:'test',createdAt:now+1});
    const response=await invoke();assert.equal(response.status,200);assert((await response.text()).includes('message_stop'));
    assert.equal((await wallet.summary('a')).spent,140);
    mode='json';await(await invoke()).text();assert.equal((await wallet.summary('a')).spent,280);
    mode='truncated';await(await invoke()).text();
    assert.equal((await wallet.summary('a')).requests[0].state,'unknown');
    assert.equal((await invoke()).status,429);assert.equal(calls,3);
    const r=(await wallet.summary('a')).requests[0];
    await wallet.settle(r.id,undefined,{amount:0,note:'fixture no usage confirmed',actor:'admin'});
    mode='budget';
    assert.equal((await invoke()).status,402);
    assert.equal((await wallet.summary('a')).reserved,0,'pre-dispatch budget denial releases the RMB hold');
    assert.equal((await wallet.summary('a')).spent,280);
    mode='rate';
    assert.equal((await invoke()).status,429);
    assert.equal((await wallet.summary('a')).reserved,0,'rate-limit denial must not strand a hold');
    mode='hold';
    const abort=new AbortController(), interrupted=await invoke(token,'ah-session-model',abort.signal);
    await interrupted.body!.getReader().read();
    assert.ok((await wallet.summary('a')).reserved>0);
    abort.abort();
    for(let i=0;i<100 && (await wallet.summary('a')).reserved>0;i++) await new Promise(r=>setTimeout(r,10));
    const released=await wallet.summary('a');
    assert.equal(released.reserved,0);
    assert.equal(released.spent,280);
    assert.equal(released.requests[0].state,'settled');
    assert.equal(released.requests[0].actual,null);
    assert.match(released.requests[0].note,/平台承担/);
    mode='ok';await(await invoke()).text();
    assert.equal((await wallet.summary('a')).spent,420,'a new request succeeds immediately after cancellation');
    await d.db.update(llmBindings).set({state:'revoked'}).where(eq(llmBindings.id,bindingId));
    assert.equal((await invoke()).status,401);
  } finally {
    server.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);
    await d.close();await rm(root,{recursive:true,force:true});
  }
});
