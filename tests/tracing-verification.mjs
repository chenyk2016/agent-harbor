/** Isolated PostgreSQL + fixed LiteLLM + native SDK, deterministic model, optional real Cloud OTLP. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parseEnv } from "node:util";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fetch as networkFetch, ProxyAgent } from "undici";
import { Pool } from "pg";

const redacted = process.env.AH_TRACING_VERIFY_CONTENT === "1";
const secretMarker = "sk-synthetic-never-export-1234567890";
const inputMarker = "HARBOR_VISIBLE_MODEL_INPUT";
const toolMarker = redacted ? "HARBOR_VISIBLE_TOOL_RESULT" : "PRIVATE_COMMAND";
const evidence = resolve(
  process.env.AH_TRACING_EVIDENCE_DIR ??
    "var/evidence/llm-observability/2026-11-05",
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const runId = Date.now(),
  pgName = "ah-tracing-pg-" + runId,
  gatewayName = "ah-tracing-gateway-" + runId;
const password = randomBytes(24).toString("hex"),
  master = "sk-" + randomBytes(24).toString("hex");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(500);
  }
  throw Error("verification timeout");
}
async function run(command, args, env, filename) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(join(evidence, filename), { mode: 0o600 });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
  const code = await new Promise((r) => child.once("exit", r));
  clearTimeout(timer);
  await new Promise((r) => log.end(r));
  if (code !== 0)
    throw Error(filename + " failed; inspect the private evidence log");
}
let database,
  manager,
  tracer,
  server,
  fixture,
  collector,
  proxy,
  fault,
  litePool;
let stage = "database",
  privacyRejected = 0;
const report = {
  realModelRequests: 0,
  cloudConfigured: false,
  cases: [],
  cleanupConfirmed: false,
  cloudHttp: {},
};
try {
  docker(
    "run",
    "-d",
    "--name",
    pgName,
    "--label",
    "harbor.verification=tracing",
    "-e",
    "POSTGRES_USER=tracing",
    "-e",
    "POSTGRES_PASSWORD=" + password,
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=512m",
    "postgres:18-alpine",
  );
  const pgPort = docker("port", pgName, "5432/tcp").split(":").at(-1),
    dbUrl = `postgres://tracing:${password}@127.0.0.1:${pgPort}/postgres`;
  await wait(async () => {
    const p = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 800,
    });
    try {
      await p.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await p.end();
    }
  });
  const env = { ...process.env, AH_TEST_DATABASE_URL: dbUrl };
  process.env.AH_TEST_DATABASE_URL = dbUrl;
  await writeFile(
    join(evidence, "test.env"),
    `AH_TEST_DATABASE_URL="${dbUrl}"\n`,
    { mode: 0o600 },
  );
  console.log("Disposable database ready; building and testing");
  if (!process.env.AH_TRACING_SKIP_TESTS) {
    await run("npm", ["run", "check"], env, "check.log");
    await run("npm", ["run", "build"], env, "build.log");
    await run(
      "node",
      [
        "--test",
        "--test-concurrency=1",
        "dist/tests/tracing.test.js",
        "dist/tests/wallet-proxy.test.js",
      ],
      env,
      "targeted-tests.log",
    );
    report.cases.push(
      "configuration, durable replay, source privacy, disabled and target isolation, partial rejection, wallet regression",
    );
    console.log("Targeted tracing and wallet tests passed");
    if (!process.env.AH_TRACING_TARGETED_ONLY) {
      await run("npm", ["test"], env, "tests.log");
      report.cases.push("full regression");
      console.log("Full regression passed");
    }
  }
  const cloud = process.env.AH_LANGFUSE_ENV_FILE
    ? parseEnv(await readFile(process.env.AH_LANGFUSE_ENV_FILE, "utf8"))
    : null;
  report.cloudConfigured = !!cloud;
  if (cloud)
    assert.equal(cloud.AH_LANGFUSE_HOST, "https://jp.cloud.langfuse.com");
  proxy = cloud
    ? new ProxyAgent(process.env.AH_TRACING_PROXY ?? "http://127.0.0.1:7890")
    : undefined;
  const sendCloud = async (path, init = {}) => {
    const r = await networkFetch(cloud.AH_LANGFUSE_HOST + path, {
      ...init,
      dispatcher: proxy,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    report.cloudHttp[r.status] = (report.cloudHttp[r.status] ?? 0) + 1;
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") ?? "application/json",
      },
    });
  };
  const gatewayBodies = [];
  let collected = 0;
  collector = createServer(async (req, res) => {
    try {
      let raw = Buffer.concat(await Array.fromAsync(req));
      if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
      const path = req.url;
      if (path.startsWith("/api/public/otel")) {
        collected++;
        // Check actual wire payload before forwarding anything to Cloud, including protobuf.
        for (const sentinel of [
          "PRIVATE_TRACE_SENTINEL",
          secretMarker,
          "fixture-only-upstream",
          "PRIVATE_COMMAND",
          "PRIVATE_ANSWER",
        ])
          if (raw.includes(Buffer.from(sentinel))) {
            privacyRejected++;
            report.rejectedSource = req.headers["content-type"]?.includes(
              "protobuf",
            )
              ? "gateway"
              : "host";
            throw Error("telemetry privacy violation");
          }
        if (req.headers["content-type"]?.includes("protobuf"))
          gatewayBodies.push(raw);
      }
      if (!cloud) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            path.startsWith("/api/public/projects")
              ? { data: [{ id: "local-fixture" }] }
              : {},
          ),
        );
        return;
      }
      const response = await sendCloud(path, {
        method: req.method,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              cloud.AH_LANGFUSE_PUBLIC_KEY + ":" + cloud.AH_LANGFUSE_SECRET_KEY,
            ).toString("base64"),
          "content-type": req.headers["content-type"] ?? "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        ...(req.method === "POST" ? { body: raw } : {}),
      });
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type"),
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error.message !== "telemetry privacy violation") {
        report.collectorErrors = (report.collectorErrors ?? 0) + 1;
        report.collectorErrorType = error.cause?.code ?? error.name;
      }
      res.writeHead(502);
      res.end("{}");
    }
  });
  await new Promise((r) => collector.listen(0, "0.0.0.0", r));
  const collectorPort = collector.address().port;
  const { fixtureModel } = await import("../dist/tests/fixture-model.js");
  fixture = fixtureModel([
    {
      name: "Bash",
      input: {
        command:
          "printf " + toolMarker + (redacted ? "; printf " + secretMarker : ""),
        timeout: 10000,
      },
    },
  ]);
  await new Promise((r) => fixture.server.listen(0, "0.0.0.0", r));
  const fixturePort = fixture.server.address().port;
  let faultMode = "error";
  fault = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume the request without recording it */
    }
    if (faultMode === "error") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "api_error",
            message: "PRIVATE_TRACE_SENTINEL provider failure detail",
          },
        }),
      );
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fault","type":"message","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      );
    }
  });
  await new Promise((r) => fault.listen(0, "0.0.0.0", r));
  const pool = new Pool({ connectionString: dbUrl });
  await pool.query("CREATE DATABASE litellm");
  await pool.end();
  litePool = new Pool({
    connectionString: dbUrl.replace(/\/postgres$/, "/litellm"),
  });
  const envFile = join(evidence, "gateway.env");
  async function startGateway(enabled) {
    try {
      docker("rm", "-f", gatewayName);
    } catch {}
    const native = {
      DATABASE_URL: `postgres://tracing:${password}@host.docker.internal:${pgPort}/litellm`,
      LITELLM_MASTER_KEY: master,
      LITELLM_SALT_KEY: password,
      STORE_MODEL_IN_DB: "True",
    };
    if (enabled)
      Object.assign(native, {
        AH_LANGFUSE_HOST: `http://host.docker.internal:${collectorPort}`,
        AH_LANGFUSE_CONTENT_MODE: redacted ? "redacted" : "metadata",
        AH_LANGFUSE_PUBLIC_KEY: "fixture-public",
        AH_LANGFUSE_SECRET_KEY: "fixture-secret",
      });
    await writeFile(
      envFile,
      Object.entries(native)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    docker(
      "run",
      "-d",
      "--name",
      gatewayName,
      "--label",
      "harbor.verification=tracing",
      "--env-file",
      envFile,
      "-p",
      "127.0.0.1::4000",
      "-v",
      resolve("infra/litellm.config.yaml") + ":/app/harbor.yaml:ro",
      "-v",
      resolve("infra/start-litellm.py") + ":/app/harbor-start.py:ro",
      "-v",
      resolve("infra/langfuse") + ":/app/harbor-observation:ro",
      "--entrypoint",
      "python",
      "ghcr.io/berriai/litellm:v1.106.1",
      "/app/harbor-start.py",
      "--port",
      "4000",
    );
    const url =
      "http://127.0.0.1:" +
      docker("port", gatewayName, "4000/tcp").split(":").at(-1);
    await wait(async () => {
      try {
        return (
          await fetch(url + "/health/readiness", {
            headers: { Authorization: "Bearer " + master },
            signal: AbortSignal.timeout(1500),
          })
        ).ok;
      } catch {
        return false;
      }
    }, 150000);
    return url;
  }
  stage = "gateway absent";
  console.log("Checking actual LiteLLM with telemetry absent");
  let gateway = await startGateway(false);
  docker(
    "exec",
    gatewayName,
    "python",
    "-c",
    `
import runpy,tempfile,yaml
configure=runpy.run_path('/app/harbor-start.py')['configure']
base={'AH_LANGFUSE_HOST':'https://jp.cloud.langfuse.com','AH_LANGFUSE_PUBLIC_KEY':'fixture-public','AH_LANGFUSE_SECRET_KEY':'fixture-secret'}
cases=[({},'disabled'),({'AH_LANGFUSE_HOST':base['AH_LANGFUSE_HOST']},'invalid'),({**base,'AH_LANGFUSE_HOST':'http://outside.invalid'},'invalid'),(base,'enabled'),({**base,'AH_LANGFUSE_HOST':base['AH_LANGFUSE_HOST']+'/'},'enabled')]
for values,expected in cases:
 env=dict(values)
 with tempfile.NamedTemporaryFile() as f:
  assert configure('/app/harbor.yaml',f.name,env)==expected
  callbacks=yaml.safe_load(open(f.name))['litellm_settings']['callbacks']
  assert ('langfuse_otel' in callbacks)==(expected=='enabled')
  assert ('LANGFUSE_SECRET_KEY' in env)==(expected=='enabled')
  assert all(not key.startswith('AH_LANGFUSE_') for key in env)
print('Container configuration cases passed')
`,
  );
  report.cases.push(
    "container generator absent/partial/invalid/complete/trailing-slash contracts",
  );
  const management = async (path, body) => {
    const r = await fetch(gateway + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + master,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert(r.ok, "isolated gateway management HTTP " + r.status);
    return r.json();
  };
  await management("/model/new", {
    model_name: "tracing-fixture",
    litellm_params: {
      model: "anthropic/fixture",
      api_base: `http://host.docker.internal:${fixturePort}`,
      api_key: "fixture-only-upstream",
      num_retries: 0,
    },
    model_info: { input_cost_per_token: 0, output_cost_per_token: 0 },
  });
  const direct = async () =>
    fetch(gateway + "/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + master,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "tracing-fixture",
        max_tokens: 64,
        messages: [{ role: "user", content: "PRIVATE_TRACE_SENTINEL" }],
      }),
    });
  const disabled = await direct();
  assert(disabled.ok, "disabled model request");
  await disabled.text();
  await delay(2500);
  assert.equal(collected, 0);
  report.cases.push(
    "actual fixed LiteLLM without configuration makes zero telemetry requests",
  );
  console.log("Disabled verified; enabling the same isolated gateway");
  stage = "gateway enabled";
  gateway = await startGateway(true);
  if (redacted) {
    const r = await fetch(gateway + "/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + master,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "tracing-fixture",
        max_tokens: 64,
        system: "HARBOR_VISIBLE_SYSTEM",
        messages: [{ role: "user", content: inputMarker + " " + secretMarker }],
      }),
    });
    assert(r.ok);
    await r.text();
    await wait(() => gatewayBodies.length > 0, 20000);
    const native = Buffer.concat(gatewayBodies);
    report.nativeJson = Object.fromEntries(
      [
        inputMarker,
        "HARBOR_VISIBLE_SYSTEM",
        toolMarker,
        "langfuse.observation.input",
        "langfuse.observation.output",
      ].map((k) => [k, native.includes(k)]),
    );
    await writeFile(
      join(evidence, "native-probe.json"),
      JSON.stringify(report.nativeJson, null, 2),
    );
    assert(
      Object.values(report.nativeJson).every(Boolean),
      "native Anthropic JSON generation fields",
    );
  }
  await management("/model/new", {
    model_name: "tracing-fault",
    litellm_params: {
      model: "anthropic/fixture",
      api_base: `http://host.docker.internal:${fault.address().port}`,
      api_key: "fixture-only-upstream",
      num_retries: 0,
    },
    model_info: { input_cost_per_token: 0, output_cost_per_token: 0 },
  });
  const invokeFault = (signal) =>
    fetch(gateway + "/v1/messages", {
      method: "POST",
      signal,
      headers: {
        Authorization: "Bearer " + master,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "tracing-fault",
        max_tokens: 10,
        stream: faultMode !== "error",
        messages: [
          {
            role: "user",
            content: redacted ? secretMarker : "PRIVATE_TRACE_SENTINEL",
          },
        ],
      }),
    });
  const beforeFault = collected;
  const failed = await invokeFault();
  assert(failed.status >= 400);
  await failed.text();
  faultMode = "hold";
  const cancel = new AbortController(),
    held = await invokeFault(cancel.signal);
  assert(held.ok);
  await held.body.getReader().read();
  cancel.abort();
  await delay(6000);
  assert(
    collected > beforeFault,
    "failure telemetry reached the privacy boundary",
  );
  assert.equal(
    privacyRejected,
    0,
    "failure/cancellation payloads must not export provider details",
  );
  report.cases.push(
    "actual gateway upstream failure and cancellation do not expose error text or credential marker",
  );
  stage = "native SDK";
  const { testDatabase } = await import("../dist/tests/pg.js");
  database = await testDatabase();
  const { Controller } = await import("../dist/src/runtime/controller.js");
  const { defaultProfile } = await import("../dist/src/shared/types.js");
  const { ServiceStore } = await import("../dist/src/service/service-store.js");
  const { SessionManager } =
    await import("../dist/src/service/session-manager.js");
  const { LlmService } = await import("../dist/src/service/llm/service.js");
  const { TracingService } =
    await import("../dist/src/service/tracing/service.js");
  const { langfuseConfig } =
    await import("../dist/src/service/tracing/config.js");
  const { createApi } = await import("../dist/src/service/http-api.js");
  const { tokenHash } = await import("../dist/src/service/auth.js");
  const controller = new Controller(join(evidence, "runtime-" + runId), {
    ...defaultProfile,
    image: process.env.AH_VERIFY_IMAGE ?? "agent-harbor:admin-operations-v28",
    timeoutMs: 90000,
    interruptTimeoutMs: 10000,
  });
  manager = new SessionManager(
    new ServiceStore(database.db),
    controller,
    "fixture-no-global",
    60000,
    4,
  );
  const config = langfuseConfig({
    ...(cloud ?? {
      AH_LANGFUSE_HOST: `http://127.0.0.1:${collectorPort}`,
      AH_LANGFUSE_PUBLIC_KEY: "fixture-public",
      AH_LANGFUSE_SECRET_KEY: "fixture-secret",
    }),
    AH_LANGFUSE_CONTENT_MODE: redacted ? "redacted" : "metadata",
  });
  const transport = async (url, init) =>
    fetch(
      "http://127.0.0.1:" +
        collectorPort +
        new URL(url).pathname +
        new URL(url).search,
      init,
    );
  tracer = new TracingService(database.db, config, transport);
  await tracer.initialize();
  tracer.start();
  const llm = new LlmService(
    database.db,
    join(evidence, "runtime-" + runId, ".service"),
    {
      managementUrl: gateway,
      inferenceUrl: gateway.replace("127.0.0.1", "host.docker.internal"),
      masterKey: master,
      walletProxyUrl: "http://pending.invalid/inference",
    },
  );
  const access = randomBytes(24).toString("hex");
  await manager.identity.importKeys([
    { userId: "tracing-fixture", tokenHash: tokenHash(access) },
  ]);
  server = createApi(
    manager,
    controller,
    undefined,
    { adminUsers: ["tracing-fixture"] },
    undefined,
    undefined,
    undefined,
    llm,
    tracer,
  );
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  llm.settings.walletProxyUrl =
    origin.replace("127.0.0.1", "host.docker.internal") + "/inference";
  const api = async (path, method = "GET", body) => {
    const r = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + access,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await r.json();
    assert(r.ok, "fixture API " + path + ": " + r.status);
    return value;
  };
  const provider = await api("/admin/llm/providers", "POST", {
    name: "Tracing fixture",
    format: "anthropic_compatible",
    apiBase: `http://host.docker.internal:${fixturePort}`,
    apiKey: "fixture-only-upstream",
  });
  const detail = await api("/admin/llm/deployments", "POST", {
    providerId: provider.id,
    name: "Tracing fixture",
    upstreamModel: "fixture",
    tools: true,
    streaming: true,
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cacheReadUsdPerMillion: 0,
      cacheWriteUsdPerMillion: 0,
    },
  });
  // A separate immutable zero-price snapshot is explicitly configured for this synthetic model.
  await llm.createPrice(
    detail.deployment.id,
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    "tracing-fixture",
  );
  const session = await api("/sessions", "POST", {
    title: "Synthetic tracing verification",
    deploymentId: detail.deployment.id,
    clientRequestId: randomUUID(),
  });
  const messages = [];
  const beforeSdk = gatewayBodies.length;
  for (let i = 0; i < 2; i++) {
    await api(`/sessions/${session.id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: redacted
        ? inputMarker + " " + secretMarker
        : "PRIVATE_TRACE_SENTINEL deterministic tracing validation",
    });
    let message;
    await wait(async () => {
      message = (await api(`/sessions/${session.id}`)).message;
      return (
        message &&
        !["accepted", "running", "finalizing", "reconciling"].includes(
          message.status,
        )
      );
    }, 120000);
    assert.equal(message.status, "succeeded", "native SDK turn completion");
    messages.push(message.id);
  }
  stage = "Harbor exporter drain";
  await wait(async () => {
    await tracer.tick();
    const status = await tracer.status();
    report.lastExportError = status.lastError;
    return status.pending === 0;
  }, 45000);
  const requests = (
    await database.pool.query(
      'SELECT id,"messageId","gatewayCallId" FROM wallet_requests ORDER BY "createdAt"',
    )
  ).rows;
  assert(requests.length >= 2);
  assert(
    requests.every((r) => messages.includes(r.messageId) && r.gatewayCallId),
  );
  report.cases.push(
    "two native SDK turns, actual Bash tool, per-request wallet/gateway/trace association",
  );
  report.requests = requests.length;
  report.messages = messages;
  report.cloudTraces = [];
  if (cloud) {
    stage = "Cloud generation confirmation";
    console.log(
      "Native SDK passed; confirming model generations in Japan Cloud",
    );
    for (const r of requests) {
      await wait(() => tracer.confirm(r.id), 150000);
      const e = await api("/admin/operations/requests/" + r.id);
      assert.equal(e.tracing.status, "confirmed");
      assert(
        e.tracing.url.startsWith("https://jp.cloud.langfuse.com/project/"),
      );
      report.cloudTraces.push({
        requestId: r.id,
        traceId: e.tracing.traceId,
        url: e.tracing.url,
      });
    }
    report.cases.push(
      "actual OTLP Cloud acceptance and generation read-back; authenticated admin links",
    );
  }
  if (redacted) {
    stage = "native streaming export";
    await wait(() => {
      const native = Buffer.concat(gatewayBodies.slice(beforeSdk));
      return (
        native.includes(inputMarker) &&
        native.includes("FIXTURE_DONE") &&
        native.includes(toolMarker) &&
        native.includes("langfuse.observation.output")
      );
    }, 20000);
    const native = Buffer.concat(gatewayBodies.slice(beforeSdk));
    assert(
      native.includes("tool_result"),
      "next model request includes tool feedback",
    );
    report.cases.push(
      "native SDK streaming generation contains request, model response and tool feedback",
    );
  }
  if (cloud && redacted) {
    stage = "Cloud content read-back";
    const auth =
      "Basic " +
      Buffer.from(
        cloud.AH_LANGFUSE_PUBLIC_KEY + ":" + cloud.AH_LANGFUSE_SECRET_KEY,
      ).toString("base64");
    async function observations(traceId) {
      const query = new URLSearchParams({
        filter: JSON.stringify([
          { type: "string", column: "traceId", operator: "=", value: traceId },
        ]),
        fields: "core,basic,io,metadata,model,usage,trace_context",
        fromStartTime: new Date(runId - 60000).toISOString(),
        limit: "100",
      });
      const response = await sendCloud("/api/public/v2/observations?" + query, {
        headers: { Authorization: auth },
      });
      if (!response.ok) return [];
      const rows = (await response.json()).data ?? [];
      assert(
        !JSON.stringify(rows).includes(secretMarker),
        "Cloud must not contain the credential marker",
      );
      return rows;
    }
    const taskTraceId = new URL(
      (await api("/admin/operations/requests/" + requests[0].id)).tracing
        .taskUrl,
    ).pathname
      .split("/")
      .at(-1);
    await wait(
      async () =>
        (await observations(taskTraceId)).some(
          (o) =>
            o.type?.toUpperCase() === "TOOL" &&
            JSON.stringify(o.output ?? "").includes(toolMarker),
        ),
      150000,
    );
    const generations = (
      await Promise.all(
        report.cloudTraces.map(async (t) => observations(t.traceId)),
      )
    )
      .flat()
      .filter((o) => o.type?.toUpperCase() === "GENERATION");
    assert(
      generations.some(
        (o) =>
          JSON.stringify(o.input ?? "").includes(inputMarker) &&
          JSON.stringify(o.output ?? "").includes("FIXTURE_DONE"),
      ),
      "same Cloud generation contains model input and output",
    );
    report.cases.push(
      "Japan Cloud read-back: generation I/O, Bash tool output, credential marker absent",
    );
  }
  stage = "storage and logs";
  const queued = (
    await database.pool.query("SELECT span FROM tracing_outbox")
  ).rows.map((r) => r.span);
  assert(queued.some((s) => s.name === "harbor.task"));
  assert(queued.some((s) => s.name === "tool.finished"));
  const serialized = JSON.stringify(queued);
  assert(
    !serialized.includes("PRIVATE_") && !serialized.includes(secretMarker),
  );
  if (redacted) {
    const tool = queued.find(
      (s) =>
        s.name === "tool.finished" &&
        s.attributes.some(
          (a) =>
            a.key === "langfuse.observation.output" &&
            a.value.stringValue?.includes(toolMarker),
        ),
    );
    assert(
      tool,
      "actual native Bash output is projected to the tool observation",
    );
    const diagnostics = (
      await database.pool.query("SELECT payload FROM events")
    ).rows;
    assert(
      !JSON.stringify(diagnostics).includes(toolMarker),
      "tool content stays outside product events",
    );
    const snapshot = JSON.parse(
      await readFile(
        join(controller.store.directory(session.id), "session.json"),
        "utf8",
      ),
    );
    const log = await readFile(
      join(
        controller.store.directory(session.id),
        "attempts",
        snapshot.runnerId,
        "runner-events.jsonl",
      ),
      "utf8",
    );
    assert(
      !log
        .split("\n")
        .filter(Boolean)
        .some((line) => "toolContent" in JSON.parse(line)),
      "Runner diagnostics exclude private content field",
    );
    const gatewayLogs = docker("logs", gatewayName);
    for (const marker of [secretMarker, inputMarker, "PRIVATE_TRACE_SENTINEL"])
      assert(
        !gatewayLogs.includes(marker),
        "gateway logs exclude telemetry content",
      );
    await wait(async () => {
      const { rows } = await litePool.query(
        'SELECT count(*)::int AS n, count(*) FILTER (WHERE to_jsonb(s)::text LIKE $1)::int AS body FROM "LiteLLM_SpendLogs" s',
        ["%" + inputMarker + "%"],
      );
      assert.equal(
        rows[0].body,
        0,
        "gateway spend rows do not contain prompt body",
      );
      return rows[0].n > 0;
    }, 35000);
    report.cases.push(
      "redacted Bash input/output in existing tool observation; excluded from product events and diagnostics; LiteLLM spend logs contain no prompt body",
    );
  }
  assert.equal(privacyRejected, 0);
  report.privacyRejected = privacyRejected;
  report.telemetryBatches = collected;
  report.hostSpans = queued.length;
  await api(`/sessions/${session.id}/close`, "POST", {
    expectedMessageId: messages.at(-1),
  });
  await wait(
    async () => (await api(`/sessions/${session.id}`)).environment === "closed",
  );
  report.passed = true;
  if (process.env.AH_TRACING_KEEP_OPEN === "1") {
    await writeFile(
      join(evidence, "browser-fixture.json"),
      JSON.stringify({
        origin,
        access,
        requestId: requests[0].id,
        sessionId: session.id,
      }),
      { mode: 0o600 },
    );
    console.log(
      "Isolated browser fixture ready; credentials in private evidence file",
    );
    await new Promise((r) => {
      process.once("SIGTERM", r);
      process.once("SIGINT", r);
    });
  }
} catch (e) {
  report.passed = false;
  report.stage = stage;
  report.privacyRejected = privacyRejected;
  report.error =
    e instanceof Error ? e.message.slice(0, 250) : "verification failed";
  // Container diagnostics stay private and must never be copied to the public report verbatim.
  try {
    await writeFile(
      join(evidence, "gateway-private.log"),
      docker("logs", gatewayName),
      { mode: 0o600 },
    );
  } catch {}
  process.exitCode = 1;
} finally {
  await manager?.shutdown().catch(() => {});
  await tracer?.close().catch(() => {});
  for (const s of [server, fixture?.server, collector, fault])
    if (s) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  await database?.close().catch(() => {});
  await litePool?.end().catch(() => {});
  await proxy?.close();
  for (const name of [gatewayName, pgName]) {
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  report.cleanupConfirmed = !docker("ps", "-a", "--format", "{{.Names}}")
    .split("\n")
    .some((n) => [gatewayName, pgName].includes(n));
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
}
