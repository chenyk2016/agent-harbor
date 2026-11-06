/** PostgreSQL连接池与Drizzle入口；凭证只来自服务进程环境，不写入仓库。 */
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.AH_DATABASE_URL;
  if (!url) throw new Error("Set AH_DATABASE_URL, for example postgres://user:password@127.0.0.1:5432/agent_harbor");
  return url;
}

/**
 * 连接池由服务统一管理：statement_timeout 防止单条查询长期占用，
 * idle_in_transaction_session_timeout 回收忘记提交的事务，避免锁一直不释放。
 */
export function openDatabase(url = databaseUrl(), max = poolSize(process.env)): DatabaseHandle {
  const pool = new Pool({
    connectionString: url,
    max,
    application_name: "agent-harbor",
    connectionTimeoutMillis: 10_000,
    // 保留连接串里的search_path等选项，同时统一加上本服务的超时保护。
    options: [optionsFromUrl(url), "-c statement_timeout=15000", "-c idle_in_transaction_session_timeout=30000"].filter(Boolean).join(" "),
  });
  // 空闲连接被网络中断时，pg会发出error；不监听会让进程直接退出。
  pool.on("error", error => console.error("PostgreSQL pool error", error));
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** 读取连接串自带的options（测试用search_path），避免被本服务的默认值覆盖。 */
function optionsFromUrl(url: string) {
  try { return new URL(url).searchParams.get("options") ?? ""; }
  catch { return ""; }
}

export function poolSize(env: NodeJS.ProcessEnv): number {
  const value = env.AH_DATABASE_POOL_MAX === undefined ? 10 : Number(env.AH_DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("Invalid AH_DATABASE_POOL_MAX");
  return value;
}

/** 唯一约束冲突要转成业务响应，不能被当成数据库故障。 */
export function uniqueViolation(error: unknown): string | undefined {
  // Drizzle把pg错误放在cause，直接使用pg时错误则位于最外层。
  while (error && typeof error === "object") {
    const value = error as { code?: string; constraint?: string; cause?: unknown };
    if (value.code === "23505") return value.constraint;
    error = value.cause;
  }
  return undefined;
}
