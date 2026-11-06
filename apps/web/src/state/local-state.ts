/** 只保存当前用户的草稿与待确认请求；从不保存Cookie、访问密钥或网关凭证。 */
export interface PendingMessage {
  clientMessageId: string;
  text: string;
  modelId?: string;
}
interface SavedState {
  selectedId?: string;
  drafts: Record<string, string>;
  pending: Record<string, PendingMessage>;
  models?: Record<string, string>;
  pinned?: string[];
  removed?: string[];
}
export class LocalState {
  private state: SavedState;
  private key: string;
  constructor(
    userId: string,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  ) {
    this.key = `agent-harbor:v4:${encodeURIComponent(userId)}`;
    try {
      const saved = JSON.parse(storage.getItem(this.key) ?? "null");
      this.state =
        saved?.drafts && saved?.pending
          ? { ...saved, pinned: saved.pinned ?? [] }
          : { drafts: {}, pending: {}, pinned: [] };
    } catch {
      this.state = { drafts: {}, pending: {}, pinned: [] };
    }
  }
  private save() {
    // 外壳和应用编辑器可能持有不同缓存实例；旧响应不能把已删除的草稿写回来。
    const raw = this.storage.getItem(this.key);
    let latest: { removed?: string[] } | null = null;
    try { latest = JSON.parse(raw ?? "null"); } catch { /* 损坏的旧缓存由本次有效状态覆盖。 */ }
    const removed = new Set<string>([...(this.state.removed ?? []), ...(Array.isArray(latest?.removed) ? latest.removed : [])]);
    for (const id of removed) {
      delete this.state.drafts[id]; delete this.state.pending[id]; delete this.state.models?.[id];
      this.state.pinned = this.state.pinned?.filter(value => value !== id);
      if (this.state.selectedId === id) delete this.state.selectedId;
    }
    this.state.removed = [...removed];
    // 持久化失败交给调用方提示；发送前若存不下请求编号，就不发起新执行。
    this.storage.setItem(this.key, JSON.stringify(this.state));
  }
  get selectedId() {
    return this.state.selectedId;
  }
  select(id: string) {
    this.state.selectedId = id;
    this.save();
  }
  draft(id: string) {
    return this.state.drafts[id] ?? "";
  }
  setDraft(id: string, text: string) {
    this.state.drafts[id] = text;
    this.save();
  }
  model(id: string) { return this.state.models?.[id]; }
  setModel(id: string, modelId: string) {
    (this.state.models ??= {})[id] = modelId;
    this.save();
  }
  pinned(id: string) {
    return (this.state.pinned ?? []).includes(id);
  }
  togglePin(id: string) {
    const pinned = new Set(this.state.pinned ?? []);
    if (pinned.has(id)) pinned.delete(id);
    else pinned.add(id);
    this.state.pinned = [...pinned];
    this.save();
  }
  pending(id: string) {
    return this.state.pending[id];
  }
  prepare(id: string, request: PendingMessage) {
    this.state.pending[id] = request;
    this.save();
  }
  accepted(id: string) {
    const request = this.state.pending[id];
    // 提交期间用户可能又写了内容；只清除已被接受的那份原文。
    if (request && this.draft(id) === request.text)
      delete this.state.drafts[id];
    delete this.state.pending[id];
    this.save();
  }
  rejected(id: string) {
    delete this.state.pending[id];
    this.save();
  }
  clear() {
    this.storage.removeItem(this.key);
    this.state = { drafts: {}, pending: {}, pinned: [] };
  }
  forget(id: string) {
    this.state.removed = [...(this.state.removed ?? []), id];
    delete this.state.drafts[id]; delete this.state.pending[id]; delete this.state.models?.[id];
    this.state.pinned = this.state.pinned?.filter(value => value !== id);
    if (this.state.selectedId === id) delete this.state.selectedId;
    this.save();
  }
}
