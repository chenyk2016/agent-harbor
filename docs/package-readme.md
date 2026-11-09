# Agent Harbor 服务包

本目录包含已构建的服务、网页、迁移和运维命令。打开 `release-manifest.json` 核对来源提交、文件哈希和运行镜像 ID。Node.js 24.19+、npm 11+、Python 3、Git、OpenSSL、Docker Engine 和 Compose v2 需要在宿主机就绪。

## 准备匹配的运行镜像

服务包通过 `release-manifest.json` 固定 `runtimeImage` 和 `runtimeImageId`。请取得发行者提供的匹配镜像并加载，例如：

```sh
docker load --input /absolute/path/to/harbor-runtime.tar
```

用 `docker image inspect <runtimeImage>` 核对实际 ID 与清单一致。服务包本身不包含镜像归档；从 Dockerfile 本地重建可能得到不同 ID，安装会拒绝不匹配镜像。不要改清单绕过校验；需要自行构建时，应从源码按对应提交构建并重新生成服务包。

## 安装和配置管理员

将下面的镜像值替换为清单中的 `runtimeImage`。首次安装使用空的专用实例目录。

```sh
HARBOR_IMAGE="replace-with-manifest-runtime-image"
HARBOR_DIR="$HOME/agent-harbor-local"

npm ci --omit=dev --workspaces=false
node dist/src/clients/ops/main.js configure --dir "$HARBOR_DIR" --image "$HARBOR_IMAGE"
node dist/src/clients/ops/main.js install --dir "$HARBOR_DIR"
```

用 `openssl rand -hex 32` 生成密钥。在实例 `harbor.env` 中修改或添加下面两项，保留已有数据库等配置：

```dotenv
AH_ADMIN_USERS=operator
AH_BOOTSTRAP_ADMIN_KEY=replace-with-your-generated-random-key
```

保存后初始化并启动，始终加载同一环境文件：

```sh
node dist/src/clients/ops/main.js init --dir "$HARBOR_DIR" --admin operator
node dist/src/clients/ops/main.js doctor --dir "$HARBOR_DIR" --runtime
node --env-file="$HARBOR_DIR/harbor.env" dist/src/service/server.js
```

在 `http://127.0.0.1:4318/` 使用环境文件中的管理员密钥登录。更换密钥只需修改文件并重启。模型凭据在后台配置，实际模型测试会产生供应商请求。团队访问通过管理员配置的HTTPS反向代理；OpenSandbox需要单独部署。

[许可证](LICENSE) · [第三方声明](NOTICE)
