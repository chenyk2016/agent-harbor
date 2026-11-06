/** 隔离真实PG/Git/Runtime/容器/网关/管理接口；浏览器可连接保留模式，不触碰4318。 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { AppDockerDriver } from "../dist/src/service/applications/docker.js";
import { ApplicationBuilder } from "../dist/src/service/applications/builder.js";
import { ApplicationSources } from "../dist/src/service/applications/source-store.js";
import { ApplicationData } from "../dist/src/service/applications/data.js";
import { CaddyApplicationEdge } from "../dist/src/service/applications/edge.js";
import { ApplicationService } from "../dist/src/service/applications/service.js";
import { ApplicationStore } from "../dist/src/service/applications/store.js";
import { openDatabase } from "../dist/src/service/db/client.js";
import { applyMigrations } from "../dist/src/service/db/migrate.js";
import { migrateObservations } from "../dist/src/service/observability/migrate.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { SessionManager } from "../dist/src/service/session-manager.js";
import { Controller } from "../dist/src/runtime/controller.js";
import { tokenHash } from "../dist/src/service/auth.js";
import { createApi } from "../dist/src/service/http-api.js";
const evidence = resolve(
  "var/evidence/observability/2026-10-26/run-" + Date.now(),
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const root = join(evidence, "sessions"),
  driver = new AppDockerDriver(join(root, ".applications")),
  suffix = randomUUID().slice(0, 8),
  pgName = "ah-observe-pg-" + suffix,
  edgeName = "ah-observe-edge-" + suffix;
const password = randomBytes(24).toString("hex"),
  deployments = [],
  environments = [],
  images = [],
  checks = [],
  cleanupErrors = [];
let admin, database, service, manager, server, edge;
const summary = {
  passed: false,
  evidence,
  checks,
  cleanupErrors,
  realModelRequests: 0,
};
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
async function wait(work, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const r = await work();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Timeout", { cause: last });
}
async function port(name, p) {
  return Number(
    JSON.parse(await driver.command(["inspect", name]))[0].NetworkSettings
      .Ports[p + "/tcp"][0].HostPort,
  );
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
    "--memory",
    "1g",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=512m",
    "--env",
    "POSTGRES_USER=observe_admin",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:18-alpine",
  ]);
  await driver.command(["start", pgName]);
  const adminUrl = `postgres://observe_admin:${password}@127.0.0.1:${await port(pgName, 5432)}/postgres`;
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  await wait(() => admin.query("SELECT 1"));
  await admin.query("CREATE DATABASE observation_test");
  const obsUrl = new URL(adminUrl);
  obsUrl.pathname = "/observation_test";
  const obsAdmin = new Pool({ connectionString: obsUrl.href, max: 1 });
  await migrateObservations(obsAdmin);
  await obsAdmin.end();
  if (process.env.AH_OBSERVATION_REGRESSION === "1") {
    const log = await import("node:fs").then((m) =>
      m.createWriteStream(join(evidence, "regression.log")),
    );
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        ...(process.env.AH_OBSERVATION_FOCUSED === "1"
          ? ["dist/tests/observability.test.js"]
          : await import("node:fs/promises")
              .then((m) => m.readdir("dist/tests"))
              .then((files) =>
                files
                  .filter((f) => f.endsWith(".test.js"))
                  .map((f) => "dist/tests/" + f),
              )),
      ],
      {
        env: { ...process.env, AH_TEST_DATABASE_URL: adminUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const [status] = await once(child, "exit");
    if (status !== 0) throw new Error("Regression failed; see regression.log");
    pass("PG regression suite");
  }
  database = openDatabase(adminUrl);
  await applyMigrations(database.pool);
  manager = new SessionManager(
    new ServiceStore(database.db),
    new Controller(root),
    "fixture-only",
  );
  await manager.identity.importKeys([
    { userId: "observer", tokenHash: tokenHash("observe-verification-only") },
    { userId: "other", tokenHash: tokenHash("observe-other-only") },
  ]);
  const config = {
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
  };
  const logs = join(evidence, "logs");
  await mkdir(logs);
  config.logging = {
    logs: {
      default: { exclude: ["http.log.access.observe"] },
      observe: {
        writer: { output: "file", filename: "/logs/access.json" },
        encoder: {
          format: "filter",
          wrap: { format: "json" },
          fields: Object.fromEntries(
            [
              "request>remote_ip",
              "request>remote_port",
              "request>client_ip",
              "request>headers",
              "request>uri",
              "resp_headers",
            ].map((k) => [k, { filter: "delete" }]),
          ),
        },
        include: ["http.log.access.observe"],
      },
    },
  };
  config.apps.http.servers.applications.logs = {
    default_logger_name: "observe",
  };
  const configPath = join(evidence, "caddy.json");
  await writeFile(configPath, JSON.stringify(config));
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
    "--mount",
    `type=bind,src=${logs},dst=/logs`,
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
  edge = new CaddyApplicationEdge(
    `http://127.0.0.1:${await port(edgeName, 2019)}`,
    `http://127.0.0.1:${await port(edgeName, 8080)}`,
    "host.docker.internal",
  );
  await wait(() => edge.actual());
  service = new ApplicationService(
    new ApplicationStore(database.db),
    manager,
    new Controller(root),
    {
      root: driver.root,
      dataAdminUrl: adminUrl,
      databaseHost: "host.docker.internal",
      nodeBase:
        "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
      creators: new Set(["observer"]), templateDirectory: "templates/application-v1",
      edge,
      downloadProxy: "http://host.docker.internal:7890",
      observation: {
        databaseUrl: obsUrl.href,
        publicUrl: "http://host.docker.internal:4327",
        bindHost: "0.0.0.0",
        port: 4327,
        edgeLog: join(logs, "access.json"),
      },
    },
  );
  await service.initialize();
  server = createApi(
    manager,
    new Controller(root),
    undefined,
    {},
    undefined,
    undefined,
    service,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const control = `http://127.0.0.1:${server.address().port}`;
  const store = service.store;
  const created = await store.create(
    "observer",
    "观测验收报名应用",
    "",
    randomUUID(),
  );
  const appId = created.app.id;
  const developmentId = randomUUID();
  await service.controller.store.prepare(developmentId);
  await manager.create("observer", "观测应用开发会话", developmentId);
  await store.activate(appId, developmentId);
  await store.progress(created.operation.id, "succeeded", "finished");
  const source = join(evidence, "source");
  await cp("templates/application-v1", source, { recursive: true });
  const revision = await service.sources.snapshot(appId, source);
  const saved = await store.addRevision(
    appId,
    revision,
    JSON.parse(await readFile(join(source, "harbor-app.json"), "utf8")),
    "Initial observation template",
    null,
  );
  // 独立正式/测试数据库，服务源版本ID与镜像构建ID固定。
  for (const environment of ["production", "preview"]) {
    const data = await service.data.provision(
      appId,
      environment,
      JSON.parse(await readFile(join(source, "harbor-app.json"), "utf8")),
    );
    environments.push(data);
    await store.dataState(data);
    const build = await service.builder.build(revision, environment, saved.id);
    images.push(build.imageId);
    await store.registerBuild(appId, saved.id, environment, build.id);
    await store.finishBuild(build.id, build);
    const deploymentId = randomUUID();
    await store.registerDeployment(
      appId,
      build.id,
      environment,
      deploymentId,
      1,
    );
    const observation = await service.observation.deployment(
      appId,
      environment,
      saved.id,
      deploymentId,
      data.schema.analytics,
    );
    const deployment = await service.driver.create(
      build,
      deploymentId,
      service.data.connection(data, false, "host.docker.internal"),
      observation,
    );
    deployments.push(deployment);
    await service.driver.start(deployment);
    await service.driver.healthy(deployment);
    await store.deploymentState(deploymentId, "healthy", deployment);
    await store.desire(appId, environment, deploymentId, 0);
    await edge.replace([...deployments]);
    await store.observed(appId, environment, 1, deploymentId);
  }
  const production = deployments[0],
    preview = deployments[1],
    base = edge.publicOrigin + production.build.basePath;
  const health = await fetch(base + "__harbor/health").then((r) => r.json());
  assert.equal(health.observationVersion, 1);
  assert.ok(!JSON.stringify(health).includes(password));
  assert.ok(!("observation" in health));
  pass("private runtime configuration excluded from health");
  const visitor = randomUUID(),
    session = randomUUID();
  const e = {
    eventId: randomUUID(),
    eventName: "page_view",
    eventVersion: 1,
    occurredAt: Date.now() - 500,
    anonymousId: visitor,
    sessionId: session,
    clientRevisionId: saved.id,
    properties: { page: "/", channel: "verification", device: "desktop" },
  };
  async function browser(events) {
    const r = await fetch(base + "__harbor/observe/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
    assert.equal(r.status, 202, await r.text());
  }
  await browser([e]);
  await browser([e]);
  await browser([
    {
      ...e,
      eventId: randomUUID(),
      eventName: "signup_started",
      occurredAt: Date.now() - 200,
      properties: {},
    },
  ]);
  await browser([
    {
      ...e,
      eventId: randomUUID(),
      eventName: "signup_succeeded",
      properties: {},
    },
  ]);
  const submit = await fetch(base + "api/tables/signups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Revision": saved.id,
      "X-App-Visitor": visitor,
      "X-App-Visit": session,
    },
    body: JSON.stringify({
      name: "Fixture Name",
      email: "private-sentinel@example.com",
    }),
  });
  assert.equal(submit.status, 201);
  const signup = await submit.json();
  assert.ok(signup.requestId);
  await service.observation.drain(appId, "production");
  await service.observation.drain(appId, "production");
  const report = await service.observation.summary(
    "observer",
    appId,
    "production",
    7,
  );
  assert.equal(report.summary.pageViews, 1);
  assert.equal(report.summary.goals, 1);
  assert.equal(report.summary.visitors, 1);
  assert.deepEqual(
    report.funnels[0].steps.map((s) => s.count),
    [1, 1, 1],
  );
  assert.ok(report.rejectedSinceRestart >= 1);
  pass(
    "deduplicated real browser events and transactional server success; spoofed success rejected",
  );
  const empty = await service.observation.summary(
    "observer",
    appId,
    "preview",
    7,
  );
  assert.equal(empty.summary.goals, 0);
  pass("preview and production data isolated");
  const oldRevisionId = randomUUID(),
    oldDeploymentId = randomUUID();
  const oldDefinition = structuredClone(environments[0].schema.analytics);
  oldDefinition.events.legacy_started = {
    version: 1,
    source: "browser",
    properties: {},
  };
  await service.observation.store.bind(
    appId,
    "production",
    oldRevisionId,
    oldDeploymentId,
    oldDefinition,
  );
  await browser([
    {
      ...e,
      eventId: randomUUID(),
      eventName: "legacy_started",
      clientRevisionId: oldRevisionId,
      properties: {},
    },
  ]);
  const legacy = await service.observation.store.pool.query(
    "SELECT client_revision_id,revision_id,definition_hash FROM observation_events WHERE event_name='legacy_started'",
  );
  assert.equal(legacy.rows[0].client_revision_id, oldRevisionId);
  assert.equal(legacy.rows[0].revision_id, saved.id);
  pass(
    "known old page contract retained with current serving deployment identity",
  );
  await assert.rejects(
    service.observation.summary("other", appId, "production", 7),
  );
  const unauthorized = await fetch(
    control + `/api/applications/${appId}/observability/summary`,
    { headers: { Authorization: "Bearer observe-other-only" } },
  );
  assert.equal(unauthorized.status, 404);
  pass("management query ownership enforced");
  const raw = await service.observation.store.pool.query(
    "SELECT properties FROM observation_events",
  );
  assert.ok(!JSON.stringify(raw.rows).includes("private-sentinel"));
  pass("business data content absent from observation events");
  // Collector暂停：业务继续成功，outbox在恢复之后补齐。
  await service.observation.close();
  service.observation = undefined;
  const offline = await fetch(base + "api/tables/signups", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Revision": saved.id },
    body: JSON.stringify({ name: "Offline", email: "offline@example.com" }),
  });
  assert.equal(offline.status, 201);
  const { ObservationService } =
    await import("../dist/src/service/observability/service.js");
  service.observation = new ObservationService(
    service,
    service.options.observation,
  );
  await service.observation.initialize();
  await service.observation.drain(appId, "production");
  assert.equal(
    (await service.observation.summary("observer", appId, "production", 7))
      .summary.goals,
    2,
  );
  pass("collector restart and outage do not block business; outbox recovers");
  await service.observation.tick();
  const withEdge = await service.observation.summary(
    "observer",
    appId,
    "production",
    7,
  );
  assert.ok(withEdge.summary.edgeRequests > 0);
  const logged = await readFile(join(logs, "access.json"), "utf8");
  assert.ok(!logged.includes("private-sentinel"));
  assert.ok(!logged.includes("remote_ip"));
  assert.ok(!logged.includes("Authorization"));
  pass(
    "real sanitized Caddy access log plus container health and resource collection",
  );
  summary.appId = appId;
  summary.control = control;
  summary.publicUrl = base;
  summary.previewUrl = edge.publicOrigin + preview.build.basePath;
  summary.login = "observe-verification-only";
  await writeFile(
    join(evidence, "browser-entry.json"),
    JSON.stringify(summary, null, 2),
  );
  if (process.env.AH_OBSERVATION_KEEP_OPEN === "1") {
    console.log(
      "BROWSER_READY",
      JSON.stringify({ control, appId, publicUrl: base, evidence }),
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
  summary.passed = true;
} catch (e) {
  summary.error = String(e.stack ?? e);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (service)
    try {
      await service.close();
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  for (const d of deployments)
    try {
      await driver.destroy(d.container);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  if (manager) await manager.shutdown();
  if (database) await database.close();
  if (admin) await admin.end();
  for (const name of [edgeName, pgName])
    try {
      await driver.destroy(name);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  if (cleanupErrors.length) {
    summary.passed = false;
    process.exitCode = 1;
  }
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: summary.passed,
      evidence,
      checks: checks.length,
      cleanupErrors,
    }),
  );
}
