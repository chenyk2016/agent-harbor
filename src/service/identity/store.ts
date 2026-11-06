/** 身份记录与控制面共用PostgreSQL；只保存登录/密钥哈希，不保存供应商token。 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { uniqueViolation } from "../db/client.js";
import { externalIdentities, loginSessions, userKeys, users } from "../db/schema/index.js";
import { tokenHash } from "../auth.js";
import { fail } from "../types.js";
import { workbenchIssuer } from "./workbench.js";
import { defaultLimits, type UserLimits } from "../limits/policy.js";
import { MICRO, signupCredit } from "../wallet/service.js";
export interface User { id: string; name: string; disabled: number; createdAt: number; limits: string | null }
export class IdentityStore {
  private configuredAdminKey?: { userId: string; hash: string };
  constructor(private db: Database) {}
  private async requireIn(tx: Tx, id: string) {
    const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user || user.disabled) fail(403, "ACCOUNT_DISABLED");
    return user as User;
  }
  private async ensureIn(tx: Tx, id: string, name = id, signupAmount?: number) {
    const inserted = await tx.insert(users).values({ id, name: name.slice(0, 200), createdAt: Date.now() }).onConflictDoNothing().returning({ id: users.id });
    if (inserted.length) await signupCredit(tx, id, signupAmount);
    const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
    return user as User;
  }
  async user(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row as User | undefined;
  }
  async require(id: string) { const user = await this.user(id); if (!user || user.disabled) fail(403, "ACCOUNT_DISABLED"); return user; }
  async ensure(id: string, name = id) {
    return this.db.transaction(tx => this.ensureIn(tx, id, name));
  }

  async external(issuer: string, subject: string, name: string) {
    const find = async (tx: Tx) => {
      const [old] = await tx.select({ userId: externalIdentities.userId }).from(externalIdentities)
        .where(and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject))).limit(1);
      if (old) return this.requireIn(tx, old.userId);
      // 不按email猜测归属，更不能把外部同名账号映射到本地管理员。
      const user = await this.ensureIn(tx, randomUUID(), name, issuer === workbenchIssuer ? 10 * MICRO : undefined);
      await tx.insert(externalIdentities).values({ issuer, subject, userId: user.id });
      return user;
    };
    try { return await this.db.transaction(find); }
    catch (error) {
      // 同一外部身份并发首次登录：另一事务已建立映射，直接复用其结果。
      if (uniqueViolation(error)) return this.db.transaction(find);
      throw error;
    }
  }
  /** Bind only a new credential; leave existing asset ownership and wallet intact. */
  async bindWorkbench(subject: string, target: string) {
    await this.db.transaction(async tx => {
      const [user] = await tx.select().from(users).where(eq(users.id, target)).for("update");
      if (!user || user.disabled) fail(409, "WORKBENCH_BIND_TARGET_UNAVAILABLE");
      const [existing] = await tx.select().from(externalIdentities)
        .where(and(eq(externalIdentities.issuer, workbenchIssuer), eq(externalIdentities.userId, target))).limit(1);
      if (existing?.subject === subject) return;
      if (existing) fail(409, "WORKBENCH_BIND_CONFLICT");
      const inserted = await tx.insert(externalIdentities).values({ issuer: workbenchIssuer, subject, userId: target })
        .onConflictDoNothing().returning({ subject: externalIdentities.subject });
      if (!inserted.length) fail(409, "WORKBENCH_BIND_CONFLICT");
    });
  }
  async importKeys(keys: { userId: string; tokenHash: string }[]) {
    return this.db.transaction(async tx => {
      let inserted = 0;
      for (const key of keys) {
        await this.ensureIn(tx, key.userId);
        // 冲突不覆盖：已有记录的revoked/expiresAt是事实，重启导入不能复活旧密钥。
        const rows = await tx.insert(userKeys)
          .values({ id: randomUUID(), hash: key.tokenHash, userId: key.userId, name: "Imported development key", createdAt: Date.now() })
          .onConflictDoNothing({ target: userKeys.hash }).returning({ id: userKeys.id });
        inserted += rows.length;
      }
      return inserted;
    });
  }
  async configureAdminKey(userId: string, hash: string, legacyHash?: string) {
    await this.db.transaction(async tx => {
      await this.ensureIn(tx, userId);
      const [existing] = await tx.select({ hash: userKeys.hash, userId: userKeys.userId })
        .from(userKeys).where(eq(userKeys.hash, hash)).limit(1);
      if (existing && (existing.userId !== userId || hash !== legacyHash))
        throw new Error("AH_BOOTSTRAP_ADMIN_KEY conflicts with an existing access key");
      if (legacyHash)
        await tx.update(userKeys).set({ revoked: 1 })
          .where(and(eq(userKeys.userId, userId), eq(userKeys.hash, legacyHash)));
    });
    this.configuredAdminKey = { userId, hash };
  }
  async key(token: string) {
    const hash = tokenHash(token);
    const configured = this.configuredAdminKey;
    if (configured?.hash === hash) {
      await this.require(configured.userId);
      return { userId: configured.userId, keyId: "configured-admin-key" };
    }
    const [row] = await this.db.select({ id: userKeys.id, userId: userKeys.userId }).from(userKeys)
      .where(and(eq(userKeys.hash, hash), eq(userKeys.revoked, 0),
        sql`(${userKeys.expiresAt} is null or ${userKeys.expiresAt} > ${Date.now()})`)).limit(1);
    if (!row) fail(401, "UNAUTHORIZED");
    await this.require(row.userId); return { userId: row.userId, keyId: row.id };
  }
  async keys(id: string) {
    return this.db.select({ id: userKeys.id, name: userKeys.name, createdAt: userKeys.createdAt,
      expiresAt: userKeys.expiresAt, revoked: userKeys.revoked }).from(userKeys)
      .where(eq(userKeys.userId, id)).orderBy(desc(userKeys.createdAt));
  }
  async createKey(id: string, name: string) {
    return this.db.transaction(async tx => {
      await this.requireIn(tx, id);
      // 锁用户行，避免并发创建同时通过数量检查而超过上限。
      await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(userKeys)
        .where(and(eq(userKeys.userId, id), eq(userKeys.revoked, 0),
          sql`(${userKeys.expiresAt} is null or ${userKeys.expiresAt} > ${Date.now()})`));
      if (Number(count.n) >= 20) fail(409, "KEY_LIMIT");
      const keyId = randomUUID(), token = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 30 * 86400_000;
      await tx.insert(userKeys).values({ id: keyId, hash: tokenHash(token), userId: id, name, createdAt: Date.now(), expiresAt });
      return { id: keyId, token, expiresAt };
    });
  }
  async revokeKey(userId: string, keyId: string) {
    const [row] = await this.db.select({ id: userKeys.id }).from(userKeys)
      .where(and(eq(userKeys.id, keyId), eq(userKeys.userId, userId))).limit(1);
    if (!row) fail(404, "KEY_NOT_FOUND");
    await this.db.update(userKeys).set({ revoked: 1 }).where(eq(userKeys.id, keyId));
  }
  async login(hash: string, id: string, expiresAt: number) {
    await this.require(id);
    await this.db.insert(loginSessions).values({ hash, userId: id, expiresAt });
  }
  async session(hash: string) {
    const [row] = await this.db.select({ userId: loginSessions.userId, expiresAt: loginSessions.expiresAt })
      .from(loginSessions).where(and(eq(loginSessions.hash, hash), sql`${loginSessions.expiresAt} > ${Date.now()}`)).limit(1);
    if (!row) fail(401, "UNAUTHORIZED");
    await this.require(row.userId); return { userId: row.userId, expiresAt: Number(row.expiresAt) };
  }
  async logout(hash: string) { await this.db.delete(loginSessions).where(eq(loginSessions.hash, hash)); }
  async policy(id: string): Promise<UserLimits> { return { ...defaultLimits, ...JSON.parse((await this.require(id)).limits ?? "{}") }; }
  async update(id: string, input: { disabled?: boolean; limits?: UserLimits }) {
    await this.db.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
      if (!user) fail(404, "USER_NOT_FOUND");
      if (input.limits) await tx.update(users).set({ limits: JSON.stringify(input.limits) }).where(eq(users.id, id));
      if (input.disabled !== undefined) {
        await tx.update(users).set({ disabled: input.disabled ? 1 : 0 }).where(eq(users.id, id));
        if (input.disabled) {
          await tx.execute(sql`DELETE FROM ah_auth_session WHERE "userId" IN (
            SELECT subject FROM external_identities WHERE issuer = ${workbenchIssuer} AND "userId" = ${id}
          )`);
          await tx.delete(loginSessions).where(eq(loginSessions.userId, id));
          await tx.update(userKeys).set({ revoked: 1 }).where(eq(userKeys.userId, id));
        }
      }
    });
  }
  async users() {
    return this.db.select({ id: users.id, name: users.name, disabled: users.disabled,
      createdAt: users.createdAt, limits: users.limits }).from(users).orderBy(asc(users.createdAt)).limit(1000);
  }
  /** V3-V5的所有者保持原ID，不能迁移时丢失或接管已有文件。 */
  async adoptSessionOwners() {
    await this.db.execute(sql`INSERT INTO users(id, name, "createdAt")
      SELECT "ownerId", "ownerId", MIN("createdAt") FROM sessions GROUP BY "ownerId"
      ON CONFLICT (id) DO NOTHING`);
  }
  /** 清理过期登录记录；启动时调用一次，不阻塞请求路径。 */
  async pruneLogins() { await this.db.delete(loginSessions).where(sql`${loginSessions.expiresAt} <= ${Date.now()}`); }
}
