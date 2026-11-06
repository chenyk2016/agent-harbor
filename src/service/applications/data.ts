/** 小规模应用数据供应：每应用/环境单独数据库与DML账号。建库是可核对的非事务步骤。 */
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { businessSchemaSignature, businessTable, pendingAppMigrations, type AppMigration } from "./migrations.js";
import { fail } from "../types.js";
import { lockSession } from "../../runtime/storage.js";
import { requireAppId } from "./source-store.js";
import { manifestHash, migrationPlan, type AppManifest } from "./manifest.js";
import { ApplicationSecrets } from "./secrets.js";

/** 应用的两个数据与部署环境：preview 用于试用，production 用于正式访问。 */
export type AppEnvironment = "preview" | "production";
/** 平台管理的数据环境记录；包含对应库、受限账号及已应用声明，password 解密后只用于运行配置。 */
export interface DataEnvironment {
  appId: string;
  environment: AppEnvironment;
  database: string;
  role: string;
  password: string;
  schema?: AppManifest;
}
/** 平台拥有迁移台账，应用运行账号与迁移脚本均不能写入。 */
async function appliedSql(client: Pick<PoolClient, "query">) {
  const { rows: [ledger] } = await client.query("SELECT to_regclass('public.harbor_sql_migrations') AS name");
  if (!ledger.name) return [];
  return (await client.query<{name: string; hash: string; appliedAt: Date}>(
    'SELECT name,hash,applied_at AS "appliedAt" FROM public.harbor_sql_migrations ORDER BY name',
  )).rows;
}

/** 校验并引用平台生成的数据库和角色名称，避免资源名进入 SQL 时被解释为其他语句。 */
function quote(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error("INVALID_DATABASE_RESOURCE");
  return `"${value}"`;
}
/** 为每个应用的预览和正式环境供应独立数据库及读写账号；平台管理连接负责建库和兼容迁移。 */
export class ApplicationData {
  private readonly pool: Pool;
  private readonly secrets: ApplicationSecrets;
  readonly owner: string;
  /** 创建小规模管理员连接池、凭据加密器和实例归属编号；归属编号参与资源命名。 */
  constructor(
    readonly root: string,
    readonly adminUrl: string,
  ) {
    this.pool = new Pool({
      connectionString: adminUrl,
      max: 2,
      connectionTimeoutMillis: 10000,
    });
    this.secrets = new ApplicationSecrets(join(root, "secrets"));
    this.pool.on("error", (error) =>
      console.error("Application data pool error", error.message),
    );
    this.owner = createHash("sha256").update(root).digest("hex").slice(0, 10);
  }
  /** 生成已校验应用和环境的数据元信息目录，拒绝未知环境或无效应用编号。 */
  private path(appId: string, environment: AppEnvironment) {
    requireAppId(appId);
    if (!["preview", "production"].includes(environment))
      throw new Error("INVALID_APP_ENVIRONMENT");
    return join(this.root, "data", appId, environment);
  }
  /** 将数据密码绑定环境身份后加密，以临时文件原子替换元信息，避免写到一半留下损坏记录。 */
  private async save(directory: string, state: DataEnvironment) {
    const path = join(directory, "environment.json");
    const { password, ...metadata } = state;
    const secret = await this.secrets.seal(
      password,
      `${state.appId}:${state.environment}:${state.database}:${state.role}`,
    );
    await writeFile(path + ".tmp", JSON.stringify({ ...metadata, secret }), {
      mode: 0o600,
    });
    await rename(path + ".tmp", path);
  }
  /** 读取并校验既有环境归属、解密账号密码，再以数据库内迁移记录校正磁盘上的旧声明。 */
  async open(
    appId: string,
    environment: AppEnvironment,
    timeoutMillis?: number,
  ): Promise<DataEnvironment> {
    const directory = this.path(appId, environment);
    const saved = JSON.parse(
      await readFile(join(directory, "environment.json"), "utf8"),
    );
    const key =
      appId.replaceAll("-", "").slice(0, 20) +
      "_" +
      (environment === "preview" ? "p" : "r");
    if (
      saved.appId !== appId ||
      saved.environment !== environment ||
      saved.database !== `aha_${this.owner}_${key}` ||
      saved.role !== `ahr_${this.owner}_${key}`
    )
      throw new Error("DATA_OWNERSHIP_MISMATCH");
    const state: DataEnvironment = {
      ...saved,
      password: await this.secrets.open(
        saved.secret,
        `${saved.appId}:${saved.environment}:${saved.database}:${saved.role}`,
      ),
    };
    const pool = new Pool({
      connectionString: this.connection(state, true),
      max: 1,
      connectionTimeoutMillis: timeoutMillis,
      statement_timeout: timeoutMillis,
    });
    try {
      const latest = await pool.query<{ manifest: AppManifest }>(
        "SELECT manifest FROM harbor_schema_migrations ORDER BY applied_at DESC, hash DESC LIMIT 1",
      );
      if (latest.rows[0]) state.schema = latest.rows[0].manifest;
      return state;
    } finally {
      await pool.end();
    }
  }
  /** 在环境锁内按固定名称创建或复用库和角色，并事务执行兼容迁移；凭据先落盘，便于中断后回查。 */
  async provision(
    appId: string,
    environment: AppEnvironment,
    manifest: AppManifest,
    migrations: readonly AppMigration[] = [],
  ): Promise<DataEnvironment> {
    const directory = this.path(appId, environment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockSession(directory);
    try {
      let state: DataEnvironment;
      try {
        const saved = JSON.parse(
          await readFile(join(directory, "environment.json"), "utf8"),
        );
        state = {
          ...saved,
          password: await this.secrets.open(
            saved.secret,
            `${saved.appId}:${saved.environment}:${saved.database}:${saved.role}`,
          ),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const key =
          appId.replaceAll("-", "").slice(0, 20) +
          "_" +
          (environment === "preview" ? "p" : "r");
        state = {
          appId,
          environment,
          database: `aha_${this.owner}_${key}`,
          role: `ahr_${this.owner}_${key}`,
          password: randomBytes(32).toString("hex"),
        };
        // 先保存名称/凭据，再做CREATE；连接超时后仍按同一名称回查，不换密码重建。
        await this.save(directory, state);
      }
      const key =
        appId.replaceAll("-", "").slice(0, 20) +
        "_" +
        (environment === "preview" ? "p" : "r");
      if (
        state.appId !== appId ||
        state.environment !== environment ||
        state.database !== `aha_${this.owner}_${key}` ||
        state.role !== `ahr_${this.owner}_${key}` ||
        !/^[a-f0-9]{64}$/.test(state.password)
      )
        throw new Error("DATA_OWNERSHIP_MISMATCH");
      if (manifest.formatVersion === 1) migrationPlan(state.schema, manifest);
      const role = await this.pool.query(
        "SELECT 1 FROM pg_roles WHERE rolname=$1",
        [state.role],
      );
      if (!role.rowCount)
        await this.pool.query(
          `CREATE ROLE ${quote(state.role)} LOGIN PASSWORD '${state.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
        );
      const database = await this.pool.query(
        "SELECT 1 FROM pg_database WHERE datname=$1",
        [state.database],
      );
      if (!database.rowCount)
        await this.pool.query(
          `CREATE DATABASE ${quote(state.database)} TEMPLATE template0`,
        );
      await this.pool.query(
        `REVOKE ALL ON DATABASE ${quote(state.database)} FROM PUBLIC`,
      );
      await this.pool.query(
        `GRANT CONNECT ON DATABASE ${quote(state.database)} TO ${quote(state.role)}`,
      );
      const connection = this.connection(state, true);
      const target = new Pool({ connectionString: connection, max: 1 });
      try {
        const client = await target.connect();
        try {
          await client.query("BEGIN");
          if (manifest.formatVersion === 2)
            await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
          await client.query("SELECT pg_advisory_xact_lock(17926100)");
          await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
          await client.query(
            "CREATE TABLE IF NOT EXISTS harbor_schema_migrations (hash text PRIMARY KEY, manifest jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
          );
          await client.query(
            "CREATE TABLE IF NOT EXISTS harbor_observation_outbox(id text PRIMARY KEY, deployment_id text NOT NULL, event jsonb NOT NULL, created_at bigint NOT NULL)",
          );
          await client.query(
            "CREATE TABLE IF NOT EXISTS harbor_observation_state(key text PRIMARY KEY,value bigint NOT NULL)",
          );
          await client.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON harbor_observation_outbox,harbor_observation_state TO ${quote(state.role)}`,
          );
          const hash = manifestHash(manifest);
          const latest = await client.query<{ manifest: AppManifest }>(
            "SELECT manifest FROM harbor_schema_migrations ORDER BY applied_at DESC, hash DESC LIMIT 1",
          );
          if (manifest.formatVersion === 2) {
            await this.applySql(client, state, migrations, !!latest.rows[0]);
          } else {
            if ((await appliedSql(client)).length)
              fail(409, "APPLICATION_MIGRATION_HISTORY_CHANGED");
            const plan = migrationPlan(latest.rows[0]?.manifest, manifest);
            const existing = await client.query(
              "SELECT 1 FROM harbor_schema_migrations WHERE hash=$1",
              [hash],
            );
            if (!existing.rowCount) {
              // 磁盘状态可能落后于上次已提交迁移；重新从库内事实计算，避免重复DDL。
              for (const sql of plan) await client.query(sql);
              await client.query(
                "INSERT INTO harbor_schema_migrations(hash,manifest) VALUES($1,$2)",
                [hash, manifest],
              );
            }
            for (const table of Object.keys(manifest.tables))
              await client.query(
                `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quote(table)} TO ${quote(state.role)}`,
              );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } finally {
        await target.end();
      }
      state.schema = manifest;
      await this.save(directory, state);
      return state;
    } finally {
      await release();
    }
  }
  /** 从未部署或首次部署尚未建库的环境没有可查询业务数据。 */
  async openIfExists(appId: string, environment: AppEnvironment) {
    try { return await this.open(appId, environment, 3000); }
    catch (error) {
      if (["ENOENT", "3D000", "42P01"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
  }

  /** 使用实例密钥保护分页位置，避免业务主键明文进入 URL 或日志。 */
  async sealCursor(identity: string, values: string[]) {
    return Buffer.from(await this.secrets.seal(JSON.stringify(values), identity), "base64").toString("base64url");
  }

  async openCursor(identity: string, cursor: string): Promise<string[]> {
    try {
      const result: unknown = JSON.parse(await this.secrets.open(cursor, identity));
      if (!Array.isArray(result) || !result.length ||
          result.some(value => typeof value !== "string" || value.includes("\0")))
        fail(400, "INVALID_DATASET_CURSOR");
      return result;
    } catch { fail(400, "INVALID_DATASET_CURSOR"); }
  }

  /** 返回应用环境已提交的迁移记录，失败或缺库不会伪造已执行项。 */
  async sqlHistory(appId: string, environment: AppEnvironment) {
    const state = await this.openIfExists(appId, environment);
    if (!state) return [];
    const target = new Pool({ connectionString: this.connection(state, true), max: 1,
      connectionTimeoutMillis: 3000, statement_timeout: 3000 });
    try { return await appliedSql(target); }
    finally { await target.end(); }
  }

  /** 构建前检查历史；正式执行在数据库锁内再检查一次。 */
  async checkSql(appId: string, environment: AppEnvironment, files: readonly AppMigration[], rollback = false) {
    if (!files.length) fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
    const state = await this.openIfExists(appId, environment);
    if (!state) {
      pendingAppMigrations(files, [], rollback);
      return;
    }
    const target = new Pool({ connectionString: this.connection(state, true), max: 1,
      connectionTimeoutMillis: 3000, statement_timeout: 3000 });
    try {
      const applied = await appliedSql(target);
      pendingAppMigrations(files, applied, rollback);
      if (!applied.length && !rollback && state.schema?.formatVersion === 1) {
        const client = await target.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await this.verifyBaseline(client, files[0], await businessSchemaSignature(client, "public"));
        } finally {
          try { await client.query("ROLLBACK"); } finally { client.release(); }
        }
      }
    } finally { await target.end(); }
  }

  /** 在事务内建参考结构，既有业务表和记录保持原位。 */
  private async verifyBaseline(client: PoolClient, baseline: AppMigration | undefined,
    existing: Awaited<ReturnType<typeof businessSchemaSignature>>) {
    if (baseline?.name !== "000_baseline.sql" ||
        baseline.statements.some(statement => !/^CREATE TABLE /i.test(statement)))
      fail(409, "APPLICATION_MIGRATION_BASELINE_REQUIRED");
    await client.query("CREATE SCHEMA harbor_migration_baseline");
    await client.query("SET LOCAL search_path TO harbor_migration_baseline, pg_catalog");
    for (const sql of baseline.statements) await client.query(sql);
    const expected = await businessSchemaSignature(client, "harbor_migration_baseline");
    if (!isDeepStrictEqual(existing, expected)) fail(409, "APPLICATION_MIGRATION_BASELINE_MISMATCH");
    await client.query("SET LOCAL search_path TO public, pg_catalog");
    await client.query("DROP SCHEMA harbor_migration_baseline CASCADE");
    return baseline;
  }

  /** 迁移只使用当前环境的对象所有者。平台记账和旧库基线核对留在可信连接。 */
  private async applySql(client: PoolClient, state: DataEnvironment, files: readonly AppMigration[], legacy: boolean) {
    if (!files.length) fail(409, "APPLICATION_MIGRATION_FILE_INVALID");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; SET LOCAL search_path TO public, pg_catalog");
    await client.query(`CREATE TABLE IF NOT EXISTS public.harbor_sql_migrations (
      name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await appliedSql(client);
    const pending = pendingAppMigrations(files, applied);
    if (!pending.length) return;
    if (pending.reduce((total, file) => total + file.statements.length, 0) > 250)
      fail(409, "APPLICATION_MIGRATION_FILE_INVALID");

    const role = quote("ahm_" + state.role.slice(4));
    if (!applied.length) {
      const existing = await businessSchemaSignature(client, "public");
      if (legacy || existing.length) {
        const baseline = await this.verifyBaseline(client, pending[0], existing);
        await client.query("INSERT INTO public.harbor_sql_migrations(name,hash) VALUES($1,$2)", [baseline.name, baseline.hash]);
        pending.shift();
      }
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      await client.query(`GRANT ${role} TO CURRENT_USER`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
      for (const { name } of existing) await client.query(`ALTER TABLE public.${quote(name)} OWNER TO ${role}`);
    }
    for (const file of pending) {
      await client.query(`SET LOCAL ROLE ${role}`);
      try {
        for (const sql of file.statements) await client.query(sql);
      } catch {
        // PostgreSQL 错误可能包含内部结构，操作记录只公开稳定错误码。
        fail(409, "APPLICATION_MIGRATION_SQL_FAILED");
      }
      await client.query("RESET ROLE");
      await client.query("INSERT INTO public.harbor_sql_migrations(name,hash) VALUES($1,$2)", [file.name, file.hash]);
    }
    const tables = await businessSchemaSignature(client, "public");
    for (const { name } of tables) {
      if (businessTable(name))
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${quote(name)} TO ${quote(state.role)}`);
    }
  }

  /** 容器地址由安装者配置；从客户端输入不能覆盖数据库目标。 */
  connection(
    state: DataEnvironment,
    admin = false,
    hostOverride?: string,
  ): string {
    const url = new URL(this.adminUrl);
    url.pathname = "/" + state.database;
    url.search = "";
    if (!admin) {
      url.username = state.role;
      url.password = state.password;
    }
    if (hostOverride) url.hostname = hostOverride;
    return url.href;
  }
  /** 启动时只验证应用管理库连通，不创建业务库或角色。 */
  async checkReady() {
    await this.pool.query("SELECT 1");
  }
  /** 关闭管理员连接池；只释放控制面连接，不删除应用数据库。 */
  async close() {
    await this.pool.end();
  }
  /** 仅测试/明确删除已拥有的数据环境调用；生产下线不删除数据。 */
  async destroyOwned(appId: string, environment: AppEnvironment) {
    requireAppId(appId);
    if (!["preview", "production"].includes(environment)) throw Error("INVALID_APP_ENVIRONMENT");
    const key = appId.replaceAll("-", "").slice(0, 20) + "_" + (environment === "preview" ? "p" : "r");
    // 名称由实例根、应用和环境确定；即使先前删除已移除配置文件也能安全重试。
    await this.pool.query(`DROP DATABASE IF EXISTS ${quote(`aha_${this.owner}_${key}`)} WITH (FORCE)`);
    await this.pool.query(`DROP ROLE IF EXISTS ${quote(`ahr_${this.owner}_${key}`)}`);
    await this.pool.query(`DROP ROLE IF EXISTS ${quote(`ahm_${this.owner}_${key}`)}`);
  }
  /** 依据已保存记录核验库和角色归属后永久删除资源；不同于暂停预览或正式下线。 */
  async destroy(state: DataEnvironment) {
    const directory = this.path(state.appId, state.environment);
    const saved = JSON.parse(
      await readFile(join(directory, "environment.json"), "utf8"),
    ) as DataEnvironment;
    if (
      saved.database !== state.database ||
      saved.role !== state.role ||
      !saved.database.startsWith(`aha_${this.owner}_`)
    )
      throw new Error("DATA_OWNERSHIP_MISMATCH");
    await this.pool.query(
      `DROP DATABASE IF EXISTS ${quote(state.database)} WITH (FORCE)`,
    );
    await this.pool.query(`DROP ROLE IF EXISTS ${quote(state.role)}`);
    await this.pool.query(`DROP ROLE IF EXISTS ${quote("ahm_" + state.role.slice(4))}`);
  }
}
