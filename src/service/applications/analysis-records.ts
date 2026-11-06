/** Model-facing table directory and bounded read-only pages for one authorized application environment. */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { catalogInput, recordsInput } from "../../agent/app-analysis/tool-contract.js";
import type { AnalysisEnvironment } from "../observability/report-snapshots.js";
import { fail } from "../types.js";
import type { ApplicationService } from "./service.js";
import { readBusinessData } from "./table-query.js";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const grantsSchema = z.record(z.uuid(), z.partialRecord(z.enum(["preview", "production"]),
  z.record(identifier, z.array(identifier).max(40))));
type Grants = z.infer<typeof grantsSchema>;
type Cursor = {
  dataset: string; from?: string; to?: string; columns?: string[]; limit?: number;
  after: { time: string; id: string } | string[];
};

const eventDataset = "observability.events";
const eventColumns = ["occurred_at", "received_at", "event_name", "event_version", "source", "deployment_id", "revision_id"];
export function analysisTableGrants(value: string | undefined): Grants {
  return value ? grantsSchema.parse(JSON.parse(value)) : {};
}

export class ApplicationAnalysisRecords {
  private readonly cursors = new Map<string, Cursor>();

  constructor(private readonly apps: ApplicationService, private readonly observation: Pool,
    private readonly owner: string, private readonly app: string, private readonly environment: AnalysisEnvironment, private readonly grants: Grants) {}

  private reader() {
    return { kind: "agent" as const, fields: this.grants[this.app]?.[this.environment] ?? {} };
  }

  async catalog(args: unknown) {
    if (!catalogInput.safeParse(args).success) fail(400, "INVALID_DATASET_QUERY");
    const { tables } = await readBusinessData(this.apps, this.owner, this.app, this.environment, this.reader());
    const datasets = tables.map(table => ({
      dataset: "business." + table.name,
      timeField: table.columns.some(column => column.name === "created_at" && column.readable &&
        /^timestamp/.test(column.type)) ? "created_at" : null,
      columns: table.columns.map(({ name, type, readable }) => ({ name, type, readable })),
    }));
    return { environment: this.environment, businessReady: tables.length > 0, datasets: [...datasets, {
      dataset: eventDataset, timeField: "occurred_at",
      columns: eventColumns.map(name => ({ name, readable: true,
        type: name.endsWith("_at") ? "epoch_milliseconds" : name === "event_version" ? "number" : "text" })),
    }] };
  }

  async read(args: unknown) {
    const input = recordsInput.safeParse(args);
    if (!input.success) fail(400, "INVALID_DATASET_QUERY");
    const { dataset, cursor } = input.data;
    const previous = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (previous?.dataset !== dataset || Object.keys(input.data).length !== 2))
      fail(400, "INVALID_DATASET_CURSOR");
    const query = previous ?? input.data;
    const { from, to, columns, limit = 20 } = query;
    if (from && to && Date.parse(from) >= Date.parse(to)) fail(400, "INVALID_DATASET_TIME_RANGE");
    if (dataset !== eventDataset) {
      if (!dataset.startsWith("business.")) fail(404, "DATASET_NOT_FOUND");
      const result = await readBusinessData(this.apps, this.owner, this.app, this.environment, this.reader(), {
        table: dataset.slice("business.".length), columns, limit, from, to,
        after: Array.isArray(previous?.after) ? previous.after : undefined,
      });
      let nextCursor: string | null = null;
      if (result.next) {
        nextCursor = randomUUID();
        this.cursors.set(nextCursor, { dataset, from, to, columns, limit, after: result.next });
      }
      return { dataset, environment: this.environment, columns: result.columns, rows: result.rows,
        textLimit: 256, nextCursor };
    }
    const selected = columns ?? eventColumns;
    if (selected.some(name => !eventColumns.includes(name)) || new Set(selected).size !== selected.length)
      fail(403, "DATASET_COLUMN_UNAVAILABLE");
    const time = "occurred_at";
    const values: unknown[] = [];
    const param = (value: unknown) => "$" + values.push(value);
    const conditions = ["app_id=" + param(this.app), "environment=" + param(this.environment)];
    if (from) conditions.push(time + ">=" + param(Date.parse(from)));
    if (to) conditions.push(time + "<" + param(Date.parse(to)));
    if (previous && !Array.isArray(previous.after))
      conditions.push(`(${time},id)<(${param(previous.after.time)},${param(previous.after.id)})`);
    const projection = selected.map(name => `"${name}"`);
    const result = await this.observation.query(`SELECT ${projection.join(",")}, ${time}::text AS "__cursor_time", id::text AS "__cursor_id"
      FROM observation_events WHERE ${conditions.join(" AND ")}
      ORDER BY ${time} DESC,id DESC LIMIT ${param(limit + 1)}`, values);
    const rows = [];
    let bytes = 0, after: Cursor["after"] | undefined;
    for (const { __cursor_time, __cursor_id, ...row } of result.rows.slice(0, limit)) {
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > 15 * 1024) break;
      rows.push(row);
      after = { time: __cursor_time, id: __cursor_id };
    }
    if (result.rows.length && !after) fail(413, "DATASET_ROW_TOO_LARGE");
    let nextCursor: string | undefined;
    if (after && result.rows.length > rows.length) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, { dataset, from, to, columns, limit, after });
    }
    return { dataset, environment: this.environment, columns: selected, rows,
      nextCursor: nextCursor ?? null };
  }
}
