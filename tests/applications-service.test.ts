/** 控制面验证：真实HTTP/PG/Git，执行器、构建和网关为受控替身。真实Docker另行验证。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { parseAppAuth, type AppAuthPolicy } from "../src/service/applications/visitor-auth/policy.js";
import { applicationLoginCommand } from "../src/shared/application-skills.js";
import { mkdtemp, mkdir, lstat, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testDatabase } from "./pg.js";
import { llmDeployments, llmModelVersions, llmProviders } from "../src/service/db/schema/llm.js";
import { Controller } from "../src/runtime/controller.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { tokenHash } from "../src/service/auth.js";
import { createApi } from "../src/service/http-api.js";
import { ServiceClient, ApiError } from "../src/clients/service-client.js";
import { ApplicationStore } from "../src/service/applications/store.js";
import { ApplicationService } from "../src/service/applications/service.js";
import { CaddyApplicationEdge } from "../src/service/applications/edge.js";
import type { Message } from "../src/service/types.js";
import type { DataEnvironment } from "../src/service/applications/data.js";
import type { AppDeployment } from "../src/service/applications/docker.js";
import { migrationPlan } from "../src/service/applications/manifest.js";

async function wait(check: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Application fixture timed out");
}
const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value;
async function fixture(withVisitorAuth: boolean | "email" = false) {
  const database = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-app-control-"));
  const real = new Controller(root),
    store = new ApplicationStore(database.db);
  let runs = 0,
    builds = 0,
    failHealth = false;
  const prompts: string[] = [];
  const authByPrompt = new Map<string, AppAuthPolicy | undefined>();
  const manager = new SessionManager(
    new ServiceStore(database.db),
    {
      async open(id) {
        return {
          async run(prompt: string) {
            prompts.push(prompt);
            runs++;
            if (authByPrompt.has(prompt)) {
              const file = join(root, id, "workspace/harbor-app.json");
              const manifest = JSON.parse(await readFile(file, "utf8"));
              manifest.auth = authByPrompt.get(prompt);
              await writeFile(file, JSON.stringify(manifest));
            }
            await writeFile(
              join(root, id, "workspace/src/style.css"),
              "body { color: navy; }",
            );
            return {
              sessionId: id,
              generation: runs,
              status: "succeeded" as const,
              environment: "ready" as const,
            };
          },
          async close() {},
          async terminate() {},
        };
      },
    },
    "fixture-only",
  );
  await manager.identity.importKeys(
    ["a", "b"].map((userId) => ({
      userId,
      tokenHash: tokenHash("app-test-" + userId),
    })),
  );
  const edge = new CaddyApplicationEdge(
    "http://127.0.0.1:1",
    "http://127.0.0.1:2",
  );
  let routes: AppDeployment[] = [];
  edge.actual = async () => ({ routes: [], etag: "fixture" });
  edge.replace = async (value) => {
    routes = value;
  };
  edge.replaceEndpoint = async (appId, environment, value) => {
    routes = routes.filter(route => route.appId !== appId || route.environment !== environment);
    if (value) routes.push(value);
  };
  const keys = withVisitorAuth ? generateKeyPairSync("ed25519") : undefined;
  const service = new ApplicationService(store, manager, real, {
    root: join(root, ".apps"),
    dataAdminUrl: "postgres://fixture:fixture@127.0.0.1:1/fixture",
    nodeBase: "fixture",
    creators: new Set(["a"]), templateDirectory: "templates/application-v1",
    edge,
    ...(keys ? { visitorAuth: {
      authOrigin: "https://auth.example.com", appDomain: "apps.example.net",
      workbenchOrigin: "https://studio.example.net",
      pocketbase: "http://127.0.0.1:1", pocketbaseToken: "fixture-only",
      ...(withVisitorAuth === true ? { googleId: "fixture-id", googleSecret: "fixture-only" } : {}),
      edgeDial: "127.0.0.1:1", edgeToken: "fixture-only",
      signingKey: keys.privateKey, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }} : {}),
  });
  if (!withVisitorAuth) service.queuePreview = () => {};
  const accounts = service.visitorAuth?.accounts;
  if (accounts) accounts.provision = async (_name, id) => id ?? randomUUID().replaceAll("-", "");
  service.builder.build = async (
    source,
    target,
    revisionId = source.commit,
    id = randomUUID(),
  ) => ({
    id,
    ...(withVisitorAuth ? { visitorAuthVersion: 1 as const } : {}),
    appId: source.appId,
    revisionId,
    target,
    basePath: `/${target === "preview" ? "preview" : "apps"}/${source.appId}/`,
    imageId: "sha256:" + String(++builds).padStart(64, "0"),
  });
  const data = new Map<string, DataEnvironment>();
  service.data.open = async (id, env) => {
    const value = data.get(id + env);
    if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  };
  service.data.provision = async (appId, environment, schema) => {
    const value = {
      appId,
      environment,
      schema,
      database: "fixture",
      role: "fixture",
      password: "fixture",
    };
    data.set(appId + environment, value);
    return value;
  };
  service.driver.create = async (build, id, _data, _observation, visitorAuth) => ({
    id,
    ...(visitorAuth ? { visitorAuth } : {}),
    appId: build.appId,
    build,
    environment: build.target,
    hostPort: 12345,
    container: "ah-app-" + id,
  });
  service.driver.start = async (deployment) => deployment;
  service.driver.refresh = async (deployment) => deployment;
  service.driver.healthy = async () => {
    if (failHealth) throw new Error("fixture unhealthy");
    return {};
  };
  service.driver.activate = async () => {};
  service.driver.destroy = async () => {};
  service.driver.inspect = async () => undefined;
  const server = createApi(
    manager,
    real,
    undefined,
    {},
    undefined,
    undefined,
    service,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const a = new ServiceClient(url, "app-test-a"),
    b = new ServiceClient(url, "app-test-b");
  async function done(appId: string, operationId: string) {
    await wait(
      async () =>
        !["queued", "running", "cancelling"].includes(
          (await store.operation("a", appId, operationId)).state,
        ),
    );
    return store.operation("a", appId, operationId);
  }
  return {
    root,
    url,
    store,
    service,
    manager,
    a,
    b,
    database,
    done,
    routes: () => routes,
    runs: () => runs,
    prompts,
    authByPrompt,
    builds: () => builds,
    unhealthy: (value: boolean) => {
      failHealth = value;
    },
    async close() {
      await manager.shutdown();
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("app ownership, durable creation deduplication, fixed revisions and controlled conversation entry", async () => {
  const f = await fixture();
  try {
    const input = {
      title: "活动报名",
      prompt: "",
      clientRequestId: randomUUID(),
    };
    const created = await f.a.request<{
      app: { id: string };
      operation: { id: string };
    }>("/applications", "POST", input);
    const appId = created.app.id;
    assert.equal(
      (await f.done(appId, created.operation.id)).state,
      "succeeded",
    );
    const again = await f.a.request<typeof created>(
      "/applications",
      "POST",
      input,
    );
    assert.equal(again.app.id, appId);
    await assert.rejects(
      f.a.request("/applications", "POST", { ...input, title: "changed" }),
      code("APPLICATION_REQUEST_CONFLICT"),
    );
    await assert.rejects(
      f.b.request(`/applications/${appId}`),
      code("APPLICATION_NOT_FOUND"),
    );
    await assert.rejects(
      f.b.request("/applications", "POST", {
        ...input,
        clientRequestId: randomUUID(),
      }),
      code("APPLICATION_CREATOR_NOT_ENABLED"),
    );
    const app = await f.store.owned("a", appId),
      first = (await f.store.revisions(appId))[0];
    await assert.rejects(
      f.a.send(app.developmentSessionId!, randomUUID(), "bypass"),
      code("USE_APPLICATION_MESSAGE_ENTRY"),
    );
    const body = {
      clientMessageId: randomUUID(),
      text: "改成蓝色",
      expectedHeadRevisionId: first.id,
    };
    const generated = await f.a.request<{
      operation: { id: string };
      message: { id: string };
    }>(`/applications/${appId}/messages`, "POST", body);
    assert.equal(
      (await f.done(appId, generated.operation.id)).state,
      "succeeded",
    );
    const retry = await f.a.request<typeof generated>(
      `/applications/${appId}/messages`,
      "POST",
      body,
    );
    assert.equal(retry.message.id, generated.message.id);
    assert.equal(f.runs(), 1);
    const revisions = await f.store.revisions(appId);
    assert.equal(revisions.length, 2);
    assert.notEqual(revisions[0].source.commit, first.source.commit);
    const output = join(f.root, "old-version");
    await f.service.sources.export(first.source, output);
    assert.notEqual(
      await readFile(join(output, "src/style.css"), "utf8"),
      "body { color: navy; }",
    );
    await assert.rejects(
      f.a.request(`/applications/${appId}/messages`, "POST", {
        ...body,
        clientMessageId: randomUUID(),
      }),
      code("APPLICATION_SOURCE_CHANGED"),
    );
    const restore = await f.a.request<{ operation: { id: string } }>(
      `/applications/${appId}/restore`,
      "POST",
      {
        revisionId: first.id,
        clientRequestId: randomUUID(),
        expectedHeadRevisionId: revisions[0].id,
      },
    );
    assert.equal(
      (await f.done(appId, restore.operation.id)).state,
      "succeeded",
    );
    const restored = (await f.store.revisions(appId))[0];
    assert.equal(restored.restoredFromId, first.id);
    assert.equal(restored.number, 3);
    const reopened = await f.database.reopen();
    try {
      assert.equal(
        (await new ApplicationStore(reopened.db).owned("a", appId))
          .headRevisionId,
        restored.id,
      );
    } finally {
      await reopened.pool.end();
    }
    const detail = JSON.stringify(await f.a.request(`/applications/${appId}`));
    assert(!detail.includes(f.root));
    assert(!detail.includes("password"));
    await assert.rejects(
      f.b.request(`/applications/${appId}/revisions/${first.id}/export`),
      code("APPLICATION_NOT_FOUND"),
    );
    const source = await f.service.exportSource("a", appId, first.id);
    try {
      assert.equal(
        await readFile(join(source.directory, "src/style.css"), "utf8"),
        await readFile(join(output, "src/style.css"), "utf8"),
      );
    } finally {
      await source.cleanup();
    }
    const download = await fetch(
      `${f.a.url}/api/applications/${appId}/revisions/${first.id}/export`,
      { headers: { Authorization: "Bearer app-test-a" } },
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.equal(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 2)
        .toString(),
      "PK",
    );
  } finally {
    await f.close();
  }
});

test("a destructive manifest change reports its reason and keeps the previous preview live", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create("a", "兼容预览", "", randomUUID());
    const appId = created.app.id;
    const initial = await f.done(appId, created.operation.id);
    const [first] = await f.store.revisions(appId);
    const preview = await f.service.deploy("a", appId, first.id, "preview", randomUUID(), 0);
    assert.equal((await f.done(appId, preview.operation.id)).state, "succeeded");
    const original = await f.store.endpoint(appId, "preview");
    const provision = f.service.data.provision;
    f.service.data.provision = async (id, env, manifest) => {
      migrationPlan((await f.service.data.open(id, env)).schema, manifest);
      return provision(id, env, manifest);
    };
    const file = join(f.root, String(initial.result?.sessionId), "workspace/harbor-app.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    delete manifest.tables.signups.fields.email;
    await writeFile(file, JSON.stringify(manifest));
    const snapshot = await f.service.snapshot("a", appId, randomUUID(), first.id);
    assert.equal((await f.done(appId, snapshot.operation.id)).state, "succeeded");
    const [latest] = await f.store.revisions(appId);
    const attempt = await f.service.deploy("a", appId, latest.id, "preview", randomUUID(), original.generation);
    const failed = await f.done(appId, attempt.operation.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "DESTRUCTIVE_SCHEMA_CHANGE");
    assert.equal(failed.payload.revisionId, latest.id);
    assert.equal(f.builds(), 2);
    const endpoint = await f.store.endpoint(appId, "preview");
    assert.equal(endpoint.state, "ready");
    assert.equal(endpoint.appliedDeploymentId, original.appliedDeploymentId);
  } finally {
    await f.close();
  }
});

test("publish retries reuse the operation; unhealthy candidate leaves online instance; rollback reuses original image", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create("a", "发布验证", "", randomUUID());
    const appId = created.app.id;
    await f.done(appId, created.operation.id);
    const revision = (await f.store.revisions(appId))[0];
    const requestId = randomUUID();
    const first = await f.service.deploy(
      "a",
      appId,
      revision.id,
      "production",
      requestId,
      0,
    );
    assert.equal((await f.done(appId, first.operation.id)).state, "succeeded");
    const online = await f.store.endpoint(appId, "production"),
      original = f.routes()[0];
    assert.equal(
      (
        await f.service.deploy(
          "a",
          appId,
          revision.id,
          "production",
          requestId,
          0,
        )
      ).operation.id,
      first.operation.id,
    );
    assert.equal(f.builds(), 1);
    f.unhealthy(true);
    const bad = await f.service.deploy(
      "a",
      appId,
      revision.id,
      "production",
      randomUUID(),
      online.generation,
    );
    assert.equal((await f.done(appId, bad.operation.id)).state, "failed");
    assert.equal(
      (await f.store.endpoint(appId, "production")).appliedDeploymentId,
      original.id,
    );
    f.unhealthy(false);
    const restored = await f.service.rollback(
      "a",
      appId,
      original.id,
      randomUUID(),
      online.generation,
    );
    assert.equal(
      (await f.done(appId, restored.operation.id)).state,
      "succeeded",
    );
    assert.equal(f.builds(), 2);
    assert.equal(f.routes()[0].build.imageId, original.build.imageId);
    assert.notEqual(f.routes()[0].id, original.id);
    const generation = (await f.store.endpoint(appId, "production")).generation;
    const stopped = await f.service.unpublish(
      "a",
      appId,
      randomUUID(),
      generation,
    );
    assert.equal(
      (await f.done(appId, stopped.operation.id)).state,
      "succeeded",
    );
    assert.equal(f.routes().length, 0);
    const reopened = await f.service.deploy(
      "a",
      appId,
      revision.id,
      "production",
      randomUUID(),
      (await f.store.endpoint(appId, "production")).generation,
    );
    await f.done(appId, reopened.operation.id);
    await f.manager.identity.update("a", { disabled: true });
    await f.manager.closeUser("a");
    assert.equal(f.routes().length, 0);
    assert.equal((await f.store.byId(appId))?.status, "suspended");
  } finally {
    await f.close();
  }
});

test("database admission reserves one source writer, rejects stale head, and keeps unknown operations occupied", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create("a", "并发", "", randomUUID());
    await f.done(created.app.id, created.operation.id);
    const app = await f.store.owned("a", created.app.id);
    const inputs = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      inputs.map((id) =>
        f.store.begin("a", app.id, "snapshot", id, "source", {
          expectedHeadRevisionId: app.headRevisionId,
        }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const accepted = results.find((result) => result.status === "fulfilled")!;
    assert(accepted.status === "fulfilled");
    await f.store.progress(
      accepted.value.operation.id,
      "reconciling",
      "unknown_writer",
    );
    await assert.rejects(
      f.store.begin("a", app.id, "snapshot", randomUUID(), "source", {
        expectedHeadRevisionId: app.headRevisionId,
      }),
      (error: any) => error.code === "APPLICATION_BUSY",
    );
    await assert.rejects(
      f.manager.withFileWrite("a", app.developmentSessionId!, async () => true),
      (error: any) => error.code === "APPLICATION_BUSY",
    );
    await assert.rejects(
      f.store.begin("a", app.id, "snapshot", randomUUID(), "source", {
        expectedHeadRevisionId: randomUUID(),
      }),
      (error: any) => error.code === "APPLICATION_SOURCE_CHANGED",
    );
    await f.store.progress(
      accepted.value.operation.id,
      "failed",
      "confirmed_stopped",
    );
    assert.equal((await f.store.active(app.id, "source")).length, 0);
    const restore = await f.store.begin(
      "a",
      app.id,
      "restore",
      randomUUID(),
      "source",
      { expectedHeadRevisionId: app.headRevisionId },
    );
    await f.store.progress(restore.operation.id, "running", "replacing_source");
    await f.service.initialize();
    const interrupted = await f.store.operation(
      "a",
      app.id,
      restore.operation.id,
    );
    assert.equal(interrupted.state, "reconciling");
    assert.equal(interrupted.phase, "replacing_source");
    await assert.rejects(
      f.service.reconcile("a", app.id),
      (error: any) => error.code === "APPLICATION_SOURCE_RECOVERY_REQUIRED",
    );
    assert.equal((await f.store.active(app.id, "source")).length, 1);
  } finally {
    await f.close();
  }
});

test("unconfirmed retired-container cleanup retains publication reservation after route switch", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create("a", "清理边界", "", randomUUID());
    const appId = created.app.id;
    await f.done(appId, created.operation.id);
    const revision = (await f.store.revisions(appId))[0];
    const first = await f.service.deploy(
      "a",
      appId,
      revision.id,
      "production",
      randomUUID(),
      0,
    );
    await f.done(appId, first.operation.id);
    const before = await f.store.endpoint(appId, "production");
    f.service.driver.destroy = async () => {
      throw new Error("fixture engine state unknown");
    };
    const next = await f.service.deploy(
      "a",
      appId,
      revision.id,
      "production",
      randomUUID(),
      before.generation,
    );
    const result = await f.done(appId, next.operation.id);
    assert.equal(result.state, "reconciling");
    assert.equal(
      result.error,
      "APPLICATION_OLD_DEPLOYMENT_CLEANUP_UNCONFIRMED",
    );
    const after = await f.store.endpoint(appId, "production");
    assert.notEqual(after.appliedDeploymentId, before.appliedDeploymentId);
    assert.equal(after.state, "reconciling");
    await assert.rejects(
      f.service.deploy(
        "a",
        appId,
        revision.id,
        "production",
        randomUUID(),
        after.generation,
      ),
      (error: any) => error.code === "APPLICATION_BUSY",
    );
  } finally {
    await f.close();
  }
});

test("application messages activate the selected model and conflicting retries cannot change it", async () => {
  const f = await fixture();
  try {
    await f.manager.store.db.transaction(async (tx) => {
      await tx.insert(llmProviders).values({ id: "fixture", name: "fixture", format: "anthropic", apiBase: "http://fixture", createdAt: 0 });
      for (const id of ["default", "selected-model"]) {
        await tx.insert(llmModelVersions).values({
          id, deploymentId: id, providerId: "fixture", upstreamModel: id, routeName: id,
          params: {}, capabilities: {}, tools: true, streaming: true, digest: id, state: "ready", createdBy: "a", createdAt: 0,
        });
        await tx.insert(llmDeployments).values({
          id, currentVersionId: id, name: id, description: "", enabled: true, allowedUsers: [], createdAt: 0, updatedAt: 0,
        });
      }
    });
    f.manager.modelSelection = async (_user, id) => ({ deploymentId:id??"default",deploymentName:id??"Default",versionId:id??"default",providerName:"fixture",upstreamModel:id??"default",routeName:id??"default" });
    f.manager.modelConnection = async session => ({url:"http://fixture",token:"fixture",model:"ah-session-model",bindingId:"fixture"});
    const created = await f.a.request<{app:{id:string};operation:{id:string}}>("/applications","POST",{title:"Model selection",prompt:"",clientRequestId:randomUUID()});
    await f.done(created.app.id,created.operation.id);
    const app = await f.store.owned("a",created.app.id);
    const body={clientMessageId:randomUUID(),text:"Use the selected model",modelDeploymentId:"selected-model",expectedHeadRevisionId:app.headRevisionId};
    const response=await f.a.request<{message:Message;operation:{id:string}}>(`/applications/${app.id}/messages`,"POST",body);
    await f.done(app.id,response.operation.id);
    const stored=await f.manager.store.message(response.message.id);
    assert.equal(stored?.requestedDeploymentId,"selected-model");
    assert.equal(stored?.activatedModelSnapshot?.deploymentId,"selected-model");
    const again=await f.a.request<typeof response>(`/applications/${app.id}/messages`,"POST",body);
    assert.equal(again.message.id,response.message.id);
    await assert.rejects(f.a.request(`/applications/${app.id}/messages`,"POST",{...body,modelDeploymentId:"other-model"}),code("APPLICATION_REQUEST_CONFLICT"));
  } finally { await f.close(); }
});

test("application timeout stays a system failure with a recoverable operation reason", async () => {
  const f = await fixture();
  try {
    const created = await f.a.request<{app:{id:string};operation:{id:string}}>("/applications","POST",{title:"Timeout feedback",prompt:"",clientRequestId:randomUUID()});
    await f.done(created.app.id,created.operation.id);
    const app=await f.store.owned("a",created.app.id);
    f.manager.controller.open=async id=>({
      async run(){ return {sessionId:id,generation:1,status:"failed" as const,environment:"closed" as const,stopped:true,stopReason:"task_timeout" as const}; },
      async close(){}, async terminate(){},
    });
    const response=await f.a.request<{message:Message;operation:{id:string}}>(`/applications/${app.id}/messages`,"POST",{text:"Create page",clientMessageId:randomUUID(),expectedHeadRevisionId:app.headRevisionId});
    const operation=await f.done(app.id,response.operation.id);
    assert.equal(operation.state,"failed");
    assert.equal(operation.error,"APPLICATION_GENERATION_TIMEOUT");
    const stored=await f.manager.store.message(response.message.id);
    assert.equal(stored?.status,"failed");
    assert.equal(JSON.parse(stored!.result!).error,"TASK_TIMEOUT");
    assert.equal((await f.store.revisions(app.id)).length,1,"failed generation must not invent a new revision");
  } finally { await f.close(); }
});

test("restart refreshes actual endpoint ports and isolates failed applications from other switches and reconciliation", async () => {
  const f = await fixture();
  try {
    const apps = [];
    for (const title of ["broken", "healthy"]) {
      const created = await f.service.create("a", title, "", randomUUID());
      await f.done(created.app.id, created.operation.id);
      const revision = (await f.store.revisions(created.app.id))[0];
      const deployed = await f.service.deploy("a", created.app.id, revision.id, "preview", randomUUID(), 0);
      assert.equal((await f.done(created.app.id, deployed.operation.id)).state, "succeeded");
      apps.push({ id: created.app.id, revision });
    }
    const [broken, healthy] = apps;
    f.service.driver.refresh = async deployment => {
      if (deployment.appId === broken.id) throw Error("engine unavailable for this application");
      return { ...deployment, hostPort: 34567 };
    };
    await f.service.initialize();
    assert.equal((await f.store.endpoint(broken.id, "preview")).state, "reconciling");
    const ready = await f.store.endpoint(healthy.id, "preview");
    assert.equal(ready.state, "ready");
    assert.equal((await f.store.deployment(ready.appliedDeploymentId!))!.spec!.hostPort, 34567);
    assert.equal(f.routes().find(r => r.appId === healthy.id)!.hostPort, 34567);
    const next = await f.service.deploy("a", healthy.id, healthy.revision.id, "preview", randomUUID(), ready.generation);
    assert.equal((await f.done(healthy.id, next.operation.id)).state, "succeeded");
    await f.service.reconcile("a", healthy.id);
    assert.equal((await f.store.endpoint(broken.id, "preview")).state, "reconciling");
    const other = f.routes().find(r => r.appId === healthy.id);
    f.service.driver.refresh = async deployment => ({ ...deployment, hostPort: 34568 });
    await f.service.reconcile("a", broken.id);
    assert.equal((await f.store.endpoint(broken.id, "preview")).state, "ready");
    assert.deepEqual(f.routes().find(r => r.appId === healthy.id), other);
  } finally { await f.close(); }
});


test("application direct deletion removes development conversation, revisions, deployment files and owned data while preserving its peer", async () => {
  const f = await fixture();
  try {
    f.manager.deletions!.resident.findOwned = async () => [];
    f.service.driver.command = async () => "";
    const dropped: string[] = [];
    let failDrop = true;
    f.service.data.destroyOwned = async (id, env) => { if(failDrop)throw Error("fixture data cleanup unavailable"); dropped.push(id + ":" + env); };
    const one = await f.service.create("a", "Delete application", "", randomUUID());
    const peer = await f.service.create("a", "Keep application", "", randomUUID());
    await f.done(one.app.id, one.operation.id); await f.done(peer.app.id, peer.operation.id);
    const app = await f.store.byId(one.app.id), revision = (await f.store.revisions(one.app.id))[0];
    const deployed = await f.service.deploy("a",one.app.id,revision.id,"preview",randomUUID(),0);
    assert.equal((await f.done(one.app.id,deployed.operation.id)).state,"succeeded");
    await assert.rejects(f.a.request("/sessions/"+app!.developmentSessionId,"DELETE"),(e:any)=>e.code==="DELETE_APPLICATION_INSTEAD");
    await assert.rejects(f.b.request("/applications/"+one.app.id,"DELETE",{confirmName:app!.title}),(e:any)=>e.status===404);
    await assert.rejects(f.a.request("/applications/"+one.app.id,"DELETE",{confirmName:"wrong"}),(e:any)=>e.code==="DELETE_NAME_CHANGED");
    const job=await f.a.request<any>("/applications/"+one.app.id,"DELETE",{confirmName:app!.title});
    await wait(async()=> (await f.manager.deletions!.job("a",job.id)).state!=="running");
    assert.equal((await f.manager.deletions!.job("a",job.id)).state,"failed");
    assert.equal((await f.store.byId(peer.app.id))!.status,"active");
    failDrop=false;
    const retry=await f.a.request<any>("/applications/"+one.app.id,"DELETE",{confirmName:app!.title});
    assert.equal(retry.id,job.id);
    await wait(async()=> (await f.manager.deletions!.job("a",job.id)).state!=="running");
    assert.equal((await f.manager.deletions!.job("a",job.id)).state,"completed");
    assert.equal(await f.store.byId(one.app.id),undefined);
    assert.equal(await f.manager.store.session(app!.developmentSessionId!),undefined);
    await assert.rejects(lstat(f.service.sources.directory(one.app.id)),{code:"ENOENT"});
    assert.deepEqual(dropped.sort(),[one.app.id+":preview",one.app.id+":production"].sort());
    assert.equal((await f.store.byId(peer.app.id))!.status,"active");
    assert(await lstat(f.service.sources.directory(peer.app.id)));
    assert.equal((await f.a.request<any>("/applications/"+one.app.id,"DELETE",{confirmName:app!.title})).state,"completed");
  } finally { await f.close(); }
});


test("manifest accepts explicit auth policies and rejects incomplete provider lists", () => {
  assert.equal(parseAppAuth(undefined), undefined);
  assert.deepEqual(parseAppAuth({ mode: "public" }), { mode: "public" });
  for (const providers of [["google"], ["email_password"], ["email_password", "google"]])
    assert.deepEqual(parseAppAuth({ mode: "required", providers }), { mode: "required", providers });
  for (const policy of [null, true, { mode: "required" }, { mode: "required", providers: [] },
    { mode: "required", providers: ["unknown"] }, { mode: "required", providers: ["google", "google"] },
    { mode: "public", providers: ["google"] }, { mode: "required", providers: ["google"], secret: "ignored" }])
    assert.throws(() => parseAppAuth(policy), /INVALID_APP_AUTH_POLICY/);
});

test("the published manifest selects providers and requires confirmation to make a protected app public", async () => {
  const f = await fixture(true);
  try {
    const created = await f.a.request<{ app: { id: string } }>("/applications", "POST", {
      title: "公开表单", prompt: "做一个公开报名页", clientRequestId: randomUUID(),
    });
    const appId = created.app.id;
    const auth = f.service.visitorAuth!;
    const endpoint = (environment: "preview" | "production") => f.store.endpoint(appId, environment);
    const route = (environment: "preview" | "production") =>
      f.routes().find(item => item.appId === appId && item.environment === environment);
    const head = async () => (await f.store.owned("a", appId)).headRevisionId!;
    await wait(async () => (await endpoint("preview")).state === "ready");
    assert.equal(route("preview")?.visitorAuth, undefined);
    assert.equal(await auth.scope(appId, "preview"), undefined);
    const publicHistory = await f.service.deploy("a", appId, await head(), "production", randomUUID());
    assert.equal((await f.done(appId, publicHistory.operation.id)).state, "succeeded");
    const oldPublicId = (await endpoint("production")).appliedDeploymentId!;

    async function edit(text: string) {
      const action = await f.a.request<{ operation: { id: string }; message: Message }>(
        `/applications/${appId}/messages`, "POST",
        { text, clientMessageId: randomUUID(), expectedHeadRevisionId: await head() },
      );
      assert.equal(action.message.text, text);
      assert.equal((await f.done(appId, action.operation.id)).state, "succeeded");
    }
    const google = "用谷歌账号访问报名页";
    f.authByPrompt.set(google, { mode: "required", providers: ["google"] });
    await edit(google);
    await wait(async () => route("preview")?.visitorAuth?.providers?.[0] === "google");
    assert.equal(f.prompts.at(-1), google);
    assert.equal(await auth.scope(appId, "production"), undefined);
    assert.equal(route("production")?.visitorAuth, undefined);

    const firstHead = await head();
    const publish = await f.service.deploy("a", appId, firstHead, "production", randomUUID());
    assert.equal((await f.done(appId, publish.operation.id)).state, "succeeded");
    const rollback = await f.service.rollback("a", appId, oldPublicId, randomUUID(), (await endpoint("production")).generation);
    assert.equal((await f.done(appId, rollback.operation.id)).state, "succeeded");
    const protectedId = (await endpoint("production")).appliedDeploymentId!;
    assert.deepEqual(route("production")?.visitorAuth?.providers, ["google"]);
    const collection = (await auth.scope(appId, "production"))?.google_collection_id;
    assert.ok(collection);
    assert.notEqual(collection, (await auth.scope(appId, "preview"))?.google_collection_id);

    f.authByPrompt.set("仅允许邮箱密码登录", { mode: "required", providers: ["email_password"] });
    await edit("仅允许邮箱密码登录");
    await wait(async () => route("preview")?.visitorAuth?.providers?.[0] === "email_password");
    assert.deepEqual(route("production")?.visitorAuth?.providers, ["google"]);

    f.authByPrompt.set("恢复一个没有登录声明的旧版", undefined);
    const beforeLegacy = (await endpoint("preview")).generation;
    await edit("恢复一个没有登录声明的旧版");
    await wait(async () => (await endpoint("preview")).state === "ready" &&
      (await endpoint("preview")).generation > beforeLegacy);
    assert.deepEqual(route("preview")?.visitorAuth?.providers, ["email_password"]);

    f.authByPrompt.set("改为公开访问", { mode: "public" });
    await edit("改为公开访问");
    await wait(async () => (await f.store.operations(appId)).some(operation =>
      operation.kind === "preview" && operation.error === "APPLICATION_AUTH_PUBLIC_CONFIRMATION_REQUIRED"));
    assert.deepEqual(route("preview")?.visitorAuth?.providers, ["email_password"]);
    const publicHead = await head();
    const failed = await f.service.deploy("a", appId, publicHead, "production", randomUUID());
    assert.equal((await f.done(appId, failed.operation.id)).error, "APPLICATION_AUTH_PUBLIC_CONFIRMATION_REQUIRED");
    assert.equal((await endpoint("production")).appliedDeploymentId, protectedId);
    const release = await f.a.request<{ operation: { id: string } }>(`/applications/${appId}/production`, "POST", {
      revisionId: publicHead, expectedGeneration: (await endpoint("production")).generation,
      clientRequestId: randomUUID(), confirmPublicRevisionId: publicHead,
    });
    assert.equal((await f.done(appId, release.operation.id)).state, "succeeded");
    assert.equal(route("production")?.visitorAuth, undefined);
    assert.equal((await auth.scope(appId, "production"))?.google_collection_id, collection);
  } finally {
    await f.close();
  }
});

test("selecting the Skill alone does not enable login unless the generated manifest declares it", async () => {
  const f = await fixture(true);
  try {
    const created = await f.a.request<{ app: { id: string } }>("/applications", "POST", {
      title: "登录咨询", prompt: applicationLoginCommand + " 解释登录", clientRequestId: randomUUID(),
    });
    const appId = created.app.id;
    await wait(async () => (await f.store.endpoint(appId, "preview")).state === "ready");
    assert.equal(f.routes().find(item => item.appId === appId)?.visitorAuth, undefined);
  } finally {
    await f.close();
  }
});

test("email-only deployment works without Google credentials while a Google deployment fails closed", async () => {
  const f = await fixture("email");
  try {
    const prompt = applicationLoginCommand + " 做一个带邮箱登录的应用";
    const config = await f.a.request<{ loginProviders: string[] }>("/applications/config");
    assert.deepEqual(config.loginProviders, ["email_password"]);
    f.authByPrompt.set(prompt, { mode: "required", providers: ["email_password", "google"] });
    const created = await f.a.request<{ app: { id: string } }>("/applications", "POST", {
      title: "邮箱登录", prompt, clientRequestId: randomUUID(),
    });
    const appId = created.app.id;
    await wait(async () => (await f.store.endpoint(appId, "preview")).state === "ready");
    assert.deepEqual(f.routes().find(item => item.appId === appId)?.visitorAuth?.providers, ["email_password"]);
    const google = "改为 Google 登录";
    f.authByPrompt.set(google, { mode: "required", providers: ["google"] });
    const app = await f.store.owned("a", appId);
    const action = await f.service.generate("a", appId, google, randomUUID(), app.headRevisionId);
    assert.equal((await f.done(appId, action.operation.id)).state, "succeeded");
    await wait(async () => (await f.store.operations(appId)).some(operation =>
      operation.kind === "preview" && operation.error === "APPLICATION_AUTH_GOOGLE_UNAVAILABLE"));
    assert.deepEqual(f.routes().find(item => item.appId === appId)?.visitorAuth?.providers, ["email_password"]);
  } finally {
    await f.close();
  }
});

test("new generated applications stay public when no managed login is configured", async () => {
  const f = await fixture();
  try {
    const config = await f.a.request<{ loginProviders: string[] }>("/applications/config");
    assert.deepEqual(config.loginProviders, []);
    const prompt = applicationLoginCommand + "加平台登录";
    f.authByPrompt.set(prompt, { mode: "required", providers: ["email_password", "google"] });
    const { app } = await f.a.request<{ app: { id: string } }>("/applications", "POST", {
      title: "平台登录不可用", prompt, clientRequestId: randomUUID(),
    });
    await wait(async () => (await f.store.revisions(app.id)).length === 2);
    const current = await f.store.owned("a", app.id);
    assert.equal((await f.store.revision(app.id, current.headRevisionId!)).manifest.auth, undefined);
  } finally {
    await f.close();
  }
});

test("OpenSandbox preserves preview owner access and requires a stop before switching application backends", async () => {
  const f = await fixture("email");
  let backendId = "opensandbox-preview";
  const resources = new Map<string, { buildId: string; deploymentId: string }>();
  const probe = createServer((request, response) => {
    const id = request.url?.split("/")[1];
    const record = id && resources.get(id);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...record, visitorAuthVersion: 1 }));
  });
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  try {
    f.service.queuePreview = () => {};
    const created = await f.service.create("a", "private", "", randomUUID());
    const appId = created.app.id;
    await f.done(appId, created.operation.id);
    f.authByPrompt.set("set private preview", { mode: "required", providers: ["email_password"] });
    const detail = await f.service.detail("a", appId);
    const operation = await f.service.generate("a", appId, "set private preview", randomUUID(), detail.app.headRevisionId);
    assert.equal((await f.done(appId, operation.operation.id)).state, "succeeded");
    const revision = (await f.store.revisions(appId))[0];
    const appIds = new Set([appId]);
    f.service.options.openSandboxPreview = { origin: new URL(`http://127.0.0.1:${port}`), appIds };
    Object.assign(f.service, { openSandbox: {
      get backendId() { return backendId; },
      async create(launch: import("../src/runtime/providers/preview.js").PreviewLaunch) {
        const resourceId = randomUUID();
        assert.equal((await f.store.deployment(launch.deploymentId))?.runtimeBackend, backendId);
        resources.set(resourceId, { buildId: launch.build.id, deploymentId: launch.deploymentId });
        return { backendId, resourceId };
      },
      async findOwned(id: string) {
        return [...resources].filter(([, item]) => item.deploymentId === id)
          .map(([resourceId]) => ({ backendId, resourceId }));
      },
      async resolvePrivateEndpoint(ref: { resourceId: string }) { return { url: new URL(`http://127.0.0.1:${port}/${ref.resourceId}`) }; },
      async stopAndConfirm(ref: { resourceId: string }) { resources.delete(ref.resourceId); },
      async remove() {},
    } });
    const deploy = async () => {
      const endpoint = await f.store.endpoint(appId, "preview");
      const result = await f.service.deploy("a", appId, revision.id, "preview", randomUUID(), endpoint.generation);
      return f.done(appId, result.operation.id);
    };
    assert.equal((await deploy()).state, "succeeded");
    const endpoint = await f.store.endpoint(appId, "preview");
    const id = endpoint.appliedDeploymentId!;
    assert.equal((await f.store.deployment(id))?.spec?.ownerOnly, true);
    const endpointUrl = `/applications/${appId}/preview-access`;
    await assert.rejects(f.b.request(endpointUrl, "POST", { deploymentId: id }), code("APPLICATION_NOT_FOUND"));
    const { ticket } = await f.a.request<{ ticket: string }>(endpointUrl, "POST", { deploymentId: id });
    const host = `${appId}-preview.apps.example.net`;
    const gate = f.url + `/__harbor/visitor/preview-access/${appId}/${id}`;
    const headers = { Host: host, Origin: "https://studio.example.net", "X-Harbor-Edge-Proof": "fixture-only" };
    const access = (extra: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
        const req = request(gate, { method: body ? "POST" : "GET",
          headers: { ...headers, ...extra, ...(body ? { "Content-Type": "text/plain" } : {}) },
        }, res => {
          res.resume();
          res.once("end", () => resolve({ status: res.statusCode!, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
        });
        req.on("error", reject);
        req.end(body);
      });
    assert.equal((await access()).status, 401);
    const response = await access({}, ticket);
    assert.equal(response.status, 204);
    assert.ok(response.cookie);
    const Cookie = response.cookie;
    assert.equal((await access({}, ticket)).status, 401);
    assert.equal((await access({ Cookie })).status, 204);
    assert.equal((await access({ Cookie, "X-Harbor-Preview-Websocket": "1" })).status, 403);
    appIds.clear();
    assert.equal((await deploy()).error, "APPLICATION_PREVIEW_PAUSE_REQUIRED");
    const pause = await f.service.pausePreview("a", appId, randomUUID(), endpoint.generation);
    assert.equal((await f.done(appId, pause.operation.id)).state, "succeeded");
    assert.equal(resources.size, 0);
    assert.equal((await access({ Cookie })).status, 404);
    assert.equal((await deploy()).state, "succeeded");
    const reverted = (await f.store.endpoint(appId, "preview")).appliedDeploymentId!;
    assert.equal((await f.store.deployment(reverted))?.runtimeBackend, "docker");
    assert.equal((await f.store.deployment(reverted))?.spec?.ownerOnly, true);

    const publish = async () => {
      const operation = await f.service.deploy("a", appId, revision.id, "production", randomUUID());
      return f.done(appId, operation.operation.id);
    };
    assert.equal((await publish()).state, "succeeded");
    const dockerProduction = await f.store.endpoint(appId, "production");
    backendId = "opensandbox-app";
    f.service.options.openSandboxPreview.all = true;
    assert.equal((await publish()).error, "APPLICATION_PREVIEW_PAUSE_REQUIRED");
    const stopped = await f.service.unpublish("a", appId, randomUUID(), dockerProduction.generation);
    assert.equal((await f.done(appId, stopped.operation.id)).state, "succeeded");
    assert.equal((await publish()).state, "succeeded");
    let sandboxProduction = await f.store.endpoint(appId, "production");
    const production = await f.store.deployment(sandboxProduction.appliedDeploymentId!);
    assert.equal(production?.runtimeBackend, "opensandbox-app");
    assert.equal(production?.spec?.ownerOnly, undefined);
    const oldBuild = await f.store.deployment(dockerProduction.appliedDeploymentId!);
    const rollback = await f.service.rollback("a", appId, oldBuild!.id, randomUUID(), sandboxProduction.generation);
    assert.equal((await f.done(appId, rollback.operation.id)).state, "succeeded");
    sandboxProduction = await f.store.endpoint(appId, "production");
    const restored = await f.store.deployment(sandboxProduction.appliedDeploymentId!);
    assert.equal(restored?.runtimeBackend, "opensandbox-app");
    assert.notEqual(restored?.buildId, oldBuild?.buildId);
    assert.equal(resources.size, 1);
    const sandboxStop = await f.service.unpublish("a", appId, randomUUID(), sandboxProduction.generation);
    assert.equal((await f.done(appId, sandboxStop.operation.id)).state, "succeeded");
    assert.equal(resources.size, 0);
    f.service.options.openSandboxPreview.all = false;
    assert.equal((await publish()).state, "succeeded");
    const dockerRestored = await f.store.endpoint(appId, "production");
    assert.equal((await f.store.deployment(dockerRestored.appliedDeploymentId!))?.runtimeBackend, "docker");
  } finally {
    probe.closeAllConnections();
    await new Promise<void>(resolve => probe.close(() => resolve()));
    await f.close();
  }
});
