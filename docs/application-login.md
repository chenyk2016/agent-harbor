# 应用访客登录

例如，你发布了报名应用，希望访客先登录才能填表。应用作者声明所需的登录方式，Harbor 负责登录页、回跳、应用会话及访客停用。应用作者的工作台账号和报名者的访客账号各自独立。

## 为应用启用登录

管理员先在实例启用 [应用创建](applications.md) 和访客认证。应用作者打开编辑器中的「应用登录」，或让 Agent 修改 `harbor-app.json`：

```json
{
  "auth": {
    "mode": "required",
    "providers": ["email_password", "google"]
  }
}
```

上面只展示 `auth` 片段，保留清单中其他配置。可以只选一种方式。公开应用可声明 `"auth": {"mode": "public"}`。新建应用省略策略时默认公开，已保护应用切回公开需确认。

预览构建成功后，从预览地址注册并验证回跳，再发布固定版本并在正式地址独立验证。应用编辑器「工作台 → 用户」按环境查看和管理访客。邮箱密码注册无需 SMTP，完成后即可进入应用。预览和正式隔离，同一邮箱可以使用不同密码。Google 与密码方式的同邮箱记录也不自动合并。停用会撤销所选环境的应用会话，恢复后需重新登录。

## 实例配置

配置保存在管理员私有环境，不能传给生成应用。上线前准备独立 HTTPS 认证域、应用通配 DNS 与证书，并让 Caddy 管理接口只对受信服务可达。

| 配置 | 含义 |
| --- | --- |
| `AH_APP_AUTH_ENABLED=0` | 关闭访客认证。省略时，所需配置就绪后自动启用 |
| `AH_APP_AUTH_ORIGIN`、`AH_APP_AUTH_DOMAIN` | 专用 HTTPS 认证来源及应用域后缀 |
| `AH_APP_PUBLIC_ORIGIN` | 应用模块使用的管理入口，与认证域和应用域区分 |
| `AH_APP_AUTH_EDGE_DIAL`、`AH_APP_AUTH_EDGE_TOKEN` | Caddy 到 Harbor 的内部地址与校验密钥 |
| `AH_APP_AUTH_SIGNING_KEY` | Base64 编码的 PKCS#8 DER Ed25519 私钥 |
| `AH_APP_AUTH_POCKETBASE`、`AH_APP_AUTH_POCKETBASE_TOKEN` | 私有 PocketBase 地址及管理凭据。当前兼容配置在启用访客认证时仍检查这两项 |
| `AH_APP_AUTH_BACKEND=better_auth`、`AH_APP_AUTH_BETTER_SECRET` | 新认证范围选用 Better Auth，并提供独立随机密钥（至少 32 字符）。省略后端时默认 PocketBase |
| `AH_APP_AUTH_WORKBENCH_ORIGIN` | 可选。用于登录后的工作台内嵌预览，必须是符合实例同站约束的独立 HTTPS 来源 |

兼容服务可使用经过隔离验证的 [PocketBase 0.41.1](https://pocketbase.io/docs/)。安装后绑定 Harbor 可访问的私有地址，持久化 `pb_data`，为 Harbor 配置专用超级用户令牌。备份包括控制库、访客认证私有配置和 PocketBase 数据。

保留一个 `harbor-application-routes` 子树，由 Harbor 管理应用主机对应的路由。平台管理反代只匹配管理域。固定认证域可合并以下 Caddy 片段。

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

Caddy 与 Harbor 必须使用相同的校验密钥。认证请求的表单、Cookie、查询参数及回跳凭据不得记入代理日志。修改配置后先执行控制库迁移，再重启并验证保护页面。配置缺失或未通过校验时，访客认证保持不可用，应用作者仍须为每个应用明确选择公开或要求登录。

## 可选 Google 登录

- Better Auth 的预览与正式使用不同的 Google Web OAuth 客户端。分别配置 `AH_APP_AUTH_BETTER_GOOGLE_PREVIEW_ID`、`AH_APP_AUTH_BETTER_GOOGLE_PREVIEW_SECRET` 及对应的 `PRODUCTION_ID`、`PRODUCTION_SECRET`。各客户端登记同一固定地址 `<AH_APP_AUTH_ORIGIN>/__harbor/visitor/better-auth/callback/google`，Harbor 按本次登录流程分流。
- PocketBase 兼容入口沿用 `AH_APP_AUTH_GOOGLE_ID`、`AH_APP_AUTH_GOOGLE_SECRET` 及 `<AH_APP_AUTH_ORIGIN>/__harbor/visitor/google/callback`。

真实 Google OAuth 需要在目标部署单独验证。使用专用测试账号验证授权、取消、回跳、退出和停用后，再开放正式应用。密码登录的浏览器验收和替身 OAuth 测试分别记录。

更改默认后端只影响新建认证范围，既有 PocketBase 账号和应用身份保持原映射。切换旧应用前应在隔离环境演练备份恢复、业务归属与停用状态。
