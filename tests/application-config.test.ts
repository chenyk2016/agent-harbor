import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { applicationOptions, type ApplicationFeatureReporter } from "../src/service/applications/config.js";

const applicationEnv = {
  AH_APP_PUBLIC_ORIGIN: "http://127.0.0.1:4318",
  AH_APP_CREATOR_IDS: "operator",
  AH_APP_DATABASE_ADMIN_URL: "postgres://localhost/app_admin",
  AH_APP_CADDY_ADMIN: "http://127.0.0.1:2019",
};

function cleanEnvironment(t: TestContext) {
  const prefix = /^(AH_APP|AH_OBSERVATION_|AH_DATABASE_URL$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => prefix.test(name)));
  const clear = () => {
    for (const name of Object.keys(process.env)) if (prefix.test(name)) delete process.env[name];
  };
  clear();
  t.after(() => { clear(); Object.assign(process.env, previous); });
}

test("application availability follows prerequisites and honors an explicit opt-out", async t => {
  cleanEnvironment(t);
  const reasons: [string, string][] = [];
  const report: ApplicationFeatureReporter = (feature, reason) => reasons.push([feature, reason]);
  assert.equal(await applicationOptions("unused", report), undefined);
  assert.match(reasons[0][1], /Missing .*AH_APP_DATABASE_ADMIN_URL.*AH_APP_CADDY_ADMIN/);

  Object.assign(process.env, applicationEnv, { AH_OBSERVATION_DATABASE_URL: "postgres://localhost/observations" });
  const available = await applicationOptions("unused", report);
  assert.ok(available?.creators.has("operator"));
  assert.ok(available?.observation);
  assert.equal(available?.visitorAuth, undefined);

  process.env.AH_OBSERVATION_ENABLED = "0";
  assert.equal((await applicationOptions("unused", report))?.observation, undefined);
  process.env.AH_APPLICATIONS_ENABLED = "0";
  assert.equal(await applicationOptions("unused", report), undefined);
  assert.deepEqual(reasons.at(-1), ["applications", "Disabled by AH_APPLICATIONS_ENABLED"]);
});

test("visitor prerequisites auto-enable email access while optional provider failures remain isolated", async t => {
  cleanEnvironment(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  Object.assign(process.env, applicationEnv, {
    AH_OBSERVATION_ENABLED: "0",
    AH_APP_AUTH_ORIGIN: "https://auth.example.com",
    AH_APP_AUTH_DOMAIN: "apps.example.net",
    AH_APP_AUTH_POCKETBASE: "http://127.0.0.1:8090",
    AH_APP_AUTH_POCKETBASE_TOKEN: "fixture-only",
    AH_APP_AUTH_EDGE_DIAL: "127.0.0.1:4318",
    AH_APP_AUTH_EDGE_TOKEN: "fixture".repeat(6),
    AH_APP_AUTH_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    AH_APP_AUTH_GOOGLE_ID: "fixture-incomplete-id",
    AH_APP_AUTH_WORKBENCH_ORIGIN: "invalid-origin",
  });
  const reasons: [string, string][] = [];
  const report: ApplicationFeatureReporter = (feature, reason) => reasons.push([feature, reason]);
  const options = await applicationOptions("unused", report);
  assert.equal(options?.visitorAuth?.defaultBackend, "pocketbase");
  assert.equal(options?.visitorAuth?.googleId, undefined);
  assert.equal(options?.visitorAuth?.workbenchOrigin, undefined);
  assert.ok(reasons.some(([feature]) => feature === "applicationVisitorGoogle"));
  assert.ok(reasons.some(([feature]) => feature === "applicationVisitorEmbedded"));
  assert.ok(!JSON.stringify(reasons).includes("fixture-incomplete-id"));

  process.env.AH_APP_AUTH_ENABLED = "0";
  assert.equal((await applicationOptions("unused", report))?.visitorAuth, undefined);
  assert.ok(reasons.some(([feature, reason]) => feature === "applicationVisitorAuth" && reason.includes("Disabled")));
});
