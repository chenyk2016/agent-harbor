# 配置与数据目录

推荐从 [托管安装](quickstart.md) 开始。该方式生成实例私有 `harbor.env`，服务通过 `node --env-file=...` 加载。手工部署源码时可复制 `.env.example` 为 `.env`，由 `npm run server` 加载。Node 启动时，已导出的同名环境变量优先于文件值。控制面使用 PostgreSQL 18，最低为 17。

| 配置 | 默认值/用途 |
| --- | --- |
| AH_GATEWAY_URL | http://host.docker.internal:8080，容器可访问的获准网关 |
| AH_GATEWAY_TOKEN | 旧全局网关的凭据。托管 LiteLLM 模式使用独立配置 |
| AH_MODEL | claude-sonnet-4-6，以网关支持范围为准 |
| AH_IMAGE | Runner 镜像。托管安装写入 `configure --image` 指定的版本 |
| AH_DATA_DIR | 服务默认var/service-sessions；cli:local默认var/sessions |
| AH_SERVICE_URL | CLI连接地址，默认http://127.0.0.1:4318 |
| AH_SERVICE_TOKEN | CLI开发访问密钥，与网关凭证独立 |
| AH_SERVICE_PORT | 服务本地监听端口，默认4318；始终绑定127.0.0.1 |
| AH_IDLE_TIMEOUT_MS | 服务任务结束后的空闲回收，默认900000 |
| AH_TASK_TIMEOUT_MS | 单轮总超时，默认0（无平台总时限）；设为正数后超时会强制关闭环境 |
| AH_MAX_TURNS / AH_MAX_BUDGET_USD | 默认均为 0，即不设平台轮数和 SDK 估算费用上限 |
| AH_INTERRUPT_TIMEOUT_MS | 原生中断等待时限，默认5000；超时强制关闭 |
| AH_CAPACITY | 最多打开中的环境数，默认4，包含启动和空闲 |
| AH_EVIDENCE_DIR | 部分验证脚本的输出位置，默认var/evidence |
| AH_BOOTSTRAP_ADMIN_KEY | 管理员访问密钥。可放入服务读取的 .env 或 harbor.env，修改后重启生效；需在 AH_ADMIN_USERS 指定单个管理员 |
| AH_DATABASE_URL | 必填，控制面PostgreSQL连接串；服务不会在启动时自动建表 |
| AH_DATABASE_POOL_MAX | 连接池上限，默认10，范围1–100 |
| AH_TEST_DATABASE_URL | 仅测试使用，指向可丢弃的数据库；测试会创建并删除独立schema |

执行配置只由受信服务部署者提供，不透传浏览器输入。SDK预算在同一次query跨消息累计，不是租户硬配额；模型网关密钥和计费配置见[模型与网关](llm-gateway.md)与[额度与计费](wallet.md)。旧开发密钥文件在启动时导入PostgreSQL；V6本人密钥接口创建/撤销即时生效。

## 功能何时启用

托管安装已准备数据库、LiteLLM、钱包地址和工作台认证密钥。已有安装中显式关闭的配置继续生效。配置变更后重启服务。

| 功能 | 自动启用条件 | 显式关闭 |
| --- | --- | --- |
| 托管 LiteLLM | 管理 URL、推理 URL、管理密钥齐全，且服务成功初始化网关 | `AH_LLM_ENABLED=false` |
| 人民币钱包 | 托管 LiteLLM 可用，且已配置 Runner 可达的 `AH_WALLET_INFERENCE_URL` | `AH_WALLET_ENABLED=false` |
| 工作台邮箱密码登录 | 固定 `AH_PUBLIC_ORIGIN`、至少 32 字符的 `AH_WORKBENCH_AUTH_SECRET`、认证表可用 | 通过移除认证密钥关闭邮箱密码入口，先验证其他登录方式 |
| 工作台自助注册 | 工作台邮箱密码登录可用、公开来源是 HTTPS、托管钱包网关可用 | `AH_WORKBENCH_REGISTRATION=false` |
| 应用创建 | 应用访问来源、创建者名单、应用数据库与 Caddy 管理地址已配置，服务检查数据库与 Caddy 就绪 | `AH_APPLICATIONS_ENABLED=0` |
| 应用访客登录 | 应用创建可用，认证域、应用域、网关认证和凭据配置通过校验。每个应用另行声明登录策略 | `AH_APP_AUTH_ENABLED=0` |
| 应用观测与只读问数 | 应用可用且观测库已迁移。问数还需要托管钱包网关 | `AH_OBSERVATION_ENABLED=0` 或仅关闭问数的 `AH_APP_ANALYSIS_ENABLED=0` |
| Langfuse | 配置地址、公钥和密钥三项 | 留空三项 |

部分启用条件缺失时，工作台可以继续启动，查看启动日志、应用入口或 `harbor doctor` 的配置说明。已选择托管网关时，配置不完整或不可用会阻止模型任务，不会回退到旧全局凭据。 [模型网关](llm-gateway.md) · [应用创建](applications.md) · [访客认证](application-login.md)

## 常驻 Runner 后端

默认使用 `AH_RESIDENT_BACKEND=docker`。在单机 Linux 上设为 `opensandbox`，并填写 `AH_OPENSANDBOX_RUNNER_ORIGIN` 和 `AH_OPENSANDBOX_RUNNER_KEY`，对话、专家、Skills、各类 MCP、设置页 MCP 测试、只读问数、Skill 依赖安装、应用构建和本地 CLI 执行均使用同主机的专用管理服务。CLI 也需要以能访问同一数据根和 Unix socket 的 Linux UID 1000 运行。

同时设置 `AH_APP_RUNTIME_BACKEND=opensandbox`，应用预览和正式运行也由 OpenSandbox 管理。默认沿用 Runner 的地址和密钥。专用管理服务须开启应用配置目录，并使用本机 Docker 引擎。参见[管理服务部署和应用回切](../infra/opensandbox/README.md)。

在隔离实例先验证。切换时停止 Harbor，保留数据根、PostgreSQL 和镜像，改后端再启动。服务会先按归属清理旧执行环境，确认停止后接单。未结束消息留在历史，用户可显式提交新一轮。确认切回时可移除 OpenSandbox Runner 配置。启动遇到未确认的创建请求时保留待核对状态，参见[部署和故障边界](../infra/opensandbox/README.md)。

## 宿主持久目录

```text
<AH_DATA_DIR>/
├── .service/                      不挂载进容器，目录权限0700
│   ├── .lock                      数据根独占锁
│   └── access-keys.json            userId与token哈希，权限0600
└── <session-uuid>/
    ├── workspace/                 用户文件
    ├── claude-state/              原生上下文与会话记录
    ├── session.json               最近一轮与容器事实
    ├── .lock                      会话执行锁
    └── attempts/
        ├── .leases/<lease-id>     每次open的独立心跳
        └── <message-id>/
            ├── task.json          本轮正文及执行规格
            ├── connection.json    启动Runner的那轮保存连接；关闭后清空
            ├── events.jsonl       本轮执行事件
            ├── runner-events.jsonl 仅启动轮，保留整个Runner事件
            ├── stderr.log         启动轮的内部诊断
            └── cancel             取消标记
```

实际进入执行层的消息才增加attempt。去重、忙时拒绝及交给SDK前就取消的消息仍保存在数据库，不一定有attempt目录。服务历史只从PostgreSQL读取，JSONL用于执行诊断。

控制面使用PostgreSQL：接收、去重、状态与事件在同一事务提交；同会话用行锁串行化，活动消息由部分唯一索引约束，事件编号用原子自增分配。数据包含用户正文、回答和工具记录；不进入Git。历史不会自动删除。可通过[删除操作](deletion.md)清理指定会话，定期[停机备份](deployment.md#停机备份与新实例恢复)。

## 数据库迁移

表结构由`migrations/*.sql`定义，用`npm run db:migrate`作为独立部署步骤应用，服务启动不会自动建表。已有SQLite控制面用`npm run db:import -- <control.sqlite>`导入空目标；导入保留原ID、撤销状态和事件编号，拒绝非空目标与重复执行。完整切换、核对与回退边界见[迁移说明](migration.md)。

## 容器目录

| 路径 | 用途 |
| --- | --- |
| /workspace | 用户工作区，持久读写 |
| /platform/runtime | 镜像内程序与依赖，只读 |
| /platform/state | 原生状态，受信程序可写，项目工具受策略限制 |
| /platform/run | 任务、连接及心跳，只读挂载 |
| /etc/claude-code | 管理员配置，只读 |
| /tmp | 容器临时区；原生沙箱还可能提供独立临时视图 |

修改infra/managed-settings.base.json后运行npm run policy。生成器读取src/shared/paths.ts的保护根，生成原生文件工具和Bash沙箱规则。Runner不加载项目settings或任意MCP配置；策略意图不等于完整安全验收。

## 浏览器身份与本地数据

网页由同一个服务提供。浏览器使用`ah_browser` HttpOnly、SameSite=Strict Cookie，固定8小时有效；登录哈希持久化，服务重启后有效期内可继续登录。写接口要求同源Origin和X-Harbor-Client:web。X-Harbor-User用于拒绝另一标签页换账号后旧页面的请求，授权仍以Cookie中的服务端身份为准。CLI的Bearer接口保持兼容。

服务仍监听回环。配置AH_PUBLIC_ORIGIN=https://...后Cookie附加Secure，Origin校验使用固定公开地址，不能信任转发头。登录与管理员权限配置见[管理员与身份](identity.md)；HTTPS反代和真实供应商须独立验收。

localStorage只保存按用户分开的会话选择、草稿、待确认请求ID及原文，不保存任何访问密钥或网关凭证。退出登录清除当前用户的本地内容，不删除服务端记录。共享电脑上应退出登录；草稿仍属于敏感工作内容。

## V6身份数据与用户策略

PostgreSQL控制面包含users、external_identities、login_sessions、user_keys、usage_entries及usage_baselines表，旧SQLite会话和消息需通过导入脚本搬迁。业务Cookie和CLI密钥明文不落库，外部身份token不持久化。AH_ADMIN_USERS指定内部用户ID，AH_KEY_LOGIN=false关闭网页登录开发密钥；CLI Bearer仍保留。

默认用户额度为100会话/1任务/2环境/1GiB工作文件软额度，管理HTTP可在线修改个人策略。全局AH_CAPACITY不变。空间软检查不包括Claude状态/日志/数据库，不保证任务执行中磁盘不超额。费用仅为已观测SDK累计值的差额估算。
