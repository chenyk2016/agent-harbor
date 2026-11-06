/** 工作台和问数的业务库只读入口。范围和字段授权在宿主上判定。 */
import { Pool, type PoolClient } from "pg";
import type { ApplicationService } from "./service.js";
import type { AppEnvironment } from "./data.js";
import { businessTable } from "./migrations.js";
import { fail } from "../types.js";

type TableColumn = { name: string; type: string; required: boolean; default: string | null; readable: boolean };
type BusinessTable = { name: string; columns: TableColumn[]; primaryKey: string[]; indexes: string[] };
type RecordQuery = { table: string; columns?: string[]; limit: number; from?: string; to?: string; after?: string[] };
/** 同一权限入口中，owner 只给工作台，agent 保留现有字段白名单。 */
export type DataReader = { kind: "owner" } | { kind: "agent"; fields: Record<string, string[]> };

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const platformFields: Record<string, string> = {
  id: "uuid", created_at: "timestamp with time zone", updated_at: "timestamp with time zone",
};

async function catalog(client: PoolClient, reader: DataReader) {
  const { rows } = await client.query<BusinessTable>(`
    SELECT c.relname AS name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped), '[]') AS columns,
      ARRAY(SELECT a.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(n,pos)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n
        WHERE i.indrelid=c.oid AND i.indisprimary AND k.pos <= i.indnkeyatts ORDER BY k.pos) AS "primaryKey",
      ARRAY(SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid=c.oid ORDER BY i.indexrelid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege(c.oid,'SELECT')
    ORDER BY c.relname LIMIT 250`);
  return rows.filter(table => businessTable(table.name)).map(table => ({
    ...table,
    indexes: reader.kind === "owner" ? table.indexes : [],
    columns: table.columns.map(column => ({
      ...column,
      default: reader.kind === "owner" ? column.default : null,
      readable: reader.kind === "owner" || platformFields[column.name] === column.type ||
        (Object.hasOwn(reader.fields, table.name) && reader.fields[table.name].includes(column.name)),
    })),
  }));
}

/** 每次重新核对应用归属与账号状态，并连接选定环境。查询事务禁止写入。 */
export async function readBusinessData(
  apps: ApplicationService, owner: string, app: string, environment: AppEnvironment,
  reader: DataReader, query?: RecordQuery,
) {
  await apps.store.owned(owner, app);
  await apps.sessions.identity.require(owner);
  const state = await apps.data.openIfExists(app, environment);
  if (!state) {
    if (query) fail(404, reader.kind === "owner" ? "APPLICATION_TABLE_NOT_FOUND" : "DATASET_NOT_FOUND");
    return { tables: [], rows: [], columns: [], next: null };
  }
  const pool = new Pool({ connectionString: apps.data.connection(state), max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const tables = await catalog(client, reader);
      if (!query) return { tables, rows: [], columns: [], next: null };
      const table = tables.find(value => value.name === query.table);
      if (!table) fail(404, reader.kind === "owner" ? "APPLICATION_TABLE_NOT_FOUND" : "DATASET_NOT_FOUND");
      const readable = table.columns.filter(column => column.readable);
      const selected = query.columns ?? readable.slice(0, reader.kind === "agent" ? 10 : 60).map(column => column.name);
      if (!selected.length || new Set(selected).size !== selected.length ||
          selected.some(name => !readable.some(column => column.name === name)))
        fail(403, "DATASET_COLUMN_UNAVAILABLE");

      const time = readable.find(column => column.name === "created_at" && /^timestamp/.test(column.type));
      const order = time?.required && table.primaryKey.length
        ? [time.name, ...table.primaryKey.filter(name => name !== time.name)] : table.primaryKey;
      const values: unknown[] = [];
      const param = (value: unknown) => "$" + values.push(value);
      const where = [];
      if ((query.from || query.to) && !time) fail(400, "INVALID_DATASET_TIME_RANGE");
      if (query.from) where.push(`source."created_at">=${param(query.from)}`);
      if (query.to) where.push(`source."created_at"<${param(query.to)}`);
      if (query.after) {
        if (!order.length || order.length !== query.after.length) fail(400, "INVALID_DATASET_CURSOR");
        where.push(`(${order.map(name => "source." + identifier(name))})<(${query.after.map(param)})`);
      }
      // 使用位置式投影保留 PostgreSQL 类型，业务列名不会与内部游标冲突。
      const projection = selected.map(name => {
        const key = identifier(name);
        const type = readable.find(column => column.name === name)!.type;
        return reader.kind === "agent" && /^(text|character)/.test(type)
          ? `left(${key},256) AS ${key}` : key;
      }).join(",");
      const orderSql = order.length ? " ORDER BY " + order.map(name => "source." + identifier(name) + " DESC").join(",") : "";
      const position = order.length
        ? `,ARRAY[${order.map(name => "source." + identifier(name) + "::text")}]` : "";
      const { rows: raw } = await client.query({
        text: `SELECT ${projection}${position} FROM public.${identifier(table.name)} source
          ${where.length ? "WHERE " + where.join(" AND ") : ""}${orderSql} LIMIT ${param(query.limit + 1)}`,
        values, rowMode: "array",
      });
      const rows = [];
      let bytes = 0, after: string[] | undefined;
      for (const values of raw.slice(0, query.limit)) {
        const record = Object.fromEntries(selected.map((name, index) => [name, values[index]]));
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > (reader.kind === "agent" ? 15 * 1024 : 256 * 1024)) break;
        rows.push(record);
        after = order.length ? values[selected.length] : undefined;
      }
      if (raw.length && !rows.length) fail(413, "DATASET_ROW_TOO_LARGE");
      return { tables, rows, columns: selected, next: raw.length > rows.length ? after ?? null : null };
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  } finally { await pool.end(); }
}
