/** 文件状态独立于对话；每次请求都捕获会话，不在异步完成后读取新的选中值。 */
import { ApiError } from "../../../../src/clients/service-client.js";
import type { BrowserApi } from "./api.js";
import { explain } from "./workspace.js";
import type {
  FileListing,
  FilePreview,
  UploadedFile,
} from "../../../../src/service/files/types.js";
export interface UploadJob {
  id: string;
  sessionId: string;
  name: string;
  size: number;
  sha256: string;
  status: "preparing" | "uploading" | "ready" | "unknown" | "failed";
  file?: UploadedFile;
  error?: string;
}
interface DirectoryState {
  path: string;
  listing?: FileListing;
  loading: boolean;
  error?: string;
}
export function fileError(error: unknown) {
  if (error instanceof ApiError) {
    const labels: Record<string, string> = {
      FILE_NOT_FOUND: "文件不存在，可能已被移走。",
      FILE_NOT_ACCESSIBLE: "链接、硬链接或特殊文件不能访问。",
      FILE_CHANGED: "文件正在变化，请刷新后重试；稳定交付前可先关闭环境。",
      PREVIEW_UNSUPPORTED: "该文件不支持文本预览，可下载后查看。",
      UPLOAD_CONFLICT: "这个上传编号的文件已变化，不会覆盖。请先检查工作区。",
      FILE_TOO_LARGE: "文件超出限制：上传20MiB，下载100MiB。",
      CHECKSUM_MISMATCH: "文件内容校验未通过，本次未发布。",
      FILE_TRANSFER_BUSY: "这个会话正在上传文件，请稍后再发送任务或上传。",
      INVALID_FILENAME: "文件名不能包含路径或控制字符，长度不得超过180字节。",
    };
    return labels[error.code] ?? explain(error);
  }
  return "连接结果待确认，请核对上传编号，不要盲目创建新上传。";
}
export class FileBrowser {
  selectedId?: string;
  open = false;
  directories = new Map<string, DirectoryState>();
  jobs: UploadJob[] = [];
  preview?: {
    path: string;
    loading: boolean;
    value?: FilePreview;
    error?: string;
  };
  downloading = false;
  private selection = new AbortController();
  private lifetime = new AbortController();
  private listGeneration = 0;
  private previewGeneration = 0;
  private lastTurn = "";
  private storageKey: string;
  constructor(
    private api: BrowserApi,
    userId: string,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private changed: () => void,
    private notify: (text: string) => void,
    private canUpload: (id: string) => boolean,
    private expired: () => void,
  ) {
    this.storageKey = `agent-harbor:files:${encodeURIComponent(userId)}`;
    try {
      this.jobs = (
        JSON.parse(storage.getItem(this.storageKey) ?? "[]") as UploadJob[]
      ).map((job) => ({ ...job, status: "unknown" }));
    } catch {
      this.jobs = [];
    }
  }
  get directory() {
    return this.selectedId ? this.directories.get(this.selectedId) : undefined;
  }
  get currentJobs() {
    return this.jobs.filter((job) => job.sessionId === this.selectedId);
  }
  busy(id: string) {
    return this.jobs.some(
      (job) =>
        job.sessionId === id && ["preparing", "uploading"].includes(job.status),
    );
  }
  private save() {
    const pending = this.jobs
      .filter((job) => ["uploading", "unknown"].includes(job.status))
      .map(({ id, sessionId, name, size, sha256 }) => ({
        id,
        sessionId,
        name,
        size,
        sha256,
      }));
    this.storage.setItem(this.storageKey, JSON.stringify(pending));
  }
  private problem(error: unknown, id = this.selectedId) {
    if (this.lifetime.signal.aborted) return;
    if (error instanceof ApiError && error.status === 401) this.expired();
    else if (id === this.selectedId) this.notify(fileError(error));
  }
  select(id?: string, turn = "") {
    if (this.selectedId !== id) {
      this.selection.abort();
      this.selection = new AbortController();
      this.listGeneration++;
      this.previewGeneration++;
      this.preview = undefined;
      this.selectedId = id;
      this.lastTurn = turn;
      if (id && !this.directories.has(id))
        this.directories.set(id, { path: "", loading: false });
      if (this.open && id) void this.refresh();
    } else if (turn !== this.lastTurn) {
      this.lastTurn = turn;
      if (this.open && turn.endsWith(":done")) void this.refresh();
    }
  }
  show(open: boolean) {
    this.open = open;
    if (open) void this.refresh();
    this.changed();
  }
  async refresh(path = this.directory?.path ?? "") {
    const id = this.selectedId;
    if (!id) return;
    const generation = ++this.listGeneration;
    const signal = AbortSignal.any([
      this.selection.signal,
      this.lifetime.signal,
    ]);
    const state = this.directories.get(id)!;
    if (state.path !== path) state.listing = undefined;
    state.path = path;
    state.loading = true;
    state.error = undefined;
    this.changed();
    try {
      const listing = await this.api.files(id, path, signal);
      if (!signal.aborted && generation === this.listGeneration)
        state.listing = listing;
    } catch (error) {
      if (!signal.aborted && generation === this.listGeneration) {
        state.error = fileError(error);
        this.problem(error);
      }
    } finally {
      if (!signal.aborted && generation === this.listGeneration) {
        state.loading = false;
        this.changed();
      }
    }
  }
  async previewFile(path: string) {
    const id = this.selectedId;
    if (!id) return;
    const generation = ++this.previewGeneration;
    const signal = AbortSignal.any([
      this.selection.signal,
      this.lifetime.signal,
    ]);
    const preview = (this.preview = { path, loading: true } as NonNullable<
      FileBrowser["preview"]
    >);
    this.changed();
    try {
      const value = await this.api.previewFile(id, path, signal);
      if (!signal.aborted && generation === this.previewGeneration)
        preview.value = value;
    } catch (error) {
      if (!signal.aborted && generation === this.previewGeneration) {
        preview.error = fileError(error);
        this.problem(error);
      }
    } finally {
      if (!signal.aborted && generation === this.previewGeneration) {
        preview.loading = false;
        this.changed();
      }
    }
  }
  async upload(input: File[]) {
    const id = this.selectedId;
    if (!id || !this.canUpload(id) || this.busy(id)) return;
    for (const file of input) {
      if (this.lifetime.signal.aborted) return;
      if (file.size > 20 * 1024 * 1024) {
        this.notify(`${file.name} 超过20MiB，尚未上传。`);
        continue;
      }
      const job: UploadJob = {
        id: crypto.randomUUID(),
        sessionId: id,
        name: file.name,
        size: file.size,
        sha256: "",
        status: "preparing",
      };
      this.jobs.push(job);
      this.changed();
      try {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        if (this.lifetime.signal.aborted) return;
        job.sha256 = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        // 重新选择同一份待确认文件时，继续沿用原编号，绝不覆盖已有工作文件。
        const pending = this.jobs.find(
          (other) =>
            other !== job &&
            other.sessionId === id &&
            other.status === "unknown" &&
            other.name === file.name &&
            other.size === file.size &&
            other.sha256 === job.sha256,
        );
        if (pending) {
          job.id = pending.id;
          this.jobs.splice(this.jobs.indexOf(pending), 1);
        }
        job.status = "uploading";
        try {
          this.save();
        } catch {
          job.status = "failed";
          job.error = "浏览器无法保存上传编号，本次尚未发送。";
          this.changed();
          continue;
        }
        job.file = await this.api.uploadFile(
          id,
          job.id,
          file,
          job.sha256,
          this.lifetime.signal,
        );
        if (this.lifetime.signal.aborted) return;
        job.status = "ready";
        this.save();
        if (id === this.selectedId && this.open) void this.refresh();
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        job.status =
          error instanceof ApiError && error.status < 500
            ? "failed"
            : "unknown";
        job.error = fileError(error);
        try {
          this.save();
        } catch {
          this.notify("上传状态未能保存到浏览器。");
        }
        this.problem(error, id);
      } finally {
        if (!this.lifetime.signal.aborted) this.changed();
      }
    }
  }
  async checkUpload(job: UploadJob) {
    try {
      const file = await this.api.uploadedFile(
        job.sessionId,
        job.id,
        job.name,
        this.lifetime.signal,
      );
      if (this.lifetime.signal.aborted) return;
      if (file.sha256 !== job.sha256 || file.size !== job.size)
        throw new ApiError(409, "UPLOAD_CONFLICT");
      job.file = file;
      job.status = "ready";
      job.error = undefined;
      this.save();
      this.changed();
    } catch (error) {
      job.error = fileError(error);
      this.problem(error, job.sessionId);
      this.changed();
    }
  }
  async download(path: string) {
    const id = this.selectedId;
    if (!id || this.downloading) return;
    this.downloading = true;
    this.changed();
    try {
      const blob = await this.api.downloadFile(id, path, this.lifetime.signal);
      if (this.lifetime.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.problem(error, id);
    } finally {
      this.downloading = false;
      if (!this.lifetime.signal.aborted) this.changed();
    }
  }
  clear() {
    this.storage.removeItem(this.storageKey);
  }
  forget(id: string) {
    if (this.selectedId === id) this.select(undefined);
    this.jobs = this.jobs.filter(job => job.sessionId !== id);
    this.directories.delete(id);
    try { this.save(); } catch { this.notify("浏览器上传缓存清理未完成，请清除本站数据。"); }
    this.changed();
  }
  dispose() {
    this.lifetime.abort();
    this.selection.abort();
  }
}
