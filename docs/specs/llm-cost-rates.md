# 供应商成本单价维护

> 阅读范围：本文件保留成本维护的设计与实施依据；“背景”描述改造前的问题。当前配置和使用以[接入和管理模型](../llm-gateway.md)、[额度与计费](../wallet.md)为准。

- 日期：2026-10-30
- 状态：已实现（2026-10-30）
- 依据：用户 2026-10-30 要求「成本单价也支持配置维护」
- 影响范围：模型版本同步、网关预算、用量归因、管理后台模型详情；不改人民币钱包账本结构
- 关联：[主流供应商预置与模型发现](llm-provider-presets.md)

## 一、背景

当前供应商美元成本只能写在 `infra/llm-policy.json`，通过 `AH_LLM_POLICY_FILE` 加载。新增一个模型时，如果策略文件里没有对应上游模型，同步会直接失败：

```
GATEWAY_MODEL_POLICY_REQUIRED
```

这带来两个问题：

1. 管理员无法在后台维护成本，必须改文件、重启服务；
2. 接入主流供应商时，每加一个模型都要先查美元单价并改配置文件，预置目录只能解决地址和模型发现问题。

同时必须保持现有边界：**供应商成本（美元）和平台售价（人民币）是两条线，永远不相加。**

## 二、目标

1. 管理后台可以按「供应商 + 上游模型」维护四项美元成本单价和请求超时。
2. 成本变更生成新版本，历史请求的计价不回溯。
3. 成本可被版本同步、网关用户预算、用量归因共同使用。
4. `AH_LLM_POLICY_FILE` 保留为兼容回退和全局 RPM 来源，但不再是维护成本的唯一入口。
5. 人民币售价仍按部署单独维护，两者在 UI 和数据结构上明确分开。

## 三、数据模型

新增表：

```sql
CREATE TABLE llm_model_costs (
  id text PRIMARY KEY,
  "providerId" text NOT NULL REFERENCES llm_providers(id),
  "upstreamModel" text NOT NULL,
  "inputUsdPerToken" double precision NOT NULL,
  "outputUsdPerToken" double precision NOT NULL,
  "cacheReadUsdPerToken" double precision NOT NULL,
  "cacheWriteUsdPerToken" double precision NOT NULL,
  "timeoutSeconds" integer NOT NULL,
  "effectiveFrom" bigint NOT NULL,
  "createdBy" text NOT NULL,
  "createdAt" bigint NOT NULL
);
CREATE INDEX llm_model_costs_lookup
  ON llm_model_costs("providerId", "upstreamModel", "effectiveFrom" DESC);
```

设计要点：

- 成本属于「供应商账号 + 上游模型」，不是版本。同一供应商下多个版本引用同一上游模型时共享成本。
- 成本按时间版本化；请求保存版本和价格版本，历史不回溯。
- 金额统一存 **美元/Token**，与 LiteLLM 参数一致；UI 用「美元/百万 Token」展示和输入。
- 超时属于成本策略的一部分；`max_retries` 继续固定为 0。
- 不存人民币售价；售价仍在 `llm_deployment_prices`。

## 四、解析顺序

`costFor(version, at)`：

1. 查 `llm_model_costs` 中同 `providerId + upstreamModel`、`effectiveFrom <= at` 的最新一行；
2. 没有则回退到 `AH_LLM_POLICY_FILE` 中同 `upstreamModel` 的配置；
3. 都没有则视为未配置。

使用点：

| 使用点 | 行为 |
| --- | --- |
| `syncVersion` | 写入 LiteLLM 成本、超时；启用策略模式且两者都没有时返回 `MODEL_COST_REQUIRED` |
| `syncUser` 的美元风险上限 | 用部署当前版本的成本与人民币售价计算保守比例 |
| 网关用量同步 | 按调用开始时间解析成本，判断 `pricingKnown` |
| 后台展示 | 「成本」Tab 显示当前成本、历史与来源（后台/文件） |

## 五、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/deployments/:id` | 版本列表附带每个版本的当前成本和来源 |
| GET | `/api/admin/llm/versions/:versionId/costs` | 成本历史 |
| POST | `/api/admin/llm/versions/:versionId/costs` | 发布新成本版本 |
| GET | `/api/admin/llm` | 增加 `costPolicyRequired`、`userRpmLimit`，供表单判断是否必填 |
| POST | `/api/admin/llm/deployments` | 创建时可选 `cost`，与版本一起落库 |
| POST | `/api/admin/llm/deployments/:id/versions` | 新版本变更供应商/上游时可带 `cost`；相同上游自动复用现有成本 |

成本输入：

```json
{
  "inputUsdPerMillion": 0.28,
  "outputUsdPerMillion": 0.42,
  "cacheReadUsdPerMillion": 0.028,
  "cacheWriteUsdPerMillion": 0.28,
  "timeoutSeconds": 180
}
```

服务端校验：每项为有限非负数，上限 1000 美元/百万 Token；超时 1–3600 秒。保存时除以 `1e6` 转为美元/Token。

错误码：`INVALID_COST`、`MODEL_COST_REQUIRED`。

## 六、成本与售价分开

| 口径 | 存储 | 单位 | 用途 |
| --- | --- | --- | --- |
| 供应商成本 | `llm_model_costs` | 美元/Token（UI 美元/百万） | LiteLLM 计价、美元风险上限、pricingKnown |
| 平台售价 | `llm_deployment_prices` | 微元/Token（UI 元/百万） | 人民币钱包扣费 |

- 两个表单分开，标签明确写「供应商成本（美元）」和「平台售价（人民币）」。
- 后台不能把成本自动换算成售价，也不做汇率转换。
- 成本变更不影响已有人民币请求的价格快照。

## 七、管理界面

- 模型详情新增「成本」Tab：
  - 当前成本四项 + 超时；
  - 来源：后台配置 / 策略文件回退 / 未配置；
  - 发布新成本；
  - 历史列表。
- 新增模型弹窗增加成本四项与超时：
  - `costPolicyRequired=true` 时必填；
  - 未启用策略时可选，留空则不写入 LiteLLM 成本。
- 发布新版本时：
  - 相同供应商和上游模型自动复用现有成本；
  - 变更供应商或上游模型时，表单提示需要新成本。
- 模型列表增加「未配成本」状态；策略模式下计入「同步异常」筛选。

## 八、兼容与迁移

- 新迁移 `0014_llm_model_costs.sql` 只新增表，不回填数据。
- 现有 `AH_LLM_POLICY_FILE` 继续生效：后台没有成本时回退到文件。
- 放宽 `readGatewayPolicy` 校验：允许 `models` 为空，仅保留 `userRpmLimit`；管理员可以逐步把成本迁到后台后清空文件。
- 不自动把文件导入数据库，避免启动时写库和产生无法解释的成本版本；后台首次发布成本时明确记录操作人和时间。

## 九、测试

1. 发布成本后，`syncVersion` 写入 LiteLLM 并读回确认。
2. 同一供应商+上游的多个版本共享成本；发布新成本后重新同步。
3. 未配置成本且策略模式启用时，同步返回 `MODEL_COST_REQUIRED`。
4. 后台成本缺失时回退策略文件；两者都没有时 pricingKnown 为 false。
5. 成本变更不改变人民币售价、余额和历史请求扣费。
6. `syncUser` 的美元风险上限使用后台成本计算。
7. 管理接口权限、输入校验、历史版本不可变。
8. `npm run check`、`npm test`、`npm run build` 通过。

## 十、不做

- 不做定时生效价格、汇率换算、供应商账单对账。
- 不做自动从供应商 API 抓取价格。
- 不做成本审批流。
- 不改变人民币钱包账本和请求结算状态机。
