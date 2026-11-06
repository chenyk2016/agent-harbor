/** SDK累计估算按会话基线求差，按消息ID去重。usage只覆盖主循环，不能冒充账单。 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages, usageBaselines, usageEntries } from "../db/schema/index.js";
export class UsageStore {
  constructor(private db: Database) {}
  async record(userId: string, sessionId: string, messageId: string, runnerId: string, value: unknown, usage?: Record<string, unknown> | unknown) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
    await this.db.transaction(async tx => {
      // 同一会话的用量记录串行化；只锁这条会话的用量键，不与消息接收争会话行。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`);
      const [exists] = await tx.select({ messageId: usageEntries.messageId }).from(usageEntries)
        .where(eq(usageEntries.messageId, messageId)).limit(1);
      if (exists) return;
      const [baseline] = await tx.select({ cumulativeUsd: usageBaselines.cumulativeUsd }).from(usageBaselines)
        .where(eq(usageBaselines.sessionId, sessionId)).limit(1);
      const old = Number(baseline?.cumulativeUsd ?? 0);
      let legacy = false;
      if (!baseline) {
        const [finished] = await tx.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.sessionId, sessionId), ne(messages.id, messageId), sql`${messages.finishedAt} is not null`)).limit(1);
        legacy = !!finished;
      }
      // 恢复会延续原生累计值。第一次接入有旧历史时只立基线，不把旧花费归到新消息。
      // 下降也可能是启动错误的零值，无法区别/clear；这条增量未知，不抹掉旧基线。
      const delta = (legacy || value < old) ? null : value - old;
      const tokens = (name: string) => {
        const n = usage && typeof usage === "object" ? (usage as Record<string, unknown>)[name] : undefined;
        return Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
      };
      await tx.insert(usageEntries).values({ messageId, sessionId, userId, runnerId, cumulativeUsd: value, estimatedUsd: delta,
        inputTokens: tokens("input_tokens"), outputTokens: tokens("output_tokens"), createdAt: Date.now() });
      if (value >= old) {
        await tx.insert(usageBaselines).values({ sessionId, cumulativeUsd: value })
          .onConflictDoUpdate({ target: usageBaselines.sessionId, set: { cumulativeUsd: value } });
      }
    });
  }
  async summary(userId: string) {
    const [row] = await this.db.select({
      observedResults: sql<number>`count(*)::int`,
      measuredMessages: sql<number>`count(${usageEntries.estimatedUsd})::int`,
      estimatedUsd: sql<number>`coalesce(sum(${usageEntries.estimatedUsd}), 0)::float8`,
      mainInputTokens: sql<number>`coalesce(sum(${usageEntries.inputTokens}), 0)::int`,
      mainOutputTokens: sql<number>`coalesce(sum(${usageEntries.outputTokens}), 0)::int`,
    }).from(usageEntries).where(eq(usageEntries.userId, userId));
    return row;
  }
}
