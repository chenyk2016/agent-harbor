/** 服务拥有采集监听与后台轮询；应用容器只得到限定写能力，查询仍走Harbor归属认证。 */
import { collectEdgeLog } from "./edge-log.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { ApplicationService } from "../applications/service.js";
import { fail } from "../types.js";
import { binaryBody } from "../http/shared.js";
import { ObservationStore, type Binding, type EventInput } from "./store.js";
import { report, type Row } from "./report.js";
import {
  compatibleEvents,
  definitionHash,
  parseAnalytics,
} from "./contract.js";
export type ObservationOptions = {
  databaseUrl: string;
  publicUrl: string;
  bindHost: string;
  port: number;
  edgeLog?: string;
};
export class ObservationService {
  readonly store: ObservationStore;
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closing = false;
  private lastRetention = 0;
  private cursor = 0;
  private sampled = new Map<string, number>();
  readonly drops = new Map<string, number>();
  private rates = new Map<string, { at: number; n: number }>();
  constructor(
    readonly applications: ApplicationService,
    readonly options: ObservationOptions,
  ) {
    this.store = new ObservationStore(options.databaseUrl);
  }
  async initialize() {
    await this.store.ready();
    this.server = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || req.url !== "/internal/observations/batch")
          return void res.writeHead(404).end();
        const bearer = req.headers.authorization?.match(
          /^Bearer ([a-f0-9]{64})$/,
        )?.[1];
        if (!bearer) return void res.writeHead(401).end();
        const binding = await this.store.authenticate(bearer);
        if (!binding) return void res.writeHead(401).end();
        const deployment = await this.applications.store.deployment(
          binding.deployment_id,
        );
        if (
          !deployment ||
          !["starting", "healthy"].includes(deployment.observedState)
        )
          return void res.writeHead(403).end();
        const app = await this.applications.store.byId(binding.app_id);
        if (!app || app.status !== "active")
          return void res.writeHead(403).end();
        await this.applications.sessions.identity.require(app.ownerId);
        const now = Date.now(),
          rate = this.rates.get(binding.deployment_id);
        if (rate && now - rate.at < 60000) {
          if (++rate.n > 120) return void res.writeHead(429).end();
        } else this.rates.set(binding.deployment_id, { at: now, n: 1 });
        if (this.rates.size > 2000)
          for (const [key, r] of this.rates)
            if (now - r.at > 60000) this.rates.delete(key);
        const body = JSON.parse(
          (await binaryBody(req, 32768, "OBSERVATION_BATCH_LIMIT")).toString(
            "utf8",
          ),
        );
        if (
          !body ||
          !["browser", "runtime"].includes(body.source) ||
          !Array.isArray(body.events) ||
          body.events.length > 20
        )
          throw new Error("INVALID_BATCH");
        const result = [];
        for (const event of body.events) {
          try {
            let eventBinding = binding;
            if (
              body.source === "browser" &&
              event.clientRevisionId &&
              event.clientRevisionId !== binding.revision_id
            ) {
              const previous = (
                await this.store.pool.query<Binding>(
                  "SELECT * FROM observation_bindings WHERE app_id=$1 AND environment=$2 AND revision_id=$3 ORDER BY created_at DESC LIMIT 1",
                  [binding.app_id, binding.environment, event.clientRevisionId],
                )
              ).rows[0];
              if (!previous) throw new Error("UNKNOWN_CLIENT_REVISION");
              eventBinding = {
                ...binding,
                definition: previous.definition,
                definition_hash: previous.definition_hash,
              };
            }
            result.push(
              await this.store.ingest(eventBinding, body.source, event),
            );
          } catch (e) {
            result.push("rejected");
            this.drops.set(
              binding.app_id,
              (this.drops.get(binding.app_id) ?? 0) + 1,
            );
          }
        }
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ results: result }));
      } catch {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: "OBSERVATION_REJECTED" }));
      }
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.listen(this.options.port, this.options.bindHost);
    await once(this.server, "listening");
    this.timer = setInterval(() => {
      if (!this.running && !this.closing)
        this.running = this.tick()
          .catch(() => console.error("OBSERVATION_WORKER_UNAVAILABLE"))
          .finally(() => {
            this.running = undefined;
          });
    }, 5000);
    this.timer.unref();
  }
  async deployment(
    app: string,
    env: string,
    revision: string,
    id: string,
    definition: any,
  ) {
    // 含义不变的事件可沿用版本；与历史同版本的冲突一律拒绝。
    const previous = await this.store.pool.query<Binding>(
      "SELECT * FROM observation_bindings WHERE app_id=$1 AND environment=$2",
      [app, env],
    );
    if (
      !previous.rows.some(
        (b) => b.definition_hash === definitionHash(definition),
      )
    )
      for (const b of previous.rows) compatibleEvents(b.definition, definition);
    const token = await this.store.bind(app, env, revision, id, definition);
    return { url: this.options.publicUrl, token };
  }
  async drain(appId: string, environment: "preview" | "production") {
    const state = await this.applications.data.open(appId, environment);
    const pool = new Pool({
      connectionString: this.applications.data.connection(state, true),
      max: 1,
      connectionTimeoutMillis: 2000,
      options: "-c statement_timeout=3000",
    });
    try {
      const exists = await pool.query(
        "SELECT to_regclass('harbor_observation_outbox') AS name",
      );
      if (!exists.rows[0]?.name) return;
      const rows = await pool.query(
        "SELECT id,deployment_id,event FROM harbor_observation_outbox ORDER BY created_at,id LIMIT 100",
      );
      for (const r of rows.rows) {
        const binding = await this.store.binding(r.deployment_id);
        if (
          !binding ||
          binding.app_id !== appId ||
          binding.environment !== environment
        )
          continue;
        try {
          await this.store.ingest(binding, "server", r.event);
          await pool.query(
            "DELETE FROM harbor_observation_outbox WHERE id=$1",
            [r.id],
          );
        } catch (e) {
          if (
            e instanceof Error &&
            /INVALID_|DENIED|CONFLICT/.test(e.message)
          ) {
            await pool.query(
              "DELETE FROM harbor_observation_outbox WHERE id=$1",
              [r.id],
            );
            await this.store.state(appId, environment, "outbox_rejected", {
              at: Date.now(),
            });
          } else throw e;
        }
      }
      const pending = await pool.query(
        "SELECT count(*) AS count,min(created_at) AS oldest FROM harbor_observation_outbox",
      );
      const gaps = await pool.query(
        "SELECT value FROM harbor_observation_state WHERE key='outbox_dropped'",
      );
      await this.store.state(appId, environment, "outbox", {
        pending: Number(pending.rows[0].count),
        oldest: pending.rows[0].oldest ? Number(pending.rows[0].oldest) : null,
        dropped: Number(gaps.rows[0]?.value ?? 0),
      });
    } finally {
      await pool.end();
    }
  }
  async tick() {
    if (this.options.edgeLog)
      try {
        await collectEdgeLog(this.store, this.options.edgeLog);
      } catch {
        await this.store.state("_host", "host", "edge_unavailable", {
          at: Date.now(),
        });
      }
    const directories = await readdir(
      join(this.applications.options.root, "data"),
      { withFileTypes: true },
    ).catch(() => []);
    // 每轮上限避免观测长期占用宿主；游标保证停止应用也会被轮到。
    const apps = directories.filter(
      (d) => d.isDirectory() && /^[a-f0-9-]{36}$/.test(d.name),
    );
    for (let i = 0; i < Math.min(5, apps.length); i++) {
      const id = apps[this.cursor++ % apps.length].name;
      const app = await this.applications.store.byId(id);
      if (!app || app.status !== "active") continue;
      try {
        await this.applications.sessions.identity.require(app.ownerId);
      } catch {
        await this.store.revoke(id);
        continue;
      }
      for (const env of ["preview", "production"] as const)
        try {
          await this.drain(id, env);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT")
            await this.store.state(id, env, "worker_error", { at: Date.now() });
        }
      for (const endpoint of await this.applications.store.endpoints(id)) {
        if (!endpoint.appliedDeploymentId) continue;
        const deployment = await this.applications.store.deployment(
          endpoint.appliedDeploymentId,
        );
        if (!deployment?.spec) continue;
        const binding = await this.store.binding(deployment.id);
        if (!binding) continue;
        if (Date.now() - (this.sampled.get(deployment.id) ?? 0) < 30000)
          continue;
        this.sampled.set(deployment.id, Date.now());
        let healthy = false;
        try {
          await this.applications.healthyDeployment(deployment.spec);
          healthy = true;
        } catch {}
        await this.store.ingest(binding, "host", {
          eventId: randomUUID(),
          eventName: "health_check",
          occurredAt: Date.now(),
          properties: { healthy },
        });
        if (healthy && !deployment.spec.runtime)
          try {
            const output = await this.applications.driver.command(
              [
                "stats",
                "--no-stream",
                "--format",
                "{{json .}}",
                deployment.spec.container,
              ],
              5000,
            );
            const stats = JSON.parse(output.trim());
            const match = String(stats.MemUsage)
              .split("/")[0]
              .trim()
              .match(/^([\d.]+)([kMGT]?i?B)$/);
            const unit: Record<string, number> = {
              B: 1,
              kB: 1000,
              MB: 1e6,
              GB: 1e9,
              KiB: 1024,
              MiB: 1048576,
              GiB: 1073741824,
            };
            const memory = match ? Number(match[1]) * (unit[match[2]] ?? 1) : 0;
            await this.store.ingest(binding, "host", {
              eventId: randomUUID(),
              eventName: "resource_sample",
              occurredAt: Date.now(),
              properties: {
                cpuPercent: parseFloat(stats.CPUPerc) || 0,
                memoryBytes: memory,
                running: true,
              },
            });
          } catch {}
      }
    }
    if (Date.now() - this.lastRetention > 3600000) {
      await this.store.retain();
      this.lastRetention = Date.now();
    }
  }
  async summary(user: string, app: string, environment: string, days: number,
    reader: Pick<import("pg").Pool, "query"> = this.store.pool, asOf = Date.now()) {
    await this.applications.store.owned(user, app);
    if (
      !["preview", "production"].includes(environment) ||
      ![1, 7, 30].includes(days)
    )
      fail(400, "INVALID_OBSERVATION_RANGE");
    const bindings = await reader.query<Binding>(
      "SELECT * FROM observation_bindings WHERE app_id=$1 AND environment=$2 ORDER BY created_at DESC",
      [app, environment],
    );
    const endpoints = await this.applications.store.endpoints(app);
    const active = endpoints.find(
      (e) => e.environment === environment,
    )?.appliedDeploymentId;
    const binding =
      bindings.rows.find((b) => b.deployment_id === active) ?? bindings.rows[0];
    if (!binding)
      return { status: "not_instrumented", enabled: true, environment, days };
    const result = await reader.query<Row>(
      "SELECT * FROM observation_events WHERE app_id=$1 AND environment=$2 AND occurred_at >=$3 AND occurred_at <=$4 ORDER BY occurred_at,id LIMIT 20001",
      [app, environment, asOf - days * 86400000, asOf],
    );
    const states = (
      await reader.query(
        "SELECT key,value,updated_at FROM observation_state WHERE app_id=$1 AND environment=$2",
        [app, environment],
      )
    ).rows;
    const latest = await reader.query(
      "SELECT max(received_at) AS at FROM observation_events WHERE app_id=$1 AND environment=$2",
      [app, environment],
    );
    const last = Number(latest.rows[0]?.at ?? 0),
      partial = result.rows.length > 20000;
    const config = states.find((s) => s.key === "analysis_config")?.value;
    const definition =
      config?.definitionHash === binding.definition_hash
        ? {
            ...binding.definition,
            primaryGoal: config.primaryGoal,
            funnels: config.funnels,
          }
        : binding.definition;
    const data = report(
      result.rows.slice(0, 20000),
      definition,
      binding.definition_hash,
      partial,
      asOf,
    );
    const outbox = states.find((s) => s.key === "outbox")?.value;
    if (outbox?.oldest && asOf - outbox.oldest > 300000)
      data.alerts.push({ name: "业务事件等待上报超过5分钟", state: "firing" });
    return {
      ...data,
      edgeLogConfigured: !!this.options.edgeLog,
      analysisConfig: {
        version: config?.version ?? 0,
        definitionHash: binding.definition_hash,
        events: binding.definition.events,
        primaryGoal: definition.primaryGoal ?? "",
        funnels: definition.funnels,
      },
      effectiveAnalysisConfigVersion: config?.definitionHash === binding.definition_hash ? config.version : 0,
      browserEventsReceived: result.rows.some((r) => r.source === "browser"),
      status: partial
        ? "partial"
        : !last
          ? "waiting"
          : asOf - last > 120000
            ? "stale"
            : "observed",
      environment,
      days,
      updatedAt: asOf,
      activeDeploymentId: active ?? null,
      activeRevisionId: bindings.rows.find((b) => b.deployment_id === active)?.revision_id ?? null,
      lastReceivedAt: last || null,
      states,
      rejectedSinceRestart: this.drops.get(app) ?? 0,
      activeDeploymentInstrumented: !!bindings.rows.find(
        (b) => b.deployment_id === active,
      ),
    };
  }
  async configure(
    user: string,
    app: string,
    environment: string,
    input: Record<string, unknown>,
  ) {
    const current = await this.summary(user, app, environment, 1);
    if (!("analysisConfig" in current))
      fail(409, "OBSERVATION_NOT_INSTRUMENTED");
    const base = current.analysisConfig;
    if (input.definitionHash !== base.definitionHash)
      fail(409, "OBSERVATION_DEFINITION_CHANGED");
    let parsed;
    try {
      parsed = parseAnalytics(
        {
          schemaVersion: 1,
          events: base.events,
          primaryGoal: input.primaryGoal || undefined,
          funnels: input.funnels,
        },
        Object.values(base.events).flatMap((e) =>
          e.binding ? [e.binding.table] : [],
        ),
      )!;
    } catch {
      fail(400, "INVALID_OBSERVATION_CONFIG");
    }
    const c = await this.store.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        app + ":" + environment,
      ]);
      const old = (
        await c.query(
          "SELECT value FROM observation_state WHERE app_id=$1 AND environment=$2 AND key='analysis_config'",
          [app, environment],
        )
      ).rows[0]?.value;
      if (input.expectedVersion !== (old?.version ?? 0))
        fail(409, "OBSERVATION_CONFIG_CHANGED");
      const value = {
        version: (old?.version ?? 0) + 1,
        definitionHash: base.definitionHash,
        primaryGoal: parsed.primaryGoal ?? null,
        funnels: parsed.funnels,
        actorId: user,
      };
      for (const key of [
        "analysis_config",
        "analysis_version_" + value.version,
      ])
        await c.query(
          "INSERT INTO observation_state VALUES($1,$2,$3,$4,$5) ON CONFLICT(app_id,environment,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
          [app, environment, key, value, Date.now()],
        );
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.running;
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await this.store.close();
  }
}
