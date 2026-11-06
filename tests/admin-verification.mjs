/** Isolated browser fixture and full regression. No production DB, provider or Docker runtime calls. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
const root = resolve(
  process.env.AH_ADMIN_EVIDENCE_DIR ?? "var/admin-verification",
);
await mkdir(root, { recursive: true, mode: 0o700 });
const name = `ah-admin-verify-${Date.now()}`,
  password = randomBytes(18).toString("hex");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let database, manager, server, remote;
async function close() {
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
  try {
    docker("rm", "-f", name);
  } catch {}
}
try {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "harbor.verification=admin",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_USER=admin_fixture",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=512m",
    "postgres:18-alpine",
  );
  const port = docker("port", name, "5432/tcp").split(":").at(-1);
  const url = `postgres://admin_fixture:${password}@127.0.0.1:${port}/postgres`;
  const { Pool } = await import("pg");
  for (let i = 0; ; i++) {
    const pool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: 1000,
    });
    try {
      await pool.query("select 1");
      await pool.end();
      break;
    } catch (e) {
      await pool.end();
      if (i > 80) throw Error("Fixture database unavailable");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!process.env.AH_ADMIN_SKIP_TESTS) {
    const log = [];
    const child = spawn("npm", ["test"], {
      env: { ...process.env, AH_TEST_DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => log.push(b));
    child.stderr.on("data", (b) => log.push(b));
    const exit = await new Promise((r) => child.on("exit", r));
    await writeFile(root + "/tests.log", Buffer.concat(log));
    if (exit) throw Error("Regression failed; see tests.log");
    console.log("Full regression passed");
  }
  process.env.AH_TEST_DATABASE_URL = url;
  const { testDatabase } = await import("../dist/tests/pg.js");
  const { Controller } = await import("../dist/src/runtime/controller.js");
  const { ServiceStore } = await import("../dist/src/service/service-store.js");
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
        throw Error("No model execution authorized in admin fixture");
      },
    },
    "fixture-only",
  );
  await manager.identity.importKeys(
    ["admin", "reader", "sample"].map((userId) => ({
      userId,
      tokenHash: tokenHash("admin-fixture-" + userId),
    })),
  );
  const deployments = [];
  remote = createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/model/info")
      res.end(JSON.stringify({ data: deployments }));
    else if (req.url === "/model/new") {
      deployments.push(JSON.parse(raw));
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise((r) => remote.listen(0, "127.0.0.1", r));
  const remoteUrl = `http://127.0.0.1:${remote.address().port}`;
  const llm = new LlmService(database.db, root + "/runtime", {
    managementUrl: remoteUrl,
    inferenceUrl: remoteUrl,
    masterKey: "fixture-only",
  });
  const provider = await llm.addProvider({
    name: "本地验收供应商",
    apiBase: remoteUrl,
    apiKey: "fixture-only",
    format: "anthropic_compatible",
  }, "reader");
  await llm.createDeployment({
    providerId: provider.id,
    name: "验收模型",
    upstreamModel: "fixture",
    description: "本地配置验收，不调用模型",
    tools: true,
    streaming: true,
    allowedUsers: [],
  }, "reader");
  const wallet = new WalletService(database.db);
  const pending = await wallet.reserve("reader", "fixture-session", {
    id: "fixture",
    name: "中断验收请求",
    price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  });
  await wallet.unknown(pending.id);
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
    "Browser fixture ready: http://127.0.0.1:8439; test keys admin-fixture-admin / admin-fixture-reader",
  );
  await writeFile(
    root + "/fixture-result.json",
    JSON.stringify(
      {
        isolated: true,
        port: 8439,
        realModelRequests: 0,
        pendingId: pending.id,
      },
      null,
      2,
    ),
  );
  if (process.env.AH_ADMIN_KEEP_OPEN)
    await new Promise((r) => {
      process.once("SIGTERM", r);
      process.once("SIGINT", r);
    });
} finally {
  await close();
}
