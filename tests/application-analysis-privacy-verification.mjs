/** Verify the pinned LiteLLM Messages path with the production exporter in redacted mode and a local collector. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DockerBackend } from "../dist/src/docker/docker.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";

const dir = await mkdtemp(resolve("var/analysis-privacy-"));
const docker = new DockerBackend(dir);
const name = "ah-analysis-privacy-" + randomBytes(5).toString("hex");
const master = "sk-" + randomBytes(24).toString("hex");
const exports = [];
const collector = createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req));
  exports.push(req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
  res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
});
const { server: model, requests } = fixtureModel();
async function port(server) {
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  return server.address().port;
}
try {
  const [provider, sink] = await Promise.all([port(model), port(collector)]);
  const config = join(dir, "gateway.yaml");
  await writeFile(config, JSON.stringify({
    model_list: [{ model_name: "fixture", litellm_params: {
      model: "anthropic/claude-haiku-4-5", api_base: "http://host.docker.internal:" + provider, api_key: "fixture-only",
    } }],
    general_settings: { master_key: master },
  }));
  await docker.command(["run", "-d", "--name", name, "-p", "127.0.0.1::4000",
    "-e", "AH_LANGFUSE_HOST=http://host.docker.internal:" + sink,
    "-e", "AH_LANGFUSE_PUBLIC_KEY=fixture-public", "-e", "AH_LANGFUSE_SECRET_KEY=fixture-secret",
    "-e", "AH_LANGFUSE_CONTENT_MODE=redacted",
    "-v", config + ":/app/harbor.yaml:ro",
    "-v", resolve("infra/start-litellm.py") + ":/app/harbor-start.py:ro",
    "-v", resolve("infra/langfuse") + ":/app/harbor-observation:ro",
    "--entrypoint", "python", "ghcr.io/berriai/litellm:v1.106.1", "/app/harbor-start.py", "--port", "4000"]);
  const target = "http://" + await docker.command(["port", name, "4000/tcp"]);
  const wait = async (fn) => {
    for (let i = 0; i < 140; i++) {
      if (await fn()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Gateway probe timed out");
  };
  await wait(() => fetch(target + "/health/liveness").then(r => r.ok, () => false));
  async function send(marker, quiet, stream) {
    const response = await fetch(target + "/v1/messages", {
      method: "POST", headers: { authorization: "Bearer " + master, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", max_tokens: 64, stream, messages: [{ role: "user", content: marker }],
        ...(quiet ? { "no-log": true } : {}) }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
  }
  const ordinary = "VISIBLE_ORDINARY_REPORT_CONTROL";
  const silent = "PRIVATE_ANALYSIS_REPORT_MARKER";
  const silentStream = "PRIVATE_STREAM_ANALYSIS_REPORT_MARKER";
  await send(silent, true, false);
  await send(silentStream, true, true);
  await send(ordinary, false, false);
  await wait(() => exports.some(body => body.includes(ordinary)));
  // A later visible control reaching the same batch exporter proves the redacted mode is collecting requests.
  const barrier = "VISIBLE_ORDINARY_REPORT_BARRIER";
  await send(barrier, false, true);
  await wait(() => exports.some(body => body.includes(barrier)));
  assert.equal(requests.length, 4);
  assert.ok(!exports.some(body => body.includes(silent) || body.includes(silentStream)));
  const logs = await docker.command(["logs", name]);
  assert.ok(!logs.includes(silent) && !logs.includes(silentStream));
  console.log("PASS fixed LiteLLM redacted OTLP, normal positive controls visible, analysis JSON/SSE sentinels absent, local destinations only");
} finally {
  await docker.command(["rm", "-f", name]).catch(() => {});
  for (const server of [model, collector]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
