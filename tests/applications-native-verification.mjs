/** 完整应用流程：真实PG/Git/Docker/Caddy/Claude SDK，模型返回由本地fixture控制。 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { AppDockerDriver } from "../dist/src/service/applications/docker.js";
import { CaddyApplicationEdge } from "../dist/src/service/applications/edge.js";
import { ApplicationService } from "../dist/src/service/applications/service.js";
import { ApplicationStore } from "../dist/src/service/applications/store.js";
import { openDatabase } from "../dist/src/service/db/client.js";
import { applyMigrations } from "../dist/src/service/db/migrate.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { SessionManager } from "../dist/src/service/session-manager.js";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { tokenHash } from "../dist/src/service/auth.js";
import { createApi } from "../dist/src/service/http-api.js";
import { ServiceClient } from "../dist/src/clients/service-client.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";

const evidence = resolve(
  "var/evidence/app-builder-implementation/2026-10-26",
  "native-" + Date.now(),
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const root = join(evidence, "sessions"),
  driver = new AppDockerDriver(join(root, ".applications"));
const suffix = randomUUID().slice(0, 8),
  pgName = "ah-app-native-pg-" + suffix,
  edgeName = "ah-app-native-edge-" + suffix;
const sqlMode = process.env.AH_APP_VERIFY_SQL === "1";
const password = randomBytes(24).toString("hex"),
  checks = [],
  cleanupErrors = [];
let database, edge, service, manager, server, model, appId, api, publicOrigin;
const summary = {
  passed: false,
  evidence,
  realModelRequests: 0,
  checks,
  cleanupErrors,
};
const pass = (text) => {
  checks.push(text);
  console.log("PASS", text);
};
async function wait(work, timeout = 180000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await work();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Verification timeout", { cause: last });
}
async function port(name, value) {
  return Number(
    JSON.parse(await driver.command(["inspect", name]))[0].NetworkSettings
      .Ports[value + "/tcp"][0].HostPort,
  );
}
async function caddy(path, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, edge.adminOrigin),
      { method: "PATCH", headers: { "Content-Type": "application/json" } },
      (response) => {
        let text = "";
        response.on("data", (value) => {
          text += value;
        });
        response.on("end", () =>
          response.statusCode < 300 ? resolve(text) : reject(new Error(text)),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function operation(result) {
  const id = result.operation.id;
  const final = await wait(async () => {
    const value = await service.store.operation("application-test", appId, id);
    return ["queued", "running", "cancelling"].includes(value.state)
      ? undefined
      : value;
  });
  assert.equal(final.state, "succeeded", JSON.stringify(final));
  return final;
}
async function detail() {
  return api.request(`/applications/${appId}`);
}
async function previewReady(revisionId) {
  return wait(async () => {
    const result = await detail(),
      endpoint = result.endpoints.find(
        (value) => value.environment === "preview",
      );
    const target = result.deployments.find(
      (value) => value.id === endpoint.appliedDeploymentId,
    );
    return endpoint.state === "ready" && target?.revisionId === revisionId
      ? result
      : undefined;
  });
}
try {
  await driver.command([
    "create",
    "--name",
    pgName,
    "--label",
    `harbor.app.store=${driver.owner}`,
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=768m",
    "--env",
    "POSTGRES_USER=application_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:18-alpine",
  ]);
  await driver.command(["start", pgName]);
  const adminUrl = `postgres://application_test:${password}@127.0.0.1:${await port(pgName, 5432)}/postgres`;
  database = openDatabase(adminUrl);
  await wait(() => database.pool.query("SELECT 1"), 30000);
  await applyMigrations(database.pool);
  const configPath = join(evidence, "caddy.json");
  await writeFile(
    configPath,
    JSON.stringify({
      admin: { listen: ":2019" },
      apps: {
        http: {
          servers: {
            applications: {
              listen: [":8080"],
              routes: [
                {
                  handle: [
                    {
                      handler: "subroute",
                      "@id": "harbor-application-routes",
                      routes: [],
                    },
                  ],
                },
                { handle: [{ handler: "static_response", status_code: 404 }] },
              ],
            },
          },
        },
      },
    }),
  );
  await driver.command([
    "create",
    "--name",
    edgeName,
    "--label",
    `harbor.app.store=${driver.owner}`,
    "--publish",
    "127.0.0.1::8080",
    "--publish",
    "127.0.0.1::2019",
    "--mount",
    `type=bind,src=${configPath},dst=/etc/caddy/app.json,readonly`,
    "--tmpfs",
    "/data:rw,size=16m",
    "--tmpfs",
    "/config:rw,size=16m",
    await driver.imageId("caddy:2-alpine"),
    "caddy",
    "run",
    "--config",
    "/etc/caddy/app.json",
  ]);
  await driver.command(["start", edgeName]);
  publicOrigin = `http://127.0.0.1:${await port(edgeName, 8080)}`;
  edge = new CaddyApplicationEdge(
    `http://127.0.0.1:${await port(edgeName, 2019)}`,
    publicOrigin,
    "host.docker.internal",
  );
  await wait(() => edge.actual(), 30000);
  const initial = await readFile(
    "templates/application-v1/src/main.tsx",
    "utf8",
  );
  const prompts = ["创建技术沙龙报名页", "第二次修改：标题改成周末沙龙"];
  model = fixtureModel([], (body) => {
    const messages = body.messages ?? [];
    for (const [i, prompt] of prompts.entries()) {
      const index = messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(prompt),
      );
      if (
        index >= 0 &&
        !messages
          .slice(index + 1)
          .some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((block) => block.type === "tool_result"),
          )
      )
        return {
          name: "Write",
          input: {
            file_path: "/workspace/src/main.tsx",
            content: initial.replace(
              "<h1>活动报名</h1>",
              `<h1>${i ? "周末沙龙" : "技术沙龙"}</h1>`,
            ),
          },
        };
    }
  });
  await new Promise((resolve) => model.server.listen(0, "0.0.0.0", resolve));
  const controller = new Controller(root, {
    ...defaultProfile,
    image: process.env.AH_VERIFY_IMAGE ?? "agent-harbor:0.6.0",
    gatewayUrl: `http://host.docker.internal:${model.server.address().port}`,
    timeoutMs: 60000,
  });
  manager = new SessionManager(
    new ServiceStore(database.db),
    controller,
    "LOCAL_FIXTURE_ONLY",
  );
  await manager.identity.importKeys([
    {
      userId: "application-test",
      tokenHash: tokenHash("application-fixture-only"),
    },
  ]);
  const options = {
    root: join(root, ".applications"),
    nodeBase:
      "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
    dataAdminUrl: adminUrl,
    databaseHost: "host.docker.internal",
    edge,
    creators: new Set(["application-test"]),
    ...(sqlMode ? {} : { templateDirectory: "templates/application-v1" }),
    downloadProxy: "http://host.docker.internal:7890",
  };
  service = new ApplicationService(
    new ApplicationStore(database.db),
    manager,
    controller,
    options,
  );
  await service.initialize();
  server = createApi(
    manager,
    controller,
    undefined,
    { origin: publicOrigin },
    undefined,
    undefined,
    service,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await caddy("/config/apps/http/servers/applications/routes/1/handle/0", {
    handler: "reverse_proxy",
    upstreams: [{ dial: `host.docker.internal:${server.address().port}` }],
  });
  api = new ServiceClient(publicOrigin, "application-fixture-only");
  const created = await api.request("/applications", "POST", {
    title: "技术沙龙报名",
    prompt: prompts[0],
    clientRequestId: randomUUID(),
  });
  appId = created.app.id;
  await operation(created);
  await wait(async () => {
    const app = await service.store.owned("application-test", appId);
    return app.nextRevisionNumber === 3;
  });
  let state = await detail(),
    originalRevision = state.app.headRevisionId;
  await previewReady(originalRevision);
  const session = await manager.store.session(state.app.developmentSessionId);
  assert.equal(session.environment, "closed");
  assert.match(
    await readFile(join(root, session.id, "workspace/src/main.tsx"), "utf8"),
    /<h1>技术沙龙<\/h1>/,
  );
  pass(
    "HTTP create uses native Claude SDK Write, confirms development closed, saves Git revision and runs real preview image",
  );
  let endpoint = (await detail()).endpoints.find(
    (value) => value.environment === "production",
  );
  const publication = await api.request(
    `/applications/${appId}/production`,
    "POST",
    {
      revisionId: originalRevision,
      expectedGeneration: endpoint.generation,
      clientRequestId: randomUUID(),
    },
  );
  await operation(publication);
  state = await detail();
  endpoint = state.endpoints.find(
    (value) => value.environment === "production",
  );
  const originalDeployment = endpoint.appliedDeploymentId;
  let response = await fetch(endpoint.url + (sqlMode ? "api/signup" : "api/tables/signups"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Revision": originalRevision,
    },
    body: JSON.stringify({
      name: "first-production",
      email: "first@example.com",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    (await api.request(`/applications/${appId}/data/production/signups`)).rows
      .length,
    1,
  );
  pass(
    "published path serves actual app container and submitted data appears in owner workbench",
  );
  const generated = await api.request(
    `/applications/${appId}/messages`,
    "POST",
    {
      clientMessageId: randomUUID(),
      text: prompts[1],
      expectedHeadRevisionId: originalRevision,
    },
  );
  await operation(generated);
  state = await detail();
  const updatedRevision = state.app.headRevisionId;
  assert.notEqual(updatedRevision, originalRevision);
  await previewReady(updatedRevision);
  const updated = await api.request(
    `/applications/${appId}/production`,
    "POST",
    {
      revisionId: updatedRevision,
      expectedGeneration: endpoint.generation,
      clientRequestId: randomUUID(),
    },
  );
  await operation(updated);
  state = await detail();
  endpoint = state.endpoints.find(
    (value) => value.environment === "production",
  );
  const originalImage = (await service.store.deployment(originalDeployment))
    .spec.build.imageId;
  const rolled = await api.request(`/applications/${appId}/rollback`, "POST", {
    deploymentId: originalDeployment,
    expectedGeneration: endpoint.generation,
    clientRequestId: randomUUID(),
  });
  await operation(rolled);
  state = await detail();
  endpoint = state.endpoints.find(
    (value) => value.environment === "production",
  );
  assert.equal(
    (await service.store.deployment(endpoint.appliedDeploymentId)).spec.build
      .imageId,
    originalImage,
  );
  assert.equal(
    (await api.request(`/applications/${appId}/data/production/signups`)).rows
      .length,
    1,
  );
  pass(
    "continued native conversation creates new version; production update and exact-image rollback retain business records",
  );
  const restored = await api.request(`/applications/${appId}/restore`, "POST", {
    revisionId: originalRevision,
    expectedHeadRevisionId: updatedRevision,
    clientRequestId: randomUUID(),
  });
  await operation(restored);
  state = await detail();
  assert.equal(state.revisions[0].restoredFromId, originalRevision);
  await previewReady(state.app.headRevisionId);
  const currentProduction = (
    await service.store.deployment(endpoint.appliedDeploymentId)
  ).spec;
  await service.close();
  assert.equal((await fetch(endpoint.url + "__harbor/health")).status, 200);
  service = new ApplicationService(
    new ApplicationStore(database.db),
    manager,
    controller,
    options,
  );
  await service.initialize();
  assert.equal(
    (await driver.inspect(currentProduction.container)).Image,
    originalImage,
  );
  pass(
    "source restoration adds a new version; production remains running across application manager close/reopen",
  );
  await edge.replace([]);
  const missingRoute = await fetch(endpoint.url + "__harbor/health");
  assert.notEqual(missingRoute.status, 200);
  await service.close();
  service = new ApplicationService(
    new ApplicationStore(database.db),
    manager,
    controller,
    options,
  );
  await service.initialize();
  assert.equal(
    (await service.store.endpoint(appId, "production")).state,
    "ready",
  );
  assert.equal((await fetch(endpoint.url + "__harbor/health")).status, 200);
  await service.reconcile("application-test", appId);
  assert.equal(
    (await service.store.endpoint(appId, "production")).state,
    "ready",
  );
  assert.equal((await fetch(endpoint.url + "__harbor/health")).status, 200);
  pass(
    "startup restores lost gateway routes for registered healthy deployments and explicit reconciliation stays safe",
  );
  // Router重新绑定新的协调器；公开网关继续使用相同管理服务端口。
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = createApi(
    manager,
    controller,
    undefined,
    { origin: publicOrigin },
    undefined,
    undefined,
    service,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await caddy("/config/apps/http/servers/applications/routes/1/handle/0", {
    handler: "reverse_proxy",
    upstreams: [{ dial: `host.docker.internal:${server.address().port}` }],
  });
  if (sqlMode) {
    const migrated = await api.request(`/applications/${appId}/data/production`);
    assert.deepEqual(migrated.tables.map(item => item.name), ["signups"]);
    assert.deepEqual(migrated.migrations.map(item => item.name), ["001_create_signups.sql"]);
    assert.equal((await fetch(endpoint.url + "api/tables/signups")).status, 404);
    const previous = await detail();
    await writeFile(join(root, session.id, "workspace/migrations/002_add_status.sql"),
      "ALTER TABLE signups ADD COLUMN status text;\n");
    const next = await operation(await api.request(`/applications/${appId}/snapshots`, "POST", {
      clientRequestId: randomUUID(), expectedHeadRevisionId: previous.app.headRevisionId,
    }));
    await previewReady(next.result.revisionId);
    const previewData = await api.request(`/applications/${appId}/data/preview`);
    assert.deepEqual(previewData.migrations.map(item => item.name), ["001_create_signups.sql", "002_add_status.sql"]);
    assert.equal(previewData.tables[0].columns.some(column => column.name === "status"), true);
    const unchanged = await api.request(`/applications/${appId}/data/production`);
    assert.deepEqual(unchanged.migrations, migrated.migrations);
    assert.equal(unchanged.tables[0].columns.some(column => column.name === "status"), false);
    assert.equal((await api.request(`/applications/${appId}/data/production/signups`)).rows.length, 1);
    pass("new SQL app uses scoped data catalog, runs migrations once per environment, and preserves production during preview");
  } else {
    state = await detail();
    const goodPreview = state.endpoints.find(value => value.environment === "preview");
    const manifestPath = join(root, session.id, "workspace/harbor-app.json");
    const incompatible = JSON.parse(await readFile(manifestPath, "utf8"));
    delete incompatible.tables.signups.fields.email;
    await writeFile(manifestPath, JSON.stringify(incompatible));
    const badSnapshot = await operation(await api.request(`/applications/${appId}/snapshots`, "POST", {
      clientRequestId: randomUUID(),
      expectedHeadRevisionId: state.app.headRevisionId,
    }));
    const failedPreview = await wait(async () => (await detail()).operations.find(item =>
      item.kind === "preview" && item.payload.revisionId === badSnapshot.result.revisionId && item.state === "failed",
    ));
    assert.equal(failedPreview.error, "DESTRUCTIVE_SCHEMA_CHANGE");
    const previewAfterFailure = (await detail()).endpoints.find(value => value.environment === "preview");
    assert.equal(previewAfterFailure.appliedDeploymentId, goodPreview.appliedDeploymentId);
    assert.equal((await fetch(goodPreview.url + "__harbor/health")).status, 200);
    pass("incompatible schema blocks the new preview with its specific reason and keeps the previous URL healthy");
  }
  if (process.env.AH_APP_FULL_REGRESSION === "1") {
    const regression = await new Promise((resolve) => {
      const child = spawn("npm", ["test"], {
        env: { ...process.env, AH_TEST_DATABASE_URL: adminUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      child.stdout.on("data", (value) => chunks.push(value));
      child.stderr.on("data", (value) => chunks.push(value));
      child.on("error", (error) =>
        resolve({ code: -1, output: String(error) }),
      );
      child.on("exit", (code) =>
        resolve({ code, output: Buffer.concat(chunks).toString() }),
      );
    });
    await writeFile(join(evidence, "regression.log"), regression.output);
    assert.equal(regression.code, 0, regression.output.slice(-4000));
    pass(
      "full regression passed on disposable PostgreSQL after native application flow",
    );
  }
  summary.passed = true;
  summary.fixtureRequests = model.requests.length;
  summary.appId = appId;
  summary.managementUrl = `${publicOrigin}/applications/${appId}`;
  summary.applicationUrl = endpoint.url;
  await writeFile(
    join(evidence, "live.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    "MANAGEMENT",
    summary.managementUrl,
    "TEST LOGIN application-fixture-only",
  );
  if (process.env.AH_APP_KEEP_OPEN === "1") {
    console.log("WAITING_BROWSER; SIGINT/SIGTERM cleans only this fixture");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} catch (error) {
  summary.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await manager?.shutdown();
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  try {
    await service?.close();
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  if (service)
    for (const deployment of await service.store.deployments().catch(() => []))
      try {
        await driver.destroy(
          deployment.spec?.container ?? "ah-app-" + deployment.id,
        );
      } catch (error) {
        cleanupErrors.push(String(error));
      }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (model) {
    model.server.closeAllConnections();
    await new Promise((resolve) => model.server.close(resolve));
  }
  await database?.close();
  for (const name of [edgeName, pgName]) {
    try {
      await writeFile(
        join(evidence, name + ".log"),
        await driver.command(["logs", name]),
      );
    } catch {}
    try {
      await driver.destroy(name);
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (cleanupErrors.length) {
    summary.passed = false;
    process.exitCode = 1;
  }
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log("EVIDENCE", evidence, "PASSED", summary.passed);
}
