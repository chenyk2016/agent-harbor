/** Isolated control/observation/business databases, HTTP, wallet relay, actual Docker SDK, fixture-only inference. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { Pool } from "pg";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { recover } from "../dist/src/service/recovery.js";
import { SessionManager } from "../dist/src/service/session-manager.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { ApplicationStore } from "../dist/src/service/applications/store.js";
import { ApplicationService } from "../dist/src/service/applications/service.js";
import { openDatabase } from "../dist/src/service/db/client.js";
import { applyMigrations } from "../dist/src/service/db/migrate.js";
import { migrateObservations } from "../dist/src/service/observability/migrate.js";
import { createApi } from "../dist/src/service/http-api.js";
import { llmProviders, llmModelVersions, llmDeployments, llmDeploymentPrices } from "../dist/src/service/db/schema/llm.js";
import { tokenHash } from "../dist/src/service/auth.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";

process.env.AH_APP_ANALYSIS_ENABLED = "1";
const root = await mkdtemp(resolve("var/analysis-verify-"));
const controller = new Controller(root, { ...defaultProfile, image: process.env.AH_ANALYSIS_TEST_IMAGE ?? "agent-harbor:delivery-v29" });
const docker = controller.backend;
const pgName = "ah-analysis-pg-" + randomUUID().slice(0, 8);
const testImage = await docker.imageId("postgres:18-alpine");
const password = randomBytes(24).toString("hex");
const keys = { owner: "ah-analysis-owner-fixture", other: "ah-analysis-other-fixture" };
const recordResult = result => {
  const text = typeof result.content === "string" ? result.content : result.content[0].text;
  return JSON.parse(text.split("\n<system-reminder>")[0]);
};
let oldCursor;
const model = fixtureModel([], (body, results) => {
  const messages = JSON.stringify(body.messages);
  const input = messages.slice(messages.lastIndexOf("question"));
  if (input.includes("查询记录专项")) {
    const tool = (name, input) => ({ name: "mcp__app_data__" + name, input });
    switch (results.length) {
      case 0: return tool("list_datasets", {});
      case 1: return tool("query_records", { dataset: "business.signups", limit: 1,
        from: "2026-05-12T12:34:56Z", to: "2026-05-12T12:34:57Z" });
      case 2:
        oldCursor = recordResult(results[1]).nextCursor;
        return tool("query_records", { dataset: "business.signups", cursor: oldCursor });
      case 3: return tool("query_records", { dataset: "business.signups", columns: ["email"] });
      case 4: return tool("query_records", { dataset: "observability.events", from: "2026-01-01T00:00:00Z",
        to: "2030-01-01T00:00:00Z", columns: ["event_name", "deployment_id"], limit: 10 });
      case 5: return tool("query_records", { dataset: "business.activities" });
      default: return undefined;
    }
  }
  if (input.includes("测试环境记录专项")) {
    if (results.length === 0) return { name: "mcp__app_data__list_datasets", input: {} };
    if (results.length === 1) return { name: "mcp__app_data__query_records",
      input: { dataset: "business.signups", cursor: oldCursor } };
    if (results.length === 2) return { name: "mcp__app_data__query_records", input: { dataset: "observability.events" } };
    if (results.length === 3) return { name: "mcp__app_data__query_records", input: { dataset: "business.harbor_schema_migrations" } };
    return undefined;
  }
  return results.length ? undefined : { name: "mcp__app_data__read_report", input: { days: 7, section: "overview" } };
});
let delay = 0, entered = 0, traced = 0;
const upstream = createServer((request, response) => {
  entered++;
  const start = () => { if (!response.destroyed) model.server.emit("request", request, response); };
  if (delay) setTimeout(start, delay).unref();
  else start();
});
let admin, database, apps, manager, server, business;
const wait = async (check, timeout = 45000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for verification state");
};
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
};
const close = async (server) => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
try {
  await docker.command(["create", "--name", pgName, "-p", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql:rw,size=512m", "-e", "POSTGRES_USER=analysis",
    "-e", "POSTGRES_PASSWORD=" + password, testImage]);
  await docker.command(["start", pgName]);
  const state = JSON.parse(await docker.command(["inspect", pgName]))[0];
  const url = new URL(`postgres://analysis:${password}@127.0.0.1:${state.NetworkSettings.Ports["5432/tcp"][0].HostPort}/postgres`);
  admin = new Pool({ connectionString: url.href, max: 1 });
  await wait(() => admin.query("SELECT 1").catch(() => false));
  await admin.query("CREATE DATABASE analysis_observations");
  const obsUrl = new URL("/analysis_observations", url);
  const obsAdmin = new Pool({ connectionString: obsUrl.href, max: 1 });
  try { await migrateObservations(obsAdmin); await migrateObservations(obsAdmin); }
  finally { await obsAdmin.end(); }
  database = openDatabase(url.href);
  await applyMigrations(database.pool);
  const store = new ServiceStore(database.db);
  manager = new SessionManager(store, controller, "unused");
  await manager.identity.importKeys(Object.entries(keys).map(([userId, token]) => ({ userId, tokenHash: tokenHash(token) })));
  for (const owner of Object.keys(keys)) await manager.identity.ensure(owner);
  const edge = { publicOrigin: "http://127.0.0.1:1", actual: async () => ({}), replaceEndpoint: async () => {} };
  apps = new ApplicationService(new ApplicationStore(database.db), manager, controller, {
    root: join(root, ".applications"), nodeBase: "unused", dataAdminUrl: url.href,
    creators: new Set(Object.keys(keys)), edge,
    observation: { databaseUrl: obsUrl.href, publicUrl: "http://127.0.0.1:1", bindHost: "127.0.0.1", port: 0 },
  });
  await apps.initialize();
  const modelOrigin = await listen(upstream);
  const snapshot = { deploymentId: randomUUID(), versionId: randomUUID(), name: "Fixture", alias: "claude-haiku-4-5" };
  const price = { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0, id: randomUUID() };
  const providerId = randomUUID(), createdAt = Date.now();
  await database.db.transaction(async tx => {
    await tx.insert(llmProviders).values({ id: providerId, name: "Fixture", format: "anthropic", apiBase: modelOrigin, createdAt });
    await tx.insert(llmModelVersions).values({ id: snapshot.versionId, deploymentId: snapshot.deploymentId, providerId,
      upstreamModel: "fixture", routeName: "fixture", params: {}, tools: true, streaming: true, capabilities: {},
      digest: "fixture", state: "ready", createdBy: "fixture", createdAt });
    await tx.insert(llmDeployments).values({ id: snapshot.deploymentId, name: "Fixture", description: "",
      currentVersionId: snapshot.versionId, enabled: true, allowedUsers: Object.keys(keys), createdAt, updatedAt: createdAt });
    await tx.insert(llmDeploymentPrices).values({ ...price, deploymentId: snapshot.deploymentId, effectiveFrom: createdAt, createdBy: "fixture", createdAt });
  });
  const llm = {
    settings: { walletProxyUrl: "http://unused/inference", managementUrl: modelOrigin },
    select: async () => snapshot,
    runtime: async (session) => ({ url: "http://unused", token: session.id, model: "claude-haiku-4-5" }),
    walletConnection: async (token) => {
      const session = await store.session(token);
      assert.ok(session?.analysisAppId);
      return { binding: { ownerId: session.ownerId, sessionId: session.id }, logicalModel: "claude-haiku-4-5",
        deployment: { id: snapshot.deploymentId, name: "Fixture" },
        version: { id: snapshot.versionId, routeName: "fixture" }, price, upstreamToken: "fixture" };
    },
    catalog: async () => ({ enabled: false, models: [], defaultModelId: null, admin: false }),
    revokeSession: async () => {}, revokeUser: async () => {},
  };
  const manifest = JSON.parse(await readFile("templates/application-v1/harbor-app.json"));
  async function create(owner, title) {
    const { app, operation } = await apps.store.create(owner, title, "", randomUUID());
    const dev = await store.create(owner, title);
    await apps.store.activate(app.id, dev.id);
    await apps.store.progress(operation.id, "succeeded", "finished");
    return app.id;
  }
  const app = await create("owner", "报名数据验收");
  const sibling = await create("owner", "同所有者另一应用");
  const external = await create("other", "其他所有者应用");
  manifest.tables.signups.fields.seat_count = { type: "number" };
  manifest.tables.activities = { fields: { title: { type: "text" } }, publicCreate: false, publicRead: false };
  process.env.AH_APP_ANALYSIS_TABLE_FIELDS = JSON.stringify({ [app]: { production: { signups: ["seat_count"] } } });
  server = createApi(manager, controller, undefined, {}, undefined, undefined, apps, llm,
    { prepare: async () => { traced++; }, capturesContent: false });
  const origin = await listen(server);
  const dbState = await apps.data.provision(app, "production", manifest);
  business = new Pool({ connectionString: apps.data.connection(dbState, true), max: 1 });
  const signupIds = [randomUUID(), randomUUID()].sort().reverse();
  await business.query(`INSERT INTO signups(id,name,email,seat_count,created_at) VALUES
    ($1,'PRIVATE_SENTINEL','private@example.com',3,'2026-05-12T12:34:56.123456Z'),
    ($2,'PRIVATE_SENTINEL','private@example.com',2,'2026-05-12T12:34:56.123456Z')`, signupIds);
  const activityId = randomUUID();
  await business.query("INSERT INTO activities(id,title) VALUES($1,'PRIVATE_SENTINEL')", [activityId]);
  const bindings = new Map();
  async function addPages(id, env, count) {
    const key = id + env;
    let binding = bindings.get(key);
    if (!binding) {
      const deployment = randomUUID();
      const revision = randomUUID();
      await apps.observation.store.bind(id, env, revision, deployment, manifest.analytics);
      binding = await apps.observation.store.binding(deployment);
      bindings.set(key, binding);
    }
    for (let i = 0; i < count; i++)
      await apps.observation.store.ingest(binding, "browser", {
        eventId: randomUUID(), eventName: "page_view", occurredAt: Date.now(),
        anonymousId: randomUUID(), sessionId: randomUUID(), properties: { page: "/", device: "mobile", channel: "fixture" },
      });
  }
  await addPages(app, "production", 3);
  await addPages(app, "preview", 1);
  await addPages(sibling, "production", 2);
  await addPages(external, "production", 4);
  const request = (path, owner = "owner", method = "GET", body) => fetch(origin + "/api" + path, {
    method, headers: { authorization: "Bearer " + keys[owner], "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const prefix = `/applications/${app}`;
  const prod = prefix + "/analysis/production/messages";
  const preview = prefix + "/analysis/preview/messages";
  const normal = await (await request(prefix)).json();
  const start = async (path, text) => {
    const input = { clientMessageId: randomUUID(), text };
    const response = await request(path, "owner", "POST", input);
    assert.equal(response.status, 202, await response.clone().text());
    return { input, message: (await response.json()).message };
  };
  const finished = id => wait(async () => {
    const row = await store.message(id);
    return row && !["accepted", "running", "finalizing"].includes(row.status) && row;
  });
  const { input, message } = await start(prod, "正式近七天报名页怎么样");
  const duplicate = await request(prod, "owner", "POST", input);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).message.id, message.id);
  assert.equal((await request(prod, "owner", "POST", { ...input, text: "different" })).status, 409);
  const done = await finished(message.id);
  assert.equal(done.status, "succeeded", done.result);
  const history = await (await request(prod)).json();
  const report = history.events.find(event => event.type === "analysis.report").payload;
  const reportPath = prefix + "/observability/reports/" + report.reportId;
  const frozen = await (await request(reportPath)).json();
  assert.equal(frozen.data.summary.pageViews, 3);
  const usedReport = model.requests.flatMap(body => body.messages)
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === "tool_result" && JSON.stringify(block).includes(report.reportId));
  assert.ok(usedReport && JSON.stringify(usedReport).includes('pageViews'));
  assert.match(JSON.stringify(usedReport), /pageViews[^0-9]*3/);
  assert.equal(frozen.environment, "production");
  assert.equal((await request(reportPath, "other")).status, 404);
  assert.equal(normal.analysisEnabled, true);
  apps.options.creators.delete("owner");
  try {
    const denied = await Promise.all([
      request(prefix + "/messages", "owner", "POST", { clientMessageId: randomUUID(), text: "改应用", expectedHeadRevisionId: null }),
      request(prod),
      request(prod, "owner", "POST", { clientMessageId: randomUUID(), text: "问数据" }),
      request(prefix + "/analysis/production/events?after=0"),
      request(reportPath),
    ]);
    for (const response of denied) {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "APPLICATION_CREATOR_NOT_ENABLED");
    }
    assert.equal((await (await request(prefix)).json()).analysisEnabled, false);
  } finally {
    apps.options.creators.add("owner");
  }
  assert.equal((await request(reportPath)).status, 200);
  console.log("PASS shared creator permission gates editing, analysis history, submissions, events and reports");
  assert.equal((await request(`/applications/${sibling}/observability/reports/${report.reportId}`)).status, 404);
  assert.equal((await request(`/applications/${external}/analysis/production/messages`)).status, 404);
  assert.equal((await request("/sessions/" + message.sessionId)).status, 404);
  assert.equal((await request("/sessions/" + message.sessionId, "owner", "DELETE")).status, 409);
  assert.ok(!(await (await request("/sessions")).json()).some(row => row.id === message.sessionId));
  assert.ok(model.requests.every(body => body["no-log"] === true));
  assert.equal(traced, 0);
  assert.ok(!JSON.stringify(model.requests).includes("PRIVATE_SENTINEL"));
  const walletRows = await database.pool.query('SELECT state,"messageId" FROM wallet_requests WHERE "sessionId"=$1', [message.sessionId]);
  assert.ok(walletRows.rows.length >= 2 && walletRows.rows.every(row => row.state === "settled" && row.messageId === message.id));
  const continuation = await request(prefix + "/analysis/production/events?after=0");
  assert.equal(continuation.status, 200);
  const eventReader = continuation.body.getReader();
  let text = "";
  while (!text.includes("event: analysis.report")) {
    const frame = await eventReader.read();
    assert.equal(frame.done, false);
    text += new TextDecoder().decode(frame.value);
  }
  assert.match(text, new RegExp(report.reportId));
  await eventReader.cancel();
  await addPages(app, "production", 1);
  assert.equal((await (await request(reportPath)).json()).data.summary.pageViews, 3);
  assert.equal((await (await request(prefix + "/observability/summary?environment=production&days=7")).json()).summary.pageViews, 4);
  const test = await start(preview, "测试近七天");
  assert.equal((await finished(test.message.id)).status, "succeeded");
  const testHistory = await (await request(preview)).json();
  const testReport = testHistory.events.find(event => event.type === "analysis.report").payload;
  assert.equal((await (await request(prefix + "/observability/reports/" + testReport.reportId)).json()).data.summary.pageViews, 1);
  assert.notEqual(test.message.sessionId, message.sessionId);
  const after = await (await request(prefix)).json();
  for (const field of ["app", "revisions", "endpoints", "deployments", "operations"]) assert.deepEqual(after[field], normal[field], field);
  assert.equal((await business.query("SELECT count(*)::int AS n FROM signups")).rows[0].n, 2);
  assert.deepEqual(await docker.forSession(message.sessionId), []);
  console.log("PASS real SDK, authenticated API, same frozen report, late events, SSE, dedupe, scope, zero application writes, wallet linkage");

  const latestResults = () => model.requests.at(-1).messages.flatMap(message =>
    Array.isArray(message.content) ? message.content : []).filter(item => item.type === "tool_result").map(recordResult);
  const recordsTurn = await start(prod, "查询记录专项");
  assert.equal((await finished(recordsTurn.message.id)).status, "succeeded");
  const [catalog, page1, page2, denied, events, activities] = latestResults();
  assert.deepEqual(catalog.datasets.map(row => row.dataset).sort(),
    ["business.activities", "business.signups", "observability.events"]);
  const signupColumns = catalog.datasets.find(row => row.dataset === "business.signups").columns;
  assert.equal(signupColumns.find(row => row.name === "email").readable, false);
  assert.equal(signupColumns.find(row => row.name === "seat_count").readable, true);
  assert.equal(page1.rows[0].seat_count, 3);
  assert.equal(page2.rows[0].seat_count, 2);
  assert.deepEqual([page1.rows[0].id, page2.rows[0].id], signupIds);
  assert.equal(page2.nextCursor, null);
  assert.equal(denied.code, "DATASET_COLUMN_UNAVAILABLE");
  assert.deepEqual(activities.rows.map(row => row.id), [activityId]);
  assert.ok(!activities.columns.includes("title"));
  assert.equal(events.rows.length, 4);
  assert.ok(events.rows.every(row => row.deployment_id === bindings.get(app + "production").deployment_id));
  assert.ok(!JSON.stringify(model.requests).includes("PRIVATE_SENTINEL"));
  assert.ok(!JSON.stringify(model.requests).includes("private@example.com"));
  assert.ok(!(await (await request(prod)).json()).events.some(event =>
    event.messageId === recordsTurn.message.id && event.type === "analysis.report"));
  const previewRecords = await start(preview, "测试环境记录专项");
  assert.equal((await finished(previewRecords.message.id)).status, "succeeded");
  const [previewCatalog, staleCursor, previewEvents, internal] = latestResults();
  assert.equal(previewCatalog.businessReady, false);
  assert.deepEqual(previewCatalog.datasets.map(row => row.dataset), ["observability.events"]);
  assert.equal(staleCursor.code, "INVALID_DATASET_CURSOR");
  assert.equal(internal.code, "DATASET_NOT_FOUND");
  assert.equal(previewEvents.rows.length, 1);
  assert.equal(previewEvents.rows[0].deployment_id, bindings.get(app + "preview").deployment_id);
  console.log("PASS native catalog, authorized business columns, precise keyset pages, time filters, scope, protected fields and internal tables");

  await apps.observation.store.pool.query(
    `INSERT INTO observation_events(app_id,environment,deployment_id,revision_id,definition_hash,source,event_id,event_name,event_version,occurred_at,received_at,properties,payload_hash)
     SELECT $1,'production',$2,$3,$4,'browser','bulk-'||i,'page_view',1,$5,$5,'{}','fixture' FROM generate_series(1,20001) i`,
    [app, bindings.get(app + "production").deployment_id, bindings.get(app + "production").revision_id,
      bindings.get(app + "production").definition_hash, Date.now()]);
  const partial = await start(prod, "再看一次数据覆盖");
  assert.equal((await finished(partial.message.id)).status, "succeeded");
  const partialHistory = await (await request(prod)).json();
  const partialReport = partialHistory.events.find(event => event.messageId === partial.message.id && event.type === "analysis.report").payload;
  assert.equal((await (await request(prefix + "/observability/reports/" + partialReport.reportId)).json()).data.status, "partial");
  const cleared = await request(prefix + "/observability/data-deletions", "owner", "POST", { confirmAppId: app, environment: "production" });
  assert.equal(cleared.status, 200);
  assert.equal((await request(reportPath)).status, 404);
  assert.equal((await request(prefix + "/observability/reports/" + testReport.reportId)).status, 200);
  const blank = await create("owner", "未接入样本");
  const blankPath = `/applications/${blank}/analysis/production/messages`;
  const blankTurn = await start(blankPath, "未接入的访问量");
  assert.equal((await finished(blankTurn.message.id)).status, "succeeded");
  assert.ok(!(await (await request(blankPath)).json()).events.some(event => event.type === "analysis.report"));
  assert.ok(model.requests.some(body => JSON.stringify(body.messages).includes("not_instrumented")));
  delay = 5000;
  const baseline = entered;
  const inFlight = await start(prod, "停止本轮");
  await wait(() => entered > baseline);
  assert.equal((await request(prod + "/" + inFlight.message.id + "/cancel", "owner", "POST")).status, 200);
  assert.equal((await finished(inFlight.message.id)).status, "cancelled");
  assert.deepEqual(await docker.forSession(message.sessionId), []);
  delay = 0;
  const beforeRestart = model.requests.length;
  const interrupted = await store.accept(message.sessionId, randomUUID(), "重启前已接收");
  await store.environment(message.sessionId, "starting");
  assert.equal(await recover(store, controller), true);
  assert.equal((await store.message(interrupted.message.id)).status, "interrupted");
  assert.equal(model.requests.length, beforeRestart);
  await manager.identity.update("other", { disabled: true });
  assert.ok([401, 403].includes((await request(`/applications/${external}/analysis/production/messages`, "other")).status));
  console.log("PASS partial reports, scoped erase, cancellation/cleanup, interrupted recovery, disabled account");

  if (process.env.AH_ANALYSIS_KEEP_OPEN === "1") {
    console.log(JSON.stringify({ browserUrl: origin + prefix, loginKey: keys.owner }));
    await new Promise(resolve => process.once("SIGINT", resolve));
  }
  await business.end();
  business = undefined;
  const deletion = await request(prefix, "owner", "DELETE", { confirmName: "报名数据验收" });
  assert.equal(deletion.status, 202);
  const job = await deletion.json();
  await wait(async () => {
    const current = await (await request("/deletions/" + job.id)).json();
    if (current.state === "failed") throw new Error(JSON.stringify(current));
    return current.state === "completed";
  });
  assert.equal(await store.session(message.sessionId), undefined);
  assert.equal(await store.session(test.message.sessionId), undefined);
  assert.equal((await apps.observation.store.pool.query("SELECT count(*)::int AS n FROM observation_report_snapshots WHERE app_id=$1", [app])).rows[0].n, 0);
  console.log("PASS permanent app deletion removes both analysis histories and snapshots; real model requests: 0");
} finally {
  await close(server);
  await manager?.shutdown();
  await business?.end();
  await apps?.close();
  await database?.close();
  await admin?.end();
  await close(upstream);
  await docker.command(["rm", "-f", pgName]);
  await rm(root, { recursive: true, force: true });
}
