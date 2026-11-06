import { randomUUID } from "node:crypto";
/** Native MCP contracts: no per-session Binding; user isolation and migration still hold. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { McpService } from "../src/service/mcp/service.js";
import { McpScripts, ownerKey } from "../src/service/mcp/scripts.js";
import { McpNetwork, publicAddress } from "../src/service/mcp/network.js";
import { loadLocalTemplates } from "../src/service/mcp/templates.js";
import { mcpSandboxPolicy } from "../src/shared/sandbox-policy.js";
import { mcpConnections } from "../src/service/db/schema/mcp.js";
import { IdentityStore } from "../src/service/identity/store.js";
import { testDatabase } from "./pg.js";

test("native connection: ownership, no credential echo, current config and optimistic updates", async () => {
  const db = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-native-"));
  try {
    const identity = new IdentityStore(db.db);
    await identity.ensure("a");
    await identity.ensure("b");
    const s = new McpService(
      db.db,
      join(root, ".service"),
      new McpNetwork(["https://example.com", "https://other.example"]),
    );
    const c = await s.save("a", {
      name: "Docs",
      url: "https://example.com/mcp",
      credentials: { Authorization: "Bearer FAKE" },
    });
    assert(!JSON.stringify(c).includes("FAKE"));
    assert.equal(
      Object.values((await s.runtime("a")).mcpServers)[0].type,
      "http",
    );
    assert.deepEqual((await s.runtime("b")).mcpServers, {});
    await assert.rejects(
      () =>
        s.save("a", {
          name: "unapproved",
          url: "https://unapproved.example/mcp",
        }),
      /MCP_ORIGIN_NOT_APPROVED/,
    );
    await assert.rejects(() => s.owned("b", c.id), /MCP_NOT_FOUND/);
    const before = await s.runtime("a");
    const renamed = await s.save(
      "a",
      {
        name: "New name",
        url: "https://example.com/mcp",
        expectedRevision: c.revision,
      },
      c.id,
    );
    assert.deepEqual(
      await s.runtime("a"),
      before,
      "display name does not restart runtime",
    );
    await assert.rejects(
      () =>
        s.save(
          "a",
          {
            name: "stale",
            url: "https://example.com/mcp",
            expectedRevision: c.revision,
          },
          c.id,
        ),
      /MCP_REVISION_CONFLICT/,
    );
    const disabled = await s.save(
      "a",
      {
        name: "New name",
        url: "https://example.com/mcp",
        enabled: false,
        expectedRevision: renamed.revision,
      },
      c.id,
    );
    assert.deepEqual((await s.runtime("a")).mcpServers, {});
    await s.save(
      "a",
      {
        name: "New name",
        url: "https://other.example/mcp",
        expectedRevision: disabled.revision,
      },
      c.id,
    );
    assert.deepEqual(
      (Object.values((await s.runtime("a")).mcpServers)[0] as any).headers,
      {},
      "target change drops previous credentials",
    );
    await s.remove("a", c.id);
    assert.deepEqual(await s.list("a"), []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy allow-lists remain disabled until explicit review, without deleting history", async () => {
  const db = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-migrate-"));
  try {
    await new IdentityStore(db.db).ensure("a");
    const s = new McpService(
      db.db,
      join(root, ".service"),
      new McpNetwork(["https://example.com", "https://other.example"]),
    );
    const c = await s.save("a", {
      name: "Old",
      url: "https://example.com/mcp",
    });
    await db.db
      .update(mcpConnections)
      .set({
        definition: {
          kind: "remote",
          name: "Old",
          url: "https://example.com/mcp",
          allowedTools: ["read"],
        },
      })
      .where(eq(mcpConnections.id, c.id));
    await s.migrateLegacy();
    await s.migrateLegacy();
    const [legacy] = await s.list("a");
    assert.equal(legacy.enabled, false);
    assert.equal(legacy.migrationPending, true);
    assert.equal(legacy.revision, 2);
    assert.deepEqual((await s.runtime("a")).mcpServers, {});
    await assert.rejects(() => s.save("a",{name:"Old client",url:"https://example.com/mcp",expectedRevision:2,enabled:true},c.id), /MCP_REVIEW_REQUIRED/);
    await assert.rejects(() => s.save("a",{name:"Old client",url:"https://example.com/mcp",expectedRevision:2,allowedTools:["read"]},c.id), /MCP_TOOL_SELECTION_REMOVED/);
    await s.save(
      "a",
      {
        confirmAllTools: true,
        name: "Reviewed",
        url: "https://example.com/mcp",
        expectedRevision: 2,
        enabled: true,
      },
      c.id,
    );
    assert.equal(Object.keys((await s.runtime("a")).mcpServers).length, 1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("script originals remain private; runtime resolves content and rejects traversal, links, environment injection", async () => {
  const db = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-scripts-"));
  try {
    const identity = new IdentityStore(db.db);
    await identity.ensure("a");
    await identity.ensure("b");
    const scripts = new McpScripts(root),
      script = await scripts.save("a", {
        name: "My tool",
        runtime: "node",
        entry: "server.mjs",
        files: { "server.mjs": "console.log(1)" },
        secretKeys: ["API_KEY"],
      });
    assert.deepEqual(await scripts.list("b"), []);
    await assert.rejects(
      () => scripts.read("user", "b", script.id),
      /MCP_SCRIPT_NOT_FOUND/,
    );
    await assert.rejects(
      () => scripts.save("a", { ...script, files: { "../escape": "bad" } }),
      /INVALID_MCP_SCRIPT_FILES/,
    );
    await assert.rejects(
      () => scripts.save("a", { ...script, secretKeys: ["NODE_OPTIONS"] }),
      /INVALID_MCP_FIELDS/,
    );
    const s = new McpService(
      db.db,
      join(root, ".service"),
      new McpNetwork(["https://example.com", "https://other.example"]),
    );
    const c = await s.save("a", {
      name: "script",
      kind: "script",
      scriptId: script.id,
      scriptScope: "user",
      credentials: { API_KEY: "FAKE" },
    });
    const runtime = await s.runtime("a");
    assert.equal(
      runtime.localMcp?.[0].script?.files["server.mjs"],
      "console.log(1)",
    );
    await scripts.save(
      "a",
      { ...script, files: { "server.mjs": "console.log(2)" } },
      script.id,
    );
    assert.notDeepEqual(await s.runtime("a"), runtime);
    assert.equal(
      runtime.localMcp?.[0].script?.files["server.mjs"],
      "console.log(1)",
      "resolved environment uses its own copy",
    );
    await assert.rejects(
      () =>
        s.save("b", {
          name: "steal",
          kind: "script",
          scriptId: script.id,
          scriptScope: "user",
        }),
      /MCP_SCRIPT_NOT_FOUND/,
    );
    await symlink(
      "/etc/passwd",
      join(root, "users", ownerKey("a"), "mcp-scripts", script.id, "leak"),
    );
    await assert.rejects(
      () => scripts.read("user", "a", script.id),
      /MCP_SCRIPT_LINK_DENIED/,
    );
    await s.remove("a", c.id);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("administrator templates use fixed commands and reject legacy image/executable injection fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-templates-"));
  try {
    const file = join(root, "templates.json");
    assert.equal((await loadLocalTemplates())[0].id, "text-tools");
    await writeFile(
      file,
      JSON.stringify([
        {
          id: "x",
          name: "x",
          command: ["/usr/local/bin/npx", "--yes", "some-tool@1.0.0"],
          secretKeys: ["API_KEY"],
        },
      ]),
    );
    assert.equal((await loadLocalTemplates(file))[0].command.length, 3);
    await writeFile(
      file,
      JSON.stringify([
        {
          id: "x",
          name: "x",
          command: ["/bin/sh", "-c", "bad"],
          secretKeys: [],
        },
      ]),
    );
    await assert.rejects(() => loadLocalTemplates(file));
    await writeFile(
      file,
      JSON.stringify([
        {
          id: "x",
          name: "x",
          command: ["/bin/node"],
          image: "old",
          secretKeys: [],
        },
      ]),
    );
    await assert.rejects(() => loadLocalTemplates(file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP derives actual managed policy; unsafe or unsupported credential modes fail closed", async () => {
  const policy = JSON.parse(
    await readFile("infra/managed-settings.json", "utf8"),
  );
  const result = mcpSandboxPolicy(policy, "/session-env/mcp");
  assert.deepEqual(result.filesystem.denyRead, [
    "/platform",
    "/etc/claude-code",
  ]);
  assert(result.filesystem.allowWrite.includes("/workspace"));
  assert.deepEqual(
    result.network.allowedDomains,
    policy.sandbox.network.allowedDomains,
  );
  policy.sandbox.filesystem.denyRead.push("~/private");
  assert(
    mcpSandboxPolicy(policy, "/session-env/mcp").filesystem.denyRead.includes(
      "/platform/state/private",
    ),
  );
  policy.sandbox.network.futureUnsafeFlag = true;
  assert.throws(
    () => mcpSandboxPolicy(policy, "/tmp"),
    /MCP_SANDBOX_FIELD_UNSUPPORTED/,
  );
  delete policy.sandbox.network.futureUnsafeFlag;
  policy.sandbox.allowNestedUserNamespaces = true;
  assert.throws(
    () => mcpSandboxPolicy(policy, "/tmp"),
    /MCP_SANDBOX_POLICY_UNSAFE/,
  );
  policy.sandbox.allowNestedUserNamespaces = false;
  policy.sandbox.credentials.envVars = [{ name: "X", mode: "mask" }];
  assert.throws(
    () => mcpSandboxPolicy(policy, "/tmp"),
    /MCP_CREDENTIAL_MODE_UNSUPPORTED/,
  );
});

test("remote URLs retain explicit origin exceptions and reject query secrets and private addresses", () => {
  const network = new McpNetwork(["http://127.0.0.1:9999"]);
  assert.equal(network.url("http://127.0.0.1:9999/mcp").pathname, "/mcp");
  assert.throws(() => network.url("http://example.com/mcp"));
  assert.throws(() => network.url("https://example.com/mcp?key=secret"));
  assert.equal(publicAddress("127.0.0.1"), false);
  assert.equal(publicAddress("8.8.8.8"), true);
});

test("confirmed-stop credential cleanup erases remote and local startup material without deleting policy or source", async () => {
  const { clearStartupCredentials } =
    await import("../src/runtime/mcp-startup.js");
  const root = await mkdtemp(join(tmpdir(), "ah-mcp-cleanup-"));
  try {
    const local = "mcp-" + randomUUID() + ".json";
    await writeFile(
      join(root, local),
      JSON.stringify({ env: { API_KEY: "FIXTURE_ONLY" } }),
    );
    await writeFile(
      join(root, "connection.json"),
      JSON.stringify({ headers: { Authorization: "FIXTURE_ONLY" } }),
    );
    await writeFile(join(root, "mcp-sandbox.json"), "POLICY");
    await clearStartupCredentials(root);
    assert.equal(await readFile(join(root, local), "utf8"), "{}");
    assert.equal(await readFile(join(root, "connection.json"), "utf8"), "{}");
    assert.equal(
      await readFile(join(root, "mcp-sandbox.json"), "utf8"),
      "POLICY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
