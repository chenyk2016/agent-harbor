# Agent Harbor

Agent Harbor 是一个自托管的 Claude Code 工作台，适合个人开发者和受信的小团队。你可以在浏览器或命令行交给 Agent 一份文件或代码项目，查看执行过程并下载产物。也可以通过对话创建 Web 应用，先预览，再发布到自己的服务器。

[快速开始](#快速开始) · [在线文档](https://chenyk2016.github.io/agent-harbor/)

## 产品功能

### 工作台 · 提交任务，取回结果

![工作台左侧是会话列表，中间是报名渠道汇总和工具记录，右侧是生成的 CSV 文件。](docs/assets/product/workbench.png)

图中 Agent 把 32 条报名记录按渠道汇总，生成的 CSV 可以从右侧下载。任务在服务端执行，关闭网页后可以重新连接，继续查看进度和产物。会话有独立工作区，可接入 Skills 和 MCP 工具。 [试做第一个任务](docs/first-task.md)

### 应用创建 · 边聊边改，预览后发布

![应用编辑页左侧是创建技术沙龙报名页的对话，右侧是可交互的表单，顶部有版本和发布入口。](docs/assets/product/application-preview.png)

图中左边对话用来修改报名页，右边可以直接试填表单。预览通过后可独立发布，也能回滚到旧版本。应用可按需开启访客登录和运营观测。 [了解应用创建与部署](docs/applications.md)

### 管理后台 · 管账号、模型和额度

![管理后台的用户页面，左侧是用户列表，右侧显示选中用户的余额、收支流水和额度操作。](docs/assets/product/admin-users.png)

图中管理员可以查看用户余额和流水、调整额度或停用账号。后台也能接入模型供应商，设置哪些成员能用哪些模型，并查看用量。 [了解管理后台](docs/admin.md)

## 快速开始

- **已有工作台账号**：登录团队工作台，选择模型，按 [第一个任务](docs/first-task.md) 上传示例文件，下载并核对结果。
- **自己部署**：按 [安装与启动](docs/quickstart.md) 准备环境并登录管理员，再 [接入模型](docs/llm-gateway.md)，完成第一个任务。
- **创建应用**：由管理员完成 [应用功能配置](docs/application-configuration.md)，再按 [创建、预览与发布](docs/applications.md) 从需求做到正式地址。

## 文档入口

| 你想了解 | 入口 |
| --- | --- |
| 产品功能、场景和适用范围 | [产品介绍](docs/product-overview.md) |
| 首次安装或首次使用 | [开始使用](docs/getting-started.md) |
| 对话、文件、技能、专家、MCP 和应用 | [使用指南](docs/guide.md) |
| 账号、模型、额度、部署与配置 | [配置与管理](docs/manage.md) |
| 核心概念和产品取舍 | [设计理念](docs/concepts.md) |
| 使用疑问和运行问题 | [常见问题](docs/faq.md) · [故障排查](docs/troubleshooting.md) |

[在线文档](https://chenyk2016.github.io/agent-harbor/) · [仓库内文档目录](docs/index.md)

参与开发请阅读 [贡献指南](CONTRIBUTING.md)、[系统架构](docs/architecture.md) 和 [测试说明](docs/testing.md)。文档维护方式见 [维护文档站](docs/pages-publishing.md)。

## 安全与许可证

服务默认监听回环地址。团队访问由运维配置 HTTPS 反向代理。陌生用户提交的任意代码需要更强的宿主和租户隔离。 [安全边界与漏洞报告](SECURITY.md)

Agent Harbor 自有源码采用 [Apache-2.0](LICENSE)。Claude Agent SDK、Claude Code 和模型服务适用各自的条款。部署者提供有权使用的模型凭据。 [第三方声明](NOTICE)
