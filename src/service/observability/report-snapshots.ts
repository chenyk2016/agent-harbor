import { randomUUID } from "node:crypto";
import type { ObservationService } from "./service.js";
import { fail } from "../types.js";

export const reportSections = ["overview", "funnel", "quality", "versions"] as const;
type Section = typeof reportSections[number];
export type AnalysisEnvironment = "preview" | "production";

type ReportData = Awaited<ReturnType<ObservationService["summary"]>>;
type Snapshot = {
  id: string; app_id: string; environment: AnalysisEnvironment; message_id: string;
  days: number; from_at: string; as_of: string; expires_at: string;
  data: ReportData & { projectionTruncated?: boolean };
};

export function reportParameters(value: unknown) {
  if (!value || typeof value !== "object") fail(400, "INVALID_REPORT_QUERY");
  const { days, section } = value as { days: number; section: Section };
  if (Object.keys(value).length !== 2 || ![1, 7, 30].includes(days) || !reportSections.includes(section))
    fail(400, "INVALID_REPORT_QUERY");
  return { days, section };
}

export async function snapshotReport(observation: ObservationService, owner: string, app: string,
  environment: AnalysisEnvironment, message: string, days: number, signal: AbortSignal): Promise<Snapshot | undefined> {
  signal.throwIfAborted();
  const pool = observation.store.pool;
  const c = await pool.connect();
  const lock = app + ":" + environment;
  let locked = false;
  try {
    // Take the scope lock before opening a read snapshot, so a concurrent erase cannot be read from its old MVCC view.
    await c.query("SELECT pg_advisory_lock(hashtextextended($1,1))", [lock]);
    locked = true;
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const old = (await c.query<Snapshot>(
      "SELECT * FROM observation_report_snapshots WHERE message_id=$1 AND days=$2 AND expires_at>$3",
      [message, days, Date.now()])).rows[0];
    if (old) {
      if (old.app_id !== app || old.environment !== environment) fail(404, "REPORT_NOT_FOUND");
      await c.query("COMMIT");
      return old;
    }
    const scope = async () => (await observation.applications.store.endpoints(app)).find(item => item.environment === environment);
    const before = await scope();
    const asOf = Date.now();
    const data = await observation.summary(owner, app, environment, days, c, asOf);
    const after = await scope();
    signal.throwIfAborted();
    if (before?.generation !== after?.generation || before?.appliedDeploymentId !== after?.appliedDeploymentId)
      fail(409, "REPORT_DEPLOYMENT_CHANGED");
    if (!("summary" in data)) {
      await c.query("COMMIT");
      return undefined;
    }
    // Raw worker state and analysis settings stay on the live management response.
    let projectionTruncated = false;
    const limited = <T>(values: T[]) => {
      if (values.length > 100) projectionTruncated = true;
      return values.slice(0, 100);
    };
    const safe = { ...data, states: [], analysisConfig: { ...data.analysisConfig, events: {} },
      channels: limited(data.channels), devices: limited(data.devices), events: limited(data.events),
      errors: limited(data.errors), statuses: limited(data.statuses), versions: limited(data.versions),
      projectionTruncated };
    if (Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024) fail(413, "REPORT_SIZE_LIMIT");
    const result = await c.query<Snapshot>(
      `INSERT INTO observation_report_snapshots(id,app_id,environment,message_id,days,from_at,as_of,expires_at,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), app, environment, message, days, asOf - days * 86400000, asOf, asOf + 7 * 86400000, safe]);
    signal.throwIfAborted();
    await c.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    let bad = false;
    if (locked) await c.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [lock]).catch(() => { bad = true; });
    c.release(bad);
  }
}

export function snapshotView(snapshot: Snapshot) {
  return { reportId: snapshot.id, environment: snapshot.environment, days: snapshot.days,
    from: Number(snapshot.from_at), asOf: Number(snapshot.as_of), expiresAt: Number(snapshot.expires_at),
    data: snapshot.data };
}
export function modelReport(snapshot: Snapshot, section: Section) {
  const { data, expiresAt: _expires, ...scope } = snapshotView(snapshot);
  if (!("summary" in data) || !data.summary) return { status: data.status };
  const coverage = { status: data.status, lastReceivedAt: data.lastReceivedAt, partial: data.partial,
    activeDeploymentInstrumented: data.activeDeploymentInstrumented, browserEventsReceived: data.browserEventsReceived,
    projectionTruncated: data.projectionTruncated, activeRevisionId: data.activeRevisionId,
    analysisConfigVersion: data.effectiveAnalysisConfigVersion, definitionHash: data.definitionHash };
  const details = {
    overview: { summary: data.summary, daily: data.daily, devices: data.devices, events: data.events.slice(0, 20) },
    funnel: { funnels: data.funnels, primaryGoal: data.primaryGoal, goals: data.summary.goals },
    quality: { summary: data.summary, statuses: data.statuses, errors: data.errors.slice(0, 20), vitals: data.vitals },
    versions: { versions: data.versions.slice(0, 20), goals: data.summary.goals },
  };
  const truncated = (section === "overview" && data.events.length > 20) ||
    (section === "quality" && data.errors.length > 20) || (section === "versions" && data.versions.length > 20);
  const value = { ...scope, section, coverage: { ...coverage, toolTruncated: truncated }, data: details[section] };
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) {
    return { ...scope, section, coverage: { ...coverage, toolTruncated: true },
      data: { summary: data.summary } };
  }
  return value;
}
export async function openSnapshot(observation: ObservationService, app: string, reportId: string) {
  const row = (await observation.store.pool.query<Snapshot>(
    "SELECT * FROM observation_report_snapshots WHERE id=$1 AND app_id=$2 AND expires_at>$3",
    [reportId, app, Date.now()])).rows[0];
  if (!row) fail(404, "REPORT_NOT_FOUND_OR_EXPIRED");
  return snapshotView(row);
}
