/** 管理后台接口返回的记录形状；字段与现有 HTTP 响应保持一致。 */
export interface AdminUser {
  id: string;
  name: string;
  disabled: number;
  limits: string | null;
  createdAt: number;
  messageQuota?: unknown;
}

export interface WalletAdminUser {
  id: string;
  name: string;
  disabled: number;
  balance: number | null;
  reserved: number | null;
  plusUntil: number | null;
}

export interface WalletAdminData {
  enabled: boolean;
  reservationMode?: "estimated" | "full";
  settings: { signupMicro: number; plusMicro: number };
  users: WalletAdminUser[];
}

export interface Provider {
  id: string;
  name: string;
  apiBase: string;
  format: string;
  secretVersion: number | null;
  createdAt?: number;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AdminCostView {
  id?: string;
  source: "database" | "file";
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  timeoutSeconds: number;
  effectiveFrom?: number;
}

export interface AdminCostRow {
  id: string;
  providerId: string;
  upstreamModel: string;
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  cacheReadUsdPerToken: number;
  cacheWriteUsdPerToken: number;
  timeoutSeconds: number;
  effectiveFrom: number;
  createdBy: string;
  createdAt: number;
}

export interface AdminVersion {
  id: string;
  deploymentId: string;
  providerId: string;
  upstreamModel: string;
  routeName: string;
  params: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools: boolean;
  streaming: boolean;
  state: string;
  lastSyncedAt: number | null;
  createdBy: string;
  createdAt: number;
  cost: AdminCostView | null;
}

export interface AdminPriceVersion extends ModelPrice {
  id: string;
  deploymentId: string;
  effectiveFrom: number;
  createdBy: string;
  createdAt: number;
}

export interface AdminAudit {
  id: string;
  actor: string;
  action: string;
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  createdAt: number;
}

export interface AdminDeploymentSummary {
  id: string;
  name: string;
  description: string;
  currentVersionId: string;
  enabled: boolean;
  setupPending?: boolean;
  allowedUsers: string[];
  archivedAt: number | null;
  deletionState?: "deleting" | null;
  createdAt: number;
  updatedAt: number;
  providerName: string | null;
  currentVersion: AdminVersion | null;
  price: AdminPriceVersion | null;
  versionCount: number;
  liveSessions: number;
  state: string;
  cost: AdminCostView | null;
  costMissing: boolean;
}

export interface AdminDeploymentRecord {
  id: string;
  name: string;
  description: string;
  currentVersionId: string;
  enabled: boolean;
  setupPending?: boolean;
  allowedUsers: string[];
  archivedAt: number | null;
  deletionState?: "deleting" | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminDeploymentDetail {
  deployment: AdminDeploymentRecord;
  versions: AdminVersion[];
  prices: AdminPriceVersion[];
  audit: AdminAudit[];
}

export interface AdminLlmOverview {
  providers: Provider[];
  deployments: AdminDeploymentSummary[];
  costPolicyRequired: boolean;
  userRpmLimit: number | null;
}

export interface PendingRequest {
  id: string;
  userId: string;
  modelName: string;
  reserved: number;
  note: string;
  createdAt: number;
}

export interface PendingQueue {
  requests: PendingRequest[];
  total: number;
  nextOffset: number | null;
  sampledAt: number;
}
