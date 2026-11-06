/** 平台固定Runtime观测：公开行为只走browser通道，成功结果进入本业务库事务outbox。 */
import express from "express";
import { randomUUID } from "node:crypto";
export function observations(configuration, manifest, pool) {
  const enabled = !!configuration.observation;
  const pending = [];
  let sending = false,
    dropped = 0;
  const identity = {
    appId: configuration.appId,
    revisionId: configuration.revisionId,
    buildId: configuration.buildId,
    deploymentId: configuration.deploymentId,
    basePath: configuration.basePath,
    observationVersion: enabled ? 1 : null,
  };
  const event = (name, properties = {}, context = {}) => ({
    eventId: randomUUID(),
    eventName: name,
    eventVersion: manifest.analytics?.events?.[name]?.version ?? 1,
    occurredAt: Date.now(),
    ...context,
    properties,
  });
  const send = async (source, events) => {
    if (!enabled) return false;
    try {
      const r = await fetch(
        configuration.observation.url + "/internal/observations/batch",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + configuration.observation.token,
          },
          body: JSON.stringify({ source, events }),
          signal: AbortSignal.timeout(1500),
        },
      );
      return r.ok;
    } catch {
      return false;
    }
  };
  const flush = async () => {
    if (sending || !pending.length || !enabled) return;
    sending = true;
    const batch = pending.splice(0, 20);
    try {
      if (!(await send("runtime", batch))) dropped += batch.length;
    } finally {
      sending = false;
    }
  };
  const timer = enabled ? setInterval(() => void flush(), 5000) : undefined;
  timer?.unref();
  function mount(router) {
    if (!enabled) return;
    const rates = new Map();
    router.post(
      "/__harbor/observe/browser",
      express.json({ limit: "32kb", type: () => true, inflate: false }),
      async (req, res) => {
        const now = Date.now(),
          key = req.ip;
        let rate = rates.get(key);
        if (!rate || now - rate.at > 60000) {
          rate = { at: now, n: 0 };
          rates.set(key, rate);
        }
        if (++rate.n > 120) return res.status(429).end();
        if (rates.size > 2000)
          for (const [key, r] of rates)
            if (now - r.at > 60000) rates.delete(key);
        const events = req.body?.events;
        if (!Array.isArray(events) || events.length > 20)
          return res.status(400).json({ error: "INVALID_BATCH" });
        // 不接受客户端选择source；Collector再按部署固定契约验证每一条。
        const ok = await send("browser", events);
        if (!ok) dropped += events.length;
        res.status(ok ? 202 : 503).json({ accepted: ok });
      },
    );
  }
  function requests(req, res, next) {
    if (!enabled || !req.path.startsWith("/api")) return next();
    const requestId = randomUUID(),
      start = performance.now();
    res.setHeader("X-Request-Id", requestId);
    req.harborRequestId = requestId;
    let ended = false;
    const done = (aborted) => {
      if (ended) return;
      ended = true;
      const route = String(req.route?.path ?? "/api/unknown");
      const normalized =
        route.startsWith("/api/") && /^\/[a-z_/:]+$/.test(route)
          ? route
          : "/api/unknown";
      if (pending.length >= 200) {
        dropped++;
        return;
      }
      pending.push(
        event(
          "http_request",
          {
            route: normalized,
            method: req.method,
            status: aborted ? 0 : res.statusCode,
            durationMs: Math.round((performance.now() - start) * 100) / 100,
            aborted,
          },
          { requestId },
        ),
      );
    };
    res.once("finish", () => done(false));
    res.once("close", () => done(!res.writableFinished));
    next();
  }
  const context = (req) => {
    const valid = (v) =>
      typeof v === "string" && /^[a-f0-9-]{16,64}$/.test(v) ? v : undefined;
    return Object.fromEntries(
      Object.entries({
        anonymousId: valid(req.get("X-App-Visitor")),
        sessionId: valid(req.get("X-App-Visit")),
        requestId: req.harborRequestId,
        clientRevisionId: valid(req.get("X-App-Revision")),
      }).filter(([, v]) => v !== undefined),
    );
  };
  async function emit(client, name, properties = {}, ctx = {}) {
    if (!enabled) return;
    const definition = manifest.analytics?.events?.[name];
    if (!definition || definition.source !== "server")
      throw new Error("UNKNOWN_SERVER_EVENT");
    if (
      !properties ||
      Object.entries(properties).some(([k, v]) => {
        const p = definition.properties[k];
        return (
          !Object.hasOwn(definition.properties, k) ||
          ("enum" in p
            ? typeof v !== "string" || !p.enum.includes(v)
            : typeof v !== p.type ||
              (p.type === "number" && !Number.isFinite(v)))
        );
      })
    )
      throw new Error("INVALID_EVENT_PROPERTIES");
    // SAVEPOINT只包观测写入，观测满额不回滚已成功的业务写入。
    await client.query("SAVEPOINT harbor_observation");
    try {
      await client.query("SELECT pg_advisory_xact_lock(17926072)");
      const size = await client.query(
        "SELECT count(*) AS n FROM (SELECT 1 FROM harbor_observation_outbox LIMIT 10001) t",
      );
      if (Number(size.rows[0].n) >= 10000) throw new Error("OUTBOX_LIMIT");
      const e = event(name, properties, ctx);
      await client.query(
        "INSERT INTO harbor_observation_outbox(id,deployment_id,event,created_at) VALUES($1,$2,$3,$4)",
        [e.eventId, configuration.deploymentId, e, e.occurredAt],
      );
      await client.query("RELEASE SAVEPOINT harbor_observation");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT harbor_observation");
      dropped++;
      try {
        await client.query(
          "INSERT INTO harbor_observation_state(key,value) VALUES('outbox_dropped',1) ON CONFLICT(key) DO UPDATE SET value=harbor_observation_state.value+1",
        );
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT harbor_observation");
      }
      await client.query("RELEASE SAVEPOINT harbor_observation");
    }
  }
  async function transaction(work) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await work(c, (name, properties, ctx) =>
        emit(c, name, properties, ctx),
      );
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  return {
    identity,
    mount,
    requests,
    context,
    emit,
    transaction,
    get dropped() {
      return dropped;
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
