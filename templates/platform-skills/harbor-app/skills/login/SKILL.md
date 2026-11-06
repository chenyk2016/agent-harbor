---
name: login
description: 为当前 Harbor 应用接入访客登录，使用平台提供的邮箱密码注册和 Google 登录，并处理当前用户、退出和个人数据归属。
user-invocable: true
---

# 应用登录

先读当前应用的 `harbor-app.json`、`src/` 和 `server/index.ts`。当用户要求接入或调整登录时，在现有 `harbor-app.json` 的顶层修改 `auth`，保留业务数据和观测声明。

替换应用自建登录时，保留已存在的旧账号和会话表。formatVersion 2 的应用把新增访客字段写入新的 SQL 迁移；formatVersion 1 的旧应用保留 `tables` 中的原声明，直到完成基线切换。

- 只允许 Google 登录写 `"auth": { "mode": "required", "providers": ["google"] }`。
- 只允许邮箱密码注册和登录写 `"auth": { "mode": "required", "providers": ["email_password"] }`。
- 两种方式并用写 `"auth": { "mode": "required", "providers": ["email_password", "google"] }`。接入登录但没有指定方式时，只用当前平台明确可用的方式。
- 明确关闭登录写 `"auth": { "mode": "public" }`。已受保护的环境需要所有者在构建预览或发布时确认开放。仅咨询登录或编辑无关功能时保留原配置。新应用没有声明时默认公开。

仅声明当前平台明确可用的方式。平台没有可用方式时不配置托管登录，告知用户联系管理员配置，或自行实现。

接入托管登录时同时实现应用自己的登录入口、跳转和退出操作。沿用现有页面风格，可在导航放登录按钮，或在访客发起需要登录的操作时引导登录。Harbor 提供托管登录页、回跳、会话和鉴权接口。

托管页根据部署配置展示可用的方式，邮箱密码注册成功后直接登录。相同邮箱的密码账号与 Google 账号各自独立，按应用访客 ID 区分数据。

- 使用 `import.meta.env.BASE_URL` 拼接平台路径。将浏览器导航到 `__harbor/auth/start`，通过 `return` 指定应用前缀内的返回路径。
- 用同源请求读取 `__harbor/auth/me`，由应用决定展示哪些账号资料。受保护的业务请求返回 `401` 时引导访客登录。用 `POST __harbor/auth/logout` 退出，成功后刷新应用自己的登录状态。写请求继续携带 `X-App-Revision`。
- 将业务路由放在 `/api/` 下。服务端从 `request.harborUser?.id` 取得可信访客 ID，并按该 ID 筛选或写入个人数据。缺少身份时拒绝访问个人数据。
- 自定义 SQL 新建业务记录时，显式写入由 `randomUUID()` 生成的 `id`。托管访客 ID 写入独立字段，用于记录归属。
- Harbor 管理 PocketBase 和 Google 凭据，应用代码只消费同源接口与运行层身份。交付时说明配置和业务代码的实际改动，预览随构建生效，正式环境随正常发布。
