/** 独立 PostgreSQL 测试业务库迁移台账、基线和环境隔离。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { ApplicationData } from "../src/service/applications/data.js";
import { parseManifest } from "../src/service/applications/manifest.js";
import { readAppMigration, pendingAppMigrations } from "../src/service/applications/migrations.js";
import { testDatabaseUrl } from "./pg.js";

const sqlManifest = parseManifest({ formatVersion: 2, template: "react-node-v1" });
const legacyManifest = parseManifest({
  formatVersion: 1, template: "react-node-v1",
  tables: { signups: { fields: { name: { type: "text" } }, publicCreate: false, publicRead: false } },
});
const baseline = readAppMigration("000_baseline.sql", `
  CREATE TABLE signups (
    id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), row_version bigint NOT NULL DEFAULT 1,
    name text
  );
`);
const added = readAppMigration("001_visitor.sql", "ALTER TABLE signups ADD COLUMN visitorid text;");

test("SQL migration admission denies commands outside the business schema subset", () => {
  for (const sql of [
    "DROP TABLE signups;", "CREATE TABLE harbor_sql_migrations (id uuid);",
    "CREATE TABLE public.signups (id uuid);", "CREATE TABLE x (n text DEFAULT current_user);",
    "ALTER TABLE signups ADD COLUMN n text NOT NULL;", "BEGIN; CREATE TABLE signups (id uuid); COMMIT;",
  ]) assert.throws(() => readAppMigration("001_test.sql", sql), /APPLICATION_MIGRATION_SQL_UNSUPPORTED/);
  assert.deepEqual(pendingAppMigrations([baseline, added], [baseline]), [added]);
  assert.throws(() => pendingAppMigrations([added], [baseline]), /APPLICATION_MIGRATION_HISTORY_CHANGED/);
});

test("legacy baseline adopts existing rows and each target applies immutable scripts exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-app-migrations-"));
  const data = new ApplicationData(root, testDatabaseUrl);
  const appId = randomUUID();
  let preview: Pool | undefined;
  try {
    const old = await data.provision(appId, "preview", legacyManifest);
    preview = new Pool({ connectionString: data.connection(old), max: 1 });
    const id = randomUUID();
    await preview.query("INSERT INTO signups (id,name) VALUES ($1,$2)", [id,"previous"]);
    const mismatch = readAppMigration("000_baseline.sql", "CREATE TABLE wrong (id uuid);");
    await assert.rejects(data.provision(appId, "preview", sqlManifest, [mismatch, added]),
      /APPLICATION_MIGRATION_BASELINE_MISMATCH/);
    assert.deepEqual(await data.sqlHistory(appId, "preview"), []);

    await data.provision(appId, "preview", sqlManifest, [baseline, added]);
    const history = await data.sqlHistory(appId, "preview");
    assert.deepEqual(history.map(item => item.name), [baseline.name, added.name]);
    assert.deepEqual((await preview.query("SELECT id,name,visitorid FROM signups")).rows,
      [{ id, name: "previous", visitorid: null }]);
    await data.provision(appId, "preview", sqlManifest, [baseline, added]);
    assert.deepEqual(await data.sqlHistory(appId, "preview"), history);
    await assert.rejects(preview.query("ALTER TABLE signups ADD COLUMN forbidden text"), { code: "42501" });
    await assert.rejects(preview.query("DELETE FROM harbor_sql_migrations"), { code: "42501" });
    await assert.rejects(data.provision(appId, "preview", legacyManifest), /APPLICATION_MIGRATION_HISTORY_CHANGED/);

    const bad = readAppMigration("002_bad.sql", "ALTER TABLE signups ADD COLUMN name text;");
    await assert.rejects(data.provision(appId, "preview", sqlManifest, [baseline, added, bad]),
      /APPLICATION_MIGRATION_SQL_FAILED/);
    assert.deepEqual(await data.sqlHistory(appId, "preview"), history);
    assert.deepEqual(await data.sqlHistory(appId, "production"), []);
    await data.provision(appId, "production", sqlManifest, [baseline, added]);
    assert.deepEqual((await data.sqlHistory(appId, "production")).map(item => item.hash), [baseline.hash, added.hash]);
  } finally {
    await preview?.end();
    await data.destroyOwned(appId, "preview");
    await data.destroyOwned(appId, "production");
    await data.close();
    await rm(root, { recursive: true, force: true });
  }
});
