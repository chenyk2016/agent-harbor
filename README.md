# Agent Harbor

Agent Harbor 是一个自托管的 Agent 工作台。你可以在浏览器或 CLI 里上传文件、交给 Claude Code 分析数据或修改项目，再从工作区取回结果。任务由 Harbor 服务管理，关闭页面后可以重新连接查看进度和产物。

适合个人开发和受信小团队。每个会话在独立 Docker 环境中执行。管理员提供获准的模型凭据，并控制团队成员可用的模型和额度。

## 快速开始

1. **安装并启动。** 准备 Node.js 24.19+、npm 11+、Python 3、Git、OpenSSL、Docker 和 Compose v2。构建服务与 Runner 镜像，执行 `harbor configure → install → init`，再启动宿主服务。首次初始化需要设置 `AH_BOOTSTRAP_ADMIN_KEY`。 [完整命令](docs/quickstart.md)
2. **登录并接入模型。** 打开 `http://127.0.0.1:4318/`，用管理员密钥登录，点击「接入模型」。配置供应商和模型后运行测试，检查原生工具和流式响应。连接实际供应商测试会产生模型请求。 [首次模型与任务教程](docs/first-task.md)
3. **完成第一个任务。** 上传教程里的 CSV，让 Agent 按类别汇总并生成文件，下载后核对结果。 [查看样例与预期输出](docs/first-task.md#提交并核对产物)

## 主要能力

| 使用场景 | Harbor 提供 |
| --- | --- |
| 处理文件或开发项目 | 持久工作区、连续对话、运行事件、任务中断与恢复、Skills、专家和 MCP 工具 |
| 为团队管理模型和账号 | 访问密钥、Better Auth 邮箱密码、模型接入向导、使用范围、内部额度、价格和用量 |
| 构建和发布 Web 应用 | 通过对话修改源码，独立预览与发布，版本回滚，可选访客登录和运营观测 |
| 管理自托管实例 | 配置诊断、停机备份、空实例恢复与升级验收 |

托管安装会准备 PostgreSQL、LiteLLM 和钱包的基础配置。工作台自助注册需要 HTTPS、邮箱密码登录和可用的托管钱包网关。应用创作需要另外配置创建者、应用数据库和 Caddy。各项功能的触发条件和关闭方式见 [配置参考](docs/configuration.md#功能何时启用)。

## 文档入口

- **使用工作台** · [第一个任务](docs/first-task.md) · [CLI](docs/cli.md) · [会话生命周期](docs/session-lifecycle.md) · [工作区](docs/workspace-files.md)
- **部署和管理** · [部署、备份与恢复](docs/deployment.md) · [管理员与身份](docs/identity.md) · [模型与网关](docs/llm-gateway.md) · [排障](docs/troubleshooting.md)
- **创建应用** · [应用创建与部署](docs/applications.md) · [访客登录](docs/application-login.md) · [运营观测](docs/application-observability.md)
- **参与开发** · [系统架构](docs/architecture.md) · [HTTP 与 SSE](docs/service.md) · [贡献指南](CONTRIBUTING.md) · [测试与验收](docs/testing.md) · [发布文档站](docs/pages-publishing.md)

[浏览完整文档目录](docs/index.md)

## 安全与许可证

服务默认监听回环地址。团队访问由运维配置 HTTPS 反向代理。陌生用户提交的任意代码需要更强的宿主和租户隔离。 [安全边界与漏洞报告](SECURITY.md)

Agent Harbor 自有源码采用 [Apache-2.0](LICENSE)。Claude Agent SDK、Claude Code 和模型服务适用各自的条款。部署者提供有权使用的模型凭据。 [第三方声明](NOTICE)
