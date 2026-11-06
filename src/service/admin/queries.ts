/** 所有搜索在服务端执行；SQL字段/排序固定，值参数化。 */
import { sql, type SQL } from "drizzle-orm";
import { fail } from "../types.js";
export type Query = Record<string, unknown>;
export function value(q: Query, key: string, max = 200): string {
  const v = q[key];
  if (v === undefined || v === "") return "";
  if (typeof v !== "string" || v.length > max)
    fail(400, "INVALID_ADMIN_FILTER");
  return v;
}
export function integer(v: unknown, fallback: number, max: number) {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    fail(400, "INVALID_ADMIN_FILTER");
  return n;
}
export function time(q: Query, key: string, fallback: number) {
  const v = value(q, key, 50);
  if (!v) return fallback;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isSafeInteger(n) || n < 0) fail(400, "INVALID_ADMIN_FILTER");
  return n;
}
export function filters(q: Query, defaultFrom = 0) {
  const from = time(q, "from", defaultFrom),
    to = time(q, "to", Date.now());
  if (from > to) fail(400, "INVALID_DATE_RANGE");
  return {
    from,
    to,
    user: value(q, "user"),
    model: value(q, "model"),
    version: value(q, "version"),
    q: value(q, "q"),
    state: value(q, "state"),
    offset: integer(q.offset, 0, 10_000_000),
    limit: Math.max(1, integer(q.limit, 50, 5000)),
  };
}
export function contains(text: string) {
  return "%" + text.replace(/[\\%_]/g, "\\$&") + "%";
}
export function requestWhere(q: Query, defaultFrom = 0): SQL {
  const f = filters(q, defaultFrom),
    parts = [sql`w."createdAt" >= ${f.from}`, sql`w."createdAt" <= ${f.to}`];
  if (f.user) parts.push(sql`w."userId" = ${f.user}`);
  if (f.model) parts.push(sql`w."deploymentId" = ${f.model}`);
  if (f.version) parts.push(sql`w."versionId" = ${f.version}`);
  if (f.state) {
    if (!["reserved", "unknown", "settled"].includes(f.state))
      fail(400, "INVALID_ADMIN_FILTER");
    parts.push(sql`w.state = ${f.state}`);
  }
  if (f.q) {
    const p = contains(f.q);
    parts.push(
      sql`(w.id ILIKE ${p} OR w."sessionId" ILIKE ${p} OR w."userId" ILIKE ${p} OR u.name ILIKE ${p} OR w."modelName" ILIKE ${p} OR w.note ILIKE ${p} OR w."gatewayCallId" ILIKE ${p})`,
    );
  }
  if (q.age === "24h")
    parts.push(sql`w."createdAt" <= ${Date.now() - 86400000}`);
  else if (q.age !== undefined && q.age !== "" && q.age !== "all")
    fail(400, "INVALID_ADMIN_FILTER");
  return sql.join(parts, sql` AND `);
}
export const requestFields = sql`w.id, w."userId", u.name AS "userName", w."sessionId", w."messageId", w."deploymentId", w."versionId", w."modelName", w.state,
  w.reserved::float8, w.actual::float8, w.charged::float8, w.waived::float8,
  w."inputTokens"::float8, w."outputTokens"::float8, w."cacheReadTokens"::float8, w."cacheWriteTokens"::float8,
  w."createdAt"::float8, w."finishedAt"::float8, w."durationMs"::float8, w."httpStatus", w."failureCode", w."gatewayCallId"`;
/** 只允许结构化元数据；嵌套密钥、URL凭据和正文均不进入审计。 */
export function scrub(input: unknown, depth = 0): unknown {
  if (depth > 5) return "[limited]";
  if (input === null || typeof input === "number" || typeof input === "boolean")
    return input;
  if (typeof input === "string") {
    if (/^(?:https?|postgres):\/\//i.test(input)) {
      try {
        const u = new URL(input);
        return u.origin + u.pathname;
      } catch {
        return "[invalid URL]";
      }
    }
    return input
      .slice(0, 1500)
      .replace(/\b(?:sk-|ahw-)[A-Za-z0-9_-]+/g, "[redacted]");
  }
  if (Array.isArray(input))
    return input.slice(0, 100).map((v) => scrub(v, depth + 1));
  if (input && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .slice(0, 60)
        .map(([k, v]) => [
          k,
          /secret|token|password|api.?key|authorization|cookie|prompt|command|content|transcript|connection|string|headers|text|body/i.test(
            k,
          )
            ? "[redacted]"
            : scrub(v, depth + 1),
        ]),
    );
  return null;
}
export function csvCell(input: unknown) {
  let s =
    input === null || input === undefined
      ? ""
      : typeof input === "object"
        ? JSON.stringify(scrub(input))
        : String(input);
  if (typeof input !== "number" && /^[\s]*[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
