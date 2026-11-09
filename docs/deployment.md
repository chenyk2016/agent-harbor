---
layout: page
title: 团队部署与备份
---

这一页帮助部署管理员把已安装的 Harbor 提供给受信团队，并安排后台运行、检查和备份。首次安装先读 [安装与启动](quickstart.md)。

## 部署前准备

推荐使用专用 Linux 主机，准备域名、HTTPS 反向代理、独立实例目录和备份位置。服务账号需要访问实例目录和 Docker；用户任务不能获得宿主 Docker 管理权限。

下文假定实例位于 `/srv/harbor-instance`，工作台端口为 `4318`，命令在项目根目录执行。替换为你的实际路径。数据库、网关管理接口和内部推理入口只向必要的内部来源开放。

## 配置团队 HTTPS 入口

1. 将团队域名指向反向代理所在服务器。
2. 配置反向代理转发到 Harbor。Caddy 与 Harbor 在同一宿主机时可用：

   ```caddyfile
   harbor.example.com {
       reverse_proxy 127.0.0.1:4318
   }
   ```

3. 在实例的私有 `harbor.env` 中设置浏览器实际使用的地址：

   ```dotenv
   AH_PUBLIC_ORIGIN=https://harbor.example.com
   AH_WORKBENCH_REGISTRATION=false
   ```

4. 重启 Harbor，通过 HTTPS 登录并提交一个短任务，检查结果能持续显示，刷新后能找回会话。
5. 按 [账号与登录](identity.md) 配置管理员邮箱和成员注册，再按 [模型接入](llm-gateway.md) 分配可用模型。

公开地址应与浏览器地址完全一致，不带路径或末尾斜线。反向代理需要支持长连接，及时转发任务事件。开启自助注册前先确认成员范围和额度规则。

## 后台运行

Linux 部署可以生成 systemd 服务文件。以下假定系统中已有 `harbor` 服务账号，且它拥有必要的目录和 Docker 权限。

```sh
npm run harbor -- service --dir /srv/harbor-instance --user harbor
```

生成的主服务文件位于实例目录的 `agent-harbor.service`。检查其中的程序路径、用户和环境文件路径，停止前台运行的 Harbor 后，再安装并启动：

```sh
sudo cp /srv/harbor-instance/agent-harbor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-harbor
sudo systemctl status agent-harbor
```

查看运行日志：

```sh
sudo journalctl -u agent-harbor -n 100
```

服务重启后不会自动重发未完成的用户任务。成员应回到原会话查看结果，再决定是否继续。

## 日常检查与可选通知

```sh
npm run harbor -- doctor --dir /srv/harbor-instance
npm run harbor -- verify --dir /srv/harbor-instance
```

这些检查查看配置、依赖和网页状态，不调用付费模型。任务结果仍需在工作台实际核对。

需要故障与恢复通知时，可先运行一次采样：

```sh
npm run harbor -- monitor --dir /srv/harbor-instance
```

默认将变化写入实例的 `last-alert.json`。配置 `AH_ALERT_WEBHOOK` 和可选的 `AH_ALERT_WEBHOOK_TOKEN` 后可发送通知。持续采样需要管理员启用生成的 `agent-harbor-monitor.service` 与 `agent-harbor-monitor.timer`；仅生成文件或运行一次命令不会持续监测。

## 停机备份与新实例恢复

备份前结束任务、停止应用实例和 Harbor 主服务，确认没有后台写入；保留实例数据库运行。使用新的、位于实例目录之外的备份目录：

```sh
npm run harbor -- backup --dir /srv/harbor-instance \
  --output /secure/backups/harbor-001
```

内置备份包含工作台控制库、模型网关库、完整数据目录和私有配置，涵盖会话、文件、账号和内部额度记录。它**不包含应用独立业务数据库、独立观测库、运行镜像和云端 Langfuse 数据**。启用这些功能时，应分别备份，并保留应用版本对应的镜像。

备份含凭据和用户内容，应加密保存并限制访问。符号链接只保存链接本身，不复制链接指向的外部文件。

恢复使用与备份匹配的程序版本和镜像，并选择新的空实例、空数据库及未占用端口：

```sh
npm run harbor -- configure --dir /srv/harbor-restored \
  --image agent-harbor:YOUR_RELEASE \
  --port 4418 --db-port 55532 --gateway-port 4420 --gateway-db-port 55533
npm run harbor -- restore --dir /srv/harbor-restored \
  --source /secure/backups/harbor-001
npm run harbor -- install --dir /srv/harbor-restored
```

恢复前不要对目标执行 `install` 或 `init`。恢复命令会检查文件完整性、程序版本和空目标，拒绝覆盖已有实例。

启动前核对新地址、登录回调和可选功能配置；应用数据库、观测库需按各自备份单独恢复。然后启动服务：

```sh
node --env-file=/srv/harbor-restored/harbor.env dist/src/service/server.js
```

用原账号确认历史、文件、权限、余额和流水，再运行 `doctor` 与 `verify`。失败时保留日志和目标现场，换新的空目标处理，避免覆盖唯一可用备份。

[返回配置与管理](manage.md)
