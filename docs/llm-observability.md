---
description: 为 Agent Harbor 配置 Langfuse 模型与任务观测，核对任务、工具调用、模型 generation 和内容采集模式。
---

# 模型与任务观测

Langfuse 是可选依赖。填写完整的三项配置会自动启用；全部留空就关闭，没有独立的 enabled 开关。支持日本区 Langfuse Cloud；同样可以配置其他明确的 HTTPS 地址。

## 配置与生效

在宿主的私有环境文件中填写，同一组值也交给 LiteLLM Compose：

```dotenv
AH_LANGFUSE_HOST=https://jp.cloud.langfuse.com
AH_LANGFUSE_PUBLIC_KEY=replace-with-project-public-key
AH_LANGFUSE_SECRET_KEY=replace-with-project-secret-key
AH_LANGFUSE_CONTENT_MODE=metadata
```

三项全空或未设置时，不创建导出客户端、不注册 Langfuse callback，也不请求云端。只配置一部分或地址无效时，观测保持关闭并提示字段名，Harbor 的任务服务仍能启动。完整配置后的鉴权/网络/限流故障属于观测降级，不当成正常关闭。

`AH_LANGFUSE_CONTENT_MODE` 决定采集范围。`metadata`（默认）保留模型指标和任务、工具元数据。`redacted` 额外采集脱敏后的模型输入输出、受支持工具的参数与返回，以及应用产物引用。宿主和网关使用同一设置。正文模式适用于启用后的新请求，已有 Cloud 记录保持原样。

配置在进程启动时读取。变更后重启宿主服务，并使用同一环境文件重新创建 LiteLLM 容器。统一交付实例将配置加入其 `harbor.env`，再执行 `npm run harbor -- install --dir /absolute/instance`（按原交付规则停服）并重启服务。直接使用 Compose 的开发实例可以运行：

```sh
docker compose --env-file .env --env-file var/private/langfuse.env \
  -f infra/litellm.compose.yml up -d --force-recreate litellm
node --env-file=.env --env-file=var/private/langfuse.env dist/src/service/server.js
```

启动命令只是示例；先确认旧进程退出并按既有步骤备份、迁移，不能为打开观测再启动第二个共用数据根的写入进程。控制面先应用待执行迁移，包括 `0016_llm_tracing.sql` 和 `0018_tracing_content.sql`。工具正文使用当前发行版 Runner，固定旧镜像的会话仍会产生原有元数据。

LiteLLM 的容器入口按配置生成 `/tmp/harbor-effective.yaml`。关闭时仅保留原有 Prometheus；启用时增加 `langfuse_otel`，使用固定版本已验证的 OTel v2、仅模型调用范围，以及按内容模式选择的原生采集。密钥只通过私有环境传递，不写入生成的 YAML、网页或 Runner。不要同时配置另一个 Langfuse callback 或客户端模型自动采集，否则会重复计算调用。

需要代理时，Harbor 导出器读取 `HTTPS_PROXY` / `HTTP_PROXY` 与 `NO_PROXY`；容器的代理地址可通过 `AH_LANGFUSE_CONTAINER_PROXY` 单独配置，例如开发机的 `http://host.docker.internal:7890`。代理字段不参与启用判断，不能用它代替三项必需配置。内网供应商地址也须加入适当的 `NO_PROXY`，不要将宿主的回环代理地址直接给容器。

## 可以看到什么

管理员在“请求与历史”的详情中可以打开模型调用追踪，以及已由 SDK 回执确认的任务与工具追踪。Langfuse 仍要求登录并拥有项目权限；不生成公开分享链接。

- LiteLLM 写入模型 generation：模型、Token、缓存用量、已知供应商成本、耗时和错误。
- Harbor 写入 inference span 及任务/工具/子代理事件。推理请求通过可信 `traceparent` 与网关 generation 组成一棵树。
- 任务与模型请求通过精确的 SDK 回执及 requestId 互相定位。任务 trace 与请求 trace 仍分开；没有回执时保持未知，不能据“当前活跃消息”分摊后台请求。
- 原生工具循环与取消逻辑不变。不为每个文字片段打点；工具开始仅代表进入权限检查，不代表工具实际执行成功。

用户/会话使用稳定匿名标识，工具标识保留受控名称及散列后的来源编号。错误记录类型和状态。默认模式仅发送这些元数据。

`redacted` 模式在模型 Generation 的 Input / Output 中显示 LiteLLM 原生观测的数据。支持的 Bash、Read、Write、Edit、Glob、Grep 调用通过 SDK 完成钩子记录参数和实际返回。SDK 提供退出码时保留该字段。Runner 正文在写入普通诊断日志与产品事件前分离，复用同一工具观察记录。应用生成保存版本后，任务追踪追加产物记录。执行状态和人工验收状态分别显示，未登记验收时写 `unrecorded`。

脱敏规则覆盖常见凭据格式、敏感字段、邮箱、已知运行凭据、识别出的敏感文件操作、媒体和内部思考块。普通项目文本仍可能含业务敏感信息，启用正文时应使用授权的 Langfuse 项目。模型 Input / Output 上限为 128 / 64 KiB，工具参数 / 返回为 16 / 32 KiB，超限会标记省略或截断。取消和失败按可获得的观测字段展示，供应商错误正文和堆栈在出口丢弃。

Harbor 人民币扣费、网关供应商美元成本与 SDK 估算是不同口径；观测记录不会反向结算、补扣或释放预占。缺失成本不等于0。

## 状态、核实与恢复

后台区分未配置、配置错误、历史无记录、等待上报、已提交、已核实和观测降级。“已提交”仅表示宿主批次获接收，不能据此认定网关模型 generation 已存入云端。

统一交付实例可以显式查看状态及核实某次模型记录，不调用模型：

```sh
npm run harbor -- tracing --dir /absolute/instance
npm run harbor -- tracing --dir /absolute/instance --request-id REQUEST_ID
```

核实成功要求在 Cloud 读取回相同 traceId 的模型 generation，而不只是宿主 span。没有新数据时状态页不会发送付费模型探测。`doctor` 单独报告配置错误，观测降级不改变 Harbor 主服务 readiness。

宿主以持久队列/事件游标导出；失败退避至最多60秒重试，最多10000条待发，饱和时保业务并增加缺口计数。重启不重新导出首次启用前的历史事件，相同目标的事件重放使用稳定 span ID。已发送队列保留30天，仅用于本地恢复投影，不是 Cloud 数据保留承诺。没有原始时间的事件使用稳定的消息/会话时间并标明时序来源。工具正文进入队列前使用最多 256 条短期内存缓冲，持久投影每目标最多 1024 条并在 7 天后清理。删除本地消息会级联清理其内容投影，云端保留和删除按 Langfuse 项目设置执行。

移除配置并重启会停止导出和重试；再次配置不同项目不会把旧目标的队列转发过去。旧目标队列保留，重新使用原目标时可能继续补发，需按数据保留要求处置。Cloud 的保留、额度和费用按实际套餐核对。

LiteLLM 的直接 callback 没有被改造成可靠消息系统；网关进程故障可能造成模型观测缺口。宿主队列、Cloud 已收数据、供应商账单分别核对，不能声称绝对不丢数据。宿主备份覆盖本地映射/游标/队列，不等于备份了 Cloud。

## 验证

```sh
npm run check
AH_TEST_DATABASE_URL=... npm test
node tests/tracing-verification.mjs
# 可选：使用私有Cloud配置做真实入库/回读，模型仍为本地夹具
AH_TRACING_VERIFY_CONTENT=1 AH_VERIFY_IMAGE=agent-harbor:release \
  AH_LANGFUSE_ENV_FILE=var/private/langfuse.env node tests/tracing-verification.mjs
```

集成验证使用独立 PostgreSQL、LiteLLM、原生 SDK 与模拟模型。发送到 Cloud 前先检查实际 OTLP 负载中的正文哨兵；测试不会调用付费供应商。测试通过不能代替真实供应商质量、Cloud长期容量或生产灾备验收。
