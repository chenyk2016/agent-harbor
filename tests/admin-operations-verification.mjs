/** 独立可丢弃PG + HTTP/浏览器夹具；不连接生产库或付费模型。 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
const root = resolve(
  process.env.AH_ADMIN_EVIDENCE_DIR ??
    "var/evidence/admin-operations/2026-11-04",
);
await mkdir(root, { recursive: true, mode: 0o700 });
const name = "ah-admin-ops-" + Date.now(),
  password = randomBytes(18).toString("hex");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let database,
  manager,
  server,
  remote,
  created = false;
async function run(cmd, args, env, file) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(root + "/" + file);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
  const code = await new Promise((r) => child.once("exit", r));
  clearTimeout(timer);
  await new Promise((r) => log.end(r));
  if (code !== 0) throw Error(file + " failed (see log)");
}
try {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "harbor.verification=admin-operations",
    "-e",
    "POSTGRES_PASSWORD=" + password,
    "-e",
    "POSTGRES_USER=ops_fixture",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=512m",
    "postgres:18-alpine",
  );
  created = true;
  const port = docker("port", name, "5432/tcp").split(":").at(-1),
    url =
      "postgres://ops_fixture:" + password + "@127.0.0.1:" + port + "/postgres";
  const { Pool } = await import("pg");
  for (let i = 0; ; i++) {
    const p = new Pool({
      connectionString: url,
      connectionTimeoutMillis: 1000,
    });
    try {
      await p.query("select 1");
      await p.end();
      break;
    } catch {
      await p.end();
      if (i > 80) throw Error("Disposable database unavailable");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const env = { ...process.env, AH_TEST_DATABASE_URL: url };
  if (!process.env.AH_ADMIN_SKIP_TESTS) {
    await run("npm", ["run", "build"], env, "build.log");
    await run(
      "node",
      [
        "--test",
        "--test-concurrency=1",
        "--test-timeout=60000",
        "dist/tests/admin-operations.test.js",
      ],
      env,
      "targeted-tests.log",
    );
    console.log("Admin operations targeted tests passed");
    if (!process.env.AH_ADMIN_TARGETED_ONLY) {
      await run("npm", ["test"], env, "tests.log");
      console.log("Full regression passed");
    }
  }
  if (process.env.AH_ADMIN_TESTS_ONLY) process.exitCode = 0;
  else {
    process.env.AH_TEST_DATABASE_URL = url;
    const { testDatabase } = await import("../dist/tests/pg.js");
    const { Controller } = await import("../dist/src/runtime/controller.js");
    const { ServiceStore } =
      await import("../dist/src/service/service-store.js");
    const { SessionManager } =
      await import("../dist/src/service/session-manager.js");
    const { createApi } = await import("../dist/src/service/http-api.js");
    const { tokenHash } = await import("../dist/src/service/auth.js");
    const { LlmService } = await import("../dist/src/service/llm/service.js");
    const { WalletService } =
      await import("../dist/src/service/wallet/service.js");
    database = await testDatabase();
    const store = new ServiceStore(database.db),
      controller = new Controller(root + "/runtime");
    manager = new SessionManager(
      store,
      {
        open: async () => {
          throw Error("No paid execution");
        },
      },
      "fixture-only",
    );
    await manager.identity.importKeys(
      ["admin", "reader"].map((userId) => ({
        userId,
        tokenHash: tokenHash("admin-ops-" + userId),
      })),
    );
    remote = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"healthy":true}');
    });
    await new Promise((r) => remote.listen(0, "127.0.0.1", r));
    const remoteUrl = "http://127.0.0.1:" + remote.address().port;
    const llm = new LlmService(database.db, root + "/runtime/.service", {
      managementUrl: remoteUrl,
      inferenceUrl: remoteUrl,
      masterKey: "fixture-only",
    });
    const now = Date.now();
    await database.pool.query(
      'INSERT INTO llm_providers(id,name,format,"apiBase","createdAt") VALUES ($1,$2,$3,$4,$5)',
      ["fixture-provider", "本地验收供应商", "anthropic", remoteUrl, now],
    );
    const seed = await database.pool.connect();
    try {
      await seed.query("BEGIN");
      await seed.query(
        'INSERT INTO llm_model_versions(id,"deploymentId","providerId","upstreamModel","routeName",params,tools,streaming,capabilities,digest,state,"createdBy","createdAt") VALUES ($1,$2,$3,$4,$5,$6,true,true,$6,$7,$8,$9,$10)',
        [
          "fixture-version",
          "fixture-deployment",
          "fixture-provider",
          "fixture",
          "fixture-route",
          "{}",
          "fixture",
          "ready",
          "admin",
          now,
        ],
      );
      await seed.query(
        'INSERT INTO llm_deployments(id,name,description,"currentVersionId",enabled,"allowedUsers","createdAt","updatedAt") VALUES ($1,$2,$3,$4,true,$5,$6,$6)',
        [
          "fixture-deployment",
          "普通对话验收模型",
          "隔离夹具，不调用模型",
          "fixture-version",
          "[]",
          now,
        ],
      );
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK");
      throw error;
    } finally {
      seed.release();
    }
    await llm.createPrice(
      "fixture-deployment",
      { input: "1", output: "2", cacheRead: "1", cacheWrite: "1" },
      "admin",
    );
    const session = await store.create("reader", "本地验收会话");
    await mkdir(root + "/runtime/" + session.id + "/workspace", {
      recursive: true,
    });
    await writeFile(
      root + "/runtime/" + session.id + "/workspace/sample.txt",
      "fixture",
    );
    const wallet = new WalletService(database.db),
      pending = await wallet.reserve(
        "reader",
        session.id,
        {
          deploymentId: "fixture-deployment",
          versionId: "fixture-version",
          priceVersionId: "fixture-price",
          name: "普通对话验收模型",
          price: {
            input: 1000000,
            output: 2000000,
            cacheRead: 1000000,
            cacheWrite: 1000000,
          },
        },
        10000,
      );
    await wallet.unknown(pending.id);
    await database.pool.query(
      'UPDATE wallet_requests SET "createdAt"=$1 WHERE id=$2',
      [now - 2 * 86400000, pending.id],
    );
    await database.pool.query(
      'INSERT INTO llm_config_audit(id,actor,action,target,before,after,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        "admin",
        "fixture.change",
        "fixture-deployment",
        JSON.stringify({ enabled: false }),
        JSON.stringify({ enabled: true }),
        now,
      ],
    );
    server = createApi(
      manager,
      controller,
      undefined,
      { adminUsers: ["admin"] },
      undefined,
      undefined,
      undefined,
      llm,
    );
    await new Promise((r) => server.listen(8439, "127.0.0.1", r));
    console.log(
      "Browser fixture ready: http://127.0.0.1:8439 (isolated test key admin-ops-admin)",
    );
    await writeFile(
      root + "/fixture-result.json",
      JSON.stringify(
        {
          isolated: true,
          realModelRequests: 0,
          port: 8439,
          pendingId: pending.id,
          sessionId: session.id,
        },
        null,
        2,
      ),
    );
    if (process.env.AH_ADMIN_KEEP_OPEN)
      await new Promise((r) => {
        process.once("SIGINT", r);
        process.once("SIGTERM", r);
      });
  }
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (remote) {
    remote.closeAllConnections();
    await new Promise((r) => remote.close(r));
  }
  if (manager) await manager.shutdown();
  if (database) await database.close();
  if (created) docker("rm", "-f", name);
}
