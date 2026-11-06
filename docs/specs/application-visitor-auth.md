# 应用访客登录技术方案

本文记录首版 PocketBase 方案。当前启用条件和两种后端的部署配置见[应用访客登录](../application-login.md)。新应用的目标方案见 [Better Auth 改造规格](application-visitor-better-auth.md)。

2026-11-05，实现默认关闭。Harbor 使用一个私有 PocketBase 实例管理访客账号，在现有 Node 服务内增加应用认证模块。邮箱作为密码账号的登录标识。每个应用的预览和正式环境拥有各自的会话、用户管理入口，以及按登录方式隔离的账号集合。每个测试或正式安装环境使用一套 Google Web OAuth 客户端和一个固定回调。

## 首版产品行为

应用版本通过 `harbor-app.json` 声明访客登录。新应用省略 `auth` 时默认公开。设为 `{"mode":"required","providers":["email_password","google"]}` 可用两种方式，只列一种时只允许该方式。设为 `{"mode":"public"}` 可开放应用，已受保护的入口需要在构建预览或发布时由所有者确认。旧版本省略 `auth` 时保留入口既有保护，回滚也保留当前生效的保护。内置 Skill 负责修改源码声明，Harbor 校验配置并托管登录页。启用登录的应用使用独立 HTTPS 主机名，用户打开应用后可以进入平台托管的注册和登录页。注册时提交邮箱和密码，成功后直接登录。Google OAuth 首次进入该应用时创建 Google 账号，即使邮箱相同也独立于邮箱密码账号。首版提供退出、当前用户查询、受保护的业务 API，以及工作台中的用户列表、停用与恢复。邮箱密码注册暂不提供邮件找回。

例如报名应用与库存应用均接受 `chen@example.com` 注册。它们各自保存账号记录，可以使用不同密码。用同一个 Google 账号分别登录两个应用，也会建立两条应用内身份。发布新代码和线上镜像回滚沿用原应用环境的账号。

## 组件与数据归属

| 位置 | 职责 |
| --- | --- |
| PocketBase 私有服务 | 每个 `(appId, environment)` 按使用的方式建立独立 Auth 集合。管理密码哈希、Google 身份及账号记录。通过现有 REST 接口接入，固定发行版本并保留持久卷。 |
| Harbor 应用认证模块 | 托管登录页，确定应用归属，处理 OAuth 交接，签发和撤销应用会话，校验工作台管理权限。 |
| Harbor 控制数据库 | 保存登录开关、应用与 PocketBase 集合的映射、登录握手、会话及停用状态。 |
| Caddy | 将平台认证路径转给 Harbor。将校验通过的业务请求转给应用容器。 |
| 固定应用 Runtime | 验证平台提供的当前请求身份，并在业务路由入口执行登录要求。生成页面通过统一接口查询当前用户。 |

迁移 `0019_application_visitor_auth.sql` 增加四类记录。

| 记录 | 关键字段与约束 |
| --- | --- |
| `app_auth_scopes` | `appId`、`environment`、`collectionId`、`origin`、期望的登录模式。生效状态取自当前部署描述。应用与环境唯一，各方式的集合及来源独立唯一。创建集合使用确定性名称，遇到超时重查并校验归属，支持安全重试。 |
| `app_auth_users` | `scopeId`、`collectionId`、`pocketbaseRecordId`、`disabledAt`。按范围和集合识别账号，保留已绑定的历史身份。Harbor 用这个映射管理停用与会话，凭据及邮箱来源由 PocketBase 管理。 |
| `app_auth_sessions` | 随机会话凭据的哈希、`scopeId`、用户引用、`expiresAt`。初值 8 小时，可按实测调整。停用用户与删除其会话在同一数据库事务完成。 |
| `app_auth_flows` | 登录流程、一次性 `state` 和交接码的哈希、应用环境、来源、返回路径、浏览器绑定、PKCE verifier 与过期时间。按阶段原子消费，短期保存并定期清理。 |

集合由平台创建。应用所有者通过 Harbor 管理用户，所有者身份取自现有管理会话，服务端校验应用归属。PocketBase 管理凭据、Google 凭据及密码哈希留在可信服务边界内。PocketBase REST 与管理界面仅允许可信网络访问，管理员请求和访客登录请求分别使用独立客户端，避免复用 SDK 登录状态。业务表和现有管理端登录继续走各自原有存储。

## 路由与最小接口

独立主机名使用 `<appId>-prod.apps.example.net` 和 `<appId>-preview.apps.example.net` 一类地址，管理后台使用独立站点。保留现有 `/apps/<appId>/` 和 `/preview/<appId>/` 路径前缀，沿用构建时的 `BASE_URL` 和 Runtime 挂载方式。认证服务使用固定平台域名。域名仅为设计示例，实际值由部署配置提供。

| 接口 | 调用方及作用 |
| --- | --- |
| `GET <base>/__harbor/auth/start` | 应用页面发起登录，平台设置短期浏览器握手 Cookie，再跳转到托管登录页。 |
| `GET <base>/__harbor/auth/finish` | 原应用域名兑换一次性交接码，签发应用会话并跳回原页面。 |
| `GET <base>/__harbor/auth/me` | 应用获取当前用户的应用内 ID 及允许展示的资料。无会话返回 `401`。 |
| `POST <base>/__harbor/auth/logout` | 校验请求来源，撤销本应用会话并清理 Cookie。 |
| `GET /api/applications/:id/auth/:env/users` | 应用所有者分页查看用户，包括邮箱、登录来源和停用状态。 |
| `PATCH /api/applications/:id/auth/:env/users/:userId` | 应用所有者停用或恢复本范围内用户，写入管理审计。 |

托管页处理注册、密码登录和 Google 启动。Google 固定回调示例为 `https://auth.example.com/__harbor/visitor/google/callback`。普通登录只接受同一应用前缀内的返回路径。工作台发起的预览登录使用平台预先配置的固定工作台地址。认证路由由 Caddy 优先交给平台处理。业务容器入口保留现有浏览器凭据清理规则。工作台没有配置嵌入式预览时，可以在独立标签页打开。

应用域的握手 Cookie 用于核对 `finish`，认证域在托管页为同一流程建立自己的短期 Cookie，用于核对 Google 回调。注册、密码登录和发起 Google 的表单检查认证域的请求来源及流程令牌。

## 工作台内体验受保护预览

可选配置 `AH_APP_AUTH_WORKBENCH_ORIGIN=https://studio.example.net`。工作台、预览用同站点下的独立 HTTPS 域名，例如 `studio.example.net` 与 `<appId>-preview.apps.example.net`。在 TLS 网关按工作台的精确 Host 代理管理服务，工作台与应用各使用 host-only Cookie。嵌入式预览仅向配置中的工作台开放，修改工作台来源后重新部署受影响的预览。新配置需重新构建既有预览一次。

打开该工作台的预览时，Harbor 只向这一个工作台来源回报当前测试会话是否有效。配置同站的 `AH_APP_AUTH_EMBEDDED_ORIGIN` 后，开启邮箱方式的受保护预览可在右侧使用托管邮箱表单。登录流程绑定测试应用，只有固定工作台能嵌入该表单。预览域兑换交接码并建立会话后，工作台确认会话再切换预览。Google 和普通登录使用独立认证流程。正式环境继续使用自己的账号及会话。已有管理服务使用 OIDC 时，应将工作台来源配置成管理登录的公开来源，并同步设置该身份系统的管理登录回调。

## 注册与登录

1. **邮箱密码注册。** Harbor 在密码集合内创建账号，PocketBase 存储密码哈希。注册成功后使用一次性交接直接登录。该流程无 SMTP 依赖，验证状态留在服务端。
2. **密码登录。** Harbor 将邮箱和密码提交给密码认证接口，确认记录属于本应用的密码集合且用户可用，然后生成一次性交接码。已验证的旧密码账号仍可登录原身份。注册和登录按应用、来源地址及账号限流，日志只记录结果类别。
3. **Google 登录。** Harbor 从所选集合取得 Google 授权 URL、`state` 和 PKCE verifier，将它们与服务端的应用握手记录绑定。Google 回调校验浏览器绑定、期限与 `state`，原子消费本次请求。Harbor 使用握手中的 `collectionId` 和 verifier 调用该集合的 `auth-with-oauth2`，并使用与授权请求相同的回调地址。每个集合复用同一 Google 凭据。Google Client Secret 通过可信配置下发给 PocketBase。正式与测试各使用各自的 Google 项目。
4. **完成会话。** 固定认证域跳回原应用的 `finish`，交接码仅允许在原应用来源和发起浏览器内兑换一次。会话 Cookie 使用 `__Host-` 前缀及 `Path=/; Secure; HttpOnly; SameSite=Lax`，作用域是当前应用主机。认证页与回调设置 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。转发日志清理 URL 中的授权码、交接码。

邮箱密码和 Google 分别使用自己的集合，同邮箱的新账号不会自动合并。升级时保留已有账号编号与会话。历史 Google 账号只按已有的 Google 账号 ID 关联回原身份，历史邮箱密码仍可登录原账号。旧注册邮件的确认入口已退役，尚未完成注册的访客可使用新页面注册。

## 保护业务请求

首版采用一个清晰的策略。登录模式下，应用页面壳和静态资源可访问，整个 `/api/*` 要求会话，前端遇到 `401` 引导登录。认证和部署健康路径由固定规则处理。未开启登录的应用沿用现有公开接口规则。首版保留 `publicRead` 和 `publicCreate` 对通用数据 API 的原有校验，增加一层应用范围内的登录校验。个人数据的行级授权由业务服务端按可信用户 ID 执行，工作台的用户管理与业务表访问分别鉴权。

1. Caddy 清理外部提交的身份头，根据已登记路由把应用环境和部署身份交给 Harbor 的私有认证检查入口。Harbor 校验 Cookie 哈希、应用环境、会话期限、账号状态和写请求来源。Caddy 可用现有 JSON 配置表达与 `forward_auth` 等价的预检查。 [Caddy 预检查](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
2. 校验成功后，Harbor 用平台私钥签发短时身份断言，包含 `appId`、`environment`、`deploymentId`、应用内用户 ID 和到期时间。Caddy 在清理外部凭据后只注入本次预检查返回的断言，再将请求传给 Runtime。浏览器 Cookie 和 PocketBase token 留在可信服务侧。
3. 固定 Runtime 用部署注入的公钥验证断言和作用域，再进入 `register()` 等业务路由。可向业务路由提供可信的用户 ID，应用源码只读取所需身份。旧路径、伪造头以及绕过 Caddy 直接访问容器的请求均由 Runtime 的验证覆盖。部署健康检查使用原有公开健康端点，回读时改用该环境真实入口 URL。

Harbor 无法完成会话检查时，受保护 API 拒绝请求。PocketBase 暂停期间，注册、新登录与用户管理不可用，已有会话仍由 Harbor 校验。登录关闭和启用都随路由切换确认，避免留存无鉴权的旧入口。认证开启时，候选镜像必须声明并验证支持对应 Runtime 契约。回滚只有在历史产物支持该契约时才可切换，否则保留当前入口。

首版沿用受信创作者范围。将来开放不受信的后端代码时，需要将所有访问控制放到应用进程无法控制的网络或执行边界，并另行验证容器间隔离。

## 与当前 Harbor 代码衔接

| 当前位置 | 设计改动 |
| --- | --- |
| `src/service/server.ts`、`src/service/applications/config.ts` | 装配应用认证模块及私有 PocketBase 客户端。配置组包含启用状态、认证域、应用域、PocketBase 私有地址和凭据、Google 客户端及签名配置。 |
| `src/service/applications/http.ts`、`store.ts` | 增加认证设置和应用所有者的用户管理接口。应用账号和 Harbor 创作者账号分别解析。可复用当前管理会话的哈希及来源校验思路。 |
| `src/service/applications/edge.ts`、`service.ts` | 给登录应用生成主机匹配、认证路径和业务预检查。将入口 URL 用于详情、路由切换及周期恢复。切换时在一次配置更新中移除旧的共享来源入口，并回读新地址身份。 |
| `infra/app-runtime/server.mjs`、`src/service/applications/docker.ts` | 注入运行所需作用域、公钥和登录模式。固定 Runtime 在 API 入口验证身份，部署记录保存兼容能力。 |
| `apps/web/src/features/applications/`、`templates/application-v1/` | 编辑器加入用户分区，预览用真实地址打开。模板增加登录入口和 `/me` 调用示例，使用平台托管的表单。 |
| `src/service/deletions/service.ts` | 永久删除时增加认证资源清理检查点，先撤销会话和阻止新登录，再删除映射所指集合，核对成功后删除应用记录。下线仅停用访问，用户资料保留。 |

应用版本的 `auth` 是发布配置，账号集合映射和最近确认的保护状态由 Harbor 保存。`harbor-app.json` 继续声明业务数据和统计。这样 Agent 修改源码时，登录要求仍由部署记录和平台运行层落实。PocketBase 持久卷纳入备份恢复，Google/邮件密钥单独保管。通过版本化构建产物安装 PocketBase，校验发行件，并订阅上游迁移后的发布入口。 [PocketBase 备份与部署](https://pocketbase.io/docs/going-to-production/) · [上游迁移公告](https://github.com/pocketbase/pocketbase/discussions/7873)

## 实施和验收顺序

| 阶段 | 通过条件 |
| --- | --- |
| 1. 固定版本探针 | 两个测试集合使用同一套 Google 客户端及固定回调，账号分别落库。验证 PKCE、注册即登录、同邮箱两种身份隔离及停用。Google 使用独立测试配置。 |
| 2. Harbor 闭环 | 从应用页面完成密码注册、密码登录、Google 登录、`me` 和退出。两应用、两个环境相互隔离。过期、重放、伪造头、错应用会话、直接容器访问均被拦截。 |
| 3. 生命周期 | 工作台分页、停用、恢复与审计通过。发布、重启和兼容回滚保持账号。旧入口无法绕过登录，永久删除只清理指定应用的用户集合和会话，备份恢复可复验。 |

独立 HTTPS 域名和测试 Google OAuth 凭据用于真实联调。固定 PocketBase 的接口已在隔离环境验证。真实 Google 回调及 HTTPS 验收需要使用独立安装配置。 [Google 回调规则](https://developers.google.com/identity/protocols/oauth2/web-server) · [Google 测试与正式配置](https://developers.google.com/identity/siwg/best-practices) · [PocketBase 记录接口](https://pocketbase.io/docs/api-records/)


## 安装与开启

1. 在独立环境安装已验证的 [PocketBase 0.41.1](https://pocketbase.io/docs/)，按官方校验文件核对发行件。绑定 Harbor 可访问的私有地址，持久化 `pb_data`。为 Harbor 准备专用 PocketBase 超级用户令牌并保管在服务环境变量中。
2. 准备独立 HTTPS 认证域和应用域的通配 DNS、证书。Harbor 配置见 [.env.example](../../.env.example) 的 `AH_APP_AUTH_*`。Google Web OAuth 客户端只登记 `<AH_APP_AUTH_ORIGIN>/__harbor/visitor/google/callback`。应用域名由 Harbor 根据应用编号和环境分配。
3. 在同一 HTTPS 监听器保留唯一的 `harbor-application-routes`，让它匹配管理域与通配应用域。固定认证域只转发 `/__harbor/visitor/*`。平台管理反向代理仅匹配管理域，其他未匹配请求返回 404。下面是认证域的 Caddy 路由片段。将其合并到现有 HTTPS 配置，应用域证书仍由安装者管理。

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

   Caddy 与 Harbor 使用相同的 `AH_APP_AUTH_EDGE_TOKEN`。Harbor 的 Node 监听地址、Caddy 管理接口与 PocketBase API 均留在可信网络。Caddy 或上层代理的访问日志应跳过认证请求。应用流量经外层代理时，只有明确设置可信代理列表后才可用可信客户端 IP 替换 `remote_host`。

4. 构建代码后，在目标控制库运行 `npm run db:migrate`，再启动配置了 `AH_APP_AUTH_ENABLED=1` 的 Harbor。用「应用登录」Skill 修改应用版本的登录声明，等待预览构建。正式访问入口随正常发布生效。Google 方式需要统一 Google OAuth 配置。邮箱密码注册无需 SMTP，只启用邮箱密码时可省略 Google 凭据。旧版本的代码可以重新构建以使用新的固定运行层。前端业务 API 请求使用同源 Cookie。用户列表随环境切换，停用立即撤销该账号的 Harbor 会话。测试通过后再用独立的正式配置启用。

应用登录域和签名密钥应持久保存。切换安装配置前先备份控制库和 PocketBase 的持久数据。Google 密钥变更后，重新部署启用了 Google 的环境以同步集合配置。已有受保护部署使用其固定公钥，更新签名密钥后需要重新部署。


托管页和登录服务读取已确认部署的登录方式。Google 回调和最终会话交接会再检查当前配置，旧页面无法使用已关闭的方式。切换方式保留已有账号和已签发会话。PocketBase 新集合只开放所对应的认证方式，Harbor 也在私有接口前执行每个部署的限制。
