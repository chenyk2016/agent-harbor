/** 观测与业务数据分库；幂等ACK只在落库后返回，坏事件不阻塞同批其他事件。 */
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  definitionHash,
  stable,
  platformEvents,
  type Analytics,
} from "./contract.js";
export type Binding = {
  deployment_id: string;
  app_id: string;
  environment: string;
  revision_id: string;
  definition_hash: string;
  definition: Analytics;
  enabled: boolean;
  token_hash: string;
  created_at: number;
};
export type EventInput = {
  eventId: string;
  eventName: string;
  eventVersion?: number;
  occurredAt: number;
  anonymousId?: string;
  sessionId?: string;
  requestId?: string;
  clientRevisionId?: string;
  properties?: Record<string, unknown>;
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const id = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9-]{16,64}$/.test(v);
const code = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(v);
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12;
const allowed: Record<string, Record<string, (v: unknown) => boolean>> = {
  page_view: {
    page: (v) => v === "/" || v === "other",
    channel: (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v),
    device: (v) => ["mobile", "desktop"].includes(String(v)),
    sequence: finite,
  },
  page_error: {
    kind: (v) =>
      [
        "Error",
        "TypeError",
        "ReferenceError",
        "SyntaxError",
        "RangeError",
        "PromiseRejection",
        "ResourceError",
      ].includes(String(v)),
    line: finite,
    column: finite,
  },
  web_vital: {
    metric: (v) => ["LCP", "INP", "CLS"].includes(String(v)),
    value: finite,
    metricId: code,
  },
  http_request: {
    route: (v) =>
      typeof v === "string" &&
      /^\/(?:api|__harbor)(?:\/[a-z_:]{1,40}){0,4}$/.test(v),
    method: (v) =>
      ["GET", "POST", "PATCH", "DELETE", "PUT", "HEAD", "OPTIONS"].includes(
        String(v),
      ),
    status: (v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 599,
    durationMs: finite,
    aborted: (v) => typeof v === "boolean",
    errorCode: code,
  },
  edge_request: {
    status: (v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 599,
    durationMs: finite,
    method: (v) =>
      ["GET", "HEAD", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"].includes(
        String(v),
      ),
  },
  resource_sample: {
    cpuPercent: finite,
    memoryBytes: finite,
    running: (v) => typeof v === "boolean",
  },
  health_check: { healthy: (v) => typeof v === "boolean" },
};
export class ObservationStore {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 2000,
      options: [
        new URL(url).searchParams.get("options") ?? "",
        "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000",
      ].join(" "),
    });
    this.pool.on("error", () =>
      console.error("OBSERVATION_DATABASE_UNAVAILABLE"),
    );
  }
  async ready() {
    await this.pool.query(
      "SELECT version FROM observation_migrations WHERE version=1",
    );
  }
  async bind(
    appId: string,
    environment: string,
    revisionId: string,
    deploymentId: string,
    definition?: Analytics,
  ) {
    const token = randomBytes(32).toString("hex");
    await this.pool.query(
      "INSERT INTO observation_bindings(deployment_id,app_id,environment,revision_id,definition_hash,definition,token_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(deployment_id) DO UPDATE SET token_hash=excluded.token_hash,enabled=true",
      [
        deploymentId,
        appId,
        environment,
        revisionId,
        definitionHash(definition),
        definition ?? { schemaVersion: 1, events: {}, funnels: [] },
        hash(token),
        Date.now(),
      ],
    );
    return token;
  }
  async binding(deploymentId: string) {
    return (
      await this.pool.query<Binding>(
        "SELECT * FROM observation_bindings WHERE deployment_id=$1",
        [deploymentId],
      )
    ).rows[0];
  }
  async authenticate(token: string) {
    return (
      await this.pool.query<Binding>(
        "SELECT * FROM observation_bindings WHERE token_hash=$1 AND enabled=true",
        [hash(token)],
      )
    ).rows[0];
  }
  async revoke(appId: string) {
    await this.pool.query(
      "UPDATE observation_bindings SET enabled=false WHERE app_id=$1",
      [appId],
    );
  }
  async state(app: string, env: string, key: string, value: unknown) {
    await this.pool.query(
      "INSERT INTO observation_state VALUES($1,$2,$3,$4,$5) ON CONFLICT(app_id,environment,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      [app, env, key, JSON.stringify(value), Date.now()],
    );
  }
  validate(binding: Binding, source: string, e: EventInput) {
    const now = Date.now();
    if (!["browser", "runtime", "server", "host", "edge"].includes(source))
      throw new Error("EVENT_SOURCE_DENIED");
    if (
      !e ||
      !id(e.eventId) ||
      typeof e.eventName !== "string" ||
      !Number.isSafeInteger(e.occurredAt) ||
      e.occurredAt > now + 300000 ||
      e.occurredAt < now - (source === "browser" ? 86400000 : 30 * 86400000)
    )
      throw new Error("INVALID_EVENT");
    for (const value of [
      e.anonymousId,
      e.sessionId,
      e.requestId,
      e.clientRevisionId,
    ])
      if (value !== undefined && !id(value))
        throw new Error("INVALID_EVENT_IDENTITY");
    let validators = allowed[e.eventName];
    if (platformEvents.has(e.eventName)) {
      if (
        (source === "browser" &&
          !["page_view", "page_error", "web_vital"].includes(e.eventName)) ||
        (source === "runtime" && e.eventName !== "http_request") ||
        (source === "host" &&
          !["resource_sample", "health_check"].includes(e.eventName)) ||
        (source === "edge" && e.eventName !== "edge_request") ||
        source === "server"
      )
        throw new Error("EVENT_SOURCE_DENIED");
    } else {
      const definition = binding.definition.events[e.eventName];
      if (
        !definition ||
        definition.source !== source ||
        e.eventVersion !== definition.version
      )
        throw new Error("EVENT_SOURCE_OR_VERSION_DENIED");
      validators = Object.fromEntries(
        Object.entries(definition.properties).map(([k, p]) => [
          k,
          (v: unknown) =>
            "enum" in p
              ? p.enum.includes(String(v)) && typeof v === "string"
              : typeof v === p.type &&
                (p.type !== "number" ||
                  (typeof v === "number" && Number.isFinite(v))),
        ]),
      );
    }
    const props = e.properties ?? {};
    if (
      !props ||
      typeof props !== "object" ||
      Array.isArray(props) ||
      Buffer.byteLength(JSON.stringify(props)) > 1024 ||
      Object.entries(props).some(
        ([k, v]) => !Object.hasOwn(validators, k) || !validators[k](v),
      )
    )
      throw new Error("INVALID_EVENT_PROPERTIES");
    return props;
  }
  async ingest(binding: Binding, source: string, e: EventInput) {
    const props = this.validate(binding, source, e);
    const payload = hash(stable({ ...e, properties: props }));
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // 删除墓碑拦住业务outbox和备份恢复后的迟到重放。
      const deletion = await c.query(
        "SELECT before_at FROM observation_deletions WHERE app_id=$1 AND environment=$2",
        [binding.app_id, binding.environment],
      );
      if (
        deletion.rows[0] &&
        e.occurredAt <= Number(deletion.rows[0].before_at)
      ) {
        await c.query("COMMIT");
        return "deleted";
      }
      const result = await c.query(
        "INSERT INTO observation_dedup(app_id,environment,source,event_id,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id",
        [
          binding.app_id,
          binding.environment,
          source,
          e.eventId,
          payload,
          Date.now(),
        ],
      );
      if (!result.rowCount) {
        const old = await c.query(
          "SELECT payload_hash FROM observation_dedup WHERE app_id=$1 AND environment=$2 AND source=$3 AND event_id=$4",
          [binding.app_id, binding.environment, source, e.eventId],
        );
        if (old.rows[0]?.payload_hash !== payload)
          throw new Error("EVENT_ID_CONFLICT");
        await c.query("COMMIT");
        return "duplicate";
      }
      await c.query(
        "INSERT INTO observation_events(app_id,environment,deployment_id,revision_id,client_revision_id,definition_hash,source,event_id,event_name,event_version,occurred_at,received_at,anonymous_id,session_id,request_id,properties,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [
          binding.app_id,
          binding.environment,
          binding.deployment_id,
          binding.revision_id,
          e.clientRevisionId ?? null,
          binding.definition_hash,
          source,
          e.eventId,
          e.eventName,
          e.eventVersion ?? 1,
          e.occurredAt,
          Date.now(),
          e.anonymousId ?? null,
          e.sessionId ?? null,
          e.requestId ?? null,
          props,
          payload,
        ],
      );
      await c.query("COMMIT");
      return "accepted";
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async erase(app: string, env: string, before: number) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [app + ":" + env]);
      await c.query(
        "INSERT INTO observation_deletions VALUES($1,$2,$3,$4) ON CONFLICT(app_id,environment) DO UPDATE SET before_at=GREATEST(observation_deletions.before_at,excluded.before_at)",
        [app, env, before, Date.now()],
      );
      await c.query(
        "DELETE FROM observation_events WHERE app_id=$1 AND environment=$2 AND occurred_at<=$3",
        [app, env, before],
      );
      if ((await c.query("SELECT to_regclass('observation_report_snapshots') AS name")).rows[0]?.name)
        await c.query("DELETE FROM observation_report_snapshots WHERE app_id=$1 AND environment=$2", [app, env]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async retain() {
    if ((await this.pool.query("SELECT to_regclass('observation_report_snapshots') AS name")).rows[0]?.name)
      await this.pool.query("DELETE FROM observation_report_snapshots WHERE expires_at <= $1", [Date.now()]);
    await this.pool.query(
      "DELETE FROM observation_events WHERE received_at<$1",
      [Date.now() - 30 * 86400000],
    );
    await this.pool.query(
      "DELETE FROM observation_dedup WHERE received_at<$1",
      [Date.now() - 37 * 86400000],
    );
  }
  close() {
    return this.pool.end();
  }
}
