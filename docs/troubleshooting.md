# 故障排查

先分清是服务启动、登录、模型请求，还是任务容器出现问题。托管安装从以下免费检查开始。

```sh
HARBOR_DIR="$HOME/agent-harbor-local"
docker info
npm run harbor -- doctor --dir "$HARBOR_DIR"
curl --fail --silent --show-error http://127.0.0.1:4318/api/health
npm run harbor -- verify --dir "$HARBOR_DIR"
```

## 安装和启动

| 现象 | 核对 |
| --- | --- |
| Docker 连不上 | 检查 Docker Engine 是否运行、当前账号是否有权限、Compose v2 是否可用 |
| 端口被占用 | 核对 4318、55432、4320、55433。Linux 还用 4317 作 Runner 推理入口。新实例用 `configure` 的参数指定新端口 |
| 找不到表或迁移缺失 | 先停止 Harbor。托管部署运行该实例的 `harbor install`；源码手工部署用正确数据库连接运行 `npm run db:migrate` |
| `AH_BOOTSTRAP_ADMIN_KEY_REQUIRED` | 在私有环境文件中配置密钥，或在首次 `harbor init` 时传入 |
| `BOOTSTRAP_CREDENTIAL_WRITE_UNCONFIRMED` | 保留现场和初始化检查点，按[初始化说明](deployment.md#管理员与模型初始化)核对文件与哈希 |
| 网页可开但 `ready: false` | 查看宿主服务日志和 Docker 状态。先核对旧 Runner 或未完成的恢复操作，避免在状态不明时再次提交 |

## 登录和调用模型

| 现象 | 核对 |
| --- | --- |
| 访问密钥登录失败 | 确认是本实例的 Harbor 访问密钥、账号未停用、网页登录方式已启用 |
| 邮箱登录或注册入口缺失 | 核对迁移、`AH_PUBLIC_ORIGIN` 与认证密钥。自助注册还需要 HTTPS、托管钱包网关可用且未显式关闭 |
| 管理员密钥改值后不生效 | 检查服务实际加载的文件、是否仍有同名进程变量、单个 `AH_ADMIN_USERS` 和服务是否已重启 |
| 模型接入测试失败 | 按向导区分网关同步、供应商密钥、模型权限、余额、工具或流式失败。修复后在同一向导重试 |
| 反代后登录循环或 Origin 错误 | 地址栏来源、`AH_PUBLIC_ORIGIN`、Cookie HTTPS 属性须一致。优先查固定来源，不依赖转发头推断 |
| 没有可用模型、调用被拒绝 | 查看部署状态、用户访问权限、四项价格、余额及预占。上游可连接仍需验证工具调用与流式响应 |
| 密码可以登录，Google 回跳失败 | 查当前应用环境的客户端、准确回调 URL、允许的测试账号和认证域 TLS。按[访客登录说明](application-login.md#可选-google-登录)核对后端路径 |

`harbor doctor` 的 configuration 项会说明可选功能的配置缺项。该项通过并不证明 Caddy 或应用库已经可用。应用实际运行仍需按[应用指南](applications.md#验证入口与边界)验收。

## 任务、预览和恢复

- **任务发送后状态不明**。重新打开原会话查看消息和事件。界面允许重试时沿用原提交，避免把同一任务当成新消息重复发送。
- **任务无法启动**。执行 `harbor doctor --runtime` 检查固定镜像、Docker 资源和原生沙箱。在改权限配置前保留错误码和检查报告。
- **预览出现 502 或待核对**。在应用工作台查看对应环境的操作记录，检查 Caddy、目标容器和 PostgreSQL。先执行「核对运行状态」，再根据结果决定重建预览或处理正式部署。
- **恢复失败**。保留失败目标和日志，核对包版本、固定镜像、备份哈希和空数据库条件。使用新空目标重试。[恢复步骤](deployment.md#停机备份与新实例恢复)
- **删除未完成**。待文件传输结束后通过原对象重试清理，查看删除回执。[删除规则](deletion.md)

提交问题时提供版本或提交、宿主系统与 Docker 版本、触发步骤、期望结果、脱敏错误码和检查结果。凭据、原始会话和真实用户文件保留在私有环境。漏洞走 [私密报告渠道](../SECURITY.md)。
