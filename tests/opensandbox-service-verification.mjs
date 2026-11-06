/** Real service processes, Docker, Claude SDK and wallet. A local fixture replaces the vendor. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ServiceClient } from "../dist/src/clients/service-client.js";
import { DockerBackend } from "../dist/src/docker/docker.js";
import { tokenHash } from "../dist/src/service/auth.js";
import { openDatabase } from "../dist/src/service/db/client.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";

assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 1000);
assert.equal(process.env.AH_RESIDENT_TEST_DISPOSABLE, "1");
const root = process.env.AH_DATA_DIR;
assert.match(root, /^\/tmp\/harbor-service-test\.[a-zA-Z0-9]+$/);
const managerOrigin = new URL(process.env.AH_OPENSANDBOX_RUNNER_ORIGIN);
assert.equal(managerOrigin.hostname, "127.0.0.1");
const exec = promisify(execFile);
const docker = new DockerBackend(root);
const db = openDatabase();
const tokens = [randomUUID(), randomUUID()];
const users = ["runner-test-admin", "runner-test-peer"];
await mkdir(join(root, ".service"), { recursive: true, mode: 0o700 });
await writeFile(join(root, ".service/access-keys.json"), JSON.stringify(users.map((userId, i) =>
  ({ userId, tokenHash: tokenHash(tokens[i]) }))), { mode: 0o600 });

const actions = new Map();
const lastUser = body => body.messages?.filter(m => m.role === "user").at(-1)?.content;
const model = fixtureModel([], body => {
  const text = lastUser(body);
  const chunks = typeof text === "string" ? [text] : (text ?? []).filter(block => block.type === "text").map(block => block.text);
  if (Array.isArray(text) && text.some(block => block.type === "tool_result")) return;
  return [...actions].find(([prompt]) => chunks.some(chunk => chunk.includes(prompt)))?.[1];
});
const nativeMessages = model.server.listeners("request")[0];
model.server.removeAllListeners("request");
const keys = new Map(), models = new Map();
let holdInference = false;
model.server.on("request", async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const reply = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const credential = req.headers.authorization?.replace(/^Bearer /, "");
  if (url.pathname.startsWith("/v1/messages")) {
    if (keys.get(credential)?.status !== "active") return reply(401, {});
    if (holdInference && url.pathname === "/v1/messages") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      model.requests.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}\n\n');
      return;
    }
    return nativeMessages(req, res);
  }
  if (credential !== "fixture-master") return reply(401, {});
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  switch (url.pathname) {
    case "/model/info": return reply(200, { data: [...models.values()] });
    case "/model/new":
    case "/model/update": models.set(body.model_info.id, { ...models.get(body.model_info.id), ...body }); return reply(200, {});
    case "/key/info": {
      const entry = [...keys].find(([key]) => createHash("sha256").update(key).digest("hex") === url.searchParams.get("key"));
      return entry ? reply(200, { info: entry[1] }) : reply(404, {});
    }
    case "/key/generate":
    case "/key/update": keys.set(body.key, { ...keys.get(body.key), ...body, expires: null, status: "active" }); return reply(200, body);
    case "/key/delete":
      for (const key of body.keys) if (keys.has(key)) keys.get(key).status = "deleted";
      return reply(200, {});
    default: return reply(404, {});
  }
});
await new Promise(resolve => model.server.listen(0, "127.0.0.1", resolve));
const gateway = `http://127.0.0.1:${model.server.address().port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const pass = label => { checks.push(label); console.log("PASS", label); };
let child, a, b, deployment;
let serviceOutput = "";
async function until(check, reason, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await wait(75);
  }
  throw Error(reason + "\n" + serviceOutput.slice(-3000));
}
async function boot(backend) {
  assert.ok(!child);
  serviceOutput = "";
  child = spawn(process.execPath, ["dist/src/service/server.js"], {
    env: {
      ...process.env, AH_ADMIN_USERS: users[0], AH_SERVICE_PORT: "0", AH_RESIDENT_BACKEND: backend,
      AH_TASK_TIMEOUT_MS: "55000", AH_IDLE_TIMEOUT_MS: "120000", AH_INTERRUPT_TIMEOUT_MS: "3000",
      AH_INFERENCE_BIND_HOST: process.env.AH_INFERENCE_BIND_HOST,
      AH_LITELLM_MANAGEMENT_URL: gateway, AH_LITELLM_INFERENCE_URL: gateway, AH_LITELLM_MASTER_KEY: "fixture-master",
      AH_WALLET_INFERENCE_URL: `http://host.docker.internal:${process.env.AH_INFERENCE_PORT}/inference`,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { serviceOutput += chunk; });
  const url = await until(() => {
    if (child.exitCode !== null) throw Error(serviceOutput);
    return /Agent Harbor: (http:\/\/127\.0\.0\.1:\d+) \(ready\)/.exec(serviceOutput)?.[1];
  }, "Harbor failed to start");
  a = new ServiceClient(url, tokens[0]);
  b = new ServiceClient(url, tokens[1]);
}
async function stop(signal = "SIGKILL") {
  if (!child) return;
  const current = child;
  child = undefined;
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, "exit");
    current.kill(signal);
    await exited;
  }
}
async function configuredSession(client = a) {
  return client.request("/sessions", "POST", { title: "Isolated Runner", deploymentId: deployment });
}
const bash = command => ({ name: "Bash", input: { command, timeout: 45000 } });
async function runtime(id) { return JSON.parse(await readFile(join(root, id, "session.json"), "utf8")); }
const readWorkspace = (id, file) => readFile(join(root, id, "workspace", file), "utf8");
const submit = (id, prompt, client = a) => client.send(id, randomUUID(), prompt).then(result => result.message);
async function finished(id, message, expected = "succeeded", client = a) {
  return until(async () => {
    const current = (await client.session(id)).message;
    if (current?.id !== message.id || ["accepted", "running", "cancelling", "finalizing"].includes(current.status)) return;
    if (expected === "failed-or-interrupted")
      assert.ok(["failed", "interrupted", "reconciling"].includes(current.status), JSON.stringify(current));
    else assert.equal(current.status, expected, JSON.stringify(current));
    return current;
  }, "message did not finish");
}
async function engine(id, strict) {
  const label = strict ? "harbor.os.session" : "harbor.session";
  const ids = await docker.command(["ps", "-aq", "--filter", `label=${label}=${id}`]);
  return Promise.all(ids.split("\n").filter(Boolean).map(async id =>
    JSON.parse(await docker.command(["inspect", "--type", "container", id]))[0]));
}
async function spent() {
  const result = await db.pool.query(`SELECT count(*)::int AS entries, coalesce(-sum(amount),0)::int AS spent
    FROM wallet_ledger WHERE kind='usage'`);
  const requests = await db.pool.query(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE state='settled')::int AS settled FROM wallet_requests`);
  return { ...result.rows[0], ...requests.rows[0], upstream: model.requests.length };
}
async function paid() {
  return until(async () => {
    const state = await spent();
    assert.ok(state.calls <= state.upstream + 1, JSON.stringify(state));
    return state.entries === state.calls && state.settled === state.calls && state.upstream === state.calls &&
      state.spent === state.calls * 140 && state;
  }, "the real wallet did not settle exactly once per local model call");
}
async function duplicate(id, message, before) {
  const retry = await a.send(id, message.clientMessageId, message.text);
  assert.equal(retry.message.id, message.id);
  await wait(600);
  assert.deepEqual(await spent(), before, "recovery or duplicate message dispatched/charged again");
}
const writer = `import signal,time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
  with Path("/workspace/ticks").open("a") as file: file.write("tick\\n")
  time.sleep(.05)
`;
async function active(id, prompt) {
  await writeFile(join(root, id, "workspace/writer.py"), writer);
  actions.set(prompt, bash("python3 /workspace/writer.py"));
  const message = await submit(id, prompt);
  await until(async () => (await readWorkspace(id, "ticks").catch(() => "")).length > 20, "writer did not start");
  const [state] = await engine(id, true);
  assert.ok(state?.State.Running);
  return { message, container: state.Id, bill: await paid() };
}
async function confirmStopped(id, previous) {
  await until(async () => !(await engine(id, true)).some(c => c.State.Running), "old writer still running");
  const stopped = await readWorkspace(id, "ticks");
  await wait(800);
  assert.equal(await readWorkspace(id, "ticks"), stopped);
  assert.deepEqual(await spent(), previous.bill);
  return stopped;
}
const systemctl = (...args) => exec("sudo", ["-n", "systemctl", ...args], { timeout: 40000 });
try {
  await boot("docker");
  await a.request("/admin/wallet/gifts", "POST", { id: randomUUID(), userIds: users, amountYuan: 10, note: "isolated fixture" });
  const provider = await a.request("/admin/llm/providers", "POST", {
    name: "Local deterministic provider", apiBase: "https://example.invalid", apiKey: "fixture-key", format: "anthropic",
  });
  const details = await a.request("/admin/llm/deployments", "POST", {
    name: "Local model", providerId: provider.id, upstreamModel: "fixture-model", tools: true, streaming: true,
    allowedUsers: users, price: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
  });
  deployment = details.deployment.id;
  const legacy = await configuredSession();
  actions.set("seed Docker", bash("printf retained > /workspace/legacy"));
  await finished(legacy.id, await submit(legacy.id, "seed Docker"));
  const seeded = await runtime(legacy.id);
  assert.equal((await engine(legacy.id, false)).length, 1);
  const billDocker = await paid();
  await stop();
  await boot("opensandbox");
  assert.deepEqual(await spent(), billDocker);
  assert.equal((await engine(legacy.id, false)).length, 0);
  await finished(legacy.id, await submit(legacy.id, "continue on OpenSandbox"));
  const [strict] = await engine(legacy.id, true);
  assert.ok(strict?.State.Running && strict.HostConfig.ReadonlyRootfs);
  assert.equal((await runtime(legacy.id)).sdkSessionId, seeded.sdkSessionId);
  const original = await active(legacy.id, "writer before switch back");
  await stop();
  await boot("docker");
  const frozen = await confirmStopped(legacy.id, original);
  assert.equal((await engine(legacy.id, true)).length, 0);
  await duplicate(legacy.id, original.message, original.bill);
  await finished(legacy.id, await submit(legacy.id, "continue back on Docker"));
  assert.equal((await runtime(legacy.id)).sdkSessionId, seeded.sdkSessionId);
  assert.equal(await readWorkspace(legacy.id, "legacy"), "retained");
  assert.equal(await readWorkspace(legacy.id, "ticks"), frozen);
  assert.equal((await engine(legacy.id, false)).length, 1);
  await paid();
  pass("01 service config Docker → OpenSandbox → Docker, legacy session preserved, interrupted submission not replayed");

  await stop("SIGTERM");
  await boot("opensandbox");
  for (const [name, unit] of [["manager", "harbor-runner-qualification"], ["engine", "docker"]]) {
    const session = await configuredSession();
    const before = await active(session.id, `writer before ${name} restart`);
    if (name === "manager") {
      await systemctl("kill", "--signal=SIGKILL", unit);
      await confirmStopped(session.id, before);
    }
    await systemctl("restart", unit);
    if (name === "manager") await until(async () => (await fetch(new URL("/health", managerOrigin)).catch(() => undefined))?.ok, "manager failed to restart");
    const stopped = await confirmStopped(session.id, before);
    await finished(session.id, before.message, "failed-or-interrupted");
    // Use the real startup reconciliation path even if loss detection raced the restart.
    await stop();
    await boot("opensandbox");
    assert.equal((await engine(session.id, true)).length, 0);
    await duplicate(session.id, before.message, before.bill);
    const next = await submit(session.id, `explicit new input after ${name}`);
    await finished(session.id, next);
    await a.close(session.id, next.id);
    assert.equal(await readWorkspace(session.id, "ticks"), stopped);
    await paid();
    pass(`0${name === "manager" ? 2 : 3} ${name} restart stops old writer, no model replay or duplicate wallet entry`);
  }

  const left = await configuredSession(a), right = await configuredSession(b);
  actions.set("write tenant A marker", bash("printf private-a > /workspace/private-a"));
  const leftMessage = await submit(left.id, "write tenant A marker");
  await finished(left.id, leftMessage);
  const [victim] = await engine(left.id, true);
  assert.ok(victim?.State.Running);
  actions.set("tenant B isolation probe", bash(
    `test ! -e /workspace/private-a && test ! -e /proc/1/root/workspace/private-a && test ! -S /platform/bridge/runner.sock && test ! -e ${root}/${left.id}/workspace/private-a && printf independent > /workspace/peer`,
  ));
  const rightMessage = await submit(right.id, "tenant B isolation probe", b);
  await finished(right.id, rightMessage, "succeeded", b);
  assert.equal(await readWorkspace(right.id, "peer"), "independent");
  const [peer] = await engine(right.id, true);
  for (const destination of ["/workspace", "/platform/state", "/platform/run", "/platform/bridge", "/dependency-cache"])
    assert.notEqual(victim.Mounts.find(m => m.Destination === destination).Source,
      peer.Mounts.find(m => m.Destination === destination).Source);
  const bill = await paid();
  const peerWallet = await b.request("/wallet");
  assert.equal(peerWallet.requests.length, 2);
  assert.ok(peerWallet.requests.every(request => request.userId === users[1] && request.sessionId === right.id));
  for (const [path, method] of [
    [`/sessions/${left.id}/files/download?path=private-a`, "GET"],
    [`/sessions/${left.id}/messages`, "POST"],
    [`/sessions/${left.id}/messages/${leftMessage.id}/cancel`, "POST"],
    [`/sessions/${left.id}`, "DELETE"],
  ]) {
    await assert.rejects(b.request(path, method, method === "POST" ? {} : undefined), { status: 404 });
  }
  const port = victim.NetworkSettings.Ports["44772/tcp"][0].HostPort;
  assert.equal((await fetch(`http://127.0.0.1:${port}/ping`)).status, 401);
  const [victimAddress] = Object.values(victim.NetworkSettings.Networks).map(network => network.IPAddress);
  await docker.command(["exec", peer.Id, "node", "-e", `
    const { connect } = require("node:net");
    const connection = connect(44772, process.argv[1]);
    connection.on("connect", () => process.exit(9));
    connection.on("error", () => process.exit(0));
    connection.setTimeout(1000, () => process.exit(0));
  `, victimAddress]);
  assert.equal((await engine(left.id, true))[0].Id, victim.Id);
  assert.deepEqual(await spent(), bill);
  await a.close(left.id, leftMessage.id);
  await b.close(right.id, rightMessage.id);
  pass("04 cross-tenant file, process, bridge, API and wallet checks with two live native Runners");

  const cancelSession = await configuredSession();
  const cancelled = await active(cancelSession.id, "explicit cancellation");
  await a.cancel(cancelSession.id, cancelled.message.id);
  await finished(cancelSession.id, cancelled.message, "cancelled");
  await confirmStopped(cancelSession.id, cancelled);
  assert.equal((await engine(cancelSession.id, true)).length, 0);
  await duplicate(cancelSession.id, cancelled.message, cancelled.bill);
  pass("05 explicit cancellation stops a writer that ignores SIGTERM and duplicate submit does not charge");

  const inFlight = await configuredSession();
  await finished(inFlight.id, await submit(inFlight.id, "establish a paid session"));
  const settled = await paid();
  holdInference = true;
  const pending = await submit(inFlight.id, "crash during paid model response");
  await until(() => model.requests.length === settled.upstream + 1, "in-flight model request never dispatched");
  await stop();
  holdInference = false;
  await boot("opensandbox");
  assert.equal((await a.session(inFlight.id)).message.status, "interrupted");
  const unknown = await db.pool.query(`SELECT state, charged FROM wallet_requests WHERE "sessionId"=$1 AND state='unknown'`, [inFlight.id]);
  assert.equal(unknown.rowCount, 1);
  assert.equal(Number(unknown.rows[0].charged), 0);
  const expected = { ...settled, calls: settled.calls + 1, upstream: settled.upstream + 1 };
  assert.deepEqual(await spent(), expected);
  await duplicate(inFlight.id, pending, expected);
  pass("06 host crash after model dispatch leaves one unresolved request and never replays or charges it again");
} finally {
  await stop("SIGTERM");
  const totals = await spent().catch(() => undefined);
  await db.close();
  model.server.closeAllConnections();
  await new Promise(resolve => model.server.close(resolve));
  await writeFile(join(root, "verification.json"), JSON.stringify({ checks, totals, realModelCalls: 0 }, null, 2));
  if (checks.length !== 6) console.error(serviceOutput.slice(-5000));
}
