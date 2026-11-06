/** 一致备份要求宿主服务停机、无遗留执行者；恢复只接收新实例和空数据库。 */
import {
  cp,
  mkdir,
  readdir,
  lstat,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { Pool } from "pg";
import { ConfiguredResidentProvider } from "../../runtime/providers/configured-resident.js";
import { DockerBackend } from "../../docker/docker.js";
import { offlineLock, compose, composeArgs } from "./install.js";
import {
  runFile,
  projectRoot,
  environment,
  requireThat,
  privateJson,
  readJson,
  hash,
  emptyDirectory,
  exists,
  updateEnv,
  type Config,
} from "./common.js";
interface Entry {
  path: string;
  kind: "file" | "link";
  sha256: string;
}
export async function inventory(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        s = await lstat(path);
      if (s.isDirectory()) await visit(path);
      else if (s.isFile())
        out.push({
          path: relative(root, path).split(sep).join("/"),
          kind: "file",
          sha256: hash(await readFile(path)),
        });
      else if (s.isSymbolicLink())
        out.push({
          path: relative(root, path).split(sep).join("/"),
          kind: "link",
          sha256: hash(await readlink(path)),
        });
      else throw Error("SPECIAL_FILE_IN_BACKUP");
    }
  }
  await visit(root);
  return out;
}
async function emptyDatabase(url: string) {
  const p = new Pool({ connectionString: url, max: 1 });
  try {
    requireThat(
      Number(
        (
          await p.query(
            "SELECT count(*) n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
          )
        ).rows[0].n,
      ) === 0,
      "RESTORE_REQUIRES_EMPTY_DATABASE",
    );
  } finally {
    await p.end();
  }
}
function command(c: Config, args: string[]) {
  return [...composeArgs(c), "exec", "-T", ...args];
}
async function stopped(c: Config) {
  requireThat(
    (await new ConfiguredResidentProvider(new DockerBackend(c.env.AH_DATA_DIR!)).findOwnedSessions()).length === 0,
    "STOP_ALL_OWNED_RUNNERS_BEFORE_BACKUP",
  );
}
export async function backup(c: Config, destination: string) {
  const dest = resolve(destination);
  requireThat(!dest.startsWith(c.dir + sep), "BACKUP_MUST_BE_OUTSIDE_INSTANCE");
  const release = await offlineLock(c);
  try {
    await stopped(c);
    const p = new Pool({ connectionString: c.env.AH_DATABASE_URL, max: 1 });
    try {
      // Older sources can still be backed up before applying the preview runtime migration.
      const runtimeColumn = await p.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'app_deployments' AND column_name = 'runtimeBackend'`);
      if (runtimeColumn.rowCount) {
        const pending = await p.query(`SELECT 1 FROM app_deployments
          WHERE "runtimeBackend" <> 'docker' AND ("observedState" <> 'stopped' OR "desiredState" <> 'stopped') LIMIT 1`);
        requireThat(!pending.rowCount, "STOP_ALL_MANAGED_PREVIEWS_BEFORE_BACKUP");
      }
      requireThat(
        Number(
          (
            await p.query(
              "SELECT count(*) n FROM messages WHERE status IN ('accepted','running','finalizing','reconciling')",
            )
          ).rows[0].n,
        ) === 0,
        "ACTIVE_MESSAGES_PREVENT_BACKUP",
      );
      requireThat(
        Number(
          (
            await p.query(
              "SELECT count(*) n FROM wallet_requests WHERE state='reserved'",
            )
          ).rows[0].n,
        ) === 0,
        "ACTIVE_MODEL_REQUESTS_PREVENT_BACKUP",
      );
    } finally {
      await p.end();
    }
    await emptyDirectory(dest);
    await runFile(
      "docker",
      command(c, [
        "control-db",
        "pg_dump",
        "-U",
        "harbor",
        "-d",
        "harbor",
        "-Fc",
      ]),
      { env: environment(c), outputFile: join(dest, "control.dump") },
    );
    await runFile(
      "docker",
      command(c, [
        "gateway-db",
        "pg_dump",
        "-U",
        "litellm",
        "-d",
        "litellm",
        "-Fc",
      ]),
      { env: environment(c), outputFile: join(dest, "gateway.dump") },
    );
    await cp(c.env.AH_DATA_DIR!, join(dest, "data"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await cp(join(c.dir, "harbor.env"), join(dest, "harbor.env"));
    for (const f of ["bootstrap.json", "first-admin.key"])
      if (await exists(join(c.dir, f))) await cp(join(c.dir, f), join(dest, f));
    const files = await inventory(dest);
    const manifest = {
      format: 1,
      complete: true,
      installationId: c.installation.id,
      createdAt: new Date().toISOString(),
      packageVersion: JSON.parse(
        await readFile(join(projectRoot, "package.json"), "utf8"),
      ).version,
      files,
    };
    await privateJson(join(dest, "backup-manifest.json"), manifest);
    return {
      backup: dest,
      complete: true,
      files: files.length,
      restoreTested: false,
    };
  } finally {
    await release();
  }
}
export async function restore(c: Config, source: string) {
  const src = resolve(source);
  const manifest = await readJson(join(src, "backup-manifest.json"));
  requireThat(
    manifest.format === 1 && manifest.complete && Array.isArray(manifest.files),
    "INCOMPLETE_BACKUP",
  );
  const actual = (await inventory(src)).filter(
    (x) => x.path !== "backup-manifest.json",
  );
  requireThat(
    JSON.stringify(actual) === JSON.stringify(manifest.files),
    "BACKUP_CHECKSUM_MISMATCH",
  );
  requireThat(
    manifest.packageVersion ===
      JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))
        .version,
    "RESTORE_VERSION_MISMATCH",
  );
  requireThat(
    (await readdir(c.env.AH_DATA_DIR!)).length === 0,
    "RESTORE_REQUIRES_EMPTY_DATA_ROOT",
  );
  await compose(c, ["up", "-d", "--wait", "control-db", "gateway-db"]);
  await emptyDatabase(c.env.AH_DATABASE_URL!);
  await emptyDatabase(c.env.AH_LITELLM_DATABASE_URL!);
  const release = await offlineLock(c);
  try {
    await runFile(
      "docker",
      command(c, [
        "control-db",
        "pg_restore",
        "-U",
        "harbor",
        "-d",
        "harbor",
        "--no-owner",
        "--exit-on-error",
        "--single-transaction",
      ]),
      { env: environment(c), inputFile: join(src, "control.dump") },
    );
    await runFile(
      "docker",
      command(c, [
        "gateway-db",
        "pg_restore",
        "-U",
        "litellm",
        "-d",
        "litellm",
        "--no-owner",
        "--exit-on-error",
        "--single-transaction",
      ]),
      { env: environment(c), inputFile: join(src, "gateway.dump") },
    );
    // 不替换持有中的根锁文件；所有其他数据来自已校验备份。
    await cp(join(src, "data"), c.env.AH_DATA_DIR!, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (p) => p !== join(src, "data", ".service", ".lock"),
    });
    const { parseEnv } = await import("node:util");
    const saved = parseEnv(await readFile(join(src, "harbor.env"), "utf8"));
    const keep = [
      "AH_ADMIN_USERS",
      "AH_LITELLM_MASTER_KEY",
      "AH_LITELLM_SALT_KEY",
      "AH_LLM_DEFAULT_DEPLOYMENT_ID",
      "AH_IMAGE",
      "AH_SKILL_IMAGE",
      "AH_OIDC_ISSUER",
      "AH_OIDC_CLIENT_ID",
      "AH_OIDC_CLIENT_SECRET",
      "AH_KEY_LOGIN",
      "AH_WORKBENCH_AUTH_SECRET",
    ];
    const updates = Object.fromEntries(
      keep.filter((k) => saved[k] !== undefined).map((k) => [k, saved[k]!]),
    );
    await updateEnv(c, updates);
    for (const f of ["bootstrap.json", "first-admin.key"])
      if (await exists(join(src, f))) await cp(join(src, f), join(c.dir, f));
    await privateJson(join(c.dir, "restore-result.json"), {
      complete: true,
      sourceInstallationId: manifest.installationId,
      at: new Date().toISOString(),
    });
    return { restored: true, serviceStarted: false, verifyRequired: true };
  } finally {
    await release();
  }
}
