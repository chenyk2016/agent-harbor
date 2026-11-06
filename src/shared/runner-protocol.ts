/** 宿主与常驻Runner的后端协议。用户连接不直接持有这条管道。 */
import type { Task } from "./types.js";

/** 宿主发给 Runner 的控制命令：提交固定任务、中断指定轮次或关闭整个输入流。 */
export type RunnerCommand =
  | { type: "message"; task: Task }
  | { type: "interrupt"; attemptId: string }
  | { type: "close" };

/** seq属于整个Runner；attempt身份缺省时是环境事件，不归到当前用户轮次。 */
export interface RunnerEvent {
  sessionId: string;
  runnerId: string;
  seq: number;
  type: string;
  attemptId?: string;
  generation?: number;
  payload: Record<string, unknown>;
  toolContent?: { input: unknown; output: unknown };
}
