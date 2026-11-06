/**
 * 实验Runner：一个进程、一份query、持续输入；不被正式CLI引用。
 * stdout是实验事件，stdin是逐行JSON控制消息，模型和任务由验证程序提供。
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { query, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { checkSandbox } from "../src/agent/sandbox.js";
import { containerPaths as paths } from "../src/shared/paths.js";
import { tools } from "../src/shared/types.js";
const sdkVersion: string = JSON.parse(await readFile(new URL("./package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk")), "utf8")).version;
const config = JSON.parse(await readFile(`${paths.run}/streaming-config.json`, "utf8"));
let seq = 0;
let active: {
    id: string;
    cancelled: boolean;
} | undefined;
let nativePid: number | undefined;
let closing = false;
let wake: (() => void) | undefined;
const pending: SDKUserMessage[] = [];
const accepted = new Set<string>();
function emit(type: string, payload: Record<string, unknown> = {}, turnId = active?.id ?? null) {
    process.stdout.write(JSON.stringify({ seq: ++seq, type, turnId, runnerPid: process.pid, nativePid, payload }) + "\n");
}
async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!closing) {
        if (pending.length)
            yield pending.shift()!;
        else
            await new Promise<void>(resolve => { wake = resolve; });
    }
}
await checkSandbox();
const options: Options = {
    cwd: paths.workspace,
    model: config.model,
    tools,
    settingSources: [], strictMcpConfig: true, mcpServers: {},
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code" },
    resume: config.resumeId,
    persistSession: true,
    includePartialMessages: true,
    maxTurns: config.maxTurns ?? 12,
    maxBudgetUsd: config.maxBudgetUsd ?? 1,
    env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: paths.state, LANG: "C.UTF-8",
        CLAUDE_CONFIG_DIR: paths.state,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_BASE_URL: config.url, ANTHROPIC_AUTH_TOKEN: config.token,
    },
    stderr: text => process.stderr.write(text),
    // 只记录实际原生进程PID，仍按SDK提供的参数原样启动，不修改原生程序。
    spawnClaudeCodeProcess: options => {
        const child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"],
        });
        nativePid = child.pid;
        emit("sdk.spawned");
        return child;
    },
    hooks: { PreToolUse: [{ hooks: [async (input) => {
                        emit("tool.started", input.hook_event_name === "PreToolUse" ? { name: input.tool_name } : {});
                        if (!active || active.cancelled)
                            return { hookSpecificOutput: {
                                    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "No active turn",
                                } };
                        return {};
                    }] }] },
    canUseTool: async (name, input) => active && !active.cancelled &&
        ["Read", "Write", "Edit", "Glob", "Grep"].includes(name)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Tool unavailable or turn cancelled" },
};
const session = query({ prompt: input(), options });
const terminal = createInterface({ input: process.stdin });
function close() {
    if (closing)
        return;
    closing = true;
    wake?.();
    session.close();
}
terminal.on("line", line => {
    void (async () => {
        const command = JSON.parse(line);
        if (command.type === "message") {
            if (closing || active || accepted.has(command.id)) {
                emit("input.rejected", { id: command.id, reason: closing ? "closing" : active ? "busy" : "duplicate" });
                return;
            }
            active = { id: command.id, cancelled: false };
            accepted.add(command.id);
            pending.push({ type: "user", uuid: command.id, session_id: "", parent_tool_use_id: null,
                message: { role: "user", content: command.text } });
            emit("input.accepted");
            wake?.();
        }
        else if (command.type === "interrupt") {
            if (!active || command.id !== active.id) {
                emit("interrupt.rejected", { id: command.id }, command.id);
                return;
            }
            active.cancelled = true;
            const receipt = await session.interrupt();
            emit("interrupt.receipt", { receipt: receipt ?? null }, command.id);
        }
        else if (command.type === "stopTask") {
            await session.stopTask(command.taskId);
            emit("task.stop.receipt", { taskId: command.taskId });
        }
        else if (command.type === "close")
            close();
        else if (command.type === "status")
            emit("runner.status", { active: active?.id ?? null });
        else
            throw new Error("Unknown input command");
    })().catch(error => { emit("control.failed", { error: String(error) }); close(); });
});
terminal.on("close", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
emit("runner.ready", { mode: "experimental-streaming", sdk: sdkVersion });
try {
    for await (const message of session) {
        if (message.type === "system" && message.subtype === "init")
            emit("sdk.session", { id: message.session_id });
        else if (message.type === "stream_event" && message.event.type === "content_block_delta" &&
            message.event.delta.type === "text_delta")
            emit("assistant.text.delta", { text: message.event.delta.text });
        else if (message.type === "result") {
            // 结果先归属并释放本轮，再接受下一条消息；禁止把SDK成功子类型直接当作未取消。
            emit("turn.result", { subtype: message.subtype, sdkSessionId: message.session_id,
                cancelled: active?.cancelled ?? false, costUsd: message.total_cost_usd, usage: message.usage });
            active = undefined;
        }
        else if (message.type === "system" &&
            ["task_started", "task_notification", "task_progress"].includes(message.subtype))
            emit("sdk.task", message as unknown as Record<string, unknown>);
    }
}
catch (error) {
    emit("stream.ended", { closing, error: String(error) });
    if (!closing)
        process.exitCode = 1;
}
finally {
    close();
    terminal.close();
    emit("runner.closed");
}
