/** 用户选择的是部署；每条消息固定其版本快照。凭据不进入快照。 */
export interface ModelSnapshot {
  deploymentId: string;
  deploymentName: string;
  versionId: string;
  providerName: string;
  upstreamModel: string;
  routeName: string;
}
export interface GatewayConnection {
  url: string;
  token: string;
  model: string;
  bindingId: string;
}
/** 目录项以部署为身份；版本只用于展示和锁定。 */
export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  versionId: string;
  routeName: string;
  description: string;
  enabled: boolean;
  state: string;
  tools: boolean;
  streaming: boolean;
}
export interface ModelCatalog {
  enabled: boolean;
  models: ModelOption[];
  defaultModelId: string | null;
  admin: boolean;
}

/** Public progress contains only check results and a stable error code. */
export interface ModelProbeStatus {
  id: string;
  deploymentId: string;
  versionId?: string;
  status: "running" | "passed" | "failed";
  synced: boolean;
  tool: boolean;
  stream: boolean;
  durationMs?: number;
  error?: string;
}
