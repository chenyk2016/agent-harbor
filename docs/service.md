# 独立会话服务与V4网页

服务和CLI分别启动。按README构建、生成开发访问密钥、填写.env，再启动npm run server。只监听127.0.0.1；不自动安装系统常驻服务。终端或进程管理器负责服务进程生命周期。

访问密钥从`<AH_DATA_DIR>/.service/access-keys.json`加载：

```json
[{"userId":"developer","tokenHash":"由access-key命令生成的SHA256十六进制哈希"}]
```

`npm run access-key -- developer`在服务停止时追加密钥，明文仅显示一次。服务运行中不热加载；添加后重启。密钥使用者可以访问该userId全部会话，不要用模型网关Token代替。

## HTTP

CLI携带`Authorization: Bearer <service-token>`；网页通过登录换取同源HttpOnly Cookie。health和构建后的静态网页无需登录。JSON正文上限256KiB，不接受客户端指定ownerId、模型凭证或Docker参数。

| 接口，前缀/api | 用途 |
| --- | --- |
| GET /health | alive和ready；协调未知时ready=false |
| POST /sessions | title，可选template=empty或fix-project；返回UUID |
| POST /auth/login | 同源Origin、自定义头、accessKey换取8小时浏览器Cookie |
| GET /auth/me | 当前登录用户 |
| POST /auth/logout | 撤销本浏览器Cookie及查看流，不取消任务 |
| GET /sessions | 当前用户列表，limit最多100；order=created&after=UUID可分页 |
| GET /sessions/:id | 最新消息、环境和事件游标 |
| POST /sessions/:id/messages | clientMessageId(UUID)、text；202接收，200返回重复请求 |
| GET /sessions/:id/messages | after为createdEventId，limit最多100 |
| GET /sessions/:id/history | after、through、limit；保存事件和引用消息，固定上界分页 |
| GET /sessions/:id/messages/:messageId | 查询指定消息原文与当前状态，仍检查会话归属 |
| GET /sessions/:id/events | SSE，after为已显示eventId |
| POST /sessions/:id/messages/:messageId/cancel | 停止指定消息；终态无副作用 |
| POST /sessions/:id/close | expectedMessageId必须等于最新消息ID，或无消息时为null |

相同clientMessageId、相同原始正文返回原消息；相同ID换正文返回409。忙时新输入409，容量或协调问题503。客户端应保留原请求ID重试，去重不等于工具副作用恰好一次。

关闭请求立即返回202，关闭中拒绝新输入；轮询环境closed才表示成功。旧的expectedMessageId返回409，不影响后来一轮。服务重启后需要重新查询当前状态。

文件接口见[V5文件工作区](workspace-files.md)。上传使用独立二进制路由，不受普通消息256KiB JSON上限约束；身份、Origin和会话归属仍由相同入口检查。

## 事件

```text
id: 39
event: assistant.text.delta
data: {"messageId":"...","text":"第一行\n第二行"}

```

客户端按完整SSE帧解析JSON，换行不会截断正文。先保存事件再发送，编号跨服务重启递增；断开只从after补发。服务器每200ms批量读取100条，每15秒保活；写缓冲超过1MiB或drain等待超过5秒关闭慢连接，让它重连，不阻塞任务执行。

CLI的watch显示事件游标，可用`watch SESSION CURSOR`继续；chat重新进入默认补看全部历史。run的传输重试沿用请求UUID；响应仍不确定时，可用输出中的UUID执行`run SESSION TEXT --request-id UUID`。不要生成新ID盲目重复提交。

网页输入框支持多行，Cmd/Ctrl+Enter发送。CLI多行输入使用`run SESSION --file prompt.txt`。chat首期按一行一条消息，尚无多行编辑器。

## 已有边界

原生中断可以保留独立后台任务；需要确保它们全部停止时关闭环境。服务崩溃不保证活任务继续；恢复只保留已落盘记录、确认旧环境停止，不自动重放任务。

本地开发身份、单机数据根和容量限制已实现；公网/企业登录、队列、租户账本、事件保留/磁盘配额与生产多租户安全另行建设。真实网关和用户任务验收不由本地模型夹具替代。

## 执行限额

默认不设平台总时限、Agent轮数和SDK估算费用上限。`AH_TASK_TIMEOUT_MS`（毫秒）、`AH_MAX_TURNS`、`AH_MAX_BUDGET_USD`分别设为正数可重新启用，0表示关闭；不限时不会向SDK传入0额度。专家包显式声明的子Agent轮数仍保留。手动停止、5秒中断兜底、空闲回收、钱包余额与资源/权限隔离继续生效。

旧会话固定了运行镜像，SDK配置变化需验证兼容后升级镜像快照；仅重启宿主不会更新旧镜像中的Runner。

运行镜像补丁可用 `docker build --pull=false -f infra/Dockerfile.execution -t agent-harbor:0.6.3 .` 构建（先构建宿主代码，需已有0.6.1基础镜像）。补丁只更新Runner配置适配器和单次运行定时器，SDK与依赖不变；旧版常驻Runner也可通过任务字段缺省取消主Agent轮数与估算费用上限。
