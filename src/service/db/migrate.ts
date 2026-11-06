/** 受控迁移步骤：按文件名顺序应用 migrations/*.sql，并记录校验值。服务启动不自动执行。 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { openDatabase } from "./client.js";
import { setupObservations } from "../observability/migrate.js";

export interface MigrationResult { executed: string[]; total: number }

export async function applyMigrations(pool: Pool, folder = resolve(process.env.AH_MIGRATIONS_DIR ?? "migrations")): Promise<MigrationResult> {
  // 记录表放在当前search_path，测试可以每个schema独立演练。
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, appliedAt bigint NOT NULL, checksum text NOT NULL)");
  const files = (await readdir(folder)).filter(name => name.endsWith(".sql")).sort();
  const rows = (await pool.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows;
  const applied = new Map(rows.map(row => [row.name, row.checksum]));
  const executed: string[] = [];
  for (const file of files) {
    const text = await readFile(join(folder, file), "utf8");
    const checksum = createHash("sha256").update(text).digest("hex");
    const previous = applied.get(file);
    if (previous !== undefined) {
      // 已应用的迁移被改写会让数据库与仓库历史不一致；宁可停下也不静默重放。
      if (previous !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(text);
      await client.query("INSERT INTO schema_migrations(name, appliedAt, checksum) VALUES ($1, $2, $3)", [file, Date.now(), checksum]);
      await client.query("COMMIT");
      executed.push(file);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return { executed, total: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = openDatabase();
  try {
    const result = await applyMigrations(database.pool);
    console.log(result.executed.length ? `Applied: ${result.executed.join(", ")}` : `No pending migrations (${result.total} total)`);
  } finally {
    await database.close();
  }
  if (process.env.AH_APPLICATIONS_ENABLED === "1") await setupObservations();
}
