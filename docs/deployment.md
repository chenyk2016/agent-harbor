# 受信小团队：安装、验收与恢复

首版目标是专用Linux单机，Node 24.19+、Python3、Git、本地Docker Engine和Compose v2。当前Mac/OrbStack为开发验证环境；支持声明以每个发行版的Linux CI与部署证据为准。只服务受信成员；这不是陌生用户代码执行平台。网页/API保持127.0.0.1；团队访问通过管理员配置的HTTPS反向代理，AH_PUBLIC_ORIGIN必须与外部地址一致。应用创建默认关闭。自有源码Apache-2.0，SDK/Claude Code与模型服务受各自条款约束；企业使用自己的获准凭据，内部额度不是支付或模型转售。

## 固定版本与安装

源码开发：`npm ci && npm run build`。发行包已经包含服务与网页；只需在包根执行`npm ci --omit=dev --workspaces=false`安装锁定的服务依赖。安装动作不会下载或执行未知来源脚本。发布包的`release-manifest.json`记录源码提交、脏状态、运行镜像ID与文件哈希；localOnly=true只供本机验证，不表示公开审计通过。

使用公开发行版提供的固定镜像；源码环境可构建不依赖旧本地标签的统一运行镜像：

```sh
docker build -f infra/Dockerfile.release -t agent-harbor:YOUR_RELEASE .
# 如需构建代理，显式设置BUILD_PROXY；不要把代理凭据写进版本库。
```

以下命令均在发布包/项目根运行。实例目录必须专用且为空；以下路径是示例，不自动改现有实例。命令输出不包含密码，私有配置与首次管理员密钥只保存在实例目录。

```sh
node dist/src/clients/ops/main.js configure --dir /srv/harbor-instance --image agent-harbor:YOUR_RELEASE
node dist/src/clients/ops/main.js install --dir /srv/harbor-instance
AH_BOOTSTRAP_ADMIN_KEY="$(openssl rand -hex 32)" node dist/src/clients/ops/main.js init --dir /srv/harbor-instance --admin operator --model-config /secure/bootstrap-model.json
node dist/src/clients/ops/main.js doctor --dir /srv/harbor-instance --runtime
node --env-file=/srv/harbor-instance/harbor.env dist/src/service/server.js
```

默认端口：服务4318、控制库55432、网关4320、网关库55433；configure可分别用--port/--db-port/--gateway-port/--gateway-db-port指定，Linux推理桥接端口为服务端口减1。端口冲突明确失败，不自动杀死其他服务。已有数据目录不自动认领，已有实例不要重新configure。

Linux由Docker bridge实际网关地址提供仅/inference的钱包入口，并为Runner配置host.docker.internal:host-gateway；网页与管理API不暴露到这个入口。它沿用钱包凭据校验。macOS使用容器引擎提供的宿主别名。doctor --runtime实际创建命名空间探针，但不代表完整隔离审计；实际容器到模型入口由acceptance验证。禁止将Docker socket挂给用户任务，服务账号的Docker权限属于宿主高权限，应在专用机器运行。

## 团队 HTTPS 入口

先用回环地址完成 [本地启动与登录](quickstart.md)。在专用服务器上为团队配置一个 HTTPS 域名，将 DNS 指向反向代理。Caddy 与 Harbor 在同一宿主机时可使用以下配置，将示例域名替换为你的域名。

```caddyfile
harbor.example.com {
    reverse_proxy 127.0.0.1:4318
}
```

在私有 `harbor.env` 中设置 `AH_PUBLIC_ORIGIN=https://harbor.example.com`，与浏览器地址完全一致，再重启 Harbor。开启认证选项前，先从团队网络登录、运行一个短任务并重连，验证 TLS、Cookie 和 SSE 事件。反代需允许长连接并及时转发事件。PostgreSQL、LiteLLM 管理面、Docker API 和内部推理入口仅对各自所需的内部来源开放。配置应用访客时再单独规划认证域与应用域。

## 管理员与模型初始化

首次执行 `init` 必须通过该命令的进程环境提供 `AH_BOOTSTRAP_ADMIN_KEY`，接受 32 至 128 个字母、数字、下划线或短横线。可以从部署密钥管理器提供高强度随机值，也可以用上面的命令随机生成。缺少或格式不合规时初始化失败，服务也无法以空密钥实例启动。该变量只用于首次初始化，无需写入 `harbor.env`，重启、恢复和重复初始化继续使用已有凭据。

`first-admin.key`仅在首次初始化写入0600文件，管理员通过受控方式交给本人，在登录页使用；不能贴到公共日志。服务停机时可为成员使用原有access-key工具显式创建密钥；OIDC配置继续复用既有身份入口。首个登录者不会自动成为管理员。重复init不轮换密钥、不恢复已撤销密钥、不覆盖模型。如果模型同步阶段失败，使用同一配置重跑init会核对现有供应商、加密凭据与模型后继续，不重复建模或轮换密钥。配置发生变化或匹配不唯一则拒绝自动选择，后续调整使用后台。若停在credentials-pending，表示凭据文件写入不确定：保留现场，核对first-admin.key与access-keys.json哈希后再修复检查点，不能直接删除重建。

bootstrap-model.json由部署者提供，0600保存，不进入版本库。例如下面费率仅说明字段结构，不可当供应商真实价格：

```json
{
  "provider": {"name":"Company provider","format":"anthropic","apiBase":"https://your-authorized-provider.example","apiKey":"YOUR_PRIVATE_KEY"},
  "deployment": {"name":"Team model","upstreamModel":"YOUR_MODEL","tools":true,"streaming":true,"allowedUsers":[],"params":{},"capabilities":{}},
  "cost": {"inputUsdPerMillion":"1","outputUsdPerMillion":"1","cacheReadUsdPerMillion":"1","cacheWriteUsdPerMillion":"1","timeoutSeconds":180},
  "price": {"input":"1","output":"1","cacheRead":"1","cacheWrite":"1"}
}
```

供应商成本用美元/百万Token，内部额度单价用元/百万Token；不得混加或当汇率。成员首次使用前管理员在后台赠送内部额度。钱包属于内部账本，公开注册默认关闭。启用工作台自助注册时，新用户一次性获得10元模型额度；已有用户不补发。TPM和模型请求并发保持未配置，不自动周期重置预算。模型必须经过工具/流式实测，协议可连通不代表Agent完整兼容。

## 免费检查与服务管理

```sh
node dist/src/clients/ops/main.js verify --dir /srv/harbor-instance
node dist/src/clients/ops/main.js service --dir /srv/harbor-instance --user harbor
```

service生成主服务与可选monitor.service/monitor.timer（每分钟采样），不安装或启用，不修改系统。管理员检查路径、数据权限和本地Docker权限后自行安装systemd单元。默认on-failure重启，关机仍走现有停止确认；服务重启不自动重放任务。脚本与报告分开给出passed/failed/skipped；网关存活检查不调用付费模型。doctor缺表会报迁移缺失，先执行install；模型配置与余额在后台核对。

## 完整任务验收

```sh
# 确定性本地模型+实际服务/SDK/Docker：不会调用真实模型
node dist/src/clients/ops/main.js acceptance --dir /srv/harbor-instance
# 显式真实供应商验收；金额是内部额度限制，不是供应商绝对费用保证
node dist/src/clients/ops/main.js acceptance --dir /srv/harbor-instance --live --model-config /secure/bootstrap-model.json --budget-rmb 5
```

acceptance在指定控制库内创建独立schema、独立数据根/账号/端口；不操作用户生产会话。默认使用本地确定性模型；live只创建隔离验收供应商/模型/用户，使用既有网关，不修改现有模型。标准链路：CSV上传→两轮生成/筛选→独立金额校验→重复提交去重→跨用户会话/事件/文件拒绝→重新登录与下载→代码修复及独立隔离测试。确定性模式还测试工具实际写入后停止、继续、进程崩溃及重启协调。fixture只证明集成，live才证明所选模型完成任务。既有验收案例可在自己的项目上继续扩展。

结果写实例acceptance下的report.json，原始服务日志为私有文件。真实模型无论成功失败都导出wallet-evidence.json；未确认费用不删除验收schema。cleanupConfirmed=false时保留schema与目录作为恢复入口；不能把清理不明当成功。live不主动做额外付费故障注入；最多4轮业务提交（重复提交复用ID），每轮最多8个Agent轮、180秒（确定性模式90秒，状态观察另留30秒收尾窗口），生产任务原有无限制默认值不变。模型工具循环与底层SDK重试会有多次请求，时间/余额有限，但预占估算和供应商账单可能有差异。未明确费用预算不能运行live。HTTP Cookie流程不冒充真实浏览器验收。

浏览器复验：使用新实例管理员登录→新会话上传标准CSV→发送汇总需求→下载文件并用独立校验器核对→第二轮修改→刷新/重登查历史→另一账号验证不可见→慢任务实际开始后停止→后台核对请求/账务/审计。逐项写证据，不把尚未执行项标通过。

## 停机备份与新实例恢复

停止宿主Harbor服务，确认没有遗留Runner。LiteLLM数据库专属于该实例，备份期间不得有其他客户端写入。备份包含控制库、网关库、完整data（含加密密钥）、私有环境及bootstrap；不包含依赖数据库的运行文件或镜像本体。必须保留原镜像；会话固定镜像不能任意重标。备份目录0700，包含敏感数据，另行加密异地保存；符号链接只备份链接本身，不复制其外部内容。

```sh
node dist/src/clients/ops/main.js backup --dir /srv/harbor-instance --output /secure/backups/harbor-001
# 在独立空目录configure，使用不同空数据库端口；先不要install/init
node dist/src/clients/ops/main.js configure --dir /srv/harbor-restored --image agent-harbor:YOUR_RELEASE --port 4418 --db-port 55532 --gateway-port 4420 --gateway-db-port 55533
node dist/src/clients/ops/main.js restore --dir /srv/harbor-restored --source /secure/backups/harbor-001
node dist/src/clients/ops/main.js install --dir /srv/harbor-restored
```

restore校验清单哈希、包版本、空数据根与空数据库，不提供覆盖参数；只保留原身份/加密/模型配置，不恢复旧机器地址。失败可能留下部分恢复，保留检查点，换新的空目标恢复，不自动删除失败现场。还需启动服务，用原身份核对历史、文件、余额/流水，再运行doctor；存在dump不代表恢复通过。AH_PUBLIC_ORIGIN与OIDC回调需按新部署地址核对。

升级：停服→备份→安装新版本到独立程序目录→检查迁移/旧镜像兼容→受控迁移→启动→verify；不覆盖旧镜像或会话快照。回退仅在旧服务兼容已执行数据库变更时进行，不自动回退数据库。破坏性迁移必须另行设计，不能用本工具强行回退。

## 状态变化通知

`monitor --dir DIR`执行一次免费采样，可由管理员调度，每次以文件锁防重入。首次健康只建基线；故障或恢复变化才通知，同状态不重复。默认写last-alert.json；显式在私有环境配置AH_ALERT_WEBHOOK（HTTPS，或本机HTTP用于测试）及可选AH_ALERT_WEBHOOK_TOKEN才发送。内容仅实例ID、失败检查名称和时间，不含正文/模型凭据。发送失败不推进状态，下次重试；网络响应丢失可能造成重复，接收方可按实例/状态去重。这不是后台监控声明，未部署调度就不会持续运行。

## 发布与限制

`package --image IMAGE --output EMPTY_DIR`先执行既有公开审计并要求干净提交；失败不生成公开包。`--local-only`仅生成带标记的私有验证目录，不包含.git、.env、用户数据、node_modules、SDK二进制。上传前核对待发布引用的可达历史。发布包安装依赖使用锁文件，并需验证来源。Linux CI配置与本机测试、真实供应商和用户验收分别记录，不能互相替代。


## Linux交付验证环境

`tests/delivery-verification.mjs`可直接运行于Linux宿主。开发机还可构建`infra/Dockerfile.delivery-check`并运行`tests/delivery-linux-verification.mjs`，在Linux控制容器+host network+本机Linux Docker Engine中对固定包执行同样的安装/恢复/任务/通知流程。验证控制容器持有Docker socket，Agent容器不持有；临时依赖卷与容器按本轮名称清理。此环境不等于另一台物理服务器，Ubuntu24.04独立部署仍需运行手动CI工作流，不能只凭模板声称支持。

## 可选Langfuse Cloud观测

在实例私有harbor.env中填写AH_LANGFUSE_HOST、AH_LANGFUSE_PUBLIC_KEY、AH_LANGFUSE_SECRET_KEY三项后自动启用；全空关闭，不额外加enabled变量。先应用0016迁移，按原停服流程重新创建网关并重启服务。配置缺项只禁用观测并单列错误，不使任务服务不可用。使用`harbor tracing --dir DIR [--request-id ID]`查看状态或核实云端模型记录。完整数据、重放和关闭规则见[模型与任务观测](llm-observability.md)。


## 工作台邮箱密码登录

先执行控制库迁移，再在实例的私有 `harbor.env` 设置 `AH_PUBLIC_ORIGIN` 和随机生成的 `AH_WORKBENCH_AUTH_SECRET`。重启后可用邮箱密码登录。公开注册默认关闭。完成 HTTPS、网关及恢复验收后，可设置 `AH_WORKBENCH_REGISTRATION=true` 开放自助注册，新用户获得一次 10 元模型额度。关闭注册后已开通账号仍能登录。注册限流使用 Harbor 看到的连接来源和邮箱，并有实例级限制。代理后的请求会共享该代理的来源限额。

在开启注册前，部署操作者可用以下命令为现有管理员建立专用邮箱密码身份。凭据文件内容为 JSON 对象 `{ "email": "...", "password": "..." }`，权限设为 0600。命令需要该实例的私有部署配置和数据库访问权限。成功后移除临时凭据文件并通过 HTTPS 验证原管理员及资产，最后再考虑关闭旧网页登录方式。

```sh
node --env-file=/srv/harbor-instance/harbor.env dist/src/service/identity/bind-workbench.js developer /path/to/private-credentials.json
```

认证表随控制库备份。恢复时同时保留认证配置，使用既有账号核对权限、资产和余额。若要暂时阻止新开户，可关闭公开注册并重启。回退认证入口时保留认证表和身份映射，已有邮箱账号需等新入口恢复后再次登录。
