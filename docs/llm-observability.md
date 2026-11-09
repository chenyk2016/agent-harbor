---
layout: page
title: 模型与任务观测
---

配置 Langfuse 后，管理员可以追查一次任务经历了哪些模型和工具调用，查看耗时、用量及已知成本。日常余额与运行状态直接在 [管理后台](admin.md) 查看，无需启用此功能。

## 配置 Langfuse

在实例私有 `harbor.env` 中填写 Langfuse 项目信息：

```dotenv
AH_LANGFUSE_HOST=https://jp.cloud.langfuse.com
AH_LANGFUSE_PUBLIC_KEY=replace-with-project-public-key
AH_LANGFUSE_SECRET_KEY=replace-with-project-secret-key
AH_LANGFUSE_CONTENT_MODE=metadata
```

使用你实际项目的 HTTPS 地址和密钥。同一组设置需要同时交给 Harbor 与模型网关。托管实例先停止 Harbor，再运行以下命令更新依赖，然后按原启动方式重启：

```sh
npm run harbor -- install --dir /absolute/instance
node --env-file=/absolute/instance/harbor.env dist/src/service/server.js
```

三项全部留空时关闭观测。缺项或地址错误会提示配置问题；网络、鉴权或限流异常会使观测降级，但不会单独阻止任务服务启动。

## 选择记录范围

| 模式 | 记录什么 | 适合什么情况 |
| --- | --- | --- |
| `metadata`，默认 | 模型指标、任务和工具元数据 | 查看调用关系、耗时和用量 |
| `redacted` | 以上内容，加脱敏后的模型输入输出及受支持工具的参数、返回 | 需要排查具体模型或工具行为 |

正文模式适用于启用后的新请求。受支持工具包括 Bash、Read、Write、Edit、Glob、Grep；内容可能因体积限制被截断或省略。失败的模型调用不导出模型输入输出正文，图片、附件和推理过程等内容也会被省略。脱敏会过滤常见凭据和敏感字段，普通项目文字仍可能包含业务信息，因此应使用获准接收这些内容的 Langfuse 项目。

## 在哪里查看

在「管理后台 → 请求与历史」打开请求详情，再进入模型或任务追踪。Langfuse 需要单独登录并拥有项目权限。

可查看的信息包括：

- 模型名称、Token 和缓存用量、耗时、错误及已知供应商成本。
- 任务、工具、子代理的开始与结束事件。
- 已确认的任务与模型请求关联；不能确认的关联保持未知。
- 在 `redacted` 模式下，查看可获得的模型与工具输入输出。

工具开始不代表执行成功，接口成功也不代表产物正确。任务结果仍应按实际需求检查。

## 没看到记录怎么办

先查看追踪状态：

```sh
npm run harbor -- tracing --dir /absolute/instance
```

知道请求 ID 时可核实对应云端模型记录：

```sh
npm run harbor -- tracing --dir /absolute/instance --request-id REQUEST_ID
```

这两个命令不调用模型。「已提交」表示上报获接收，「已核实」才表示已从云端读回对应模型记录。没有调用过的历史数据不会因开启观测而自动补齐。

网络故障时会重试上报，但记录仍可能存在缺口。云端保留时间、容量和费用按你的 Langfuse 项目设置处理。

## 关闭与数据保留

清空三项 Langfuse 配置，按启用时相同方式更新网关并重启 Harbor，可停止导出。已经发送到云端的数据按 Langfuse 项目规则保留或删除；删除本地会话不会同步删除云端记录。重新使用原项目时，仍保留的待发记录可能继续上报。

观测用于诊断，不会补扣或退还成员额度。Harbor 人民币扣费、供应商美元成本与 SDK 估算分别记录；缺失成本表示未知。

[返回配置与管理](manage.md)
