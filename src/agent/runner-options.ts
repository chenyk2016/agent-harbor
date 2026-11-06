/** 两种Runner共用同一套原生权限与环境配置，避免隔离规则随输入方式漂移。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { tools, type Task } from "../shared/types.js";
import { contentTools, projectToolContent } from "../shared/observation-content.js";
import { containerPaths } from "../shared/paths.js";
import { applicationExpertId, applicationSkillPluginPath } from "../shared/application-skills.js";


/** 只把可写依赖目录加入沙箱内命令；原生SDK进程的PATH/HOME仍指向受保护环境。 */
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const dependencyShellEnvironment: Record<string, string> = {
  PATH: `${containerPaths.dependencyEnv}/venv/bin:${containerPaths.dependencyEnv}/node-global/bin:/usr/local/bin:/usr/bin:/bin`,
  HOME: `${containerPaths.dependencyEnv}/home`,
  VIRTUAL_ENV: `${containerPaths.dependencyEnv}/venv`,
  UV_PROJECT_ENVIRONMENT: `${containerPaths.dependencyEnv}/venv`,
  UV_CACHE_DIR: `${containerPaths.dependencyCache}/uv`,
  UV_LINK_MODE: "copy",
  UV_PYTHON_DOWNLOADS: "never",
  PIP_CACHE_DIR: `${containerPaths.dependencyCache}/pip`,
  PIP_INDEX_URL: "https://pypi.org/simple",
  npm_config_cache: `${containerPaths.dependencyCache}/npm`,
  npm_config_prefix: `${containerPaths.dependencyEnv}/node-global`,
  npm_config_registry: "https://registry.npmjs.org",
};
const dependencyExports = Object.entries(dependencyShellEnvironment)
  .map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");

/** 把受信 Task 转成原生 SDK 配置：设置工具、权限、网关和恢复编号；普通专家 instructions 追加到 claude_code 系统提示词。 */
export function runnerOptions(
  task: Task,
  connection: {
    url: string;
    token: string;
    observeToolContent?: boolean;
    mcpServers?: Record<
      string,
      import("@anthropic-ai/claude-agent-sdk").McpServerConfig
    >;
  },
  emit: (type: string, payload: Record<string, unknown>, content?: { input: unknown; output: unknown }) => void,
  cancelled: () => boolean,
): Options {
  const observeContent = (name: string, input: unknown, output: unknown) => {
    if (!connection.observeToolContent || !contentTools.has(name)) return;
    try {
      return projectToolContent(input, output, [connection.token]);
    } catch {
      // Telemetry cannot prevent the SDK from finishing the tool call.
      return;
    }
  };
  // 普通会话沿用用户能力快照。平台应用插件由可信的应用专家快照决定。
  const plugins = task.expert?.workbuddy ? [] : [
    ...[...new Set(task.capabilities?.skills.map(skill => skill.namespace))]
      .map(namespace => `/opt/harbor-skills/${namespace}`),
    ...(task.expert?.expertId === applicationExpertId ? [applicationSkillPluginPath] : []),
  ];
  return {
    cwd: containerPaths.workspace,
    model: task.model,
    // 即使未选择个人技能，也保留Claude Code默认技能的调用入口。
    tools: [
      ...tools,
      "Skill",
      ...(task.expert?.workbuddy?.expertType === "team"
        ? [
            "Agent",
            "SendMessage",
            "ListAgents",
            "TaskCreate",
            "TaskUpdate",
            "TaskList",
            "TaskGet",
          ]
        : []),
    ],
    ...(plugins.length || (task.capabilities && !task.expert?.workbuddy)
      ? {
          plugins: plugins.map(path => ({
            type: "local" as const,
            path,
            skipMcpDiscovery: true,
          })),
          pluginDelivery: "initialize" as const,
        }
      : {}),
    // 排除用户/项目配置来源；管理员策略仍由原生运行时加载。
    // 平台仅注入用户启用的连接；本地进程必须经过可信MCP启动器。
    settingSources: task.expert?.workbuddy ? ["project"] : [],
    ...(task.expert?.workbuddy
      ? {
          projectConfigRoot: "/opt/harbor-skills/workbuddy-config",
          additionalDirectories: ["/opt/harbor-skills/workbuddy-source"],
        }
      : {}),
    strictMcpConfig: true,
    mcpServers: connection.mcpServers ?? {},
    permissionMode: "default",
    // 角色只在创建 query 时追加；后续消息继续同一个 query，不重复灌入提示词。
    ...(task.expert?.workbuddy
      ? {
          agent: task.expert.workbuddy.agentName,
          agents: Object.fromEntries(
            Object.entries(task.expert.workbuddy.agents).map(
              ([name, agent]) => [
                name,
                {
                  description: agent.description,
                  // SDK主Agent的skills不注入正文，兼容层补静态上下文；调用仍由原生Skill处理。
                  prompt:
                    agent.prompt +
                    "\n\n<expert-package-root>/opt/harbor-skills/workbuddy-source</expert-package-root>" +
                    (task.expert!.workbuddy!.expertType === "team"
                      ? "\n\n<workbuddy-tool-mapping>WorkBuddy AgentTool 对应当前原生 Agent 工具；团队消息使用 SendMessage。</workbuddy-tool-mapping>"
                      : "") +
                    (task.expert!.workbuddy!.preloadedSkills ?? [])
                      .filter((skill) => agent.skills.includes(skill.name))
                      .map(
                        (skill) =>
                          `\n\n<preloaded-skill name="${skill.name}">\nBase directory for this skill: ${skill.directory}\n\n${skill.body}\n</preloaded-skill>`,
                      )
                      .join(""),
                  skills: agent.skills,
                  // 保留专家显式指定的上限；未指定时不补隐式50轮。
                  ...((task.maxTurns ?? 0) > 0
                    ? { maxTurns: Math.min(agent.maxTurns ?? task.maxTurns!, task.maxTurns!) }
                    : agent.maxTurns === undefined ? {} : { maxTurns: agent.maxTurns }),
                },
              ],
            ),
          ),
        }
      : {}),
    // 内置 appExpert 没有 workbuddy，因此走 append 分支；保留原生提示词，再附加应用开发约定。
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(task.expert && !task.expert.workbuddy
        ? { append: task.expert.instructions }
        : {}),
    },
    // 恢复对话依赖明确的 SDK ID；实际文件另由持久化工作目录保留。
    resume: task.resumeId,
    persistSession: true,
    includePartialMessages: true,
    // 单次查询限额与取消，不能代替平台级账本或外层环境停止确认。
    // SDK的0可能表示零额度；不限时省略字段。
    ...((task.maxTurns ?? 0) > 0 ? { maxTurns: task.maxTurns } : {}),
    ...((task.maxBudgetUsd ?? 0) > 0 ? { maxBudgetUsd: task.maxBudgetUsd } : {}),
    // 主进程需要短期凭证；原生沙箱规则用于限制项目命令取得它。
    // 此配置意图的实际效果仍需文件、环境变量与 /proc 等目标探针验证。
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: containerPaths.state,
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: containerPaths.state,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(task.expert?.workbuddy?.expertType === "team"
        ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }
        : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // 显式覆盖继承环境，保留当前原生版本默认提供的技能。
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "0",
      ANTHROPIC_BASE_URL: connection.url,
      ANTHROPIC_AUTH_TOKEN: connection.token,
      // 受管多模型会话的辅助角色也使用所选模型，不能落回另一个供应商。
      ...(task.model?.startsWith("ah-") ? {
        ANTHROPIC_MODEL: task.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: task.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: task.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: task.model,
        CLAUDE_CODE_SUBAGENT_MODEL: task.model,
      } : {}),
    },
    stderr: (text) => process.stderr.write(text),
    // 每次模型工具调用先经过此 Hook；取消后拒绝新调用。
    // tool.started 记录调用进入检查阶段，后续仍可能被原生权限拒绝。
    hooks: {
      UserPromptSubmit: [{ hooks: [async (input) => { emit("turn.observed", { promptId: input.prompt_id }); return {}; }] }],
      SubagentStart: [{ hooks: [async (input) => { emit("agent.started", { agentId: input.agent_id, promptId: input.prompt_id, at: Date.now() }); return {}; }] }],
      SubagentStop: [{ hooks: [async (input) => { emit("agent.finished", { agentId: input.agent_id, promptId: input.prompt_id, at: Date.now() }); return {}; }] }],
      PostToolUse: [{ hooks: [async (input) => {
        if (input.hook_event_name === "PostToolUse") emit("tool.finished", { toolUseId: input.tool_use_id, name: input.tool_name, agentId: input.agent_id, promptId: input.prompt_id, durationMs: input.duration_ms, outcome: "completed", at: Date.now() }, observeContent(input.tool_name, input.tool_input, input.tool_response));
        return {};
      }] }],
      PostToolUseFailure: [{ hooks: [async (input) => {
        if (input.hook_event_name === "PostToolUseFailure") emit("tool.failed", { toolUseId: input.tool_use_id, name: input.tool_name, agentId: input.agent_id, promptId: input.prompt_id, durationMs: input.duration_ms, outcome: input.is_interrupt ? "interrupted" : "failed", at: Date.now() }, observeContent(input.tool_name, input.tool_input, "[tool failed]"));
        return {};
      }] }],
      PermissionDenied: [{ hooks: [async (input) => {
        const p = input as unknown as Record<string,unknown>;
        emit("tool.denied", { toolUseId: p.tool_use_id, name: p.tool_name, agentId: input.agent_id, promptId: input.prompt_id, outcome: "denied", at: Date.now() }); return {};
      }] }],
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (cancelled())
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "Run cancelled",
                  },
                };
              const toolInput =
                input.hook_event_name === "PreToolUse" &&
                input.tool_input &&
                typeof input.tool_input === "object"
                  ? (input.tool_input as Record<string, unknown>)
                  : {};
              const detail =
                typeof toolInput.file_path === "string"
                  ? toolInput.file_path
                  : typeof toolInput.pattern === "string"
                    ? toolInput.pattern
                    : typeof toolInput.path === "string"
                      ? toolInput.path
                      : input.hook_event_name === "PreToolUse" &&
                          input.tool_name === "Bash"
                        ? "运行命令"
                        : undefined;
              emit("tool.started", {
                toolUseId: input.hook_event_name === "PreToolUse" ? input.tool_use_id : undefined,
                promptId: input.prompt_id, agentId: input.agent_id, at: Date.now(),
                name:
                  input.hook_event_name === "PreToolUse"
                    ? input.tool_name
                    : "unknown",
                ...(detail ? { detail } : {}),
              });
              if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && typeof toolInput.command === "string") {
                if (toolInput.dangerouslyDisableSandbox === true)
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Managed sandbox is required" } };
                // 导出语句会触发原生命令解析器询问；只批准强制沙箱中的命令。
                // failIfUnavailable / allowUnsandboxedCommands=false仍由管理员策略强制执行。
                return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: {
                  ...toolInput,
                  dangerouslyDisableSandbox: false,
                  command: `export ${dependencyExports}; ${toolInput.command}`,
                } } };
              }
              return {}; // 继续原生权限流程，不替管理员规则作出允许决定。
            },
          ],
        },
      ],
    },
    // 原生Skill自行解析名字与加载内容；这里仅沿用通用工具权限和取消状态。
    // 只处理原生权限仍待决的请求：允许文件计算，拒绝待决 Bash。
    // 沙箱 Bash 可由原生策略自动批准；本回调并非所有工具的必经入口。
    canUseTool: async (name, input) =>
      !cancelled() &&
      (["Read", "Write", "Edit", "Glob", "Grep", "Skill"].includes(name) ||
        (task.expert?.workbuddy?.expertType === "team" &&
          [
            "Agent",
            "SendMessage",
            "ListAgents",
            "TaskCreate",
            "TaskUpdate",
            "TaskList",
            "TaskGet",
          ].includes(name)) ||
        Object.entries(connection.mcpServers ?? {}).some(([server,config]) =>
          "tools" in config && config.tools
            ? config.tools.some(tool=>tool.permission_policy!=="always_deny"&&name===`mcp__${server}__${tool.name}`)
            : name.startsWith(`mcp__${server}__`),
        ))
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Tool unavailable or run cancelled" },
  };
}
