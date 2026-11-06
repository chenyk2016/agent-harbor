import test from "node:test";
import assert from "node:assert/strict";
import { llmSettings, resolveLlmSettings } from "../src/service/llm/client.js";

const gateway = {
  AH_LITELLM_MANAGEMENT_URL: "http://127.0.0.1:4320/",
  AH_LITELLM_INFERENCE_URL: "http://host.docker.internal:4320",
  AH_LITELLM_MASTER_KEY: "test-master-key",
};
const walletUrl = "http://host.docker.internal:4318/inference";

test("managed models and wallet start automatically when configured", () => {
  const env = { ...gateway, AH_WALLET_INFERENCE_URL: walletUrl };
  const resolved = resolveLlmSettings(env);
  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.allowLegacyGateway, false);
  assert.equal(resolved.settings?.managementUrl, "http://127.0.0.1:4320");
  assert.equal(resolved.settings?.walletProxyUrl, walletUrl);
  assert.equal(llmSettings(gateway)?.walletProxyUrl, undefined);
});

test("explicit disable still applies independently to gateway and wallet", () => {
  const env = { ...gateway, AH_WALLET_INFERENCE_URL: walletUrl };
  assert.deepEqual(resolveLlmSettings({ ...env, AH_LLM_ENABLED: "false" }), {
    missing: [],
    allowLegacyGateway: true,
  });
  const direct = resolveLlmSettings({ ...env, AH_WALLET_ENABLED: "false" });
  assert.ok(direct.settings);
  assert.equal(direct.settings.walletProxyUrl, undefined);
  assert.deepEqual(resolveLlmSettings({ AH_GATEWAY_TOKEN: "legacy" }), {
    missing: [],
    allowLegacyGateway: true,
  });
});

test("incomplete managed configuration cannot silently bypass wallet or gateway", () => {
  assert.deepEqual(resolveLlmSettings({ ...gateway, AH_WALLET_ENABLED: "true" }), {
    missing: ["AH_WALLET_INFERENCE_URL"],
    allowLegacyGateway: false,
  });
  const { AH_LITELLM_MASTER_KEY: unused, ...incomplete } = gateway;
  assert.deepEqual(resolveLlmSettings({ ...incomplete, AH_GATEWAY_TOKEN: "legacy" }), {
    missing: ["AH_LITELLM_MASTER_KEY"],
    allowLegacyGateway: false,
  });
  assert.equal(llmSettings({ ...incomplete, AH_LLM_ENABLED: "true" }), undefined);
});

test("malformed settings report only safe field names", () => {
  const secretSentinel = "private-invalid-url-value";
  for (const [name, value] of [
    ["AH_LITELLM_MANAGEMENT_URL", secretSentinel],
    ["AH_WALLET_INFERENCE_URL", `https://${secretSentinel}@example.com`],
    ["AH_LLM_POLICY_FILE", secretSentinel],
    ["AH_LLM_SESSION_BUDGET_USD", secretSentinel],
  ]) {
    assert.throws(
      () => resolveLlmSettings({ ...gateway, [name]: value }),
      { message: `Invalid ${name}` },
    );
  }
});
