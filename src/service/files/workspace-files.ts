/** 文件传输编排：先私有暂存，再调用唯一的目录访问边界。这里不控制Agent。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, open, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fail } from "../types.js";
import { uploadLimit, type FileListing, type FilePreview, type UploadedFile } from "./types.js";
const exec = promisify(execFile);
const helper = fileURLToPath(new URL("./workspace-access.py", import.meta.url));
const statuses: Record<string, number> = {
  INVALID_PATH: 400, INVALID_FILENAME: 400, INVALID_UPLOAD_ID: 400,
  FILE_NOT_FOUND: 404, FILE_NOT_ACCESSIBLE: 403, FILE_CHANGED: 409, UPLOAD_CONFLICT: 409,
  FILE_TOO_LARGE: 413, PREVIEW_UNSUPPORTED: 415, CHECKSUM_MISMATCH: 422,
  FILE_IO_FAILED: 503, FILE_ACCESS_UNAVAILABLE: 503,
};
export function checkFilename(name: string) {
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 180) fail(400, "INVALID_FILENAME");
}
export class WorkspaceFiles {
  private directory: string;
  private initialization?: Promise<boolean>;
  private lifetime = new AbortController();
  private operations = new Set<Promise<unknown>>();
  private sessionSignals = new Map<string, AbortController>();
  private sessionOperations = new Map<string, Set<Promise<unknown>>>();
  async stopSession(id: string) {
    const controller = this.sessionSignals.get(id) ?? new AbortController();
    this.sessionSignals.set(id, controller); controller.abort();
    await Promise.allSettled([...(this.sessionOperations.get(id) ?? [])]);
  }
  constructor(private root: string) { this.directory = join(root, ".service", "file-transfers"); }
  get signal() { return this.lifetime.signal; }
  initialize() {
    // 服务持有数据根锁后清理旧暂存；同一实例只初始化一次，不能清掉正在进行的传输。
    return this.initialization ??= (async () => {
      const capability = await this.call<{ available: boolean }>("", "capabilities", {}).catch(() => ({ available: false }));
      if (!capability.available) return false;
      await rm(this.directory, { recursive: true, force: true });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return true;
    })();
  }
  private async call<T>(workspace: string, operation: string, args: object, signal = this.lifetime.signal): Promise<T> {
    let stdout: string;
    try {
      ({ stdout } = await exec("python3", [helper, workspace, operation, JSON.stringify(args)], {
        signal, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      }));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      console.error("Workspace helper failed", error);
      fail(503, "FILE_ACCESS_UNAVAILABLE");
    }
    const value = JSON.parse(stdout) as { error?: string };
    if (value.error) fail(statuses[value.error] ?? 503, value.error);
    return value as T;
  }
  private async operation<T>(id: string, signal: AbortSignal, work: (workspace: string, signal: AbortSignal) => Promise<T>) {
    if (this.lifetime.signal.aborted) fail(503, "SERVICE_STOPPING");
    const controller = this.sessionSignals.get(id) ?? new AbortController();
    this.sessionSignals.set(id, controller);
    const run = (async () => {
      if (!await this.initialize()) fail(503, "FILE_ACCESS_UNAVAILABLE");
      const combined = AbortSignal.any([signal, this.lifetime.signal, controller.signal]);
      combined.throwIfAborted();
      return work(join(this.root, id, "workspace"), combined);
    })();
    this.operations.add(run);
    const active = this.sessionOperations.get(id) ?? new Set<Promise<unknown>>();
    this.sessionOperations.set(id, active); active.add(run);
    try { return await run; } finally {
      this.operations.delete(run); active.delete(run);
      if (!active.size) this.sessionOperations.delete(id);
    }
  }
  async bytes(ids: string[], signal: AbortSignal) {
    let total = 0;
    for (const id of ids) total += (await this.operation(id, signal, (root, signal) => this.call<{ bytes: number }>(root, "size", {}, signal)).catch(error => {
      if (error.code === "FILE_NOT_FOUND") return { bytes: 0 };
      throw error;
    })).bytes;
    return total;
  }
  list(id: string, path: string, signal: AbortSignal) {
    return this.operation(id, signal, (root, signal) => this.call<FileListing>(root, "list", { path }, signal));
  }
  preview(id: string, path: string, signal: AbortSignal) {
    return this.operation(id, signal, (root, signal) => this.call<FilePreview>(root, "preview", { path }, signal));
  }
  uploaded(id: string, uploadId: string, name: string, signal: AbortSignal) {
    return this.operation(id, signal, (root, signal) => this.call<UploadedFile>(root, "uploaded", { uploadId, name }, signal));
  }
  upload(id: string, uploadId: string, name: string, expectedHash: string, input: AsyncIterable<Buffer>, signal: AbortSignal, allowance = uploadLimit) {
    checkFilename(name);
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) fail(400, "INVALID_CHECKSUM");
    return this.operation(id, signal, async (root, signal) => {
      const temporary = await mkdtemp(join(this.directory, "upload-"));
      try {
        const stage = join(temporary, "payload");
        await mkdir(stage, { mode: 0o755 });
        const file = await open(join(stage, name), "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        try {
          for await (const chunk of input) {
            signal.throwIfAborted(); size += chunk.length;
            if (size > allowance) fail(413, "WORKSPACE_LIMIT");
            if (size > uploadLimit) fail(413, "FILE_TOO_LARGE");
            hash.update(chunk); await file.writeFile(chunk);
          }
          signal.throwIfAborted();
          if (hash.digest("hex") !== expectedHash) fail(422, "CHECKSUM_MISMATCH");
          await file.sync();
        } finally { await file.close(); }
        // 工作副本要让容器内用户读取；接收期间仍被私有暂存父目录保护。
        await chmod(join(stage, name), 0o644);
        return await this.call<UploadedFile>(root, "upload", { uploadId, name, stage, sha256: expectedHash, size }, signal);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  /** 先完成有限大小的副本，再交给HTTP层发送；断开、异常均释放私有文件。 */
  download(id: string, path: string, signal: AbortSignal, send: (file: string, size: number, signal: AbortSignal) => Promise<void>) {
    return this.operation(id, signal, async (root, signal) => {
      const temporary = await mkdtemp(join(this.directory, "download-"));
      try {
        const file = join(temporary, "content");
        const info = await this.call<{ size: number }>(root, "download", { path, output: file }, signal);
        await send(file, info.size, signal);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  async close() { this.lifetime.abort(); await Promise.allSettled(this.operations); }
}
