/**
 * Controller 与容器内 Runner 共用的数据约定。
 * Task 描述本次要执行的工作；Session 保存可跨运行保留的会话状态；
 * Event 把执行进度从 Runner 传回 Controller。
 */
export const tools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
// finalizing 表示正在收尾；reconciling 表示停止、持久化或清理还有待核实。
// reconciling 时容器可能已经停止，需结合 stopped 和实际 Docker 状态判断。
export type Status =
  | "starting"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "reconciling";

/** 由受信 Controller 生成，写入 task.json 后交给本次 Runner。 */
export interface Task {
  hasLocalMcp?: boolean;
  mcpProbe?: boolean;
  /** 服务端从已认证用户生成；CLI缺省按会话隔离缓存，不接收网页透传。 */
  dependencyCacheKey?: string;
  networkDomains?: string[];
  /** 会话创建时固定的专家，供 Runner 构造系统提示词或 WorkBuddy Agent 配置。 */
  expert?: import("./experts.js").ExpertSnapshot;
  capabilities?: import("./skills.js").CapabilitySnapshot;
  sessionId: string; // 产品会话 ID，同一会话的多次运行保持不变。
  attemptId: string; // 本次实际启动的 ID，每次运行重新生成。
  generation: number; // 会话内递增的执行代次，用于识别过时事件。
  prompt: string;
  model: string;
  resumeId?: string; // 已保存的 Claude 原生会话 ID；首次运行不传。
  maxTurns?: number; // 缺省 = 不设平台轮数上限。
  maxBudgetUsd?: number; // 缺省 = 不设SDK估算上限；不等同于租户硬账本。
  timeoutMs: number; // 本次运行总时限，单位毫秒；0 = 不设总时限。
}
/** 本次执行停止的原因；用于区分超时、用户中断和主动关闭环境。 */
export type StopReason = "task_timeout" | "user_cancelled" | "environment_closed";
/** 宿主保存的最近运行状态和原生会话恢复信息；stopped 表示环境停止事实，与消息成功或失败分开记录。 */
export interface Session {
  stopReason?: StopReason;
  /** 上次执行的专家内容指纹，恢复前必须与传入快照一致。 */
  expertDigest?: string;
  sessionId: string;
  generation: number;
  capabilityDigest?: string;
  sdkSessionId?: string; // 来自 SDK init 事件，不可用产品 sessionId 替代。
  attemptId?: string;
  status?: Status;
  containerId?: string;
  runtimeBackend?: string; // Old records without a backend were created by Docker.
  imageId?: string; // 实际镜像内容 ID，用于检查后续恢复的版本兼容性。
  runnerId?: string; // 常驻Runner启动attempt，连接文件和全流日志放在该目录。
  environment?: "ready" | "closed" | "unknown"; // V2区分本轮结束与整个环境关闭。
  stopped?: boolean; // Controller 是否已确认本次环境停止，与任务成功与否分开。
  result?: { subtype: string; costUsd: number }; // costUsd为原生累计估算，不能逐轮相加。
  error?: string;
}
/** JSONL事件：run在本轮编号；chat沿用整个Runner序号，每轮是其中子序列。 */
export interface Event {
  seq: number;
  type: string;
  sessionId: string;
  attemptId: string;
  generation: number;
  payload: Record<string, unknown>;
}
/** 受信开发配置，由 Controller 选择，不接收浏览器透传的 Docker 参数。 */
export interface Profile {
  image: string;
  gatewayUrl: string;
  model: string;
  timeoutMs: number;
  maxTurns: number;
  maxBudgetUsd: number;
  interruptTimeoutMs?: number; // 原生中断未在此时间内结束，升级为整容器停止。
  idleTimeoutMs?: number; // chat等待输入的时限；缺省15分钟。
}
// 本地开发初值；真实网关、模型及资源范围需按目标环境另行配置和验收。
export const defaultProfile: Profile = {
  image: "agent-harbor:0.6.3",
  // 容器通过宿主别名访问本机 127.0.0.1:8080 网关。
  gatewayUrl: "http://host.docker.internal:8080",
  model: "claude-sonnet-4-6",
  timeoutMs: 0,
  maxTurns: 0,
  maxBudgetUsd: 0,
};
