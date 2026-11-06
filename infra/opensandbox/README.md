# OpenSandbox 只读 Runner 隔离验收

此目录用于在专用 Linux 主机验证 Harbor 常驻 Runner。固定版本为 OpenSandbox Server 1.2.0 和 Linux ARM64 execd 1.1.0。现有 Harbor 服务继续使用自己的后端配置。

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

官方 Docker 实现在启动前把 execd 和启动脚本写入容器层。这个验证配置在创建容器时就设为只读根，并将校验过的文件从宿主只读挂载。沿用 Harbor 的非 root 用户、能力收回、seccomp、禁止提权、资源上限和独立可写目录。Runner 的标准输入、标准输出及错误输出通过每次执行独占的本地 socket 传输。宿主掉线后，Runner 或租约失效可使旧容器退出。交接仍以 Docker 实际确认旧容器消失为准。

- 用独立 Docker 引擎、专用命名 bridge、空的本地数据根、仅监听 127.0.0.1 的管理服务。数据根由运行验收的 UID 1000 用户持有。管理密钥仅用于本次运行。
- 从官方 Linux ARM64 execd 镜像取 `/execd` 和 `/bootstrap.sh`。后者保存为 `upstream-bootstrap.sh`，本目录的 `strict-bootstrap.sh` 保存为 `bootstrap.sh`。与本目录的 `runner-bridge.cjs` 一起安装到 root 所有的只读资源目录。固定文件的 SHA-256 在 `strict-runner.py` 中校验。
- 按 1.2.0 的配置格式启用 `runtime.type = "docker"`，设置 `docker.network_mode` 为专用 bridge、`docker.publish_host = "127.0.0.1"`、专用端口段与 `storage.allowed_host_paths`。在 1.2.0 虚拟环境启动 `python infra/opensandbox/strict-runner.py --assets <资源目录> --seccomp infra/seccomp.json --network <bridge> --workspace-root <数据根> --config <配置文件>`。
- 在空的 Harbor 源码副本运行 `npm run build`。在 UID 1000 下设置 `AH_OPENSANDBOX_DISPOSABLE=1`、`AH_RUNNER_FIXTURE_ROOT`、`AH_STRICT_OPENSANDBOX_ORIGIN`、`AH_STRICT_OPENSANDBOX_KEY` 和 `AH_RUNNER_TEST_IMAGE`（本地已加载的 Harbor 原生 Runner 镜像），运行 `node tests/opensandbox-runner-verification.mjs`。数据根下生成 `qualification.json`。

本次覆盖单宿主普通会话，使用真实 Claude SDK 和本地确定性模型响应。管理服务为可信本机测试进程。execd 与 Runner 共用容器，真实供应商扣费、跨租户隔离、管理服务和引擎故障、不同宿主与架构、MCP 和专家会话仍需独立验收。

上游只读根改动追踪 [Issue #1549](https://github.com/opensandbox-group/OpenSandbox/issues/1549) 与 [PR #1590](https://github.com/opensandbox-group/OpenSandbox/pull/1590)。
