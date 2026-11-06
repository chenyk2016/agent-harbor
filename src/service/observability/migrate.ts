/** 仅显式命令执行，使用独立观测数据库，禁止指向控制库。 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { observationDatabaseUrl } from "./database.js";
export async function migrateObservations(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(17926071)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS observation_migrations (version integer PRIMARY KEY, checksum text NOT NULL)",
    );
    for (const [index, file] of ["schema.sql", "report-snapshots.sql"].entries()) {
      const version = index + 1;
      const sql = await readFile(new URL(file, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = await c.query("SELECT checksum FROM observation_migrations WHERE version=$1", [version]);
      if (old.rows[0] && old.rows[0].checksum !== checksum) throw new Error("OBSERVATION_MIGRATION_CHANGED");
      if (!old.rowCount) {
        await c.query(sql);
        await c.query("INSERT INTO observation_migrations VALUES ($1,$2)", [version, checksum]);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
/** 管理员显式初始化，已托管的实例重复执行时只检查迁移。 */
export async function setupObservations() {
  if (process.env.AH_OBSERVATION_ENABLED === "0") return;
  const url = await observationDatabaseUrl(undefined, true);
  if (!url) throw new Error("Set AH_APP_DATABASE_ADMIN_URL or a separate AH_OBSERVATION_DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await migrateObservations(pool);
    console.log("Observation migration applied");
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await setupObservations();
