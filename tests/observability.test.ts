import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  parseManifest,
  manifestHash,
} from "../src/service/applications/manifest.js";
import {
  compatibleEvents,
  definitionHash,
  parseAnalytics,
} from "../src/service/observability/contract.js";
import { ObservationService } from "../src/service/observability/service.js";
import { ObservationStore } from "../src/service/observability/store.js";
import { migrateObservations } from "../src/service/observability/migrate.js";
import { report, type Row } from "../src/service/observability/report.js";
import { testDatabaseUrl } from "./pg.js";
const definition = () =>
  parseAnalytics(
    {
      schemaVersion: 1,
      events: {
        started: {
          version: 1,
          source: "browser",
          properties: { variant: { enum: ["a", "b"] } },
        },
        success: {
          version: 1,
          source: "server",
          properties: {},
          binding: { kind: "table_created", table: "signups" },
        },
      },
      primaryGoal: "success",
      funnels: [
        {
          id: "main",
          unit: "session",
          windowMinutes: 30,
          steps: ["page_view", "started", "success"],
        },
      ],
    },
    ["signups"],
  )!;
test("analytics preserves typed definitions, separates data hash, rejects undeclared goals and same-version semantic changes", () => {
  const m = {
    formatVersion: 1,
    template: "react-node-v1",
    tables: {
      signups: {
        fields: { name: { type: "text" } },
        publicCreate: true,
        publicRead: false,
      },
    },
  };
  const a = parseManifest(m),
    b = parseManifest({ ...m, analytics: definition() });
  assert.equal(manifestHash(a), manifestHash(b));
  assert.equal(b.analytics?.primaryGoal, "success");
  const next = definition();
  next.events.started.properties.variant = { enum: ["c"] };
  assert.throws(() => compatibleEvents(definition(), next), /VERSION_REQUIRED/);
  next.events.started.version = 2;
  compatibleEvents(definition(), next);
  assert.throws(
    () =>
      parseAnalytics({ ...definition(), primaryGoal: "started" }, ["signups"]),
    /GOAL/,
  );
  assert.throws(
    () =>
      parseAnalytics(
        {
          ...definition(),
          events: {
            ...definition().events,
            page_view: definition().events.started,
          },
        },
        ["signups"],
      ),
    /EVENT/,
  );
});
test("observation PG ingestion isolates apps/environments, deduplicates concurrent and cross-day replay, rejects spoofing and honors delete tombstones", async () => {
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 }),
    schema = "observe_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("options", "-c search_path=" + schema);
  const store = new ObservationStore(url.href);
  try {
    await migrateObservations(store.pool);
    await migrateObservations(store.pool);
    const app = randomUUID(),
      deployment = randomUUID();
    const token = await store.bind(
      app,
      "production",
      randomUUID(),
      deployment,
      definition(),
    );
    const binding = (await store.authenticate(token))!;
    assert.equal(binding.app_id, app);
    assert.equal(await store.authenticate("0".repeat(64)), undefined);
    const event = {
      eventId: randomUUID(),
      eventName: "page_view",
      occurredAt: Date.now() - 3600000,
      anonymousId: randomUUID(),
      sessionId: randomUUID(),
      properties: { page: "/", channel: "test", device: "desktop" },
    };
    const results = await Promise.all([
      store.ingest(binding, "browser", event),
      store.ingest(binding, "browser", event),
    ]);
    assert.deepEqual(results.toSorted(), ["accepted", "duplicate"]);
    await assert.rejects(
      store.ingest(binding, "browser", {
        ...event,
        properties: { page: "other" },
      }),
      /CONFLICT/,
    );
    await assert.rejects(
      store.ingest(binding, "browser", {
        ...event,
        eventId: randomUUID(),
        eventName: "success",
      }),
      /SOURCE/,
    );
    await assert.rejects(
      store.ingest(binding, "browser", {
        ...event,
        eventId: randomUUID(),
        properties: { email: "secret@example.com" },
      }),
      /PROPERTIES/,
    );
    await assert.rejects(
      store.ingest(binding, "browser", {
        ...event,
        eventId: randomUUID(),
        eventName: "started",
        eventVersion: 1,
        properties: { variant: "unregistered" },
      }),
      /PROPERTIES/,
    );
    assert.equal(
      await store.ingest(binding, "server", {
        eventId: randomUUID(),
        eventName: "success",
        eventVersion: 1,
        occurredAt: Date.now(),
        properties: {},
      }),
      "accepted",
    );
    const second = randomUUID();
    await store.bind(
      second,
      "preview",
      randomUUID(),
      randomUUID(),
      definition(),
    );
    const b = (
      await store.pool.query(
        "SELECT * FROM observation_bindings WHERE app_id=$1",
        [second],
      )
    ).rows[0];
    await store.ingest(b, "browser", event);
    assert.equal(
      (
        await store.pool.query(
          "SELECT count(*) FROM observation_events WHERE app_id=$1",
          [app],
        )
      ).rows[0].count,
      "2",
    );
    await store.erase(app, "production", Date.now());
    assert.equal(await store.ingest(binding, "browser", event), "deleted");
    assert.equal(
      (
        await store.pool.query(
          "SELECT count(*) FROM observation_events WHERE app_id=$1",
          [app],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await store.pool.query(
          "SELECT count(*) FROM observation_events WHERE app_id=$1",
          [second],
        )
      ).rows[0].count,
      "1",
    );
    await store.revoke(second);
    assert.equal(
      (
        await store.pool.query(
          "SELECT enabled FROM observation_bindings WHERE app_id=$1",
          [second],
        )
      ).rows[0].enabled,
      false,
    );
  } finally {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
test("report counts cross-day UV once, uses ordered same-session funnels, final vital samples and actual percentiles", () => {
  const d = definition(),
    digest = definitionHash(d),
    visitor = randomUUID(),
    session = randomUUID(),
    at = Date.now() - 86400000;
  const row = (
    name: string,
    time: number,
    overrides: Partial<Row> = {},
  ): Row => ({
    event_name: name,
    event_version: 1,
    occurred_at: time,
    received_at: time,
    anonymous_id: visitor,
    session_id: session,
    request_id: null,
    revision_id: "server-revision",
    client_revision_id: "old-page-revision",
    definition_hash: digest,
    deployment_id: "deployment",
    source: name === "success" ? "server" : "browser",
    properties: {},
    ...overrides,
  });
  const rows = [
    row("page_view", at),
    row("started", at + 10),
    row("success", at + 20),
    row("page_view", at + 86400000),
    row("success", at + 40, { session_id: null }),
    row("started", at - 10, { session_id: randomUUID() }),
    row("web_vital", at, {
      properties: { metric: "LCP", metricId: "a", value: 100 },
    }),
    row("web_vital", at + 1, {
      properties: { metric: "LCP", metricId: "a", value: 300 },
    }),
  ];
  for (let i = 1; i <= 20; i++)
    rows.push(
      row("http_request", at, {
        source: "runtime",
        properties: { route: "/api/tables/:table", status: 200, durationMs: i },
      }),
    );
  const result = report(rows, d, digest);
  assert.equal(result.summary.visitors, 1);
  assert.equal(result.summary.goals, 2);
  assert.deepEqual(
    result.funnels[0].steps.map((s) => s.count),
    [1, 1, 1],
  );
  assert.equal(result.vitals[0].samples, 1);
  assert.equal(result.vitals[0].p75, 300);
  assert.equal(result.summary.p95Ms, 19);
  assert.equal(result.versions[0].revisionId, "old-page-revision");
});

test("analysis configuration is versioned, checks ownership and rejects stale writes", async () => {
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 }),
    schema = "obs_config_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("options", "-c search_path=" + schema);
  const app = randomUUID(),
    applications = {
      store: {
        async owned(user: string, id: string) {
          assert.equal(id, app);
          if (user !== "owner") throw new Error("NOT_OWNER");
        },
        async endpoints() {
          return [];
        },
      },
    };
  const service = new ObservationService(applications as any, {
    databaseUrl: url.href,
    publicUrl: "http://127.0.0.1:1",
    bindHost: "127.0.0.1",
    port: 1,
  });
  try {
    await migrateObservations(service.store.pool);
    await service.store.bind(
      app,
      "production",
      randomUUID(),
      randomUUID(),
      definition(),
    );
    const initial = await service.summary("owner", app, "production", 1);
    assert.ok("analysisConfig" in initial);
    if (!("analysisConfig" in initial)) throw new Error("missing config");
    const input = {
      expectedVersion: 0,
      definitionHash: initial.analysisConfig.definitionHash,
      primaryGoal: "success",
      funnels: definition().funnels,
    };
    const saved = await service.configure("owner", app, "production", input);
    assert.equal(saved.version, 1);
    await assert.rejects(
      service.configure("owner", app, "production", input),
      /CONFIG_CHANGED/,
    );
    await assert.rejects(
      service.configure("other", app, "production", {
        ...input,
        expectedVersion: 1,
      }),
      /NOT_OWNER/,
    );
    const next = await service.configure("owner", app, "production", {
      ...input,
      expectedVersion: 1,
      primaryGoal: null,
    });
    assert.equal(next.version, 2);
    assert.equal(
      (
        await service.store.pool.query(
          "SELECT count(*) FROM observation_state WHERE key LIKE 'analysis_version_%'",
        )
      ).rows[0].count,
      "2",
    );
  } finally {
    await service.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("Runtime business rollback leaves no success event; outbox/counter failure preserves committed business", async () => {
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 }),
    schema = "obs_tx_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("options", "-c search_path=" + schema);
  const p = new Pool({ connectionString: url.href, max: 2 });
  const { pathToFileURL } = await import("node:url"),
    { resolve } = await import("node:path");
  const { observations } = await import(
    pathToFileURL(resolve("infra/app-runtime/observe.mjs")).href
  );
  const manifest = {
    analytics: {
      events: { success: { version: 1, source: "server", properties: {} } },
    },
  };
  const observe = observations(
    {
      appId: randomUUID(),
      deploymentId: randomUUID(),
      revisionId: randomUUID(),
      observation: { url: "http://127.0.0.1:1", token: "fixture" },
    },
    manifest,
    p,
  );
  try {
    await p.query(
      "CREATE TABLE business(id integer PRIMARY KEY);CREATE TABLE harbor_observation_outbox(id text PRIMARY KEY,deployment_id text,event jsonb,created_at bigint);CREATE TABLE harbor_observation_state(key text PRIMARY KEY,value bigint)",
    );
    await assert.rejects(
      observe.transaction(async (c: any, emit: any) => {
        await c.query("INSERT INTO business VALUES(1)");
        await emit("success");
        throw new Error("BUSINESS_ROLLBACK");
      }),
      /BUSINESS_ROLLBACK/,
    );
    assert.equal(
      (await p.query("SELECT count(*) FROM harbor_observation_outbox")).rows[0]
        .count,
      "0",
    );
    assert.equal(
      (await p.query("SELECT count(*) FROM business")).rows[0].count,
      "0",
    );
    await observe.transaction(async (c: any, emit: any) => {
      await c.query("INSERT INTO business VALUES(2)");
      await emit("success");
    });
    assert.equal(
      (await p.query("SELECT count(*) FROM harbor_observation_outbox")).rows[0]
        .count,
      "1",
    );
    await p.query(
      "ALTER TABLE harbor_observation_outbox ADD CONSTRAINT no_new_events CHECK(false) NOT VALID",
    );
    await observe.transaction(async (c: any, emit: any) => {
      await c.query("INSERT INTO business VALUES(3)");
      await emit("success");
    });
    assert.equal(
      (await p.query("SELECT value FROM harbor_observation_state")).rows[0]
        .value,
      "1",
    );
    await p.query(
      "ALTER TABLE harbor_observation_state ADD CONSTRAINT no_counters CHECK(false) NOT VALID",
    );
    await observe.transaction(async (c: any, emit: any) => {
      await c.query("INSERT INTO business VALUES(4)");
      await emit("success");
    });
    assert.equal(
      (await p.query("SELECT count(*) FROM business")).rows[0].count,
      "3",
    );
    assert.equal(observe.dropped, 2);
  } finally {
    await observe.close();
    await p.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("edge log replay deduplicates and copy-truncate starts a new generation", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { collectEdgeLog } =
      await import("../src/service/observability/edge-log.js");
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 }),
    schema = "obs_edge_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("options", "-c search_path=" + schema);
  const store = new ObservationStore(url.href),
    directory = await mkdtemp(join(tmpdir(), "ah-obs-edge-")),
    path = join(directory, "access.json");
  try {
    await migrateObservations(store.pool);
    const deployment = randomUUID();
    await store.bind(
      randomUUID(),
      "production",
      randomUUID(),
      deployment,
      definition(),
    );
    const line = (duration: number) =>
      JSON.stringify({
        ts: Date.now() / 1000,
        status: 200,
        duration,
        harbor_deployment: deployment,
        request: { method: "GET" },
      }) + "\n";
    await writeFile(path, line(1) + line(2));
    await collectEdgeLog(store, path);
    await collectEdgeLog(store, path);
    assert.equal(
      (await store.pool.query("SELECT count(*) FROM observation_events"))
        .rows[0].count,
      "2",
    );
    await writeFile(path, line(3));
    await collectEdgeLog(store, path);
    assert.equal(
      (await store.pool.query("SELECT count(*) FROM observation_events"))
        .rows[0].count,
      "3",
    );
    assert.equal(
      (
        await store.pool.query(
          "SELECT value FROM observation_state WHERE key='edge_rotation'",
        )
      ).rows[0].value.truncated,
      true,
    );
  } finally {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
