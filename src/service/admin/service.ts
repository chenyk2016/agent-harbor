/** 管理查询投影。账务权威仍在wallet；这里不重放任务，也不自动改款。 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { SessionManager } from "../session-manager.js";
import type { LlmService } from "../llm/service.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import type { TracingService } from "../tracing/service.js";
import { fail } from "../types.js";
import {
  contains,
  csvCell,
  filters,
  requestFields,
  requestWhere,
  scrub,
  value,
  type Query,
} from "./queries.js";
import type {
  AdminPageResult,
  AuditRow,
  ChangePreview,
  Incident,
  LedgerRow,
  OperationsStatus,
  RequestEvidence,
  RequestRow,
  ResourceRow,
  UsageReport,
} from "../../shared/admin.js";

type Row = Record<string, any>;
export class AdminOperations {
  private changes = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private sampling?: Promise<OperationsStatus>;
  private snapshot?: OperationsStatus;
  constructor(
    readonly db: Database,
    private manager: SessionManager,
    private files: WorkspaceFiles,
    private llm?: LlmService,
    private tracing?: TracingService,
  ) {}
  async acquireChange(path: string) {
    const key =
      path.match(
        /^\/admin\/(?:llm\/(?:deployments|providers|versions)|wallet\/(?:requests|users)|users)\/[^/]+/,
      )?.[0] ?? path;
    const prior = this.changes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.changes.set(key, gate);
    await prior;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
      if (this.changes.get(key) === gate) this.changes.delete(key);
    };
  }
  async rows<T extends Row = Row>(query: SQL): Promise<T[]> {
    return (await this.db.execute(query)).rows as T[];
  }
  start() {
    this.timer = setInterval(() => {
      void this.status(true).catch(() =>
        console.error("Admin status sample unavailable"),
      );
    }, 30_000);
    this.timer.unref();
    void this.status(true).catch(() => {});
  }
  stop() {
    clearInterval(this.timer);
  }
  private async page<T extends Row>(
    query: SQL,
    count: SQL,
    q: Query,
  ): Promise<AdminPageResult<T>> {
    const f = filters(q),
      items = await this.rows<T>(query),
      [n] = await this.rows(count);
    return {
      items,
      total: Number(n.total),
      offset: f.offset,
      limit: f.limit,
      sampledAt: Date.now(),
    };
  }
  async requests(q: Query) {
    const f = filters(q),
      where = requestWhere(q);
    return this.page<RequestRow>(
      sql`SELECT ${requestFields} FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE ${where} ORDER BY w."createdAt" DESC, w.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      sql`SELECT count(*)::int AS total FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE ${where}`,
      q,
    );
  }
  async evidence(id: string): Promise<RequestEvidence> {
    const [request] = await this.rows<
      RequestRow & {
        price: Record<string, number>;
        priceVersionId: string;
        note: string;
      }
    >(
      sql`SELECT ${requestFields}, w.price, w."priceVersionId", w.note FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE w.id=${id}`,
    );
    if (!request) fail(404, "REQUEST_NOT_FOUND");
    const gateway = request.gatewayCallId
      ? await this.rows<RequestEvidence["gateway"][number]>(
          sql`SELECT id,"callId","requestId",model,status,"spendUsd","pricingKnown",usage,"costBreakdown","startedAt"::float8 FROM gateway_usage_events WHERE "callId"=${request.gatewayCallId} AND "ownerId"=${request.userId} AND "sessionId"=${request.sessionId} ORDER BY "startedAt",id LIMIT 101`,
        )
      : [];
    const turns = await this.rows<RequestEvidence["turns"][number]>(
      sql`SELECT id,status,"startedAt"::float8,"finishedAt"::float8,"cancelRequested" FROM messages WHERE "sessionId"=${request.sessionId} ${request.messageId ? sql`AND id=${request.messageId}` : sql``} ORDER BY "createdEventId" DESC LIMIT 51`,
    );
    const eventRows = await this.rows<Row>(
      sql`SELECT "eventId"::float8,"messageId",type,payload FROM events WHERE "sessionId"=${request.sessionId} AND type IN ('tool.started','tool.finished','tool.failed','tool.denied','agent.started','agent.finished','task.updated','model.request.link','message.started','message.finished') ${request.messageId ? sql`AND "messageId"=${request.messageId}` : sql``} ORDER BY "eventId" DESC LIMIT 201`,
    );
    const allowed = new Set([
      "name",
      "toolUseId",
      "agentId",
      "promptId",
      "durationMs",
      "outcome",
      "at",
      "taskId",
      "subtype",
      "status",
      "requestId",
      "reason",
      "startedAt",
      "finishedAt",
    ]);
    const events = eventRows
      .slice(0, 200)
      .reverse()
      .map((e) => {
        const p =
          typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
        return {
          eventId: e.eventId,
          messageId: e.messageId,
          type: e.type,
          payload: Object.fromEntries(
            Object.entries(p ?? {}).filter(([key]) => allowed.has(key)),
          ),
        };
      });
    return {
      tracing: await this.tracing?.evidence(id),
      request: { ...request, note: String(scrub(request.note)) },
      gateway: gateway.slice(0, 100).map((g) => ({
        ...g,
        usage: scrub(g.usage),
        costBreakdown: scrub(g.costBreakdown),
      })),
      turns: turns.slice(0, 50),
      events,
      partial:
        gateway.length > 100 || turns.length > 50 || eventRows.length > 200,
      association: request.messageId
        ? "SDK回执关联到本轮；事件按messageId筛选"
        : "该请求未确认轮次归属；以下仅为同会话记录，不能据此认定因果或分摊费用",
    };
  }
  async ledger(q: Query) {
    const f = filters(q),
      parts = [sql`l."createdAt">=${f.from}`, sql`l."createdAt"<=${f.to}`];
    if (f.user) parts.push(sql`l."userId"=${f.user}`);
    if (f.model)
      parts.push(
        sql`EXISTS (SELECT 1 FROM wallet_requests w WHERE l.id='request:'||w.id AND w."deploymentId"=${f.model})`,
      );
    if (f.q) {
      const p = contains(f.q);
      parts.push(
        sql`(l.id ILIKE ${p} OR l."userId" ILIKE ${p} OR u.name ILIKE ${p} OR l.note ILIKE ${p})`,
      );
    }
    const where = sql.join(parts, sql` AND `);
    const page = await this.page<LedgerRow>(
      sql`SELECT l.id,l."userId",u.name AS "userName",l.amount::float8,l."balanceAfter"::float8,l.kind,l.note,l."createdAt"::float8 FROM wallet_ledger l LEFT JOIN users u ON u.id=l."userId" WHERE ${where} ORDER BY l."createdAt" DESC,l.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      sql`SELECT count(*)::int AS total FROM wallet_ledger l LEFT JOIN users u ON u.id=l."userId" WHERE ${where}`,
      q,
    );
    page.items = page.items.map((r) => ({ ...r, note: String(scrub(r.note)) }));
    return page;
  }
  async audits(q: Query) {
    const f = filters(q),
      parts = [sql`a."createdAt">=${f.from}`, sql`a."createdAt"<=${f.to}`];
    if (f.user) parts.push(sql`a.actor=${f.user}`);
    if (f.state) parts.push(sql`a.outcome=${f.state}`);
    if (f.q) {
      const p = contains(f.q);
      parts.push(
        sql`(a.actor ILIKE ${p} OR a.action ILIKE ${p} OR a.target ILIKE ${p} OR a.id ILIKE ${p})`,
      );
    }
    const source = sql`(SELECT id,actor,action,target,before,requested,result,outcome,"createdAt","finishedAt",'operations' AS source FROM admin_audit UNION ALL SELECT id,actor,action,target,before,after AS requested,null::jsonb AS result,'legacy_recorded' AS outcome,"createdAt","createdAt" AS "finishedAt",'model_history' AS source FROM llm_config_audit) a`;
    const where = sql.join(parts, sql` AND `);
    const page = await this.page<AuditRow>(
      sql`SELECT a.*,a."createdAt"::float8 AS "createdAt",a."finishedAt"::float8 AS "finishedAt" FROM ${source} WHERE ${where} ORDER BY a."createdAt" DESC,a.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      sql`SELECT count(*)::int AS total FROM ${source} WHERE ${where}`,
      q,
    );
    page.items = page.items.map((r) => ({
      ...r,
      before: scrub(r.before),
      requested: scrub(r.requested),
      result: scrub(r.result),
    }));
    return page;
  }
  async resources(q: Query) {
    const f = filters(q),
      parts = [sql`true`];
    if (f.user) parts.push(sql`s."ownerId"=${f.user}`);
    if (f.state) {
      if (
        !["closed", "starting", "ready", "stopping", "reconciling"].includes(
          f.state,
        )
      )
        fail(400, "INVALID_ADMIN_FILTER");
      parts.push(sql`s.environment=${f.state}`);
    }
    if (f.q) {
      const p = contains(f.q);
      parts.push(
        sql`(s.id ILIKE ${p} OR s."ownerId" ILIKE ${p} OR u.name ILIKE ${p})`,
      );
    }
    const where = sql.join(parts, sql` AND `);
    return this.page<ResourceRow>(
      sql`SELECT s.id,s."ownerId",u.name AS "userName",s.environment,s."updatedAt"::float8,s."lastMessageId",m.status,m."startedAt"::float8,m."finishedAt"::float8,m."cancelRequested", CASE WHEN m.result IS NOT NULL THEN (m.result::jsonb)->>'stopReason' ELSE NULL END AS "stopReason" FROM sessions s LEFT JOIN users u ON u.id=s."ownerId" LEFT JOIN messages m ON m.id=s."lastMessageId" WHERE ${where} ORDER BY s."updatedAt" DESC,s.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      sql`SELECT count(*)::int AS total FROM sessions s LEFT JOIN users u ON u.id=s."ownerId" WHERE ${where}`,
      q,
    );
  }
  async resourceSize(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, "INVALID_SESSION_ID");
    const [session] = await this.rows(
      sql`SELECT id,"ownerId" FROM sessions WHERE id=${id}`,
    );
    if (!session) fail(404, "SESSION_NOT_FOUND");
    const bytes = await this.files.bytes([id], AbortSignal.timeout(12_000));
    const [user] = await this.rows(
      sql`SELECT limits FROM users WHERE id=${session.ownerId}`,
    );
    return {
      sessionId: id,
      bytes,
      measuredAt: Date.now(),
      limits: user?.limits ? JSON.parse(user.limits) : null,
      scope: "该会话工作文件逻辑字节数，不包含运行环境、依赖缓存及容器可写层",
    };
  }
  async usage(q: Query): Promise<UsageReport> {
    const f = filters(q, Date.now() - 7 * 86400000),
      where = requestWhere({ ...q, from: String(f.from), to: String(f.to) });
    const base = sql`FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE ${where}`;
    const [rmb] = await this.rows<UsageReport["rmb"]>(
      sql`SELECT count(*)::int AS requests,count(*) FILTER(WHERE w.state='settled')::int AS settled,count(*) FILTER(WHERE w.state='unknown')::int AS unknown,coalesce(sum(w.charged),0)::float8 AS "chargedMicro",coalesce(sum(CASE WHEN w.state IN ('reserved','unknown') THEN w.reserved ELSE 0 END),0)::float8 AS "reservedMicro",coalesce(sum(w.waived),0)::float8 AS "waivedMicro",count(*) FILTER(WHERE w.actual IS NULL)::int AS "unknownActual",count(*) FILTER(WHERE w."inputTokens" IS NULL OR w."outputTokens" IS NULL OR w."cacheReadTokens" IS NULL OR w."cacheWriteTokens" IS NULL)::int AS "unknownUsage",coalesce(sum(w."inputTokens"),0)::float8 AS "inputTokens",coalesce(sum(w."outputTokens"),0)::float8 AS "outputTokens",coalesce(sum(w."cacheReadTokens"),0)::float8 AS "cacheReadTokens",coalesce(sum(w."cacheWriteTokens"),0)::float8 AS "cacheWriteTokens",count(w."httpStatus")::int AS "httpMeasured",count(*) FILTER(WHERE w."httpStatus" BETWEEN 200 AND 299)::int AS "httpSuccess",count(w."durationMs")::int AS measured,percentile_cont(0.5) WITHIN GROUP(ORDER BY w."durationMs") AS "p50Ms",percentile_cont(0.95) WITHIN GROUP(ORDER BY w."durationMs") AS "p95Ms" ${base}`,
    );
    const daily = await this.rows<UsageReport["daily"][number]>(
      sql`SELECT to_char(to_timestamp(w."createdAt"/1000.0) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,count(*)::int AS requests,coalesce(sum(w.charged),0)::float8 AS "chargedMicro",count(*) FILTER(WHERE w.state='unknown')::int AS unknown ${base} GROUP BY day ORDER BY day`,
    );
    const models = await this.rows<UsageReport["models"][number]>(
      sql`SELECT w."modelName",w."versionId",count(*)::int AS requests,coalesce(sum(w.charged),0)::float8 AS "chargedMicro",count(*) FILTER(WHERE w.state='unknown')::int AS unknown,coalesce(sum(coalesce(w."inputTokens",0)+coalesce(w."outputTokens",0)+coalesce(w."cacheReadTokens",0)+coalesce(w."cacheWriteTokens",0)),0)::float8 AS tokens,percentile_cont(0.95) WITHIN GROUP(ORDER BY w."durationMs") AS "p95Ms" ${base} GROUP BY w."deploymentId",w."modelName",w."versionId" ORDER BY requests DESC`,
    );
    const users = await this.rows<UsageReport["users"][number]>(
      sql`SELECT w."userId",u.name AS "userName",count(*)::int AS requests,coalesce(sum(w.charged),0)::float8 AS "chargedMicro",count(*) FILTER(WHERE w.state='unknown')::int AS unknown,coalesce(sum(coalesce(w."inputTokens",0)+coalesce(w."outputTokens",0)+coalesce(w."cacheReadTokens",0)+coalesce(w."cacheWriteTokens",0)),0)::float8 AS tokens ${base} GROUP BY w."userId",u.name ORDER BY requests DESC`,
    );
    const g = [sql`g."startedAt">=${f.from}`, sql`g."startedAt"<=${f.to}`];
    if (f.user) g.push(sql`g."ownerId"=${f.user}`);
    if (f.model) g.push(sql`g."deploymentId"=${f.model}`);
    if (f.version) g.push(sql`g."versionId"=${f.version}`);
    const [usd] = await this.rows<UsageReport["usd"]>(
      sql`SELECT count(*)::int AS "observedRows",count(*) FILTER(WHERE "pricingKnown" AND "spendUsd" IS NOT NULL)::int AS "knownRows",count(*) FILTER(WHERE NOT "pricingKnown" OR "spendUsd" IS NULL)::int AS "unknownRows",sum(CASE WHEN "pricingKnown" THEN "spendUsd" END)::float8 AS "knownSpendUsd" FROM gateway_usage_events g WHERE ${sql.join(g, sql` AND `)}`,
    );
    return {
      from: f.from,
      to: f.to,
      sampledAt: Date.now(),
      rmb,
      usd,
      daily,
      models,
      users,
    };
  }
  async status(force = false): Promise<OperationsStatus> {
    if (
      !force &&
      this.snapshot &&
      Date.now() - this.snapshot.sampledAt < 15_000
    )
      return this.snapshot;
    if (this.sampling) return this.sampling;
    this.sampling = this.sample().finally(() => {
      this.sampling = undefined;
    });
    return this.sampling;
  }
  private async sample(): Promise<OperationsStatus> {
    const now = Date.now();
    await this.rows(sql`SELECT 1`);
    let gatewayState = this.llm ? "unknown" : "disabled";
    if (this.llm)
      try {
        await this.llm.client.request("/health/liveness");
        gatewayState = "ready";
      } catch {
        gatewayState = "unavailable";
      }
    const source = this.llm
      ? createHash("sha256")
          .update(this.llm.settings.managementUrl)
          .digest("hex")
          .slice(0, 16)
      : "disabled";
    const [sync] = await this.rows(
      sql`SELECT "lastSuccessAt"::float8 AS at FROM gateway_sync_state WHERE id=${source}`,
    );
    const [recent] = await this.rows<OperationsStatus["recent"]>(
      sql`SELECT count(*)::int AS requests,count(*) FILTER(WHERE state='unknown')::int AS unknown,count(*) FILTER(WHERE "httpStatus">=400)::int AS "httpErrors",count("durationMs")::int AS measured,percentile_cont(0.95) WITHIN GROUP(ORDER BY "durationMs") AS "p95Ms" FROM wallet_requests WHERE "createdAt">=${now - 86400000}`,
    );
    const enabled = !!this.llm?.settings.policy;
    const checks = [
      {
        name: "执行服务",
        state: this.manager.ready ? "ready" : "unavailable",
        detail: "会话执行服务就绪状态",
        checkedAt: now,
      },
      {
        name: "控制数据库",
        state: "ready",
        detail: "实际查询成功",
        checkedAt: now,
      },
      {
        name: "LiteLLM",
        state: gatewayState,
        detail: "仅免费存活检查，不证明供应商模型可调用",
        checkedAt: now,
      },
      {
        name: "费用同步",
        state: !enabled
          ? "disabled"
          : sync?.at && now - sync.at < 60_000
            ? "ready"
            : "stale",
        detail: enabled
          ? "最近成功导入时间，超过60秒提示"
          : "当前未启用网关用量同步",
        checkedAt: now,
      },
    ];
    if (this.tracing) {
      const t = await this.tracing.status();
      checks.push({ name: "Langfuse观测", state: t.state === "enabled" ? t.lastError ? "degraded" : "ready" : t.state === "invalid" ? "invalid" : "disabled",
        detail: t.state === "enabled" ? `待发 ${t.pending ?? "未知"}；缺口 ${t.dropped ?? "未知"}；${t.lastError ?? "云端模型记录需单独核实"}` : t.state === "invalid" ? "配置字段需检查：" + t.issues.join(",") : "未配置，不初始化或发送观测", checkedAt: now });
    }
    const signals = checks
      .filter((x) => !["ready", "disabled"].includes(x.state))
      .map((x) => ({
        id: "health:" + x.name,
        kind: "health",
        target: x.name,
        title: x.name + "状态待处理",
      }));
    const unknown = await this.rows(
      sql`SELECT id FROM wallet_requests WHERE state='unknown' AND "createdAt"<${now - 86400000} ORDER BY "createdAt" LIMIT 200`,
    );
    for (const r of unknown)
      signals.push({
        id: "request:" + r.id,
        kind: "billing",
        target: r.id,
        title: "扣费待核对超过24小时",
      });
    const models = await this.rows(
      sql`SELECT d.id,d.name FROM llm_deployments d JOIN llm_model_versions v ON v.id=d."currentVersionId" WHERE d.enabled AND d."archivedAt" IS NULL AND v.state<>'ready' LIMIT 200`,
    );
    for (const m of models)
      signals.push({
        id: "model:" + m.id,
        kind: "model",
        target: m.id,
        title: String(m.name).slice(0, 100) + "同步待确认",
      });
    await this.db.transaction(async (tx) => {
      const healthIds = signals
        .filter((s) => s.kind === "health")
        .map((s) => s.id);
      await tx.execute(sql`UPDATE admin_incidents i SET active=false,"recoveredAt"=${now},"updatedAt"=${now} WHERE active AND (
        (kind='health' ${
          healthIds.length
            ? sql`AND id NOT IN (${sql.join(
                healthIds.map((x) => sql`${x}`),
                sql`,`,
              )})`
            : sql``
        }) OR
        (kind='billing' AND NOT EXISTS(SELECT 1 FROM wallet_requests w WHERE w.id=i.target AND w.state='unknown' AND w."createdAt"<${now - 86400000})) OR
        (kind='model' AND NOT EXISTS(SELECT 1 FROM llm_deployments d JOIN llm_model_versions v ON v.id=d."currentVersionId" WHERE d.id=i.target AND d.enabled AND d."archivedAt" IS NULL AND v.state<>'ready'))
      )`);
      for (const s of signals)
        await tx.execute(
          sql`INSERT INTO admin_incidents(id,kind,target,title,active,status,"firstSeenAt","lastSeenAt","updatedAt") VALUES(${s.id},${s.kind},${s.target},${s.title},true,'open',${now},${now},${now}) ON CONFLICT(id) DO UPDATE SET active=true,"lastSeenAt"=${now},"recoveredAt"=null,"updatedAt"=${now},status=CASE WHEN admin_incidents.status='resolved' THEN 'open' ELSE admin_incidents.status END`,
        );
    });
    const incidents = await this.rows<Incident>(
      sql`SELECT id,kind,target,title,active,status,assignee,note,"firstSeenAt"::float8 AS "firstSeenAt","lastSeenAt"::float8 AS "lastSeenAt","recoveredAt"::float8 AS "recoveredAt","updatedAt"::float8 AS "updatedAt" FROM admin_incidents ORDER BY CASE WHEN status='resolved' THEN 1 ELSE 0 END,"firstSeenAt" DESC LIMIT 200`,
    );
    return (this.snapshot = {
      sampledAt: now,
      checks,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        rssBytes: process.memoryUsage().rss,
      },
      sync: { enabled, lastSuccessAt: sync?.at ?? null },
      incidents,
      recent,
    });
  }
  async updateIncident(id: string, actor: string, input: Row) {
    await this.status(true);
    if (
      !["acknowledged", "resolved", "open"].includes(input.status) ||
      typeof input.note !== "string" ||
      !input.note.trim() ||
      input.note.length > 1000
    )
      fail(400, "INCIDENT_REASON_REQUIRED");
    const assignee =
      input.assignee === undefined ? actor : String(input.assignee);
    if (assignee.length > 200) fail(400, "INVALID_ASSIGNEE");
    const [row] = await this.rows(
      sql`UPDATE admin_incidents SET status=${input.status},assignee=${assignee},note=${String(scrub(input.note))},"updatedAt"=${Date.now()} WHERE id=${id} AND (${input.status}<>'resolved' OR NOT active) RETURNING id`,
    );
    if (!row) fail(409, "INCIDENT_STILL_ACTIVE_OR_MISSING");
    this.snapshot = undefined;
    return { saved: true };
  }
  /** 预览快照只取配置和影响计数。Token校验前态，不把动态会话数量当配置版本。 */
  async preview(
    path: string,
    method: string,
    input: Row,
  ): Promise<ChangePreview> {
    let before: Row | undefined,
      affected: Row[] = [];
    let effect = "";
    let m = path.match(/^\/admin\/llm\/providers\/([^/]+)$/);
    if (m && method === "PATCH") {
      [before] = await this.rows(
        sql`SELECT id,name,format,"apiBase" FROM llm_providers WHERE id=${m[1]}`,
      );
      affected = await this.rows(
        sql`SELECT DISTINCT b."sessionId" AS id FROM llm_bindings b JOIN llm_model_versions v ON v.id=b."versionId" WHERE v."providerId"=${m[1]} AND b.state<>'revoked'`,
      );
      effect =
        "供应商地址会同步到相关版本，可能影响正在运行对话的后续模型请求；协议不在此处修改。";
    } else if (
      (m = path.match(
        /^\/admin\/llm\/deployments\/([^/]+)(?:\/(current|prices))?$/,
      )) &&
      ["PATCH", "POST"].includes(method)
    ) {
      [before] = await this.rows(
        sql`SELECT id,name,enabled,"currentVersionId","allowedUsers" FROM llm_deployments WHERE id=${m[1]}`,
      );
      if (m[2] === "prices" && before) {
        const [p] = await this.rows(
          sql`SELECT id,input::float8,output::float8,"cacheRead"::float8,"cacheWrite"::float8 FROM llm_deployment_prices WHERE "deploymentId"=${m[1]} ORDER BY "effectiveFrom" DESC,"createdAt" DESC LIMIT 1`,
        );
        before = { ...before, price: p ?? null };
      }
      affected = await this.rows(
        sql`SELECT "sessionId" AS id FROM llm_bindings WHERE "deploymentId"=${m[1]} AND state<>'revoked'`,
      );
      effect =
        m[2] === "current"
          ? "下一轮接收消息时使用新版本；已接收轮次保持原快照。"
          : m[2] === "prices"
            ? "后续模型请求使用新售价；已经预占的请求沿用价格快照，历史不重算。"
            : "缩小使用范围或停用将撤销不再允许的环境Key；原生工具停止由执行生命周期确认。";
    } else if (
      (m = path.match(/^\/admin\/llm\/versions\/([^/]+)\/costs$/)) &&
      method === "POST"
    ) {
      const [version] = await this.rows(
        sql`SELECT "providerId","upstreamModel" FROM llm_model_versions WHERE id=${m[1]}`,
      );
      if (version) {
        const [cost] = await this.rows(
          sql`SELECT * FROM llm_model_costs WHERE "providerId"=${version.providerId} AND "upstreamModel"=${version.upstreamModel} ORDER BY "effectiveFrom" DESC,"createdAt" DESC LIMIT 1`,
        );
        before = { ...version, cost: cost ?? null };
        affected = await this.rows(
          sql`SELECT DISTINCT b."sessionId" AS id FROM llm_bindings b JOIN llm_model_versions v ON v.id=b."versionId" WHERE v."providerId"=${version.providerId} AND v."upstreamModel"=${version.upstreamModel} AND b.state<>'revoked'`,
        );
      }
      effect =
        "同步同一供应商、上游模型的相关版本成本及超时；不修改人民币售价或历史费用。";
    } else fail(400, "PREVIEW_NOT_SUPPORTED");
    if (!before) fail(404, "PREVIEW_TARGET_NOT_FOUND");
    const ids = affected.map((x) => x.id);
    const [active] = ids.length
      ? await this.rows(
          sql`SELECT count(*)::int AS n FROM messages WHERE "sessionId" IN (${sql.join(
            ids.map((x) => sql`${x}`),
            sql`,`,
          )}) AND status IN ('accepted','running','finalizing','reconciling')`,
        )
      : [{ n: 0 }];
    const canonical = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, canonical(x)]),
            )
          : v;
    const token = createHash("sha256")
      .update(JSON.stringify(canonical({ path, method, input, before })))
      .digest("hex");
    return {
      token,
      before: scrub(before),
      requested: scrub(input),
      affectedSessions: ids.length,
      activeMessages: active.n,
      effect,
    };
  }
  async before(path: string): Promise<unknown> {
    // req.path保留百分号编码；记录目标主键前先与路由参数保持一致。
    try {
      path = decodeURIComponent(path);
    } catch {
      fail(400, "INVALID_ADMIN_FILTER");
    }
    let m = path.match(/^\/admin\/users\/([^/]+)$/);
    if (m)
      return (
        (
          await this.rows(
            sql`SELECT id,disabled,limits FROM users WHERE id=${m[1]}`,
          )
        )[0] ?? null
      );
    if (path === "/admin/wallet/settings")
      return (
        (
          await this.rows(
            sql`SELECT * FROM wallet_settings WHERE id='platform'`,
          )
        )[0] ?? null
      );
    if ((m = path.match(/^\/admin\/wallet\/users\/([^/]+)\/plus$/)))
      return (
        (
          await this.rows(
            sql`SELECT "userId","plusSince","plusUntil" FROM wallets WHERE "userId"=${m[1]}`,
          )
        )[0] ?? null
      );
    if ((m = path.match(/^\/admin\/wallet\/requests\/([^/]+)\/resolve$/)))
      return (
        (
          await this.rows(
            sql`SELECT id,state,reserved::float8,charged::float8 FROM wallet_requests WHERE id=${m[1]}`,
          )
        )[0] ?? null
      );
    if ((m = path.match(/^\/admin\/operations\/incidents\/([^/]+)$/)))
      return (
        (
          await this.rows(
            sql`SELECT id,status,active,assignee,note,"recoveredAt" FROM admin_incidents WHERE id=${m[1]}`,
          )
        )[0] ?? null
      );
    return null;
  }
  async auditStart(actor: string, path: string, method: string, input: Row) {
    const id = randomUUID();
    let before = await this.before(path);
    if (path.startsWith("/admin/llm/"))
      try {
        before = (await this.preview(path, method, input)).before;
      } catch {}
    await this.db.execute(
      sql`INSERT INTO admin_audit(id,actor,action,target,before,requested,outcome,"createdAt") VALUES(${id},${actor},${method},${path},${JSON.stringify(scrub(before))}::jsonb,${JSON.stringify(scrub(input))}::jsonb,'unconfirmed',${Date.now()})`,
    );
    return id;
  }
  async auditFinish(id: string, status: number, result: unknown) {
    await this.db.execute(
      sql`UPDATE admin_audit SET outcome=${status < 400 ? "succeeded" : "failed"},result=${JSON.stringify(scrub(result))}::jsonb,"finishedAt"=${Date.now()} WHERE id=${id}`,
    );
  }
  async export(kind: string, q: Query) {
    const query = { ...q, offset: "0", limit: "5000" };
    const page =
      kind === "requests"
        ? await this.requests(query)
        : kind === "ledger"
          ? await this.ledger(query)
          : kind === "audit"
            ? await this.audits(query)
            : fail(400, "INVALID_EXPORT_KIND");
    const fields =
      kind === "requests"
        ? [
            "id",
            "userId",
            "sessionId",
            "messageId",
            "modelName",
            "versionId",
            "state",
            "createdAt",
            "finishedAt",
            "reserved",
            "actual",
            "charged",
            "waived",
            "inputTokens",
            "outputTokens",
            "gatewayCallId",
          ]
        : kind === "ledger"
          ? [
              "id",
              "userId",
              "kind",
              "amount",
              "balanceAfter",
              "createdAt",
              "note",
            ]
          : [
              "id",
              "actor",
              "action",
              "target",
              "outcome",
              "createdAt",
              "finishedAt",
              "source",
            ];
    const labels: Record<string, string> = {
      id: "记录编号",
      userId: "用户编号",
      sessionId: "会话编号",
      messageId: "轮次编号",
      modelName: "模型",
      versionId: "版本编号",
      state: "状态",
      createdAt: "创建时间（UTC）",
      finishedAt: "完成时间（UTC）",
      reserved: "预占（元）",
      actual: "实际费用（元）",
      charged: "已扣（元）",
      waived: "免收（元）",
      inputTokens: "输入Token",
      outputTokens: "输出Token",
      gatewayCallId: "网关调用编号",
      kind: "流水类型",
      amount: "金额（元）",
      balanceAfter: "变更后余额（元）",
      note: "备注",
      actor: "操作人",
      action: "动作",
      target: "目标",
      outcome: "结果",
      source: "来源",
    };
    const cell = (key: string, v: unknown) =>
      csvCell(
        v === null || v === undefined
          ? v
          : [
                "reserved",
                "actual",
                "charged",
                "waived",
                "amount",
                "balanceAfter",
              ].includes(key)
            ? Number(v) / 1e6
            : ["createdAt", "finishedAt"].includes(key)
              ? new Date(Number(v)).toISOString()
              : v,
      );
    const csv =
      "\uFEFF" +
      [
        fields.map((key) => csvCell(labels[key] ?? key)).join(","),
        ...page.items.map((r) =>
          fields.map((k) => cell(k, (r as unknown as Row)[k])).join(","),
        ),
      ].join("\r\n");
    return {
      filename:
        "harbor-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".csv",
      csv,
      total: page.total,
      exported: page.items.length,
      partial: page.total > page.items.length,
      units: "人民币金额以元导出，时间为ISO 8601（UTC）",
    };
  }
}
