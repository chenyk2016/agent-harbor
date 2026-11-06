# V6：用户、额度与用量

V6宿主版本0.7.0，仍使用agent-harbor:0.4.0执行镜像。正常对话链路不变：网页/CLI → 服务 → 原有Conversation → Docker → Claude Code。

## 本地体验

原有开发密钥仍能登录。左侧「我的用量与密钥」查看任务/环境占用、工作文件空间、SDK估算费用，并为CLI生成30天访问密钥。明文只在创建成功时显示，关窗即清除，不存localStorage。若创建响应丢失，先刷新列表核对/撤销未保存的新密钥，不能找回明文。

退出登录只结束当前浏览器身份，已执行任务继续。撤销CLI密钥会阻止新请求并断开使用该密钥的观看/传输；不会取消任务，也不会注销此前独立换取的浏览器登录。账号停用则撤销该用户全部登录和密钥，并确认关闭全部环境。重新启用不会复活旧密钥。

浏览器登录哈希保存进SQLite，8小时到期，重启可继续登录。已有会话ownerId原样保留。旧access-keys.json在启动时导入，已撤销的密钥不会因重启再次生效；旧文件不是在线身份事实来源。

## 接入统一身份登录

使用标准OIDC身份服务，不自行实现密码、找回密码或账号注册。身份供应商负责准入策略：如果供应商允许任何人登录，该应用也会为其创建普通用户；内网试用应先在供应商限制可登录人员。

创建一个机密Web应用，启用授权码、PKCE及client_secret_post，登记唯一回调：

```text
https://harbor.example.com/api/auth/oidc/callback
```

在私有.env配置：

```dotenv
AH_PUBLIC_ORIGIN=https://harbor.example.com
AH_OIDC_ISSUER=https://identity.example.com
AH_OIDC_CLIENT_ID=your-client-id
AH_OIDC_CLIENT_SECRET=your-client-secret
AH_KEY_LOGIN=false
AH_ADMIN_USERS=internal-user-id
```

服务仍监听127.0.0.1，使用HTTPS反向代理转发网页/API/SSE，代理须关闭SSE缓冲并放行长连接。Origin只用固定AH_PUBLIC_ORIGIN，不信任X-Forwarded-*；HTTPS下Cookie附加Secure。供应商地址必须HTTPS，不提供正式环境跳过证书/签名的开关。身份库按issuer+sub匹配内部UUID，不按邮箱或显示名合并，旧developer不会被同名外部账号接管。

无需为本地开发设置OIDC。缺失供应商配置时隐藏统一登录入口；不伪造第三方登录成功。真实供应商、回调域名和HTTPS部署需要独立验收，本轮仅使用本机签名身份夹具验证协议。

管理员来自AH_ADMIN_USERS中的内部用户ID，不从前端、显示名或“第一个登录”推断。首次外部登录后，可从本人账户查看内部ID，由部署操作者配置管理员并重启服务。重启会关闭运行环境，安排在没有执行任务时进行。

## 额度怎么工作

默认每用户100会话、1个同时执行任务、2份保留环境、1GiB工作文件软额度；全局容量仍由AH_CAPACITY控制（默认4）。任务结束释放任务名额；环境确认停止才释放环境名额；空闲容器和停止未知环境仍占位。额度不足明确拒绝，不自动排队、不取消已有任务。

检查与accepted/内存占位之间不await。文件扫描在此之前完成，扫描后再次检查身份、忙状态和额度。创建会话在异步准备目录前登记创建名额，失败释放，不留下可执行的半初始化会话。相同clientMessageId重试先返回原消息，不重复扫描/占位。

空间统计通过已有Python目录描述符边界，不跟随软链接。上传按实际字节执行剩余额度并保留原20MiB单文件限制；同一用户的上传串行占位，避免同时发布跨会话文件。扫描最多100000条/64层，未知或超限不把部分结果当零使用量。任务开始前重新扫描；上传原ID重试仍校验实际哈希，不因额度已满而覆盖或重新创建。

空间是工作区逻辑字节软额度，不含Claude状态、事件数据库、诊断或私有暂存。Agent/后台进程仍可增长文件，不是文件系统硬配额；总体磁盘硬额度、备份与保留策略需在部署层单独实现。

## 管理命令与接口

管理员CLI复用AH_SERVICE_URL和AH_SERVICE_TOKEN，通过HTTP操作，不直接打开运行中的数据库：

```sh
npm run admin -- list
npm run admin -- update USER_ID '{"limits":{"sessions":100,"tasks":2,"environments":2,"workspaceBytes":1073741824}}'
npm run admin -- update USER_ID '{"disabled":true}'
npm run admin -- update USER_ID '{"disabled":false}'
```

limits对象表示一整份策略，省略字段恢复默认；0表示禁止相应新操作。降低额度不会强停已接受任务。停用失败返回USER_CLEANUP_UNCONFIRMED，身份仍停用，环境占位保留；管理员可重复停用重试，或按原恢复流程重启协调。不能停用当前管理员自己。

| 接口 | 内容 |
| --- | --- |
| GET /api/auth/config | 可用登录方式，无密钥 |
| GET /api/auth/oidc/start、callback | 登录跳转、单次换码 |
| GET /api/account | 本人身份、策略、实时占用、工作空间和用量 |
| GET/POST /api/account/keys | 列出元信息/创建本人密钥 |
| DELETE /api/account/keys/:id | 撤销本人密钥 |
| GET /api/admin/users | 明确配置的管理员列出用户 |
| PATCH /api/admin/users/:id | 管理员设置停用或用户策略 |

所有会话/文件接口继续经过owned检查。浏览器写请求要求固定同源和X-Harbor-Client:web，旧标签页账号比对仍保留。Cookie和Bearer观看连接都响应身份撤销；文件操作响应对应连接的取消信号。

## 用量的含义

当前固定SDK0.3.306的total_cost_usd跨流式轮次累计，恢复会话还会继承历史。按服务messageId去重、按会话保存最后累计值求差，不能把每轮累计值直接相加。已有旧历史但没有计量基线时，第一次结果只记录累计观察值，不把它作为本轮费用。累计下降/启动错误零值标记增量未知，不清空此前基线。

usage字段只覆盖主循环、按轮提供；展示输入/输出token时明确这个范围，不声称涵盖全部子任务、辅助调用和缓存分类。没有原生result的中断/崩溃可能缺失用量，不补猜测。记录的费用是SDK估算，不能用它给终端用户出账单或承诺硬金额封顶。

参考：[官方费用说明](https://code.claude.com/docs/en/agent-sdk/cost-tracking)，以本项目安装的sdk.d.ts注释为固定版本依据。

## 从代码阅读

- identity/oidc.ts：登录握手、PKCE/state/nonce、签名和claims核验；供应商token不落库。
- identity/store.ts：用户、身份对应、登录哈希、密钥和用户策略。
- identity/http.ts：本人/管理接口与撤销活动连接，不承担容器执行。
- browser-sessions.ts：持久Cookie对应的活动观看连接。
- limits/policy.ts：简单策略及参数检查；SessionManager里检查并占位。
- usage/store.ts：累计值、差额、消息去重与汇总。
- clients/web/account.ts：账户弹窗，关闭/换账号时中止旧请求并清理明文。

没有新增执行引擎、消息队列、组织共享或管理看板。
