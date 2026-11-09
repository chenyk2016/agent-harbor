---
layout: page
title: 安装与启动
---

这篇指南面向首次部署者：取得源码、启动实例、登录管理员。已有团队账号的成员可直接看 [第一个任务](first-task.md)。

## 检查环境

准备 Node.js **24.19+**、npm **11+**、Python 3、Git、OpenSSL、运行中的 Docker Engine 和 Compose v2，以及用于镜像、依赖和任务文件的可用磁盘空间。推荐 Linux 专用主机。macOS 可用于本地运行，安装后用 `doctor --runtime` 检查实际兼容性。

```sh
node --version
npm --version
python3 --version
git --version
openssl version
docker info
docker compose version
```

默认需要空闲的宿主端口 4318（工作台）、55432（控制库）、4320（模型网关）、55433（网关库）。Linux 还使用工作台端口减 1 提供 Runner 推理入口。端口冲突时在 `configure` 设置不同的端口。

## 构建并安装

先取得源码，再保持同一个终端完成下面步骤。实例目录用于保存配置和数据，首次使用时应为空。

```sh
git clone https://github.com/chenyk2016/agent-harbor.git
cd agent-harbor
npm ci
npm run build

HARBOR_DIR="$HOME/agent-harbor-local"
HARBOR_IMAGE="agent-harbor:local"
docker build -f infra/Dockerfile.release -t "$HARBOR_IMAGE" .

npm run harbor -- configure --dir "$HARBOR_DIR" --image "$HARBOR_IMAGE"
npm run harbor -- install --dir "$HARBOR_DIR"
```

`configure` 生成实例配置；`install` 启动专用数据库和模型网关，并初始化所需数据结构。若已取得源码，可以跳过克隆和进入目录两行。

## 初始化管理员

```sh
AH_BOOTSTRAP_ADMIN_KEY="$(openssl rand -hex 32)" \
  npm run harbor -- init --dir "$HARBOR_DIR" --admin operator
```

初始化后，用编辑器打开实例目录中的 `first-admin.key`，将登录密钥保存到密码管理器。也可以在首次运行 `init` 前把密钥写进实例私有的 `harbor.env`，后续由该文件管理。 [管理员密钥设置](identity.md)

## 启动并登录

```sh
npm run harbor -- doctor --dir "$HARBOR_DIR" --runtime
node --env-file="$HARBOR_DIR/harbor.env" dist/src/service/server.js
```

打开 **http://127.0.0.1:4318/**，选择访问密钥登录，使用环境文件中配置的密钥，或初始化时写入 `first-admin.key` 的密钥。首次登录后查看管理员入口。另开终端验证依赖与服务，路径沿用上面的实例目录。

```sh
curl --fail --silent --show-error http://127.0.0.1:4318/api/health
npm run harbor -- verify --dir "$HOME/agent-harbor-local"
```

预期网页可打开、`/api/health` 返回 `ready: true`、免费检查通过。登录后按 [模型与网关](llm-gateway.md) 接入首个模型，再发送任务。

## 停止与再次启动

前台运行时用 Ctrl+C 停止 Harbor 服务。此操作保留实例数据和依赖容器。下次从同一个源码目录执行「启动并登录」中的 `node --env-file=...` 即可。若 Docker 或依赖也已停止，先保持 Harbor 停止，运行 `harbor install` 恢复依赖，再启动服务。

默认使用 Docker 执行环境。可选执行后端见 [配置参考](configuration.md)。

继续 [接入模型](llm-gateway.md) → [完成第一个任务](first-task.md)，或查看 [故障排查](troubleshooting.md)。

[返回开始使用](getting-started.md)
