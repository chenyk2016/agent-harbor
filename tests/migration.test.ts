/** 迁移测试：用真实SQLite数据副本导入真实PostgreSQL，核对ID、状态、约束与重复执行。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importSqlite, type ImportOptions } from "../src/service/db/import-sqlite.js";
import { testDatabase, testDatabaseUrl, type TestDatabase } from "./pg.js";

const schema = `
  PRAGMA user_version=1;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, title TEXT NOT NULL,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    environment TEXT NOT NULL DEFAULT 'closed', lastMessageId TEXT, lastEventId INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), clientMessageId TEXT NOT NULL,
    text TEXT NOT NULL, status TEXT NOT NULL, cancelRequested INTEGER NOT NULL DEFAULT 0,
    createdEventId INTEGER NOT NULL DEFAULT 0, startedAt INTEGER, finishedAt INTEGER, result TEXT,
    UNIQUE(sessionId, clientMessageId)
  );
  CREATE UNIQUE INDEX one_active_message ON messages(sessionId)
    WHERE status IN ('accepted','running','finalizing','reconciling');
  CREATE TABLE events (
    sessionId TEXT NOT NULL REFERENCES sessions(id), eventId INTEGER NOT NULL, messageId TEXT,
    type TEXT NOT NULL, payload TEXT NOT NULL, sourceEventKey TEXT,
    PRIMARY KEY(sessionId,eventId), UNIQUE(sessionId,sourceEventKey)
  );
  CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,limits TEXT);
  CREATE TABLE external_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,userId TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(issuer,subject));
  CREATE TABLE login_sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),expiresAt INTEGER NOT NULL);
  CREATE TABLE user_keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,userId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE usage_entries(messageId TEXT PRIMARY KEY,sessionId TEXT NOT NULL,userId TEXT NOT NULL,runnerId TEXT NOT NULL,cumulativeUsd REAL NOT NULL,estimatedUsd REAL,inputTokens INTEGER,outputTokens INTEGER,createdAt INTEGER NOT NULL);
  CREATE TABLE usage_baselines(sessionId TEXT PRIMARY KEY,cumulativeUsd REAL NOT NULL);
`;

async function source() {
  const directory = await mkdtemp(join(tmpdir(), "ah-import-"));
  const file = join(directory, "control.sqlite");
  const db = new DatabaseSync(file);
  db.exec(schema);
  db.exec(`
    INSERT INTO users VALUES
      ('u-a','Alice',0,1000,'{"sessions":5}'),
      ('u-b','Bob',1,2000,NULL);
    INSERT INTO external_identities VALUES ('https://idp.example','sub-1','u-a');
    INSERT INTO login_sessions VALUES ('hash-cookie','u-a',9999999999999);
    INSERT INTO user_keys VALUES
      ('k-active','hash-active','u-a','laptop',1000,NULL,0),
      ('k-revoked','hash-revoked','u-a','old',1000,NULL,1),
      ('k-expired','hash-expired','u-b','temp',1000,1,0);
    INSERT INTO sessions VALUES
      ('s-1','u-a','one',1000,1500,'closed','m-1',3),
      ('s-2','u-b','two',2000,2500,'reconciling','m-2',1);
    INSERT INTO messages VALUES
      ('m-1','s-1','c-1','hello','succeeded',0,1,1100,1200,'{"ok":true}'),
      ('m-2','s-2','c-2','unfinished','accepted',0,1,NULL,NULL,NULL),
      ('m-3','s-1','c-3','second','failed',1,3,1300,1400,NULL);
    INSERT INTO events VALUES
      ('s-1',1,'m-1','message.accepted','{}',NULL),
      ('s-1',2,'m-1','message.finished','{"status":"succeeded"}','r1:1'),
      ('s-1',3,'m-3','message.accepted','{}',NULL),
      ('s-2',1,'m-2','message.accepted','{}',NULL);
    INSERT INTO usage_entries VALUES
      ('m-1','s-1','u-a','r1',0.5,0.5,10,20,1200),
      ('m-3','s-1','u-a','r1',0.8,0.3,5,6,1400);
    INSERT INTO usage_baselines VALUES ('s-1',0.8);
  `);
  db.close();
  return { directory, file };
}

function importOptions(file: string, directory: string, dryRun = false): ImportOptions {
  return { source: file, dryRun, report: join(directory, "import.json") };
}

function scopedUrl(database: TestDatabase) {
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("options", `-c search_path=${database.schema}`);
  return url.toString();
}

test("imports a V7 SQLite copy into an empty PostgreSQL schema with IDs, states and constraints intact", async () => {
  const { directory, file } = await source();
  const database = await testDatabase();
  try {
    const report = await importSqlite(importOptions(file, directory), scopedUrl(database));
    assert.equal(report.result, "imported");
    assert.deepEqual(report.targetCounts, {
      users: 2, external_identities: 1, login_sessions: 1, user_keys: 3,
      sessions: 2, messages: 3, events: 4, usage_entries: 2, usage_baselines: 1,
    });
    assert.equal(report.integrity && (report.integrity as { eventCountMismatch: number }).eventCountMismatch, 0);

    const user = (await database.pool.query('SELECT * FROM users ORDER BY id')).rows;
    assert.equal(user[0].id, "u-a"); assert.equal(user[0].limits, '{"sessions":5}');
    assert.equal(user[1].disabled, 1);
    const keys = (await database.pool.query('SELECT id, revoked, "expiresAt" FROM user_keys ORDER BY id')).rows;
    assert.deepEqual(keys.map(row => [row.id, row.revoked]), [["k-active", 0], ["k-expired", 0], ["k-revoked", 1]]);
    assert.equal(Number(keys[1].expiresAt), 1);

    const sessions = (await database.pool.query('SELECT * FROM sessions ORDER BY id')).rows;
    assert.equal(Number(sessions[0].lastEventId), 3); assert.equal(sessions[1].environment, "reconciling");
    const messages = (await database.pool.query('SELECT * FROM messages ORDER BY id')).rows;
    assert.equal(messages[0].status, "succeeded"); assert.equal(messages[0].result, '{"ok":true}');
    assert.equal(messages[2].cancelRequested, 1);
    const events = (await database.pool.query('SELECT * FROM events WHERE "sessionId"=$1 ORDER BY "eventId"', ["s-1"])).rows;
    assert.deepEqual(events.map(row => Number(row.eventId)), [1, 2, 3]);
    assert.equal(events[1].payload, '{"status":"succeeded"}');
    assert.equal(events[1].sourceEventKey, "r1:1");

    // 约束必须随数据一起生效，而不是只在SQLite里存在。
    await assert.rejects(database.pool.query(`INSERT INTO messages(id,"sessionId","clientMessageId",text,status)
      VALUES('m-new','s-2','c-new','another','accepted')`), /one_active_message/);
    await assert.rejects(database.pool.query(`INSERT INTO messages(id,"sessionId","clientMessageId",text,status)
      VALUES('m-new','s-1','c-1','duplicate','failed')`), /messages_session_client_unique/);
    await assert.rejects(database.pool.query(`INSERT INTO messages(id,"sessionId","clientMessageId",text,status)
      VALUES('m-new','missing','c-new','orphan','failed')`), /foreign key/);

    const again = await importSqlite(importOptions(file, directory), scopedUrl(database));
    assert.equal(again.result, "already-imported");
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM messages")).rows[0].n, 3);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a non-empty target and does not modify it", async () => {
  const { directory, file } = await source();
  const database = await testDatabase();
  try {
    await database.pool.query(`INSERT INTO users(id,name,"createdAt") VALUES('existing','Existing',1)`);
    await assert.rejects(importSqlite(importOptions(file, directory), scopedUrl(database)), /not empty/);
    assert.deepEqual((await database.pool.query("SELECT id FROM users")).rows, [{ id: "existing" }]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry run validates the source without writing rows", async () => {
  const { directory, file } = await source();
  const database = await testDatabase();
  try {
    const report = await importSqlite(importOptions(file, directory, true), scopedUrl(database));
    assert.equal(report.result, "dry-run");
    assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n, 0);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an incomplete source instead of importing partial tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ah-import-bad-"));
  const file = join(directory, "control.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=1; CREATE TABLE users(id TEXT PRIMARY KEY);");
  db.close();
  const database = await testDatabase();
  try {
    await assert.rejects(importSqlite(importOptions(file, directory), scopedUrl(database)), /missing table external_identities/);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [name, corruption] of [
  ["orphan event message", `UPDATE events SET messageId='missing' WHERE sessionId='s-1' AND eventId=1`],
  ["orphan usage session", `UPDATE usage_entries SET sessionId='missing' WHERE messageId='m-1'`],
  ["invalid event cursor", `UPDATE sessions SET lastEventId=99 WHERE id='s-1'`],
]) {
  test(`rolls back the entire import for ${name}`, async () => {
    const { directory, file } = await source(), database = await testDatabase();
    try {
      const sqlite = new DatabaseSync(file); sqlite.exec(corruption); sqlite.close();
      await assert.rejects(importSqlite(importOptions(file, directory), scopedUrl(database)), /Referential integrity failed/);
      for (const table of ["users", "sessions", "messages", "events", "usage_entries", "import_runs"]) {
        assert.equal((await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
      }
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
