/** 应用功能默认使用平台托管的独立观测库；显式连接配置优先。 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { lockSession } from "../../runtime/storage.js";
import { ApplicationSecrets } from "../applications/secrets.js";

/** 安装命令与服务从同一个应用数据根读取私有配置。 */
export function applicationDataRoot(dataRoot = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions")) {
  return resolve(process.env.AH_APP_DATA_DIR ?? join(dataRoot, ".applications"));
}

/** 拒绝将观测迁移写入已配置的控制库或应用管理连接所指向的数据库。 */
function independentDatabase(url: URL) {
  for (const configured of [process.env.AH_DATABASE_URL, process.env.AH_APP_DATABASE_ADMIN_URL]) {
    if (!configured) continue;
    const existing = new URL(configured);
    if (url.hostname === existing.hostname && (url.port || "5432") === (existing.port || "5432") &&
        decodeURIComponent(url.pathname) === decodeURIComponent(existing.pathname))
      throw new Error("OBSERVATION_DATABASE_MUST_BE_SEPARATE");
  }
  return url.href;
}

/** 默认库和角色名称绑定应用数据根，密码使用现有主密钥密封。 */
export async function observationDatabaseUrl(root = applicationDataRoot(), setup = false): Promise<string | undefined> {
  if (process.env.AH_OBSERVATION_ENABLED === "0") return;
  const explicit = process.env.AH_OBSERVATION_DATABASE_URL;
  if (explicit) return independentDatabase(new URL(explicit));

  const admin = process.env.AH_APP_DATABASE_ADMIN_URL;
  if (!admin) return;
  const name = "aho_" + createHash("sha256").update(root).digest("hex").slice(0, 16);
  const directory = join(root, "observation");
  const file = join(directory, "database.secret");
  const secrets = new ApplicationSecrets(join(root, "secrets"));
  const target = new URL(admin);
  target.pathname = "/" + name;
  target.username = name;
  target.searchParams.delete("options");
  independentDatabase(target);

  const load = async () => {
    try { return await secrets.open(await readFile(file, "utf8"), name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  };
  if (!setup) {
    const password = await load();
    if (!password) return;
    target.password = password;
    return target.href;
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockSession(directory);
  const pool = new Pool({ connectionString: admin, max: 1, connectionTimeoutMillis: 3000,
    statement_timeout: 15000 });
  try {
    let password = await load();
    const role = (await pool.query<{ scoped: boolean }>(`SELECT rolcanlogin AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AS scoped FROM pg_roles WHERE rolname=$1`, [name])).rows[0];
    const database = (await pool.query<{ owned: boolean }>(
      "SELECT pg_get_userbyid(datdba)=CURRENT_USER AS owned FROM pg_database WHERE datname=$1", [name],
    )).rows[0];
    if ((role && (!role.scoped || !password)) || (database && (!role || !database.owned)))
      throw new Error("OBSERVATION_DATABASE_OWNERSHIP_MISMATCH");
    if (!password) {
      // 先落盘，再创建角色。进程中断后重跑会沿用同一组身份。
      password = randomBytes(32).toString("hex");
      await writeFile(file + ".tmp", await secrets.seal(password, name), { mode: 0o600 });
      await rename(file + ".tmp", file);
    }
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("OBSERVATION_DATABASE_SECRET_INVALID");
    if (!role)
      await pool.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    if (!database)
      await pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    await pool.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await pool.query(`GRANT CONNECT ON DATABASE "${name}" TO "${name}"`);
    const schemaAdmin = new URL(admin);
    schemaAdmin.pathname = target.pathname;
    schemaAdmin.searchParams.delete("options");
    const schemaPool = new Pool({ connectionString: schemaAdmin.href, max: 1, connectionTimeoutMillis: 3000 });
    try {
      await schemaPool.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${name}"`);
    } finally {
      await schemaPool.end();
    }
    target.password = password;
    return target.href;
  } finally {
    try { await pool.end(); } finally { await release(); }
  }
}
