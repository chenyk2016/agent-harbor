# HTTP 路由与请求边界

V9 使用 Express 5。HTTP 层负责匹配方法与路径、认证、输入解析及响应；业务服务继续负责归属、版本、额度、撤销和运行状态。换路由框架不改变进程隔离边界：API、MCP 网关和容器管理器仍在同一个宿主进程。

## 从入口阅读

`src/service/http-api.ts` 的 `createApi()` 只装配应用与模块，返回原来的 Node HTTP Server，启动、关机和 SSE 继续使用既有生命周期。

请求顺序如下：

1. `/api` 响应设置 `Cache-Control: no-store`，API 的隐式 HEAD 返回 404。
2. `GET /api/health` 公开，不经过登录和 Origin 检查。
3. 检查浏览器 Origin，挂载登录、OIDC 回调和退出等公开身份路由。
4. 校验 Cookie 或 Bearer、浏览器身份切换和写操作的 Origin/CSRF，将身份与撤销信号放入 `response.locals.principal`。
5. 挂载个人账户、MCP、Skill、专家、会话和文件 Router。
6. 未匹配 API 返回 404；只有已知页面和构建资源进入网页 Router。
7. 最后的错误中间件统一转换业务异常和解析异常。

这里不使用全局 `express.json()`。认证在业务 JSON 解析之前，未登录的大正文不会先触发业务解析；文件、ZIP 和 MCP 也不会被误当成 JSON 消费。

## 模块分工

| 文件                           | 职责                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `src/service/identity/http.ts` | `publicRouter()` 提供登录入口；`accountRouter()` 提供已登录账户管理 |
| `src/service/mcp/http.ts`      | MCP 连接、模板和探测管理；只使用服务端确认的当前用户                |
| `src/service/skills/http.ts`   | 技能、版本、准备请求及 ZIP 导入导出                                 |
| `src/service/experts/http.ts`  | 专家、版本、连接、OAuth、头像和完整包                               |
| `src/service/sessions/http.ts` | 会话创建与能力快照、历史、消息、SSE、取消和关闭                     |
| `src/service/files/http.ts`    | 文件列表、预览、流式下载和上传；继承父级 sessionId                  |
| `src/service/http/shared.ts`   | 身份读取、参数读取、JSON/二进制限长、404 和错误转换                 |
| `src/service/web-assets.ts`    | 已知页面及资源的白名单匹配、静态响应头                              |
| `src/service/mcp/gateway.ts`   | 独立端口的 `/mcp/:bindingId` 原生协议入口                           |

路由直接声明方法和参数，例如：

```ts
router.put(
  "/mcp-connections/:connectionId",
  ...jsonBody(),
  async (request, response) => {
    response.json(
      await gateway.service.save(
        principal(response).userId,
        jsonInput(request),
        parameter(request, "connectionId"),
      ),
    );
  },
);
```

读这段代码时，顺序就是“匹配 PUT 路径 → 解析有限 JSON → 取已认证身份 → 调用业务服务 → 返回 JSON”。`principal()` 不接受浏览器传入的 userId。Express 5 自动把 async handler 的异常传给错误中间件，业务 handler 不需要重复 try/catch。

会话子路由先执行 `manager.owned()`，文件层再检查 `fileAccess()`；文件 Router 设置 `mergeParams: true`，才能读到上级路径的 sessionId。归属校验仍由服务层执行，不能只靠 URL 存在。

## 正文和长连接

- 普通 JSON 默认上限 256 KiB；Skill/专家的相关编辑接口为 2 MiB。只接受对象；空正文、数组、null 和损坏 JSON 返回 400，超限返回 413。保留旧客户端不填 JSON Content-Type 的兼容行为，不接受压缩正文。
- ZIP 导入保留原始字节，限制 20 MiB；超限排空输入后返回 413。ZIP 内容的安全校验由原有包服务执行。
- 文件上传继续把原始流交给文件层，下载使用 `pipeline()` 保留背压。退出登录、断线、超时和服务关闭信号仍能中断传输。
- SSE 沿用事件游标、历史补看和取消行为，不经 JSON parser。
- MCP 使用独立 Express 应用匹配 `/mcp/:bindingId`，以 Binding 的短期 Bearer 凭证认证，正文由 MCP SDK transport 读取。不能套用网页 Cookie 或全局 JSON parser；上游异常仍统一拒绝，避免返回凭据。

## 迁移时容易遗漏的细节

- Router 挂载 `/api` 后，`request.url` 会临时移除前缀。OIDC 回调显式传 `request.originalUrl` 给供应商校验，避免 redirect URI 变成缺少 `/api` 的路径；查询串也从 originalUrl 解析，保留重复 version 参数。
- Express 默认可以把空 JSON 正文当作 `{}`，这里额外拒绝，以保留旧错误契约。
- 路径区分大小写，额外路径后缀不会进入原 handler；保留 Express 的单个末尾斜杠兼容。静态页面明确支持 HEAD，API 不隐式执行 GET handler。
- 解析错误可能附带原始正文，错误边界仅返回稳定错误码，不直接记录解析异常对象；响应已开始时关闭连接，不能再拼一段 JSON。
- 已知页面刷新可以返回 SPA，未知 API 和私有路径仍为 404。Express 不获得文件目录遍历权限。

## 验证入口

`tests/express-routing.test.ts` 专门覆盖精确路径、认证先于正文解析、CSRF、JSON 边界、原始 ZIP、页面刷新和带挂载前缀的 OIDC 回调。既有 service/files/identity/MCP 测试继续覆盖业务、SSE 和撤销。

完整回归使用 `npm test`；`npm run check` 检查宿主与网页类型。原生 MCP 验证还需要 Docker 与现有执行镜像，可用 `AH_MCP_EVIDENCE_DIR` 指定证据目录，避免覆盖过去的结果。受控模型与 MCP fixture 的通过不代表真实第三方账户或生产部署验收。
