# Agent Harbor

**为每个用户的 Agent 提供独立的会话与执行环境。**

MCP已简化为个人连接管理、原生HTTP直连与会话容器内srt执行，支持管理员模板和个人手写脚本，见[使用与边界](docs/mcp.md)。V8增加固定版本专家、角色说明与Skill绑定、个人技能管理、完整技能包导入/导出、保存即版本、卡片启停、Python/Node依赖安装和会话能力快照。网页使用React、Chakra UI和Vite重构网页工作台，保留统一身份登录、个人密钥、用户额度、文件工作区和独立会话服务：网页或CLI提交消息，服务持有会话，Docker容器内的Claude Code执行任务。用户关掉CLI，任务仍然继续；重新连接可以补看结果。

正常多轮共享同一个容器、Runner和Claude Code进程。含本地MCP的任务停止时会清理整个环境；其他任务优先使用原生中断；明确关闭环境、超时或异常时确认整个容器停止。原生Read / Write / Edit / Glob / Grep / Bash及工具循环继续由Claude SDK管理。

当前适用于受信本地开发：已实现开发访问密钥、会话归属、消息去重、事件补看、容量限制和空闲回收。网页支持文件上传/预览/下载、多行对话、历史恢复、工具记录、会话草稿和开发密钥登录；统一身份供应商需配置并独立验收；租户计费及生产多租户安全尚未完成。

应用创建首版已接入独立入口、持续对话与预览、Git版本、固定路径发布和独立运行容器，默认关闭。启用条件和验证边界见[应用创建指南](docs/applications.md)。

对话与应用支持直接删除，不设回收站或恢复；会停止任务并清理专属文件、容器及应用业务数据，账务和必要审计记录保留。入口、范围与失败重试见[删除说明](docs/deletion.md)。

启用应用创建后，受控迁移默认初始化应用运营观测，支持流量、业务转化、运行质量和版本分组，见[启用与边界](docs/application-observability.md)。

LiteLLM网关首版支持主流供应商预置与模型发现、管理员维护供应商成本、命名部署与不可变版本、用户选择与个人默认、输入框选择与同会话按轮切换模型、密钥轮换和独立受限凭据，默认关闭。见[模型与网关指南](docs/llm-gateway.md)。

人民币额度支持注册赠送、管理员授予Plus及月度赠送、指定/全员赠送和逐请求余额扣费。启用后需配置模型平台单价，已有用户需赠送额度，见[钱包与扣费](docs/wallet.md)。


模型与任务追踪可选接入Langfuse Cloud，完整配置自动启用、未配置关闭，见[配置与验证](docs/llm-observability.md)。

## 小团队部署与完整验收

推荐交付方式为固定服务发布包 + 宿主运行 + Compose PostgreSQL/LiteLLM，应用创建默认关闭。统一入口`npm run harbor -- --help`（先构建），提供显式实例配置、安装、初始化、doctor、免费验证、隔离任务验收、停机备份/空库恢复、服务配置生成及状态变化通知。见[部署与验收](docs/deployment.md)。真实模型必须显式`--live`并指定验收预算；普通安装与检查不产生模型费用。

以下为源码开发入口；其中历史镜像标签仅用于已有会话，不作为新部署推荐。新环境使用`infra/Dockerfile.release`统一构建镜像，并让AH_IMAGE/AH_SKILL_IMAGE匹配同一发行版。

## 源码开发快速开始

需要Node.js **24.19+**、npm 11+、Python 3、可用的本地Docker CLI/Engine，以及PostgreSQL **18**（17可用）。容器的原生沙箱还要求兼容的Linux内核与命名空间能力。

```sh
npm ci
cp .env.example .env
```

编辑`.env`，填写获准网关、模型凭证、`AH_IMAGE=agent-harbor:0.4.0`及`AH_DATABASE_URL`。服务建议使用独立数据根`AH_DATA_DIR=var/service-sessions`，不要直接认领旧V2数据。控制面表结构不随服务启动自动创建：

```sh
npm run build
npm run db:migrate
docker build -f infra/Dockerfile -t agent-harbor:0.4.0 .
docker build -f infra/Dockerfile.skills -t agent-harbor:0.6.0 .
# 本地MCP另见docs/mcp.md：基于0.6.1构建0.6.2原生MCP镜像
npm run access-key -- developer
```

已有SQLite控制面时，先停服务并做一致备份，再对空库执行`npm run db:import -- <control.sqlite>`；完整步骤与回退边界见[docs/migration.md](docs/migration.md)。

测试会创建并删除独立schema，需要一个可丢弃的数据库：

```sh
AH_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/agent_harbor_test npm test
```

最后一个命令只显示一次开发访问密钥；将它填入本机`.env`的`AH_SERVICE_TOKEN`。服务只保存哈希，该密钥与模型网关凭证不同。未配置OIDC时，密钥文件缺失会使服务拒绝启动。

在一个终端启动服务并保持运行：

```sh
npm run server
```

打开 **http://127.0.0.1:4318/**，输入生成的开发访问密钥，即可新建会话并连续对话。页面和接口由同一服务提供，无需单独启动前端服务。Cmd/Ctrl+Enter发送，普通Enter保留换行。

宿主包版本为0.9.0。新会话推荐0.6.0执行镜像；旧会话与镜像快照保留。旧会话沿用其固定镜像；新会话的技能与专家使用0.6.0镜像；本地MCP需要0.6.2镜像，需额外构建，见[技能使用与架构](docs/skills.md)。浏览器使用持久化的8小时HttpOnly Cookie，访问密钥不进入localStorage。退出登录不停止任务，会清除当前用户在本站保存的草稿；关闭页面则保留草稿。

CLI继续可用，在另一个终端创建会话并开始对话：

```sh
npm run cli -- init demo fix-project
# 使用上一步返回的会话UUID
npm run cli -- chat <session-id>
```

如果构建需要代理，可加`--build-arg BUILD_PROXY=http://host.docker.internal:7890`，使用你自己的地址。构建代理不会写入运行时连接配置。

## 常用命令

```sh
npm run cli -- list
npm run cli -- status <session-id>
npm run cli -- run <session-id> '解释项目结构'
npm run cli -- run <session-id> --file prompt.txt
npm run cli -- watch <session-id> 0
npm run cli -- cancel <session-id> <message-id>
npm run cli -- close <session-id>
```

- `chat`每行提交一轮；多行大段文字使用`run --file`，完整保留换行和缩进。
- `/exit`、EOF或终端断开只退出客户端，任务继续。
- 执行中Ctrl+C停止本客户端当前任务；正常原生中断后可以在同一环境继续。
- `/close`或`close`关闭整个工作环境，保留文件和对话。它也会停止后台进程。
- 同一会话忙时拒绝新任务，不隐式排队；不同会话可以并行。
- 本轮结束后空闲15分钟回收环境；查看事件不会延长时限。默认最多保留4份环境。
- 服务崩溃后，重启先清理旧容器，将未完成任务标为interrupted，不自动重放。服务升级暂不保证正在执行的任务继续。

不经服务的旧调试入口保留为`npm run cli:local -- ...`；它仍由CLI持有会话。调试必须使用另一数据根，不能与服务共管同一工作目录。

## 架构与目录

```text
网页 / CLI → HTTP命令 + SSE事件 → 独立会话服务
                                      ↓
                             Controller / Conversation
                                      ↓ Docker管道
                           Runner → Claude SDK / Code
```

```text
src/
├── service/       长期服务、身份、PostgreSQL控制面、HTTP/SSE、会话管理与重启协调
├── clients/
│   ├── cli/       服务CLI及显式本地调试入口
│   ├── web/       网页入口、状态、展示和安全Markdown；prototype保留设计稿
│   └── service-client.ts  共用HTTP/SSE客户端
├── runtime/       会话控制、文件状态、锁与Runner管道
├── docker/        Docker CLI驱动及容器状态确认
├── agent/         容器内Runner、Keeper、SDK权限配置与沙箱检查
└── shared/        执行数据类型、协议与容器路径
infra/             镜像、管理员策略与seccomp
examples/          示例工作项目
tests/            单元、HTTP、PostgreSQL迁移及实际Docker/SDK验证
docs/             架构、配置、生命周期与开发文档
var/               本地运行数据和证据，不进入Git
```

## 验证与安全边界

`npm test`和`npm run check`不调用模型。Docker验证使用本地确定性模型夹具，证明实际SDK、工具和生命周期行为，不证明模型自主完成用户任务。见[测试指南](docs/testing.md)。

Docker使用非root、只读根、cap-drop ALL、固定seccomp及原生管理员策略。当前为兼容原生沙箱使用`systempaths=unconfined`；路径保护取舍及未验安全范围见[安全说明](SECURITY.md)。本地服务默认仅监听127.0.0.1，不作为已完成生产隔离的公网服务。

## 文档

- [V7 React前端开发与设计](docs/react-web.md)
- [V6用户登录、额度、用量与配置](docs/users-and-limits.md)
- [V5文件工作区与代码阅读](docs/workspace-files.md)
- [V4网页使用与代码阅读](docs/web-client.md)
- [架构与代码入口](docs/architecture.md)
- [从一条消息阅读代码](docs/code-reading.md)
- [HTTP 路由与请求边界（Express 5）](docs/http-routing.md)
- [V3运行与HTTP接口](docs/service.md)
- [配置与数据目录](docs/configuration.md)
- [持续对话、中断与回收](docs/session-lifecycle.md)
- [独立服务设计及实现边界](docs/specs/service-managed-sessions.md)
- [独立管理后台](docs/admin.md)
- [测试指南](docs/testing.md)
- [路线图](docs/roadmap.md)、[迁移说明](docs/migration.md)、[贡献指南](CONTRIBUTING.md)
- [公开发布检查](docs/releasing.md)

## 许可证与依赖

自有源码采用[Apache-2.0](LICENSE)。Claude Agent SDK / Claude Code是外部依赖，受自身条款约束，不随本项目变为Apache开源软件；SDK、二进制、本地依赖和运行数据不纳入源码仓库。Moby seccomp配置的来源和许可见[NOTICE](NOTICE)。

部署前请核对[上游使用条款](https://code.claude.com/docs/en/legal-and-compliance)，包括凭证、结算和分发要求。本项目不代表Anthropic官方产品，不提供模型账号、共享账号或代付服务。

WorkBuddy专家包导入、完整Markdown、包内技能、MCP与OAuth使用见[专家模式](docs/workbuddy-experts.md)。新镜像使用`agent-harbor:0.5.4`，专家定义不会改变原有工具权限或个人Skill默认开关。

## 会话依赖环境

新会话镜像0.5.5提供Python、Node、uv/npm；专家与独立Skill共用用户级下载缓存和会话独立环境，重建容器后保留。原包格式不变，不要求新增依赖声明。详见[运行说明](docs/dependency-runtime.md)，执行`npm run verify:dependencies`验证真实包安装与离线复用（模型使用本地夹具）。
