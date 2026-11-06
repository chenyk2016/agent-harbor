/** Disposable deletion acceptance: actual HTTP, PG databases/roles, Docker resources and scoped Caddy routes. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
const evidence = resolve(
    process.env.AH_DELETE_EVIDENCE ?? "var/evidence/direct-deletion/2026-11-05",
  ),
  suffix = randomUUID().slice(0, 8),
  root = join(evidence, "fixture-" + suffix),
  pgName = "ah-delete-pg-" + suffix;
await mkdir(root, { recursive: true, mode: 0o700 });
const owned = new Set(),
  images = new Set(),
  checks = [];
let db, manager, server, apps, data, stopKeepOpen;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  }).trim();
const port = (name, p) =>
  Number(
    JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports[p + "/tcp"][0]
      .HostPort,
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  let error;
  for (let i = 0; i < 200; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await pause(100);
    }
  }
  throw error;
}
async function run(command, args, env, file) {
  const out = createWriteStream(join(evidence, file));
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  await new Promise((r) => out.end(r));
  assert.equal(code, 0, file + " failed");
}
const pass = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
const report = { passed: false, realModelRequests: 0, checks };
try {
  const password = randomBytes(18).toString("hex");
  owned.add(pgName);
  docker(
    "run",
    "-d",
    "--name",
    pgName,
    "--label",
    "harbor.verification=direct-deletion",
    "-e",
    "POSTGRES_PASSWORD=" + password,
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=512m",
    "postgres:18-alpine",
  );
  const url = `postgres://postgres:${password}@127.0.0.1:${port(pgName, 5432)}/postgres`;
  const { Pool } = await import("pg"),
    probe = new Pool({ connectionString: url });
  await until(() => probe.query("select 1"));
  await probe.end();
  await run("npm", ["run", "build"], process.env, "build.log");
  const testFiles =
    process.env.AH_DELETE_FULL_TESTS === "1"
      ? (await readdir("dist/tests"))
          .filter((name) => name.endsWith(".test.js"))
          .sort()
          .map((name) => "dist/tests/" + name)
      : [
          "dist/tests/deletions.test.js",
          "dist/tests/applications-service.test.js",
        ];
  await run(
    "node",
    ["--test", "--test-concurrency=1", ...testFiles],
    { ...process.env, AH_TEST_DATABASE_URL: url },
    "targeted-tests.log",
  );
  pass("deletion and application control-plane tests");
  if (process.env.AH_DELETE_TARGETED_ONLY === "1") {
    report.passed = true;
  } else {
    const { openDatabase } = await import("../dist/src/service/db/client.js"),
      { applyMigrations } = await import("../dist/src/service/db/migrate.js"),
      { Controller } = await import("../dist/src/runtime/controller.js"),
      { ServiceStore } = await import("../dist/src/service/service-store.js"),
      { SessionManager } =
        await import("../dist/src/service/session-manager.js"),
      { ApplicationService } =
        await import("../dist/src/service/applications/service.js"),
      { ApplicationStore } =
        await import("../dist/src/service/applications/store.js"),
      { CaddyApplicationEdge } =
        await import("../dist/src/service/applications/edge.js"),
      { createApi } = await import("../dist/src/service/http-api.js"),
      { ServiceClient } = await import("../dist/src/clients/service-client.js"),
      { tokenHash } = await import("../dist/src/service/auth.js"),
      { parseManifest } =
        await import("../dist/src/service/applications/manifest.js");
    db = openDatabase(url);
    await applyMigrations(db.pool);
    const controller = new Controller(root),
      store = new ApplicationStore(db.db);
    manager = new SessionManager(
      new ServiceStore(db.db),
      {
        open: async () => {
          throw Error("No model execution in deletion verification");
        },
      },
      "not-executing",
    );
    const key = "deletion-fixture-" + randomBytes(18).toString("hex");
    await manager.identity.importKeys([
      { userId: "fixture", tokenHash: tokenHash(key) },
      { userId: "other", tokenHash: tokenHash("other-fixture") },
    ]);
    const caddyName = "ah-delete-edge-" + suffix,
      caddyPath = join(root, "caddy.json");
    await writeFile(
      caddyPath,
      JSON.stringify({
        admin: { listen: ":2019" },
        apps: {
          http: {
            servers: {
              app: {
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
                    handle: [{ handler: "static_response", status_code: 404 }],
                  },
                ],
              },
            },
          },
        },
      }),
    );
    owned.add(caddyName);
    docker(
      "run",
      "-d",
      "--name",
      caddyName,
      "-p",
      "127.0.0.1::8080",
      "-p",
      "127.0.0.1::2019",
      "--mount",
      `type=bind,src=${caddyPath},dst=/etc/caddy/app.json,readonly`,
      "caddy:2-alpine",
      "caddy",
      "run",
      "--config",
      "/etc/caddy/app.json",
    );
    const edge = new CaddyApplicationEdge(
      `http://127.0.0.1:${port(caddyName, 2019)}`,
      `http://127.0.0.1:${port(caddyName, 8080)}`,
      "host.docker.internal",
    );
    await until(() => edge.actual());
    apps = new ApplicationService(store, manager, controller, {
      root: join(root, ".apps"),
      nodeBase: "agent-harbor:delivery-v29",
      dataAdminUrl: url,
      creators: new Set(["fixture"]), templateDirectory: "templates/application-v1",
      edge,
    });
    data = apps.data;
    const manifest = parseManifest(
        JSON.parse(
          await readFile("templates/application-v1/harbor-app.json", "utf8"),
        ),
      ),
      records = [];
    async function session(title) {
      const s = await manager.create("fixture", title);
      await controller.store.prepare(s.id);
      await writeFile(
        join(root, s.id, "workspace", "canary.txt"),
        "private content",
      );
      return s;
    }
    async function application(title) {
      const appId = randomUUID(),
        sid = (await session(title + " development")).id,
        rev = randomUUID(),
        buildId = randomUUID(),
        now = Date.now();
      await db.pool.query(
        'INSERT INTO applications(id,"ownerId",title,status,"developmentSessionId","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$6)',
        [appId, "fixture", title, "active", sid, now],
      );
      await db.pool.query(
        'INSERT INTO app_revisions(id,"appId",number,source,manifest,summary,"createdAt") VALUES($1,$2,1,$3,$4,$5,$6)',
        [rev, appId, {}, manifest, "fixture", now],
      );
      const envs = [];
      for (const env of ["preview", "production"]) {
        const d = await data.provision(appId, env, manifest);
        envs.push(d);
        await db.pool.query(
          'INSERT INTO app_data_environments("appId",environment,"databaseName",role,schema,"updatedAt") VALUES($1,$2,$3,$4,$5,$6)',
          [appId, env, d.database, d.role, manifest, now],
        );
      }
      const dir = join(root, "image-" + appId);
      await mkdir(dir);
      await writeFile(
        join(dir, "server.cjs"),
        `const c=JSON.parse(require('fs').readFileSync('/run/harbor-app.json'));require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({appId:c.appId,buildId:c.buildId,deploymentId:c.deploymentId}));}).listen(3000,'0.0.0.0');`,
      );
      await writeFile(
        join(dir, "Dockerfile"),
        'FROM agent-harbor:delivery-v29\nCOPY server.cjs /server.cjs\nENTRYPOINT ["node","/server.cjs"]\n',
      );
      const tag = "agent-harbor-app:" + buildId;
      docker(
        "build",
        "--pull=false",
        "--label",
        `harbor.app.store=${apps.driver.owner}`,
        "--label",
        `harbor.app.id=${appId}`,
        "--label",
        `harbor.app.build=${buildId}`,
        "-t",
        tag,
        dir,
      );
      images.add(tag);
      const build = {
        id: buildId,
        appId,
        revisionId: rev,
        target: "preview",
        basePath: `/preview/${appId}/`,
        imageId: await apps.driver.imageId(tag),
      };
      await db.pool.query(
        'INSERT INTO app_builds(id,"appId","revisionId",target,status,artifact,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
        [buildId, appId, rev, "preview", "succeeded", build, now],
      );
      const d = await apps.driver.create(
        build,
        randomUUID(),
        data.connection(envs[0], false, "host.docker.internal"),
      );
      owned.add(d.container);
      await apps.driver.start(d);
      await apps.driver.healthy(d);
      await store.registerDeployment(appId, buildId, "preview", d.id, 1);
      await store.deploymentState(d.id, "healthy", d);
      for (const env of ["preview", "production"])
        await db.pool.query(
          'INSERT INTO app_endpoints("appId",environment,generation,"desiredDeploymentId","appliedDeploymentId",state) VALUES($1,$2,1,$3,$3,$4)',
          [
            appId,
            env,
            env === "preview" ? d.id : null,
            env === "preview" ? "ready" : "offline",
          ],
        );
      await mkdir(apps.sources.directory(appId), { recursive: true });
      await writeFile(
        join(apps.sources.directory(appId), "source-canary.txt"),
        "source",
      );
      await mkdir(join(apps.options.root, "builds", buildId), {
        recursive: true,
      });
      await writeFile(
        join(apps.options.root, "builds", buildId, "private.txt"),
        "build",
      );
      const record = { appId, sid, envs, build, d, title, tag };
      records.push(record);
      return record;
    }
    const plain = await session("Ordinary conversation deletion acceptance"),
      a = await application("Delete application acceptance"),
      b = await application("Keep application acceptance");
    await apps.initialize();
    server = createApi(
      manager,
      controller,
      undefined,
      {},
      undefined,
      undefined,
      apps,
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`,
      client = new ServiceClient(origin, key),
      other = new ServiceClient(origin, "other-fixture");
    const runner = "ah-delete-runner-" + suffix;
    owned.add(runner);
    docker(
      "run",
      "-d",
      "--name",
      runner,
      "--label",
      "io.agent-harbor.project=agent-harbor",
      "--label",
      `harbor.owner=${manager.deletions.backend.owner}`,
      "--label",
      `harbor.session=${plain.id}`,
      "--entrypoint",
      "node",
      "agent-harbor:delivery-v29",
      "-e",
      "setInterval(()=>{},1000)",
    );
    const visible = async (r) => {
      const response = await fetch(
        edge.publicOrigin + r.build.basePath + "__harbor/health",
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).deploymentId, r.d.id);
    };
    await visible(a);
    await visible(b);
    pass(
      "real app routes, dedicated data environments and orphan session container ready",
    );
    await writeFile(join(evidence, "browser-key.txt"), key, { mode: 0o600 });
    await writeFile(
      join(evidence, "browser-fixture.json"),
      JSON.stringify(
        {
          origin,
          plainId: plain.id,
          appId: a.appId,
          appTitle: a.title,
          peerId: b.appId,
          keyFile: join(evidence, "browser-key.txt"),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (process.env.AH_DELETE_KEEP_OPEN === "1") {
      console.log("BROWSER_FIXTURE_READY " + origin);
      for (let i = 0; i < 1800; i++) {
        try {
          await lstat(join(evidence, "continue-verification"));
          break;
        } catch {}
        await pause(500);
      }
    }
    const done = async (job) => {
      let j;
      for (let i = 0; i < 300; i++) {
        j = await client.request("/deletions/" + job.id);
        if (j.state !== "running") return j;
        await pause(100);
      }
      throw Error("Deletion timeout");
    };
    await assert.rejects(
      other.request("/sessions/" + plain.id, "DELETE"),
      (e) => e.status === 404,
    );
    await assert.rejects(
      client.request("/sessions/" + a.sid, "DELETE"),
      (e) => e.code === "DELETE_APPLICATION_INSTEAD",
    );
    const originalDrop = data.destroyOwned.bind(data);
    let fail = true;
    data.destroyOwned = async (...args) => {
      if (fail) throw Error("injected data failure");
      return originalDrop(...args);
    };
    const aj = await client.request("/applications/" + a.appId, "DELETE", {
      confirmName: a.title,
    });
    assert.equal((await done(aj)).state, "failed");
    await visible(b);
    pass("app deletion failure retained checkpoint; peer remains available");
    const sj = await client.request("/sessions/" + plain.id, "DELETE");
    assert.equal((await done(sj)).state, "completed");
    await assert.rejects(lstat(join(root, plain.id)), { code: "ENOENT" });
    assert.equal(
      docker(
        "ps",
        "-a",
        "--filter",
        "name=^/" + runner + "$",
        "--format",
        "{{.Names}}",
      ),
      "",
    );
    pass(
      "ordinary conversation and actual owned orphan container removed while app cleanup is failing",
    );
    fail = false;
    const retry = await client.request("/applications/" + a.appId, "DELETE", {
      confirmName: a.title,
    });
    assert.equal(retry.id, aj.id);
    assert.equal((await done(retry)).state, "completed");
    assert.equal(await store.byId(a.appId), undefined);
    assert.equal(await manager.store.session(a.sid), undefined);
    for (const p of [
      join(root, a.sid),
      apps.sources.directory(a.appId),
      join(apps.options.root, "builds", a.build.id),
      join(apps.options.root, "deployments", a.d.id),
      join(apps.options.root, "data", a.appId),
    ])
      await assert.rejects(lstat(p), { code: "ENOENT" });
    for (const env of a.envs) {
      assert.equal(
        (
          await db.pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            env.database,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
            env.role,
          ])
        ).rowCount,
        0,
      );
    }
    assert.equal(docker("image", "ls", "-q", a.tag), "");
    assert.equal(
      (await fetch(edge.publicOrigin + a.build.basePath)).status,
      404,
    );
    pass(
      "retry removed application records, development session, files, owned image, both business databases and roles",
    );
    await visible(b);
    for (const env of b.envs)
      assert.equal(
        (
          await db.pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            env.database,
          ])
        ).rowCount,
        1,
      );
    assert(await lstat(apps.sources.directory(b.appId)));
    pass("peer application data, files, image and route preserved");
    assert.equal(
      (
        await client.request("/applications/" + a.appId, "DELETE", {
          confirmName: a.title,
        })
      ).state,
      "completed",
    );
    await assert.rejects(
      client.request("/sessions/" + a.sid + "/files"),
      (e) => e.status === 404,
    );
    pass("repeated deletion is idempotent and deleted content cannot be read");
    report.passed = true;
  }
} catch (e) {
  report.error = e?.message ?? "VERIFICATION_FAILED";
  console.log("FAIL " + report.error);
  process.exitCode = 1;
} finally {
  await manager?.shutdown().catch(() => {
    report.cleanupFailed = true;
  });
  await apps?.close().catch(() => {
    report.cleanupFailed = true;
  });
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await db?.close();
  for (const name of owned) {
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  for (const tag of images) {
    try {
      docker("image", "rm", tag);
    } catch {}
  }
  try {
    report.cleanupConfirmed =
      [...owned].every(
        (name) =>
          docker(
            "ps",
            "-a",
            "--filter",
            `name=^/${name}$`,
            "--format",
            "{{.Names}}",
          ) === "",
      ) && [...images].every((tag) => docker("image", "ls", "-q", tag) === "");
  } catch {
    report.cleanupConfirmed = false;
  }
  if (!report.cleanupConfirmed) {
    report.passed = false;
    process.exitCode = 1;
  }
  await rm(join(evidence, "browser-key.txt"), { force: true });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
