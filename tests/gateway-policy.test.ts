import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./pg.js";
import { IdentityStore } from "../src/service/identity/store.js";
import { LlmService } from "../src/service/llm/service.js";
import { readGatewayPolicy, type GatewayPolicy } from "../src/service/llm/policy.js";
import { GatewayUsageSync, gatewayTokenUsage } from "../src/service/llm/usage-sync.js";
import { gatewayUsageEvents, gatewaySyncState, wallets } from "../src/service/db/schema/index.js";
import { estimateRequest } from "../src/service/wallet/proxy.js";
const policy: GatewayPolicy = { userRpmLimit: 60, models: { fixture: { timeoutSeconds: 180,
  inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheReadCostPerToken: 1e-7, cacheWriteCostPerToken: 1e-6 } } };

test("gateway policy validates costs and normalizes inclusive cache token counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-gateway-policy-")), path = join(dir, "policy.json");
  try {
    await writeFile(path, JSON.stringify(policy)); assert.deepEqual(readGatewayPolicy(path), policy);
    await writeFile(path, JSON.stringify({ ...policy, userRpmLimit: 0 })); assert.throws(() => readGatewayPolicy(path));
    await writeFile(path, JSON.stringify({ userRpmLimit: 60, models: {} })); assert.deepEqual(readGatewayPolicy(path), { userRpmLimit: 60, models: {} });
    assert.deepEqual(gatewayTokenUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } }), { input: 40, output: 20, cacheRead: 60, cacheWrite: 0 });
    assert.equal(gatewayTokenUsage({ prompt_tokens: 10, completion_tokens: 1, cache_read_input_tokens: 20 }), null);
    assert.ok(estimateRequest({ max_tokens: 100, messages: [{ role: "user", content: "hello" }] }, { input: 2_000_000, output: 8_000_000, cacheRead: 0, cacheWrite: 0 }) > 800);
    assert.throws(() => estimateRequest({ max_tokens: 0 }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("gateway baseline binds users, clears optional limits, confirms pricing and projects usage without charging twice", async () => {
  const d = await testDatabase(), root = await mkdtemp(join(tmpdir(), "ah-gateway-baseline-"));
  const deployments: any[] = [], keys = new Map<string, any>(), users = new Map<string, any>();
  let logs: any[] = [], unavailable = false, dropPrice = false;
  const remote = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer master");
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url!, "http://localhost");
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, code = 200) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    if (path.pathname === "/model/info") return send({ data: deployments });
    if (path.pathname === "/model/new") { deployments.push(body); return send({}); }
    if (path.pathname === "/model/update") {
      const row = deployments.find(x => x.model_info.id === body.model_info.id);
      row.model_info = { ...row.model_info, ...body.model_info }; row.litellm_params = { ...row.litellm_params, ...body.litellm_params };
      if (dropPrice) row.model_info.input_cost_per_token = null;
      return send({});
    }
    if (path.pathname === "/user/info") { const user = users.get(path.searchParams.get("user_id")!); return send(user ? { user_info: user } : {}, user ? 200 : 404); }
    if (path.pathname === "/user/new") { assert.equal(body.auto_create_key, false); users.set(body.user_id, body); return send(body); }
    if (path.pathname === "/user/update") { users.set(body.user_id, { ...users.get(body.user_id), ...body }); return send(body); }
    if (path.pathname === "/key/generate") { keys.set(body.key, { ...body, expires: null, status: "active" }); return send(body); }
    if (path.pathname === "/key/update") { Object.assign(keys.get(body.key), body); return send({}); }
    if (path.pathname === "/key/info") {
      const row = [...keys].find(([key]) => createHash("sha256").update(key).digest("hex") === path.searchParams.get("key"))?.[1];
      return send(row ? { info: row } : {}, row ? 200 : 404);
    }
    if (path.pathname === "/spend/logs/v2") {
      if (unavailable) return send({}, 503);
      assert.ok(path.searchParams.has("start_date"));
      return send({ data: logs, total_pages: 0 });
    }
    send({}, 404);
  });
  await new Promise<void>(r => remote.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(remote.address() as any).port}`;
  const llm = new LlmService(d.db, root, { managementUrl: url, inferenceUrl: url, masterKey: "master", policy });
  try {
    await new IdentityStore(d.db).ensure("alice");
    const provider = await llm.addProvider({ name: "fixture", apiBase: url, apiKey: "upstream", format: "anthropic_compatible" }, "admin");
    const created = await llm.createDeployment({ name: "fixture", providerId: provider.id, upstreamModel: "fixture", tools: true, streaming: true }, "admin");
    const model = { id: created.deployment.id, versionId: created.versions[0].id, alias: created.versions[0].routeName };
    assert.equal(created.versions[0].state, "ready");
    await llm.applyBaseline();
    const first = await llm.runtime({ id: "session", ownerId: "alice", modelSnapshot: await llm.select("alice", model.id) });
    assert.equal(users.get("harbor:alice").rpm_limit, 60);
    assert.equal(users.get("harbor:alice").tpm_limit, null);
    const key = keys.get(first.token);
    assert.equal(key.user_id, "harbor:alice");
    assert.equal(key.max_parallel_requests, null); assert.equal(key.budget_duration, null);
    key.tpm_limit = 1; key.max_parallel_requests = 1; key.budget_duration = "30d";
    await llm.runtime({ id: "session", ownerId: "alice", modelSnapshot: await llm.select("alice", model.id) });
    assert.equal(key.tpm_limit, null); assert.equal(key.max_parallel_requests, null); assert.equal(key.budget_duration, null);
    assert.deepEqual(deployments[0].model_info.supported_endpoints, ["/v1/messages", "/v1/chat/completions"]);
    assert.equal(deployments[0].litellm_params.timeout, 180);
    const hash = createHash("sha256").update(first.token).digest("hex");
    logs = [{ api_key: hash, request_id: "provider-1", litellm_call_id: "call-1", model: "openai/fixture", status: "success", spend: 0.000086,
      startTime: new Date().toISOString(), metadata: { usage_object: { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 60 },
        cost_breakdown: { input_cost: 0.00004, output_cost: 0.00004, cache_read_cost: 0.000006, secret: "do not store" } } }];
    const sync = new GatewayUsageSync(llm), before = (await d.db.select().from(wallets))[0].balance;
    await sync.run(); await sync.run();
    const events = await d.db.select().from(gatewayUsageEvents);
    assert.equal(events.length, 1); assert.equal(events[0].ownerId, "alice"); assert.equal(events[0].sessionId, "session");
    assert.equal(events[0].pricingKnown, true); assert(!JSON.stringify(events[0]).includes("do not store"));
    assert.equal((await d.db.select().from(wallets))[0].balance, before, "projection never double-charges wallets");
    const persistentUsage = await llm.usage("session", "alice");
    assert.equal(persistentUsage.knownUsd, 0.000086);
    assert.equal(persistentUsage.complete, true);
    logs.push({ ...logs[0], request_id: "provider-2", metadata: structuredClone(logs[0].metadata) });
    await sync.run();
    assert.equal((await d.db.select().from(gatewayUsageEvents)).length, 2, "distinct provider attempts are not collapsed into one logical call");
    assert.equal((await llm.usage("session", "alice")).knownUsd, 0.000172);
    logs[0].metadata.cost_breakdown.input_cost = 0; await sync.run();
    assert.equal((await d.db.select().from(gatewayUsageEvents))[0].pricingKnown, false, "nonzero cache-only spend is not complete pricing");
    const checkpoint = (await d.db.select().from(gatewaySyncState))[0].scannedUntil;
    unavailable = true; await assert.rejects(sync.run());
    assert.equal((await d.db.select().from(gatewaySyncState))[0].scannedUntil, checkpoint);
    await llm.createPrice(model.id, { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 }, "admin");
    users.get("harbor:alice").spend = 1;
    const billing = new LlmService(d.db, root, { managementUrl: url, inferenceUrl: url, masterKey: "master", policy, walletProxyUrl: "http://example.invalid/inference" });
    await billing.syncUser("alice");
    assert.equal(users.get("harbor:alice").max_budget, 3.5, "USD risk ceiling uses the strictest configured RMB/USD unit ratio");
    const missing = await llm.createVersion(created.deployment.id, {
      upstreamModel: "missing-cost",
      tools: true,
      streaming: true,
    }, "admin");
    const missingVersion = missing.versions.find((version) => version.upstreamModel === "missing-cost")!;
    await assert.rejects(
      () => llm.syncVersion(missingVersion.id),
      (e: any) => e.code === "MODEL_COST_REQUIRED",
    );
    dropPrice = true; await assert.rejects(llm.syncVersion(model.versionId), (e: any) => e.code === "MODEL_POLICY_UNCONFIRMED");
  } finally {
    remote.closeAllConnections(); await new Promise<void>(r => remote.close(() => r()));
    await d.close(); await rm(root, { recursive: true, force: true });
  }
});
