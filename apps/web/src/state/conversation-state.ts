/** 纯数据层：按事件编号重建会话，回答和工具记录始终属于原消息。 */
import type {
  ClientEvent,
  SessionDetail,
} from "../../../../src/clients/service-client.js";
import type { Message, MessageStatus } from "../../../../src/service/types.js";
export type Connection =
  | "loading"
  | "connecting"
  | "synchronizing"
  | "connected"
  | "disconnected"
  | "error";
export interface ToolCall {
  name: string;
  detail?: string;
  at?: number;
}
export interface DisplayMessage {
  lastOutputAt?: number;
  observedAt?: number;
  record: Message;
  text: string;
  tools: ToolCall[];
}
export const isActive = (message?: Message | null) =>
  Boolean(
    message &&
    ["accepted", "running", "finalizing", "reconciling"].includes(
      message.status,
    ),
  );
const states: MessageStatus[] = [
  "accepted",
  "running",
  "finalizing",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "reconciling",
];

export class ConversationState {
  messages = new Map<string, DisplayMessage>();
  cursor = 0;
  connection: Connection = "loading";
  error?: string;
  submitting = false;
  control?: "cancel" | "close";
  syncSnapshot?: SessionDetail;
  activity: string[] = [];
  constructor(public detail: SessionDetail) {}
  get id() {
    return this.detail.id;
  }
  get latest() {
    return this.detail.lastMessageId
      ? (this.messages.get(this.detail.lastMessageId)?.record ??
          this.detail.message)
      : null;
  }
  get ordered() {
    return [...this.messages.values()].sort(
      (a, b) => a.record.createdEventId - b.record.createdEventId,
    );
  }

  add(record: Message) {
    if (this.messages.has(record.id)) return;
    // 初次回放按事件推进状态，不让较新的REST结果被较旧的历史事件短暂覆盖。
    this.messages.set(record.id, {
      record: { ...record, status: "accepted", cancelRequested: 0 },
      observedAt: Date.now(),
      text: "",
      tools: [],
    });
  }
  apply(event: ClientEvent, replay = false) {
    if (event.id <= this.cursor) return false;
    const id = event.data.messageId;
    const message = id ? this.messages.get(id) : undefined;
    if (event.type === "message.accepted" && id) this.detail.lastMessageId = id;
    if (event.type === "model.activated") {
      const model = event.data.model as import("../../../../src/shared/llm.js").ModelSnapshot;
      this.detail.modelSnapshot = model;
      if (message) message.record.activatedModelSnapshot = model;
    }
    if (event.type === "model.replaced") {
      const to = event.data.to as import("../../../../src/shared/llm.js").ModelSnapshot;
      this.detail.modelSnapshot = to;
      if (message) message.record.activatedModelSnapshot = to;
    }
    if (event.type === "message.started" && message) {
      message.record.status = "running";
      if (typeof event.data.startedAt === "number") message.record.startedAt = event.data.startedAt;
    }
    if (event.type === "message.stopping" && message)
      message.record.cancelRequested = 1;
    if (
      ["message.state", "message.finished"].includes(event.type) &&
      message &&
      states.includes(event.data.status as MessageStatus)
    ) {
      message.record.status = event.data.status as MessageStatus;
      if (event.type === "message.finished") {
        message.record.result = JSON.stringify(event.data.result ?? null);
        if (typeof event.data.finishedAt === "number") message.record.finishedAt = event.data.finishedAt;
      }
    }
    if (!replay && message && ["assistant.text.delta", "tool.started"].includes(event.type))
      message.lastOutputAt = Date.now();
    if (event.type === "assistant.text.delta" && message)
      message.text += String(event.data.text ?? "");
    if (event.type === "tool.started" && message)
      message.tools.push({
        name: String(event.data.name ?? "工具"),
        detail:
          typeof event.data.detail === "string"
            ? event.data.detail
            : undefined,
        at: typeof event.data.at === "number" ? event.data.at : undefined,
      });
    if (event.type === "environment.changed")
      this.detail.environment = event.data
        .environment as SessionDetail["environment"];
    const description =
      event.type === "tool.started"
        ? `发起 ${event.data.name} 调用`
        : event.type === "message.accepted"
          ? "消息已接收"
          : event.type === "model.replaced"
            ? "模型版本已按部署指针更新"
          : event.type === "message.started"
            ? "本轮开始执行"
            : event.type === "message.stopping"
              ? "已请求停止本轮"
              : event.type === "message.finished"
                ? "本轮执行结束"
                : event.type === "environment.changed"
                  ? "工作环境状态已更新"
                  : event.type === "task.updated"
                    ? `后台任务：${event.data.status ?? event.data.subtype}`
                    : undefined;
    if (description) this.activity.unshift(description);
    this.activity.length = Math.min(this.activity.length, 12);
    this.cursor = event.id;
    this.detail.lastEventId = Math.max(this.detail.lastEventId, event.id);
    if (!replay) this.detail.updatedAt = Date.now();
    this.finishSync();
    return true;
  }
  /** 先查当前快照，再等SSE追到该编号，才恢复发送/停止等操作。 */
  beginSync(snapshot: SessionDetail) {
    this.syncSnapshot = snapshot;
    this.connection = "synchronizing";
    this.finishSync();
  }
  private finishSync() {
    if (!this.syncSnapshot || this.cursor < this.syncSnapshot.lastEventId)
      return;
    const snapshot = this.syncSnapshot;
    this.detail = { ...snapshot, lastEventId: this.cursor };
    if (snapshot.message) {
      const latest = this.messages.get(snapshot.message.id);
      if (latest) latest.record = snapshot.message;
    }
    this.syncSnapshot = undefined;
    this.connection = "connected";
    this.error = undefined;
    this.control = undefined;
  }
}
