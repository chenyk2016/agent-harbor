/** 有界原始数据计算：人数不能按小时相加，百分位不能取平均；超过范围明确显示partial。 */
import type { Analytics } from "./contract.js";
export type Row = {
  event_name: string;
  event_version: number;
  occurred_at: string | number;
  received_at: string | number;
  anonymous_id: string | null;
  session_id: string | null;
  request_id: string | null;
  revision_id: string;
  client_revision_id: string | null;
  definition_hash: string;
  deployment_id: string;
  source: string;
  properties: Record<string, any>;
};
const countBy = (rows: Row[], key: (r: Row) => string) =>
  Object.entries(
    rows.reduce<Record<string, number>>((a, r) => {
      const k = key(r);
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {}),
  )
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
const percentile = (values: number[], p: number) =>
  values.length
    ? values.toSorted((a, b) => a - b)[
        Math.max(0, Math.ceil(values.length * p) - 1)
      ]
    : null;
export function report(
  rows: Row[],
  definition: Analytics,
  definitionHash: string,
  partial = false,
  asOf = Date.now(),
) {
  const page = rows.filter((r) => r.event_name === "page_view"),
    requests = rows.filter(
      (r) =>
        r.event_name === "http_request" &&
        String(r.properties.route).startsWith("/api"),
    );
  const goal = rows.filter(
    (r) =>
      r.source === "server" &&
      r.event_name === definition.primaryGoal &&
      r.event_version === definition.events[definition.primaryGoal!]?.version,
  );
  const unique = (r: Row[], key: "anonymous_id" | "session_id") =>
    new Set(r.map((e) => e[key]).filter(Boolean)).size;
  const valid = rows.filter(
    (r) => r.event_name === "page_view" || r.definition_hash === definitionHash,
  );
  const funnels = definition.funnels.map((f) => {
    const sessions = new Map<string, Row[]>();
    for (const r of valid)
      if (r.session_id) {
        const list = sessions.get(r.session_id) ?? [];
        list.push(r);
        sessions.set(r.session_id, list);
      }
    const counts = f.steps.map(() => 0);
    let ambiguous = 0;
    for (const events of sessions.values()) {
      events.sort(
        (a, b) =>
          Number(a.occurred_at) - Number(b.occurred_at) ||
          Number(a.properties.sequence ?? 0) -
            Number(b.properties.sequence ?? 0),
      );
      let step = 0,
        start = 0,
        last: Row | undefined;
      for (const e of events) {
        if (e.event_name !== f.steps[step]) continue;
        if (step && Number(e.occurred_at) - start > f.windowMinutes * 60000)
          break;
        if (
          last &&
          Number(e.occurred_at) === Number(last.occurred_at) &&
          e.source !== last.source
        ) {
          ambiguous++;
          continue;
        }
        if (!step) start = Number(e.occurred_at);
        counts[step]++;
        step++;
        last = e;
        if (step === f.steps.length) break;
      }
    }
    return {
      ...f,
      steps: f.steps.map((name, i) => ({
        name,
        count: counts[i],
        conversion: counts[0] ? counts[i] / counts[0] : null,
      })),
      ambiguous,
    };
  });
  const vital = rows.filter((r) => r.event_name === "web_vital"),
    finalVitals = new Map<string, Row>();
  for (const r of vital) {
    const key =
      r.deployment_id + ":" + r.anonymous_id + ":" + r.properties.metricId;
    const old = finalVitals.get(key);
    if (!old || Number(old.received_at) < Number(r.received_at))
      finalVitals.set(key, r);
  }
  const errorRows = rows.filter((r) => r.event_name === "page_error");
  const health = rows
    .filter((r) => r.event_name === "health_check")
    .sort((a, b) => Number(a.occurred_at) - Number(b.occurred_at));
  const alerts = [];
  if (
    health.length >= 3 &&
    health.slice(-3).every((r) => r.properties.healthy === false)
  )
    alerts.push({ name: "连续三次健康检查失败", state: "firing" });
  const recent = requests.filter(
    (r) => Number(r.occurred_at) > asOf - 300000,
  );
  if (
    recent.length >= 100 &&
    recent.filter((r) => r.properties.status >= 500).length / recent.length >
      0.05
  )
    alerts.push({ name: "近5分钟接口5xx超过5%", state: "firing" });
  return {
    partial,
    definitionHash,
    primaryGoal: definition.primaryGoal ?? null,
    summary: {
      pageViews: page.length,
      visitors: unique(page, "anonymous_id"),
      sessions: unique(page, "session_id"),
      unidentifiedPageViews: page.filter((r) => !r.anonymous_id).length,
      goals: goal.length,
      edgeRequests: rows.filter((r) => r.event_name === "edge_request").length,
      apiRequests: requests.length,
      apiFailures: requests.filter((r) => r.properties.status >= 500).length,
      aborted: requests.filter((r) => r.properties.aborted).length,
      p95Ms: percentile(
        requests.map((r) => Number(r.properties.durationMs)),
        0.95,
      ),
      pageErrors: errorRows.length,
    },
    channels: countBy(page, (r) => String(r.properties.channel ?? "unknown")),
    devices: countBy(page, (r) => String(r.properties.device ?? "unknown")),
    daily: countBy(page, (r) =>
      new Date(Number(r.occurred_at)).toISOString().slice(0, 10),
    ),
    events: countBy(rows, (r) => r.event_name),
    errors: countBy(
      errorRows,
      (r) =>
        `${r.properties.kind ?? "Error"} · ${r.client_revision_id ?? r.revision_id} · ${r.properties.line ?? 0}:${r.properties.column ?? 0}`,
    ),
    statuses: countBy(requests, (r) => String(r.properties.status)),
    vitals: ["LCP", "INP", "CLS"].map((metric) => {
      const values = [...finalVitals.values()]
        .filter((r) => r.properties.metric === metric)
        .map((r) => Number(r.properties.value));
      return { metric, samples: values.length, p75: percentile(values, 0.75) };
    }),
    resources: rows
      .filter((r) => r.event_name === "resource_sample")
      .slice(-20)
      .map((r) => ({
        at: Number(r.occurred_at),
        deploymentId: r.deployment_id,
        ...r.properties,
      })),
    versions: countBy(rows, (r) => r.client_revision_id ?? r.revision_id).map(
      (v) => {
        const group = rows.filter(
          (r) => (r.client_revision_id ?? r.revision_id) === v.name,
        );
        return {
          revisionId: v.name,
          pageViews: group.filter((r) => r.event_name === "page_view").length,
          goals: group.filter(
            (r) =>
              r.source === "server" && r.event_name === definition.primaryGoal,
          ).length,
          errors: group.filter((r) => r.event_name === "page_error").length,
        };
      },
    ),
    funnels,
    alerts,
  };
}
