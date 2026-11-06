/** 外壳持有工作台对象和公共操作；子页面只读取，不另建会话状态。 */
import type { RefObject } from "react";
import { useOutletContext } from "react-router";
import type { BrowserApi } from "../state/api.js";
import type { Workbench } from "./use-workspace.js";
export interface WorkbenchContext {
  bench: Workbench;
  api: BrowserApi;
  composer: RefObject<HTMLTextAreaElement>;
  openNew(mode?: "chat" | "app"): void;
  showFiles(): void;
  created(id: string): Promise<void>;
  notify(text: string): void;
  problem(error: unknown): void;
  openNavigation(): void;
  openWorkspace(): void;
  openPalette(): void;
  openGuide(): void;
  closeEnvironment(): void;
}
export const useWorkbench = () => useOutletContext<WorkbenchContext>();
