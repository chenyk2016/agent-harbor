import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import {
  configure,
  initialize,
  serviceUnit,
  monitorUnits,
  loadModelFile,
} from "../src/clients/ops/install.js";
import {
  config,
  dotenv,
  projectRoot,
  environment,
  privateJson,
  verifyReleaseFiles,
  hash,
} from "../src/clients/ops/common.js";
import { validateSummary, acceptance } from "../src/clients/ops/acceptance.js";
import { inventory } from "../src/clients/ops/backup.js";
import {
  privateInferenceHost,
  startInferenceListener,
} from "../src/service/wallet/listener.js";

test("delivery: explicit empty instance, private configuration, no production environment inheritance", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-delivery-"));
  try {
    const dir = join(root, "instance");
    await configure(dir, "agent-harbor:admin-operations-v28");
    const c = await config(dir);
    assert.equal(c.env.AH_APPLICATIONS_ENABLED, "0");
    assert.equal((await lstat(join(dir, "harbor.env"))).mode & 0o077, 0);
    assert.ok(!projectRoot.endsWith("/dist"));
    assert.equal(
      parseEnv(dotenv({ VALUE: "a $value `literal` # @ : %" })).VALUE,
      "a $value `literal` # @ : %",
    );
    await assert.rejects(configure(dir, "another-image"), /EMPTY_DIRECTORY/);
    assert.equal(environment(c).AH_DATA_DIR, join(dir, "data"));
    assert.throws(() => dotenv({ VALUE: "bad\nvalue" }), /INVALID_ENV_VALUE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery: bootstrap requires an explicit key once and never rotates it on restart or retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-delivery-"));
  const previous = process.env.AH_BOOTSTRAP_ADMIN_KEY;
  try {
    const dir = join(root, "instance");
    await configure(dir, "agent-harbor:admin-operations-v28");
    const c = await config(dir);
    delete process.env.AH_BOOTSTRAP_ADMIN_KEY;
    await assert.rejects(initialize(c, "operator"), /AH_BOOTSTRAP_ADMIN_KEY_REQUIRED/);
    await assert.rejects(readFile(join(dir, "bootstrap.json")), /ENOENT/);
    process.env.AH_BOOTSTRAP_ADMIN_KEY = "invalid";
    await assert.rejects(initialize(c, "operator"), /INVALID_AH_BOOTSTRAP_ADMIN_KEY/);
    const key = randomBytes(32).toString("base64url");
    process.env.AH_BOOTSTRAP_ADMIN_KEY = key;
    const first = await initialize(c, "operator");
    assert.equal(first.reused, false);
    const before = await readFile(join(dir, "first-admin.key"), "utf8");
    assert.equal(before, key + "\n");
    assert.equal((await config(dir)).env.AH_BOOTSTRAP_ADMIN_KEY, undefined);
    delete process.env.AH_BOOTSTRAP_ADMIN_KEY;
    const again = await initialize(await config(dir), "operator");
    assert.equal(again.reused, true);
    process.env.AH_BOOTSTRAP_ADMIN_KEY = randomBytes(32).toString("base64url");
    assert.equal((await initialize(await config(dir), "operator")).reused, true);
    assert.equal(await readFile(join(dir, "first-admin.key"), "utf8"), before);
    await assert.rejects(initialize(c, "other"), /ADMIN_ALREADY/);
    const state = JSON.parse(
      await readFile(join(dir, "bootstrap.json"), "utf8"),
    );
    await privateJson(join(dir, "bootstrap.json"), {
      ...state,
      phase: "credentials-pending",
    });
    await assert.rejects(
      initialize(c, "operator"),
      /BOOTSTRAP_CREDENTIAL_WRITE_UNCONFIRMED/,
    );
    assert.throws(
      () => serviceUnit(c, "root\nExecStart=bad"),
      /INVALID_SERVICE_USER/,
    );
    assert.ok(serviceUnit(c, "harbor").includes("UMask=0077"));
    assert.ok(monitorUnits(c, "harbor").timer.includes("OnUnitActiveSec=60"));
  } finally {
    if (previous === undefined) delete process.env.AH_BOOTSTRAP_ADMIN_KEY;
    else process.env.AH_BOOTSTRAP_ADMIN_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery: service refuses missing or ambiguous administrator configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-delivery-"));
  try {
    await configure(root, "agent-harbor:fixture");
    const c = await config(root);
    const key = randomBytes(32).toString("base64url");
    for (const bootstrapKey of [undefined, key]) {
      const result = spawnSync(process.execPath, ["dist/src/service/server.js"], {
        env: { ...environment(c), AH_BOOTSTRAP_ADMIN_KEY: bootstrapKey },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, bootstrapKey
        ? /AH_BOOTSTRAP_ADMIN_KEY requires exactly one AH_ADMIN_USERS entry/
        : /AH_BOOTSTRAP_ADMIN_KEY and run harbor init/);
      assert.ok(!result.stderr.includes(key));
    }
    await assert.rejects(readFile(join(root, "first-admin.key")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery: independent CSV validator rejects wrong values, duplicate rows and missing results", () => {
  validateSummary("department,total\nFinance,11.30\nEngineering,21.00\n");
  validateSummary("department,total\nEngineering,21.00\n", true);
  for (const value of [
    "department,total\nFinance,11.31\nEngineering,21.00",
    "department,total\nEngineering,21.00\nEngineering,21.00",
    "department,total",
  ])
    assert.throws(() => validateSummary(value));
});

test("delivery: backup inventory hashes files and links without following external targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-delivery-"));
  try {
    await writeFile(join(root, "file"), "stable");
    await symlink("/does-not-exist", join(root, "external"));
    const before = await inventory(root);
    assert.equal(before.find((x) => x.path === "external")?.kind, "link");
    await writeFile(join(root, "file"), "changed");
    assert.notDeepEqual(await inventory(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery: bridge listener excludes UI/admin routes and rejects missing inference credentials", async () => {
  assert.equal(privateInferenceHost("0.0.0.0"), false);
  assert.equal(privateInferenceHost("8.8.8.8"), false);
  assert.equal(privateInferenceHost("172.17.0.1"), true);
  const llm = {
    verifyWallet: async () => {
      throw Error("no credential");
    },
  } as any;
  const server = await startInferenceListener("127.0.0.1", 0, llm, {} as any);
  try {
    const base = "http://127.0.0.1:" + (server.address() as any).port;
    for (const path of ["/", "/api/health", "/api/admin/users"])
      assert.equal((await fetch(base + path)).status, 404);
    const r = await fetch(base + "/inference/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.ok(r.status >= 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("delivery: packaged file corruption and manifest traversal are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-release-"));
  try {
    await writeFile(join(dir, "code.js"), "original");
    await privateJson(join(dir, "release-manifest.json"), {
      format: 1,
      files: [{ path: "code.js", kind: "file", sha256: hash("original") }],
    });
    assert.equal(await verifyReleaseFiles(dir), true);
    await writeFile(join(dir, "code.js"), "changed");
    await assert.rejects(verifyReleaseFiles(dir), /RELEASE_FILE_CHANGED/);
    await privateJson(join(dir, "release-manifest.json"), {
      format: 1,
      files: [{ path: "../outside", kind: "file", sha256: hash("original") }],
    });
    await assert.rejects(verifyReleaseFiles(dir), /INVALID_RELEASE_FILE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivery: invalid model setup is rejected before issuing administrator credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-bootstrap-"));
  try {
    const instance = join(dir, "instance"),
      file = join(dir, "model.json");
    await configure(instance, "agent-harbor:delivery-v29");
    await privateJson(file, {
      provider: {
        name: "provider",
        format: "anthropic",
        apiBase: "https://provider.example",
        apiKey: "fixture",
      },
      deployment: { name: "model", tools: true, streaming: true },
      cost: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        cacheReadUsdPerMillion: 1,
        cacheWriteUsdPerMillion: 1,
      },
      price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    await assert.rejects(
      initialize(await config(instance), "operator", file),
      /BOOTSTRAP_REQUIRES_TOOL_STREAM_MODEL/,
    );
    await assert.rejects(readFile(join(instance, "first-admin.key")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivery: live acceptance requires explicit model configuration and positive budget before touching infrastructure", async () => {
  for (const options of [
    { live: true },
    { live: true, modelFile: "not-read.json", budgetRmb: 0 },
    { live: true, modelFile: "not-read.json", budgetRmb: Infinity },
  ])
    await assert.rejects(
      acceptance({} as any, options),
      /LIVE_REQUIRES_MODEL_CONFIG_AND_BUDGET_RMB/,
    );
});
