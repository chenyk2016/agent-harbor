/** 测试数据库：每个测试文件独立schema，避免共用public表；结束后删除。 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../src/service/db/schema/index.js";
import { applyMigrations } from "../src/service/db/migrate.js";

export const testDatabaseUrl: string = (() => {
  const value = process.env.AH_TEST_DATABASE_URL;
  if (!value) throw new Error("Set AH_TEST_DATABASE_URL to a disposable PostgreSQL database before running tests");
  return value;
})();

export interface TestDatabase {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
  schema: string;
  reopen(): Promise<{ db: NodePgDatabase<typeof schema>; pool: Pool }>;
  close(): Promise<void>;
}

export async function testDatabase(): Promise<TestDatabase> {
  const name = `ah_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${name}"`);
  // search_path只影响本次连接；迁移里的外键因此指向同一schema。
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 5, options: `-c search_path=${name}` });
  try {
    await applyMigrations(pool);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA "${name}" CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    db: drizzle(pool, { schema }), pool, schema: name,
    /** 关闭原连接池后重新连接同一schema，用于验证状态确实落库。 */
    async reopen() {
      const next = new Pool({ connectionString: testDatabaseUrl, max: 5, options: `-c search_path=${name}` });
      return { db: drizzle(next, { schema }), pool: next };
    },
    async close() {
      // 重连测试会先主动结束原池；重复end只忽略这一种情况。
      try { await pool.end(); }
      catch (error) { if (!(error instanceof Error) || !/more than once/.test(error.message)) throw error; }
      await admin.query(`DROP SCHEMA "${name}" CASCADE`);
      await admin.end();
    },
  };
}
