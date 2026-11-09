---
layout: page
title: 应用功能配置
---

这一页面向管理员，说明如何开通应用创建、访客登录、应用观测和只读问数。应用作者的操作见 [创建、预览与发布](applications.md)。

## 开通应用创建

需要可用模型、运行中的 Docker、独立的应用 PostgreSQL 数据库，以及用于管理应用访问地址的 Caddy 网关。

1. 准备应用专用 PostgreSQL 管理账号。Harbor 用它创建测试和正式数据库；不要使用工作台控制库的账号。
2. 为 Caddy 添加 ID 为 `harbor-application-routes` 的应用路由分区，放在工作台反向代理之前。可参考仓库的 [本地 HTTP 配置示例](https://github.com/chenyk2016/agent-harbor/blob/main/infra/app-edge.example.json)。已有网关应合并这一分区，保留自己的站点配置。
3. 在实例私有的 `harbor.env` 中填写下列配置。创建者名单使用 Harbor 内部用户 ID，多个 ID 以逗号分隔。

```dotenv
AH_APP_PUBLIC_ORIGIN=http://127.0.0.1:8080
AH_APP_CADDY_ADMIN=http://127.0.0.1:2019
AH_APP_CREATOR_IDS=operator
AH_APP_DATABASE_ADMIN_URL=postgres://app_admin:replace-me@127.0.0.1:5432/postgres
AH_APP_DATABASE_HOST=host.docker.internal
```

`AH_APP_CREATOR_IDS` 中的 `operator` 沿用安装指南初始化的管理员 ID，请替换或补充为实际获准创作的用户 ID。`AH_APP_PUBLIC_ORIGIN` 是经过 Caddy 的工作台与应用入口。团队部署使用实际 HTTPS 来源，并将 `AH_PUBLIC_ORIGIN` 设为实际工作台来源，以便右侧预览正常嵌入。

4. 准备默认应用基础镜像：

```sh
docker pull node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
```

也可以通过 `AH_APP_NODE_BASE` 指定经过检查的固定镜像。它需要已经存在于运行 Harbor 的 Docker 引擎中。

5. 保持 Harbor 服务停止，在源码根目录用实例配置初始化所需数据结构，再按 [安装指南](quickstart.md#启动并登录) 启动：

```sh
node --env-file="$HARBOR_DIR/harbor.env" dist/src/service/db/migrate.js
```

`HARBOR_DIR` 沿用安装时的实例目录。配置、数据库和网关就绪后，应用功能自动开启。用名单中的账号创建一个小应用，检查预览、测试数据与正式地址。

### 网络与存储

- `AH_APP_EDGE_UPSTREAM_HOST`：Caddy 在容器中、应用端口在宿主机时使用 `host.docker.internal`；默认 `127.0.0.1`。

- `AH_APP_DATABASE_HOST`：应用容器访问数据库时使用的主机名，端口沿用数据库连接串。

- `AH_APP_BUILD_PROXY`：应用构建需要下载代理时设置，仅供构建过程使用。

- `AH_APP_DATA_DIR`：指定应用源码、构建与私有配置的持久目录；默认位于 `AH_DATA_DIR/.applications`。

- `AH_APPLICATIONS_ENABLED=0`：显式关闭应用功能。

数据库、Caddy 管理接口及私有配置不应对公网开放。应用备份必须同时覆盖业务数据库与应用目录，见 [团队部署与备份](deployment.md)。

## 访客登录

应用访客与工作台成员分别管理。先准备独立 HTTPS 认证域、应用通配域名及证书，再选择所需认证方式。

- `AH_APP_AUTH_ORIGIN`：独立认证来源，例如 `https://auth.example.com`。

- `AH_APP_AUTH_DOMAIN`：应用域后缀，例如 `apps.example.net`，配置通配 DNS 和 HTTPS。

- `AH_APP_AUTH_EDGE_DIAL`：Caddy 访问 Harbor 的内部地址，例如 `127.0.0.1:4318`。

- `AH_APP_AUTH_EDGE_TOKEN`：Harbor 与 Caddy 共用的随机校验密钥，至少 32 字符。

- `AH_APP_AUTH_SIGNING_KEY`：Base64 编码的 PKCS#8 DER Ed25519 私钥。

- `AH_APP_AUTH_POCKETBASE`：私有 PocketBase 地址，例如 `http://127.0.0.1:8090`。

- `AH_APP_AUTH_POCKETBASE_TOKEN`：PocketBase 专用管理员凭据。

认证域与工作台管理域不能位于应用通配域内。PocketBase 应持久化 `pb_data`，并只向受信服务开放。

默认账号服务为 PocketBase。可选设置 `AH_APP_AUTH_BACKEND=better_auth`，并设置至少 32 字符的 `AH_APP_AUTH_BETTER_SECRET`，将账号保存在 Harbor 数据库中。当前启用检查仍要求填写上述 PocketBase 地址和凭据，选择 Better Auth 时也需要准备这些配置。

私钥可在私有终端生成后保存进配置，不应提交到 Git：

```sh
openssl genpkey -algorithm ED25519 -outform DER | openssl base64 -A
```

在认证域的 Caddy 配置中代理认证路径，并携带相同校验密钥：

```caddyfile
auth.example.com {
    handle /__harbor/visitor/* {
        log_skip
        reverse_proxy {$AH_APP_AUTH_EDGE_DIAL} {
            header_up X-Harbor-Edge-Proof {$AH_APP_AUTH_EDGE_TOKEN}
            header_up X-Harbor-Auth-IP {remote_host}
            header_up -X-Harbor-Visitor-Write
        }
    }
    handle {
        respond 404
    }
}
```

这些环境变量也必须提供给 Caddy。代理日志不要记录登录表单、Cookie 和回跳参数。完成配置后初始化数据结构并重启 Harbor，再由应用作者选择 [登录策略](application-login.md)，独立检查测试与正式地址的注册、回跳、退出和停用。

### Google 登录

根据所选账号服务配置 Google Web OAuth 客户端：

**PocketBase**

凭据配置：`AH_APP_AUTH_GOOGLE_ID`、`AH_APP_AUTH_GOOGLE_SECRET`。

回调路径，拼接在认证来源后：`/__harbor/visitor/google/callback`。

**Better Auth**

测试与正式使用不同的客户端，分别填写：

```dotenv
AH_APP_AUTH_BETTER_GOOGLE_PREVIEW_ID=replace-with-preview-client-id
AH_APP_AUTH_BETTER_GOOGLE_PREVIEW_SECRET=replace-with-preview-secret
AH_APP_AUTH_BETTER_GOOGLE_PRODUCTION_ID=replace-with-production-client-id
AH_APP_AUTH_BETTER_GOOGLE_PRODUCTION_SECRET=replace-with-production-secret
```

回调路径，拼接在认证来源后：`/__harbor/visitor/better-auth/callback/google`。

配置后用实际 Google 账号检查授权、取消和回跳。只配置邮箱密码时，不需要 Google 凭据。

### 工作台内嵌测试登录

需要在右侧完成邮箱测试登录时，配置：

- `AH_APP_AUTH_WORKBENCH_ORIGIN`：同站、独立的 HTTPS 工作台来源。
- `AH_APP_AUTH_EMBEDDED_ORIGIN`：另一个同站 HTTPS 来源，仅承接测试邮箱登录。

例如工作台为 `https://studio.example.net`、应用域为 `apps.example.net`，内嵌认证可用 `https://preview-auth.example.net`。为内嵌认证域配置相同校验头，只代理下面三个路径，其他路径返回 404：

```text
/__harbor/visitor/login
/__harbor/visitor/password
/__harbor/visitor/register
```

普通认证域继续承接独立登录和 Google 回调。

设置 `AH_APP_AUTH_ENABLED=0` 可关闭访客认证；要求登录的应用不会因配置缺失而自动变成公开应用。

## 应用观测

初始化应用数据结构时，默认准备独立观测数据库。也可用 `AH_OBSERVATION_DATABASE_URL` 指定自备库；在相同实例配置下单独初始化：

```sh
node --env-file="$HARBOR_DIR/harbor.env" dist/src/service/observability/migrate.js
```

托管观测库的采集端口默认 **4324**。使用自备库时显式设置 `AH_OBSERVATION_PORT=4324`，避免与默认模型网关端口冲突。默认监听回环地址，应用使用 `http://host.docker.internal:4324` 访问。Docker 网络不同的部署需按实际情况配置 `AH_OBSERVATION_BIND_HOST` 和 `AH_OBSERVATION_COLLECTOR_URL`，并限制采集端仅对应用网络可达。

重启后构建并发布应用，实际访问并完成一次业务，在目标环境检查事件和报表。设置 `AH_OBSERVATION_ENABLED=0` 可关闭观测。

需要采集网关日志时，按仓库 [脱敏日志示例](https://github.com/chenyk2016/agent-harbor/blob/main/infra/app-observation.Caddyfile) 配置，在 Caddy 写入磁盘前删除请求 URI、IP 和请求头等敏感字段，再用 `AH_OBSERVATION_EDGE_LOG` 指向日志文件。

## 只读问数的字段授权

应用、观测和托管钱包网关就绪后，问数自动开启。设置 `AH_APP_ANALYSIS_ENABLED=0` 可单独关闭。

默认只向模型开放业务记录 ID 和系统时间字段。需要分析业务字段时，管理员按应用 ID、环境和表名授权，例如：

```dotenv
AH_APP_ANALYSIS_TABLE_FIELDS={"00000000-0000-4000-8000-000000000001":{"preview":{"signups":["status"]}}}
```

将示例 ID 换成实际应用 ID；`preview` 表示测试，`production` 表示正式。只开放问题所需字段，修改后重启服务。应用作者的使用方法见 [应用数据与分析](application-observability.md)。

[返回配置与管理](manage.md)
