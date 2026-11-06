/** HTTP与客户端共用的记录；执行层Session仍只记录容器事实。 */
/** 产品消息的执行状态；reconciling 仍占用会话，避免未核对就接收新的写入。 */
export type MessageStatus = "accepted" | "running" | "finalizing" | "succeeded" | "failed" | "cancelled" | "interrupted" | "reconciling";
/** 开发环境状态，与消息状态分离：一轮成功后环境仍可能 ready。 */
export type Environment = "closed" | "starting" | "ready" | "stopping" | "reconciling";
/** 产品会话记录，保存用户归属、当前环境及创建时固定的模型、专家与技能配置。 */
export interface ServiceSession {
  deletionState?: "running" | "failed";
  modelSnapshot?: import("../shared/llm.js").ModelSnapshot | null;
  /** createPrepared() 保存的专家快照，执行时传给 Controller；应用创建使用内置 appExpert。 */
  expertSnapshot?: import("../shared/experts.js").ExpertSnapshot | null;
  id: string; ownerId: string; title: string; createdAt: number; updatedAt: number;
  capabilitySnapshot?: import("../shared/skills.js").CapabilitySnapshot | null;
  analysisAppId?: string | null;
  analysisEnvironment?: "preview" | "production" | null;
  creationRequestId?: string | null; creationRequestHash?: string | null;
  environment: Environment; lastMessageId: string | null; lastEventId: number;
}
/** Only server-created test sessions use a non-UUID creation request identifier. */
export const modelProbePrefix = "model-probe:";
export const isModelProbe = (session: ServiceSession) =>
  session.creationRequestId?.startsWith(modelProbePrefix) === true;

/** 一次已接收的用户需求及执行结果；clientMessageId 用于重试去重，模型快照归属于该消息。 */
export interface Message {
  id: string; sessionId: string; clientMessageId: string; text: string;
  requestedDeploymentId?: string | null;
  modelSnapshot?: import("../shared/llm.js").ModelSnapshot | null;
  activatedModelSnapshot?: import("../shared/llm.js").ModelSnapshot | null;
  status: MessageStatus; cancelRequested: number; createdEventId: number;
  startedAt: number | null; finishedAt: number | null; result: string | null;
}
/** 浏览器可续读的产品事件；eventId 在会话内递增，messageId 为空表示环境等会话级事件。 */
export interface ServiceEvent {
  sessionId: string; eventId: number; messageId: string | null; type: string;
  payload: Record<string, unknown>;
}
/** 仍禁止下一条并发写入的消息状态；包括执行完成事实尚待核对的状态。 */
export const activeStatuses: MessageStatus[] = ["accepted", "running", "finalizing", "reconciling"];
/** 可对外转换为 HTTP 状态与稳定错误码的业务异常，不携带私有运行诊断。 */
export class ServiceError extends Error {
  /** 固定 HTTP 状态与产品错误码，由接口统一格式化。 */
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** 立即抛出带产品错误码的业务异常；never 让调用方的类型分支在此终止。 */
export function fail(status: number, code: string): never { throw new ServiceError(status, code); }
