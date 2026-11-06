/** Skill 版本库的结构约束：slug 范围、版本不可重复、导入归属外键。 */
import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./pg.js";

const now = Date.now();

test("skill tables enforce slug scope, immutable versions and ownership", async () => {
  const database = await testDatabase();
  try {
    await database.pool.query(
      `INSERT INTO users (id, name, disabled, "createdAt") VALUES ('u1', 'Dev', 0, $1), ('u2', 'Other', 0, $1)`, [now]);
    await database.pool.query(
      `INSERT INTO skills (id, "ownerId", source, slug, "displayName", status, "draftRevision", "createdAt", "updatedAt")
       VALUES ('s1', 'u1', 'private', 'table', 'Table', 'active', 0, $1, $1)`, [now]);

    // 同一拥有者的 slug 唯一，另一个拥有者可以重名。
    await assert.rejects(database.pool.query(
      `INSERT INTO skills (id, "ownerId", source, slug, "displayName", status, "draftRevision", "createdAt", "updatedAt")
       VALUES ('s2', 'u1', 'private', 'table', 'Table 2', 'active', 0, $1, $1)`, [now]), /skills_owner_slug_unique/);
    await database.pool.query(
      `INSERT INTO skills (id, "ownerId", source, slug, "displayName", status, "draftRevision", "createdAt", "updatedAt")
       VALUES ('s3', 'u2', 'private', 'table', 'Table 3', 'active', 0, $1, $1)`, [now]);

    // 内置技能在平台范围内唯一。
    await database.pool.query(
      `INSERT INTO skills (id, source, slug, "displayName", status, "draftRevision", "createdAt", "updatedAt")
       VALUES ('b1', 'builtin', 'table', 'Builtin', 'active', 0, $1, $1)`, [now]);
    await assert.rejects(database.pool.query(
      `INSERT INTO skills (id, source, slug, "displayName", status, "draftRevision", "createdAt", "updatedAt")
       VALUES ('b2', 'builtin', 'table', 'Builtin 2', 'active', 0, $1, $1)`, [now]), /skills_builtin_slug_unique/);

    // 版本号与发布请求键分别唯一。
    const version = (id: string, number: number, request: string) => database.pool.query(
      `INSERT INTO skill_versions (id, "skillId", "versionNumber", "sourceHash", manifest, "fileCount", "sizeBytes", "sourcePath", "publishRequestId", "publishRequestHash", "createdAt")
       VALUES ($1, 's1', $2, 'h', '{}', 1, 10, 'p', $3, 'rh', $4)`, [id, number, request, now]);
    await version("v1", 1, "r1");
    await assert.rejects(version("v2", 1, "r2"), /skill_versions_number_unique/);
    await assert.rejects(version("v3", 2, "r1"), /skill_versions_request_unique/);

    // 导入记录必须属于真实用户。
    await assert.rejects(database.pool.query(
      `INSERT INTO skill_imports (id, "userId", "clientRequestId", "clientRequestHash", "fileName", "expectedSize", "expectedSha256", status, "createdAt", "updatedAt")
       VALUES ('i1', 'missing', 'c1', 'ch', 'a.zip', 10, 'x', 'pending', $1, $1)`, [now]), /skill_imports_userId_users_id_fk/);

    // 个人启用记录以 (userId, skillId) 为主键。
    const enable = (userId: string) => database.pool.query(
      `INSERT INTO user_skills ("userId", "skillId", enabled, "createdAt", "updatedAt") VALUES ($1, 's1', 1, $2, $2)`, [userId, now]);
    await enable("u1");
    await assert.rejects(enable("u1"), /user_skills_userId_skillId_pk/);

    // 删除仍被版本引用的技能会被外键拦住，避免"删了元数据留下可执行版本"。
    await assert.rejects(database.pool.query(`DELETE FROM skills WHERE id = 's1'`), /skill_versions_skillId_skills_id_fk/);
  } finally {
    await database.close();
  }
});
