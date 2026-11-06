/** 使用隔离 PostgreSQL 验证默认库初始化、专用凭据、重试和关闭。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { observationDatabaseUrl } from "../src/service/observability/database.js";
import { migrateObservations } from "../src/service/observability/migrate.js";
import { testDatabaseUrl } from "./pg.js";

test("app observation uses a separate managed database by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-observation-"));
  const keys = ["AH_APP_DATABASE_ADMIN_URL", "AH_DATABASE_URL", "AH_OBSERVATION_ENABLED", "AH_OBSERVATION_DATABASE_URL"] as const;
  const before = keys.map(key => process.env[key]);
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  let observer: Pool | undefined, name: string | undefined;
  try {
    process.env.AH_APP_DATABASE_ADMIN_URL = testDatabaseUrl;
    process.env.AH_DATABASE_URL = testDatabaseUrl;
    delete process.env.AH_OBSERVATION_ENABLED;
    delete process.env.AH_OBSERVATION_DATABASE_URL;
    assert.equal(await observationDatabaseUrl(root), undefined);
    const url = await observationDatabaseUrl(root, true);
    assert.ok(url);
    const connection = new URL(url);
    name = connection.pathname.slice(1);
    assert.match(name, /^aho_[a-f0-9]{16}$/);
    assert.equal(connection.username, name);
    const sealed = await readFile(join(root, "observation/database.secret"), "utf8");
    assert(!sealed.includes(connection.password));
    assert.equal(await observationDatabaseUrl(root), url);
    assert.equal(await observationDatabaseUrl(root, true), url);

    observer = new Pool({ connectionString: url, max: 1 });
    await migrateObservations(observer);
    await migrateObservations(observer);
    const { rows } = await observer.query("SELECT version FROM observation_migrations ORDER BY version");
    assert.deepEqual(rows.map(row => row.version), [1, 2]);
    const original = await admin.query("SELECT to_regclass('public.observation_events') AS observation");
    assert.equal(original.rows[0].observation, null);
    await assert.rejects(observer.query("CREATE ROLE forbidden_observer"), { code: "42501" });

    process.env.AH_OBSERVATION_DATABASE_URL = testDatabaseUrl;
    await assert.rejects(observationDatabaseUrl(root), /OBSERVATION_DATABASE_MUST_BE_SEPARATE/);
    process.env.AH_OBSERVATION_ENABLED = "0";
    assert.equal(await observationDatabaseUrl(root, true), undefined);
  } finally {
    await observer?.end();
    if (name) {
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.query(`DROP ROLE "${name}"`);
    }
    await admin.end();
    await rm(root, { recursive: true, force: true });
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});
