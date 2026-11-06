/** Bounded OTLP/HTTP projection. No telemetry HTTP call runs on the inference path. */
import { randomUUID } from "node:crypto";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import { sql, type SQL } from "drizzle-orm";
import {
  contentTools,
  projectToolContent,
} from "../../shared/observation-content.js";
import type { RunnerEvent } from "../../shared/runner-protocol.js";
import type { Database } from "../db/client.js";
import {
  digest,
  langfuseConfig,
  publicTracingConfig,
  type LangfuseConfig,
} from "./config.js";

type Row = Record<string, any>;
type Attributes = Record<string, string | number | boolean>;
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string; boolValue?: boolean };
  }>;
  status: { code: number };
}
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
export function span(
  traceId: string,
  spanId: string,
  name: string,
  start: number,
  end: number,
  attrs: Attributes,
  parentSpanId?: string,
  failed = false,
): TraceSpan {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, end)),
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value:
        typeof value === "boolean"
          ? { boolValue: value }
          : typeof value === "number"
            ? { intValue: String(Math.round(value)) }
            : { stringValue: value },
    })),
    status: { code: failed ? 2 : 1 },
  };
}
export function otlp(spans: TraceSpan[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "agent-harbor" } },
          ],
        },
        scopeSpans: [
          { scope: { name: "harbor.metadata", version: "1" }, spans },
        ],
      },
    ],
  };
}

export class TracingService {
  readonly config: LangfuseConfig;
  private instance = "";
  private ready = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private abort = new AbortController();
  private lastError: string | null = null;
  private toolContent = new Map<
    string,
    { content: NonNullable<RunnerEvent["toolContent"]>; at: number }
  >();
  private contentDropped = 0;
  private lastContentSweep = 0;
  private send: typeof fetch;
  private proxy?: EnvHttpProxyAgent;
  constructor(
    readonly db: Database,
    config = langfuseConfig(),
    send?: typeof fetch,
  ) {
    this.config = config;
    // This exporter alone respects operator-provided proxy routing, including NO_PROXY.
    if (
      !send &&
      config.state === "enabled" &&
      (process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy)
    )
      this.proxy = new EnvHttpProxyAgent();
    this.send =
      send ??
      (this.proxy
        ? (url, init) =>
            proxyFetch(url as string, {
              method: init?.method,
              headers: init?.headers as Record<string, string>,
              body: init?.body as string | undefined,
              signal: init?.signal,
              redirect: "error",
              dispatcher: this.proxy,
            }) as unknown as Promise<Response>
        : fetch);
  }
  get capturesContent() {
    return this.ready && !this.closed && this.config.contentMode === "redacted";
  }
  observeToolContent(
    sessionId: string,
    event: RunnerEvent,
    content: NonNullable<RunnerEvent["toolContent"]>,
  ) {
    if (
      !this.capturesContent ||
      event.sessionId !== sessionId ||
      !event.attemptId ||
      !["tool.finished", "tool.failed"].includes(event.type) ||
      typeof event.payload.name !== "string" ||
      !contentTools.has(event.payload.name)
    )
      return;
    if (this.toolContent.size >= 256) {
      this.contentDropped++;
      return;
    }
    try {
      const secrets = Object.entries(process.env)
        .filter(
          ([name, value]) => value && /key|token|secret|password/i.test(name),
        )
        .map(([, value]) => value!);
      secrets.push(this.config.secretKey!);
      this.toolContent.set(`${sessionId}:${event.runnerId}:${event.seq}`, {
        content: projectToolContent(content.input, content.output, secrets),
        at: Date.now(),
      });
    } catch {
      this.contentDropped++;
    }
  }
  /** The app operation saves the revision after the task span may already have been sent. */
  async observeArtifact(revisionId: string, messageId: string) {
    if (!this.capturesContent) return;
    try {
      const [row] = await this.rows(sql`
        SELECT a.id AS "appId", v.id AS "revisionId", v.number, v."createdAt", v."sourceMessageId",
          m.id AS "messageId", m."sessionId", m."finishedAt", a."ownerId"
        FROM app_revisions v JOIN applications a ON a.id=v."appId"
        JOIN messages m ON m.id=${messageId} AND m."sessionId"=a."developmentSessionId"
        WHERE v.id=${revisionId}`);
      if (!row) return;
      const created = row.sourceMessageId === messageId;
      const at = Number(
        created ? row.createdAt : (row.finishedAt ?? row.createdAt),
      );
      await this.enqueue(
        span(
          this.id("message:" + row.messageId),
          this.id("artifact:" + row.messageId + ":" + row.revisionId, 16),
          "harbor.artifact",
          at,
          at,
          {
            ...this.attributes(row.sessionId, row.ownerId, "harbor.task"),
            "harbor.message_id": row.messageId,
            "langfuse.observation.metadata.app_id": row.appId,
            "langfuse.observation.metadata.revision_id": row.revisionId,
            "langfuse.observation.metadata.revision_number": Number(row.number),
            "langfuse.observation.metadata.outcome": created
              ? "artifact_created"
              : "artifact_reused",
          },
          this.id("message-span:" + row.messageId, 16),
        ),
        row.messageId,
      );
    } catch {
      this.contentDropped++;
    }
  }
  private get target() {
    return this.config.destination!;
  }
  private async rows(q: SQL): Promise<Row[]> {
    return (await this.db.execute(q)).rows as Row[];
  }
  private id(value: string, n = 32) {
    return digest(this.target + ":" + this.instance + ":" + value, n);
  }
  private attributes(
    sessionId: string,
    ownerId: string,
    name: string,
  ): Attributes {
    return {
      "session.id": this.id("session:" + sessionId),
      "user.id": this.id("owner:" + ownerId),
      "langfuse.trace.name": name,
      "langfuse.environment": "harbor",
      "langfuse.observation.type": "span",
    };
  }
  async initialize() {
    if (this.config.state !== "enabled" || this.closed) return;
    try {
      await this.db.transaction(async (tx) => {
        const inserted = await tx.execute(
          sql`INSERT INTO tracing_targets(destination,"createdAt","instanceId") VALUES(${this.target},${Date.now()},${randomUUID()}) ON CONFLICT DO NOTHING RETURNING destination`,
        );
        if (inserted.rows.length) {
          // Establish a fence once, without retrospectively exporting old conversations.
          await tx.execute(
            sql`INSERT INTO tracing_cursors(destination,"sessionId","eventId") SELECT ${this.target},id,"lastEventId" FROM sessions ON CONFLICT DO NOTHING`,
          );
        }
      });
      this.instance = String(
        (
          await this.rows(
            sql`SELECT "instanceId" FROM tracing_targets WHERE destination=${this.target}`,
          )
        )[0].instanceId,
      );
      this.ready = true;
    } catch {
      this.lastError = "TRACING_STORAGE_UNAVAILABLE";
    }
  }
  start() {
    if (this.config.state !== "enabled" || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.closed || this.config.state !== "enabled")
      return Promise.resolve();
    return (this.running ??= this.run()
      .catch(() => {
        this.lastError = "TRACING_EXPORT_UNAVAILABLE";
      })
      .finally(() => {
        this.running = undefined;
      }));
  }
  private auth() {
    return (
      "Basic " +
      Buffer.from(this.config.publicKey + ":" + this.config.secretKey).toString(
        "base64",
      )
    );
  }
  private async request(path: string, init: RequestInit = {}) {
    return this.send(this.config.host + path, {
      ...init,
      redirect: "error",
      headers: { ...init.headers, Authorization: this.auth() },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(3_000)]),
    });
  }
  /** The local mapping is best effort; failure must not prevent a paid request or wallet settlement. */
  async prepare(requestId: string, sessionId: string, ownerId: string) {
    if (!this.ready || this.closed) return;
    const traceId = this.id("request:" + requestId),
      spanId = this.id("inference:" + requestId, 16);
    try {
      await this.db.execute(
        sql`INSERT INTO tracing_requests("requestId",destination,"traceId","spanId","createdAt") VALUES(${requestId},${this.target},${traceId},${spanId},${Date.now()}) ON CONFLICT DO NOTHING`,
      );
      return {
        traceparent: `00-${traceId}-${spanId}-01`,
        langfuse_trace_name: "harbor.inference",
        langfuse_session_id: this.id("session:" + sessionId),
        langfuse_trace_user_id: this.id("owner:" + ownerId),
      };
    } catch {
      this.lastError = "TRACING_MAPPING_UNAVAILABLE";
      return;
    }
  }
  private async enqueue(s: TraceSpan, contentMessageId: string | null = null) {
    const now = Date.now();
    await this.db
      .execute(sql`INSERT INTO tracing_outbox(destination,id,span,"createdAt","contentMessageId","contentExpiresAt")
      SELECT ${this.target},${s.spanId},${JSON.stringify(s)}::jsonb,${now},${contentMessageId},${contentMessageId ? now + 7 * 86400_000 : null}
      WHERE (${contentMessageId}::text IS NULL OR EXISTS (
        SELECT 1 FROM messages WHERE id=${contentMessageId} FOR KEY SHARE
      )) AND (${contentMessageId}::text IS NULL OR (
        SELECT count(*) FROM tracing_outbox WHERE destination=${this.target} AND "contentMessageId" IS NOT NULL
      ) < 1024) AND (SELECT count(*) FROM tracing_outbox WHERE destination=${this.target} AND "sentAt" IS NULL)<10000
      ON CONFLICT(destination,id) DO UPDATE SET span=EXCLUDED.span,"sentAt"=NULL,"nextAttemptAt"=0,
      "contentMessageId"=EXCLUDED."contentMessageId","contentExpiresAt"=EXCLUDED."contentExpiresAt"
      WHERE tracing_outbox.span IS DISTINCT FROM EXCLUDED.span
        AND (tracing_outbox."contentMessageId" IS NULL OR EXCLUDED."contentMessageId" IS NOT NULL)`);
    // Queue saturation is visible; callers continue independently of telemetry.
    const [present] = await this.rows(
      sql`SELECT id FROM tracing_outbox WHERE destination=${this.target} AND id=${s.spanId}`,
    );
    if (!present)
      await this.db.execute(
        sql`UPDATE tracing_targets SET dropped=dropped+1 WHERE destination=${this.target}`,
      );
    return !!present;
  }
  private async project() {
    const [target] = await this.rows(
      sql`SELECT "projectId" FROM tracing_targets WHERE destination=${this.target}`,
    );
    if (target?.projectId) return;
    const r = await this.request("/api/public/projects");
    if (!r.ok) throw Error("LANGFUSE_PROJECT_HTTP_" + r.status);
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    if (
      body.data?.length !== 1 ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(body.data[0].id ?? "")
    )
      throw Error("LANGFUSE_PROJECT_UNCONFIRMED");
    await this.db.execute(
      sql`UPDATE tracing_targets SET "projectId"=${body.data[0].id!} WHERE destination=${this.target}`,
    );
  }
  private async collectRequests() {
    // A returned SDK receipt may attach messageId after the inference span was exported.
    // Replaying the same span ID updates metadata, without creating a second generation.
    const rows = await this
      .rows(sql`SELECT t.*,w."sessionId",w."userId",w."messageId",w."finishedAt",w."durationMs",w."httpStatus",w."failureCode",w."gatewayCallId",w."createdAt" AS started,w.state
      FROM tracing_requests t JOIN wallet_requests w ON w.id=t."requestId"
      LEFT JOIN tracing_outbox o ON o.destination=t.destination AND o.id=t."spanId"
      WHERE t.destination=${this.target} AND t."createdAt">=${Date.now() - 30 * 86400_000} AND (w."durationMs" IS NOT NULL OR w."finishedAt" IS NOT NULL)
      AND (o.id IS NULL OR coalesce(o.span->'attributes','[]'::jsonb) @> '[{"key":"harbor.association","value":{"stringValue":"unconfirmed"}}]'::jsonb AND w."messageId" IS NOT NULL)
      ORDER BY t."createdAt" LIMIT 100`);
    for (const r of rows) {
      const start = Number(r.started),
        end =
          r.durationMs === null
            ? Number(r.finishedAt)
            : start + Number(r.durationMs);
      const attrs: Attributes = {
        ...this.attributes(r.sessionId, r.userId, "harbor.inference"),
        "harbor.request_id": r.requestId,
        "harbor.association": r.messageId ? "confirmed" : "unconfirmed",
        "harbor.billing_state": r.state,
      };
      if (r.messageId) {
        attrs["harbor.message_id"] = r.messageId;
        attrs["harbor.task_trace_id"] = this.id("message:" + r.messageId);
      }
      if (r.gatewayCallId) attrs["harbor.gateway_call_id"] = r.gatewayCallId;
      if (r.httpStatus !== null)
        attrs["http.response.status_code"] = r.httpStatus;
      // Failure codes are finite internal identifiers, never exception text or provider bodies.
      if (
        typeof r.failureCode === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(r.failureCode)
      )
        attrs["harbor.failure_code"] = r.failureCode;
      await this.enqueue(
        span(
          r.traceId,
          r.spanId,
          "harbor.inference",
          start,
          end,
          attrs,
          undefined,
          !!r.failureCode || r.httpStatus >= 400,
        ),
      );
    }
  }
  private async collectEvents() {
    const rows = await this
      .rows(sql`SELECT e.*,s."ownerId",s."createdAt" AS "sessionCreatedAt",m."startedAt",m."finishedAt",m.status
      FROM events e JOIN sessions s ON s.id=e."sessionId"
      LEFT JOIN messages m ON m.id=e."messageId"
      LEFT JOIN tracing_cursors c ON c.destination=${this.target} AND c."sessionId"=e."sessionId"
      WHERE e."eventId">coalesce(c."eventId",0) ORDER BY e."sessionId",e."eventId" LIMIT 500`);
    const types = new Set([
      "message.started",
      "message.finished",
      "message.stopping",
      "tool.started",
      "tool.finished",
      "tool.failed",
      "tool.denied",
      "agent.started",
      "agent.finished",
      "task.updated",
      "model.request.link",
    ]);
    for (const r of rows) {
      if (r.messageId && types.has(r.type)) {
        const p =
          typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
        const root = this.id("message-span:" + r.messageId, 16),
          trace = this.id("message:" + r.messageId);
        const knownAt = Number(
          p.at ??
            p.finishedAt ??
            p.startedAt ??
            r.startedAt ??
            r.sessionCreatedAt,
        );
        const at =
          Number.isSafeInteger(knownAt) && knownAt > 0
            ? knownAt
            : Number(r.sessionCreatedAt);
        const attrs: Attributes = {
          ...this.attributes(r.sessionId, r.ownerId, "harbor.task"),
          "harbor.message_id": r.messageId,
          "harbor.event_type": r.type,
          "harbor.timing":
            p.at || p.startedAt || p.finishedAt ? "source" : "observed",
        };
        for (const k of ["toolUseId", "agentId", "promptId", "taskId"])
          if (typeof p[k] === "string")
            attrs["harbor." + k] = this.id(k + ":" + p[k]);
        if (
          typeof p.requestId === "string" &&
          /^[a-f0-9-]{36}$/.test(p.requestId)
        ) {
          attrs["harbor.request_id"] = p.requestId;
          const [request] = await this.rows(
            sql`SELECT "traceId" FROM tracing_requests WHERE destination=${this.target} AND "requestId"=${p.requestId}`,
          );
          if (request) attrs["harbor.request_trace_id"] = request.traceId;
        }
        if (
          [
            "Read",
            "Write",
            "Edit",
            "Bash",
            "Glob",
            "Grep",
            "Agent",
            "Skill",
            "WebFetch",
            "WebSearch",
          ].includes(p.name)
        )
          attrs["harbor.tool"] = p.name;
        if (
          ["completed", "failed", "interrupted", "denied"].includes(p.outcome)
        )
          attrs["harbor.outcome"] = p.outcome;
        const failed =
          ["tool.failed", "tool.denied"].includes(r.type) ||
          (r.type === "message.finished" && r.status !== "succeeded");
        if (r.type === "message.finished") {
          attrs["harbor.status"] = String(r.status);
          if (this.capturesContent) {
            // Execution success and acceptance are separate facts.
            attrs["langfuse.observation.metadata.assessment_status"] =
              "unrecorded";
          }
          await this.enqueue(
            span(
              trace,
              root,
              "harbor.task",
              Number(r.startedAt ?? at),
              Number(r.finishedAt ?? at),
              attrs,
              undefined,
              failed,
            ),
          );
        } else {
          const duration =
            Number.isSafeInteger(p.durationMs) && p.durationMs >= 0
              ? p.durationMs
              : 0;
          const contentKey = `${r.sessionId}:${r.sourceEventKey}`;
          const tool = this.toolContent.get(contentKey);
          if (["tool.finished", "tool.failed", "tool.denied"].includes(r.type))
            attrs["langfuse.observation.type"] = "tool";
          const makeSpan = (attributes: Attributes) =>
            span(
              trace,
              this.id(`event:${r.sessionId}:${r.eventId}`, 16),
              r.type,
              at - duration,
              at,
              attributes,
              root,
              failed,
            );
          const saved =
            tool &&
            (await this.enqueue(
              makeSpan({
                ...attrs,
                "langfuse.observation.input": JSON.stringify(
                  tool.content.input,
                ),
                "langfuse.observation.output": JSON.stringify(
                  tool.content.output,
                ),
                "langfuse.observation.metadata.content_policy":
                  "harbor-redacted-v1",
              }),
              r.messageId,
            ));
          if (!saved) await this.enqueue(makeSpan(attrs));
          if (tool) this.toolContent.delete(contentKey);
        }
      }
      await this.db
        .execute(sql`INSERT INTO tracing_cursors(destination,"sessionId","eventId") VALUES(${this.target},${r.sessionId},${r.eventId})
        ON CONFLICT(destination,"sessionId") DO UPDATE SET "eventId"=greatest(tracing_cursors."eventId",EXCLUDED."eventId")`);
    }
  }
  private async run() {
    if (!this.ready) await this.initialize();
    if (!this.ready || this.closed) return;
    const now = Date.now();
    for (const [key, capture] of this.toolContent) {
      if (capture.at < now - 60_000) {
        this.toolContent.delete(key);
        this.contentDropped++;
      }
    }
    if (this.contentDropped) {
      const dropped = this.contentDropped;
      await this.db.execute(
        sql`UPDATE tracing_targets SET dropped=dropped+${dropped} WHERE destination=${this.target}`,
      );
      this.contentDropped -= dropped;
    }
    if (this.lastContentSweep < now - 60_000) {
      await this.db.execute(sql`DELETE FROM tracing_outbox
        WHERE "contentExpiresAt" <= ${now} OR destination=${this.target}
        AND "contentMessageId" IS NOT NULL AND ${!this.capturesContent}`);
      this.lastContentSweep = now;
    }
    await this.collectRequests();
    await this.collectEvents();
    const batch = await this.rows(
      sql`SELECT id,span,attempts FROM tracing_outbox WHERE destination=${this.target} AND "sentAt" IS NULL AND "nextAttemptAt"<=${Date.now()}
        AND ("contentMessageId" IS NULL OR (${this.capturesContent} AND "contentExpiresAt" > ${Date.now()})) ORDER BY "createdAt",id LIMIT 50`,
    );
    if (!batch.length) return;
    let error: string | null = null;
    try {
      await this.project();
      const response = await this.request("/api/public/otel/v1/traces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body: JSON.stringify(otlp(batch.map((r) => r.span))),
      });
      if (!response.ok) throw Error("LANGFUSE_HTTP_" + response.status);
      const body = (await response.json()) as {
        partialSuccess?: { rejectedSpans?: string | number };
      };
      if (Number(body.partialSuccess?.rejectedSpans ?? 0) > 0)
        throw Error("LANGFUSE_PARTIAL_REJECTION");
    } catch (e) {
      error =
        e instanceof Error &&
        /^LANGFUSE_(HTTP_\d+|PROJECT_HTTP_\d+|PARTIAL_REJECTION|PROJECT_UNCONFIRMED)$/.test(
          e.message,
        )
          ? e.message
          : "LANGFUSE_UNREACHABLE";
    }
    for (const row of batch) {
      if (error)
        await this.db.execute(
          sql`UPDATE tracing_outbox SET attempts=attempts+1,"nextAttemptAt"=${Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6))},"lastError"=${error} WHERE destination=${this.target} AND id=${row.id}`,
        );
      else
        await this.db.execute(
          sql`UPDATE tracing_outbox SET "sentAt"=${Date.now()},"lastError"=NULL WHERE destination=${this.target} AND id=${row.id}`,
        );
    }
    this.lastError = error;
    await this.db.execute(
      error
        ? sql`UPDATE tracing_targets SET "lastError"=${error} WHERE destination=${this.target}`
        : sql`UPDATE tracing_targets SET "lastError"=NULL,"lastSuccessAt"=${Date.now()} WHERE destination=${this.target}`,
    );
    await this.db.execute(
      sql`DELETE FROM tracing_outbox WHERE destination=${this.target} AND "sentAt"<${Date.now() - 30 * 86400_000}`,
    );
  }
  async evidence(requestId: string) {
    const base = publicTracingConfig(this.config);
    if (this.config.state !== "enabled")
      return { ...base, status: this.config.state, url: null };
    try {
      const [row] = await this.rows(
        sql`SELECT r."traceId",r.confirmed,t."projectId",o."sentAt",o."lastError",w."messageId" FROM tracing_requests r JOIN tracing_targets t ON t.destination=r.destination LEFT JOIN tracing_outbox o ON o.destination=r.destination AND o.id=r."spanId" LEFT JOIN wallet_requests w ON w.id=r."requestId" WHERE r.destination=${this.target} AND r."requestId"=${requestId}`,
      );
      return {
        ...base,
        status: !row
          ? "historical"
          : row.confirmed
            ? "confirmed"
            : row.lastError
              ? "degraded"
              : row.sentAt
                ? "submitted"
                : "pending",
        traceId: row?.traceId,
        taskAssociation: "SDK receipt required",
        taskUrl:
          row?.projectId && row.messageId
            ? `${this.config.host}/project/${row.projectId}/traces/${this.id("message:" + row.messageId)}`
            : null,
        url: row?.projectId
          ? `${this.config.host}/project/${row.projectId}/traces/${row.traceId}`
          : null,
      };
    } catch {
      return { ...base, status: "degraded", url: null };
    }
  }
  async status() {
    const base = publicTracingConfig(this.config);
    if (this.config.state !== "enabled")
      return { ...base, pending: 0, dropped: 0, lastError: null };
    try {
      const [row] = await this.rows(
        sql`SELECT t."lastError",t."lastSuccessAt",t.dropped::float8,(SELECT count(*)::int FROM tracing_outbox WHERE destination=t.destination AND "sentAt" IS NULL) AS pending FROM tracing_targets t WHERE t.destination=${this.target}`,
      );
      return {
        ...base,
        pending: row?.pending ?? null,
        dropped: row?.dropped ?? null,
        lastSuccessAt: row?.lastSuccessAt ?? null,
        lastError: this.lastError ?? row?.lastError ?? null,
      };
    } catch {
      return {
        ...base,
        pending: null,
        dropped: null,
        lastError: "TRACING_STORAGE_UNAVAILABLE",
      };
    }
  }
  /** Explicit verification, never a prerequisite for inference. */
  async confirm(requestId: string) {
    if (!this.ready) return false;
    const [r] = await this.rows(
      sql`SELECT "traceId","createdAt" FROM tracing_requests WHERE destination=${this.target} AND "requestId"=${requestId}`,
    );
    if (!r) return false;
    const filter = JSON.stringify([
      { type: "string", column: "traceId", operator: "=", value: r.traceId },
    ]);
    const query = new URLSearchParams({
      filter,
      fromStartTime: new Date(Number(r.createdAt) - 60_000).toISOString(),
      toStartTime: new Date(Date.now() + 60_000).toISOString(),
      limit: "100",
    });
    const response = await this.request("/api/public/v2/observations?" + query);
    if (!response.ok) return false;
    const body = (await response.json()) as {
      data?: Array<{ traceId?: string; type?: string }>;
    };
    // Confirm the gateway generation too, rather than just our host inference span.
    const confirmed = !!body.data?.some(
      (o) => o.traceId === r.traceId && o.type?.toUpperCase() === "GENERATION",
    );
    if (confirmed)
      await this.db.execute(
        sql`UPDATE tracing_requests SET confirmed=true WHERE destination=${this.target} AND "requestId"=${requestId}`,
      );
    return confirmed;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.running;
    await this.proxy?.close();
  }
}
