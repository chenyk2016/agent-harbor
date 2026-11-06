# 配置与数据目录

复制.env.example为.env，npm命令通过Node的env-file选项加载。已导出的环境变量优先；直接node启动时自行加载.env。服务使用PostgreSQL保存控制面，要求Node24.19+与PostgreSQL 18（17可用）。

| 配置 | 默认值/用途 |
| --- | --- |
| AH_GATEWAY_URL | http://host.docker.internal:8080，容器可访问的获准网关 |
| AH_GATEWAY_TOKEN | 无有效默认值，仅服务或cli:local执行器需要 |
| AH_MODEL | claude-sonnet-4-6，以网关支持范围为准 |
| AH_IMAGE | agent-harbor:0.4.0 |
| AH_DATA_DIR | 服务默认var/service-sessions；cli:local默认var/sessions |
| AH_SERVICE_URL | CLI连接地址，默认http://127.0.0.1:4318 |
| AH_SERVICE_TOKEN | CLI开发访问密钥，与网关凭证独立 |
| AH_SERVICE_PORT | 服务本地监听端口，默认4318；始终绑定127.0.0.1 |
| AH_IDLE_TIMEOUT_MS | 服务任务结束后的空闲回收，默认900000 |
| AH_TASK_TIMEOUT_MS | 单轮总超时，默认120000；超时强制关闭环境 |
| AH_INTERRUPT_TIMEOUT_MS | 原生中断等待时限，默认5000；超时强制关闭 |
| AH_CAPACITY | 最多打开中的环境数，默认4，包含启动和空闲 |
| AH_EVIDENCE_DIR | 部分验证脚本的输出位置，默认var/evidence |
| AH_BOOTSTRAP_ADMIN_KEY | 管理员访问密钥。可放入服务读取的 .env 或 harbor.env，修改后重启生效；需在 AH_ADMIN_USERS 指定单个管理员 |
| AH_DATABASE_URL | 必填，控制面PostgreSQL连接串；服务不会在启动时自动建表 |
| AH_DATABASE_POOL_MAX | 连接池上限，默认10，范围1–100 |
| AH_TEST_DATABASE_URL | 仅测试使用，指向可丢弃的数据库；测试会创建并删除独立schema |

执行配置只由受信服务部署者提供，不透传浏览器输入。SDK预算在同一次query跨消息累计，不是租户硬配额；模型网关密钥和计费配置见[模型与网关](llm-gateway.md)与[额度与计费](wallet.md)。旧开发密钥文件在启动时导入PostgreSQL；V6本人密钥接口创建/撤销即时生效。

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
