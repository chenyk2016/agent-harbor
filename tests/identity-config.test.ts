import assert from "node:assert/strict";
import test from "node:test";
import { identityFromEnvironment } from "../src/service/config.js";

const passwordConfig = {
  AH_PUBLIC_ORIGIN: "https://workbench.example.test",
  AH_WORKBENCH_AUTH_SECRET: "workbench test-only secret of sufficient length",
};

test("workbench registration requires password login, HTTPS and the managed wallet; explicit false wins", () => {
  assert.equal(identityFromEnvironment(passwordConfig, true).workbench?.registration, true);
  assert.equal(identityFromEnvironment({ ...passwordConfig, AH_WORKBENCH_REGISTRATION: "false" }, true).workbench?.registration, false);
  assert.equal(identityFromEnvironment({ ...passwordConfig, AH_PUBLIC_ORIGIN: "http://127.0.0.1:4318" }, true).workbench?.registration, false);
  assert.equal(identityFromEnvironment(passwordConfig).workbench?.registration, false);

  const requested = identityFromEnvironment({ ...passwordConfig, AH_WORKBENCH_REGISTRATION: "true" });
  assert.equal(requested.workbench?.registration, false);
  assert.match(requested.issues.join(" "), /AH_WORKBENCH_REGISTRATION.*managed wallet/);
});

test("invalid optional login does not re-enable explicitly disabled browser key login or reveal secrets", () => {
  const input = {
    ...passwordConfig,
    AH_KEY_LOGIN: "false",
    AH_WORKBENCH_AUTH_SECRET: "invalid-private-value",
    AH_OIDC_ISSUER: "https://user:private-value@example.test",
    AH_OIDC_CLIENT_ID: "client",
    AH_OIDC_CLIENT_SECRET: "private-oidc-secret",
    AH_WORKBENCH_REGISTRATION: "true",
  };
  const identity = identityFromEnvironment(input, true);
  assert.equal(identity.keyLogin, false);
  assert.equal(identity.workbench, undefined);
  assert.equal(identity.oidc, undefined);
  assert.equal(identity.issues.length, 4);
  assert.doesNotMatch(identity.issues.join(" "), /private-value|private-oidc-secret/);
  assert.throws(() => identityFromEnvironment({ AH_PUBLIC_ORIGIN: "not an origin" }), /Invalid AH_PUBLIC_ORIGIN/);
});

test("workbench password login stays usable with incomplete OIDC and an invalid registration override", () => {
  const identity = identityFromEnvironment({ ...passwordConfig, AH_OIDC_CLIENT_ID: "client", AH_WORKBENCH_REGISTRATION: "yes" }, true);
  assert.equal(identity.keyLogin, true);
  assert.equal(identity.oidc, undefined);
  assert.equal(identity.workbench?.registration, false);
  assert.equal(identity.issues.length, 2);
});
