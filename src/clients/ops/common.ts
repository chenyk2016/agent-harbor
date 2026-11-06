/** 运维入口只操作显式选定实例；子进程参数不经shell，错误不回显凭据。 */
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  readdir,
  chmod,
} from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve, join, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
// 编译入口位于dist/src/clients/ops，源码执行由测试直接注入项目路径。
export const projectRoot = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
export class OpsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireThat(ok: unknown, code: string): asserts ok {
  if (!ok) throw new OpsError(code);
}
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function privateJson(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function readJson<T = any>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function emptyDirectory(path: string) {
  requireThat(
    isAbsolute(path) && path !== "/",
    "ABSOLUTE_DEDICATED_DIRECTORY_REQUIRED",
  );
  if (await exists(path)) {
    requireThat(
      !(await lstat(path)).isSymbolicLink(),
      "SYMLINK_DIRECTORY_REFUSED",
    );
    requireThat((await readdir(path)).length === 0, "EMPTY_DIRECTORY_REQUIRED");
  } else await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    input?: string | Buffer;
  } = {},
) {
  return new Promise<string>((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let text = "",
      size = 0;
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      options.timeout ?? 30000,
    );
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > 8 * 1024 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      text += b;
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new OpsError("COMMAND_UNAVAILABLE:" + command));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= 8 * 1024 * 1024) done(text);
      else reject(new OpsError("COMMAND_FAILED:" + command));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
export interface Installation {
  id: string;
  format: 1;
  createdAt: string;
  runtimeImage: string;
}
export interface Config {
  dir: string;
  env: NodeJS.ProcessEnv;
  installation: Installation;
}
export async function config(dir: string): Promise<Config> {
  dir = resolve(dir);
  const installation = await readJson<Installation>(
    join(dir, "installation.json"),
  );
  requireThat(
    installation.format === 1 && /^[a-f0-9-]{36}$/.test(installation.id),
    "INVALID_INSTALLATION",
  );
  const path = join(dir, "harbor.env"),
    stat = await lstat(path);
  requireThat(
    !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "PRIVATE_ENV_PERMISSIONS_REQUIRED",
  );
  const env = parseEnv(await readFile(path, "utf8"));
  requireThat(env.AH_DATA_DIR === join(dir, "data"), "DATA_ROOT_MISMATCH");
  return { dir, env, installation };
}
export function environment(c: Config) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AH_")) delete env[k];
  return { ...env, ...c.env };
}
export function dotenv(env: Record<string, string>) {
  return (
    Object.entries(env)
      .map(([k, v]) => {
        requireThat(
          /^[A-Z][A-Z0-9_]*$/.test(k) && !/[\r\n"\\]/.test(v),
          "INVALID_ENV_VALUE",
        );
        return k + '="' + v + '"';
      })
      .join("\n") + "\n"
  );
}
export async function updateEnv(c: Config, values: Record<string, string>) {
  const all = { ...c.env, ...values } as Record<string, string>;
  const file = join(c.dir, "harbor.env");
  await writeFile(file + ".tmp", dotenv(all), { mode: 0o600 });
  await rename(file + ".tmp", file);
  await chmod(file, 0o600);
  c.env = all;
}
export const publicOrigin = (c: Config) => c.env.AH_PUBLIC_ORIGIN!;
export async function request(url: string, options: RequestInit = {}) {
  return fetch(url, {
    ...options,
    redirect: "error",
    signal: options.signal ?? AbortSignal.timeout(8000),
  });
}
/** 大型dump直接走文件描述符，不经文本转换或内存缓冲。 */
export async function runFile(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    inputFile?: string;
    outputFile?: string;
    timeout?: number;
  } = {},
) {
  const { open } = await import("node:fs/promises");
  const input = options.inputFile ? await open(options.inputFile, "r") : null,
    output = options.outputFile
      ? await open(options.outputFile, "wx", 0o600)
      : null;
  try {
    await new Promise<void>((ok, no) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        env: options.env ?? process.env,
        stdio: [input?.fd ?? "ignore", output?.fd ?? "ignore", "ignore"],
      });
      const timer = setTimeout(
        () => child.kill("SIGTERM"),
        options.timeout ?? 120000,
      );
      child.once("error", () => {
        clearTimeout(timer);
        no(new OpsError("COMMAND_UNAVAILABLE:" + command));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? ok() : no(new OpsError("COMMAND_FAILED:" + command));
      });
    });
  } finally {
    await input?.close();
    await output?.close();
  }
}
export async function verifyReleaseFiles(directory: string) {
  const path = join(directory, "release-manifest.json");
  if (!(await exists(path))) return false;
  const manifest = await readJson(path);
  requireThat(
    manifest.format === 1 &&
      Array.isArray(manifest.files) &&
      manifest.files.length <= 10000,
    "INVALID_RELEASE_MANIFEST",
  );
  for (const file of manifest.files) {
    requireThat(
      typeof file.path === "string" &&
        !isAbsolute(file.path) &&
        !file.path
          .split("/")
          .some((p: string) => !p || p === "." || p === "..") &&
        /^[a-f0-9]{64}$/.test(file.sha256),
      "INVALID_RELEASE_FILE",
    );
    let current = directory;
    const parts = file.path.split("/");
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      requireThat(
        !(await lstat(current)).isSymbolicLink(),
        "RELEASE_SYMLINK_ANCESTOR",
      );
    }
    const target = join(directory, file.path),
      s = await lstat(target);
    requireThat(
      file.kind === "file" && s.isFile() && !s.isSymbolicLink(),
      "RELEASE_REGULAR_FILES_REQUIRED",
    );
    requireThat(
      hash(await readFile(target)) === file.sha256,
      "RELEASE_FILE_CHANGED",
    );
  }
  return true;
}
