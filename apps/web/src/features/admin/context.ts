import { useOutletContext } from "react-router";
import type { BrowserApi } from "../../state/api.js";
export interface AdminContext {
  api: BrowserApi;
  userId: string;
  notify(text: string): void;
  problem(error: unknown): void;
  openNavigation(): void;
  requestChange<T>(path: string, method: string, input: Record<string, unknown>): Promise<T>;
}
export const useAdmin = () => useOutletContext<AdminContext>();
