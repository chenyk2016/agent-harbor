/** 应用编辑器的数据形状与状态文案；画廊和编辑页共用，避免各写一套。 */
import type { Tone } from "../../shared/ui.js";
import { explainCode } from "../../state/errors.js";

/** 浏览器可见的应用摘要；关联开发会话及当前源码头，不包含运行配置或数据凭据。 */
export interface AppRecord {
  id: string;
  title: string;
  status: string;
  developmentSessionId: string | null;
  headRevisionId: string | null;
  stateVersion: number;
}
/** 浏览器可见的源码版本摘要，用于版本历史、数据声明及下载展示。 */
export interface Revision {
  id: string;
  number: number;
  summary: string;
  commit: string;
  createdAt: number;
  manifest: { tables: Record<string, unknown>; auth?: { mode: "public" | "required" } };
}
/** 某环境的访问入口摘要；appliedDeploymentId 表示实际已确认接通的实例，generation 用于防止过时切换。 */
export interface Endpoint {
  environment: "preview" | "production";
  generation: number;
  state: string;
  appliedDeploymentId: string | null;
  requiresLogin?: boolean;
  ownerOnly?: boolean;
  previewParentOrigin?: string;
  embeddedEmailLogin?: boolean;
  loginProviders?: ("google" | "email_password")[];
  publicReleaseNeedsConfirmation?: boolean;
  url: string;
}
/** 编辑页展示的异步操作摘要，区分整体状态、当前阶段和可解释错误。 */
export interface Operation {
  id: string;
  kind: string;
  phase: string;
  state: string;
  error?: string;
  payload?: { revisionId?: string };
  createdAt?: number;
  updatedAt?: number;
}
/** 已脱敏的运行部署摘要，用于关联入口、源码版本和容器观测状态。 */
export interface Deployment {
  id: string;
  revisionId?: string;
  environment: string;
  observedState: string;
}
/** 应用详情 API 的页面数据集合；源码、预览入口、操作和运行部署分别展示，避免混淆完成状态。 */
export interface Detail {
  analysisEnabled?: boolean;
  app: AppRecord;
  revisions: Revision[];
  endpoints: Endpoint[];
  operations: Operation[];
  deployments: Deployment[];
}

/** 把操作错误转换为用户能理解的说明，对费用尚未确认的情形补充账户核对指引。 */
export const operationError = (operation: Operation) =>
  operation.error === "WALLET_BUSY"
    ? "当时有一笔模型费用未确认，导致本次请求未能开始。当前余额和预占状态请查看账户明细。"
    : explainCode(operation.error ?? "APPLICATION_OPERATION_FAILED");

/** 判断操作是否仍占用资源；reconciling 虽未运行也保留占位，不能作为可重试成功状态。 */
export const busy = (operation: Operation) =>
  ["queued", "running", "cancelling", "reconciling"].includes(operation.state);

/** 后台操作阶段到界面文案的映射；阶段不等同于整体成功状态。 */
export const phases: Record<string, string> = {
  accepted: "等待处理",
  starting: "开始执行",
  preparing: "准备应用",
  generating: "生成应用",
  saving_version: "保存版本",
  building: "构建预览",
  preparing_data: "准备数据",
  starting_container: "启动应用",
  switching: "更新访问入口",
  finished: "已完成",
  prepared: "模板已准备",
  replacing_source: "恢复源码",
  submission_failed: "请求未能开始",
  APPLICATION_GENERATION_CANCELLED: "生成已中断",
  APPLICATION_GENERATION_NOT_COMPLETED: "生成未完成",
  APPLICATION_GENERATION_TIMEOUT: "生成超时",
  DESTRUCTIVE_SCHEMA_CHANGE: "数据结构变更不兼容",
  service_restarted: "服务重启，等待核对",
};

/** 异步操作状态文案，供操作记录与状态徽标共用。 */
export const states: Record<string, string> = {
  succeeded: "成功",
  cancelled: "已中断",
  queued: "排队中",
  running: "执行中",
  ready: "就绪",
  offline: "未启用",
  reconciling: "待核对",
  switching: "切换中",
  provisioning: "创建中",
  active: "可编辑",
  failed: "失败",
  stopped: "已停止",
};

export const operationKinds: Record<string, string> = {
  create: "创建",
  generate: "生成",
  snapshot: "保存版本",
  restore: "恢复",
  preview: "预览",
  publish: "发布",
  unpublish: "下线",
  rollback: "回滚",
  reconcile: "核对",
};

const toneColors: Record<Tone, { bg: string; color: string }> = {
  blue: { bg: "brand.50", color: "brand.600" },
  teal: { bg: "okTint", color: "ok" },
  red: { bg: "dangerTint", color: "dangerStrong" },
  amber: { bg: "warnTint", color: "warnStrong" },
  neutral: { bg: "sunken", color: "muted" },
};

/** 把应用生命周期状态映射为中文文案，未知值保留原文便于排查。 */
export function appStatus(status: string): {
  label: string;
  tone: Tone;
  pulse: boolean;
} {
  if (status === "active") return { label: "可编辑", tone: "teal", pulse: false };
  if (status === "deleting") return { label: "删除未完成", tone: "amber", pulse: false };
  if (["ready", "succeeded"].includes(status))
    return { label: states[status] ?? status, tone: "teal", pulse: false };
  if (["running", "queued", "provisioning", "switching"].includes(status))
    return { label: states[status] ?? status, tone: "blue", pulse: true };
  if (status === "reconciling")
    return { label: "待核对", tone: "amber", pulse: false };
  if (status === "failed") return { label: "失败", tone: "red", pulse: false };
  if (status === "stopped") return { label: "已停止", tone: "neutral", pulse: false };
  return { label: states[status] ?? status, tone: "neutral", pulse: false };
}

/** 根据应用状态选择徽标色调，帮助区分准备、可用、删除及异常状态。 */
export function appStatusColors(status: string) {
  return toneColors[appStatus(status).tone];
}

/** 将操作状态转换为展示色调，不改变后台操作状态。 */
export function operationTone(state: string): Tone {
  if (state === "succeeded") return "teal";
  if (state === "failed") return "red";
  if (state === "reconciling") return "amber";
  if (["queued", "running", "cancelling"].includes(state)) return "blue";
  return "neutral";
}

/** 为访问入口生成简短状态文案，区分已就绪、暂停和待核对等情况。 */
export function endpointLabel(state: string) {
  if (state === "ready") return "就绪";
  if (state === "provisioning") return "创建中";
  if (state === "switching") return "切换中";
  if (state === "offline") return "未启用";
  if (state === "reconciling") return "待核对";
  if (state === "stopped") return "已停止";
  return states[state] ?? state;
}
