/** 简单的用户策略。检查和任务占位由SessionManager的短接收锁串行完成，不另起调度队列。 */
import { fail } from "../types.js";
export interface UserLimits { sessions: number; tasks: number; environments: number; workspaceBytes: number; monthlyMessages: number | null }
export const defaultLimits: UserLimits = { sessions: 100, tasks: 1, environments: 2, workspaceBytes: 1024 ** 3, monthlyMessages: null };
export function parseLimits(value: unknown): UserLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "INVALID_LIMITS");
  const limits = value as Record<string, unknown>;
  if (Object.keys(limits).some(key => !Object.hasOwn(defaultLimits, key))) fail(400, "INVALID_LIMITS");
  const result = { ...defaultLimits, ...limits };
  if (Object.entries(result).some(([key, n]) => !(key === "monthlyMessages" && n === null) && (!Number.isSafeInteger(n) || Number(n) < 0))) fail(400, "INVALID_LIMITS");
  return result as UserLimits;
}

/** 固定上海自然月，不依赖宿主时区；新周期独立计数，无需定时清零。 */
export function messagePeriod(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 7);
}
