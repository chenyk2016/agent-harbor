/**
 * 容器内的执行入口，每次任务启动一个新进程。
 * 读取 Controller 写入的任务与短期连接配置，检查沙箱，再调用 Claude SDK。
 * SDK 负责原生工具循环；本文件负责配置装配、取消信号和事件格式转换。
 */
import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { checkSandbox } from "./sandbox.js";
import { type Task } from "../shared/types.js";
import { containerPaths } from "../shared/paths.js";
import { runnerOptions } from "./runner-options.js";
import { prepareDependencyEnvironment } from "./dependency-env.js";

// 从实际安装包读取版本，避免升级候选镜像后，事件仍报告旧SDK版本。
const sdkVersion: string = JSON.parse(
  await readFile(
    new URL(
      "./package.json",
      import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
    ),
    "utf8",
  ),
).version;

// 1. 读取只读挂载的运行描述。项目工作文件位于另一个 /workspace 挂载。
// 常驻容器挂载全部 attempts；参数只由受信 Controller 传入。
const attemptId = process.argv[2];
if (attemptId && !/^[a-f0-9-]{36}$/.test(attemptId))
  throw new Error("Invalid attempt ID");
const runDirectory = attemptId
  ? `${containerPaths.run}/${attemptId}`
  : containerPaths.run;
const task: Task = JSON.parse(
  await readFile(`${runDirectory}/task.json`, "utf8"),
);
const connection = JSON.parse(
  await readFile(`${runDirectory}/connection.json`, "utf8"),
) as { url: string; token: string };
// 宿主的终止信号与 Runner 自身时限都转为 SDK abort。
// SDK 无法及时结束时，外层 Controller 仍会停止整个容器。
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
const timer = task.timeoutMs > 0
  ? setTimeout(() => abort.abort(), task.timeoutMs)
  : undefined;
let seq = 0;
/** stdout 每行一条产品事件；每个 attempt 独立编号，供 Controller 核对顺序。 */
function emit(type: string, payload: Record<string, unknown>) {
  process.stdout.write(
    JSON.stringify({
      type,
      seq: ++seq,
      sessionId: task.sessionId,
      attemptId: task.attemptId,
      generation: task.generation,
      payload,
    }) + "\n",
  );
}

// 2. 装配原生 SDK：固定工具与权限，沿用原生 loop 和会话保存能力。
const options = {
  ...runnerOptions(task, connection, emit, () => abort.signal.aborted),
  abortController: abort,
};
let sandboxReady = false;
try {
  // 3. 先检查实际启动条件；通过只表示基础能力可用，不代表完整隔离验收。
  await prepareDependencyEnvironment();
  await checkSandbox();
  sandboxReady = true;
  const session = query({ prompt: task.prompt, options });
  emit("runner.ready", { sdk: sdkVersion, profile: "docker-local-v2" });
  // 4. 消费 SDK 消息
  for await (const message of session) {
    if (message.type === "system" && message.subtype === "init")
      emit("sdk.session", { id: message.session_id });
    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
    ) {
      emit("assistant.text.delta", { text: message.event.delta.text });
    }
    if (message.type === "result") {
      // Agent 回合结束后，仍由宿主 Controller 处理后台进程与容器收尾。
      emit("agent.result", {
        subtype: message.subtype,
        costUsd: message.total_cost_usd,
        usage: message.usage,
      });
      if (message.subtype !== "success") process.exitCode = 1;
    }
  }
} catch (error) {
  // 原始异常可能含请求数据，只写内部 stderr；公开事件使用固定错误信息。
  process.stderr.write(String(error) + "\n");
  emit("runner.failed", {
    code: sandboxReady ? "SDK_FAILED" : "SANDBOX_UNAVAILABLE",
    message: !sandboxReady
      ? "Native sandbox unavailable"
      : abort.signal.aborted
        ? "Run cancelled or timed out"
        : "SDK execution failed",
  });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
