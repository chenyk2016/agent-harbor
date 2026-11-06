/** 可丢弃两个Compose实例：安装→初始化→HTTP→备份→空库恢复→通知；不接生产库/模型。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import {
  configure,
  install,
  initialize,
  compose,
  serviceUnit,
} from "../dist/src/clients/ops/install.js";
import {
  config,
  environment,
  privateJson,
  request,
} from "../dist/src/clients/ops/common.js";
import { doctor } from "../dist/src/clients/ops/doctor.js";
import { backup, restore } from "../dist/src/clients/ops/backup.js";
import { monitor } from "../dist/src/clients/ops/monitor.js";
import { acceptance } from "../dist/src/clients/ops/acceptance.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
const evidence = resolve(
  process.env.AH_DELIVERY_EVIDENCE ??
    "var/evidence/reliable-delivery/2026-11-04",
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(evidence, "integration-")),
  image = process.env.AH_DELIVERY_TEST_IMAGE ?? "agent-harbor:delivery-v29";
const instances = [],
  children = [],
  results = [],
  alerts = [];
const model = fixtureModel([], (body, results) => {
  if (results.length || !JSON.stringify(body.messages).includes("浏览器验收"))
    return;
  return {
    name: "Bash",
    input: {
      command: `python3 -c 'import csv,glob; from decimal import Decimal; from collections import defaultdict; s=defaultdict(Decimal); rows=list(csv.DictReader(open(glob.glob("/workspace/uploads/*/*.csv")[0]))); [(s.__setitem__(r["department"],s[r["department"]]+Decimal(r["amount"]))) for r in rows]; f=open("/workspace/summary.csv","w"); f.write("department,total\\n"); [f.write(k+","+format(v,".2f")+"\\n") for k,v in sorted(s.items())]'`,
    },
  };
});
await new Promise((r) => model.server.listen(0, "0.0.0.0", r));
const receiver = httpServer(async (req, res) => {
  let b = "";
  for await (const v of req) b += v;
  alerts.push(JSON.parse(b));
  res.end("ok");
});
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
let passed = false;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function free() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function fresh(name) {
  const service = await free(),
    control = await free(),
    gateway = await free(),
    gatewayDb = await free();
  await configure(join(root, name), image, {
    service,
    control,
    gateway,
    gatewayDb,
  });
  const c = await config(join(root, name));
  instances.push(c);
  return c;
}
async function boot(c) {
  let log = "";
  const child = spawn(process.execPath, ["dist/src/service/server.js"], {
    env: environment(c),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  const end = Date.now() + 45000;
  while (
    !log.includes("(ready)") &&
    Date.now() < end &&
    child.exitCode === null
  )
    await pause(100);
  await writeFile(join(c.dir, "service-private.log"), log, { mode: 0o600 });
  assert.ok(log.includes("(ready)"), log);
  return child;
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
  }
}
async function stage(name, action) {
  const detail = await action();
  results.push({ name, passed: true, detail });
  console.log("PASS", name);
}
try {
  const source = await fresh("source");
  await stage("managed-dependencies-and-migrations", async () =>
    install(source),
  );
  const modelFile = join(root, "model-private.json");
  await privateJson(modelFile, {
    provider: {
      name: "Isolated fixture provider",
      format: "anthropic",
      apiBase: `http://host.docker.internal:${model.server.address().port}`,
      apiKey: "fixture-only",
    },
    deployment: {
      name: "Fixture team model",
      upstreamModel: "fixture",
      tools: true,
      streaming: true,
      allowedUsers: [],
      params: {},
      capabilities: {},
    },
    cost: {
      inputUsdPerMillion: "1",
      outputUsdPerMillion: "2",
      cacheReadUsdPerMillion: "1",
      cacheWriteUsdPerMillion: "1",
      timeoutSeconds: 180,
    },
    price: { input: "1", output: "2", cacheRead: "1", cacheWrite: "1" },
  });
  await stage("bootstrap-and-repeat-without-rotation", async () => {
    const first = await initialize(source, "operator", modelFile);
    const hash = await readFile(join(source.dir, "first-admin.key"));
    const state = JSON.parse(
      await readFile(join(source.dir, "bootstrap.json"), "utf8"),
    );
    await privateJson(join(source.dir, "bootstrap.json"), {
      ...state,
      phase: "provider-created",
    });
    await initialize(await config(source.dir), "operator", modelFile);
    const second = await initialize(
      await config(source.dir),
      "operator",
      modelFile,
    );
    const probe = new Pool({ connectionString: source.env.AH_DATABASE_URL });
    try {
      assert.equal(
        Number(
          (await probe.query("SELECT count(*) n FROM llm_providers")).rows[0].n,
        ),
        1,
      );
      assert.equal(
        Number(
          (await probe.query("SELECT count(*) n FROM llm_deployments")).rows[0]
            .n,
        ),
        1,
      );
    } finally {
      await probe.end();
    }
    assert.equal(second.reused, true);
    assert.deepEqual(await readFile(join(source.dir, "first-admin.key")), hash);
    return { modelConfigured: first.modelConfigured, reused: second.reused };
  });
  const active = await config(source.dir);
  let child = await boot(active),
    base = active.env.AH_SERVICE_URL;
  const key = (
    await readFile(join(active.dir, "first-admin.key"), "utf8")
  ).trim();
  const api = async (path, method = "GET", body, which = base) => {
    const r = await request(which + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type":
          typeof body === "string"
            ? "application/octet-stream"
            : "application/json",
        ...(typeof body === "string"
          ? {
              "X-Content-Sha256": createHash("sha256")
                .update(body)
                .digest("hex"),
            }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    assert.ok(r.ok, `HTTP ${r.status}: ${path}`);
    return r;
  };
  await api("/admin/wallet/gifts", "POST", {
    id: randomUUID(),
    amountYuan: "10",
    note: "Isolated internal test allowance",
    userIds: ["operator"],
  });
  const session = await (
    await api("/sessions", "POST", { title: "Recovery canary" })
  ).json();
  const upload = randomUUID(),
    content = "recover-exactly-" + randomUUID();
  await api(
    `/sessions/${session.id}/files/uploads/${upload}?name=proof.txt`,
    "PUT",
    content,
  );
  await stage("doctor-and-service-unit", async () => {
    const d = await doctor(active, { service: true, runtime: true });
    assert.equal(d.passed, true, JSON.stringify(d.checks));
    assert.ok(serviceUnit(active, "harbor").includes("Restart=on-failure"));
    return d.checks.map((x) => ({ name: x.name, status: x.status }));
  });
  if (!process.env.AH_DELIVERY_SKIP_ACCEPTANCE)
    await stage("standard-task-and-fault-acceptance", async () => {
      const report = await acceptance(active, {
        output: join(root, "acceptance"),
      });
      assert.equal(report.passed, true, JSON.stringify(report));
      return report.steps;
    });
  await stop(child);
  const backupDir = join(root, "backup");
  await stage("stopped-consistent-backup", async () =>
    backup(active, backupDir),
  );
  const target = await fresh("restored");
  await stage("checksum-tampering-is-rejected", async () => {
    const file = join(backupDir, "first-admin.key"),
      original = await readFile(file);
    await writeFile(file, "tamper");
    await assert.rejects(restore(target, backupDir), /CHECKSUM/);
    await writeFile(file, original);
    return { rejected: true };
  });
  await stage("empty-target-restore", async () => restore(target, backupDir));
  await compose(target, ["up", "-d", "--wait"]);
  const restored = await config(target.dir);
  child = await boot(restored);
  base = restored.env.AH_SERVICE_URL;
  await stage("restored-identity-history-file-and-ledger", async () => {
    const detail = await (await api("/sessions/" + session.id)).json();
    assert.equal(detail.id, session.id);
    const r = await api(
      `/sessions/${session.id}/files/download?path=${encodeURIComponent("uploads/" + upload + "/proof.txt")}`,
    );
    assert.equal(await r.text(), content);
    const a = new Pool({ connectionString: active.env.AH_DATABASE_URL }),
      b = new Pool({ connectionString: restored.env.AH_DATABASE_URL });
    try {
      for (const sql of [
        'SELECT * FROM wallets ORDER BY "userId"',
        "SELECT * FROM wallet_ledger ORDER BY id",
        "SELECT * FROM wallet_requests ORDER BY id",
      ])
        assert.deepEqual((await a.query(sql)).rows, (await b.query(sql)).rows);
    } finally {
      await a.end();
      await b.end();
    }
    return { identity: true, history: true, file: true, wallets: true };
  });
  await stage("managed-model-wallet-roundtrip", async () => {
    const s = await (
      await api("/sessions", "POST", { title: "Managed model acceptance" })
    ).json();
    const uploadId = randomUUID(),
      csv =
        "department,amount\nFinance,10.10\nEngineering,20.05\nFinance,1.20\nEngineering,0.95\n";
    await api(
      `/sessions/${s.id}/files/uploads/${uploadId}?name=expenses.csv`,
      "PUT",
      csv,
    );
    const accepted = await (
      await api(`/sessions/${s.id}/messages`, "POST", {
        clientMessageId: randomUUID(),
        text: "浏览器验收：请用工具汇总上传的expenses.csv，按department求amount总和，生成summary.csv，头为department,total，金额两位小数。",
      })
    ).json();
    let d;
    const deadline = Date.now() + 90000;
    do {
      d = await (await api("/sessions/" + s.id)).json();
      if (
        !["accepted", "running", "finalizing", "reconciling"].includes(
          d.message?.status,
        )
      )
        break;
      await pause(100);
    } while (Date.now() < deadline);
    assert.equal(d.message?.status, "succeeded", JSON.stringify(d));
    const result = await (
      await api(`/sessions/${s.id}/files/download?path=summary.csv`)
    ).text();
    const { validateSummary } =
      await import("../dist/src/clients/ops/acceptance.js");
    validateSummary(result);
    const p = new Pool({ connectionString: restored.env.AH_DATABASE_URL });
    try {
      const rows = (
        await p.query(
          'SELECT state,charged,"messageId" FROM wallet_requests WHERE "sessionId"=$1',
          [s.id],
        )
      ).rows;
      assert.ok(rows.length >= 2);
      assert.ok(
        rows.every(
          (r) => r.state === "settled" && r.messageId === accepted.message.id,
        ),
      );
      return {
        calls: rows.length,
        chargedMicro: rows.reduce((n, r) => n + Number(r.charged), 0),
      };
    } finally {
      await p.end();
    }
  });
  await stage("restore-refuses-existing-target", async () => {
    await assert.rejects(restore(restored, backupDir), /EMPTY_DATA_ROOT/);
    return { rejected: true };
  });
  restored.env.AH_ALERT_WEBHOOK = `http://127.0.0.1:${receiver.address().port}`;
  await stage("notification-change-deduplication-and-recovery", async () => {
    await monitor(restored);
    assert.equal(alerts.length, 0);
    await stop(child);
    await monitor(restored);
    await monitor(restored);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "unhealthy");
    child = await boot(restored);
    await monitor(restored);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].type, "recovered");
    assert.ok(!JSON.stringify(alerts).includes(key));
    return { notifications: 2, duplicateSuppressed: true };
  });
  passed = true;
  if (process.env.AH_DELIVERY_KEEP_OPEN) {
    await privateJson(join(evidence, "browser-fixture.json"), {
      instance: restored.dir,
      url: base,
      credentialFile: join(restored.dir, "first-admin.key"),
      sessionId: session.id,
      uploadId: upload,
      content,
    });
    console.log("Browser fixture ready:", base);
    await new Promise((r) => {
      process.once("SIGINT", r);
      process.once("SIGTERM", r);
    });
  }
} catch (e) {
  console.error(e.message);
  await writeFile(join(root, "failure-private.log"), String(e.stack), {
    mode: 0o600,
  });
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child).catch(() => {});
  for (const c of instances) {
    await compose(c, ["down", "--volumes", "--remove-orphans"]).catch(() => {});
  }
  model.server.closeAllConnections();
  receiver.closeAllConnections();
  await new Promise((r) => model.server.close(r));
  await new Promise((r) => receiver.close(r));
  await privateJson(join(evidence, "integration-report.json"), {
    passed,
    root,
    results,
    realModelRequests: 0,
  });
  console.log("Integration evidence:", root);
}
