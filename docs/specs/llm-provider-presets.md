# 主流供应商预置与模型发现

- 日期：2026-10-30
- 状态：已实现（2026-10-30）
- 依据：用户 2026-10-30 要求「支持主流的供应商」
- 影响范围：管理后台供应商/模型创建流程、供应商管理接口、共享预置目录；不改执行引擎、密钥存储和计费账本

## 一、背景

当前新增模型必须手填：供应商名称、API 地址、协议、密钥，再逐个手填上游模型标识。实际使用中出现两类问题：

1. 用户把「模型」和「供应商」混在一起：想加 MIMO，却只在供应商下拉里看到 DeepSeek；
2. 主流供应商的地址、协议、常用模型 ID 需要自己查，容易填错；没有从供应商读取模型列表的能力。

协议层已经覆盖大多数供应商：OpenAI Chat Completions 兼容接口、OpenAI Responses、Anthropic Messages、Anthropic 兼容入口。缺的是预置和发现，不是新的转发协议。

## 二、目标

1. 新增供应商时可以从内置主流供应商列表选择，自动带出名称、API 地址、协议和常用模型示例。
2. 创建供应商后，可以从供应商读取可用模型列表，勾选后批量创建命名部署。
3. 「自定义供应商」是一等路径：预置目录只是快捷模板，任何符合支持协议的地址都可以手动接入，包括公司内部网关、OneAPI/NewAPI、自建 LiteLLM、Ollama/vLLM 等。
4. 不把供应商密钥、模型价格或供应商账单写入预置目录。

## 三、预置目录

新增共享文件 `src/shared/provider-presets.ts`，只包含公开元数据：

```ts
export interface ProviderPreset {
  id: string;
  name: string;
  format: "anthropic" | "anthropic_compatible" | "openai_chat" | "openai_responses";
  apiBase: string;
  docsUrl?: string;
  keyHint?: string;
  models: Array<{ id: string; name?: string; tools?: boolean; streaming?: boolean }>;
  discovery?: {
    path: string;
    auth: "bearer" | "x-api-key";
    anthropicVersion?: string;
  };
}
```

首批目录：

| 分组 | 供应商 | 协议 | 默认地址 |
| --- | --- | --- | --- |
| 国际 | OpenAI | openai_chat | `https://api.openai.com/v1` |
| 国际 | Anthropic | anthropic | `https://api.anthropic.com` |
| 国际 | Google Gemini（OpenAI 兼容） | openai_chat | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| 国际 | OpenRouter | openai_chat | `https://openrouter.ai/api/v1` |
| 国际 | Groq | openai_chat | `https://api.groq.com/openai/v1` |
| 国际 | Mistral | openai_chat | `https://api.mistral.ai/v1` |
| 国际 | xAI | openai_chat | `https://api.x.ai/v1` |
| 国际 | Together | openai_chat | `https://api.together.xyz/v1` |
| 国际 | Fireworks | openai_chat | `https://api.fireworks.ai/inference/v1` |
| 国内 | DeepSeek | openai_chat | `https://api.deepseek.com/v1` |
| 国内 | 阿里云百炼 / Qwen | openai_chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 国内 | Moonshot / Kimi | openai_chat | `https://api.moonshot.cn/v1` |
| 国内 | 智谱 GLM | openai_chat | `https://open.bigmodel.cn/api/paas/v4` |
| 国内 | MiniMax | openai_chat | `https://api.minimaxi.com/v1` |
| 国内 | 火山方舟 / 豆包 | openai_chat | `https://ark.cn-beijing.volces.com/api/v3` |
| 国内 | 百度千帆 | openai_chat | `https://qianfan.baidubce.com/v2` |
| 国内 | 腾讯混元 | openai_chat | `https://api.hunyuan.cloud.tencent.com/v1` |
| 国内 | 讯飞星火 | openai_chat | `https://spark-api-open.xf-yun.com/v1` |
| 聚合 | 硅基流动 | openai_chat | `https://api.siliconflow.cn/v1` |
| 本地 | Ollama / vLLM | openai_chat | `http://host.docker.internal:11434/v1` |

说明：

- 地址和模型示例随供应商变化，预置只是默认值，创建时仍可修改；管理页显示「以供应商文档为准」。
- 火山方舟需要填写接入点 ID（`ep-...`）而不是模型名，预置会在上游标识处给出提示。
- 预置模型只做示例，不作为可用性声明；能力声明仍由管理员勾选。
- 不内置模型价格；平台售价仍按部署设置，供应商美元成本由独立的[成本单价维护](llm-cost-rates.md)规格管理（后台可配置，策略文件保留为回退）。

### 自定义供应商

除了选择预置，管理页始终提供「自定义供应商」：

| 字段 | 要求 |
| --- | --- |
| 名称 | 任意可读名称，仅用于展示 |
| API 地址 | `http`/`https` 根地址；不能带账号、查询串或片段 |
| 协议 | `openai_chat`、`openai_responses`、`anthropic`、`anthropic_compatible` 四选一 |
| API Key | 单个密钥；保存后不回显，只支持轮换 |
| 上游模型标识 | 自由填写，支持 `namespace/model`、`ep-...` 等常见格式 |

适用场景：

- 公司内部 LLM 网关、OneAPI/NewAPI、自建 LiteLLM；
- Ollama、vLLM、LM Studio 等本地 OpenAI 兼容服务；
- 不在预置列表里的 OpenAI/Anthropic 兼容供应商。

边界：

- 认证方式固定为 LiteLLM 对应协议的默认方式（OpenAI 兼容走 Bearer，Anthropic 原生走 x-api-key）；暂不支持自定义请求头。
- 地址不能带 `api-version` 等查询参数；Azure OpenAI 这类需要 deployment + 查询参数的接入后续单独设计。
- 不支持 mTLS、AWS SigV4、Vertex 服务账号 JSON 等非单一 API Key 的鉴权。
- 模型发现是可选增强；自定义供应商读取失败时，手动填写上游标识仍然可用。

## 四、模型发现

### 接口

`POST /api/admin/llm/providers/:id/discover`

1. 读取供应商当前有效密钥。
2. 按预置/格式选择请求方式：
   - `anthropic`：`GET {apiBase}/v1/models?limit=1000`，`x-api-key` + `anthropic-version: 2023-06-01`；
   - 其他：`GET {apiBase}/models`，`Authorization: Bearer <key>`。
3. 兼容返回形状：`{data:[{id}]}`、`{models:[{id|name}]}`。
4. 只返回 `{ models: [{ id, displayName? }] }`，不回传密钥或完整响应。
5. 失败返回可读错误码：`DISCOVERY_UNAUTHORIZED`、`DISCOVERY_UNREACHABLE`、`DISCOVERY_INVALID_RESPONSE`、`DISCOVERY_UNSUPPORTED`。

### 安全边界

- 仅管理员可调用。
- 只允许 `http`/`https`，拒绝 URL 内嵌账号、查询串和片段。
- `redirect: "error"`，8 秒超时，响应体上限 1 MiB。
- 拒绝链路本地地址 `169.254.0.0/16`（云元数据）；允许私有地址，因为本地 Ollama/vLLM 是合法场景。
- 发现结果不落库；管理员勾选后才创建部署。

## 五、管理界面

### 新增供应商

- 弹窗先展示预置分组卡片/下拉：选择预置后自动填名称、地址、协议，只让管理员填密钥。
- 预置列表第一项固定为「自定义供应商」，可手填名称、地址、协议、密钥；它和预置走同一套创建接口。
- 预置只影响表单初始值，不写入数据库；供应商仍按现有模型保存。

### 新增模型

- 供应商弹窗增加「读取模型」按钮。
- 读取成功后展示可搜索的模型列表：
  - 点击一个模型 → 填入上游标识；名称为空时同时填入模型 id；
  - 创建前确认名称、能力声明、供应商成本和平台售价；
  - 不做一键批量创建：不同模型的成本和售价通常不同，逐个确认可以避免产生未定价或未配成本的模型。
- 读取失败时保留手动填写上游标识的路径。
- 预置模型示例显示为快捷选项，点击即填入上游标识。

## 六、接口变更

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/presets` | 返回预置目录（无密钥） |
| POST | `/api/admin/llm/providers/:id/discover` | 读取供应商模型列表 |

供应商创建接口增加可选 `presetId`；只用于服务端校验和审计，不改变现有字段。若提供 `presetId` 但地址/格式被覆盖，以表单值为准。

## 七、不做

- 不做 Azure OpenAI（需要 deployment + api-version）、AWS Bedrock、Google Vertex 的原生鉴权；这些不是单一 API Key 模型，后续单独设计。
- 不做模型自动定价、自动能力探测、自动创建后启用。
- 不内置供应商账单或价格，不改变两套货币的边界。
- 不做后台定时同步供应商模型列表；只做显式读取。

## 八、测试与验收

1. 预置目录接口只返回公开字段，不含密钥。
2. 选择预置创建供应商，地址、协议、名称正确；自定义覆盖生效。
3. 模型发现：OpenAI 形状、Anthropic 形状、失败/超时/超大响应、未授权、不可达。
4. 模型发现结果可点击填入；重复模型不覆盖已有上游标识。
5. 自定义供应商：手动填写全部字段可创建；关闭/失败模型发现后仍可手动创建模型；内部地址、带路径的地址可用。
6. `npm run check`、`npm test`、`npm run build` 通过。

## 九、实施顺序

1. 预置目录与接口。
2. 管理页供应商预置选择。
3. 模型发现接口与安全边界。
4. 模型发现与填入界面。
5. 文档：`docs/admin.md`、`docs/llm-gateway.md`、`README.md`。
