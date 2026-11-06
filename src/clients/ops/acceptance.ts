/** 正式服务子进程+Cookie HTTP+Docker/SDK验收；每次独立schema/根目录，不自动重试业务。 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixtureModel } from "../../../tests/fixture-model.js";
import { openDatabase } from "../../service/db/client.js";
import { applyMigrations } from "../../service/db/migrate.js";
import { tokenHash } from "../../service/auth.js";
import { Controller } from "../../runtime/controller.js";
import { ServiceStore } from "../../service/service-store.js";
import { SessionManager } from "../../service/session-manager.js";
import { WalletService } from "../../service/wallet/service.js";
import { LlmService } from "../../service/llm/service.js";
import { loadModelFile } from "./install.js";
import { llmSettings } from "../../service/llm/client.js";
import {
  requireThat,
  privateJson,
  environment,
  run,
  projectRoot,
  hash,
  request,
  type Config,
} from "./common.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
async function until(
  test: () => Promise<boolean>,
  code: string,
  timeout = 90000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await pause(100);
  }
  throw Error(code);
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p as number;
}
export function validateSummary(csv: string, filtered = false) {
  const rows = csv.trim().split(/\r?\n/);
  requireThat(rows.shift() === "department,total", "CSV_HEADER_INVALID");
  const result = Object.fromEntries(
    rows.map((s) => {
      const cells = s.split(",");
      requireThat(cells.length === 2, "CSV_COLUMNS_INVALID");
      return cells;
    }),
  );
  const expected = filtered
    ? { Engineering: "21.00" }
    : { Engineering: "21.00", Finance: "11.30" };
  requireThat(
    rows.length === Object.keys(expected).length &&
      JSON.stringify(Object.entries(result).sort()) ===
        JSON.stringify(Object.entries(expected).sort()),
    "CSV_RESULT_INCORRECT",
  );
}
export async function acceptance(
  c: Config,
  options: {
    live?: boolean;
    budgetRmb?: number;
    modelFile?: string;
    output?: string;
  } = {},
) {
  if (options.live)
    requireThat(
      options.modelFile &&
        Number.isFinite(options.budgetRmb) &&
        options.budgetRmb! > 0,
      "LIVE_REQUIRES_MODEL_CONFIG_AND_BUDGET_RMB",
    );
  const id = randomUUID(),
    schema = "ah_accept_" + id.replace(/-/g, "").slice(0, 16),
    output = resolve(options.output ?? join(c.dir, "acceptance", id)),
    data = join(output, "data");
  await mkdir(join(data, ".service"), { recursive: true, mode: 0o700 });
  const admin = openDatabase(c.env.AH_DATABASE_URL);
  await admin.pool.query('CREATE SCHEMA "' + schema + '"');
  const url = new URL(c.env.AH_DATABASE_URL!);
  url.searchParams.set("options", "-c search_path=" + schema);
  const db = openDatabase(url.href),
    controller = new Controller(data);
  const uid = "accept-" + id.slice(0, 8),
    key = randomUUID(),
    reader = randomUUID();
  await privateJson(join(data, ".service/access-keys.json"), [
    { userId: uid, tokenHash: tokenHash(key) },
    { userId: uid + "-reader", tokenHash: tokenHash(reader) },
  ]);
  let toolCommand = "",
    dispatched = false;
  const model = options.live
    ? undefined
    : fixtureModel([], () => {
        if (dispatched) return;
        dispatched = true;
        return {
          name: "Bash",
          input: { command: toolCommand, timeout: 60000 },
        };
      });
  if (model)
    await new Promise<void>((r) => model.server.listen(0, "0.0.0.0", r));
  const port = await freePort(),
    base = "http://127.0.0.1:" + port,
    env = environment(c);
  Object.assign(env, {
    AH_DATABASE_URL: url.href,
    AH_DATA_DIR: data,
    AH_SERVICE_PORT: String(port),
    AH_PUBLIC_ORIGIN: base,
    AH_SERVICE_URL: base,
    AH_ADMIN_USERS: uid,
    AH_APPLICATIONS_ENABLED: "0",
    AH_TASK_TIMEOUT_MS: options.live ? "180000" : "90000",
    AH_MAX_TURNS: "8",
    AH_IDLE_TIMEOUT_MS: "300000",
    AH_GATEWAY_TOKEN: "acceptance-fixture-only",
  });
  delete env.AH_OIDC_ISSUER;
  delete env.AH_OIDC_CLIENT_ID;
  delete env.AH_OIDC_CLIENT_SECRET;
  env.AH_KEY_LOGIN = "true";
  if (model) {
    Object.assign(env, {
      AH_LLM_ENABLED: "false",
      AH_WALLET_ENABLED: "false",
      AH_GATEWAY_URL: `http://host.docker.internal:${(model.server.address() as any).port}`,
    });
    delete env.AH_INFERENCE_BIND_HOST;
    delete env.AH_INFERENCE_PORT;
  } else {
    if (env.AH_INFERENCE_BIND_HOST) {
      env.AH_INFERENCE_PORT = String(await freePort());
      env.AH_WALLET_INFERENCE_URL = `http://host.docker.internal:${env.AH_INFERENCE_PORT}/inference`;
    } else
      env.AH_WALLET_INFERENCE_URL = `http://host.docker.internal:${port}/inference`;
  }
  let service: ChildProcess | undefined,
    logs = "",
    cookie = "",
    llm: LlmService | undefined;
  const sessions: string[] = [],
    steps: Array<{ name: string; status: string; detail?: unknown }> = [];
  let passed = false,
    cleanup = true;
  let walletEvidence: Array<Record<string, any>> | undefined;
  const headers = () => ({
    "Content-Type": "application/json",
    Origin: base,
    "X-Harbor-Client": "web",
    ...(cookie ? { Cookie: cookie } : { Authorization: "Bearer " + key }),
  });
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const r = await request(base + "/api" + path, {
      method,
      headers: { ...headers(), ...extra },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as any;
      const code =
        typeof body?.error === "string" && /^[A-Z_]+$/.test(body.error)
          ? body.error
          : "REQUEST_FAILED";
      requireThat(false, "ACCEPTANCE_HTTP_" + r.status + ":" + code);
    }
    return r;
  }
  async function json(path: string, method = "GET", body?: unknown) {
    return (await api(path, method, body)).json() as Promise<any>;
  }
  async function login() {
    const r = await request(base + "/api/auth/login", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ accessKey: key }),
    });
    requireThat(r.ok, "LOGIN_FAILED");
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  }
  async function boot() {
    logs = "";
    service = spawn(
      process.execPath,
      [join(projectRoot, "dist/src/service/server.js")],
      { env, cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    service.stdout!.on("data", (b) => (logs += b));
    service.stderr!.on("data", (b) => (logs += b));
    await until(
      async () => {
        requireThat(service!.exitCode === null, "SERVICE_EXITED");
        return logs.includes("(ready)");
      },
      "SERVICE_START_TIMEOUT",
      30000,
    );
  }
  async function halt(signal: NodeJS.Signals = "SIGTERM") {
    if (service && service.exitCode === null && service.signalCode === null) {
      const child = service, exited = once(child, "exit");
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.kill(signal);
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(Error("SERVICE_STOP_TIMEOUT"));
            }, 35000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async function create() {
    const s = await json("/sessions", "POST", { title: "Acceptance task" });
    sessions.push(s.id);
    return s.id as string;
  }
  async function send(sid: string, text: string, command: string) {
    toolCommand = command;
    dispatched = false;
    return (
      await json(`/sessions/${sid}/messages`, "POST", {
        clientMessageId: randomUUID(),
        text,
      })
    ).message.id as string;
  }
  async function finished(sid: string, mid: string, wanted = "succeeded") {
    let detail: any;
    await until(async () => {
      detail = await json("/sessions/" + sid);
      return (
        detail.message?.id === mid &&
        !["accepted", "running", "finalizing", "reconciling"].includes(
          detail.message.status,
        )
      );
    }, "TASK_TIMEOUT", options.live ? 210000 : 90000);
    requireThat(
      detail.message.status === wanted,
      "UNEXPECTED_TASK_STATUS:" + detail.message.status,
    );
    return detail;
  }
  async function upload(sid: string, name: string, content: string) {
    const id = randomUUID();
    await api(
      `/sessions/${sid}/files/uploads/${id}?name=${name}`,
      "PUT",
      content,
      {
        "Content-Type": "application/octet-stream",
        "X-Content-Sha256": hash(content),
      },
    );
    return "/workspace/uploads/" + id + "/" + name;
  }
  const download = async (sid: string, path: string) =>
    (
      await api(
        `/sessions/${sid}/files/download?path=${encodeURIComponent(path)}`,
      )
    ).text();
  async function stage(name: string, action: () => Promise<unknown>) {
    try {
      steps.push({ name, status: "passed", detail: await action() });
    } catch (error) {
      steps.push({
        name,
        status: "failed",
        detail: error instanceof Error ? error.message : "CHECK_FAILED",
      });
      throw Error("ACCEPTANCE_STAGE_FAILED:" + name);
    }
  }
  try {
    await applyMigrations(db.pool, join(projectRoot, "migrations"));
    if (options.live) {
      const setup = await loadModelFile(options.modelFile!);
      const manager = new SessionManager(
        new ServiceStore(db.db),
        {
          open: async () => {
            throw Error("not executing");
          },
        },
        "fixture-only",
      );
      await manager.identity.importKeys([
        { userId: uid, tokenHash: tokenHash(key) },
      ]);
      await new WalletService(db.db).gift(uid, {
        id: randomUUID(),
        amountYuan: String(options.budgetRmb),
        note: "isolated acceptance budget",
        userIds: [uid],
      });
      llm = new LlmService(db.db, join(data, ".service"), llmSettings(env)!);
      const p = await llm.addProvider(setup.provider, uid);
      const d = await llm.createDeployment(
        {
          ...setup.deployment,
          providerId: p.id,
          cost: setup.cost,
          price: setup.price,
        },
        uid,
      );
      env.AH_LLM_DEFAULT_DEPLOYMENT_ID = d.deployment.id;
      await manager.shutdown();
    }
    await boot();
    await login();
    const sid = await create(),
      input =
        "department,amount\nFinance,10.10\nEngineering,20.05\nFinance,1.20\nEngineering,0.95\n",
      source = await upload(sid, "expenses.csv", input);
    const resultFile = "/workspace/summary.csv";
    await stage("upload-model-tools-download", async () => {
      const py = `import csv\nfrom decimal import Decimal\nfrom collections import defaultdict\nsums=defaultdict(Decimal)\nwith open(${JSON.stringify(source)}) as f:\n for r in csv.DictReader(f): sums[r['department']]+=Decimal(r['amount'])\nwith open('/workspace/summary.csv','w') as f:\n f.write('department,total\\n')\n for k,v in sorted(sums.items()): f.write(f'{k},{v:.2f}\\n')\n`;
      const mid = await send(
        sid,
        `实际读取 ${source}，用工具按department汇总amount。生成 ${resultFile}，CSV头为department,total，金额保留两位小数。不要改原文件。`,
        "python3 -c " + quote(py),
      );
      await finished(sid, mid);
      validateSummary(await download(sid, "summary.csv"));
      requireThat(
        (await readFile(
          join(data, sid, source.replace("/workspace/", "workspace/")),
          "utf8",
        )) === input,
        "INPUT_CHANGED",
      );
      return { messageId: mid };
    });
    await stage("continuation-and-duplicate-submission", async () => {
      const mid = await send(
        sid,
        "继续上轮，读取summary.csv，只保留总额不少于20的部门，生成filtered.csv，保持同一列头和两位金额。",
        `python3 -c ${quote("import csv\nfrom decimal import Decimal\nwith open('/workspace/summary.csv') as f: rows=list(csv.DictReader(f))\nwith open('/workspace/filtered.csv','w') as f:\n f.write('department,total\\n')\n for r in rows:\n  if Decimal(r['total'])>=20: f.write(r['department']+','+r['total']+'\\n')")}`,
      );
      await finished(sid, mid);
      validateSummary(await download(sid, "filtered.csv"), true);
      const clientId = randomUUID();
      const body = {
        clientMessageId: clientId,
        text: "请只回复已收到，不调用任何工具。",
      };
      toolCommand = "true";
      dispatched = true;
      const first = await json(`/sessions/${sid}/messages`, "POST", body),
        second = await json(`/sessions/${sid}/messages`, "POST", body);
      requireThat(first.message.id === second.message.id, "DUPLICATE_MESSAGE");
      await finished(sid, first.message.id);
      return { messageId: mid };
    });
    await stage("user-and-file-isolation", async () => {
      for (const path of [
        `/sessions/${sid}`,
        `/sessions/${sid}/history`,
        `/sessions/${sid}/files/download?path=summary.csv`,
      ]) {
        const r = await request(base + "/api" + path, {
          headers: { Authorization: "Bearer " + reader },
        });
        requireThat([403, 404].includes(r.status), "CROSS_USER_ACCESS_ALLOWED");
      }
      return { checks: 3 };
    });
    await stage("relogin-history-download", async () => {
      cookie = "";
      await login();
      requireThat((await json("/sessions/" + sid)).id === sid, "SESSION_LOST");
      const history = await json(`/sessions/${sid}/history?after=0`);
      requireThat(
        history.events.some((e: any) => e.type === "tool.started"),
        "NO_TOOL_EVIDENCE",
      );
      validateSummary(await download(sid, "summary.csv"));
      return { events: history.events.length };
    });
    const code = await create(),
      codePath = await upload(
        code,
        "calculator.py",
        "def add(a,b):\n    return a-b\n",
      );
    await stage("real-code-edit-and-independent-tests", async () => {
      const mid = await send(
        code,
        `读取 ${codePath} 并修复add函数应该做加法的问题。把修复后的完整模块写入 /workspace/calculator.py，保留函数名，不需要安装依赖。`,
        `printf 'def add(a,b):\\n    return a+b\\n' > /workspace/calculator.py`,
      );
      await finished(code, mid);
      await download(code, "calculator.py");
      const name = "ah-code-check-" + id;
      try {
        await run(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            "none",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--pids-limit",
            "64",
            "--memory",
            "256m",
            "--tmpfs",
            "/tmp:rw,nosuid,size=32m,mode=1777",
            "--mount",
            `type=bind,src=${join(data, code, "workspace/calculator.py")},dst=/candidate.py,readonly`,
            "--entrypoint",
            "python3",
            c.env.AH_IMAGE!,
            "-I",
            "-c",
            "import runpy; f=runpy.run_path('/candidate.py')['add']; assert f(2,3)==5; assert f(-3,2)==-1; assert f(0,0)==0",
          ],
          { timeout: 15000 },
        );
      } finally {
        await run("docker", ["rm", "-f", name]).catch(() => {});
      }
      return { assertions: 3 };
    });
    for (const existing of [sid, code]) {
      const d = await json("/sessions/" + existing);
      await json("/sessions/" + existing + "/close", "POST", {
        expectedMessageId: d.lastMessageId,
      });
      await until(
        async () =>
          (await json("/sessions/" + existing)).environment === "closed",
        "ENVIRONMENT_CLOSE_UNCONFIRMED",
      );
    }
    await until(async () => {
      const a = await json("/account");
      return a.counts.environments === 0 && a.counts.tasks === 0;
    }, "QUOTA_RELEASE_UNCONFIRMED");
    if (!options.live) {
      const slow = await create(),
        ticks = join(data, slow, "workspace/ticks");
      const slowCommand =
        "python3 -c " +
        quote(
          "import time\nf=open('/workspace/ticks','a',buffering=1)\nfor i in range(1200): f.write('tick\\n'); time.sleep(.05)",
        );
      await stage("viewer-disconnect-task-continues", async () => {
        const mid = await send(
          slow,
          "执行有限计数任务",
          "python3 -c " +
            quote(
              "import time\nf=open('/workspace/ticks','w',buffering=1)\nfor i in range(40): f.write('tick\\n'); time.sleep(.1)",
            ),
        );
        await until(
          async () =>
            (await readFile(ticks).catch(() => Buffer.alloc(0))).length > 0,
          "FINITE_TOOL_NOT_STARTED",
        );
        const watch = new AbortController();
        const stream = await request(
          base + "/api/sessions/" + slow + "/events",
          { headers: headers(), signal: watch.signal },
        );
        requireThat(stream.ok, "EVENT_STREAM_FAILED");
        const reader = stream.body!.getReader();
        await reader.read();
        await reader.cancel();
        watch.abort();
        cookie = "";
        await login();
        await finished(slow, mid);
        requireThat(
          (await readFile(ticks, "utf8")).trim().split("\n").length === 40,
          "DISCONNECT_INTERRUPTED_TASK",
        );
        await until(
          async () => (await json("/account")).counts.tasks === 0,
          "TASK_SLOT_NOT_RELEASED",
        );
        return { viewerDisconnected: true, taskCompleted: true, ticks: 40 };
      });
      await stage("stop-and-continue", async () => {
        await writeFile(ticks, "");
        const mid = await send(slow, "运行配置的慢任务", slowCommand);
        await until(
          async () =>
            (await readFile(ticks).catch(() => Buffer.alloc(0))).length > 0,
          "SLOW_TOOL_DID_NOT_START",
        );
        await json(`/sessions/${slow}/messages/${mid}/cancel`, "POST");
        await finished(slow, mid, "cancelled");
        const before = await readFile(ticks);
        await pause(300);
        requireThat(
          hash(before) === hash(await readFile(ticks)),
          "WRITER_NOT_STOPPED",
        );
        await until(
          async () => (await json("/account")).counts.tasks === 0,
          "TASK_SLOT_NOT_RELEASED",
        );
        const next = await send(slow, "继续，执行echo resumed", "echo resumed");
        await finished(slow, next);
        return { stopped: true };
      });
      await stage("service-crash-and-recovery", async () => {
        await writeFile(ticks, "");
        const mid = await send(slow, "运行配置的慢任务", slowCommand);
        await until(
          async () => (await readFile(ticks)).length > 0,
          "SLOW_TOOL_DID_NOT_START",
        );
        await halt("SIGKILL");
        await boot();
        await login();
        const detail = await json("/sessions/" + slow);
        requireThat(
          ["interrupted", "failed", "cancelled"].includes(
            detail.message.status,
          ),
          "CRASH_STATUS_NOT_EXPLICIT",
        );
        requireThat(
          (await controller.backend.forSession(slow)).length === 0,
          "OLD_WRITER_REMAINS",
        );
        validateSummary(await download(sid, "summary.csv"));
        return { messageId: mid, historyPreserved: true };
      });
    } else
      steps.push({
        name: "fault-injection",
        status: "skipped",
        detail:
          "run deterministic acceptance separately; no extra paid fault tasks",
      });
    if (options.live)
      await stage("wallet-evidence", async () => {
        const rows = (
          await db.pool.query(
            'SELECT id,state,charged,"messageId" FROM wallet_requests',
          )
        ).rows;
        requireThat(rows.length > 0, "NO_WALLET_REQUESTS");
        requireThat(
          rows.every((r) => r.state === "settled" && r.messageId),
          "USAGE_OR_CORRELATION_UNCONFIRMED",
        );
        return {
          requests: rows.length,
          chargedMicro: rows.reduce((n, r) => n + Number(r.charged), 0),
        };
      });
    passed = true;
  } catch {
    passed = false;
  } finally {
    await halt().catch(() => {
      cleanup = false;
    });
    // 失败也必须留下计量证据；未确认的费用保留schema，不能随临时任务一并丢弃。
    if (options.live) {
      try {
        walletEvidence = (await db.pool.query(
          'SELECT id,state,charged,actual,"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","messageId","gatewayCallId","httpStatus","failureCode" FROM wallet_requests ORDER BY "createdAt",id',
        )).rows;
        await privateJson(join(output, "wallet-evidence.json"), walletEvidence);
        if (walletEvidence.some(r => !["settled", "released"].includes(r.state))) cleanup = false;
      } catch {
        cleanup = false;
      }
    }
    for (const sid of await controller.backend.ownedSessions()) {
      for (const container of await controller.backend.forSession(sid)) {
        try {
          await controller.backend.stop(container);
          await controller.backend.destroy(container);
        } catch {
          cleanup = false;
        }
      }
    }
    if (llm) {
      try {
        await llm.revokeUser(uid);
        const versions = (
          await db.pool.query("SELECT id FROM llm_model_versions")
        ).rows;
        for (const v of versions)
          await llm.client.request("/model/delete", { id: v.id });
      } catch {
        cleanup = false;
      }
    }
    if (model) {
      model.server.closeAllConnections();
      await new Promise<void>((r) => model.server.close(() => r()));
    }
    await writeFile(join(output, "service-private.log"), logs, { mode: 0o600 });
    await db.close();
    if (cleanup) await admin.pool.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.close();
  }
  const report = {
    format: 1,
    passed: passed && cleanup,
    mode: options.live ? "real-model" : "deterministic",
    steps,
    cleanupConfirmed: cleanup,
    realModelRequests: options.live ? walletEvidence?.length ?? "unknown" : 0,
    ...(options.live ? {
      walletEvidenceFile: join(output, "wallet-evidence.json"),
      chargedMicro: walletEvidence?.reduce((n, r) => n + Number(r.charged ?? 0), 0),
      ...(cleanup ? {} : { retainedSchema: schema }),
    } : {}),
    browserVerification: "not_run",
    output,
  };
  await privateJson(join(output, "report.json"), report);
  return report;
}
