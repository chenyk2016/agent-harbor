# OpenSandbox 执行后端

Harbor 可在专用单机 Linux 上让 OpenSandbox 统一启动和回收执行环境。配置固定 OpenSandbox Server 1.2.0 和 Linux ARM64 execd 1.1.0。未配置时使用原 Docker 后端。

```mermaid
flowchart LR
    H[Harbor 会话协调器]
    O[OpenSandbox 管理服务]
    S[只读根容器]
    R[原生 Claude Runner]
    W[(工作区和会话记录)]
    H -->|创建与删除| O
    O -->|启动及确认回收| S
    H <-->|私有 Unix socket| R
    S --- R
    R --> W
```

官方 Docker 实现在启动前把 execd 和启动脚本写入容器层。这个验证配置在创建容器时就设为只读根，并将校验过的文件从宿主只读挂载。沿用 Harbor 的非 root 用户、能力收回、seccomp、禁止提权、资源上限和独立可写目录。Runner 的标准输入、标准输出及错误输出通过每次执行独占的本地 socket 传输。Harbor 掉线后原生 Runner 连接结束或会话租约失效。管理服务不再获得 Docker 心跳时，其租约也会过期，Runner 随即退出。管理服务重启时作废旧租约，确认清理同数据根的旧容器后再接单。Harbor 交接仍以 Docker 实际确认旧容器消失为准。

## 部署与回切

- 用独立 Docker 引擎、专用命名 bridge、仅监听 127.0.0.1 的管理服务。Docker 必须关闭 `live-restore`，使用 `docker network create --opt com.docker.network.bridge.enable_icc=false <bridge>` 创建网络。用绝对、无符号链接的数据根，由 Harbor 进程的 UID 1000 用户持有。管理服务与 Harbor 必须访问同一本机 Docker 引擎。管理密钥至少 32 字符。
- 从官方 Linux ARM64 execd 镜像取 `/execd` 和 `/bootstrap.sh`。后者保存为 `upstream-bootstrap.sh`，本目录的 `strict-bootstrap.sh` 保存为 `bootstrap.sh`。与本目录的 `runner-bridge.cjs` 一起安装到 root 所有的只读资源目录。固定文件的 SHA-256 在 `strict-runner.py` 中校验。
- 按 1.2.0 的配置格式启用 `runtime.type = "docker"`，设置 `docker.network_mode` 为专用 bridge、`docker.publish_host = "127.0.0.1"`、专用端口段与 `storage.allowed_host_paths`。在 1.2.0 虚拟环境启动 `python infra/opensandbox/strict-runner.py --assets <资源目录> --seccomp infra/seccomp.json --network <bridge> --workspace-root <数据根> --config <配置文件>`。
- 在 Harbor 服务设置 `AH_RESIDENT_BACKEND=opensandbox`、`AH_OPENSANDBOX_RUNNER_ORIGIN` 和 `AH_OPENSANDBOX_RUNNER_KEY`。使用同一镜像和工作区切换。切回时正常停止 Harbor、设置 `AH_RESIDENT_BACKEND=docker` 并启动。只有实际旧容器和创建意图均已核对后才恢复接单。同一管理进程中结果未知的创建会阻止接手。保留 OpenSandbox 配置重启管理服务，使旧代次失效，再重启 Harbor 协调。
- 已启动的 OpenSandbox 会话取消时关闭整个容器。单个容器最长保留一小时，后续显式输入可以重建环境并续用会话。未完成消息保留历史，恢复不主动发送旧输入。已确认用量按原钱包记录结算，响应不完整而崩溃的请求保留待核对。用户显式发送新消息仍可触发新的推理调用。

## 执行范围

| 场景 | 启用配置 | 执行边界 |
| --- | --- | --- |
| 对话、专家、Skills、MCP、本地 CLI | `AH_RESIDENT_BACKEND=opensandbox` | 非 root、只读根、专用工作区和私有通信。 |
| MCP 设置页测试、只读问数 | 同上 | 独立的短任务。问数断网，通过私有通信调用白名单工具。 |
| Skill 依赖安装、应用构建 | 同上 | 安装 Skill 时断网，应用按原配置访问依赖源。输入只读，确认构建进程停止后才交接产物。 |
| 应用预览、正式运行 | `AH_APP_RUNTIME_BACKEND=opensandbox` | 只读根、独立网络和单应用配置。固定入口验证每次部署独有的反向代理凭据。沿用 Caddy 的公开地址、访客鉴权和路由，应用可访问自己的数据库。 |

应用运行须在同一数据根下预建 `<应用数据根>/opensandbox-preview`，由 Harbor 的 UID 1000 持有。应用数据根默认为 `<数据根>/.applications`，可用 `AH_APP_DATA_DIR` 指定。管理服务增加 `--application-root <应用数据根>/opensandbox-preview`，并启用回环端口转发与 `proxy.resolve_internal = true`。应用默认复用 Runner 的管理地址和密钥。若配置 `AH_APP_OPENSANDBOX_ORIGIN` 和 `AH_APP_OPENSANDBOX_API_KEY`，它们须指向具备同一数据根、应用目录及只读规则的管理服务。Caddy 必须从受控网络访问该回环管理端口，通过固定的实例代理路径访问应用。管理 API 仅供内部使用。

迁移应用前，使用现有配置执行「暂停预览」或「正式下线」并确认原实例已停止。启用新的后端后，以原版本重新部署，核对原地址、业务数据和访问权限。回切 Docker、从单应用预览试点切换到完整模式，或更换应用管理密钥时按同样顺序执行。回滚到 Docker 时期的版本会重建镜像，以使用支持私有凭据的固定入口。正式运行使用手动回收的生命周期，管理服务重启保留已托管应用。Runner 和短任务仍按租约及旧容器清理规则恢复。

OpenSandbox 通过本机 Docker 引擎启动容器。Harbor 还使用引擎核对隔离属性，以及通过平台固定且没有 `RUN` 步骤的 Dockerfile 封装应用镜像。应用依赖安装和构建脚本在 OpenSandbox 中执行。

## 隔离验收

- 在空的 Harbor 源码副本运行 `npm run build`。在 UID 1000 下设置 `AH_OPENSANDBOX_DISPOSABLE=1`、`AH_RUNNER_FIXTURE_ROOT`、`AH_STRICT_OPENSANDBOX_ORIGIN`、`AH_STRICT_OPENSANDBOX_KEY` 和 `AH_RUNNER_TEST_IMAGE`（本地已加载的 Harbor 原生 Runner 镜像），运行 `node tests/opensandbox-runner-verification.mjs`。数据根下生成 `qualification.json`。

- 服务级验证运行 `tests/opensandbox-service-verification.mjs`。需要一次性 Ubuntu、Docker 和已迁移的空 PostgreSQL，以及只允许测试用户重启本虚拟机内 Docker 和 `harbor-runner-qualification` 的权限。测试以真实 Harbor 服务、Claude SDK 和钱包执行，供应商由本地响应替代。

管理服务持有本机 Docker 权限，execd 与 Runner 共用容器。面向不受信任的多租户环境、其他宿主架构或切换底层容器运行方式时，需要重新验证隔离和恢复。

上游只读根改动追踪 [Issue #1549](https://github.com/opensandbox-group/OpenSandbox/issues/1549) 与 [PR #1590](https://github.com/opensandbox-group/OpenSandbox/pull/1590)。
