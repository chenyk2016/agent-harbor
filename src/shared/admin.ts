/** 管理页面只接收白名单元数据，不返回聊天正文、文件或凭据。金额Micro为人民币微元。 */
export interface AdminPageResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  sampledAt: number;
}
export interface RequestRow {
  id: string;
  userId: string;
  userName: string;
  sessionId: string;
  messageId: string | null;
  deploymentId: string;
  versionId: string;
  modelName: string;
  state: string;
  reserved: number;
  actual: number | null;
  charged: number | null;
  waived: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  createdAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  failureCode: string | null;
  gatewayCallId: string | null;
}
export interface LedgerRow {
  id: string;
  userId: string;
  userName: string;
  amount: number;
  balanceAfter: number;
  kind: string;
  createdAt: number;
  note: string;
}
export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  before: unknown;
  requested: unknown;
  result: unknown;
  outcome: string;
  createdAt: number;
  finishedAt: number | null;
  source: string;
}
export interface Incident {
  id: string;
  kind: string;
  target: string;
  title: string;
  active: boolean;
  status: string;
  assignee: string | null;
  note: string;
  firstSeenAt: number;
  lastSeenAt: number;
  recoveredAt: number | null;
  updatedAt: number;
}
export interface OperationsStatus {
  sampledAt: number;
  checks: Array<{
    name: string;
    state: string;
    detail: string;
    checkedAt: number;
  }>;
  process: { uptimeSeconds: number; rssBytes: number };
  sync: { enabled: boolean; lastSuccessAt: number | null };
  incidents: Incident[];
  recent: {
    requests: number;
    unknown: number;
    httpErrors: number;
    measured: number;
    p95Ms: number | null;
  };
}
export interface RequestEvidence {
  tracing?: {
    state: string; issues: string[]; status: string; url: string | null; traceId?: string; taskUrl?: string | null;
    contentMode?: "metadata" | "redacted";
  };
  request: RequestRow & {
    price: Record<string, number>;
    priceVersionId: string;
    note: string;
  };
  gateway: Array<{
    id: string;
    callId: string;
    requestId: string | null;
    model: string;
    status: string;
    spendUsd: number | null;
    pricingKnown: boolean;
    usage: unknown;
    costBreakdown: unknown;
    startedAt: number;
  }>;
  turns: Array<{
    id: string;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    cancelRequested: number;
  }>;
  events: Array<{
    eventId: number;
    messageId: string | null;
    type: string;
    payload: Record<string, unknown>;
  }>;
  partial: boolean;
  association: string;
}
export interface ResourceRow {
  id: string;
  ownerId: string;
  userName: string;
  environment: string;
  updatedAt: number;
  lastMessageId: string | null;
  status: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequested: number | null;
  stopReason: string | null;
}
export interface UsageReport {
  from: number;
  to: number;
  sampledAt: number;
  rmb: {
    requests: number;
    settled: number;
    unknown: number;
    chargedMicro: number;
    reservedMicro: number;
    waivedMicro: number;
    unknownActual: number;
    unknownUsage: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    httpMeasured: number;
    httpSuccess: number;
    measured: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  usd: {
    observedRows: number;
    knownRows: number;
    unknownRows: number;
    knownSpendUsd: number | null;
  };
  daily: Array<{
    day: string;
    requests: number;
    chargedMicro: number;
    unknown: number;
  }>;
  models: Array<{
    modelName: string;
    versionId: string;
    requests: number;
    chargedMicro: number;
    unknown: number;
    tokens: number;
    p95Ms: number | null;
  }>;
  users: Array<{
    userId: string;
    userName: string;
    requests: number;
    chargedMicro: number;
    unknown: number;
    tokens: number;
  }>;
}
export interface ChangePreview {
  token: string;
  before: unknown;
  requested: unknown;
  affectedSessions: number;
  activeMessages: number;
  effect: string;
}
