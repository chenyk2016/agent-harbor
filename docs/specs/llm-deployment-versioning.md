# 模型网关：命名部署 → 版本化模型

- 日期：2026-10-30
- 状态：已实现（2026-10-30）
- 依据：用户 2026-10-30 要求「按最正确实现重构，不兼容旧结构，该迁移就迁移」
- 影响范围：数据库迁移、`src/service/llm/**`、`src/service/wallet/**`、会话/消息模型快照、管理后台与模型选择器、LLM 相关测试与文档

## 一、背景与目标

当前 `llm_models` 一行同时承担「用户选择的模型」「上游部署」「价格」「能力声明」「启用状态」，改上游只能新增一行，导致：

- 管理员无法原地轮换供应商密钥；
- 展示名、说明等无风险字段也被冻结；
- 历史消息、钱包请求、网关用量只能引用一个含义会漂移的 id；
- 没有版本历史、没有指针、没有回滚和审计。

本次把模型配置拆成三层：

```text
可变命名部署（用户选择的对象、当前指针）
        │ 指向
        ▼
不可变模型版本（上游、协议、能力、LiteLLM route）
        │ 被
        ▼
请求级快照（消息、钱包请求、网关用量）
```

密钥与价格各自独立版本化，不再挂在模型行上。

## 二、术语与不变量

| 术语 | 说明 |
| --- | --- |
| deployment 命名部署 | 用户和管理员看到、可选择的对象；`id` 创建后不变，`name/description/enabled/allowedUsers` 可改 |
| version 模型版本 | 不可变：provider、上游模型、route、能力声明；内容变更 = 新版本 |
| route | LiteLLM 的 `model_name`，每个版本唯一，如 `ah-mv-<versionId>` |
| price 售价版本 | 不可变的人民币四项单价；请求发生时的价格快照就是它的 id |
| secret 供应商密钥版本 | 可轮换；轮换不改变任何版本的路由身份 |

不变量：

1. 会话绑定部署（稳定别名）；每条消息接收时解析部署当前版本并固定，执行期间不再变化。
2. 切换模型只更新同一把 Key 的 alias，不重建容器、不换 Token。
3. 任何远端写操作先落库、再写 LiteLLM、再读回确认；失败保持 pending/未知，不静默重放。
4. 历史记录（消息、钱包、用量）记录 deployment + version；版本不可变，历史可还原。
5. 有未撤销绑定的部署不能归档；版本永不删除。

## 三、数据模型

新增表（PostgreSQL）：

```sql
CREATE TABLE llm_providers (
  id text PRIMARY KEY,
  name text NOT NULL,
  format text NOT NULL,              -- anthropic | anthropic_compatible | openai_chat | openai_responses
  "apiBase" text NOT NULL,
  "createdAt" bigint NOT NULL
);

CREATE TABLE llm_provider_secrets (
  id text PRIMARY KEY,
  "providerId" text NOT NULL REFERENCES llm_providers(id),
  version integer NOT NULL,
  secret text NOT NULL,              -- AES-GCM 密文
  "createdAt" bigint NOT NULL,
  "retiredAt" bigint,
  UNIQUE ("providerId", version)
);

CREATE TABLE llm_model_versions (
  id text PRIMARY KEY,
  "deploymentId" text NOT NULL,
  "providerId" text NOT NULL REFERENCES llm_providers(id),
  "upstreamModel" text NOT NULL,
  "routeName" text NOT NULL UNIQUE,
  params jsonb NOT NULL DEFAULT '{}',
  tools boolean NOT NULL,
  streaming boolean NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}',
  digest text NOT NULL,
  state text NOT NULL,               -- pending | ready | failed
  "lastSyncedAt" bigint,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);

CREATE TABLE llm_deployments (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  "currentVersionId" text NOT NULL REFERENCES llm_model_versions(id),
  enabled boolean NOT NULL DEFAULT true,
  "allowedUsers" jsonb NOT NULL DEFAULT '[]',
  "archivedAt" bigint,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL
);

CREATE TABLE llm_deployment_prices (
  id text PRIMARY KEY,
  "deploymentId" text NOT NULL REFERENCES llm_deployments(id),
  input bigint NOT NULL,
  output bigint NOT NULL,
  "cacheRead" bigint NOT NULL,
  "cacheWrite" bigint NOT NULL,
  "effectiveFrom" bigint NOT NULL,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);

CREATE TABLE llm_config_audit (
  id text PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  "createdAt" bigint NOT NULL
);
```

修改表：

```sql
-- 绑定固定到 deployment + version；不再引用旧 modelId。
ALTER TABLE llm_bindings
  ADD COLUMN "deploymentId" text NOT NULL REFERENCES llm_deployments(id),
  ADD COLUMN "versionId" text NOT NULL REFERENCES llm_model_versions(id),
  DROP COLUMN "modelId";

-- 个人默认模型改指部署。
CREATE TABLE llm_preferences (
  "ownerId" text PRIMARY KEY,
  "deploymentId" text REFERENCES llm_deployments(id)
);
```

请求级归因：

```sql
ALTER TABLE wallet_requests
  ADD COLUMN "deploymentId" text NOT NULL,
  ADD COLUMN "versionId" text NOT NULL,
  ADD COLUMN "priceVersionId" text NOT NULL,
  DROP COLUMN "modelId";

ALTER TABLE gateway_usage_events
  ADD COLUMN "deploymentId" text,
  ADD COLUMN "versionId" text;
```

删除旧表 `llm_models`；`llm_providers.secret` 迁移后删除。

## 四、运行时契约

共享类型改为：

```ts
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
  model: "ah-session-model";
  bindingId: string;
  deploymentId: string;
  versionId: string;
}
```

会话创建、消息提交、应用开发入口的请求字段 `modelId` 统一改为 `deploymentId`（UUID 校验不变）；`requestedModelId` 列改为 `requestedDeploymentId`。

### 1. 会话选择与消息执行

1. `modelSelection(userId, deploymentId?)` 返回当前快照：
   - 未指定时取个人默认部署 → 服务配置默认部署 → 第一个可用部署；
   - 校验部署未归档、已启用、用户可见、当前版本 `ready`、能力满足 Agent 要求（`tools && streaming`）；
   - 钱包启用时额外要求存在当前售价版本。
2. 消息接收时把快照写入 `messages.modelSnapshot`；`requestedDeploymentId` 保留用户原始请求。
3. 消息接收时解析部署当前版本并写入消息快照；执行时 `modelConnection(session)` 只认该快照，不再读指针。
4. 网关连接就绪后写 `activatedModelSnapshot` 与 `model.activated` 事件，并更新会话最近模型。

### 2. 切换模型

- 切换只改绑定：`llm_bindings.deploymentId/versionId` + Key 的 `models`/`aliases`，同 Token、同容器。
- 当前轮不可切；有 SDK 后台任务时切模型返回 409；同 `clientMessageId` 换部署返回 409。
- 管理员切部署指针后，已有会话在下一轮消息接收时解析新版本；本轮已接收的消息不受影响。版本变化记录 `model.replaced` 事件。

### 3. 会话环境 Key

- 每个会话环境一把 Key，逻辑名常量 `ah-session-model`。
- Key 的 `models: [version.routeName]`，`aliases: { "ah-session-model": version.routeName }`。
- 钱包模式返回 Harbor 钱包 Token；真实 LiteLLM Key 不出宿主。
- 关闭环境、停用用户、归档部署时撤销；撤销读回 `deleted`/404 才算完成。

## 五、LiteLLM 同步协议

版本同步 `syncVersion(versionId)`：

1. 读取版本、供应商、当前有效密钥、供应商成本策略；缺失必要配置 → `MODEL_POLICY_REQUIRED`。
2. `GET /model/info`；不存在则 `POST /model/new`：

```json
{
  "model_name": "<routeName>",
  "litellm_params": {
    "model": "<prefix>/<upstreamModel>",
    "api_base": "<provider.apiBase>",
    "api_key": "<decrypted secret>",
    "timeout": 180,
    "stream_timeout": 180,
    "max_retries": 0
  },
  "model_info": { "id": "<versionId>", "harbor_deployment": "<deploymentId>" }
}
```

3. `POST /model/update` 写入供应商成本单价、超时与 `max_retries: 0`；保留 `model_info.id`。
4. 再次 `GET /model/info` 读回；校验 id、routeName、单价、超时、重试；任何不一致 → `MODEL_SYNC_UNCONFIRMED`，版本保持 pending。
5. 成功后写 `state=ready`、`lastSyncedAt`。

`digest` 由 provider 身份、上游模型、协议、params、能力声明计算，用于漂移检测；密钥轮换不改变 digest。

### 密钥轮换

1. 新增 `llm_provider_secrets` 行（version+1），旧行暂不退休。
2. 对该供应商所有 `state=ready` 且未归档部署引用的版本逐个 `/model/update` 写入新 `api_key`，读回确认模型仍存在。
3. 全部成功后旧 secret 写 `retiredAt`；任一失败保持旧密钥有效并返回 503，允许重试。
4. 写审计 `secret.rotate`；不改变路由、Token、会话绑定。

## 六、HTTP 接口

### 用户端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/llm/models` | 返回可用部署（id、name、provider、当前版本摘要、能力）与 `defaultModelId` |
| PUT | `/api/llm/default` | `{ deploymentId }` 保存个人默认部署 |
| GET | `/api/sessions/:id/llm-usage` | 按 deployment/version 归因的会话费用摘要 |

### 管理端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm` | 供应商 + 部署（含当前版本、当前价格、版本数、活跃会话数） |
| GET | `/api/admin/llm/deployments/:id` | 部署详情：版本列表、价格历史、审计 |
| POST | `/api/admin/llm/providers` | 新建供应商 + 密钥 v1 |
| POST | `/api/admin/llm/providers/:id/secrets` | 轮换密钥 |
| POST | `/api/admin/llm/deployments` | 新建部署 + 版本 v1 + 价格 v1 |
| POST | `/api/admin/llm/deployments/:id/versions` | 发布新版本（不自动切指针） |
| POST | `/api/admin/llm/deployments/:id/current` | `{ versionId, expectedVersionId }` CAS 切指针 |
| PATCH | `/api/admin/llm/deployments/:id` | 仅 `name/description/enabled/allowedUsers` |
| POST | `/api/admin/llm/deployments/:id/prices` | 发布新售价版本 |
| POST | `/api/admin/llm/deployments/:id/sync` | 重新同步当前版本 |
| POST | `/api/admin/llm/deployments/:id/archive` | 无未撤销绑定时归档 |

错误码新增：`DEPLOYMENT_NOT_FOUND`、`DEPLOYMENT_ARCHIVED`、`DEPLOYMENT_IN_USE`、`DEPLOYMENT_VERSION_CONFLICT`、`VERSION_NOT_FOUND`、`PRICE_REQUIRED`、`MODEL_SYNC_UNCONFIRMED`。

旧 `/admin/llm/models`、`/admin/llm/models/:id`、`/admin/llm/models/:id/sync` 删除，不做兼容。

## 七、计费与观测

- `wallet_requests` 在请求开始时写 `deploymentId`、`versionId`、`priceVersionId`、`price` 快照与 `modelName`（部署名）。
- 钱包代理按绑定版本解析部署与价格；未配置售价 → `PRICE_REQUIRED`。
- `gateway_usage_events` 通过 LiteLLM spend 日志的 `model`（routeName）反查版本，写入 deployment/version；未知 route 保持 NULL 并计入 unknown。
- 会话费用摘要按 deployment/version 分组；SDK 美元估算、LiteLLM 美元观测、人民币钱包三者仍不相加。

## 八、迁移（0013）

单次迁移完成，不做双写与旧字段兼容：

1. 建新表 `llm_provider_secrets`、`llm_model_versions`、`llm_deployments`、`llm_deployment_prices`、`llm_config_audit`。
2. 回填：
   - `llm_providers.secret` → `llm_provider_secrets` v1；
   - 每个 `llm_models` → deployment（id 沿用 model id，name/description/enabled/allowedUsers 沿用）+ version v1（id 沿用 model id，`routeName` 沿用旧 alias，state 沿用）+ 价格 v1（有价格时，`effectiveFrom=createdAt`）；
   - `llm_bindings.modelId` → `deploymentId/versionId`；
   - `llm_preferences.modelId` → `deploymentId`；
   - 消息/会话 `modelSnapshot` 用旧模型行补齐新字段；
   - `wallet_requests.modelId` → `deploymentId/versionId`，`priceVersionId` 指向回填的价格版本；
   - `gateway_usage_events.model` 能匹配旧 alias 的写入 deployment/version。
3. 删除 `llm_models`、`llm_providers.secret`、`llm_preferences` 旧结构，重建 preferences。
4. 迁移前必须停服并备份控制面数据库；迁移不可回退，回退依赖备份。

## 九、前端改动

- 模型选择器（`ModelPicker`、`ComposerModelPicker`、`NewEntry`、应用创建）改用 `deploymentId`。
- 管理后台「模型与网关」重做：
  - 列表展示部署：名称、当前版本、供应商/上游、价格、同步状态、活跃会话数；
  - 详情抽屉：版本历史、当前指针、价格历史、审计记录；
  - 操作：发布新版本、切指针（带影响提示与 CAS 冲突提示）、回滚（切回旧版本）、轮换密钥、归档；
  - 新建流程：先建供应商（含密钥），再建部署（自动生成 v1 与初始价格）。
- 文案区分「部署名」与「版本」，不再出现「配置不可变但可 PATCH」的矛盾说明。

## 十、测试与验收

必须覆盖：

1. 迁移：空库执行 0000–0013；带旧数据夹具执行 0013 后回填正确，重复执行被 checksum 拒绝。
2. 部署指针：切指针后已有会话下一轮走新版本，当轮已接收消息保持旧版本；CAS 冲突返回 409。
3. 切换模型：A→B→A 同容器、同 Key、同原生会话；Key alias 读回正确；旧版本仍在 LiteLLM。
4. 版本不可变：新版本创建不改变旧版本远端记录；归档被活跃绑定阻止。
5. 密钥轮换：轮换后路由/Token/绑定不变；失败时旧密钥保持可用。
6. 计费：请求快照记录 deployment/version/priceVersion；改价不回溯；未定价拒绝执行。
7. 观测：spend 日志按 routeName 归因到版本；未知 route 计 unknown。
8. `npm run check`、`npm test`、`npm run audit:public` 通过；`tests/llm-verification.mjs`、`tests/model-switching-verification.mjs` 按新契约改写并通过。

## 实现补充

- 版本表增加 `deploymentId`，用于版本历史和归属校验；`llm_model_versions_deployment_fk` 为 `DEFERRABLE INITIALLY DEFERRED`，允许同一事务先插版本再插部署。
- `GatewayConnection` 保持 `url/token/model/bindingId` 四项不变；deployment/version 不进入 Runner 连接摘要，否则切模型会重建会话。
- 应用开发入口的模型字段命名为 `modelDeploymentId`，与应用自身的 `deploymentId`（应用发布实例）区分。
- 新增 `tests/llm-migration.test.ts` 验证 0013 的旧数据回填。
- 供应商名称与 API 地址可在管理端维护，地址变更重写所有 ready 版本并读回；协议仍属于版本身份。
- 运行语义采用稳定别名：会话绑定部署，消息接收时解析当前版本并固定；执行只认消息快照。版本因指针移动而变化时记录 `model.replaced`，UI 活动流显示提示。

## 十一、不做

- 不做灰度发布、按百分比切流、自动回滚。
- 不做自动探活/能力探测；能力仍由管理员声明，切换时只校验声明。
- 不做版本删除；不做远端 LiteLLM 配置的自动清理。
- 不做旧接口/旧字段兼容；不保留双写。
- 不改 Agent 工具循环、容器生命周期和 SDK 调用方式。

## 十二、实施顺序

1. 迁移 0013 + Drizzle schema + 类型。
2. LlmService 重写（部署/版本/价格/密钥/审计）+ 同步读回。
3. HTTP 路由与钱包代理、用量归因。
4. 会话/消息字段重命名与快照。
5. 管理后台与模型选择器。
6. 测试改写、文档更新（`docs/llm-gateway.md`、`docs/admin.md`、`docs/wallet.md`、`docs/llm-baseline.md`、`.env.example`、`README.md`）。
