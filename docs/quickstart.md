# 本地安装与启动

这一页从已取得的 Agent Harbor 源码开始。先把工作台跑起来并用首次管理员密钥登录。配置模型和发送任务在下一页进行，以下步骤不会发起模型推理。

## 检查环境

准备 Node.js **24.19+**、npm **11+**、Python 3、Git、OpenSSL、运行中的 Docker Engine 和 Compose v2，以及至少 1 GiB 实例目录可用空间。推荐 Linux 专用主机。macOS 可用于 Docker 开发验收，原生沙箱兼容性以 `doctor --runtime` 的实际结果为准。

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

从源码仓库根目录运行。保持同一个终端完成下列步骤。目录变量指向本次安装专属位置，首次使用时目录应为空。

```sh
npm ci
npm run build

HARBOR_DIR="$HOME/agent-harbor-local"
HARBOR_IMAGE="agent-harbor:$(git rev-parse --short HEAD)"
docker build -f infra/Dockerfile.release -t "$HARBOR_IMAGE" .

npm run harbor -- configure --dir "$HARBOR_DIR" --image "$HARBOR_IMAGE"
npm run harbor -- install --dir "$HARBOR_DIR"
```

`configure` 生成实例配置，`install` 启动实例专用 PostgreSQL 和 LiteLLM 并执行迁移。若使用维护者提供的固定发行包，参照 [发行包安装](deployment.md#固定版本与安装)。

## 初始化管理员

```sh
AH_BOOTSTRAP_ADMIN_KEY="$(openssl rand -hex 32)" \
  npm run harbor -- init --dir "$HARBOR_DIR" --admin operator
```

首次 `init` 必须收到这个变量，接受 32 至 128 位字母、数字、下划线或短横线。这里由 OpenSSL 生成密钥，初始化后保存在实例目录的 `first-admin.key`，文件权限为 0600。请通过受控方式读取并放进密码管理器。如需通过环境文件管理密钥，可将该变量放入服务读取的环境文件，修改后重启生效。

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

预期网页可打开、`/api/health` 返回 `ready: true`、免费检查通过。登录后还需要设置模型和额度才能发送模型任务。

## 停止与再次启动

前台运行时用 Ctrl+C 停止 Harbor 服务。此操作保留实例数据和依赖容器。下次从同一个源码目录执行「启动并登录」中的 `node --env-file=...` 即可。若 Docker 或依赖也已停止，先保持 Harbor 停止，运行 `harbor install` 恢复依赖，再启动服务。

继续 [配置模型并完成第一个任务](first-task.md)，或查看 [启动排障](troubleshooting.md)。
