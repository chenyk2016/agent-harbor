/**
 * 一次性业务数据导入：SQLite控制面 → PostgreSQL。
 * 只向空目标写入，保留原ID、时间戳、撤销状态与事件编号；失败整体回滚。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { databaseUrl, openDatabase } from "./client.js";

interface SourceTable { name: string; columns: string[]; select: string }
export interface ImportOptions { source: string; dryRun: boolean; report: string }

// 顺序即外键顺序：用户 → 身份/密钥 → 会话 → 消息/事件 → 用量。
const tables: SourceTable[] = [
  { name: "users", columns: ["id", "name", "disabled", "createdAt", "limits"],
    select: "SELECT id,name,disabled,createdAt,limits FROM users ORDER BY id" },
  { name: "external_identities", columns: ["issuer", "subject", "userId"],
    select: "SELECT issuer,subject,userId FROM external_identities ORDER BY issuer,subject" },
  { name: "login_sessions", columns: ["hash", "userId", "expiresAt"],
    select: "SELECT hash,userId,expiresAt FROM login_sessions ORDER BY hash" },
  { name: "user_keys", columns: ["id", "hash", "userId", "name", "createdAt", "expiresAt", "revoked"],
    select: "SELECT id,hash,userId,name,createdAt,expiresAt,revoked FROM user_keys ORDER BY id" },
  { name: "sessions", columns: ["id", "ownerId", "title", "createdAt", "updatedAt", "environment", "lastMessageId", "lastEventId"],
    select: "SELECT id,ownerId,title,createdAt,updatedAt,environment,lastMessageId,lastEventId FROM sessions ORDER BY id" },
  { name: "messages", columns: ["id", "sessionId", "clientMessageId", "text", "status", "cancelRequested", "createdEventId", "startedAt", "finishedAt", "result"],
    select: "SELECT id,sessionId,clientMessageId,text,status,cancelRequested,createdEventId,startedAt,finishedAt,result FROM messages ORDER BY id" },
  { name: "events", columns: ["sessionId", "eventId", "messageId", "type", "payload", "sourceEventKey"],
    select: "SELECT sessionId,eventId,messageId,type,payload,sourceEventKey FROM events ORDER BY sessionId,eventId" },
  { name: "usage_entries", columns: ["messageId", "sessionId", "userId", "runnerId", "cumulativeUsd", "estimatedUsd", "inputTokens", "outputTokens", "createdAt"],
    select: "SELECT messageId,sessionId,userId,runnerId,cumulativeUsd,estimatedUsd,inputTokens,outputTokens,createdAt FROM usage_entries ORDER BY messageId" },
  { name: "usage_baselines", columns: ["sessionId", "cumulativeUsd"],
    select: "SELECT sessionId,cumulativeUsd FROM usage_baselines ORDER BY sessionId" },
];

export function options(argv: string[]): ImportOptions {
  const source = argv.find(arg => !arg.startsWith("--"));
  if (!source) throw new Error("Usage: npm run db:import -- /path/to/control.sqlite [--dry-run] [--report path]");
  const index = argv.indexOf("--report");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { source: resolve(source), dryRun: argv.includes("--dry-run"),
    report: resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : `var/evidence/db-migration/${stamp}/import.json`) };
}

function openSource(path: string) {
  // 只读打开，SQLite会自行读取同目录WAL中已提交的内容；不复制主文件，避免漏掉WAL。
  const db = new DatabaseSync(path, { readOnly: true });
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  if (version !== 1) { db.close(); throw new Error(`Unsupported source user_version ${version}; expected 1`); }
  for (const table of tables) if (!names.has(table.name)) { db.close(); throw new Error(`Source is missing table ${table.name}`); }
  return { db, version };
}

/** 逻辑指纹：按主键排序后的全部行内容，不受文件页布局或WAL检查点影响。 */
function fingerprint(db: DatabaseSync) {
  const hash = createHash("sha256");
  for (const table of tables) {
    hash.update(`${table.name}\n`);
    for (const row of db.prepare(table.select).all()) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

function insertSql(table: SourceTable, count: number) {
  const columns = table.columns.map(column => `"${column}"`).join(",");
  const tuples = Array.from({ length: count }, (_, row) =>
    `(${table.columns.map((_, column) => `$${row * table.columns.length + column + 1}`).join(",")})`);
  return `INSERT INTO "${table.name}" (${columns}) VALUES ${tuples.join(",")}`;
}

async function copyTable(client: PoolClient, table: SourceTable, rows: Record<string, unknown>[]) {
  const batch = Math.max(1, Math.min(500, Math.floor(5000 / table.columns.length)));
  for (let start = 0; start < rows.length; start += batch) {
    const slice = rows.slice(start, start + batch);
    const values = slice.flatMap(row => table.columns.map(column => row[column] ?? null));
    await client.query(insertSql(table, slice.length), values);
  }
}

async function counts(client: PoolClient, table: string) {
  return Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
}

async function integrity(client: PoolClient) {
  const query = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0].n);
  return {
    orphanMessages: await query(`SELECT count(*) AS n FROM messages m LEFT JOIN sessions s ON s.id=m."sessionId" WHERE s.id IS NULL`),
    orphanEvents: await query(`SELECT count(*) AS n FROM events e LEFT JOIN sessions s ON s.id=e."sessionId" WHERE s.id IS NULL`),
    orphanEventMessages: await query(`SELECT count(*) AS n FROM events e LEFT JOIN messages m ON m.id=e."messageId" WHERE e."messageId" IS NOT NULL AND m.id IS NULL`),
    orphanUsage: await query(`SELECT count(*) AS n FROM usage_entries u LEFT JOIN sessions s ON s.id=u."sessionId" WHERE s.id IS NULL`),
    eventCountMismatch: await query(`SELECT count(*) AS n FROM sessions s WHERE s."lastEventId" <> (SELECT count(*) FROM events e WHERE e."sessionId"=s.id)`),
  };
}

function targetLabel(url: string) {
  try { const parsed = new URL(url); parsed.password = ""; return parsed.toString(); }
  catch { return "postgres"; }
}

export async function importSqlite(input: ImportOptions, url = databaseUrl()) {
  const source = openSource(input.source);
  const started = Date.now();
  const sourceCounts: Record<string, number> = {};
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    rows[table.name] = source.db.prepare(table.select).all() as Record<string, unknown>[];
    sourceCounts[table.name] = rows[table.name].length;
  }
  const sourceFingerprint = fingerprint(source.db);
  source.db.close();

  const database = openDatabase(url, 2);
  const client = await database.pool.connect();
  const report: Record<string, unknown> = {
    source: input.source, target: targetLabel(url), sourceVersion: source.version,
    sourceFingerprint, sourceCounts, dryRun: input.dryRun, startedAt: new Date().toISOString(),
  };
  try {
    const migrated = await client.query<{ n: string }>("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '%_control_plane.sql'");
    if (Number(migrated.rows[0].n) === 0) throw new Error("Target has no control-plane migration; run npm run db:migrate first");

    const existing = Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM import_runs WHERE fingerprint=$1", [sourceFingerprint])).rows[0].n);
    if (existing) {
      report.result = "already-imported";
      return report;
    }
    // 单连接顺序查询：同一client不能并发执行多条语句。
    const used: number[] = [];
    for (const table of [...tables.map(table => table.name), "import_runs"]) used.push(await counts(client, table));
    if (used.some(count => count > 0)) throw new Error("Target is not empty; refusing to import over existing records");

    if (!input.dryRun) {
      await client.query("BEGIN");
      try {
        for (const table of tables) await copyTable(client, table, rows[table.name]);
        const targetCounts: Record<string, number> = {};
        for (const table of tables) {
          targetCounts[table.name] = await counts(client, table.name);
          if (targetCounts[table.name] !== sourceCounts[table.name]) throw new Error(`Count mismatch on ${table.name}: ${sourceCounts[table.name]} -> ${targetCounts[table.name]}`);
        }
        const check = await integrity(client);
        if (Object.values(check).some(count => count !== 0)) throw new Error(`Referential integrity failed: ${JSON.stringify(check)}`);
        await client.query(`INSERT INTO import_runs(fingerprint,"sourcePath","sourceVersion","importedAt",counts) VALUES($1,$2,$3,$4,$5)`,
          [sourceFingerprint, input.source, source.version, Date.now(), JSON.stringify(targetCounts)]);
        await client.query("COMMIT");
        report.targetCounts = targetCounts;
        report.integrity = check;
        report.result = "imported";
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    } else {
      report.result = "dry-run";
    }
    report.durationMs = Date.now() - started;
    await mkdir(dirname(input.report), { recursive: true });
    await writeFile(input.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    client.release();
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await importSqlite(options(process.argv.slice(2)))
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
