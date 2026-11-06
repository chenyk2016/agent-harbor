/** Source scripts are private library files. A running environment receives a copy, never this writable library. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../types.js";
export interface ScriptPackage {
  id: string;
  name: string;
  entry: string;
  runtime: "node" | "python";
  install: "none" | "npm" | "uv";
  secretKeys: string[];
  files: Record<string, string>;
}
export const ownerKey = (user: string) =>
  createHash("sha256").update(user).digest("hex").slice(0, 32);
export const validId = (id: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
export const reservedEnv = (key: string) =>
  /^(PATH|HOME|TMPDIR|NODE_PATH|NODE_OPTIONS|BASH_ENV|ENV|CLAUDE.*|ANTHROPIC.*|MCP_TOKEN|SRT_.*|LD_.*|DYLD_.*|.*PROXY|npm_config_.*|UV_.*|PIP_.*)$/i.test(
    key,
  );
export function secretKeys(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 20 ||
    input.some(
      (k) =>
        typeof k !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(k) ||
        reservedEnv(k),
    )
  )
    fail(400, "INVALID_MCP_FIELDS");
  return [...new Set(input as string[])];
}
export function checkScript(
  input: Record<string, unknown>,
  id: string,
): ScriptPackage {
  if (
    !validId(id) ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80
  )
    fail(400, "INVALID_MCP_SCRIPT");
  const files = input.files;
  if (!files || typeof files !== "object" || Array.isArray(files))
    fail(400, "INVALID_MCP_SCRIPT");
  const entries = Object.entries(files);
  if (
    !entries.length ||
    entries.length > 100 ||
    entries.some(
      ([p, v]) =>
        !p ||
        p.length > 200 ||
        p === "script.json" ||
        p.startsWith("/") ||
        p
          .split("/")
          .some(
            (s) =>
              !s ||
              s === "." ||
              s === ".." ||
              s === "node_modules" ||
              s === ".venv",
          ) ||
        /[\\\0]/.test(p) ||
        typeof v !== "string",
    ) ||
    Buffer.byteLength(JSON.stringify(files)) > 1024 * 1024
  )
    fail(400, "INVALID_MCP_SCRIPT_FILES");
  if (typeof input.entry !== "string" || !Object.hasOwn(files, input.entry))
    fail(400, "INVALID_MCP_SCRIPT_ENTRY");
  if (
    !["node", "python"].includes(String(input.runtime)) ||
    !["none", "npm", "uv"].includes(String(input.install ?? "none"))
  )
    fail(400, "INVALID_MCP_SCRIPT_RUNTIME");
  if (
    input.install === "npm" &&
    (input.runtime !== "node" || !Object.hasOwn(files, "package-lock.json"))
  )
    fail(400, "MCP_LOCKFILE_REQUIRED");
  if (
    input.install === "uv" &&
    (input.runtime !== "python" || !Object.hasOwn(files, "requirements.txt"))
  )
    fail(400, "MCP_REQUIREMENTS_REQUIRED");
  return {
    id,
    name: input.name.trim(),
    entry: input.entry,
    runtime: input.runtime as "node" | "python",
    install: (input.install ?? "none") as ScriptPackage["install"],
    secretKeys: secretKeys(input.secretKeys ?? []),
    files: files as Record<string, string>,
  };
}
export class McpScripts {
  private pending = Promise.resolve();
  constructor(readonly root: string) {}
  private directory(user: string) {
    return join(this.root, "users", ownerKey(user), "mcp-scripts");
  }
  // A short queue protects source replacement/read; model execution never runs under this queue.
  private async serial<T>(fn: () => Promise<T>) {
    const before = this.pending;
    let release!: () => void;
    this.pending = new Promise((r) => (release = r));
    await before;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async list(user: string) {
    const read = async (scope: "admin" | "user", directory: string) => {
      const ids = await readdir(directory).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
      const rows = [];
      for (const id of ids.filter(validId)) {
        const script = await this.read(scope, user, id);
        rows.push({
          id,
          scope,
          name: script.name,
          runtime: script.runtime,
          entry: script.entry,
          secretKeys: script.secretKeys,
        });
      }
      return rows;
    };
    return [
      ...(await read("admin", join(this.root, "mcp-scripts", "admin"))),
      ...(await read("user", this.directory(user))),
    ];
  }
  async read(scope: "admin" | "user", user: string, id: string) {
    if (!validId(id)) fail(404, "MCP_SCRIPT_NOT_FOUND");
    return this.serial(async () => {
      const dir =
        scope === "admin"
          ? join(this.root, "mcp-scripts", "admin", id)
          : join(this.directory(user), id);
      try {
        if (
          !(await lstat(dir)).isDirectory() ||
          (await lstat(dir)).isSymbolicLink()
        )
          fail(400, "INVALID_MCP_SCRIPT");
        const config = JSON.parse(
          await readFile(join(dir, "script.json"), "utf8"),
        );
        const files: Record<string, string> = {};
        let totalBytes = 0;
        const visit = async (base: string, prefix = "") => {
          for (const item of await readdir(base, { withFileTypes: true })) {
            if (item.name === "script.json" && !prefix) continue;
            if (item.isSymbolicLink()) fail(400, "MCP_SCRIPT_LINK_DENIED");
            const relative = prefix + item.name;
            if (item.isDirectory()) {
              if (["node_modules", ".venv", ".git"].includes(item.name))
                continue;
              await visit(join(base, item.name), relative + "/");
            } else if (item.isFile()) {
              if (Object.keys(files).length >= 100)
                fail(413, "MCP_SCRIPT_LIMIT");
              const info = await lstat(join(base, item.name));
              if ((totalBytes += info.size) > 1024 * 1024)
                fail(413, "MCP_SCRIPT_LIMIT");
              files[relative] = await readFile(join(base, item.name), "utf8");
            } else fail(400, "INVALID_MCP_SCRIPT_FILE");
          }
        };
        await visit(dir);
        return checkScript({ ...config, files }, id);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          fail(404, "MCP_SCRIPT_NOT_FOUND");
        throw e;
      }
    });
  }
  async save(
    user: string,
    input: Record<string, unknown>,
    id: string = randomUUID(),
  ) {
    const script = checkScript(input, id);
    return this.serial(async () => {
      const base = this.directory(user);
      await mkdir(base, { recursive: true, mode: 0o700 });
      const temp = join(base, "." + randomUUID()),
        dest = join(base, id),
        old = dest + ".old";
      await mkdir(temp, { mode: 0o700 });
      try {
        for (const [p, content] of Object.entries(script.files)) {
          await mkdir(join(temp, p, ".."), { recursive: true });
          await writeFile(join(temp, p), content, { mode: 0o600 });
        }
        const { files, ...metadata } = script;
        await writeFile(join(temp, "script.json"), JSON.stringify(metadata), {
          mode: 0o600,
        });
        await rm(old, { recursive: true, force: true });
        await rename(dest, old).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
        try {
          await rename(temp, dest);
        } catch (error) {
          await rename(old, dest).catch(() => {});
          throw error;
        }
        await rm(old, { recursive: true, force: true });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      return script;
    });
  }
}
