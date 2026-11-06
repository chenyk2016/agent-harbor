/** Isolated app runtime profile. The fixture image is built from a local Node image, without RUN steps. */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applicationPreviewClient } from "../dist/src/opensandbox/client.js";
import { OpenSandboxPreviewProvider } from "../dist/src/opensandbox/preview-provider.js";
import { AppDockerDriver } from "../dist/src/service/applications/docker.js";
import { applicationRoutes } from "../dist/src/service/applications/edge.js";
import { stopAndRemove } from "../dist/src/runtime/providers/contracts.js";
import { applicationRuntimeAccess, applicationRuntimeHeader, verifyPreview } from "../dist/src/runtime/providers/preview.js";
import { residentFromEnvironment } from "../dist/src/service/config.js";

const root = process.env.AH_VERIFY_ROOT;
assert.match(root, /\/opensandbox-unified-test\.[a-zA-Z0-9]+\/data-/);
const settings = residentFromEnvironment();
assert.ok(settings);
const appRoot = join(root, ".applications");
const configRoot = join(appRoot, "opensandbox-preview");
const scope = createHash("sha256").update(root).digest("hex").slice(0, 16);
const docker = new AppDockerDriver(appRoot);
const client = applicationPreviewClient(settings.origin, settings.key, scope);
const provider = new OpenSandboxPreviewProvider(client, docker, configRoot, settings.origin, settings.key);
const buildRoot = join(root, "fixture-image");
await mkdir(buildRoot, { recursive: true });
await writeFile(join(buildRoot, "Dockerfile"), "FROM node:24.19.0-bookworm-slim\nLABEL harbor.app.runtime-access=v1\nCOPY runtime.mjs /app/harbor-runtime.mjs\nUSER node\n");
await writeFile(join(buildRoot, "runtime.mjs"), `
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const { basePath, deploymentId, buildId, runtimeAccess } = JSON.parse(readFileSync("/run/harbor-app.json"));
createServer((req, res) => {
  if (req.headers["x-app-runtime-access"] !== runtimeAccess) return res.writeHead(404).end();
  if (req.url === basePath + "__harbor/health") res.end(JSON.stringify({ deploymentId, buildId }));
  else if (req.url === basePath) res.end("APP_OK:" + deploymentId);
  else res.writeHead(404).end();
}).listen(3000, "0.0.0.0");
`);
const tag = "harbor-unified-app-test:" + randomUUID();
const refs = [];
const edge = "harbor-opensandbox-unified-edge-test";
let edgeStarted = false;
try {
  await docker.command(["build", "--pull=false", "--network=none", "-t", tag, buildRoot], 120000);
  const imageId = await docker.imageId(tag);
  const deployments = [];
  for (const target of ["preview", "production"]) {
    const appId = randomUUID(), deploymentId = randomUUID();
    const build = { id: randomUUID(), revisionId: "fixture", appId, target, imageId,
      basePath: `/${target === "preview" ? "preview" : "apps"}/${appId}/` };
    const launch = { build, deploymentId, databaseUrl: "unused-by-fixture" };
    const ref = await provider.create(launch);
    refs.push(ref);
    const endpoint = await provider.resolvePrivateEndpoint(ref);
    await verifyPreview(endpoint, launch);
    const request = new URL(endpoint.url);
    request.pathname += build.basePath;
    assert.equal(await (await fetch(request, { headers: endpoint.headers })).text(), "APP_OK:" + deploymentId);
    const state = await fetch(new URL("/v1/sandboxes/" + ref.resourceId, settings.origin),
      { headers: { "OPEN-SANDBOX-API-KEY": settings.key } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).expiresAt ?? null, null);
    deployments.push({ id: deploymentId, appId, build, container: "", hostPort: Number(settings.origin.port),
      environment: target, runtime: ref });
    console.log("PASS", target, "served by a private read-only OpenSandbox environment with manual lifecycle");
  }
  const routes = applicationRoutes(deployments, "127.0.0.1", undefined, undefined, Number(settings.origin.port), settings.key);
  for (const ref of refs) assert.match(JSON.stringify(routes), new RegExp(`/v1/sandboxes/${ref.resourceId}/proxy/3000`));
  assert.throws(() => applicationRoutes(deployments, "127.0.0.1", undefined, undefined, Number(settings.origin.port)));
  const caddy = join(root, "edge.json");
  await writeFile(caddy, JSON.stringify({
    admin: { disabled: true },
    apps: { http: { servers: { applications: { listen: ["127.0.0.1:8590"], routes } } } },
  }));
  await docker.command(["run", "-d", "--name", edge, "--network", "host",
    "--mount", `type=bind,src=${caddy},dst=/etc/caddy/harbor.json,readonly`,
    "caddy:2-alpine", "caddy", "run", "--config", "/etc/caddy/harbor.json"]);
  edgeStarted = true;
  const edgeOrigin = "http://127.0.0.1:8590";
  for (let i = 0; i < 40; i++) {
    if ((await fetch(edgeOrigin).catch(() => undefined)) !== undefined) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const deployment of deployments) {
    const response = await fetch(edgeOrigin + deployment.build.basePath);
    assert.equal(await response.text(), "APP_OK:" + deployment.id);
  }
  const victim = deployments[1], prefix = deployments[0].build.basePath;
  const raw = path => new Promise((resolve, reject) => {
    httpRequest(edgeOrigin, { path }, async response => {
      let body = "";
      for await (const chunk of response) body += chunk;
      resolve(body);
    }).on("error", reject).end();
  });
  for (const traversal of ["../", "%2e%2e/", "%2e%2e%2f", "%252e%252e%252f"]) {
    const escaped = prefix + traversal.repeat(8) + `v1/sandboxes/${victim.runtime.resourceId}/proxy/3000${victim.build.basePath}`;
    assert.ok(!(await raw(escaped)).includes("APP_OK:" + victim.id));
  }
  const containerFor = ref => docker.command(["ps", "-q", "--filter", "label=opensandbox.io/id=" + ref.resourceId]);
  const firstContainer = await containerFor(deployments[0].runtime);
  const peer = await containerFor(victim.runtime);
  const [peerState] = JSON.parse(await docker.command(["inspect", peer]));
  const [firstState] = JSON.parse(await docker.command(["inspect", firstContainer]));
  assert.notEqual(firstState.HostConfig.NetworkMode, peerState.HostConfig.NetworkMode);
  const peerIp = Object.values(peerState.NetworkSettings.Networks)[0].IPAddress;
  const peerPath = victim.build.basePath;
  const privateProxy = `http://host.docker.internal:${settings.origin.port}/v1/sandboxes/${victim.runtime.resourceId}/proxy/3000${peerPath}`;
  const firstCredential = applicationRuntimeAccess(settings.key, deployments[0].id);
  await docker.command(["exec", firstContainer, "node", "-e", `
    const assert = require("node:assert/strict");
    Promise.all(process.argv.slice(2).map(async url => {
      const headers = { "${applicationRuntimeHeader}": process.argv[1] };
      const body = await fetch(url, { headers, signal: AbortSignal.timeout(1000) }).then(r => r.text(), () => "");
      assert(!body.includes("APP_OK:"), "private peer application reachable from a sandbox: " + url);
    })).catch(error => { console.error(error); process.exitCode = 1; });
  `, firstCredential, `http://${peerIp}:3000${peerPath}`, privateProxy]);
  console.log("PASS Caddy routes both environments and containers cannot reach private peer application endpoints");

  // This process is launched only by the dedicated verification harness.
  assert.equal(process.env.AH_UNIFIED_TEST_MANAGER, "harbor-opensandbox-unified-test");
  await docker.command(["restart", process.env.AH_UNIFIED_TEST_MANAGER]);
  for (let i = 0; i < 60; i++) {
    if ((await fetch(new URL("/health", settings.origin)).catch(() => undefined))?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  for (const deployment of deployments) {
    assert.equal(await provider.inspect(deployment.runtime), "running");
    const response = await fetch(edgeOrigin + deployment.build.basePath);
    assert.equal(await response.text(), "APP_OK:" + deployment.id);
  }
  console.log("PASS application environments survive the isolated manager restart and retain their routes");
} finally {
  if (edgeStarted) await docker.command(["rm", "-f", edge]);
  for (const ref of refs) {
    await stopAndRemove(provider, ref);
    const networks = await docker.command(["network", "ls", "-q", "--filter", "label=harbor.os.app-network=" + ref.resourceId]);
    assert.equal(networks, "");
  }
  await docker.command(["image", "rm", tag]).catch(() => {});
  await client.close();
}
