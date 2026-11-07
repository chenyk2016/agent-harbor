---
description: 查看 Agent Harbor 应用的访问、转化、错误与版本数据，使用受控只读问数分析获准记录，为应用改版提供依据。
---

# 应用观测与运营分析

本模块为受信创作者的应用提供通用观测：流量、业务转化、质量和版本分组。业务目标由各应用声明，采集、去重和管理面板由Harbor统一提供。

## 已实现

- 应用编辑器的「运营」页：正式/测试环境、最近1/7/30天、概览/转化/质量/版本。
- 平台SDK在构建时注入，默认记录页面访问、SPA路径变化、来源标签、设备、脱敏页面错误及LCP/INP/CLS。旧应用源码也可重建接入。
- 业务事件在manifest声明；浏览器只能上报browser事件，服务端成功事件通过业务事务outbox持久化。事务回滚不会留下成功事件。
- 独立观测PostgreSQL数据库、显式迁移、部署级写能力、请求归属验证、批量上报、重复去重、限长/枚举属性、版本关联和查询上限。
- Runtime接口状态/耗时、Caddy脱敏JSON日志、容器CPU/内存与健康采样。边缘请求和应用接口分别统计。
- 分析设置支持核心目标、漏斗步骤与窗口，带版本冲突检测并保留历史设置，不改变应用业务代码。
- 简单站内异常提示：连续三次健康失败、至少100次请求且近5分钟5xx超过5%、业务事件积压超过5分钟。暂不发送外部消息。
- 所有者可通过管理API清除所选环境观测；删除墓碑拒绝已删除范围的迟到重放。

## 启用

按[应用创建指南](applications.md)启用应用功能后，`npm run db:migrate` 默认在应用 PostgreSQL 实例创建独立观测库与专用账号，再执行观测迁移。已有应用安装可单独执行 `npm run observability:migrate`。这两条命令须使用和 Harbor 服务相同的应用数据目录与数据库配置。服务启动读取已准备好的库。

- 自备独立库时设置 `AH_OBSERVATION_DATABASE_URL`，迁移命令会使用它。
- 显式关闭应用观测时设置 `AH_OBSERVATION_ENABLED=0`。
- 托管库的采集端口默认 `4324`，原有自备库的默认端口保持 `4320`。默认监听回环地址，应用用 `host.docker.internal` 访问同一端口。可通过 `AH_OBSERVATION_PORT`、`AH_OBSERVATION_BIND_HOST` 和 `AH_OBSERVATION_COLLECTOR_URL` 覆盖。请实测 Docker 到内部采集端的可达性，部署私有写能力和监听地址由 Harbor 管理。
- 重启 Harbor 后，后续部署默认接入。对已有应用，在要接入的环境重新部署一次。用真实浏览器访问并完成一次核心业务，检查该环境的事件和漏斗。
- 备份应用数据目录时保留 `observation/` 和 `secrets/`，并单独备份观测 PostgreSQL 数据库。

Collector与Worker仍在Harbor宿主进程，拥有独立的小数据库连接池；这是单机受信首版，不是进程级生产安全隔离。Collector不使用控制面Cookie认证，应用无权查询别人的观测库。Runtime可读取自身获授写能力，因此不能把应用自行emit的数据视为外部审计账本。

## 工作台只读问数

应用及观测可用、托管钱包网关就绪时，问数随应用工作台启用。设置 `AH_APP_ANALYSIS_ENABLED=0` 可单独关闭问数。查询限定在选定应用和环境内。没有配置字段授权时，模型只能看到业务记录的 ID 和系统时间字段。需要开放业务字段时，在私有部署配置中通过 `AH_APP_ANALYSIS_TABLE_FIELDS` 为指定应用和环境列出允许字段。问数使用托管模型，可能消耗额度。

## 业务事件

在`harbor-app.json`原有字段旁声明可选`analytics`：

```json
{
  "analytics": {
    "schemaVersion": 1,
    "events": {
      "signup_started": { "version": 1, "source": "browser", "properties": {} },
      "signup_succeeded": {
        "version": 1, "source": "server", "properties": {},
        "binding": { "kind": "table_created", "table": "signups" }
      }
    },
    "primaryGoal": "signup_succeeded",
    "funnels": [{
      "id": "signup", "unit": "session", "windowMinutes": 30,
      "steps": ["page_view", "signup_started", "signup_succeeded"]
    }]
  }
}
```

前端在实际开始填写时调用：

```ts
(window as any).harbor?.track("signup_started", {});
```

`table_created`绑定只有在公共CRUD实际新增记录成功时触发；必须由业务确认新增记录就是目标含义。自定义业务路由使用`context.analytics.transaction(async (client, emit) => { ... })`，在同一个client执行参数化业务写入后`await emit(name, properties, context.analytics.context(request))`，事务返回后再发送成功响应。事件含义/属性类型改变必须增加事件版本；发布时检查历史契约冲突，允许回滚到已知历史契约。

属性只接受声明过的有限枚举、数值和布尔值。禁止用埋点收集姓名、邮箱、完整表单、任意自由文本、Token和连接串。平台保留事件名不允许业务重定义。

## 口径与可信度

- 匿名访客ID按应用存储，不跨设备合并，不使用Harbor账号作访客身份。按键名前缀隔离只避免受信代码误串，不构成同源恶意代码隔离。
- 页面浏览以事件去重；跨天UV从原始样本distinct计算，不能相加每日UV。漏斗为同session、严格顺序、声明窗口；跨来源同毫秒无法确认顺序时保留歧义，不猜测。
- 当前来源标签取白名单格式`utm_source`，缺失为unknown。尚未实现Referer归因、多触点归因、完整内部生产流量排除或机器人识别。
- 页面源码版本与实际处理请求的部署版本分别保存；旧页面不会被强行当作新页面。版本分组不是受控实验，也不证明因果。
- 浏览器批量上报为最佳努力，关闭/断网/拦截器可能丢失。业务outbox持久重试；硬上限10000条时降级保业务，记录缺口计数，不承诺所有故障下都不丢。
- Worker每5秒至多轮询5个应用的数据环境，停止应用也可补发；容器/健康约30秒采样。应用数量增加会延长排空周期，应按实测调参。
- 每次查询最多20000条原始记录，超过上限标记partial，图表只代表当前样本。原始事件30天，去重键37天；尚未实现180天汇总、长周期精确UV或留存矩阵。
- JS错误只保留受控异常类型和位置，不传任意错误消息/stack。当前没有私有source map还原。
- 缺失、零、未接入、迟延分别展示。CPU/内存是资源样本，不是精确费用；外部模型/API账单尚未接入。

## 网关日志

合并[脱敏Caddy示例](../infra/app-observation.Caddyfile)到实际站点，可用`caddy adapt`转换为JSON。Harbor应用路由会追加固定`harbor_deployment`标签；日志采集器只消费带已登记部署标签的记录。

```dotenv
AH_OBSERVATION_EDGE_LOG=/var/log/caddy/application-access.json
```

必须在Caddy写日志前删除请求URI、IP、headers及响应headers；不能只在入库前过滤后声称磁盘日志没有秘密。保持部署日志标签，不把边缘资源请求当PV。采集游标按文件身份和偏移持久化，重读去重；轮转时标记可能缺口。当前不追读全部轮转归档，服务停机跨过轮转窗口可能丢失边缘明细。

## 存储与维护

独立观测库保存绑定、事件、去重、运行状态、分析设置历史和删除墓碑。应用业务库新增`harbor_observation_outbox`与`harbor_observation_state`，平台供应器创建并授权，不通过公共tables API暴露。

数据清除接口：`POST /api/applications/:id/observability/data-deletions`，正文包括`environment`和`confirmAppId`。它清除该环境原始观测并登记时间墓碑；待发旧outbox被Worker丢弃，去重键按保留窗口清理，不含访客明文身份。当前没有后台聚合缓存，因此不会保留旧统计。备份也需包含墓碑；恢复更早备份时需由运维补回其后的删除记录。完整自动删除作业、备份恢复验证和永久应用删除联动仍待完成。

## 检查与验证

```sh
npm run check
# AH_TEST_DATABASE_URL必须指向可丢弃数据库
npm test
npm run verify:observability
# 保留临时服务用于浏览器验收，Ctrl-C后只清理本轮资源
AH_OBSERVATION_REGRESSION=1 AH_OBSERVATION_KEEP_OPEN=1 npm run verify:observability
```

专项验证使用隔离PostgreSQL、真实应用镜像和Caddy，不调用真实模型、不切换既有服务。浏览器验收和公网HTTPS/真实运营验收分开记录。原始设计保留在仓库的 `docs/design/application-observability.md`。

尚待交付：180天聚合、留存、持久告警确认/恢复工作流、受控A/B、费用账单、完整删除/备份恢复、全量故障与容量验收。当前首版支持小规模受信试用，不能据此承诺生产吞吐或真实运营效果。
