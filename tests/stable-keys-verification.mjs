/** Isolated LiteLLM + Docker/SDK; deterministic upstream, no vendor calls. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../dist/tests/pg.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
import { LlmService } from "../dist/src/service/llm/service.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { SessionManager } from "../dist/src/service/session-manager.js";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { createApi } from "../dist/src/service/http-api.js";
import { tokenHash } from "../dist/src/service/auth.js";
const gateway = process.env.AH_VERIFY_LITELLM_URL,
  master = process.env.AH_VERIFY_LITELLM_KEY;
if (!gateway || !master)
  throw Error(
    "Use disposable LiteLLM + PG and set AH_VERIFY_LITELLM_URL/KEY and AH_TEST_DATABASE_URL",
  );
const evidence = resolve(
  process.env.AH_EVIDENCE_DIR ?? "var/evidence/stable-llm-keys/2026-10-28",
);
await mkdir(evidence, { recursive: true });
const root = join(evidence, "runtime-" + Date.now()),
  db = await testDatabase();
const upstream = fixtureModel([
  {
    name: "Bash",
    input: {
      command: "sleep 4; printf stable-key-ok > /workspace/stable-key.txt",
      timeout: 20000,
    },
  },
]);
await new Promise((r) => upstream.server.listen(0, "0.0.0.0", r));
const llm = new LlmService(db.db, join(root, ".service"), {
  managementUrl: gateway,
  inferenceUrl: gateway.replace("127.0.0.1", "host.docker.internal"),
  masterKey: master,
});
const store = new ServiceStore(db.db),
  controller = new Controller(root, {
    ...defaultProfile,
    image: process.env.AH_VERIFY_IMAGE ?? "agent-harbor:0.6.2",
    timeoutMs: 90000,
  });
const manager = new SessionManager(store, controller, "unused", 120000, 4);
const owner = "stable-key-fixture",
  access = "fixture-" + randomUUID();
await manager.identity.importKeys([
  { userId: owner, tokenHash: tokenHash(access) },
]);
const server = createApi(
  manager,
  controller,
  undefined,
  { adminUsers: [owner] },
  undefined,
  undefined,
  undefined,
  llm,
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
async function api(path, method = "GET", body) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + access,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  assert(r.ok, JSON.stringify({ path, status: r.status, value }));
  return value;
}
async function inference(c) {
  return fetch(gateway + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": c.token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: c.model,
      max_tokens: 100,
      messages: [{ role: "user", content: "credential probe" }],
    }),
  });
}
async function denied(c) {
  const n = upstream.requests.length,
    r = await inference(c);
  await r.text();
  assert(
    [401, 403].includes(r.status),
    "revoked credential must fail auth: " + r.status,
  );
  assert.equal(
    upstream.requests.length,
    n,
    "revoked request never reaches upstream",
  );
  return r.status;
}
const results = { checks: [], rounds: [] };
try {
  const provider = await llm.addProvider({
    name: "Stable fixture",
    format: "anthropic_compatible",
    apiBase: "http://host.docker.internal:" + upstream.server.address().port,
    apiKey: "fixture-only",
  }, owner);
  const created = await llm.createDeployment({
    providerId: provider.id,
    name: "Stable model",
    upstreamModel: "fixture",
    tools: true,
    streaming: true,
  }, owner);
  const model = { id: created.deployment.id, versionId: created.versions[0].id, alias: created.versions[0].routeName };
  const session = await api("/sessions", "POST", {
    title: "Stable keys",
    deploymentId: model.id,
  });
  const c = await llm.runtime(session);
  assert.equal((await llm.client.keyInfo(c.token)).info.expires, null);
  // Warm authentication cache, then turn it into a legacy short-lived key.
  let response = await inference(c);
  assert.equal(response.status, 200);
  await response.text();
  await llm.client.request("/key/update", { key: c.token, duration: "1s" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await llm.client.keyInfo(c.token)).info.status, "expired");
  assert.deepEqual(await llm.runtime(session), c);
  assert.equal((await llm.client.keyInfo(c.token)).info.expires, null);
  results.checks.push("already expired legacy key migrated without changing token");
  await llm.client.request("/key/update", { key: c.token, duration: "2s" });
  assert.notEqual((await llm.client.keyInfo(c.token)).info.expires, null);
  assert.deepEqual(await llm.runtime(session), c);
  assert.equal((await llm.client.keyInfo(c.token)).info.expires, null);
  results.checks.push("same-token legacy expiry removal with warm auth cache");
  const marker = "HISTORY_ONLY_" + randomUUID();
  for (let round = 0; round < 2; round++) {
    const started = Date.now(),
      before = upstream.requests.length;
    const { message } = await api(
      "/sessions/" + session.id + "/messages",
      "POST",
      {
        clientMessageId: randomUUID(),
        text: round
          ? "Continue our previous conversation"
          : "Remember " + marker + " and execute the requested tool.",
      },
    );
    let detail;
    for (let i = 0; i < 360; i++) {
      detail = await api("/sessions/" + session.id);
      if (
        !["accepted", "running", "finalizing", "reconciling"].includes(
          detail.message?.status,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(detail.message?.id, message.id);
    assert.equal(
      detail.message.status,
      "succeeded",
      JSON.stringify(detail.message),
    );
    const runtime = JSON.parse(
      await readFile(join(root, session.id, "session.json"), "utf8"),
    );
    assert.deepEqual(await llm.runtime(detail), c);
    const snapshot = {
      round,
      containerId: runtime.containerId,
      runnerId: runtime.runnerId,
      sdkSessionId: runtime.sdkSessionId,
      requests: upstream.requests.length - before,
      elapsedMs: Date.now() - started,
    };
    if (round === 0) {
      assert(snapshot.elapsedMs >= 4000);
      assert(snapshot.requests >= 2);
      assert.equal(
        await readFile(
          join(root, session.id, "workspace/stable-key.txt"),
          "utf8",
        ),
        "stable-key-ok",
      );
    } else {
      for (const k of ["containerId", "runnerId", "sdkSessionId"])
        assert.equal(snapshot[k], results.rounds[0][k]);
      assert(JSON.stringify(upstream.requests.at(-1)).includes(marker));
    }
    results.rounds.push(snapshot);
  }
  results.checks.push(
    "one SDK turn crosses former 2s expiry with multiple model requests",
    "same Key/container/Runner/native session and history across turns",
  );
  await api("/sessions/" + session.id + "/close", "POST", {
    expectedMessageId: (await api("/sessions/" + session.id)).message.id,
  });
  for (let i = 0; i < 120; i++) {
    if ((await api("/sessions/" + session.id)).environment === "closed") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal((await api("/sessions/" + session.id)).environment, "closed");
  results.closeStatus = await denied(c);
  const isolated = await api("/sessions", "POST", {
      title: "Independent",
      deploymentId: model.id,
    }),
    other = await llm.runtime(isolated);
  response = await inference(other);
  assert.equal(response.status, 200);
  await response.text();
  results.checks.push(
    "environment close invalidates warmed key; independent key remains usable",
  );
  await llm.updateDeployment(model.id, { enabled: false }, owner);
  results.modelDisableStatus = await denied(other);
  await llm.updateDeployment(model.id, { enabled: true }, owner);
  const userSession = await api("/sessions", "POST", {
      title: "Disable user",
      deploymentId: model.id,
    }),
    userKey = await llm.runtime(userSession);
  await manager.identity.update(owner, { disabled: true });
  await manager.closeUser(owner);
  results.userDisableStatus = await denied(userKey);
  await assert.rejects(() => llm.runtime(userSession));
  results.checks.push(
    "model disable and user disable deny subsequent direct inference",
  );
  results.passed = true;
  await writeFile(
    join(evidence, "stable-key-result.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await manager.shutdown().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  try {
    await llm.recover();
  } finally {
    upstream.server.closeAllConnections();
    await new Promise((r) => upstream.server.close(r));
    await db.close();
  }
}
