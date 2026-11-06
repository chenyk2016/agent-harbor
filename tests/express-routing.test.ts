/** Express迁移契约：真实HTTP/PG/磁盘，专门检查精确路径、解析顺序与原始字节。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Controller } from "../src/runtime/controller.js";
import { createApi } from "../src/service/http-api.js";
import { tokenHash } from "../src/service/auth.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { WorkspaceFiles } from "../src/service/files/workspace-files.js";
import { SkillService } from "../src/service/skills/service.js";
import { SkillBuildManager } from "../src/service/skills/build-manager.js";
import { SkillBuilder } from "../src/docker/skill-builder.js";
import { McpService } from "../src/service/mcp/service.js";
import { McpNetwork } from "../src/service/mcp/network.js";
import { testDatabase } from "./pg.js";

async function fixture() {
  const database = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "ah-express-"));
  const store = new ServiceStore(database.db),
    controller = new Controller(root);
  const manager = new SessionManager(
    store,
    {
      open: async () => {
        throw new Error("No model execution in routing tests");
      },
    },
    "fixture-model-only",
  );
  await manager.identity.importKeys(
    ["a", "b"].map((userId) => ({
      userId,
      tokenHash: tokenHash("route-" + userId),
    })),
  );
  const files = new WorkspaceFiles(root);
  assert(await files.initialize());
  const library = new SkillService(database.db, root);
  // 此组只验证路由与包，不做依赖准备；避免普通回归依赖Docker。
  class FixtureBuilder extends SkillBuilder {
    override async imageId() {
      return "sha256:" + "0".repeat(64);
    }
  }
  const builds = new SkillBuildManager(library, new FixtureBuilder(root));
  const mcp = new McpService(
    database.db,
    join(root, ".service"),
    new McpNetwork(),
  );
  const server = createApi(
    manager,
    controller,
    files,
    {},
    { library, builds },
    mcp,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, options: RequestInit = {}, user = "a") =>
    fetch(origin + "/api" + path, {
      ...options,
      headers: { Authorization: "Bearer route-" + user, ...options.headers },
    });
  return {
    origin,
    api,
    files,
    manager,
    controller,
    async close() {
      await manager.shutdown();
      await builds.close();
      await files.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const skillInput = (body = "Use the input.") => ({
  clientRequestId: randomUUID(),
  displayName: "Route fixture",
  skillMd: `---\nname: route-fixture\ndescription: Route fixture\n---\n${body}`,
});

test("explicit routes reject suffixes and case mismatches without entering business handlers", async () => {
  const f = await fixture();
  const id = randomUUID();
  try {
    for (const [method, path] of [
      ["GET", "/mcp-templates/extra"],
      ["POST", `/mcp-connections/${id}/test/extra`],
      ["GET", "/skill-selection/extra"],
      ["POST", `/skills/${id}/versions/extra`],
      ["GET", `/skill-versions/${id}/export/extra`],
      ["POST", `/skill-build-requests/${id}/cancel/extra`],
      ["GET", `/expert-versions/${id}/installation/extra`],
      ["POST", `/expert-installs/${id}/cancel/extra`],
      ["GET", "/expert-skill-choices/extra"],
      ["DELETE", `/account/keys/${id}/extra`],
      ["GET", "/MCP-connections"],
    ]) {
      const response = await f.api(path, { method });
      assert.equal(response.status, 404, method + " " + path);
      assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
    }
    assert.equal((await f.api("/mcp-templates")).status, 200);
    assert.equal((await f.api("/sessions/%ZZ")).status, 400);
    assert.equal((await f.api("/sessions/%2F")).status, 404);
    assert.equal((await f.api("/account", { method: "HEAD" })).status, 404);
  } finally {
    await f.close();
  }
});

test("authentication precedes JSON parsing; parser limits and error responses retain the API contract", async () => {
  const f = await fixture();
  try {
    const denied = await fetch(f.origin + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(denied.status, 401);
    const crossOrigin = await fetch(f.origin + "/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{",
    });
    assert.equal(crossOrigin.status, 403);
    for (const body of ["{", "[]", "null", '"text"', ""]) {
      const response = await f.api("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, body);
      assert.deepEqual(await response.json(), { error: "INVALID_JSON" });
    }
    const oversized = await f.api("/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "x", padding: "x".repeat(270_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "BODY_TOO_LARGE" });
    // 旧客户端未声明JSON Content-Type时仍接受有效JSON；支持普通会话集合路由。
    const created = await f.api("/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "No JSON header" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("x-powered-by"), null);
    assert.equal(created.headers.get("etag"), null);
    assert.equal(created.headers.get("cache-control"), "no-store");
    const compressed = await f.api("/sessions", {
      method: "POST",
      headers: {
        "Content-Encoding": "gzip",
        "Content-Type": "application/json",
      },
      body: gzipSync("{}"),
    });
    assert.equal(compressed.status, 415);
    // Skill编辑明确使用2MiB解析限额，不能误继承普通API的256KiB限额。
    const skill = await f.api("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skillInput("x".repeat(300_000))),
    });
    assert.equal(skill.status, 201, await skill.clone().text());
  } finally {
    await f.close();
  }
});

test("ZIP exports and imports remain binary across Skill and expert routers", async () => {
  const f = await fixture();
  try {
    const skill = (await (
      await f.api("/skills", {
        method: "POST",
        body: JSON.stringify(skillInput()),
      })
    ).json()) as { currentVersionId: string };
    const exportResponse = await f.api(
      `/skill-versions/${skill.currentVersionId}/export`,
    );
    assert.equal(exportResponse.status, 200);
    const zip = Buffer.from(await exportResponse.arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    const record = (await (
      await f.api(
        "/skill-imports",
        {
          method: "POST",
          body: JSON.stringify({
            clientRequestId: randomUUID(),
            fileName: "fixture.zip",
            size: zip.length,
            sha256: createHash("sha256").update(zip).digest("hex"),
          }),
        },
        "b",
      )
    ).json()) as { id: string };
    const upload = await f.api(
      `/skill-imports/${record.id}/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: zip,
      },
      "b",
    );
    assert.equal(upload.status, 200, await upload.clone().text());
    const expert = (await (
      await f.api("/expert-packages", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: randomUUID(),
          name: "Route expert",
          description: "Route expert fixture",
          instructions: "Follow the request.",
        }),
      })
    ).json()) as { currentVersionId: string };
    const expertExport = await f.api(
      `/expert-versions/${expert.currentVersionId}/export`,
    );
    assert.equal(expertExport.status, 200);
    const expertZip = Buffer.from(await expertExport.arrayBuffer());
    const importedResponse = await f.api(
      `/expert-packages/import?clientRequestId=${randomUUID()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: expertZip,
      },
      "b",
    );
    assert.equal(
      importedResponse.status,
      201,
      await importedResponse.clone().text(),
    );
    const imported = (await importedResponse.json()) as {
      currentVersionId: string;
    };
    const roundtrip = Buffer.from(
      await (
        await f.api(
          `/expert-versions/${imported.currentVersionId}/export`,
          {},
          "b",
        )
      ).arrayBuffer(),
    );
    assert.deepEqual(roundtrip, expertZip);
  } finally {
    await f.close();
  }
});

test("Express page router serves refresh/HEAD and never falls back for private files or API paths", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/sessions/demo",
      "/skills/demo",
      "/experts/new",
      "/mcp",
      "/settings",
    ]) {
      const response = await fetch(f.origin + path);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /Agent Harbor/);
      assert.match(
        response.headers.get("content-security-policy")!,
        /default-src 'none'/,
      );
      const head = await fetch(f.origin + path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    for (const path of [
      "/.env",
      "/src/main.ts",
      "/var/private",
      "/skills/id/private.txt",
    ]) {
      assert.equal((await fetch(f.origin + path)).status, 404, path);
    }
    assert.equal((await f.api("/not-found")).status, 404);
  } finally {
    await f.close();
  }
});

test("mounted identity router passes the full OIDC callback URL and preserves login redirects/cookies", async () => {
  const f = await fixture();
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const { IdentityHttp } = await import("../src/service/identity/http.js");
  const identity = new IdentityHttp(f.manager, f.files, {
    oidc: {
      issuer: "https://fixture.invalid",
      clientId: "fixture",
      clientSecret: "fixture",
      origin: f.origin,
    },
  });
  let trimmed = "",
    original = "";
  // 此测试只替代供应商换码；Router、用户落库、Cookie与重定向均使用正式代码。
  identity.oidc!.callback = async (request, _response, requestUrl) => {
    trimmed = request.url!;
    original = requestUrl!;
    return {
      issuer: "https://fixture.invalid",
      subject: "route-subject",
      name: "Route User",
    };
  };
  const app = express();
  app.use("/api", identity.publicRouter());
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(
      origin + "/api/auth/oidc/callback?code=fixture-code&state=fixture-state",
      { redirect: "manual" },
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.match(response.headers.get("set-cookie")!, /ah_browser=/);
    assert.equal(
      trimmed,
      "/auth/oidc/callback?code=fixture-code&state=fixture-state",
    );
    assert.equal(
      original,
      "/api/auth/oidc/callback?code=fixture-code&state=fixture-state",
    );
  } finally {
    identity.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

test("native MCP reload preserves session ownership and rejects stale requests; private script APIs enforce owner", async () => {
  const f = await fixture();
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const created = await f.api("/sessions", json({ title: "MCP reload" }));
    assert.equal(created.status, 201);
    const session = (await created.json()) as { id: string };
    assert.equal(
      (
        await f.api(
          `/sessions/${session.id}/mcp/reload`,
          json({ expectedMessageId: null }),
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.api(
          `/sessions/${session.id}/mcp/reload`,
          json({ expectedMessageId: randomUUID() }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(
          `/sessions/${session.id}/mcp/reload`,
          json({ expectedMessageId: null }),
        )
      ).status,
      200,
    );
    assert.equal((await f.api(`/sessions/${session.id}`)).status, 200);
    assert.equal(
      (await f.api("/sessions", json({ mcpConnectionIds: [] }))).status,
      400,
    );
    const source = {
      name: "Private source",
      entry: "server.mjs",
      runtime: "node",
      files: { "server.mjs": "// fixture" },
    };
    const saved = await f.api("/mcp-scripts", json(source));
    assert.equal(saved.status, 201);
    const script = (await saved.json()) as { id: string };
    assert.equal(
      (await f.api(`/mcp-scripts/${script.id}`, {}, "b")).status,
      404,
    );
    assert.equal(
      ((await (await f.api("/mcp-scripts", {}, "b")).json()) as unknown[])
        .length,
      0,
    );
    assert.equal(
      (
        await f.api(`/mcp-scripts/${script.id}`, {
          ...json({ ...source, name: "Updated" }),
          method: "PUT",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          "/mcp-scripts",
          json({ ...source, files: { "../escape": "x" } }),
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
