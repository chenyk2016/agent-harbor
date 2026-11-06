# Agent Harbor 服务包

本目录包含已构建的服务、网页、迁移和运维命令。打开 `release-manifest.json` 核对来源提交、文件哈希和运行镜像 ID。Node.js 24.19+、npm 11+、Python 3、Git、OpenSSL、Docker Engine 和 Compose v2 需要在宿主机就绪。

准备清单中 `runtimeImage` 对应的 Docker 镜像。服务包提供 Dockerfile 和已构建产物，可从包根构建；独立构建的镜像 ID 可能与清单中的验证镜像不同。若用于恢复既有会话，应保留并加载该会话原来使用的镜像。

```sh
HARBOR_IMAGE="agent-harbor:local"
HARBOR_DIR="$HOME/agent-harbor-local"

docker build -f infra/Dockerfile.release -t "$HARBOR_IMAGE" .
npm ci --omit=dev --workspaces=false
node dist/src/clients/ops/main.js configure --dir "$HARBOR_DIR" --image "$HARBOR_IMAGE"
node dist/src/clients/ops/main.js install --dir "$HARBOR_DIR"
AH_BOOTSTRAP_ADMIN_KEY="$(openssl rand -hex 32)" \
  node dist/src/clients/ops/main.js init --dir "$HARBOR_DIR" --admin operator
node dist/src/clients/ops/main.js doctor --dir "$HARBOR_DIR" --runtime
node --env-file="$HARBOR_DIR/harbor.env" dist/src/service/server.js
```

首次安装使用空的专用实例目录。在 `http://127.0.0.1:4318/` 使用该实例 `first-admin.key` 中的密钥登录。模型凭据在后台配置，执行实际模型测试会产生供应商请求。团队访问通过管理员配置的 HTTPS 反向代理，OpenSandbox 是需要单独部署的可选执行后端。

[许可证](LICENSE) · [第三方声明](NOTICE)
