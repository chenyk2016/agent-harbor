/**
 * 阶段A探针：在会话容器内启动一次真实 SDK 查询，记录原生装载与调用证据。
 * 只用于验证，不进入 npm test；参数全部由环境变量给出，避免把探针做成第二套配置面。
 */
const SDK = "/platform/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

const scenario = process.env.PROBE_SCENARIO ?? "init";
const skillNames = (process.env.PROBE_SKILLS ?? "").split(",").filter(Boolean);
const pluginPaths = (process.env.PROBE_PLUGINS ?? "").split(",").filter(Boolean);
const abortAfterMs = Number(process.env.PROBE_ABORT_MS ?? 0);

const emit = (type, data = {}) => console.log("PROBE " + JSON.stringify({ type, ...data }));

const { query } = await import(SDK);

const controller = new AbortController();
const toolCalls = [];

const options = {
  cwd: "/workspace",
  model: process.env.PROBE_MODEL,
  tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  permissionMode: "default",
  systemPrompt: { type: "preset", preset: "claude_code" },
  persistSession: false,
  includePartialMessages: false,
  maxTurns: 4,
  maxBudgetUsd: 1,
  plugins: pluginPaths.map(path => ({ type: "local", path, skipMcpDiscovery: true })),
  pluginDelivery: "initialize",
  skills: skillNames,
  abortController: controller,
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/platform/state",
    LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: "/platform/state",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(process.env.PROBE_DISABLE_BUNDLED ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" } : {}),
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  },
  stderr: text => {
    for (const line of String(text).split("\n")) if (line.trim()) emit("stderr", { line: line.slice(0, 400) });
  },
  canUseTool: async (name, input) => {
    emit("permission", { name });
    return ["Read", "Write", "Edit", "Glob", "Grep", "Skill"].includes(name)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Tool unavailable or run cancelled" };
  },
  hooks: {
    PreToolUse: [{
      hooks: [async input => {
        emit("pretool", { name: input.tool_name, input: input.tool_input });
        return {};
      }],
    }],
  },
};

// 不发送正文的输入流：用于只取初始化信息，不消耗模型调用。
async function* idle() { await new Promise(() => {}); }

function messages(text) {
  return (async function* () {
    yield {
      type: "user",
      uuid: crypto.randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    };
    await new Promise(() => {});
  })();
}

const prompt = ["init", "dynamic", "empty", "none-name", "no-plugin", "no-bundled"].includes(scenario)
  ? idle()
  : messages(process.env.PROBE_PROMPT ?? "");

const q = query({ prompt, options });

if (["init", "dynamic", "empty", "none-name", "no-plugin", "no-bundled"].includes(scenario)) {
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("init timeout after 25s")), 25_000)),
    ]);
    emit("init", {
      pluginsApplied: init.plugins_applied ?? null,
      commands: init.commands.map(command => command.name).sort(),
      claudeCodeVersion: init.claude_code_version ?? null,
    });
  } catch (error) {
    emit("error", { message: String(error).slice(0, 300) });
  }
  process.exit(0);
}

let timer;
if (abortAfterMs > 0) timer = setTimeout(() => { emit("abort", { afterMs: abortAfterMs }); controller.abort(); }, abortAfterMs);

try {
  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      emit("system-init", {
        skills: message.skills ?? [],
        plugins: (message.plugins ?? []).map(plugin => plugin.name),
        slashCommands: message.slash_commands ?? [],
        tools: message.tools ?? [],
      });
    }
    if (message.type === "assistant") {
      for (const block of message.message.content ?? []) {
        if (block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input });
          emit("tool_use", { name: block.name, input: block.input });
        }
        if (block.type === "text") emit("text", { text: block.text.slice(0, 500) });
      }
    }
    if (message.type === "result") {
      emit("result", {
        subtype: message.subtype,
        isError: message.is_error ?? null,
        result: typeof message.result === "string" ? message.result.slice(0, 800) : null,
      });
      break; // 输入流是常驻的，结果到达后立即结束，避免容器空转。
    }
  }
} catch (error) {
  emit("error", { message: String(error).slice(0, 500) });
} finally {
  if (timer) clearTimeout(timer);
  if (scenario === "slow") {
    // 取消后立刻看容器内还有没有残留进程，不依赖宿主侧的事后推断。
    // 镜像没有 procps，直接读 /proc 的 cmdline。
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const found = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
          if (/slow\.sh|sleep 45/.test(cmd)) found.push({ pid: entry, cmd });
        } catch {}
      }
      emit("leftover", { processes: found });
    } catch (error) {
      emit("leftover", { error: String(error).slice(0, 200) });
    }
  }
  emit("done", { toolCalls: toolCalls.length });
  process.exit(0);
}
