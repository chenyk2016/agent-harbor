# Agent Harbor

**为每个用户的 Agent 提供独立的会话与执行环境。**

通过网页或 CLI 提交任务，由长期运行的 Harbor 服务管理会话。Claude Code 在独立 Docker 容器中读写工作区，任务进度与结果可以重连补看。用户可为会话配置技能、专家及 MCP 工具。

当前适用于本地开发和受信小团队。工作台支持访问密钥及可选的 Better Auth 邮箱密码登录。管理员可以开通模型、分配额度和查看用量。

应用创建首版已接入独立入口、持续对话与预览、Git版本、固定路径发布和独立运行容器，配置和依赖就绪后自动启用。启用条件和验证边界见[应用创建指南](docs/applications.md)。

对话与应用支持直接删除，不设回收站或恢复；会停止任务并清理专属文件、容器及应用业务数据，账务和必要审计记录保留。入口、范围与失败重试见[删除说明](docs/deletion.md)。

启用应用创建后，受控迁移默认初始化应用运营观测，支持流量、业务转化、运行质量和版本分组，见[启用与边界](docs/application-observability.md)。

LiteLLM网关首版支持主流供应商预置与模型发现、管理员维护供应商成本、命名部署与不可变版本、用户选择与个人默认、输入框选择与同会话按轮切换模型、密钥轮换和独立受限凭据，网关配置齐全后自动启用。见[模型与网关指南](docs/llm-gateway.md)。

人民币额度支持注册赠送、管理员授予Plus及月度赠送、指定/全员赠送和逐请求余额扣费。启用后需配置模型平台单价，已有用户需赠送额度，见[钱包与扣费](docs/wallet.md)。


模型与任务追踪可选接入Langfuse Cloud，完整配置自动启用、未配置关闭，见[配置与验证](docs/llm-observability.md)。

## 安装与使用

1. [本地安装与启动](docs/quickstart.md)涵盖环境准备、Docker 运行镜像、依赖迁移、首次管理员密钥及启动检查。
2. [第一个 Agent 任务](docs/first-task.md)涵盖开通模型、上传 CSV、提交任务及下载校验。
3. [托管部署与恢复](docs/deployment.md)涵盖专用服务器、HTTPS、团队账号、验收、停机备份、空库恢复和升级。

命令行用法见 [CLI 指南](docs/cli.md)。开发者从 [贡献指南](CONTRIBUTING.md) 开始。文档站的完整索引见 [文档首页](docs/index.md)，站点维护者见 [GitHub Pages 构建与发布](docs/pages-publishing.md)。

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

WorkBuddy专家包导入、完整Markdown、包内技能、MCP与OAuth使用见[专家模式](docs/workbuddy-experts.md)。专家定义不会改变原有工具权限或个人 Skill 默认开关。

## 会话依赖环境

统一运行镜像提供 Python、Node、uv/npm；专家与独立Skill共用用户级下载缓存和会话独立环境，重建容器后保留。原包格式不变，不要求新增依赖声明。详见[运行说明](docs/dependency-runtime.md)，执行`npm run verify:dependencies`验证真实包安装与离线复用（模型使用本地夹具）。
