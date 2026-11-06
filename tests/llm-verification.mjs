/** Real LiteLLM + PostgreSQL + Docker/SDK, deterministic local model endpoints; no vendor charges. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
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
const evidence = resolve(
  process.env.AH_EVIDENCE_DIR ?? "var/evidence/llm-gateway/2026-10-27",
);
const root = join(evidence, "runtime-" + Date.now());
await mkdir(root, { recursive: true });
const gateway = process.env.AH_VERIFY_LITELLM_URL;
if (!gateway)
  throw Error("Set AH_VERIFY_LITELLM_URL to an isolated local LiteLLM");
const master = process.env.AH_VERIFY_LITELLM_KEY;
if (!master) throw Error("Set AH_VERIFY_LITELLM_KEY");
const plan = (name) => [
  { name: "Read", input: { file_path: "/workspace/source.txt" } },
  {
    name: "Write",
    input: { file_path: "/workspace/output.txt", content: name + "\n" },
  },
  {
    name: "Bash",
    input: {
      command: `test "$(cat /workspace/output.txt)" = "${name}" && printf verified`,
      timeout: 20000,
    },
  },
];
const native = fixtureModel(plan("native-target")),
  chatRequests = [];
const chat = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    chatRequests.push(body);
    const count = (body.messages ?? []).filter((m) => m.role === "tool").length;
    const call = plan("chat-target")[count],
      id = "chatcmpl-" + randomUUID(),
      usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const base = {
      id,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: call ? null : "FIXTURE_DONE",
                ...(call
                  ? {
                      tool_calls: [
                        {
                          id: "call_" + count,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: JSON.stringify(call.input),
                          },
                        },
                      ],
                    }
                  : {}),
              },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (choices, u) =>
      res.write(
        "data: " +
          JSON.stringify({
            ...base,
            object: "chat.completion.chunk",
            choices,
            ...(u ? { usage: u } : {}),
          }) +
          "\n\n",
      );
    send([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
    send([
      {
        index: 0,
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_" + count,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input),
                  },
                },
              ],
            }
          : { content: "FIXTURE_DONE" },
        finish_reason: null,
      },
    ]);
    send([
      { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
    ]);
    send([], usage);
    res.end("data: [DONE]\n\n");
  } catch {
    res.writeHead(500);
    res.end("{}");
  }
});
for (const server of [native.server, chat])
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
const db = await testDatabase(),
  controller = new Controller(root, {
    ...defaultProfile,
    image: process.env.AH_VERIFY_IMAGE ?? "agent-harbor:llm-verify",
    timeoutMs: 90000,
    interruptTimeoutMs: 10000,
  });
const manager = new SessionManager(
  new ServiceStore(db.db),
  controller,
  "no-legacy",
  60000,
  4,
);
const service = new LlmService(db.db, join(root, ".service"), {
  managementUrl: gateway,
  inferenceUrl: gateway.replace("127.0.0.1", "host.docker.internal"),
  masterKey: master,
});
const access = "fixture-" + randomUUID();
await manager.identity.importKeys([
  { userId: "gateway-test", tokenHash: tokenHash(access) },
]);
const server = createApi(
  manager,
  controller,
  undefined,
  { adminUsers: ["gateway-test"] },
  undefined,
  undefined,
  undefined,
  service,
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const api = async (path, method = "GET", body) => {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + access,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert(response.ok, JSON.stringify({ status: response.status, value }));
  return value;
};
const results = [];
let browser;
try {
  for (const [name, format, port, target] of [
    [
      "Native model",
      "anthropic_compatible",
      native.server.address().port,
      "native-target",
    ],
    ["Chat model", "openai_chat", chat.address().port, "chat-target"],
  ]) {
    const provider = await api("/admin/llm/providers", "POST", {
      name,
      format,
      apiBase: `http://host.docker.internal:${port}`,
      apiKey: "fixture-only-upstream",
    });
    const detail = await api("/admin/llm/deployments", "POST", {
      providerId: provider.id,
      name,
      upstreamModel: target,
      tools: true,
      streaming: true,
    });
    const model = {
      id: detail.deployment.id,
      versionId: detail.versions[0].id,
      alias: detail.versions[0].routeName,
      state: detail.versions[0].state,
    };
    assert.equal(model.state, "ready", "real LiteLLM model API read-back");
    const session = await api("/sessions", "POST", {
      title: name,
      deploymentId: model.id,
      clientRequestId: randomUUID(),
    });
    await writeFile(
      join(controller.store.directory(session.id), "workspace/source.txt"),
      "fixture-source\n",
    );
    await api(`/sessions/${session.id}/messages`, "POST", {
      clientMessageId: randomUUID(),
      text: "Read source.txt, write output.txt and run verification.",
    });
    let terminal;
    const until = Date.now() + 100000;
    while (Date.now() < until) {
      const detail = await api(`/sessions/${session.id}`);
      if (
        detail.message &&
        !["accepted", "running", "finalizing", "reconciling"].includes(
          detail.message.status,
        )
      ) {
        terminal = detail.message;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(terminal?.status, "succeeded", JSON.stringify(terminal));
    assert.equal(
      (
        await readFile(
          join(controller.store.directory(session.id), "workspace/output.txt"),
          "utf8",
        )
      ).trim(),
      target,
    );
    const detail = await api(`/sessions/${session.id}`);
    assert.equal(detail.modelSnapshot.deploymentId, model.id);
    const connection = await service.runtime(detail);
    const adminDenied = await fetch(gateway + "/key/generate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + connection.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ models: [] }),
    });
    assert.equal(
      adminDenied.status,
      403,
      "inference credential cannot create keys",
    );
    const denied = await fetch(gateway + "/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + connection.token,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "unauthorized-model",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      }),
    });
    assert(!denied.ok, "scoped key rejects arbitrary model");
    await api(`/sessions/${session.id}/close`, "POST", {
      expectedMessageId: terminal.id,
    });
    for (let i = 0; i < 160; i++) {
      if ((await api(`/sessions/${session.id}`)).environment === "closed")
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      (await api(`/sessions/${session.id}`)).environment,
      "closed",
      "close completion, not just HTTP acceptance",
    );
    const revoked = await fetch(gateway + "/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + connection.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.alias,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      }),
    });
    assert(!revoked.ok, "revoked key refuses calls");
    results.push({
      name,
      modelId: model.id,
      alias: model.alias,
      target,
      status: terminal.status,
      tools: ["Read", "Write", "Bash"],
      restrictedKey: true,
      revokedKey: true,
      usage: await api(`/sessions/${session.id}/llm-usage`),
    });
  }
  assert(native.requests.length >= 4);
  assert(native.requests.every((r) => r.model === "native-target"));
  assert(chatRequests.length >= 4);
  assert(chatRequests.every((r) => r.model === "chat-target"));
  if (process.env.AH_PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.AH_PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(origin);
    await page.getByPlaceholder("输入管理员提供的访问密钥").fill(access);
    await page.getByRole("button", { name: "登录工作台", exact: true }).click();
    await page.getByRole("link", { name: "模型与网关", exact: true }).click();
    await page
      .getByRole("heading", { name: "添加供应商", exact: true })
      .waitFor();
    await page.screenshot({
      path: join(evidence, "models-desktop.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "新建会话", exact: true })
      .first()
      .click();
    await page.getByRole("combobox", { name: "会话模型" }).click();
    await page
      .getByRole("option", { name: "Chat model · Chat model", exact: true })
      .click();
    await page
      .getByPlaceholder("例如：整理产品调研资料")
      .fill("Browser selected model");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "创建会话", exact: true })
      .click();
    await page.getByText("会话固定模型", { exact: false }).waitFor();
    await page.screenshot({
      path: join(evidence, "model-selected.png"),
      fullPage: true,
    });
    const selected = (await api("/sessions")).find(
      (s) => s.title === "Browser selected model",
    );
    assert.equal(selected.modelSnapshot.deploymentId, results[1].modelId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(evidence, "model-mobile.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    results.push({ browser: true, modelId: selected.modelSnapshot.deploymentId, errors });
  }
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(
      {
        realLiteLLM: true,
        version: "v1.106.1",
        realDockerSdk: true,
        realVendor: false,
        results,
        nativeRequests: native.requests.length,
        chatRequests: chatRequests.length,
      },
      null,
      2,
    ),
  );
  console.log(
    "LiteLLM native passthrough + Chat conversion, SDK Read/Write/Bash, isolation and revocation verified.",
  );
} finally {
  await browser?.close();
  await manager.shutdown().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
  for (const fixture of [native.server, chat]) {
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(() => r()));
  }
  await db.close();
}
