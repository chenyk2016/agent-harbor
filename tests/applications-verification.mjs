/** 阶段A真实验证：隔离PG/Caddy、Git、依赖构建、应用镜像和实际HTTP。没有模型请求。 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { Agent, setGlobalDispatcher } from "undici";
import { ApplicationSources } from "../dist/src/service/applications/source-store.js";
import { ApplicationBuilder } from "../dist/src/service/applications/builder.js";
import { ApplicationData } from "../dist/src/service/applications/data.js";
import { AppDockerDriver } from "../dist/src/service/applications/docker.js";
import { CaddyApplicationEdge } from "../dist/src/service/applications/edge.js";
import { parseManifest } from "../dist/src/service/applications/manifest.js";

// This probe repeatedly replaces Caddy routes and stops their old upstreams.
// Fresh connections keep transport reuse from obscuring the endpoint assertions.
const dispatcher = new Agent({ pipelining: 0 });
setGlobalDispatcher(dispatcher);

const evidence = resolve(
  "var/evidence/app-builder-implementation/2026-10-26",
  "run-" + Date.now(),
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const root = join(evidence, "data"),
  driver = new AppDockerDriver(root),
  sources = new ApplicationSources(root);
const nodeBase =
  "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8";
const builder = new ApplicationBuilder(
  root,
  sources,
  nodeBase,
  resolve("infra/app-runtime"),
  "http://host.docker.internal:7890",
);
const suffix = randomUUID().slice(0, 8),
  pgName = "ah-app-pg-" + suffix,
  edgeName = "ah-app-edge-" + suffix;
const password = randomBytes(24).toString("hex");
const deployments = [],
  dataEnvironments = [],
  images = [],
  passed = [];
let data, admin, edge, regression;
const summary = {
  passed: false,
  evidence,
  realModelRequests: 0,
  checks: passed,
};
function pass(name) {
  passed.push(name);
  console.log("PASS", name);
}
async function fixturePort(name, port) {
  const value = JSON.parse(await driver.command(["inspect", name]))[0];
  return Number(value.NetworkSettings.Ports[port + "/tcp"][0].HostPort);
}
async function wait(work, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      return await work();
    } catch (e) {
      error = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw error;
}
async function build(source, appId, target) {
  const revision = await sources.snapshot(appId, source);
  const artifact = await builder.build(revision, target);
  images.push(artifact.imageId);
  return { revision, artifact };
}
async function start(artifact, environment) {
  const deployment = await driver.create(
    artifact,
    randomUUID(),
    data.connection(environment, false, "host.docker.internal"),
    undefined,
    undefined,
    "https://studio.example.net",
  );
  deployments.push(deployment);
  await driver.start(deployment);
  await driver.healthy(deployment);
  return deployment;
}
async function submit(deployment, name) {
  const response = await fetch(
    edge.publicOrigin + deployment.build.basePath + "api/tables/signups",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Revision": deployment.build.revisionId,
      },
      body: JSON.stringify({ name, email: name + "@example.com" }),
    },
  );
  assert.equal(response.status, 201, await response.text());
}
async function rows(environment) {
  const pool = new Pool({
    connectionString: data.connection(environment),
    max: 1,
  });
  try {
    return (
      await pool.query("SELECT name FROM signups ORDER BY name")
    ).rows.map((r) => r.name);
  } finally {
    await pool.end();
  }
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
    "POSTGRES_USER=app_test_admin",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:18-alpine",
  ]);
  await driver.command(["start", pgName]);
  const pgPort = await fixturePort(pgName, 5432);
  const adminUrl = `postgres://app_test_admin:${password}@127.0.0.1:${pgPort}/postgres`;
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  await wait(() => admin.query("SELECT 1"));
  data = new ApplicationData(root, adminUrl);

  const configuration = {
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
              {
                handle: [
                  {
                    handler: "static_response",
                    status_code: 404,
                    body: "Application not found",
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const configPath = join(evidence, "caddy.json");
  await writeFile(configPath, JSON.stringify(configuration));
  const caddyImageId = await driver.imageId("caddy:2-alpine");
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
    caddyImageId,
    "caddy",
    "run",
    "--config",
    "/etc/caddy/app.json",
  ]);
  await driver.command(["start", edgeName]);
  const edgePort = await fixturePort(edgeName, 8080),
    adminPort = await fixturePort(edgeName, 2019);
  edge = new CaddyApplicationEdge(
    `http://127.0.0.1:${adminPort}`,
    `http://127.0.0.1:${edgePort}`,
    "host.docker.internal",
  );
  await wait(() => edge.actual());
  pass("isolated PostgreSQL and real Caddy ready");

  const appA = randomUUID(),
    appB = randomUUID();
  const sourceA = join(evidence, "workspace-a"),
    sourceB = join(evidence, "workspace-b");
  await cp("templates/application-v1", sourceA, { recursive: true });
  await cp("templates/application-v1", sourceB, { recursive: true });
  const manifest = parseManifest(
    JSON.parse(await readFile(join(sourceA, "harbor-app.json"), "utf8")),
  );
  const prod = await data.provision(appA, "production", manifest);
  dataEnvironments.push(prod);
  const preview = await data.provision(appA, "preview", manifest);
  dataEnvironments.push(preview);
  const other = await data.provision(appB, "production", manifest);
  dataEnvironments.push(other);
  pass("app and environment databases have separate DML identities");

  console.log("BUILD production A v1");
  const v1 = await build(sourceA, appA, "production");
  const first = await start(v1.artifact, prod);
  await edge.replace([first]);
  const productionCsp = (await fetch(edge.publicOrigin + first.build.basePath)).headers.get("content-security-policy");
  assert.match(productionCsp, /frame-ancestors 'self';/);
  assert.ok(!productionCsp.includes("studio.example.net"));
  pass("production does not inherit the workbench embedding origin");
  await driver.activate(first);
  console.log("PUBLIC_APPLICATION", edge.publicOrigin + first.build.basePath);
  await writeFile(
    join(evidence, "live.json"),
    JSON.stringify({
      origin: edge.publicOrigin,
      applicationUrl: edge.publicOrigin + first.build.basePath,
      appId: appA,
    }),
  );
  const html = await (
    await fetch(edge.publicOrigin + first.build.basePath)
  ).text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
    (m) => m[1],
  );
  assert(assets.length >= 2);
  for (const asset of assets) {
    assert(asset.startsWith(first.build.basePath));
    assert.equal((await fetch(edge.publicOrigin + asset)).status, 200);
  }
  assert.equal(
    (
      await fetch(
        edge.publicOrigin + first.build.basePath + "details/registration",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(
        edge.publicOrigin + first.build.basePath + "assets/missing.js",
      )
    ).status,
    404,
  );
  assert.equal(
    (await fetch(edge.publicOrigin + first.build.basePath + "api/missing"))
      .status,
    404,
  );
  await submit(first, "production-one");
  assert.deepEqual(await rows(prod), ["production-one"]);
  assert.equal(
    (
      await fetch(
        edge.publicOrigin + first.build.basePath + "api/tables/signups",
      )
    ).status,
    403,
  );
  pass(
    "real image runs frontend/backend; prefix assets, deep refresh, API and protected reads verified",
  );

  console.log("BUILD preview A v1");
  const pv = await build(sourceA, appA, "preview"),
    previewDeployment = await start(pv.artifact, preview);
  await edge.replace([first, previewDeployment]);
  const previewCsp = (await fetch(edge.publicOrigin + previewDeployment.build.basePath)).headers.get("content-security-policy");
  assert.match(previewCsp, /frame-ancestors 'self' https:\/\/studio\.example\.net;/);
  assert.ok(!previewCsp.includes("frame-ancestors *"));
  pass("public preview permits only itself and the configured workbench");
  // Old protected deployment configurations carry the parent under visitorAuth.
  const keyPair = generateKeyPairSync("ed25519");
  const legacy = await driver.create(pv.artifact, randomUUID(),
    data.connection(preview, false, "host.docker.internal"), undefined,
    { origin: "https://legacy.example.net", publicKey: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      providers: ["email_password"], previewParentOrigin: "https://studio.example.net" });
  deployments.push(legacy);
  await driver.start(legacy);
  await driver.healthy(legacy);
  const legacyUrl = `http://127.0.0.1:${legacy.hostPort}${legacy.build.basePath}`;
  assert.match((await fetch(legacyUrl)).headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/studio\.example\.net;/);
  assert.equal((await fetch(legacyUrl + "api/tables/signups")).status, 401);
  pass("legacy login preview still embeds while rejecting unauthenticated business API requests");
  await submit(previewDeployment, "test-only");
  assert.deepEqual(await rows(preview), ["test-only"]);
  assert.deepEqual(await rows(prod), ["production-one"]);
  assert.notEqual(pv.artifact.imageId, v1.artifact.imageId);
  pass(
    "preview has independent build/base and cannot write production records",
  );

  console.log("BUILD application B");
  await writeFile(
    join(sourceB, "server/index.ts"),
    'export function register(router:any){router.get("/api/about",(_q:any,r:any)=>r.json({title:"APPLICATION-B"}));}',
  );
  const b = await build(sourceB, appB, "production"),
    otherDeployment = await start(b.artifact, other);
  await edge.replace([first, previewDeployment, otherDeployment]);
  assert.equal(
    (
      await (
        await fetch(
          edge.publicOrigin + otherDeployment.build.basePath + "api/about",
        )
      ).json()
    ).title,
    "APPLICATION-B",
  );
  await submit(otherDeployment, "other-app");
  assert.deepEqual(await rows(other), ["other-app"]);
  assert.deepEqual(await rows(prod), ["production-one"]);
  const hostile = new URL(data.connection(prod));
  hostile.pathname = "/" + other.database;
  const hostilePool = new Pool({ connectionString: hostile.href, max: 1 });
  try {
    await assert.rejects(hostilePool.query("SELECT * FROM signups"));
  } finally {
    await hostilePool.end();
  }
  pass("two app routes remain distinct; cross-app database credentials denied");

  console.log("BUILD production A v2");
  await writeFile(
    join(sourceA, "server/index.ts"),
    'export function register(router:any){router.get("/api/about",(_q:any,r:any)=>r.json({title:"APPLICATION-A-V2"}));}',
  );
  const extended = structuredClone(manifest);
  extended.tables.signups.fields.phone = { type: "text", maxLength: 40 };
  await writeFile(join(sourceA, "harbor-app.json"), JSON.stringify(extended));
  const updatedData = await data.provision(appA, "production", extended);
  // 模拟DDL已提交、磁盘schema尚未保存时崩溃；库内事实必须阻止历史hash绕过破坏性检查。
  const metadataPath = join(
    root,
    "data",
    appA,
    "production",
    "environment.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata, schema: manifest }),
  );
  assert(
    (await data.open(appA, "production")).schema.tables.signups.fields.phone,
  );
  await assert.rejects(
    data.provision(appA, "production", manifest),
    /DESTRUCTIVE_SCHEMA_CHANGE/,
  );
  await writeFile(metadataPath, JSON.stringify(metadata));
  pass(
    "database migration truth survives stale disk metadata and rejects historical-hash schema downgrade",
  );
  const v2 = await build(sourceA, appA, "production"),
    second = await start(v2.artifact, updatedData);
  await edge.replace([second, previewDeployment, otherDeployment]);
  await driver.activate(second);
  await driver.destroy(first.container);
  assert.equal(
    (
      await (
        await fetch(edge.publicOrigin + second.build.basePath + "api/about")
      ).json()
    ).title,
    "APPLICATION-A-V2",
  );
  assert.deepEqual(await rows(prod), ["production-one"]);
  await submit(second, "production-two");
  const stale = await fetch(
    edge.publicOrigin + second.build.basePath + "api/tables/signups",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Revision": first.build.revisionId,
      },
      body: JSON.stringify({ name: "stale" }),
    },
  );
  assert.equal(stale.status, 409);
  pass(
    "new image switches fixed route; nullable migration preserves data; stale frontend writes rejected",
  );

  const rollback = await start(v1.artifact, updatedData);
  await edge.replace([rollback, previewDeployment, otherDeployment]);
  await driver.activate(rollback);
  await driver.destroy(second.container);
  assert.deepEqual(await rows(prod), ["production-one", "production-two"]);
  // Caddy reload may retire the previous keep-alive socket. Retry this read-only probe.
  const restored = await wait(async () => {
    const response = await fetch(edge.publicOrigin + rollback.build.basePath + "api/about");
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(restored.title, "活动报名");
  pass(
    "rollback runs exact retained image while keeping current production data",
  );

  const state = await driver.inspect(rollback.container);
  assert.equal(state.Config.User, "1000:1000");
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.equal(state.HostConfig.RestartPolicy.Name, "unless-stopped");
  assert(!state.Config.Labels["harbor.owner"]);
  assert(!state.Config.Labels["harbor.session"]);
  assert(
    !state.Mounts.some((m) =>
      /docker.sock|claude-state|workspace/.test(m.Source),
    ),
  );
  await edge.replace([rollback, otherDeployment]);
  await driver.destroy(previewDeployment.container);
  assert.equal(
    (
      await fetch(
        edge.publicOrigin + rollback.build.basePath + "__harbor/health",
      )
    ).status,
    200,
  );
  const adopted = new AppDockerDriver(root);
  assert.equal(
    (await adopted.inspect(rollback.container)).Image,
    v1.artifact.imageId,
  );
  await assert.rejects(
    new AppDockerDriver(root + "-foreign").inspect(rollback.container),
    /OWNERSHIP/,
  );
  pass(
    "runtime survives preview removal, is adoptable by same owner and rejects foreign ownership",
  );

  await assert.rejects(
    edge.replace([{ ...rollback, hostPort: 70000 }]),
    /INVALID_EDGE_DEPLOYMENT/,
  );
  assert.equal(
    (
      await fetch(
        edge.publicOrigin + rollback.build.basePath + "__harbor/health",
      )
    ).status,
    200,
  );
  await assert.rejects(
    data.provision(appA, "production", manifest),
    /DESTRUCTIVE_SCHEMA_CHANGE/,
  );
  pass(
    "invalid update and destructive migration leave current service and data intact",
  );

  if (process.env.AH_APP_FULL_REGRESSION === "1") {
    console.log("RUN full existing regression on isolated PostgreSQL");
    regression = await new Promise((resolveRun) => {
      const child = spawn("npm", ["test"], {
        env: { ...process.env, AH_TEST_DATABASE_URL: adminUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      child.stdout.on("data", (value) => chunks.push(value));
      child.stderr.on("data", (value) => chunks.push(value));
      child.on("error", (error) => {
        chunks.push(Buffer.from(String(error)));
        resolveRun({ exitCode: -1, output: Buffer.concat(chunks).toString() });
      });
      child.on("exit", (code) =>
        resolveRun({
          exitCode: code,
          output: Buffer.concat(chunks).toString(),
        }),
      );
    });
    await writeFile(join(evidence, "regression.log"), regression.output);
    assert.equal(regression.exitCode, 0, regression.output.slice(-4000));
    pass("full existing regression passed on isolated PostgreSQL");
  }
  summary.passed = true;
  summary.artifacts = {
    v1: v1.artifact,
    v2: v2.artifact,
    preview: pv.artifact,
    other: b.artifact,
    caddyImageId,
  };
} catch (error) {
  summary.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const name of [edgeName, pgName])
    try {
      await writeFile(
        join(evidence, name + ".log"),
        await driver.command(["logs", name]),
      );
    } catch {
      /* 辅助日志不改变清理事实。 */
    }
  for (const deployment of [...deployments].reverse())
    try {
      await driver.destroy(deployment.container);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  for (const environment of dataEnvironments)
    try {
      await data.destroy(environment);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  await data?.close();
  await admin?.end();
  await dispatcher.close();
  for (const name of [edgeName, pgName])
    try {
      await driver.destroy(name);
    } catch (e) {
      cleanupErrors.push(String(e));
    }
  summary.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) {
    summary.passed = false;
    process.exitCode = 1;
  }
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(
    "var/evidence/app-builder-implementation/2026-10-26/latest.json",
    JSON.stringify({ evidence }),
  );
  console.log("EVIDENCE", evidence, "PASSED", summary.passed);
}
