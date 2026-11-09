---
layout: page
title: 配置参考
---

Harbor 的部署配置保存在私有环境文件中；模型、成员和价格等日常设置在管理后台完成。

## 修改哪里，什么时候生效

按 [安装指南](quickstart.md) 创建的实例使用 `<实例目录>/harbor.env`：

```sh
node --env-file=/absolute/instance/harbor.env dist/src/service/server.js
```

源码手工部署可复制 `.env.example` 为 `.env`，由 `npm run server` 加载。已在进程环境中导出的同名变量优先于文件值。修改环境文件后重启服务；需要同时交给网关的设置，还须按相应功能说明重新创建网关容器。

环境文件包含数据库密码和密钥，应限制访问并随实例备份，不加入版本库。

## 基础配置

托管 `configure` 会生成下列实例配置，一般无需逐项手填。

- `AH_DATABASE_URL`

  必需，工作台 PostgreSQL 连接串；托管安装准备数据库与表结构

- `AH_DATA_DIR`

  文件和会话数据目录；托管实例为其 `data/`，源码默认 `var/service-sessions`

- `AH_IMAGE`

  执行任务的固定镜像，由 `configure --image` 指定

- `AH_SKILL_IMAGE`

  准备技能依赖使用的镜像，托管安装与任务镜像一致

- `AH_SERVICE_PORT`

  工作台回环监听端口，默认 `4318`

- `AH_PUBLIC_ORIGIN`

  浏览器实际访问来源，例如 `https://harbor.example.com`，无末尾斜线

- `AH_ADMIN_USERS`

  管理员内部用户 ID，以逗号分隔；初始化命令写入首个管理员

- `AH_BOOTSTRAP_ADMIN_KEY`

  首次初始化必需；服务启动时也可用来管理单个管理员的访问密钥

新建实例时，端口可通过 `configure` 的 `--port`、`--db-port`、`--gateway-port`、`--gateway-db-port` 设置。默认分别为 `4318`、`55432`、`4320`、`55433`；Linux 另用工作台端口减 1 作为内部推理入口。已有实例不能重新 `configure`。

## 功能何时启用

功能满足前置条件后启用；明确关闭的设置优先。缺少可选功能配置时，可通过 `harbor doctor` 查看提示。

- **模型网关**

  启用条件：管理地址、推理地址、管理密钥齐全且可用。

  关闭方式：`AH_LLM_ENABLED=false`。

- **内部额度计费**

  启用条件：托管模型网关和可达的计费入口。

  关闭方式：`AH_WALLET_ENABLED=false`。

- **工作台邮箱登录**

  启用条件：固定访问来源、至少 32 字符认证密钥、可用认证表。

  关闭方式：移除认证密钥前先确认其他登录方式可用。

- **成员自助注册**

  启用条件：邮箱登录、HTTPS 和托管钱包网关就绪。

  关闭方式：`AH_WORKBENCH_REGISTRATION=false`。

- **应用创建**

  启用条件：创建者名单、应用访问来源、应用数据库和 Caddy 已配置并可用。

  关闭方式：`AH_APPLICATIONS_ENABLED=0`。

- **应用访客登录**

  启用条件：应用创建和认证配置就绪，每个应用选择登录策略。

  关闭方式：`AH_APP_AUTH_ENABLED=0`。

- **应用观测**

  启用条件：应用功能和观测库就绪。

  关闭方式：`AH_OBSERVATION_ENABLED=0`。

- **应用只读问数**

  启用条件：应用观测和托管钱包网关可用。

  关闭方式：`AH_APP_ANALYSIS_ENABLED=0`。

- **Langfuse 观测**

  启用条件：地址、公钥和密钥三项齐全。

  关闭方式：清空三项并重启相关服务。

具体配置见 [账号与登录](identity.md)、[应用创建](applications.md)、[应用访客登录](application-login.md)、[应用运营分析](application-observability.md) 和 [模型与任务观测](llm-observability.md)。

## 模型网关和计费

按安装指南创建的实例已生成网关配置。供应商 API Key 在 [模型接入向导](llm-gateway.md) 中填写。

- `AH_LITELLM_MANAGEMENT_URL`

  Harbor 宿主可访问的网关管理地址

- `AH_LITELLM_INFERENCE_URL`

  任务容器可访问的网关推理地址

- `AH_LITELLM_MASTER_KEY`

  网关管理密钥，须与网关一致

- `AH_LITELLM_SALT_KEY`

  网关保存凭据使用的加密密钥，长期保留并备份

- `AH_LITELLM_DATABASE_URL`

  网关专用数据库连接串

- `AH_WALLET_INFERENCE_URL`

  任务容器可访问的 Harbor 计费入口，以 `/inference` 结尾

- `AH_LLM_DEFAULT_DEPLOYMENT_ID`

  可选，工作台默认模型 ID

- `AH_LLM_POLICY_FILE`

  可选，管理员维护的网关速率、供应商成本与请求超时策略文件

- `AH_LLM_SESSION_BUDGET_USD`

  可选，新执行环境调用凭据的美元预算；重建凭据时重新计算，不是用户累计额度

宿主与容器访问同一服务时可能需要不同地址：`127.0.0.1` 指向当前机器或容器自身，任务容器访问宿主通常使用 `host.docker.internal`。托管安装会按运行环境准备入口，不要直接把宿主回环地址复制给容器。

已经配置托管网关的实例在配置缺项或不可用时会阻止模型任务，避免绕开额度控制。关闭钱包会停止 Harbor 扣费；供应商调用仍可能产生费用。

## 登录配置

- `AH_WORKBENCH_AUTH_SECRET`

  邮箱密码登录的私有认证密钥，至少 32 字符

- `AH_WORKBENCH_REGISTRATION`

  `false` 关闭成员注册；省略时按前置条件自动启用

- `AH_KEY_LOGIN`

  默认 `true`；`false` 只关闭网页登录密钥入口

- `AH_OIDC_ISSUER`

  `AH_OIDC_CLIENT_ID`

  `AH_OIDC_CLIENT_SECRET`

  按需接入统一身份系统

- `AH_SERVICE_URL`

  `AH_SERVICE_TOKEN`

  CLI 使用的服务地址和个人访问密钥，与供应商凭据分开

操作步骤与回调地址见 [账号与登录](identity.md)。

## 任务资源和执行环境

- `AH_CAPACITY`

  `4`，同时打开的执行环境上限，包含启动中和空闲环境

- `AH_IDLE_TIMEOUT_MS`

  `900000`，任务结束后空闲 15 分钟回收环境

- `AH_TASK_TIMEOUT_MS`

  `0`，不设单轮总时限；正数表示毫秒，超时关闭执行环境

- `AH_MAX_TURNS`

  `0`，不设平台 Agent 轮数上限

- `AH_MAX_BUDGET_USD`

  `0`，不设 SDK 估算费用上限；内部钱包单独生效

- `AH_INTERRUPT_TIMEOUT_MS`

  `5000`，等待停止操作的毫秒数，超时强制关闭环境

- `AH_RESIDENT_BACKEND`

  默认 `docker`，也可选单机 Linux 的 `opensandbox`

- `AH_OPENSANDBOX_RUNNER_ORIGIN`

  `AH_OPENSANDBOX_RUNNER_KEY`

  选用 OpenSandbox 时的本机管理服务地址与私有密钥

- `AH_APP_RUNTIME_BACKEND`

  应用运行后端，默认 `docker`，按需设为 `opensandbox`

OpenSandbox 需要另外部署同主机管理服务，服务进程以 Linux UID 1000 运行。任务和应用后端分别配置；不要只改一个开关就认为所有用途都已启用。完整部署步骤见 [OpenSandbox 部署说明](https://github.com/chenyk2016/agent-harbor/blob/main/infra/opensandbox/README.md)。

用户自己的会话数、并行任务、保留环境和工作文件额度在 [管理后台](admin.md) 设置。全局环境容量与个人额度共同生效。

## 数据保存在什么地方

- 实例目录的 `harbor.env`

  私有部署配置

- `AH_DATA_DIR`

  会话工作文件、原生会话状态、技能和应用相关文件

- 工作台 PostgreSQL

  账号、会话历史、模型配置、内部额度和管理记录

- 网关 PostgreSQL

  网关配置和用量

- 应用与观测数据库

  启用相关功能后使用的独立业务记录和运营数据

保留整个数据目录，避免按内部文件名手工清理。释放空间使用产品提供的 [删除操作](deletion.md)，备份范围见 [团队部署与备份](deployment.md)。

[返回配置与管理](manage.md)
