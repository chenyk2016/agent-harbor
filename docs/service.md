# 会话 HTTP 与 SSE 参考

本文面向客户端开发者，列出当前会话接口的主要契约，不是全部业务API清单。服务使用PostgreSQL保存身份、消息、事件、模型和钱包信息；浏览器与CLI连接同一个服务，执行由服务持有。

部署与管理员环境密钥见[安装](quickstart.md)和[账号与登录](identity.md)。源码启动 `npm run server` 加载根目录 `.env`；托管实例使用 `node --env-file=<实例目录>/harbor.env dist/src/service/server.js`。服务默认监听回环地址，团队HTTPS入口由部署者配置。

## 身份与正文

CLI使用 `Authorization: Bearer <Harbor访问密钥>`。网页通过密钥、邮箱密码或OIDC登录，具体方式由实例配置。浏览器修改请求须通过Origin与 `X-Harbor-Client: web` 检查。模型供应商的API Key不能用于登录Harbor。

普通JSON正文上限256KiB。服务按已认证用户检查资源归属，不接受客户端指定ownerId、模型凭据或Docker参数。静态页面和健康接口无需登录，业务接口需要登录。

个人密钥在“设置→访问密钥”管理。停服时运行 `npm run access-key -- USER_ID` 可追加导入用密钥，随后须重启服务；日常管理员登录以环境文件中的 `AH_BOOTSTRAP_ADMIN_KEY` 为准。

## 主要接口

下表路径均以 `/api` 为前缀。完整参数以 `src/service/sessions/http.ts` 和各业务模块的 `http.ts` 为准。

| 接口 | 契约摘要 |
| --- | --- |
| `GET /health` | 返回alive和ready；运行状态未协调完成时ready为false |
| `POST /sessions` | 创建会话，支持title、空模板或fix-project模板，以及获准的模型/能力选择；返回会话记录 |
| `POST /auth/login` | 使用accessKey建立浏览器登录；默认8小时 |
| `GET /auth/me` | 当前登录用户及可用能力 |
| `POST /auth/logout` | 退出当前登录并断开其查看连接，不主动取消任务 |
| `GET /sessions` | 本人会话，limit最多100；order=created和after支持分页 |
| `GET /sessions/:id` | 会话、最近消息、环境与事件位置 |
| `POST /sessions/:id/messages` | clientMessageId、text，可选deploymentId；新消息202，重复请求200 |
| `GET /sessions/:id/messages` | 按after和limit分页，最多100条 |
| `GET /sessions/:id/history` | 固定through上界，返回事件和关联消息快照 |
| `GET /sessions/:id/messages/:messageId` | 指定消息原文与状态 |
| `GET /sessions/:id/events` | SSE，以after指定最后已处理的事件ID |
| `POST /sessions/:id/messages/:messageId/cancel` | 终态重复取消200，登记取消202；不代表全部清理已完成 |
| `POST /sessions/:id/close` | expectedMessageId为最新消息ID，无消息时为null；已关闭200，开始关闭202 |

文件接口采用同一会话归属检查，独立的二进制上传不受普通JSON大小限制。文件限制见[工作区与文件](workspace-files.md)。删除资源与单纯关闭环境分开，见[删除说明](deletion.md)。

## 重试与状态

相同会话下，同一clientMessageId、原始正文及原始deploymentId选择均相同才返回原消息；是否省略deploymentId也属于原始选择。复用ID但更换正文或模型选择返回409。忙时新消息返回冲突，容量或协调问题可能返回503。去重保护的是提交，不保证外部工具副作用恰好一次。

关闭中拒绝新消息。关闭请求后继续查询环境状态，只有确认closed才算完成。expectedMessageId过期返回409，避免关闭后来一轮的环境。重启后重新查询，不自动重发结果不明的业务操作。

## 事件流

```text
id: 39
event: assistant.text.delta
data: {"messageId":"...","text":"第一行\n第二行"}

```

先保存事件再发送，编号在同一会话内跨服务重启递增。客户端按完整SSE帧解析JSON，并保存最后处理的eventId重连。服务每批最多读100条；无满批时等待200ms，空闲15秒保活。缓冲超过1MiB或等待drain超过5秒，会关闭慢连接让它重连。

CLI `watch SESSION_ID CURSOR` 可从游标继续；`run` 重试应使用原 `--request-id`。`chat`按一行一条消息，复杂多行正文用 `run SESSION_ID --file prompt.txt`。网页Enter发送，Shift+Enter换行，输入法组合期间不发送。

## 执行与恢复边界

关闭网页和CLI断开不取消服务端任务。普通Docker任务可原生中断并保留环境，本地MCP及OpenSandbox停止会关闭整个环境；任务超时、异常或明确关闭均须确认清理。恢复保留已保存记录，未完成消息标中断，不自动重放。

默认不设平台总时限、Agent轮数和SDK估算费用上限；对应变量设正数可启用限制。钱包余额、个人资源策略和环境容量独立生效。镜像与会话快照需要兼容，单纯重启服务不会替换已有会话的运行镜像。

当前支持OIDC、邮箱密码、人民币钱包和管理审计；持久执行队列、多主机接管、磁盘硬配额和面向陌生租户的完整生产隔离仍不是已交付保证。
