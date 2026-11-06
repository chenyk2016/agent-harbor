/** 平台人民币额度账本。账户行锁串行处理赠送、预占、结算；SDK美元估算不参与扣款。 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { users, wallets, walletSettings, walletLedger, walletGifts, walletRequests, type ModelPrice } from "../db/schema/index.js";
import { fail } from "../types.js";
import { messagePeriod } from "../limits/policy.js";
export const MICRO = 1_000_000;
export function yuan(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+(\.\d{1,6})?$/.test(String(value))) fail(400, "INVALID_AMOUNT");
  const amount = Math.round(Number(value) * MICRO);
  if (!Number.isSafeInteger(amount) || amount > 1_000_000 * MICRO) fail(400, "INVALID_AMOUNT");
  return amount;
}
export function parsePrice(value: unknown): ModelPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "INVALID_PRICE");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["input", "output", "cacheRead", "cacheWrite"].includes(k))) fail(400, "INVALID_PRICE");
  return { input: yuan(v.input), output: yuan(v.output), cacheRead: yuan(v.cacheRead), cacheWrite: yuan(v.cacheWrite) };
}
async function lock(tx: Tx, userId: string) {
  await tx.insert(wallets).values({ userId, balance: 0, reserved: 0 }).onConflictDoNothing();
  const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
  return wallet;
}
async function credit(tx: Tx, userId: string, id: string, amount: number, kind: string, note: string) {
  const wallet = await lock(tx, userId);
  if ((await tx.select({ id: walletLedger.id }).from(walletLedger).where(eq(walletLedger.id, id))).length) return;
  const balance = wallet.balance + amount;
  if (!Number.isSafeInteger(balance) || balance > 1_000_000_000 * MICRO) fail(409, "BALANCE_TOO_LARGE");
  await tx.update(wallets).set({ balance }).where(eq(wallets.userId, userId));
  await tx.insert(walletLedger).values({ id, userId, amount, kind, note, balanceAfter: balance, createdAt: Date.now() });
}
/** 仅在用户首次插入的事务内调用；迁移和服务重启不向已有用户追发。 */
export async function signupCredit(tx: Tx, userId: string, amount?: number) {
  const [settings] = await tx.select().from(walletSettings).where(eq(walletSettings.id, "platform"));
  await credit(tx, userId, `signup:${userId}`, amount ?? settings.signupMicro, "signup", "新用户注册赠送");
}
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export function cost(price: ModelPrice, usage: TokenUsage): number {
  let total = 0n;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) fail(400, "INVALID_USAGE");
    total += BigInt(price[key]) * BigInt(usage[key]);
  }
  const result = Number((total + 999999n) / 1000000n);
  if (!Number.isSafeInteger(result)) fail(400, "INVALID_USAGE");
  return result;
}
export class WalletService {
  constructor(readonly db: Database) {}
  async settings() { return (await this.db.select().from(walletSettings).where(eq(walletSettings.id, "platform")))[0]; }
  async configure(input: Record<string, unknown>) {
    const settings = { signupMicro: yuan(input.signupYuan), plusMicro: yuan(input.plusYuan) };
    await this.db.update(walletSettings).set(settings).where(eq(walletSettings.id, "platform"));
  }
  async grantPlus(userId: string, now = Date.now()) {
    await this.db.transaction(async tx => {
      const w = await lock(tx, userId);
      if (w.plusSince === null || w.plusUntil === null) return;
      const end = Math.min(now, w.plusUntil - 1);
      if (end < w.plusSince) return;
      const [s] = await tx.select().from(walletSettings).where(eq(walletSettings.id, "platform"));
      let period = messagePeriod(w.plusSince), last = messagePeriod(end);
      while (period <= last) {
        await credit(tx, userId, `plus:${userId}:${period}`, s.plusMicro, "plus", `Plus ${period} 月度赠送`);
        const date = new Date(`${period}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); period = date.toISOString().slice(0, 7);
      }
    });
  }
  async tick() {
    const rows = await this.db.select({ userId: wallets.userId }).from(wallets).where(sql`${wallets.plusSince} is not null`);
    for (const row of rows) await this.grantPlus(row.userId);
  }
  async setPlus(userId: string, until: unknown) {
    if (until !== null && (!Number.isSafeInteger(until) || Number(until) <= Date.now() || Number(until) > Date.now() + 5 * 366 * 86400000)) fail(400, "INVALID_PLUS_EXPIRY");
    if (!(await this.db.select().from(users).where(eq(users.id, userId))).length) fail(404, "USER_NOT_FOUND");
    await this.grantPlus(userId);
    await this.db.transaction(async tx => {
      const w = await lock(tx, userId), now = Date.now();
      await tx.update(wallets).set(until === null ? { plusSince: null, plusUntil: null } : {
        plusSince: w.plusUntil && w.plusUntil > now ? w.plusSince : now, plusUntil: Number(until),
      }).where(eq(wallets.userId, userId));
    });
    await this.grantPlus(userId);
  }
  async gift(actor: string, input: Record<string, unknown>) {
    const id = String(input.id ?? ""), amount = yuan(input.amountYuan), note = String(input.note ?? "").trim();
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id) || !amount || !note || note.length > 200 || !Array.isArray(input.userIds) || !input.userIds.length || input.userIds.length > 10000 || input.userIds.some(u => typeof u !== "string")) fail(400, "INVALID_GIFT");
    const recipients = [...new Set(input.userIds as string[])].sort();
    return this.db.transaction(async tx => {
      // 并发的同批赠送先串行判定请求内容，重试不改变名单或金额。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gift:${id}`}, 0))`);
      const [old] = await tx.select().from(walletGifts).where(eq(walletGifts.id, id));
      if (old) {
        if (old.actor !== actor || old.amount !== amount || old.note !== note || JSON.stringify(old.recipients) !== JSON.stringify(recipients)) fail(409, "GIFT_ID_CONFLICT");
        return { count: old.recipients.length, duplicate: true };
      }
      const targets = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, recipients), eq(users.disabled, 0)));
      if (targets.length !== recipients.length) fail(400, "GIFT_USER_UNAVAILABLE");
      await tx.insert(walletGifts).values({ id, actor, amount, recipients, note, createdAt: Date.now() });
      for (const userId of recipients) await credit(tx, userId, `gift:${id}:${userId}`, amount, "gift", note);
      return { count: recipients.length, duplicate: false };
    });
  }
  async summary(userId: string) {
    await this.grantPlus(userId);
    const [w] = await this.db.select().from(wallets).where(eq(wallets.userId, userId));
    const ledger = await this.db.select().from(walletLedger).where(eq(walletLedger.userId, userId)).orderBy(desc(walletLedger.createdAt)).limit(100);
    const [totals] = await this.db.select({
      credited: sql<number>`coalesce(sum(greatest(${walletLedger.amount},0)),0)::float8`,
      spent: sql<number>`coalesce(sum(-least(${walletLedger.amount},0)),0)::float8`,
      monthSpent: sql<number>`coalesce(sum(case when ${walletLedger.createdAt} >= ${Date.parse(messagePeriod()+"-01T00:00:00+08:00")} then -least(${walletLedger.amount},0) else 0 end),0)::float8`,
    }).from(walletLedger).where(eq(walletLedger.userId, userId));
    const requests = await this.db.select().from(walletRequests).where(eq(walletRequests.userId, userId)).orderBy(desc(walletRequests.createdAt)).limit(100);
    const [tokens] = await this.db.select({
      settledCalls: sql<number>`count(*) filter (where ${walletRequests.state} = 'settled')::int`,
      inputTokens: sql<number>`coalesce(sum(${walletRequests.inputTokens}),0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${walletRequests.outputTokens}),0)::float8`,
      cacheReadTokens: sql<number>`coalesce(sum(${walletRequests.cacheReadTokens}),0)::float8`,
      cacheWriteTokens: sql<number>`coalesce(sum(${walletRequests.cacheWriteTokens}),0)::float8`,
    }).from(walletRequests).where(eq(walletRequests.userId, userId));
    return { balance: w?.balance ?? 0, reserved: w?.reserved ?? 0, available: (w?.balance ?? 0) - (w?.reserved ?? 0), plusUntil: w?.plusUntil ?? null, ...totals, tokens, ledger, requests };
  }
  async reserve(userId: string, sessionId: string, model: { deploymentId: string; versionId: string; priceVersionId: string; name: string; price: ModelPrice | null }, estimate?: number) {
    if (!model.price) fail(409, "PRICE_REQUIRED");
    await this.grantPlus(userId);
    return this.db.transaction(async tx => {
      const w = await lock(tx, userId);
      if (estimate === undefined && w.reserved > 0) fail(429, "WALLET_BUSY");
      const available = w.balance - w.reserved;
      if (available <= 0) fail(402, "INSUFFICIENT_BALANCE");
      if (estimate !== undefined && (!Number.isSafeInteger(estimate) || estimate < 0)) fail(400, "INVALID_USAGE");
      const reserved = Math.min(available, estimate === undefined ? available : Math.max(1, estimate));
      const request = { id: randomUUID(), userId, sessionId, deploymentId: model.deploymentId, versionId: model.versionId, priceVersionId: model.priceVersionId, modelName: model.name, price: model.price!, reserved, state: "reserved", note: "", createdAt: Date.now() };
      await tx.update(wallets).set({ reserved: w.reserved + reserved }).where(eq(wallets.userId, userId));
      await tx.insert(walletRequests).values(request);
      return request;
    });
  }
  async settle(id: string, usage?: TokenUsage, manual?: { amount: number; note: string; actor: string }) {
    await this.db.transaction(async tx => {
      const [r] = await tx.select().from(walletRequests).where(eq(walletRequests.id, id)).for("update");
      if (!r) fail(404, "REQUEST_NOT_FOUND");
      if (r.state === "settled") {
        if (manual && (r.charged !== manual.amount || r.note !== `${manual.actor}: ${manual.note}`)) fail(409, "SETTLEMENT_CONFLICT");
        return;
      }
      if (manual && r.state !== "unknown") fail(409, "REQUEST_NOT_UNKNOWN");
      const actual = manual ? manual.amount : cost(r.price, usage!);
      if (manual && actual > r.reserved) fail(400, "INVALID_AMOUNT");
      const w = await lock(tx, r.userId);
      // Actual usage may exceed an estimate. Protect other in-flight reservations;
      // any cost beyond this request's hold plus unreserved balance is absorbed.
      const charged = Math.min(actual, r.reserved + Math.max(0, w.balance - w.reserved));
      if (w.reserved < r.reserved || w.balance < charged) fail(409, "WALLET_STATE_INVALID");
      const balance = w.balance - charged;
      await tx.update(wallets).set({ balance, reserved: w.reserved - r.reserved }).where(eq(wallets.userId, r.userId));
      const note = manual ? `${manual.actor}: ${manual.note}` : `${r.modelName} 模型使用`;
      await tx.insert(walletLedger).values({ id: `request:${id}`, userId: r.userId, amount: -charged, kind: "usage", note, balanceAfter: balance, createdAt: Date.now() });
      await tx.update(walletRequests).set({ state: "settled", actual, charged, waived: actual - charged, note, finishedAt: Date.now(),
        ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } : {}),
      }).where(eq(walletRequests.id, id));
    });
  }
  async unknown(id: string) {
    await this.db.update(walletRequests).set({ state: "unknown", note: "用量未确认，保留预占待管理员核对" }).where(and(eq(walletRequests.id, id), eq(walletRequests.state, "reserved")));
  }
  async attachGatewayCall(id: string, callId: string) {
    if (!callId || callId.length > 200 || /[\r\n]/.test(callId)) return;
    await this.db.update(walletRequests).set({ gatewayCallId: callId }).where(eq(walletRequests.id, id));
  }
  /** A disconnected client cannot supply final usage. The platform absorbs that cost,
   * releases the hold and keeps usage/actual null rather than claiming zero consumption. */
  async waiveInterrupted(id: string, reason = "客户端中断，用量未确认；平台承担未知费用，本次免收") {
    await this.db.transaction(async tx => {
      const [r] = await tx.select().from(walletRequests).where(eq(walletRequests.id, id)).for("update");
      if (!r) fail(404, "REQUEST_NOT_FOUND");
      if (r.state === "settled") return;
      const w = await lock(tx, r.userId);
      if (w.reserved < r.reserved) fail(409, "WALLET_STATE_INVALID");
      const note = reason;
      await tx.update(wallets).set({ reserved: w.reserved - r.reserved }).where(eq(wallets.userId, r.userId));
      await tx.insert(walletLedger).values({ id: `request:${id}`, userId: r.userId, amount: 0, kind: "usage", note, balanceAfter: w.balance, createdAt: Date.now() });
      await tx.update(walletRequests).set({ state: "settled", charged: 0, note, finishedAt: Date.now() }).where(eq(walletRequests.id, id));
    });
  }
  async recover() {
    await this.db.update(walletRequests).set({ state: "unknown", note: "服务重启，未完成请求待核对" }).where(eq(walletRequests.state, "reserved"));
  }
}
