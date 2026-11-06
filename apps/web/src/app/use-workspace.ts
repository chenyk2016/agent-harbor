/** React负责展示；经过验证的消息去重、草稿和SSE恢复仍由状态对象管理。 */
import { useEffect, useReducer, useState } from "react";
import { BrowserApi } from "../state/api.js";
import { Workspace } from "../state/workspace.js";
import { LocalState } from "../state/local-state.js";
import { FileBrowser } from "../state/files.js";
import { isActive } from "../state/conversation-state.js";

export interface Workbench {
  work: Workspace;
  files: FileBrowser;
  canUpload: () => boolean;
  changed: () => void;
}
export function useWorkspace(
  api: BrowserApi,
  userId: string,
  expired: () => void,
  notify: (text: string) => void,
  listOwner?: Workspace,
) {
  const [, changed] = useReducer((n) => n + 1, 0);
  const [bench, setBench] = useState<Workbench>();
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (alive) changed();
    };
    const work = new Workspace(
      api,
      new LocalState(userId, localStorage),
      userId,
      refresh,
      expired,
      notify,
      listOwner,
    );
    const canUpload = (): boolean => {
      const state = work.current;
      return (
        !!state &&
        state.connection === "connected" &&
        !isActive(state.latest) &&
        !state.submitting &&
        !state.control &&
        ["closed", "ready"].includes(state.detail.environment) &&
        !files.busy(state.id)
      );
    };
    const files: FileBrowser = new FileBrowser(
      api,
      userId,
      localStorage,
      refresh,
      notify,
      (id) => work.selectedId === id && canUpload(),
      expired,
    );
    work.fileBusy = (id) => files.busy(id);
    setBench({ work, files, canUpload, changed: refresh });
    // URL 决定查看哪个会话；初始化只读取列表，不抢选上次会话。
    void work.start(false);
    const foreground = () => {
      if (!document.hidden) void work.refreshList();
    };
    if (!listOwner) document.addEventListener("visibilitychange", foreground);
    const detached = () => {
      work.dispose();
      files.dispose();
    };
    window.addEventListener("pagehide", detached);
    return () => {
      alive = false;
      if (!listOwner) document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("pagehide", detached);
      detached();
    };
  }, [api, userId, expired, notify, listOwner]);

  // 选择变化或本轮结束时，文件面板沿用原有刷新/旧响应排除规则。
  const message = bench?.work.current?.latest;
  useEffect(() => {
    bench?.files.select(
      bench.work.selectedId,
      message ? `${message.id}:${isActive(message) ? "active" : "done"}` : "",
    );
  }, [bench, bench?.work.selectedId, message?.id, message?.status]);
  return bench;
}
