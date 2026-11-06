/**
 * 终端连续对话入口。会话期间持有锁，复用容器及Runner；重建时才resume。
 * 不缓存或拼接聊天历史；容器停止、文件持久化及会话锁继续由 Controller 管理。
 */
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Controller } from "../../runtime/controller.js";

export async function chat(controller: Controller, sessionId: string, token: string) {
  // 在显示输入提示之前校验会话目录及已有元数据，避免误把损坏状态当新会话。
  const conversation = await controller.open(sessionId, token);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let active: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  let exitCode = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const waitForInput = () => {
    clearTimeout(idleTimer);
    if (closed) return;
    idleTimer = setTimeout(() => {
      process.stdout.write("\n会话空闲超时，对话已关闭。\n");
      terminal.close();
    }, controller.profile.idleTimeoutMs ?? 15 * 60_000);
    terminal.prompt();
  };
  const disconnect = () => terminal.close();
  process.on("SIGTERM", disconnect);
  process.on("SIGHUP", disconnect);

  /** 忙时只取消当前轮，不直接退出；必须等待 Controller 确认停止。 */
  const interrupt = () => {
    if (active) {
      if (!active.signal.aborted) {
        process.stdout.write("\n正在停止本轮，等待执行结束……\n");
        active.abort();
      }
    } else terminal.close();
  };
  // 键盘 Ctrl+C 由 readline 接收；外部发送的 SIGINT 由 process 接收。
  terminal.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  terminal.on("close", () => {
    closed = true;
    clearTimeout(idleTimer);
    active?.abort(); // EOF/终端断开时也取消当前轮，下面会等它完成收尾。
  });

  async function turn(prompt: string) {
    const abort = new AbortController(); // 每轮独立，上一轮取消不影响下一轮。
    active = abort;
    clearTimeout(idleTimer);
    process.stdout.write("\nClaude > ");
    try {
      const result = await conversation.run(prompt, event => {
        if (event.type === "assistant.text.delta")
          process.stdout.write(String(event.payload.text));
        else if (event.type === "tool.started")
          process.stdout.write(`\n[工具：${event.payload.name}]\n`);
        else if (event.type === "runner.failed")
          process.stderr.write(`\n[${event.payload.code}] ${event.payload.message}\n`);
      }, abort.signal);
      process.stdout.write("\n");
      // 收尾不确定时停止输入，不能让交互界面悄悄发起下一轮。
      if ((result.stopped !== true && result.environment !== "ready") || result.status === "reconciling") {
        process.stderr.write(`环境收尾尚未完成，对话已退出：${result.error ?? result.status}\n`);
        exitCode = 1;
        terminal.close();
      } else if (result.status === "cancelled") {
        process.stdout.write(closed ? "[本轮已取消]\n" : "[本轮已取消，可以继续输入]\n");
      } else if (result.status !== "succeeded") {
        process.stderr.write(`[本轮失败] ${result.error ?? result.result?.subtype ?? result.status}\n`);
      }
    } catch (error) {
      // 包括会话锁、镜像兼容性和引擎协调错误；不自动重试有副作用的输入。
      process.stderr.write(`对话已退出：${String(error)}\n`);
      exitCode = 1;
      terminal.close();
    } finally {
      active = undefined;
      if (!closed) waitForInput();
    }
  }

  terminal.on("line", line => {
    if (active) {
      // 不排队也不并行执行：避免用户执行中输入的文字变成意外的后续任务。
      process.stdout.write("\n本轮仍在执行，输入未提交；Ctrl+C 可取消。\n");
      return;
    }
    const prompt = line.trim();
    if (prompt === "/exit") terminal.close();
    else if (!prompt) waitForInput();
    else if (prompt === "/help") {
      process.stdout.write("/exit 退出；执行时 Ctrl+C 取消本轮，空闲时 Ctrl+C 退出。\n");
      waitForInput();
    } else {
      pending = turn(prompt);
    }
  });

  process.stdout.write(`会话：${sessionId}\n/exit 退出，/help 查看帮助。\n`);
  terminal.setPrompt("你 > ");
  waitForInput();
  try {
    await once(terminal, "close");
    await pending; // 终端关闭也要等取消和容器停止完成，不能直接结束进程。
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", disconnect);
    process.removeListener("SIGHUP", disconnect);
    clearTimeout(idleTimer);
    try {
      await conversation.close();
    } catch (error) {
      process.stderr.write(`环境关闭尚未确认：${String(error)}\n`);
      exitCode = 1;
    }
    terminal.close();
  }
  return exitCode;
}
