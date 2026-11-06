/** 重试保留原模型和版本，避免已被接收的请求在页面重绘后改变含义。 */
import { ApiError } from "../../../../src/clients/service-client.js";
import { BrowserApi } from "./api.js";
import type { Message } from "../../../../src/service/types.js";
/** 为应用编辑页适配会话消息提交接口，将消息送到应用写入门，并固定重试所用的源码版本和模型。 */
export class ApplicationApi extends BrowserApi {
  readonly requests = new Map<string, { head: string | null; modelDeploymentId?: string }>();
  private owner = "";
  /** 绑定应用编号、当前源码头读取函数和可恢复请求存储；同一实例只服务一个应用。 */
  constructor(readonly appId: string, readonly head: () => string | null,
    private storage = typeof localStorage === "undefined" ? undefined : localStorage) { super(); }
  /** 同步基础 API 的认证用户及本地请求归属，避免不同账号共用重试记录。 */
  override bindUser(userId?: string) { super.bindUser(userId); this.owner = userId ?? ""; }

  /** 首次发送时持久化请求的头版本和模型，重试沿用原值，再向应用消息入口提交需求。 */
  override async send(_sessionId: string, clientMessageId: string, text: string, modelDeploymentId?: string) {
    if (!this.requests.has(clientMessageId)) {
      const key = `ah-app-request:${this.owner}:${this.appId}`;
      let original = { head: this.head(), modelDeploymentId };
      try {
        const saved = JSON.parse(this.storage?.getItem(key) ?? "null");
        if (saved?.clientMessageId === clientMessageId &&
            (saved.head === null || typeof saved.head === "string") &&
            (saved.modelDeploymentId === undefined || typeof saved.modelDeploymentId === "string")) original = { head: saved.head, modelDeploymentId: saved.modelDeploymentId };
        // 先保存请求归属；刷新后仍用原模型和原版本核对，不重复生成。
        this.storage?.setItem(key, JSON.stringify({ clientMessageId, ...original }));
      } catch { throw new ApiError(409, "REQUEST_NOT_SAVED"); }
      this.requests.set(clientMessageId, original);
    }
    const original = this.requests.get(clientMessageId)!;
    return this.request<{ message: Message }>(`/applications/${this.appId}/messages`, "POST", {
      clientMessageId, text, modelDeploymentId: original.modelDeploymentId, expectedHeadRevisionId: original.head,
    });
  }
}
