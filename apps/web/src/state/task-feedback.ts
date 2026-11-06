/** 只按保存下来的事实解释结果；旧记录没有原因时不推断用户按过停止。 */
import type { Message } from "../../../../src/service/types.js";
import { explainCode } from "./errors.js";
export function resultInfo(message: Message): Record<string, unknown> {
  try { const value = JSON.parse(message.result ?? "null"); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
export function messageFeedback(message: Message) {
  const info = resultInfo(message);
  if (info.reason === "task_timeout" || info.error === "TASK_TIMEOUT")
    return { title: "本轮执行超时", description: explainCode("TASK_TIMEOUT") };
  if (info.reason === "environment_closed") return { title: "工作环境已关闭", description: "本轮因工作环境关闭而中断。已保存的文件保留，可以检查结果后继续。" };
  if (message.status === "cancelled") return {
    title: info.reason === "user_cancelled" || message.cancelRequested ? "本轮已停止" : "本轮已中断",
    description: info.reason === "user_cancelled" || message.cancelRequested
      ? "停止前已保存的文件仍在工作区。可以检查结果后继续修改。"
      : "这条记录没有保存具体的中断原因。已保存的对话和文件仍可查看，可以在下方继续。",
  };
  if (["failed", "interrupted"].includes(message.status)) return {
    title: "本轮未完成", description: explainCode(typeof info.error === "string" ? info.error : "EXECUTION_FAILED"),
  };
  return undefined;
}
export function messageStatusLabel(message: Message) {
  const feedback = messageFeedback(message);
  return feedback?.title;
}
