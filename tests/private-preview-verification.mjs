/** Run only in a disposable Linux machine with a separate Docker daemon. See the runtime provider spec. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile, copyFile, cp, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { AppDockerDriver } from "../dist/src/service/applications/docker.js";
import { DockerPreviewProvider } from "../dist/src/docker/preview-provider.js";
import { OpenSandboxPreviewProvider } from "../dist/src/opensandbox/preview-provider.js";
import { stopAndRemove } from "../dist/src/runtime/providers/contracts.js";
import { verifyPreview } from "../dist/src/runtime/providers/preview.js";

const { Sandbox, SandboxManager, ConnectionConfig } = await import("@alibaba-group/opensandbox");
assert.equal(process.platform, "linux");
assert.equal(process.env.AH_PRIVATE_PREVIEW_DISPOSABLE, "1");
const root = resolve(process.env.AH_PREVIEW_PROBE_ROOT ?? "preview-run");
await mkdir(root, { mode: 0o700 }); // Exclusive evidence and mount root for this run.
await mkdir(join(root, "runtime"), { mode: 0o700 });
await mkdir(join(root, "edge"), { mode: 0o700 });
const driver = new AppDockerDriver(root);
const docker = args => driver.command(args, 90_000);
const suffix = randomUUID().slice(0, 8);
const network = "preview-backend-" + suffix, clientNetwork = "preview-client-" + suffix;
const db = "preview-db-" + suffix, caddy = "preview-edge-" + suffix;
const image = "harbor-private-preview:" + suffix;
const appId = randomUUID(), basePath = `/preview/${appId}/`;
const owner = randomBytes(32).toString("hex"), other = randomBytes(32).toString("hex");
const apiKey = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("hex");
const adminPassword = randomBytes(24).toString("hex");
const auth = createServer((req, res) => {
  const cookie = req.headers.cookie;
  res.writeHead(cookie === "preview=" + owner ? 204 : cookie === "preview=" + other ? 403 : 401).end();
});
async function listening(server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  const port = await listening(server);
  await new Promise(done => server.close(done));
  return port;
}
async function wait(fn) {
  let failure;
  for (let n = 0; n < 70; n++) {
    try { return await fn(); } catch (error) { failure = error; }
    await new Promise(done => setTimeout(done, 200));
  }
  throw failure;
}
async function inspectContainer(name) {
  return JSON.parse(await docker(["inspect", name]))[0];
}
const authPort = await listening(auth), edgePort = await freePort(), adminPort = await freePort();
const controlPort = await freePort(), control = new URL(`http://127.0.0.1:${controlPort}`);
const connectionConfig = new ConnectionConfig({
  domain: control.host, apiKey, useServerProxy: true, endpointCacheDisabled: true,
  requestTimeoutSeconds: 5, disableMetrics: true,
});
const manager = SandboxManager.create({ connectionConfig });
const sandboxClient = {
  async create({ image, configPath, metadata }) {
    const sandbox = await Sandbox.create({
      connectionConfig, image, metadata, entrypoint: ["node", "/app/server.cjs"],
      volumes: [{ name: "harbor-config", host: { path: configPath }, mountPath: "/run/harbor-app.json", readOnly: true }],
      resource: { cpu: "1", memory: "512Mi" }, timeoutSeconds: 300,
    });
    try { return sandbox.id; } finally { await sandbox.close(); }
  },
  kill: id => manager.killSandbox(id),
  async endpoint(id, port) {
    const sandbox = await Sandbox.connect({ sandboxId: id, connectionConfig });
    try { return new URL(await sandbox.getEndpointUrl(port)); } finally { await sandbox.close(); }
  },
};
const dockerProvider = new DockerPreviewProvider(driver, network);
const openProvider = new OpenSandboxPreviewProvider(sandboxClient, driver, join(root, "runtime"), control);
const created = [];
const checks = [];
let sandboxServer;
let sandboxLog;
const pass = name => { checks.push(name); console.log("PASS " + name); };

async function configureEdge(target) {
  const file = join(root, "edge/Caddyfile");
  const prefix = target?.url.pathname.replace(/\/$/, "") ?? "";
  await writeFile(file, `{
    admin 127.0.0.1:${adminPort}
    auto_https off
}
:${edgePort} {
    route ${basePath}* {
        forward_auth 127.0.0.1:${authPort} {
            uri /verify
        }
        ${target ? `reverse_proxy ${target.url.host} {
            ${prefix ? `rewrite ${prefix}{uri}` : ""}
            header_up -Cookie
            header_up -Authorization
            header_up -X-Harbor-*
            header_up -OPEN-SANDBOX-API-KEY
            header_down -Set-Cookie
        }` : "respond 404"}
    }
    respond 404
}
`, { mode: 0o600 });
}

function call(path = "", token = owner, method = "GET") {
  return fetch(`http://127.0.0.1:${edgePort}${basePath}${path}`, {
    method, headers: token ? { Cookie: "preview=" + token } : {},
    signal: AbortSignal.timeout(4000),
  });
}
async function publish(target) {
  await configureEdge(target);
  await docker(["exec", caddy, "caddy", "reload", "--config", "/edge/Caddyfile", "--adapter", "caddyfile"]);
}
async function checkRoute(launch) {
  const health = await call("__harbor/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { buildId: launch.build.id, deploymentId: launch.deploymentId });
  assert.equal((await call("", "")).status, 401);
  assert.equal((await call("", other)).status, 403);
  assert.equal((await call("asset.js", "")).status, 401);
  assert.equal((await call("value", other, "POST")).status, 403);
  const page = await call();
  assert.match(await page.text(), /Private preview/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.match(await (await call("asset.js")).text(), /previewAsset/);
}
async function checkSocket(token = owner, authorized = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${edgePort}${basePath}socket`, {
    headers: token ? { Cookie: "preview=" + token } : {},
  });
  try {
    const result = await Promise.race([
      once(socket, authorized ? "message" : "error"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket timeout")), 4500).unref()),
    ]);
    if (authorized) assert.equal(result[0].data, "ok");
  } finally { socket.close(); }
}
async function create(provider, build, databaseUrl) {
  const launch = { build, databaseUrl, deploymentId: randomUUID() };
  created.push({ provider, launch });
  const ref = await provider.create(launch);
  assert.deepEqual(await provider.findOwned(launch.deploymentId), [ref]);
  const endpoint = await provider.resolvePrivateEndpoint(ref);
  await verifyPreview(endpoint, launch);
  return { launch, ref, endpoint };
}
async function terminate(provider, ref) {
  await stopAndRemove(provider, ref);
  assert.equal(await provider.inspect(ref), "absent");
  await stopAndRemove(provider, ref);
}
async function outside(target, expected) {
  // Separate Docker bridge; the tester is neither on the backend network nor on the host.
  await docker(["run", "--pull=never", "--rm", "--network", clientNetwork,
    "node:24.19.0-bookworm-slim", "node", "-e",
    "fetch(process.argv[1], {signal:AbortSignal.timeout(2000)}).then(r=>{if(String(r.status)!==process.argv[2])process.exit(1)},()=>{if(process.argv[2]!=='blocked')process.exit(1)})",
    target, expected]);
}
async function startOpenSandbox() {
  const config = join(root, "opensandbox.toml");
  await writeFile(config, `[server]
host = "127.0.0.1"
port = ${controlPort}
api_key = "${apiKey}"
max_sandbox_timeout_seconds = 600
[runtime]
type = "docker"
execd_image = "${process.env.AH_PREVIEW_EXECD_IMAGE}"
[storage]
allowed_host_paths = ["${join(root, "runtime")}"]
[store]
type = "sqlite"
path = "${join(root, "opensandbox.db")}"
[docker]
network_mode = "${network}"
publish_host = "127.0.0.1"
port_range_min = 48000
port_range_max = 48199
drop_capabilities = ["ALL"]
no_new_privileges = true
pids_limit = 128
[proxy]
resolve_internal = true
[ingress]
mode = "direct"
`, { mode: 0o600 });
  sandboxLog ??= await open(join(root, "opensandbox.log"), "a", 0o600);
  sandboxServer = spawn(process.env.AH_OPENSANDBOX_SERVER, ["--config", config], {
    stdio: ["ignore", sandboxLog.fd, sandboxLog.fd],
  });
  await wait(async () => {
    assert.equal(sandboxServer.exitCode, null, "OpenSandbox process exited");
    await manager.listSandboxInfos({ pageSize: 1 });
  });
}
async function stopOpenSandbox(signal = "SIGTERM") {
  if (sandboxServer && sandboxServer.exitCode === null && sandboxServer.signalCode === null) {
    const exited = once(sandboxServer, "exit");
    sandboxServer.kill(signal);
    await exited;
  }
}
async function assembleImage() {
  const context = join(root, "app");
  await mkdir(join(context, "node_modules"), { recursive: true });
  await copyFile(new URL("./fixtures/private-preview.cjs", import.meta.url), join(context, "server.cjs"));
  for (const name of ["pg", "pg-pool", "pg-protocol", "pg-types", "pgpass", "pg-connection-string",
    "postgres-array", "postgres-bytea", "postgres-date", "postgres-interval", "pg-int8", "split2", "xtend"]) {
    await cp(resolve("node_modules", name), join(context, "node_modules", name), { recursive: true });
  }
  await writeFile(join(context, "Dockerfile"), `FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY . .
USER node
ENTRYPOINT ["node", "/app/server.cjs"]
`);
  await docker(["build", "--pull=false", "-t", image, context]);
  return driver.imageId(image);
}

let successful = false;
try {
  assert.ok(process.env.AH_OPENSANDBOX_SERVER);
  assert.ok(process.env.AH_PREVIEW_EXECD_IMAGE);
  for (const name of [network, clientNetwork]) await docker(["network", "create", name]);
  const clientGateway = (JSON.parse(await docker(["network", "inspect", clientNetwork])))[0].IPAM.Config[0].Gateway;
  await docker(["run", "--pull=never", "-d", "--network", network, "--name", db,
    "-e", "POSTGRES_PASSWORD=" + adminPassword, "-e", "POSTGRES_DB=preview", "postgres:18-alpine"]);
  // The init phase briefly starts a socket-only server before creating the database.
  await wait(() => docker(["exec", db, "pg_isready", "-h", "127.0.0.1", "-d", "preview"]));
  await docker(["exec", db, "psql", "-U", "postgres", "-d", "preview", "-v", "ON_ERROR_STOP=1",
    "-c", `create table preview_probe(value int not null); insert into preview_probe values (0);
      create role preview_app login password '${password}'; grant select, update on preview_probe to preview_app;`]);
  const databaseUrl = `postgres://preview_app:${password}@${db}/preview`;
  const build = { id: randomUUID(), appId, revisionId: randomUUID(), target: "preview",
    basePath, imageId: await assembleImage() };
  await configureEdge(null);
  await docker(["run", "--pull=never", "-d", "--name", caddy, "--network", "host",
    "--mount", `type=bind,src=${join(root, "edge")},dst=/edge,readonly`,
    "caddy:2-alpine", "caddy", "run", "--config", "/edge/Caddyfile", "--adapter", "caddyfile"]);
  await wait(async () => assert.equal((await call()).status, 404));

  const original = await create(dockerProvider, build, databaseUrl);
  await publish(original.endpoint);
  await checkRoute(original.launch);
  await checkSocket();
  assert.equal(await (await call("value", owner, "POST")).text(), "1");
  await outside(`http://${clientGateway}:${edgePort}${basePath}`, "401");
  const dockerState = await inspectContainer(original.ref.resourceId);
  const dockerIp = dockerState.NetworkSettings.Networks[network].IPAddress;
  await outside(`http://${dockerIp}:3000${basePath}`, "blocked");
  await outside(`http://${clientGateway}:${original.endpoint.url.port}${basePath}`, "blocked");
  pass("Docker private preview, owner-only access, static assets, WebSocket and direct-network denial");

  await publish(null);
  await terminate(dockerProvider, original.ref);
  await startOpenSandbox();
  const sandbox = await create(openProvider, build, databaseUrl);
  await assert.rejects(() => openProvider.remove(sandbox.ref));
  await assert.rejects(() => verifyPreview(sandbox.endpoint, {
    ...sandbox.launch, deploymentId: randomUUID(),
  }), /PREVIEW_HEALTH_IDENTITY_MISMATCH/);
  await publish(sandbox.endpoint);
  await checkRoute(sandbox.launch);
  await checkSocket();
  await checkSocket("", false);
  assert.equal(await (await call("value")).text(), "1");
  assert.equal(await (await call("value", owner, "POST")).text(), "2");
  const [sandboxContainer] = (await docker(["ps", "-q", "--filter",
    "label=opensandbox.io/id=" + sandbox.ref.resourceId])).split("\n");
  const sandboxState = await inspectContainer(sandboxContainer);
  const sandboxIp = sandboxState.NetworkSettings.Networks[network].IPAddress;
  assert.ok(sandboxIp);
  assert.equal(sandboxState.HostConfig.Privileged, false);
  assert.ok(sandboxState.HostConfig.CapDrop.includes("ALL"));
  assert.ok(sandboxState.HostConfig.SecurityOpt.some(option => option.startsWith("no-new-privileges")));
  assert.equal(sandboxState.Config.User, "node");
  await outside(`http://${sandboxIp}:3000${basePath}`, "blocked");
  await outside(`http://${clientGateway}:${controlPort}${sandbox.endpoint.url.pathname}`, "blocked");
  for (const ports of Object.values(sandboxState.NetworkSettings.Ports)) {
    for (const binding of ports ?? []) {
      assert.equal(binding.HostIp, "127.0.0.1");
      await outside(`http://${clientGateway}:${binding.HostPort}/`, "blocked");
    }
  }
  // In single-tenant mode the internal data proxy deliberately skips API-key auth.
  // Prove both the risk and the network boundary; the authenticated edge is mandatory.
  assert.equal((await fetch(sandbox.endpoint.url.href + basePath)).status, 200);
  assert.equal((await fetch(control.origin + "/v1/sandboxes")).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${edgePort}${sandbox.endpoint.url.pathname}${basePath}`)).status, 404);
  pass("OpenSandbox private preview, same build and PostgreSQL state; management and direct ports denied");

  await stopOpenSandbox("SIGKILL");
  assert.equal(await openProvider.inspect(sandbox.ref), "running");
  await assert.rejects(() => openProvider.stopAndConfirm(sandbox.ref));
  assert.equal(await openProvider.inspect(sandbox.ref), "running");
  assert.equal((await call()).status, 502);
  await startOpenSandbox();
  await checkRoute(sandbox.launch);
  pass("Management loss does not prove stop; restored server reuses the same healthy preview");

  await publish(null);
  assert.equal((await call()).status, 404);
  await terminate(openProvider, sandbox.ref);
  const fallback = await create(dockerProvider, build, databaseUrl);
  await publish(fallback.endpoint);
  await checkRoute(fallback.launch);
  await checkSocket();
  assert.equal(await (await call("value")).text(), "2");
  assert.equal(await (await call("value", owner, "POST")).text(), "3");
  pass("Same URL and data after explicit OpenSandbox to Docker rollback; old sandbox absent");
  successful = true;
} finally {
  const cleanup = await Promise.allSettled(created.reverse().map(async ({ provider, launch }) => {
    for (const ref of await provider.findOwned(launch.deploymentId)) await terminate(provider, ref);
  }));
  await manager.close();
  await stopOpenSandbox();
  await sandboxLog?.close();
  auth.closeAllConnections();
  auth.close();
  for (const resource of [caddy, db]) await docker(["rm", "-f", "-v", resource]).catch(() => {});
  await docker(["image", "rm", image]).catch(() => {});
  const networks = await Promise.allSettled([network, clientNetwork].map(name => docker(["network", "rm", name])));
  const cleaned = [...cleanup, ...networks].every(result => result.status === "fulfilled");
  await writeFile(join(root, "result.json"), JSON.stringify({ successful, cleaned, checks, realModelRequests: 0 }, null, 2) + "\n");
  assert.ok(cleaned, "Preview probe cleanup could not be confirmed");
}
