/** 服务版交互：退出只断开，Ctrl+C明确停止本客户端提交的当前消息。 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ServiceClient } from "../service-client.js";
import { display } from "./display.js";
export async function chat(client: ServiceClient, id: string) {
  const session = await client.session(id);
  const watch = new AbortController();
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let ownMessage: string | undefined;
  let submitting = false;
  let pendingStop = false;
  let busy = session.message && ["accepted", "running", "finalizing", "reconciling"].includes(session.message.status);
  const stop = () => {
    if (ownMessage) void client.cancel(id, ownMessage).catch(error => console.error(String(error)));
    // 提交中的消息ID还没回来：记下意图，拿到ID后再取消，不能直接断开。
    else if (submitting) pendingStop = true;
    else terminal.close();
  };
  terminal.on("SIGINT", stop);
  process.on("SIGINT", stop);
  const detach = () => terminal.close();
  process.on("SIGTERM", detach);
  process.on("SIGHUP", detach);
  terminal.on("close", () => watch.abort());
  console.log("/exit 断开连接；/close 关闭工作环境；Ctrl+C 停止本客户端当前任务。历史结果会补发。");
  const viewing = (async () => {
    for await (const event of client.events(id, 0, watch.signal)) {
      display(event);
      if (event.type === "message.accepted") busy = true;
      if (event.type === "message.finished") {
        if (event.data.messageId === ownMessage) ownMessage = undefined;
        // 结束事件先解除忙状态，避免界面已显示结束却吞掉下一行输入。
        busy = false;
        terminal.prompt();
        // 历史结束事件可能晚到；只有确实存在另一条活动消息时才恢复忙状态。
        const current = await client.session(id);
        busy = !!(current.message && current.message.id !== event.data.messageId &&
          ["accepted", "running", "finalizing", "reconciling"].includes(current.message.status));
      }
    }
  })();
  void viewing.catch(error => { console.error(String(error)); terminal.close(); });
  terminal.setPrompt("> "); terminal.prompt();
  try {
    for await (const text of terminal) {
      if (text.trim() === "/exit") break;
      if (text.trim() === "/close") {
        const latest = await client.session(id);
        await client.close(id, latest.lastMessageId);
        break;
      }
      if (!text.trim()) { terminal.prompt(); continue; }
      if (busy || submitting) { console.log("当前会话仍在执行，请等待结束。"); continue; }
      submitting = true;
      const clientMessageId = randomUUID();
      console.log(`[请求 ${clientMessageId}]`);
      try {
        const { message } = await client.send(id, clientMessageId, text);
        // 很短的任务可能在HTTP响应前已经结束；不要因此永远停在busy。
        const latest = await client.session(id);
        busy = latest.message && ["accepted", "running", "finalizing", "reconciling"].includes(latest.message.status);
        ownMessage = busy && latest.message?.id === message.id ? message.id : undefined;
        // 提交期间按下的Ctrl+C在这里补发；任务已结束时只清掉意图，不退出交互。
        if (pendingStop) { pendingStop = false; if (ownMessage) void client.cancel(id, ownMessage).catch(error => console.error(String(error))); }
      } catch (error) { console.error(String(error)); terminal.prompt(); }
      finally { submitting = false; }
    }
  } finally {
    terminal.close(); watch.abort(); await viewing.catch(() => {});
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", detach);
    process.removeListener("SIGHUP", detach);
  }
}
