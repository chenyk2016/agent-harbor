# LiteLLM 网关、命名部署与版本

首版提供管理员维护供应商、命名部署、不可变模型版本、版本指针、价格版本、密钥轮换、按环境签发的受限 Key、撤销协调和会话级网关费用观测。未启用钱包时模型流量由原生 SDK 直连 LiteLLM；启用人民币钱包后经过 Harbor 计费转发，原生 Agent 循环保持不变。

## 结构

| 对象 | 可变性 | 说明 |
| --- | --- | --- |
| 供应商 | 身份不可变 | 名称、协议、API 地址；密钥独立版本化 |
| 部署（deployment） | 指针可变 | 用户选择和看到的对象；名称、说明、启用状态、使用范围可改 |
| 版本（version） | 不可变 | 供应商、上游模型、LiteLLM route、能力声明；内容变更 = 新版本 |
| 成本（cost） | 版本化 | 供应商美元单价，按供应商 + 上游模型共享；后台优先，策略文件回退 |
| 价格（price） | 不可变 | 每次调价新增一行；请求保存价格版本快照 |
| 会话/消息 | 部署固定、版本按轮解析 | 会话绑定部署；每条消息接收时解析当前版本并固定，记录 deployment + version |

部署的 `id` 创建后不变；版本路由名为 `ah-mv-<versionId>`。Runner 只认稳定逻辑名 `ah-session-model`，由会话 Key 的 `aliases` 指向当前固定版本。

## 启用

1. 为 LiteLLM 准备独立 PostgreSQL 数据库/账号；不要使用 Harbor 业务表或观测库。
2. 在私有环境文件配置 `AH_LITELLM_DATABASE_URL`、`AH_LITELLM_MASTER_KEY`、`AH_LITELLM_SALT_KEY`。管理 Key 和 Salt 必须长期保管；Salt 变化会影响已保存上游凭据的解密。
3. `docker compose --env-file <private-env-file> -f infra/litellm.compose.yml up -d`。模板固定 `ghcr.io/berriai/litellm:v1.106.1`，本机默认 127.0.0.1:4320，仅用于受管本地部署；公开服务应使用 TLS 和网络访问控制。
4. Harbor 配置 `AH_LITELLM_MANAGEMENT_URL=http://127.0.0.1:4320`、`AH_LITELLM_INFERENCE_URL=http://host.docker.internal:4320` 和同一管理 Key。宿主与 Runner 地址不同；全容器部署应改为内部服务名。
5. 可选配置 `AH_LLM_DEFAULT_DEPLOYMENT_ID`、`AH_LLM_POLICY_FILE`、`AH_LLM_SESSION_BUDGET_USD`。执行 `npm run build` 和 `npm run db:migrate` 后启动；启动不自动迁移数据库。
6. 管理员先新增供应商，再新增命名部署；部署会自动创建 v1 并同步。需要更换上游、协议或能力声明时发布新版本，再显式设为当前。

托管网关配置齐全后自动启用。缺少必要配置时，管理台仍可启动。已指定托管网关的实例不会因配置不全而改用全局密钥。管理模式下不使用全局 `AH_GATEWAY_TOKEN`。关闭 `AH_LLM_ENABLED` 后仍可使用旧全局网关模式，但带受管快照的会话不会回退旧出口。

## 管理操作

- **新增供应商**：支持预置目录或自定义；保存协议、地址和密钥 v1；密钥保存后不回显。名称和 API 地址可维护，地址变更会重写所有 ready 版本并读回；协议属于版本身份，变更请新增供应商。还能从供应商 `/models` 显式读取模型列表。
- **新增部署（用户看到的模型）**：必须先有供应商；创建部署、v1 版本，可选初始价格；同一供应商可承载多个上游模型。同步失败保持 `pending`，由管理员重新核对。
- **发布新版本**：内容不可变；不会自动切换指针。
- **设为当前版本**：提交 `versionId` 和 `expectedVersionId` 做 CAS；冲突返回 `DEPLOYMENT_VERSION_CONFLICT`。已有会话在下一轮消息接收时解析新版本，并记录 `model.replaced`。
- **发布新价格**：按四项人民币单价生成新的价格版本；历史请求不回溯。
- **发布供应商成本**：按供应商 + 上游模型发布美元单价和超时；同上游的 ready 版本会重新同步，失败保持 pending。
- **轮换密钥**：新增密钥版本，重写该供应商所有 ready 版本的 `api_key` 并读回确认；全部成功后才退休旧密钥，失败时旧密钥继续有效。路由、Token 和会话绑定不变。
- **归档部署**：没有未撤销绑定时才能归档；归档后不再出现在模型目录。
- **同步**：所有远端写入都是「先落库 → 写 LiteLLM → 读回确认」；失败保持 pending 或返回未确认错误，不静默重放。

## 路由与状态

供应商协议和版本配置不可变；`/model/new` 只在缺失时创建，后续 `/model/update` 每次写回完整期望配置（模型、地址、密钥、参数、价格与超时），用于修复漂移。模型同步先保存 pending 和确定的 `model_info.id`，再读回确认；超时保留 pending，管理员点「重新核对」。

`anthropic` 使用 LiteLLM Anthropic 适配；`anthropic_compatible` 对 OpenAI 兼容 deployment 显式声明原生 `/v1/messages`；`openai_chat` 使用 `custom_openai` 路径；`openai_responses` 使用 `openai` 路径。格式适配不保证 thinking、缓存、搜索、图片等高级语义等价。

会话创建记录 `modelSnapshot`，消息 POST 可带 `deploymentId`。不传时沿用会话最近激活的部署；新会话默认值优先使用个人设置，再管理员默认和首个可用部署。稳定别名按轮解析：消息接收时读取部署当前版本并写入消息快照，执行期间不变；选择只改变草稿，发送后固定当轮版本。服务端再次鉴权，确认网关 route 后保存 `activatedModelSnapshot`、`model.activated`，版本因指针移动而变化时另记 `model.replaced`。

新 Key 使用稳定逻辑模型 `ah-session-model`；Key 的 `aliases` 将其映射到消息固定版本的 route，`models` 只放行该 route。切换模型时更新同一把 Key，不调用客户端 setModel，也不重建容器或 MCP。后端保持 Runner 可见的 URL、Token、逻辑模型和绑定 ID 不变。超时或状态不符则本轮不发送到模型，不静默回退。

生成中可以修改下一轮草稿模型，但不能改变当前轮次或并行排队。SDK 报告仍有后台任务时，服务端拒绝切换模型；相同消息 ID 换部署或正文返回 409。管理员停用部署会撤销使用该部署的 Key；停止工具仍由 Harbor 生命周期确认。

Key 采用环境生命周期授权，不设固定到期时间。关闭环境、停用用户、停用或归档部署触发撤销；远端删除后读回 `deleted` 或 404 才记 `revoked`。撤销失败保留待核对状态。启动先清理旧 Runner 并撤销旧 Key，结果不明不开放执行。

## 费用与观测

聊天顶部显示最近使用模型及 LiteLLM Key 观测费用，可刷新。`GET /api/sessions/:id/llm-usage` 检查会话归属，只返回脱敏费用摘要。单 Key 跨版本沿用总费用；记录所有曾选版本，任何未计价部分都保持未知。凭据创建时固定计价状态，后补价格不会把此前未计价的 0 误认为免费。

启用 `AH_LLM_POLICY_FILE` 后，网关用量同步按 route 反查版本，写入 deployment/version 归因；未知 route 保持未知。人民币钱包按请求的 deployment/version/价格版本结算，与网关美元观测不相加。

供应商美元成本优先读取 `llm_model_costs`，没有后台记录时回退 `AH_LLM_POLICY_FILE`；两者都没有且策略模式启用时同步返回 `MODEL_COST_REQUIRED`。策略文件仍提供全局 RPM，`models` 可以为空。

`AH_LLM_SESSION_BUDGET_USD` 为可选的新环境 Key 预算，凭据重建时重新计算，不能作为整个会话或用户累计硬预算。用户级月度预算、并发预留、完整请求/attempt 账本和逐消息严格归因仍不在首版范围。

## 验证

- `npm run check`、配置 `AH_TEST_DATABASE_URL` 后 `npm test`：覆盖迁移回填、部署指针 CAS、按轮版本解析、密钥轮换、撤销未知态与计费归因。
- `npm run verify:llm`：要求专用可丢弃 PostgreSQL、已启动的隔离 LiteLLM，设置 `AH_VERIFY_LITELLM_URL` 和 `AH_VERIFY_LITELLM_KEY`；使用本地确定性模型端点验证真实 LiteLLM、Docker、SDK 的 Read→Write→Bash 链路。
- `node tests/model-switching-verification.mjs` 与 `tests/stable-keys-verification.mjs` 使用隔离网关验证 A→B→A、同一 Key 跨轮和撤销；确定性上游不代表真实供应商质量或生产隔离。

源文档：https://docs.litellm.ai/docs/proxy/client_setup/claude_code 、https://docs.litellm.ai/docs/anthropic_unified/native_passthrough 、https://docs.litellm.ai/docs/proxy/virtual_keys 。
