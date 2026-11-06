/** 页面只负责展示；这里持有会话缓存、请求归属和查看连接的生命周期。 */
import {
  ApiError,
  type SessionDetail,
} from "../../../../src/clients/service-client.js";
import { BrowserApi } from "./api.js";
import { ConversationState, isActive } from "./conversation-state.js";
import { LocalState } from "./local-state.js";
import { explain } from "./errors.js";
export { explain } from "./errors.js";

export interface AppLink {
  id: string;
  title: string;
  status: string;
}

/** 会话标题取首行、压缩空白并限制长度；应用名称同理。 */
export function draftTitle(text: string, fallback: string) {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? line.replace(/\s+/g, " ").slice(0, 40) : fallback;
}

export class Workspace {
  sessions = new Map<string, SessionDetail>();
  conversations = new Map<string, ConversationState>();
  /** developmentSessionId → 应用；列表图标和点击分流只依赖这份映射。 */
  applications = new Map<string, AppLink>();
  selectedId?: string;
  query = "";
  listError?: string;
  loadingList = true;
  appsLoaded = false;
  fileBusy: (id: string) => boolean = () => false;
  private generation = 0;
  private selection?: AbortController;
  private lifetime = new AbortController();
  private poll?: ReturnType<typeof setInterval>;
  private appsAt = 0;
  private appsLoading = false;
  private removedSessions = new Set<string>();
  constructor(
    readonly api: BrowserApi,
    readonly local: LocalState,
    readonly userId: string,
    private changed: () => void,
    private expired: () => void,
    private notify: (text: string) => void,
    private readonly listOwner?: Workspace,
  ) {}
  get current() {
    return this.selectedId
      ? this.conversations.get(this.selectedId)
      : undefined;
  }
  forgetSession(id: string) {
    this.removedSessions.add(id);
    if (this.selectedId === id) { this.selection?.abort(); this.generation++; this.selectedId = undefined; }
    this.sessions.delete(id); this.conversations.delete(id); this.applications.delete(id);
    try { this.local.forget(id); } catch { this.notify("浏览器缓存清理未完成，请清除本站数据。"); }
    this.changed();
  }
  get visible() {
    return [...this.sessions.values()]
      .filter((s) => s.title.toLowerCase().includes(this.query.toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get draft() {
    return this.selectedId ? this.local.draft(this.selectedId) : "";
  }
  get modelId() {
    return this.selectedId ? (this.local.model(this.selectedId) ?? this.current?.detail.modelSnapshot?.deploymentId) : undefined;
  }
  setModel(modelId: string) {
    if (this.selectedId) { this.local.setModel(this.selectedId, modelId); this.changed(); }
  }
  get pending() {
    return this.selectedId ? this.local.pending(this.selectedId) : undefined;
  }
  pinned(id: string) {
    return this.local.pinned(id);
  }
  togglePin(id: string) {
    this.local.togglePin(id);
    this.changed();
  }
  private problem(error: unknown) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.code === "ACCOUNT_DISABLED")
    ) {
      this.dispose();
      this.expired();
      return;
    }
    this.notify(explain(error));
  }
  applicationFor(sessionId: string) {
    return this.applications.get(sessionId);
  }
  /** 应用列表或编辑页返回的记录都回填到同一张映射表；无变化时不触发重绘。 */
  rememberApplication(app: {
    id: string;
    title: string;
    status: string;
    developmentSessionId: string | null;
  }) {
    if (!app.developmentSessionId) return;
    const old = this.applications.get(app.developmentSessionId);
    this.applications.set(app.developmentSessionId, {
      id: app.id,
      title: app.title,
      status: app.status,
    });
    this.appsLoaded = true;
    if (!old || old.id !== app.id || old.title !== app.title || old.status !== app.status)
      this.changed();
  }
  rememberApplications(
    list: {
      id: string;
      title: string;
      status: string;
      developmentSessionId: string | null;
    }[],
  ) {
    for (const app of list) this.rememberApplication(app);
    this.appsLoaded = true;
    this.changed();
  }
  /** 应用服务未开启或账号无权限时静默降级，不影响普通会话。 */
  async loadApplications() {
    if (this.appsLoading || this.lifetime.signal.aborted) return;
    this.appsLoading = true;
    try {
      const list = await this.api.request<
        {
          id: string;
          title: string;
          status: string;
          developmentSessionId: string | null;
        }[]
      >("/applications");
      if (this.lifetime.signal.aborted) return;
      this.applications.clear();
      for (const app of list)
        if (app.developmentSessionId)
          this.applications.set(app.developmentSessionId, {
            id: app.id,
            title: app.title,
            status: app.status,
          });
    } catch {
      // 404/403/网络中断都按“没有应用会话”展示；已缓存的映射继续可用。
    } finally {
      this.appsLoading = false;
      this.appsAt = Date.now();
      this.appsLoaded = true;
      this.changed();
    }
  }
  /**
   * 入口发送即创建：会话与首条消息一次完成。
   * 创建失败抛给入口；消息失败仍返回会话编号，并把原文留作草稿供重试。
   */
  async startConversation(
    text: string,
    modelId?: string,
    clientRequestId?: string,
  ) {
    const session = await this.api.create(
      draftTitle(text, "新的会话"),
      "empty",
      undefined,
      modelId,
      clientRequestId,
    );
    if (this.lifetime.signal.aborted) return session.id;
    this.sessions.set(session.id, { ...session, message: null });
    const request = {
      clientMessageId: crypto.randomUUID(),
      text,
      modelId,
    };
    try {
      this.local.prepare(session.id, request);
    } catch {
      this.local.setDraft(session.id, text);
      this.notify("浏览器无法保存请求编号，本次尚未发送。请在会话中重新发送。");
      this.changed();
      return session.id;
    }
    try {
      const result = await this.api.send(
        session.id,
        request.clientMessageId,
        request.text,
        request.modelId,
      );
      if (this.lifetime.signal.aborted) return session.id;
      this.sessions.set(session.id, {
        ...session,
        message: result.message,
      });
      this.local.accepted(session.id);
    } catch (error) {
      if (this.lifetime.signal.aborted) return session.id;
      // 明确拒绝才丢弃请求编号；网络结果未知时保留 pending，供会话页核对重试。
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401
      )
        this.local.rejected(session.id);
      this.local.setDraft(session.id, text);
      this.problem(error);
    }
    this.changed();
    return session.id;
  }

  async start(restoreSelection = true) {
    if (this.listOwner) return;
    void this.loadApplications();
    await this.refreshList();
    if (this.lifetime.signal.aborted) return;
    const saved = this.local.selectedId;
    const id = saved && this.sessions.has(saved) ? saved : this.visible[0]?.id;
    if (restoreSelection && id) void this.select(id);
    this.poll = setInterval(() => {
      if (!globalThis.document?.hidden) void this.refreshList();
    }, 10_000);
  }
  async refreshList() {
    if (this.listOwner || this.lifetime.signal.aborted) return;
    const before = new Set(this.sessions.keys());
    try {
      const sessions = await this.api.sessions(this.lifetime.signal);
      if (this.lifetime.signal.aborted) return;
      // 列表可能晚于流事件返回，不能用旧列表覆盖新状态。
      for (const item of sessions) {
        if (this.removedSessions.has(item.id)) continue;
        const old = this.sessions.get(item.id);
        if (!old || item.lastEventId >= old.lastEventId)
          this.sessions.set(item.id, item);
      }
      const present = new Set(sessions.map(item => item.id));
      for (const id of before) if (!present.has(id)) this.forgetSession(id);
      this.listError = undefined;
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        this.listError = explain(error);
        this.problem(error);
      }
    } finally {
      this.loadingList = false;
      // 应用会话映射变化不频繁；随列表轮询每分钟顺带刷新一次。
      if (Date.now() - this.appsAt > 60_000) void this.loadApplications();
      this.changed();
    }
  }
  async select(id: string) {
    let detail = this.sessions.get(id) ?? this.listOwner?.sessions.get(id);
    if ((!detail && !this.listOwner) || this.lifetime.signal.aborted) return;
    this.selection?.abort();
    const connection = (this.selection = new AbortController());
    const generation = ++this.generation;
    // 编辑页复用外层列表；刚创建或从链接打开时，缓存未命中只读取目标会话。
    if (!detail) {
      try {
        detail = await this.api.request<SessionDetail>(`/sessions/${id}`, "GET", undefined, connection.signal);
      } catch (error) {
        if (!connection.signal.aborted) this.problem(error);
        return;
      }
      if (connection.signal.aborted) return;
    }
    this.selectedId = id;
    try {
      this.local.select(id);
    } catch {
      this.notify("浏览器存储不可用，选择与草稿可能无法保留。");
    }
    let state = this.conversations.get(id);
    if (!state) {
      state = new ConversationState({ ...detail });
      this.conversations.set(id, state);
    }
    state.connection = "loading";
    state.error = undefined;
    this.changed();
    // A→B→A时，除会话编号以外，还要核对本次选择的代数。
    const current = () =>
      !connection.signal.aborted && generation === this.generation;
    try {
      await this.history(state, connection.signal);
      if (!current()) return;
      this.publish(state);
      await this.watch(state, connection.signal, current);
    } catch (error) {
      if (current()) {
        state.connection = "error";
        state.error = explain(error);
        this.problem(error);
        this.changed();
      }
    }
  }
  private async history(state: ConversationState, signal: AbortSignal) {
    let through: number | undefined;
    do {
      const page = await this.api.history(
        state.id,
        state.cursor,
        through,
        signal,
      );
      if (signal.aborted) return;
      through ??= page.through;
      for (const message of page.messages) {
        state.add(message);
        if (
          message.clientMessageId ===
          this.local.pending(state.id)?.clientMessageId
        )
          this.local.accepted(state.id);
      }
      for (const event of page.events)
        state.apply(
          {
            id: event.eventId,
            type: event.type,
            data: { ...event.payload, messageId: event.messageId },
          },
          true,
        );
      if (state.cursor >= through) return;
      if (!page.events.length) throw new Error("Missing persisted history");
    } while (!signal.aborted);
  }
  private async watch(
    state: ConversationState,
    signal: AbortSignal,
    current: () => boolean,
  ) {
    for await (const event of this.api.events(
      state.id,
      state.cursor,
      signal,
      async (status) => {
        if (!current()) return;
        if (status === "connected") {
          const snapshot = await this.api.request<SessionDetail>(
            `/sessions/${state.id}`,
            "GET",
            undefined,
            signal,
          );
          if (!current()) return;
          state.beginSync(snapshot);
        } else state.connection = status;
        this.changed();
      },
    )) {
      if (!current()) return;
      const id = event.data.messageId;
      if (id && !state.messages.has(id)) {
        const message = await this.api.message(state.id, id, signal);
        if (!current()) return;
        state.add(message);
        if (
          message.clientMessageId ===
          this.local.pending(state.id)?.clientMessageId
        )
          this.local.accepted(state.id);
      }
      state.apply(event);
      this.publish(state);
    }
  }
  private publish(state: ConversationState) {
    this.sessions.set(state.id, {
      ...state.detail,
      message: state.latest ?? null,
    });
    if (!isActive(state.latest) && state.detail.environment === "closed")
      state.control = undefined;
    if (!isActive(state.latest) && state.control === "cancel")
      state.control = undefined;
    this.changed();
  }
  setDraft(text: string) {
    if (!this.selectedId) return;
    try {
      this.local.setDraft(this.selectedId, text);
    } catch {
      this.notify("草稿未能保存到浏览器。请保留原文后再刷新。");
    }
    this.changed();
  }
  async create(title: string, template: string, modelId?: string) {
    const session = await this.api.create(title, template, undefined, modelId);
    if (this.lifetime.signal.aborted) return;
    this.sessions.set(session.id, { ...session, message: null });
    return session.id;
  }
  async send(retry = false) {
    const state = this.current;
    if (
      !state ||
      this.fileBusy(state.id) ||
      state.connection !== "connected" ||
      state.submitting ||
      state.control ||
      ["stopping", "reconciling"].includes(state.detail.environment)
    )
      return;
    const pending = this.local.pending(state.id);
    if (isActive(state.latest) || (pending && !retry)) return;
    const text = retry ? pending?.text : this.draft;
    if (!text?.trim()) return;
    // 编号先落盘；响应丢失或刷新后，只能用原编号核对/重试。
    const request = pending ?? { clientMessageId: crypto.randomUUID(), text, modelId: this.modelId };
    try {
      this.local.prepare(state.id, request);
    } catch {
      this.notify("浏览器无法保存请求编号，本次尚未发送。请启用本站存储。");
      return;
    }
    state.submitting = true;
    state.error = undefined;
    this.changed();
    try {
      const result = await this.api.send(
        state.id,
        request.clientMessageId,
        request.text,
        request.modelId,
      );
      if (this.lifetime.signal.aborted) return;
      state.add(result.message);
      // SSE可能先到，不覆盖已经推进的事件状态。
      if (state.cursor < result.message.createdEventId)
        state.detail.lastMessageId = result.message.id;
      this.local.accepted(state.id);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401
      )
        this.local.rejected(state.id);
      state.error = explain(error);
      this.problem(error);
    } finally {
      state.submitting = false;
      this.publish(state);
    }
  }
  async cancel() {
    const state = this.current;
    if (
      !state ||
      state.connection !== "connected" ||
      !isActive(state.latest) ||
      state.control ||
      !state.latest
    )
      return;
    const messageId = state.latest.id;
    state.control = "cancel";
    this.changed();
    try {
      await this.api.cancel(state.id, messageId);
    } catch (error) {
      state.error = explain(error);
      this.problem(error);
    }
    // HTTP成功只表示接收请求，等待message.finished确认停止。
    this.changed();
  }
  async close(id: string, expectedMessageId: string | null) {
    const state = this.conversations.get(id);
    if (!state || state.connection !== "connected" || state.control) return;
    state.control = "close";
    this.changed();
    try {
      await this.api.close(id, expectedMessageId);
    } catch (error) {
      state.error = explain(error);
      this.problem(error);
    }
    this.changed();
  }
  async reloadMcp(id: string, expectedMessageId: string | null) {
    const state = this.conversations.get(id);
    if (!state || state.control || isActive(state.latest)) return;
    state.control = "close";
    this.changed();
    try {
      await this.api.request("/sessions/" + id + "/mcp/reload", "POST", {
        expectedMessageId,
      });
      this.notify("已请求重新加载连接，下次发送时应用最新配置。");
    } catch (error) {
      state.control = undefined;
      state.error = explain(error);
      this.problem(error);
    }
    this.publish(state);
  }
  reconnect() {
    void this.refreshList();
    if (this.selectedId) void this.select(this.selectedId);
  }
  async logout() {
    await this.api.logout();
    this.dispose();
    this.local.clear();
    this.expired();
  }
  dispose() {
    this.lifetime.abort();
    this.selection?.abort();
    clearInterval(this.poll);
  }
}
