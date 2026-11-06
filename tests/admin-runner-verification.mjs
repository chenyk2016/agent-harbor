/** 实际Docker/原生SDK的观测验收；上游是确定性本地夹具，无付费请求。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
const evidence = resolve("var/evidence/admin-operations/2026-11-04"),
  root = resolve(evidence, "native-runner");
await mkdir(root, { recursive: true, mode: 0o700 });
const calls = [
  { name: "Bash", input: { command: "echo observed > /workspace/probe.txt" } },
];
const model = fixtureModel(calls),
  requestIds = [];
model.server.prependListener("request", (_req, res) => {
  const id = randomUUID();
  requestIds.push(id);
  res.setHeader("request-id", id);
});
await new Promise((r) => model.server.listen(0, "0.0.0.0", r));
const image =
  process.env.AH_ADMIN_RUNNER_IMAGE ?? "agent-harbor:admin-operations-v28";
const controller = new Controller(root, {
  ...defaultProfile,
  image,
  gatewayUrl: `http://host.docker.internal:${model.server.address().port}`,
  timeoutMs: 30000,
});
let conversation;
const events = [],
  results = [];
try {
  conversation = await controller.open("observation", "fixture-only");
  const first = await conversation.run("Run the configured command", (e) =>
    events.push(e),
  );
  assert.equal(first.status, "succeeded");
  results.push(first.status);
  calls.push({ name: "Read", input: { file_path: "/workspace/probe.txt" } });
  const second = await conversation.run("Read the file", (e) => events.push(e));
  assert.equal(second.status, "succeeded");
  results.push(second.status);
  for (const turn of [first, second]) {
    assert.ok(
      events.some(
        (e) => e.attemptId === turn.attemptId && e.type === "tool.started",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.attemptId === turn.attemptId &&
          e.type === "tool.finished" &&
          e.payload.outcome === "completed",
      ),
      JSON.stringify(
        events.map((e) => ({
          type: e.type,
          attempt: e.attemptId,
          payload: e.type.startsWith("tool.") ? e.payload : undefined,
        })),
      ),
    );
  }
  const links = events.filter((e) => e.type === "model.request.link");
  assert.ok(links.length > 0, "SDK did not expose request correlation");
  assert.ok(links.every((e) => requestIds.includes(e.payload.requestId)));
  const safe = events.filter((e) =>
    /^(tool\.|turn\.observed|agent\.(started|finished)|model\.request\.link)/.test(
      e.type,
    ),
  );
  assert.ok(!JSON.stringify(safe).includes("echo observed"));
  await writeFile(
    resolve(evidence, "runner-events.json"),
    JSON.stringify(safe, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    resolve(evidence, "runner-verification.json"),
    JSON.stringify(
      {
        passed: true,
        image,
        imageId: await controller.backend.imageId(image),
        turns: results,
        toolsFinished: safe.filter((e) => e.type === "tool.finished").length,
        requestLinks: links.length,
        realModelRequests: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Native Docker/SDK observation passed: two turns, tool starts/returns, exact request correlation; real model requests 0",
  );
} finally {
  await conversation?.close();
  for (const id of await controller.backend.forSession("observation")) {
    await controller.backend.stop(id);
    await controller.backend.destroy(id);
  }
  model.server.closeAllConnections();
  await new Promise((r) => model.server.close(r));
}
