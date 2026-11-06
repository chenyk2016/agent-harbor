/** PostgreSQL + HTTP管理契约；fixture不证明真实LiteLLM或模型质量。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import { LlmService } from "../src/service/llm/service.js";
import { llmBindings, llmProviderSecrets, llmProviders } from "../src/service/db/schema/llm.js";
import { gatewayUsageEvents, messages, walletLedger, walletRequests } from "../src/service/db/schema/index.js";
import { Controller } from "../src/runtime/controller.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { createApi } from "../src/service/http-api.js";
import { tokenHash } from "../src/service/auth.js";
import type { GatewayConnection } from "../src/shared/llm.js";

test("LLM: deployment versions, scoped catalogs, per-message choice, key lifecycle and restart", async () => {
  const database = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-llm-"));
  const deployed: Array<any> = [],
    keys = new Map<string, any>();
  let failDelete = false,
    dropGenerate = false, failUpdate = false, failModelUpdate = false;
  let modelDeleteFailure: string | undefined;
  let executions = 0;
  const remote = createServer(async (req, res) => {
    if (new URL(req.url!, "http://local").pathname === "/models") {
      if (req.headers.authorization !== "Bearer fixture-upstream-secret") {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: [
          { id: "fixture-a" },
          { id: "fixture-b", name: "Fixture B" },
        ],
      }));
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-master") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://local");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/model/info")
      res.end(JSON.stringify({ data: deployed }));
    else if (url.pathname === "/model/new") {
      deployed.push(body);
      res.end("{}");
    } else if (url.pathname === "/model/update") {
      if (failModelUpdate) {
        res.writeHead(503);
        res.end("{}");
        return;
      }
      const row = deployed.find((item) => item.model_info?.id === body.model_info?.id);
      if (!row) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      row.model_info = { ...row.model_info, ...body.model_info };
      row.litellm_params = { ...row.litellm_params, ...body.litellm_params };
      res.end("{}");
    } else if (url.pathname === "/model/delete") {
      if (body.id === modelDeleteFailure) {
        res.writeHead(503).end("{}");
      } else {
        const index = deployed.findIndex(row => row.model_info.id === body.id);
        if (index !== -1) deployed.splice(index, 1);
        res.end("{}");
      }
    } else if (url.pathname === "/key/info") {
      const info = [...keys].find(
        ([key]) =>
          createHash("sha256").update(key).digest("hex") ===
          url.searchParams.get("key"),
      )?.[1];
      if (!info) {
        res.writeHead(404);
        res.end("{}");
      } else res.end(JSON.stringify({ info }));
    } else if (url.pathname === "/key/generate") {
      keys.set(body.key, { ...body, expires: body.duration === null ? null : "2099-01-01T00:00:00Z", status: "active", spend: 0 });
      if (dropGenerate) {
        dropGenerate = false;
        res.destroy();
      } else res.end(JSON.stringify(body));
    } else if (url.pathname === "/key/update") {
      if (failUpdate) { res.writeHead(503); res.end("{}"); }
      else if (!keys.has(body.key)) { res.writeHead(404); res.end("{}"); }
      else {
        Object.assign(keys.get(body.key), body);
        if (body.duration === null) {
          keys.get(body.key).expires = null;
          if (keys.get(body.key).status === "expired") keys.get(body.key).status = "active";
        }
        res.end("{}");
      }
    } else if (url.pathname === "/key/delete") {
      if (failDelete) {
        res.writeHead(503);
        res.end("{}");
      } else {
        for (const k of body.keys)
          if (keys.has(k)) keys.get(k).status = "deleted";
        res.end("{}");
      }
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(remote.address() as { port: number }).port}`;
  const service = new LlmService(database.db, root, {
    managementUrl: url,
    inferenceUrl: url,
    masterKey: "fixture-master",
  });
  const runtime: GatewayConnection[] = [];
  const notices = new Map<string, (notice: any) => Promise<void>>();
  const controller = new Controller(root),
    store = new ServiceStore(database.db);
  const manager = new SessionManager(
    store,
    {
      open: async (_id, _token, options) => {
        runtime.push(options!.gateway!);
        notices.set(_id, options!.onRuntimeNotice!);
        return {
          run: async () => { executions++; return { status: "succeeded", stopped: false } as any; },
          close: async () => {},
          terminate: async () => {},
        };
      },
    },
    "legacy",
  );
  await manager.identity.importKeys(
    ["a", "b"].map((userId) => ({
      userId,
      tokenHash: tokenHash("fixture-" + userId),
    })),
  );
  const server = createApi(
    manager,
    controller,
    undefined,
    { adminUsers: ["a"] },
    undefined,
    undefined,
    undefined,
    service,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (
    path: string,
    method = "GET",
    body?: unknown,
    user = "a",
  ) =>
    fetch(origin + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer fixture-" + user,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await api("/admin/llm", "GET", undefined, "b")).status, 403);
    const p = await service.addProvider({
      name: "Provider",
      apiBase: "https://example.invalid/v1",
      format: "openai_chat",
      apiKey: "fixture-upstream-secret",
    }, "a");
    assert(!JSON.stringify(p).includes("fixture-upstream-secret"));
    const [stored] = await database.db.select().from(llmProviders);
    assert(!JSON.stringify(stored).includes("fixture-upstream-secret"));
    const [storedSecret] = await database.db.select().from(llmProviderSecrets);
    assert(!storedSecret.secret.includes("fixture-upstream-secret"));
    assert.equal((await api("/admin/llm/providers", "POST", {
      name: "Denied", apiBase: "https://example.invalid", format: "openai_chat", apiKey: "x",
    }, "b")).status, 403);
    // 预置目录与模型发现：只返回公开信息，不泄露密钥。
    assert.equal((await api("/admin/llm/presets", "GET", undefined, "b")).status, 403);
    const presets = await (await api("/admin/llm/presets")).json();
    assert(presets.presets.length > 5);
    assert(!JSON.stringify(presets).includes("apiKey"));
    const discovery = await service.addProvider({
      name: "Discovery",
      apiBase: url,
      format: "openai_chat",
      apiKey: "fixture-upstream-secret",
    }, "a");
    const discovered = await service.discoverModels(discovery.id);
    assert.deepEqual(discovered.models.map((model) => model.id), ["fixture-a", "fixture-b"]);
    assert.equal(discovered.models[1].displayName, "Fixture B");
    const wrongKey = await service.addProvider({
      name: "Wrong key",
      apiBase: url,
      format: "openai_chat",
      apiKey: "wrong",
    }, "a");
    await assert.rejects(
      () => service.discoverModels(wrongKey.id),
      (error: any) => error.code === "DISCOVERY_UNAUTHORIZED",
    );

    const createdA = await service.createDeployment({
      providerId: p.id,
      name: "Model A",
      upstreamModel: "target-a",
      tools: true,
      streaming: true,
      allowedUsers: ["a"],
    }, "a");
    const a = {
      id: createdA.deployment.id,
      versionId: createdA.versions[0].id,
      routeName: createdA.versions[0].routeName,
    };
    assert.equal(createdA.versions[0].state, "ready");
    const createdB = await service.createDeployment({
      providerId: p.id,
      name: "Model B",
      upstreamModel: "target-b",
      tools: true,
      streaming: true,
    }, "a");
    const b = {
      id: createdB.deployment.id,
      versionId: createdB.versions[0].id,
      routeName: createdB.versions[0].routeName,
    };
    assert.equal(deployed[0].litellm_params.model, "custom_openai/target-a");
    assert.equal(deployed[0].model_info.id, a.versionId);
    assert.equal(deployed[0].model_name, a.routeName);
    await service.syncDeployment(a.id);
    assert.equal(deployed.length, 2, "read-back prevents duplicate deployment");
    // 后台成本：写入 LiteLLM、共享给同供应商+上游的版本、历史只追加。
    const costed = await service.createDeployment({
      providerId: p.id,
      name: "Costed",
      upstreamModel: "target-cost",
      tools: true,
      streaming: true,
      cost: {
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 0.6,
        cacheReadUsdPerMillion: 0.03,
        cacheWriteUsdPerMillion: 0.3,
        timeoutSeconds: 120,
      },
    }, "a");
    const costedVersion = costed.versions[0];
    assert.equal(costedVersion.cost?.source, "database");
    const costedRemote = deployed.find((row) => row.model_info?.id === costedVersion.id);
    assert.equal(costedRemote.litellm_params.input_cost_per_token, 3e-7);
    assert.equal(costedRemote.litellm_params.timeout, 120);
    const beforeHistory = await service.costHistory(costedVersion.id);
    assert.equal(beforeHistory.length, 1);
    await service.publishCost(costedVersion.id, {
      inputUsdPerMillion: 0.5,
      outputUsdPerMillion: 0.9,
      cacheReadUsdPerMillion: 0.05,
      cacheWriteUsdPerMillion: 0.5,
      timeoutSeconds: 90,
    }, "a");
    assert.equal((await service.costHistory(costedVersion.id)).length, 2);
    assert.equal(
      deployed.find((row) => row.model_info?.id === costedVersion.id).litellm_params.input_cost_per_token,
      5e-7,
    );
    assert.equal(
      deployed.find((row) => row.model_info?.id === costedVersion.id).litellm_params.timeout,
      90,
    );
    // 密钥轮换失败时旧密钥继续有效；成功后才退休旧密钥。
    failModelUpdate = true;
    await assert.rejects(() => service.rotateProviderSecret(p.id, { apiKey: "rotated-secret" }, "a"));
    assert.equal(
      (await database.db.select().from(llmProviderSecrets).where(eq(llmProviderSecrets.providerId, p.id))).length,
      1,
    );
    failModelUpdate = false;
    const rotated = await service.rotateProviderSecret(p.id, { apiKey: "rotated-secret" }, "a");
    assert.equal(rotated.secretVersion, 2);
    const secretRows = await database.db
      .select()
      .from(llmProviderSecrets)
      .where(eq(llmProviderSecrets.providerId, p.id));
    assert.equal(secretRows.length, 2);
    assert.equal(secretRows.filter((row) => row.retiredAt !== null).length, 1);
    assert(deployed.every((row) => row.litellm_params.api_key === "rotated-secret"));
    // 供应商名称和地址可维护；地址变更会重写所有 ready 版本并读回。
    const renamed = await service.updateProvider(p.id, { name: "Renamed Provider" }, "a");
    assert.equal(renamed.name, "Renamed Provider");
    await service.updateProvider(p.id, { apiBase: "https://example.invalid/v2" }, "a");
    assert(deployed.every((row) => row.litellm_params.api_base === "https://example.invalid/v2"));
    failModelUpdate = true;
    await assert.rejects(() => service.updateProvider(p.id, { apiBase: "https://example.invalid/v3" }, "a"));
    assert.equal((await service.providerList()).find((row) => row.id === p.id)?.apiBase, "https://example.invalid/v2");
    assert(deployed.every((row) => row.litellm_params.api_base === "https://example.invalid/v2"));
    failModelUpdate = false;
    await assert.rejects(
      () => service.updateProvider(p.id, { format: "anthropic" }, "a"),
      (error: any) => error.code === "INVALID_MODEL_INPUT",
    );
    const catalogB = (await service.catalog("b")).models.map((m) => m.id);
    assert(catalogB.includes(b.id));
    assert(!catalogB.includes(a.id));
    assert.equal(
      (await api("/sessions", "POST", { deploymentId: a.id }, "b")).status,
      404,
    );
    assert.equal((await api(`/admin/llm/deployments/${a.id}`, "PATCH", { allowedUsers: ["b"] }, "b")).status, 403);
    assert.equal((await api(`/admin/llm/deployments/${a.id}`, "PATCH", { allowedUsers: ["b"] })).status, 200);
    assert.equal((await service.catalog("a")).models.some(m => m.id === a.id), false);
    assert.equal((await service.catalog("b")).models.some(m => m.id === a.id), true);
    assert.equal((await api(`/admin/llm/deployments/${a.id}`, "PATCH", { allowedUsers: [""] })).status, 400);
    assert.equal((await api(`/admin/llm/deployments/${a.id}`, "PATCH", { allowedUsers: ["a"] })).status, 200);
    assert.equal((await api(`/admin/llm/deployments/${a.id}`, "PATCH", { upstreamModel: "changed" })).status, 400);

    const req = { clientRequestId: randomUUID(), title: "A", deploymentId: a.id };
    const response = await api("/sessions", "POST", req);
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal(session.modelSnapshot.deploymentId, a.id);
    assert.equal(session.modelSnapshot.versionId, a.versionId);
    assert.equal(session.modelSnapshot.routeName, a.routeName);
    assert(!JSON.stringify(session).includes("secret"));
    assert.equal(
      (await (await api("/sessions", "POST", req)).json()).id,
      session.id,
    );
    assert.equal(
      (await api("/sessions", "POST", { ...req, deploymentId: b.id })).status,
      409,
    );
    await service.setDefault("a", b.id);
    assert.equal((await store.session(session.id))!.modelSnapshot!.deploymentId, a.id);
    const other = await (
      await api("/sessions", "POST", { title: "B", deploymentId: b.id }, "b")
    ).json();
    assert.equal(other.modelSnapshot.deploymentId, b.id);

    dropGenerate = true;
    await assert.rejects(() => service.runtime(session));
    const connection = await service.runtime(session);
    assert.equal(connection.model, "ah-session-model");
    assert.equal(keys.get(connection.token).expires, null);
    assert.deepEqual(keys.get(connection.token).models, [a.routeName]);
    assert.equal(keys.get(connection.token).aliases[connection.model], a.routeName);
    // 已过期旧绑定原地迁移；网关更新失败时不能把本地到期事实抹掉。
    const oldExpiry = Date.now() - 1000;
    await database.db.update(llmBindings).set({ expiresAt: oldExpiry }).where(eq(llmBindings.id, connection.bindingId));
    keys.get(connection.token).expires = new Date(oldExpiry).toISOString();
    keys.get(connection.token).status = "expired";
    keys.get(connection.token).spend = 2.5;
    failUpdate = true;
    await assert.rejects(() => service.runtime(session));
    assert.equal((await database.db.select().from(llmBindings).where(eq(llmBindings.id, connection.bindingId)))[0].expiresAt, oldExpiry);
    failUpdate = false;
    const pendingKey = keys.get(connection.token);
    keys.delete(connection.token);
    await assert.rejects(() => service.runtime(session));
    assert.equal(keys.has(connection.token), false, "uncertain update cannot recreate an externally deleted key");
    keys.set(connection.token, pendingKey);
    assert.deepEqual(await service.runtime(session), connection, "expiry migration preserves every Runner connection field");
    assert.equal(keys.get(connection.token).expires, null);
    assert.equal(keys.get(connection.token).spend, 2.5, "migration must not reset spend");
    assert.equal((await database.db.select().from(llmBindings).where(eq(llmBindings.id, connection.bindingId)))[0].expiresAt, null);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 25 * 60 * 60 * 1000;
      assert.deepEqual(await service.runtime(session), connection, "crossing 24h must not rotate credentials");
    } finally { Date.now = clock; }
    const otherConnection = await service.runtime(other);
    const remoteKey = keys.get(otherConnection.token);
    remoteKey.blocked = true;
    await assert.rejects(() => service.runtime(other));
    assert.equal(remoteKey.blocked, true, "never undo an external block");
    remoteKey.blocked = false;
    keys.delete(otherConnection.token);
    await assert.rejects(() => service.runtime(other));
    assert.equal(keys.has(otherConnection.token), false, "never recreate an externally deleted active key");
    keys.set(otherConnection.token, remoteKey);
    assert.equal(
      (await api(`/sessions/${session.id}/llm-usage`, "GET", undefined, "b"))
        .status,
      404,
    );
    const observed = await (
      await api(`/sessions/${session.id}/llm-usage`)
    ).json();
    assert.equal(observed.complete, false);
    assert.equal(observed.unknownCredentials, 1);
    assert.equal(observed.pricingKnown, false);
    for (const model of deployed)
      Object.assign(model.model_info, {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      });
    const freeSession = await (
      await api("/sessions", "POST", { title: "explicit free", deploymentId: a.id })
    ).json();
    await service.runtime(freeSession);
    assert.equal((await service.usage(freeSession.id, "a")).complete, true);
    assert.equal(
      (await service.usage(session.id, "a")).complete,
      false,
      "later pricing must not rewrite unpriced history",
    );

    assert.notEqual(connection.token, otherConnection.token);
    assert.equal(
      (
        await database.db
          .select()
          .from(llmBindings)
          .where(eq(llmBindings.sessionId, session.id))
      )[0].state,
      "active",
    );
    const sent = await api(`/sessions/${session.id}/messages`, "POST", {
      text: "hi",
      clientMessageId: randomUUID(),
    });
    assert.equal(sent.status, 202);
    for (let i = 0; i < 100 && !runtime.length; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(runtime[0].model, "ah-session-model");
    async function waitMessage(id: string) {
      for (let i = 0; i < 100; i++) {
        const m = await store.message(id);
        if (m && ["succeeded", "failed", "cancelled"].includes(m.status)) return m;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error("Message did not finish");
    }
    const first = await sent.json();
    assert.equal((await waitMessage(first.message.id)).status, "succeeded");
    const messageId = randomUUID();
    const switched = await api(`/sessions/${session.id}/messages`, "POST", {
      text: "switch", clientMessageId: messageId, deploymentId: b.id,
    });
    assert.equal(switched.status, 202);
    const next = await switched.json();
    const completed = await waitMessage(next.message.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.modelSnapshot?.deploymentId, b.id);
    assert.equal(completed.activatedModelSnapshot?.deploymentId, b.id);
    assert.equal((await store.session(session.id))!.modelSnapshot!.deploymentId, b.id);
    assert.equal(runtime.length, 1, "model change must not reopen the conversation");
    assert.equal((await service.runtime({ ...session, modelSnapshot: await service.select("a", b.id) })).token, connection.token);
    assert.equal(keys.get(connection.token).aliases[connection.model], b.routeName);
    assert.deepEqual(keys.get(connection.token).models, [b.routeName]);
    assert.equal(keys.get(otherConnection.token).aliases[otherConnection.model], b.routeName);
    assert.equal((await api(`/sessions/${session.id}/messages`, "POST", {
      text: "switch", clientMessageId: messageId, deploymentId: b.id,
    })).status, 200);
    assert.equal((await api(`/sessions/${session.id}/messages`, "POST", {
      text: "switch", clientMessageId: messageId, deploymentId: a.id,
    })).status, 409);
    const back = await (await api(`/sessions/${session.id}/messages`, "POST", {
      text: "back", clientMessageId: randomUUID(), deploymentId: a.id,
    })).json();
    assert.equal((await waitMessage(back.message.id)).activatedModelSnapshot?.deploymentId, a.id);
    assert.equal(runtime.length, 1);
    assert.equal(keys.get(connection.token).aliases[connection.model], a.routeName);
    const notice = notices.get(session.id)!;
    await notice({ type: "runner.event", event: { sessionId: session.id, runnerId: "background-fixture", seq: 1, type: "sdk.task", payload: { task_id: "bg-one", subtype: "task_started" } } });
    assert.equal((await api(`/sessions/${session.id}/messages`, "POST", {
      text: "blocked switch", clientMessageId: randomUUID(), deploymentId: b.id,
    })).status, 409, "active background task blocks route changes");
    await notice({ type: "runner.event", event: { sessionId: session.id, runnerId: "background-fixture", seq: 2, type: "sdk.task", payload: { task_id: "bg-one", subtype: "task_notification", status: "completed" } } });
    const failedSession = await (await api("/sessions", "POST", { title: "route failure", deploymentId: a.id })).json();
    await service.runtime(failedSession);
    const previousExecutions = executions;
    failUpdate = true;
    const failedMessage = await (await api(`/sessions/${failedSession.id}/messages`, "POST", {
      text: "must not execute", clientMessageId: randomUUID(), deploymentId: b.id,
    })).json();
    const failure = await waitMessage(failedMessage.message.id);
    assert.equal(failure.status, "failed");
    assert.equal(failure.activatedModelSnapshot, null);
    assert.equal(executions, previousExecutions, "uncertain route never sends user input");
    assert.equal((await store.session(failedSession.id))!.modelSnapshot!.deploymentId, a.id);
    failUpdate = false;

    // 稳定别名：切指针后，已有会话下一轮自动解析新版本，并记录版本替换事件。
    const v2Detail = await service.createVersion(a.id, {
      upstreamModel: "target-a2",
      tools: true,
      streaming: true,
    }, "a");
    const v2 = v2Detail.versions.find((version) => version.id !== a.versionId)!;
    assert.equal(v2.state, "ready");
    assert.equal((await service.deploymentDetail(a.id)).deployment.currentVersionId, a.versionId);
    await service.pointDeployment(a.id, v2.id, a.versionId, "a");
    assert.equal((await service.deploymentDetail(a.id)).deployment.currentVersionId, v2.id);
    const upgradedMessage = await (await api(`/sessions/${session.id}/messages`, "POST", {
      text: "follow the alias",
      clientMessageId: randomUUID(),
      deploymentId: a.id,
    })).json();
    const upgradedDone = await waitMessage(upgradedMessage.message.id);
    assert.equal(upgradedDone.modelSnapshot?.versionId, v2.id);
    assert.equal(upgradedDone.activatedModelSnapshot?.versionId, v2.id);
    assert.deepEqual(keys.get(connection.token).models, [v2.routeName]);
    const replaced = await store.events(session.id, 0, 1000);
    assert(replaced.some((event) => event.type === "model.replaced"));
    await service.setDefault("a", a.id);
    const newSession = await (await api("/sessions", "POST", { title: "v2", deploymentId: a.id })).json();
    assert.equal(newSession.modelSnapshot.versionId, v2.id);
    await service.pointDeployment(a.id, a.versionId, v2.id, "a");
    await assert.rejects(
      () => service.pointDeployment(a.id, v2.id, "stale", "a"),
      (error: any) => error.code === "DEPLOYMENT_VERSION_CONFLICT",
    );
    const rolledMessage = await (await api(`/sessions/${session.id}/messages`, "POST", {
      text: "follow the rollback",
      clientMessageId: randomUUID(),
      deploymentId: a.id,
    })).json();
    const rolledDone = await waitMessage(rolledMessage.message.id);
    assert.equal(rolledDone.modelSnapshot?.versionId, a.versionId);
    assert.deepEqual(keys.get(connection.token).models, [a.routeName]);
    const rolledBack = await (await api("/sessions", "POST", { title: "v1", deploymentId: a.id })).json();
    assert.equal(rolledBack.modelSnapshot.versionId, a.versionId);
    await assert.rejects(
      () => service.archiveDeployment(a.id, "a"),
      (error: any) => error.code === "DEPLOYMENT_IN_USE",
    );

    failDelete = true;
    await assert.rejects(() => service.revokeSession(session.id));
    assert.equal(
      (
        await database.db
          .select()
          .from(llmBindings)
          .where(eq(llmBindings.sessionId, session.id))
      )[0].state,
      "revoking",
    );
    failDelete = false;
    await service.revokeSession(session.id);
    assert.equal(keys.get(connection.token).status, "deleted");
    assert.equal(keys.get(otherConnection.token).status, "active");
    await service.updateDeployment(b.id, { enabled: false }, "a");
    assert.equal(keys.get(otherConnection.token).status, "deleted");
    assert.equal(
      (await api("/sessions", "POST", { title: "disabled", deploymentId: b.id }))
        .status,
      409,
    );
    // 删除检查包括关闭的会话、已接收轮次及非当前版本；已完成轮次只作为历史保留。
    const retiringProvider = await service.addProvider({
      name: "Retiring", apiBase: url, format: "openai_chat", apiKey: "retiring-fixture",
    }, "a");
    await service.rotateProviderSecret(retiringProvider.id, { apiKey: "rotated-fixture" }, "a");
    const retiring = await service.createDeployment({
      name: "Retiring model", providerId: retiringProvider.id, upstreamModel: "retiring-model",
      tools: true, streaming: true, price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }, "a");
    const retiringId = retiring.deployment.id;
    const retiringPath = "/admin/llm/deployments/" + retiringId;
    const providerPath = "/admin/llm/providers/" + retiringProvider.id;
    const formerVersion = retiring.deployment.currentVersionId;
    const changed = await service.createVersion(retiringId, { providerId: p.id }, "a");
    const replacement = changed.versions.find(item => item.id !== formerVersion)!;
    await service.pointDeployment(retiringId, replacement.id, formerVersion, "a");
    assert.equal((await api(providerPath, "DELETE", undefined, "b")).status, 403);
    assert.deepEqual(await (await api(providerPath + "/deletion-impact")).json(), { models: 1 });
    assert.equal((await (await api(providerPath, "DELETE")).json()).error, "PROVIDER_IN_USE");

    const snapshot = await service.select("a", retiringId);
    const held = await store.create("a", "Closed session with model", randomUUID(), { model: snapshot });
    assert.deepEqual(await (await api(retiringPath + "/deletion-impact")).json(), { sessions: 1 });
    assert.equal((await (await api(retiringPath, "DELETE")).json()).error, "MODEL_IN_USE");
    const replacementSnapshot = await service.select("a", a.id);
    const switchedAway = await store.accept(held.id, randomUUID(), "Fixture switch", replacementSnapshot, a.id);
    await store.activateModel(switchedAway.message, replacementSnapshot);
    await store.transition(switchedAway.message.id, "succeeded");
    const queued = await store.accept(held.id, randomUUID(), "Fixture queue", snapshot, retiringId);
    assert.equal((await (await api(retiringPath, "DELETE")).json()).error, "MODEL_IN_USE");
    await database.db.update(messages).set({ status: "succeeded" }).where(eq(messages.id, queued.message.id));

    const price = (await service.currentPrice(retiringId))!;
    const requestId = randomUUID(), now = Date.now();
    await database.db.insert(walletRequests).values({
      id: requestId, userId: "a", sessionId: held.id, deploymentId: retiringId, versionId: replacement.id,
      priceVersionId: price.id, modelName: "Retiring model", price, state: "settled", note: "fixture",
      reserved: 3, actual: 3, charged: 3, createdAt: now, finishedAt: now,
    });
    await database.db.insert(walletLedger).values({
      id: "request:" + requestId, userId: "a", amount: -3, kind: "request", note: "fixture",
      balanceAfter: 10, createdAt: now,
    });
    await database.db.insert(gatewayUsageEvents).values({
      id: requestId, callId: requestId, sessionId: held.id, ownerId: "a",
      model: replacement.routeName, deploymentId: retiringId, versionId: replacement.id,
      status: "success", spendUsd: 0.0001, pricingKnown: true, startedAt: now, observedAt: now,
    });
    const history = async () => ({
      wallet: await database.db.select().from(walletRequests).where(eq(walletRequests.id, requestId)),
      ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.id, "request:" + requestId)),
      usage: await database.db.select().from(gatewayUsageEvents).where(eq(gatewayUsageEvents.id, requestId)),
      message: await store.message(queued.message.id),
      price: await service.currentPrice(retiringId),
    });
    const beforeDeletion = await history();
    await service.setDefault("a", retiringId);
    modelDeleteFailure = replacement.id;
    assert.equal((await (await api(retiringPath, "DELETE")).json()).error, "MODEL_DELETE_UNCONFIRMED");
    assert.equal((await service.deploymentDetail(retiringId)).deployment.deletionState, "deleting");
    assert(!deployed.some(row => row.model_info.id === formerVersion));
    assert(deployed.some(row => row.model_info.id === replacement.id));
    assert(!(await service.catalog("a")).models.some(model => model.id === retiringId));
    assert.equal((await (await api(providerPath, "DELETE")).json()).error, "PROVIDER_IN_USE");
    await assert.rejects(store.create("a", "stale selection", randomUUID(), { model: snapshot }), /MODEL_UNAVAILABLE/);
    await assert.rejects(store.accept(held.id, randomUUID(), "stale selection", snapshot, retiringId), /MODEL_UNAVAILABLE/);
    await assert.rejects(service.syncVersion(formerVersion), /MODEL_DELETE_PENDING/);
    modelDeleteFailure = undefined;
    assert.equal((await api(retiringPath, "DELETE")).status, 200);
    assert.equal((await api(retiringPath, "DELETE")).status, 200);
    assert.equal((await api(retiringPath)).status, 404);
    assert(!deployed.some(row => [formerVersion, replacement.id].includes(row.model_info.id)));
    assert.equal((await api(providerPath, "DELETE")).status, 200);
    assert.equal((await api(providerPath, "DELETE")).status, 200);
    assert.equal((await api(providerPath + "/deletion-impact")).status, 404);
    assert.deepEqual(await database.db.select().from(llmProviderSecrets)
      .where(eq(llmProviderSecrets.providerId, retiringProvider.id)), []);
    assert((await service.gatewayVersions()).some(row => row.versionId === formerVersion));
    assert.deepEqual(await history(), beforeDeletion);
    const afterDeletion = await service.adminOverview();
    assert(!afterDeletion.providers.some(row => row.id === retiringProvider.id));
    assert(!afterDeletion.deployments.some(row => row.id === retiringId));

    const restarted = new LlmService(database.db, root, {
      managementUrl: url,
      inferenceUrl: url,
      masterKey: "fixture-master",
    });
    assert.equal((await restarted.select("a", a.id)).routeName, a.routeName);
    await restarted.recover();
  } finally {
    await manager.shutdown().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    remote.closeAllConnections();
    await new Promise<void>((r) => remote.close(() => r()));
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
