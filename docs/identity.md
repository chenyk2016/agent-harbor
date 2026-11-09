---
layout: page
title: 账号与登录
---

工作台账号用于登录 Agent Harbor、使用自己的会话和文件；创建的应用有独立访客账号，见 [应用访客登录](application-login.md)。

## 选择登录方式

| 方式 | 适合谁 | 需要什么 |
| --- | --- | --- |
| 访问密钥 | 管理员首次登录、个人使用、CLI 和脚本 | 属于本实例用户的 Harbor 访问密钥 |
| 邮箱密码 | 团队成员日常登录 | 管理员配置固定访问地址和认证密钥 |
| OIDC 单点登录 | 已有统一身份系统的团队 | 管理员配置身份提供方和回调地址 |

模型供应商的 API Key 用于推理，不能作为工作台登录密钥。管理员权限由 `AH_ADMIN_USERS` 中的内部用户 ID 决定；注册账号或第一个登录都不会自动取得管理员权限。

## 管理员访问密钥

管理员密钥由环境变量 `AH_BOOTSTRAP_ADMIN_KEY` 提供，保存在服务实际加载的私有环境文件中：

| 启动方式 | 配置文件 |
| --- | --- |
| 按安装指南创建的实例 | 实例目录的 `harbor.env`，启动时通过 `--env-file` 加载 |
| 源码目录执行 `npm run server` | 项目根目录的 `.env` |

在对应文件中设置：

```dotenv
AH_ADMIN_USERS=operator
AH_BOOTSTRAP_ADMIN_KEY=replace-with-a-private-random-key-at-least-32-characters
```

`AH_ADMIN_USERS` 必须只有一个管理员内部 ID。密钥长度为 32 至 128 个字符，只允许 ASCII 字母、数字、下划线和短横线；可用 `openssl rand -hex 32` 生成。

首次安装先保存配置，再执行 [安装指南](quickstart.md#配置并初始化管理员) 的初始化命令。后续修改密钥只需更新同一个环境文件并重启服务，无需重新运行初始化命令。登录时使用环境文件中的当前值。

重启后旧密钥不能建立新登录，已有浏览器登录仍按原有效期处理。已在进程环境中导出的同名变量会优先于启动时的环境文件值，修改文件后应确认没有被外部设置覆盖。环境文件含密钥，不要提交到 Git。

## 启用邮箱密码

在实例私有 `harbor.env` 中设置：

```dotenv
AH_PUBLIC_ORIGIN=https://harbor.example.com
AH_WORKBENCH_AUTH_SECRET=replace-with-a-private-random-secret-at-least-32-characters
AH_WORKBENCH_REGISTRATION=false
```

将访问地址替换为团队实际使用的 HTTPS 地址，不带路径或末尾斜线。托管安装已生成认证密钥，可保留生成值。配置 HTTPS 的步骤见 [团队部署](deployment.md)。

管理员可以把邮箱密码绑定到初始化时创建的管理员账号。准备一个权限为 `0600` 的私有 JSON 文件，内容如下：

```json
{"email":"operator@example.com","password":"replace-with-a-private-password"}
```

在项目根目录执行，把 `operator` 和路径换成实际值：

```sh
node --env-file=/srv/harbor-instance/harbor.env \
  dist/src/service/identity/bind-workbench.js \
  operator /secure/workbench-credentials.json
```

完成后删除临时凭据文件，重启服务，通过 HTTPS 用邮箱密码登录，确认能够进入管理后台。

## 开放成员注册

邮箱登录、HTTPS 和托管钱包网关都就绪后，省略 `AH_WORKBENCH_REGISTRATION` 或设为 `true` 会开放自助注册。设为 `false` 并重启可关闭；已开通的账号仍能登录。

注册使用邮箱和密码，无需邮箱验证码，密码须为 12–128 个字符。邮箱自助注册当前固定赠送一次 **10 元**内部模型额度，暂不随后台「注册赠送」设置调整；将该设置改为 0 也不会关闭这笔赠送。需要停止新账号开通时，请关闭自助注册。其他赠送规则见 [额度与计费](wallet.md)。

## 配置 OIDC 单点登录

在身份提供方创建机密 Web 客户端，把回调地址设为：

```text
https://harbor.example.com/api/auth/oidc/callback
```

在私有环境文件中配置并重启：

```dotenv
AH_PUBLIC_ORIGIN=https://harbor.example.com
AH_OIDC_ISSUER=https://identity.example.com
AH_OIDC_CLIENT_ID=replace-with-client-id
AH_OIDC_CLIENT_SECRET=replace-with-private-client-secret
```

身份提供方须支持 `client_secret_post`、PKCE，以及可通过发现文档和 JWKS 校验的签名身份令牌。登录后确认工作台中的内部用户 ID，再按实际授权维护 `AH_ADMIN_USERS`。

## 个人密钥和共享电脑

成员在「设置 → 访问密钥」创建或撤销个人访问密钥。CLI 使用个人密钥，见 [命令行使用](cli.md)。设置 `AH_KEY_LOGIN=false` 只关闭网页登录密钥入口，CLI 仍可使用 Bearer 密钥；关闭前先确认其他网页登录方式正常。

浏览器会保存草稿和会话选择。共享电脑使用后应退出登录；退出会清理当前用户的浏览器本地内容，服务端会话和文件会保留。

[返回配置与管理](manage.md)
