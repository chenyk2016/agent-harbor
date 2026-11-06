/** 固定源码中的业务 SQL，只支持平台能在发布事务中安全执行的语句。 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { fail } from "../types.js";

export interface AppMigration {
  name: string;
  hash: string;
  statements: string[];
}

const namePattern = /^(\d{3})_[a-z0-9_]{1,48}\.sql$/;
const identifier = '(?:"[a-z][a-z0-9_]{0,39}"|[a-z][a-z0-9_]{0,39})';
const type = "(?:double precision|timestamp with time zone|timestamptz|timestamp|text|boolean|uuid|integer|bigint|jsonb|date|numeric)";
const literal = "(?:gen_random_uuid\\(\\)|now\\(\\)|true|false|null|-?\\d+(?:\\.\\d+)?|'[a-zA-Z0-9_ .-]*')";
const column = new RegExp(
  `^(${identifier}) +${type}(?: +(NOT NULL|PRIMARY KEY))?(?: +DEFAULT +${literal})?(?: +PRIMARY KEY)?$`,
  "i",
);
const table = new RegExp(`^CREATE TABLE +(${identifier}) *\\((.+)\\)$`, "i");
const add = new RegExp(`^ALTER TABLE +(${identifier}) +ADD (?:COLUMN +)?(.+)$`, "i");

/** 数据目录和迁移都排除平台对象。 */
export function businessTable(name: string) {
  return /^[a-z][a-z0-9_]{0,39}$/.test(name) && !name.startsWith("harbor_");
}

/** 首版支持建表和新增可空字段。执行前校验整条语句，拒绝任意 SQL 和事务控制。 */
export function readAppMigration(name: string, text: string): AppMigration {
  if (!namePattern.test(name) || Buffer.byteLength(text) > 32 * 1024)
    fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
  const statements = text.replace(/^\s*--[^\r\n]*/gm, "").split(";")
    .map(value => value.trim().replace(/[\r\n\t]/g, " ")).filter(Boolean);
  if (!statements.length || statements.length > 60)
    fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
  for (const statement of statements) {
    const create = table.exec(statement);
    const alter = add.exec(statement);
    const match = create ?? alter;
    if (!match || !businessTable(match[1].replaceAll('"', "")))
      fail(409, "APPLICATION_MIGRATION_SQL_UNSUPPORTED");
    if (create) {
      if (!create[2].split(",").every(value => column.test(value.trim())))
        fail(409, "APPLICATION_MIGRATION_SQL_UNSUPPORTED");
    } else {
      const field = column.exec(match[2]);
      if (!field || /\b(?:NOT NULL|PRIMARY KEY|DEFAULT)\b/i.test(match[2]))
        fail(409, "APPLICATION_MIGRATION_SQL_UNSUPPORTED");
    }
  }
  return { name, hash: createHash("sha256").update(text).digest("hex"), statements };
}

/** 迁移历史必须保持前缀完整。回滚仅验证旧版本依赖，不重新执行脚本。 */
export function pendingAppMigrations(
  files: readonly AppMigration[],
  applied: readonly { name: string; hash: string }[],
  rollback = false,
) {
  const overlap = Math.min(files.length, applied.length);
  if ((!rollback && files.length < applied.length) ||
      (rollback && files.length > applied.length) ||
      applied.slice(0, overlap).some((item, index) =>
        files[index].name !== item.name || files[index].hash !== item.hash))
    fail(409, "APPLICATION_MIGRATION_HISTORY_CHANGED");
  return files.slice(applied.length);
}

/** 用真实目录比较基线。忽略物理列顺序，保留类型、约束、默认值和索引定义。 */
export async function businessSchemaSignature(client: PoolClient, schema: string) {
  const result = await client.query(`
    SELECT c.relname AS name,
      (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod),
        a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
       WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT array_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid))
       FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
      (SELECT array_agg(replace(pg_get_indexdef(i.indexrelid), ' ON ' || quote_ident($1) || '.', ' ON ') ORDER BY pg_get_indexdef(i.indexrelid))
       FROM pg_index i WHERE i.indrelid=c.oid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`, [schema]);
  return result.rows.filter(row => businessTable(row.name));
}
