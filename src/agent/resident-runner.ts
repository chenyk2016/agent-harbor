/**
 * 容器内常驻入口：一次query、一个原生进程，持续等待宿主消息。
 * 两条流程同时工作：stdin把用户消息交给SDK，SDK输出转换成stdout事件。
 * 正常result只结束本轮；取消/退出最终由宿主确认整个容器停止。
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { checkSandbox } from "./sandbox.js";
import { containerPaths } from "../shared/paths.js";
import { runnerOptions } from "./runner-options.js";
import { ObservationOrigins } from "./observation.js";
import { prepareDependencyEnvironment } from "./dependency-env.js";
import type { Task } from "../shared/types.js";
import type { RunnerCommand, RunnerEvent } from "../shared/runner-protocol.js";

// 启动配置只读一次。runnerId指向首次启动的attempt，不随每条消息变化。
const runnerId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(runnerId ?? ""))
  throw new Error("Invalid Runner ID");
const startupDirectory = `${containerPaths.run}/${runnerId}`;
const initialTask: Task = JSON.parse(
  await readFile(`${startupDirectory}/task.json`, "utf8"),
);
const connection = JSON.parse(
  await readFile(`${startupDirectory}/connection.json`, "utf8"),
);
const sdkVersion = JSON.parse(
  await readFile(
    new URL(
      "./package.json",
      import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
    ),
    "utf8",
  ),
).version;

const observationOrigins = new ObservationOrigins();
const acceptedOrigins = new Map<string,Task>();
let sequence = 0;
let nativePid: number | undefined;
let isClosing = false;
let activeTask: Task | undefined;
let turnCancelled = false;
let interrupting: Promise<void> | undefined;
let latestCostUsd = 0;
let lastGeneration = initialTask.generation - 1;
let sdkSession: ReturnType<typeof query> | undefined;

// 输入队列连接stdin与SDK；wakeInput用于唤醒正在等消息的异步生成器。
const inputQueue: SDKUserMessage[] = [];
let wakeInput: (() => void) | undefined;
// 后台任务可以晚于创建轮次结束，因此必须独立保留task_id到原轮次的映射。
const backgroundTaskOrigins = new Map<string, Task>();

/** 把当前执行代次、消息归属及递增序号封装为标准输出事件，交给宿主按顺序消费。 */
function emit(
  type: string,
  payload: Record<string, unknown>,
  origin: Task | null = activeTask ?? null,
  toolContent?: RunnerEvent["toolContent"],
) {
  if (type.startsWith("tool.") || type.startsWith("agent.") && type !== "agent.result" || type === "turn.observed")
    origin = observationOrigins.observe(type, payload, activeTask ?? null);
  const event: RunnerEvent = {
    sessionId: initialTask.sessionId,
    runnerId,
    seq: ++sequence,
    type,
    attemptId: origin?.attemptId,
    generation: origin?.generation,
    payload,
    ...(origin && toolContent ? { toolContent } : {}),
  };
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** yield交出一条消息后还会继续等待；没有输入时暂停，不轮询、不空转。 */
async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  while (!isClosing) {
    if (inputQueue.length) {
      yield inputQueue.shift()!;
    } else {
      await new Promise<void>((resolve) => {
        wakeInput = resolve;
      });
    }
  }
}

/** 校验后续消息属于同一会话和固定运行配置，再把用户需求放入 SDK 输入队列。 */
function acceptUserMessage(task: Task) {
  if (
    isClosing ||
    activeTask ||
    task.sessionId !== initialTask.sessionId ||
    task.capabilities?.digest !== initialTask.capabilities?.digest ||
    task.expert?.digest !== initialTask.expert?.digest ||
    task.generation <= lastGeneration ||
    !/^[a-f0-9-]{36}$/.test(task.attemptId)
  ) {
    emit("input.rejected", { message: "Busy, duplicate or invalid input" });
    return;
  }

  lastGeneration = task.generation;
  activeTask = task;
  acceptedOrigins.set(task.attemptId, task);
  if (acceptedOrigins.size > 4096) acceptedOrigins.delete(acceptedOrigins.keys().next().value!);
  turnCancelled = false;
  inputQueue.push({
    type: "user",
    uuid: task.attemptId as SDKUserMessage["uuid"],
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: task.prompt },
  });
  emit("input.accepted", {});
  wakeInput?.();
}

/** JSON解析也放在async函数里，确保错误沿统一的控制失败路径处理。 */
async function handleInputLine(line: string) {
  const command: RunnerCommand = JSON.parse(line);
  if (command.type === "message") {
    acceptUserMessage(command.task);
  } else if (command.type === "interrupt") {
    if (!activeTask || command.attemptId !== activeTask.attemptId) return;
    const origin = activeTask;
    turnCancelled = true;
    // 尚未交给SDK的输入直接移除；否则中断可能先于原生接收，留下待执行消息。
    const queued = inputQueue.findIndex(
      (message) => message.uuid === origin.attemptId,
    );
    if (queued >= 0) {
      inputQueue.splice(queued, 1);
      emit(
        "agent.result",
        { subtype: "cancelled", cancelled: true, costUsd: latestCostUsd },
        origin,
      );
      activeTask = undefined;
      return;
    }
    // result要等这次中断控制请求结束再发出，避免迟到中断影响下一轮。
    interrupting ??= (async () => {
      const receipt = await sdkSession!.interrupt();
      emit("interrupt.receipt", { receipt: receipt ?? null }, origin);
      if (receipt?.still_queued?.length)
        throw new Error("Interrupted input remains queued");
    })();
    await interrupting;
  } else if (command.type === "close") {
    close();
  } else {
    throw new Error("Unknown Runner command");
  }
}

/** 只转换事件，不接管SDK的模型推理和工具循环。 */
async function handleSdkMessage(message: SDKMessage) {
  if (message.type === "assistant" && message.request_id && /^[a-f0-9-]{36}$/.test(message.request_id)) {
    const origin = message.parent_tool_use_id ? observationOrigins.tool(message.parent_tool_use_id)
      : message.user_message_uuid ? acceptedOrigins.get(message.user_message_uuid) ?? null : activeTask ?? null;
    emit("model.request.link", { requestId: message.request_id }, origin);
  }
  if (message.type === "system" && message.subtype === "init") {
    emit("mcp.status", {
      servers: message.mcp_servers.map((server) => ({
        name: server.name,
        status: server.status,
      })),
    });
    emit("sdk.session", {
      id: message.session_id,
      runnerPid: process.pid,
      nativePid,
    });
  } else if (
    message.type === "stream_event" &&
    message.event.type === "content_block_delta" &&
    message.event.delta.type === "text_delta"
  ) {
    emit("assistant.text.delta", { text: message.event.delta.text });
  } else if (message.type === "result") {
    await interrupting;
    interrupting = undefined;
    latestCostUsd = message.total_cost_usd;
    emit("agent.result", {
      subtype: message.subtype,
      cancelled: turnCancelled,
      costUsd: message.total_cost_usd,
      usage: message.usage,
    });
    // 只释放当前轮次，不关闭query；下一条用户消息仍使用同一进程。
    activeTask = undefined;
  } else if (
    message.type === "system" &&
    ["task_started", "task_notification", "task_progress"].includes(
      message.subtype,
    )
  ) {
    const payload = message as unknown as Record<string, unknown>;
    const taskId = String(payload.task_id);
    if (message.subtype === "task_started" && activeTask) {
      backgroundTaskOrigins.set(taskId, activeTask);
    }
    // 显式传null表示未知归属，不能用emit默认值误挂到新的前台轮次。
    const origin = backgroundTaskOrigins.get(taskId);
    emit("sdk.task", payload, origin ?? null);
    if (message.subtype === "task_notification")
      backgroundTaskOrigins.delete(taskId);
  }
}

/** 同时结束输入等待与SDK会话。允许EOF、信号和finally重复调用。 */
function close() {
  if (isClosing) return;
  isClosing = true;
  turnCancelled = true;
  wakeInput?.();
  sdkSession?.close();
}

const terminal = createInterface({ input: process.stdin });
terminal.on("close", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
let sandboxReady = false;
try {
  await prepareDependencyEnvironment();
  await checkSandbox();
  sandboxReady = true;

  // 启动配置和预算在此固定，后续消息不能改变权限、模型或重置query预算。
  const options = runnerOptions(
    initialTask,
    connection,
    (type, payload, toolContent) => emit(type, payload, activeTask ?? null, toolContent),
    () => !activeTask || turnCancelled,
  );
  options.spawnClaudeCodeProcess = (spawnOptions) => {
    // 参数原样交给原生进程，只记录PID以确认多轮之间没有重新启动。
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    nativePid = child.pid;
    emit("sdk.spawned", { nativePid, runnerPid: process.pid });
    return child;
  };
  sdkSession = query({ prompt: userMessages(), options });

  terminal.on("line", (line) => {
    void handleInputLine(line).catch((error) => {
      process.stderr.write(String(error) + "\n");
      emit("runner.failed", {
        code: "PROTOCOL_FAILED",
        message: "Runner control failed",
      });
      close();
    });
  });
  // EOF可能在沙箱初始化期间就到达；此时刚创建的SDK会话也要关闭。
  if (isClosing) sdkSession.close();
  emit("runner.ready", {
    sdk: sdkVersion,
    runnerPid: process.pid,
    profile: "docker-resident-v3",
  });
  for await (const message of sdkSession) {
    await handleSdkMessage(message);
  }
} catch (error) {
  process.stderr.write(String(error) + "\n");
  if (!isClosing) {
    emit("runner.failed", {
      code: sandboxReady ? "SDK_FAILED" : "SANDBOX_UNAVAILABLE",
      message: sandboxReady
        ? "SDK execution failed"
        : "Native sandbox unavailable",
    });
    process.exitCode = 1;
  }
} finally {
  close();
  terminal.close();
}
