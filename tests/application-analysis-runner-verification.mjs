/** Actual Docker and the pinned Claude SDK; every model request is answered by a local fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DockerBackend } from "../dist/src/docker/docker.js";
import { runAnalysis } from "../dist/src/runtime/app-analysis.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";

const image = process.env.AH_ANALYSIS_TEST_IMAGE ?? "agent-harbor:delivery-v29";
const id = randomUUID();
const docker = new DockerBackend(`/analysis-probe-${id}`);
const calls = [
  { name: "Bash", input: { command: "echo forbidden" } },
  { name: "Write", input: { file_path: "/tmp/forbidden", content: "forbidden" } },
  { name: "WebFetch", input: { url: "https://example.com", prompt: "read" } },
  { name: "mcp__other__read", input: {} },
  { name: "mcp__app_data__read_report", input: { days: 7, section: "overview" } },
];
const model = fixtureModel(calls);
model.server.listen(0, "127.0.0.1");
await once(model.server, "listening");
let toolCalls = 0, answer = "", checked = false;
try {
  await runAnalysis(docker, {
    sessionId: id, messageId: id, image, prompt: "Read the report", model: "claude-haiku-4-5",
    signal: AbortSignal.timeout(50_000),
    infer: async (path, body, headers, signal) => {
      if (!checked) {
        checked = true;
        const state = JSON.parse(await docker.command(["inspect", `ah-${id}`]))[0];
        assert.equal(state.HostConfig.NetworkMode, "none");
        assert.equal(state.HostConfig.ReadonlyRootfs, true);
        assert.equal(state.Mounts.length, 1);
        assert.equal(state.Mounts[0].RW, false);
        assert.equal(state.Mounts[0].Destination, "/platform/runtime/app-analysis");
        await docker.command(["exec", `ah-${id}`, "node", "-e", `
          const assert=require('node:assert/strict');
          assert.deepEqual(Object.keys(require('node:os').networkInterfaces()),['lo']);
          assert(!require('node:fs').existsSync('/var/run/docker.sock'));
          fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1000)})
            .then(()=>process.exit(3),()=>{});
        `]);
      }
      return fetch(`http://127.0.0.1:${model.server.address().port}${path}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal,
      });
    },
    tool: async (name, args) => {
      assert.equal(name, "read_report");
      toolCalls++;
      assert.deepEqual(args, { days: 7, section: "overview" });
      return { observed: 42 };
    },
    text: async (value) => { answer += value; },
    receipt: async () => {},
  });
  assert.equal(toolCalls, 1);
  assert.match(answer, /FIXTURE_DONE/);
  const exposed = model.requests[0].tools.map((tool) => tool.name);
  assert.deepEqual(exposed.sort(), ["mcp__app_data__list_datasets", "mcp__app_data__query_records", "mcp__app_data__read_report"]);
  const results = model.requests.at(-1).messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
  assert.equal(results.length, 5);
  assert.ok(results.slice(0, 4).every((result) => result.is_error));
  assert.match(JSON.stringify(results[4]), /"observed[^0-9]*42/);
  console.log("PASS actual SDK exposes only three app data tools; four forbidden calls rejected; Docker has no external interfaces or writable mounts");
} finally {
  model.server.closeAllConnections();
  await new Promise((resolve) => model.server.close(resolve));
  assert.equal(await docker.inspect(`ah-${id}`), undefined);
}
