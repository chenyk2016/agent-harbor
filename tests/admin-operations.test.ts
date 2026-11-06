/** 隔离PG/HTTP验证管理权限、全量检索、未知态、审计、预览和恢复闭环。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { Controller } from "../src/runtime/controller.js";
import { WorkspaceFiles } from "../src/service/files/workspace-files.js";
import { LlmService } from "../src/service/llm/service.js";
import { WalletService } from "../src/service/wallet/service.js";
import { createApi } from "../src/service/http-api.js";
import { tokenHash } from "../src/service/auth.js";
import { AdminOperations } from "../src/service/admin/service.js";
import { csvCell, scrub } from "../src/service/admin/queries.js";
import { ObservationOrigins } from "../src/agent/observation.js";
import type { Task } from "../src/shared/types.js";

async function fixture() {
  const d = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-admin-ops-"));
  const store = new ServiceStore(d.db),
    manager = new SessionManager(
      store,
      {
        open: async () => {
          throw Error("No paid execution");
        },
      },
      "fixture-only",
    ),
    controller = new Controller(root),
    files = new WorkspaceFiles(root);
  await manager.identity.importKeys(
    ["admin", "reader", "other"].map((userId) => ({
      userId,
      tokenHash: tokenHash("ops-test-" + userId),
    })),
  );
  const remote = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end('{"healthy":true}');
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  const remoteUrl =
    "http://127.0.0.1:" + (remote.address() as { port: number }).port;
  const llm = new LlmService(d.db, root + "/.service", {
    managementUrl: remoteUrl,
    inferenceUrl: remoteUrl,
    masterKey: "fixture-only",
  });
  await d.pool.query(
    'INSERT INTO llm_providers(id,name,format,"apiBase","createdAt") VALUES ($1,$2,$3,$4,$5)',
    ["provider", "Fixture", "anthropic", remoteUrl, Date.now()],
  );
  const seed = await d.pool.connect();
  try {
    await seed.query("BEGIN");
    await seed.query(
      'INSERT INTO llm_model_versions(id,"deploymentId","providerId","upstreamModel","routeName",params,tools,streaming,capabilities,digest,state,"createdBy","createdAt") VALUES ($1,$2,$3,$4,$5,$6,true,true,$6,$7,$8,$9,$10)',
      [
        "version",
        "deployment",
        "provider",
        "fixture",
        "fixture-route",
        "{}",
        "fixture",
        "ready",
        "admin",
        Date.now(),
      ],
    );
    await seed.query(
      'INSERT INTO llm_deployments(id,name,description,"currentVersionId",enabled,"allowedUsers","createdAt","updatedAt") VALUES ($1,$2,$3,$4,true,$5,$6,$6)',
      ["deployment", "Fixture model", "", "version", "[]", Date.now()],
    );
    await seed.query("COMMIT");
  } catch (error) {
    await seed.query("ROLLBACK");
    throw error;
  } finally {
    seed.release();
  }
  await llm.createPrice(
    "deployment",
    { input: "1", output: "2", cacheRead: "1", cacheWrite: "1" },
    "admin",
  );
  const session = await store.create("reader", "PRIVATE TITLE NOT FOR ADMIN");
  await mkdir(join(root, session.id, "workspace"), { recursive: true });
  await writeFile(join(root, session.id, "workspace", "sample.txt"), "hello");
  await symlink("/etc", join(root, session.id, "workspace", "external"));
  const wallet = new WalletService(d.db),
    model = {
      deploymentId: "deployment",
      versionId: "version",
      priceVersionId: "price",
      name: "Fixture model",
      price: {
        input: 1_000_000,
        output: 2_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      },
    };
  const pending = [];
  for (let i = 0; i < 55; i++) {
    const r = await wallet.reserve("reader", session.id, model, 10);
    await wallet.unknown(r.id);
    pending.push(r.id);
    await d.pool.query(
      'UPDATE wallet_requests SET "createdAt"=$1,note=$2 WHERE id=$3',
      [Date.now() - 2 * 86400000 + i, i === 54 ? "needle-page-2" : "", r.id],
    );
  }
  const server = createApi(
    manager,
    controller,
    files,
    { adminUsers: ["admin"] },
    undefined,
    undefined,
    undefined,
    llm,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    user = "admin",
  ) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer ops-test-" + user,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const ops = new AdminOperations(d.db, manager, files, llm);
  return {
    d,
    root,
    manager,
    files,
    session,
    wallet,
    model,
    pending,
    ops,
    call,
    base,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      remote.closeAllConnections();
      await new Promise<void>((r) => remote.close(() => r()));
      await manager.shutdown();
      await files.close();
      await d.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("admin operations: protected routes, complete queue search and metadata evidence", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call("/admin/operations/status", "GET", undefined, "reader"))
        .status,
      403,
    );
    assert.equal(
      (await fetch(f.base + "/api/admin/operations/requests")).status,
      401,
    );
    for (const path of [
      "/admin/activity",
      "/admin/usage",
      "/admin/audit",
      "/admin/operations",
    ])
      assert.equal((await fetch(f.base + path)).status, 200);
    const all = await f.call("/admin/wallet/requests");
    assert.equal(all.body.total, 55);
    assert.equal(all.body.requests.length, 50);
    const searched = await f.call(
      "/admin/wallet/requests?q=needle-page-2&age=24h",
    );
    assert.equal(searched.body.total, 1);
    assert.equal(searched.body.requests[0].id, f.pending[54]);
    assert.equal(
      (
        await f.call(
          "/admin/operations/requests?q=" + encodeURIComponent("' OR 1=1 --"),
        )
      ).body.total,
      0,
    );
    const detail = await f.call("/admin/operations/requests/" + f.pending[0]);
    assert.equal(detail.body.request.messageId, null);
    assert.match(detail.body.association, /未确认/);
    assert.ok(!JSON.stringify(detail.body).includes("PRIVATE TITLE"));
    const resources = await f.call("/admin/operations/resources?user=reader");
    assert.equal(resources.body.total, 1);
    assert.ok(!JSON.stringify(resources.body).includes("PRIVATE TITLE"));
    const size = await f.call(
      "/admin/operations/resources/" + f.session.id + "/size",
    );
    assert.equal(size.status, 200);
    assert.equal(size.body.bytes, 5, "external symlink is not followed");
    assert.equal(
      (await f.call("/admin/operations/requests?state=bogus")).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("admin operations: preview expires, writes have durable redacted audit and export is bounded", async () => {
  const f = await fixture();
  try {
    const path = "/admin/llm/deployments/deployment/prices",
      input = { input: "3", output: "4", cacheRead: "1", cacheWrite: "1" };
    const p = await f.call("/admin/operations/preview", "POST", {
      path,
      method: "POST",
      input,
    });
    assert.equal(p.status, 200);
    assert.ok(p.body.token);
    await f.call(path, "POST", {
      input: "2",
      output: "2",
      cacheRead: "1",
      cacheWrite: "1",
    });
    const stale = await f.call(path, "POST", {
      ...input,
      previewToken: p.body.token,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "CHANGE_PREVIEW_EXPIRED");
    const fresh = await f.call("/admin/operations/preview", "POST", {
      path,
      method: "POST",
      input,
    });
    assert.equal(
      (await f.call(path, "POST", { ...input, previewToken: fresh.body.token }))
        .status,
      200,
    );
    const simultaneousInput = { ...input, input: "5" };
    const simultaneous = await f.call("/admin/operations/preview", "POST", {
      path,
      method: "POST",
      input: simultaneousInput,
    });
    const racing = await Promise.all(
      [1, 2].map(() =>
        f.call(path, "POST", {
          ...simultaneousInput,
          previewToken: simultaneous.body.token,
        }),
      ),
    );
    assert.deepEqual(racing.map((r) => r.status).sort(), [200, 409]);
    const patch = await f.call("/admin/users/reader", "PATCH", {
      limits: { sessions: 20 },
    });
    assert.equal(patch.status, 200);
    const id = await f.ops.auditStart("admin", "/fixture", "POST", {
      apiKey: "secret-value",
      nested: { Authorization: "Bearer secret" },
      prompt: "PRIVATE PROMPT",
      apiBase: "https://user:password@example.com/api?key=secret",
      safe: true,
    });
    await f.ops.auditFinish(id, 503, { secret: "hidden", saved: false });
    const audit = await f.call("/admin/operations/audit");
    const encoded = JSON.stringify(audit.body);
    assert.ok(!encoded.includes("secret-value"));
    assert.ok(!encoded.includes("PRIVATE PROMPT"));
    assert.ok(!encoded.includes("user:password"));
    assert.ok(audit.body.items.some((r: any) => r.outcome === "failed"));
    const pendingId = await f.ops.auditStart("admin", "/fixture", "POST", {
      safe: true,
    });
    assert.equal(
      (await f.ops.audits({ q: pendingId })).items[0].outcome,
      "unconfirmed",
    );
    const exported = await f.call(
      "/admin/operations/export?kind=requests&user=reader",
    );
    assert.equal(exported.status, 200);
    assert.equal(exported.body.exported, 55);
    assert.ok(!exported.body.csv.includes("PRIVATE TITLE"));
    assert.equal(
      (await f.call("/admin/operations/export?kind=secrets")).status,
      400,
    );
    const failedExport = await f.ops.audits({
      q: "/admin/operations/export",
      state: "failed",
    });
    assert.ok(failedExport.items.some((r) => r.outcome === "failed"));
    await f.d.pool.query(
      `INSERT INTO wallet_ledger(id,"userId",amount,kind,note,"balanceAfter","createdAt")
      SELECT 'export-cap-' || n, 'reader', -1000000, 'charge', '=FORMULA_TEST', 0, $1 FROM generate_series(1,5001) n`,
      [Date.now()],
    );
    const capped = await f.call(
      "/admin/operations/export?kind=ledger&q=FORMULA_TEST",
    );
    assert.equal(capped.body.total, 5001);
    assert.equal(capped.body.exported, 5000);
    assert.equal(capped.body.partial, true);
    assert.ok(capped.body.csv.includes("'=FORMULA_TEST"));
    assert.ok(capped.body.csv.includes('"-1"'));
    const last = await f.call(
      "/admin/operations/ledger?q=FORMULA_TEST&offset=5000",
    );
    assert.equal(last.body.items.length, 1);
  } finally {
    await f.close();
  }
});

test("admin operations: incidents persist, active issues cannot resolve, costs keep unknown separate", async () => {
  const f = await fixture();
  try {
    let status = await f.call("/admin/operations/status");
    const incident = status.body.incidents.find(
      (r: any) => r.target === f.pending[0],
    );
    assert.ok(incident?.active);
    assert.equal(
      (
        (await f.ops.before(
          "/admin/operations/incidents/" + encodeURIComponent(incident.id),
        )) as any
      ).active,
      true,
    );
    assert.equal(
      (
        await f.call(
          "/admin/operations/incidents/" + encodeURIComponent(incident.id),
          "PATCH",
          { status: "resolved", note: "not recovered" },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          "/admin/operations/incidents/" + encodeURIComponent(incident.id),
          "PATCH",
          { status: "acknowledged", note: "investigating" },
        )
      ).status,
      200,
    );
    await f.wallet.settle(f.pending[0], undefined, {
      amount: 0,
      note: "fixture waived",
      actor: "admin",
    });
    assert.equal(
      (
        await f.call(
          "/admin/operations/incidents/" + encodeURIComponent(incident.id),
          "PATCH",
          { status: "resolved", note: "reconciled" },
        )
      ).status,
      200,
    );
    const saved = (await f.ops.status(true)).incidents.find(
      (r) => r.id === incident.id,
    );
    assert.equal(saved?.status, "resolved");
    assert.equal(saved?.active, false);
    await f.d.pool.query("UPDATE wallet_requests SET state=$1 WHERE id=$2", [
      "unknown",
      f.pending[0],
    ]);
    assert.equal(
      (await f.ops.status(true)).incidents.find((r) => r.id === incident.id)
        ?.status,
      "open",
    );
    const report = await f.call("/admin/operations/usage?from=0");
    assert.equal(report.status, 200);
    assert.equal(report.body.rmb.requests, 55);
    assert.equal(report.body.usd.knownSpendUsd, null);
    assert.equal(report.body.rmb.measured, 0);
    assert.equal(report.body.rmb.p95Ms, null);
    assert.equal(report.body.models[0].versionId, "version");
    assert.equal(report.body.users[0].userId, "reader");
    assert.equal(
      (await f.call("/admin/operations/usage?from=200&to=100")).status,
      400,
    );
    assert.equal(
      (await f.call("/admin/operations/usage?version=missing&from=0")).body.rmb
        .requests,
      0,
    );
  } finally {
    await f.close();
  }
});

test("observation origins preserve late results and unknown child attribution; CSV neutralizes formulas", () => {
  const origins = new ObservationOrigins(),
    old = { attemptId: "old" } as Task,
    next = { attemptId: "next" } as Task;
  origins.observe("turn.observed", { promptId: "p1" }, old);
  origins.observe("tool.started", { toolUseId: "t1", promptId: "p1" }, old);
  assert.equal(
    origins.observe("tool.finished", { toolUseId: "t1" }, next)?.attemptId,
    "old",
  );
  assert.equal(
    origins.observe(
      "tool.started",
      { toolUseId: "unknown", agentId: "unmapped" },
      next,
    ),
    null,
  );
  origins.observe("agent.started", { agentId: "agent", promptId: "p1" }, next);
  assert.equal(
    origins.observe("tool.started", { toolUseId: "t2", agentId: "agent" }, next)
      ?.attemptId,
    "old",
  );
  assert.match(csvCell(' =HYPERLINK("https://x")'), /^"'/);
  assert.equal((scrub({ apiKey: "hidden" }) as any).apiKey, "[redacted]");
});
