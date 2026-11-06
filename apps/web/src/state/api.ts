/** 网页使用同源Cookie；这里不保存、回传或持久化开发访问密钥。 */
import {
  ApiError,
  ServiceClient,
  type SessionDetail,
} from "../../../../src/clients/service-client.js";
import type {
  FileListing,
  FilePreview,
  UploadedFile,
} from "../../../../src/service/files/types.js";
import type { Message, ServiceEvent } from "../../../../src/service/types.js";
export interface LoginConfig {
  oidc: boolean;
  keyLogin: boolean;
  passwordLogin?: boolean;
  registration?: boolean;
}
export interface HistoryPage {
  session: SessionDetail;
  through: number;
  events: ServiceEvent[];
  messages: Message[];
}
export class BrowserApi extends ServiceClient {
  private userId?: string;
  constructor() {
    super("");
  }
  bindUser(userId?: string) {
    this.userId = userId;
  }
  protected override headers() {
    return {
      ...super.headers(),
      ...(this.userId ? { "X-Harbor-User": this.userId } : {}),
    };
  }
  me() {
    return this.request<{
      userId: string;
      capabilities: { managePlatform: boolean };
    }>("/auth/me");
  }
  login(accessKey: string) {
    return this.request<{ userId: string }>("/auth/login", "POST", {
      accessKey,
    });
  }
  async passwordLogin(email: string, password: string, register: boolean) {
    await this.request(register ? "/auth/register" : "/auth/password", "POST", { email, password });
    return this.me();
  }
  logout() {
    return this.request("/auth/logout", "POST");
  }
  async create(
    title: string,
    template: string,
    skillVersionIds?: string[],
    deploymentId?: string,
    clientRequestId: string = crypto.randomUUID(),
  ) {
    const userId = this.userId;
    let selection:
      { digest: string; skills: { versionId: string }[] } | undefined;
    try {
      selection = await this.request(
        `/skill-selection${skillVersionIds ? "?" + skillVersionIds.map((id) => "version=" + encodeURIComponent(id)).join("&") : ""}`,
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (this.userId !== userId) throw new ApiError(401, "LOGIN_CHANGED");
    return this.request<SessionDetail>("/sessions", "POST", {
      title,
      template,
      deploymentId: deploymentId || undefined,
      clientRequestId,
      ...(selection
        ? {
            skillSelection: {
              expectedSelectionDigest: selection.digest,
              skillVersionIds: selection.skills.map((skill) => skill.versionId),
            },
          }
        : {}),
    });
  }
  async importSkill(file: File) {
    const userId = this.userId;
    if (file.size > 20 * 1024 * 1024) throw new ApiError(413, "PACKAGE_LIMIT");
    const sha256 = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      ),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (this.userId !== userId) throw new ApiError(401, "LOGIN_CHANGED");
    const record = await this.request<{ id: string }>(
      "/skill-imports",
      "POST",
      {
        clientRequestId: crypto.randomUUID(),
        fileName: file.name,
        size: file.size,
        sha256,
      },
    );
    if (this.userId !== userId) throw new ApiError(401, "LOGIN_CHANGED");
    const response = await this.binary(
      `/skill-imports/${record.id}/content`,
      AbortSignal.timeout(60_000),
      file,
      sha256,
    );
    return response.json();
  }
  async exportSkill(versionId: string) {
    return (
      await this.binary(
        `/skill-versions/${versionId}/export`,
        AbortSignal.timeout(60_000),
      )
    ).blob();
  }
  message(sessionId: string, id: string, signal?: AbortSignal) {
    return this.request<Message>(
      `/sessions/${sessionId}/messages/${id}`,
      "GET",
      undefined,
      signal,
    );
  }
  history(id: string, after: number, through?: number, signal?: AbortSignal) {
    return this.request<HistoryPage>(
      `/sessions/${id}/history?after=${after}&limit=100${through === undefined ? "" : `&through=${through}`}`,
      "GET",
      undefined,
      signal,
    );
  }
  files(id: string, path: string, signal: AbortSignal) {
    return this.request<FileListing>(
      `/sessions/${id}/files?path=${encodeURIComponent(path)}`,
      "GET",
      undefined,
      signal,
    );
  }
  previewFile(id: string, path: string, signal: AbortSignal) {
    return this.request<FilePreview>(
      `/sessions/${id}/files/preview?path=${encodeURIComponent(path)}`,
      "GET",
      undefined,
      signal,
    );
  }
  uploadedFile(
    id: string,
    uploadId: string,
    name: string,
    signal: AbortSignal,
  ) {
    return this.request<UploadedFile>(
      `/sessions/${id}/files/uploads/${uploadId}?name=${encodeURIComponent(name)}`,
      "GET",
      undefined,
      signal,
    );
  }
  private async binary(
    path: string,
    signal: AbortSignal,
    file?: Blob,
    sha256?: string,
  ) {
    const response = await fetch(`/api${path}`, {
      method: file ? "PUT" : "GET",
      body: file,
      headers: {
        ...this.headers(),
        ...(file
          ? {
              "Content-Type": "application/octet-stream",
              "X-Content-Sha256": sha256!,
            }
          : {}),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) {
      const value = (await response.json()) as { error: string };
      throw new ApiError(response.status, value.error);
    }
    return response;
  }
  async uploadFile(
    id: string,
    uploadId: string,
    file: File,
    sha256: string,
    signal: AbortSignal,
  ) {
    const response = await this.binary(
      `/sessions/${id}/files/uploads/${uploadId}?name=${encodeURIComponent(file.name)}`,
      signal,
      file,
      sha256,
    );
    return response.json() as Promise<UploadedFile>;
  }
  async downloadFile(id: string, path: string, signal: AbortSignal) {
    const response = await this.binary(
      `/sessions/${id}/files/download?path=${encodeURIComponent(path)}`,
      signal,
    );
    return response.blob();
  }
  async sessions(signal?: AbortSignal) {
    const result: SessionDetail[] = [];
    let after = "";
    while (true) {
      const page = await this.request<SessionDetail[]>(
        `/sessions?order=created&limit=100${after ? `&after=${after}` : ""}`,
        "GET",
        undefined,
        signal,
      );
      result.push(...page);
      if (page.length < 100) return result;
      after = page.at(-1)!.id;
    }
  }
}
