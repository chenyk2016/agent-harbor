# 基础 MCP 使用与边界

本版采用 Claude Code 原生 MCP 客户端：HTTP 直接连接远程服务，stdio 由会话容器内的可信启动器经过 Anthropic Sandbox Runtime（srt）运行。Harbor 管理个人配置、密文凭据、脚本原件和环境生命周期。没有独立 MCP 网关、临时 Grant、固定会话 Binding 或逐工具白名单。

## 构建与升级

```sh
npm ci
npm run build
# 缺少0.4.0/0.6.1基线时先构建；不覆盖正在使用的旧镜像。
docker build -f infra/Dockerfile -t agent-harbor:0.4.0 .
docker build -f infra/Dockerfile.skills -t agent-harbor:0.6.1 .
docker build -f infra/Dockerfile.mcp-native -t agent-harbor:0.6.2 .
```

将服务的 `AH_IMAGE`、`AH_SKILL_IMAGE` 设置为 `agent-harbor:0.6.2`，让新建会话具有本地 MCP 启动器。已有会话固定旧镜像，必须另建使用新镜像的会话；关闭环境不改变原镜像快照。模板程序也必须存在于所选镜像内。运行版本固定 Claude Agent SDK 0.3.306、srt 0.0.81。

升级前停止旧服务，并备份数据库和整个数据根（包括 `.service/.mcp-key`）。现有 SQL 表无需新增迁移。启动时核对旧 Worker 的归属并停止、清理；状态不明则拒绝启动。旧连接保留凭据与历史，但全部停用并标为待复核：打开连接、确认新的全服务授权范围，重新保存后才可启用。API 复核须带 `confirmAllTools: true`，继续提交 `allowedTools` 的旧客户端明确拒绝。旧 Binding 和审计表保留历史，本版不再读写其运行状态。旧 `image` 模板必须改为下文的固定命令，不能自动转换。

删除旧 `AH_MCP_PORT`、`AH_MCP_BIND_HOST`、`AH_MCP_GATEWAY_URL`；本版不监听 MCP 网关端口。此变更与模型网关无关。

## 用户流程

1. 在「MCP 连接」创建远程、管理员本地模板或手写脚本连接。
2. 远程填写 HTTP headers JSON；本地填写模板或脚本声明的环境变量 JSON。留空保留原凭据，`{}` 清空。更换服务目标会清空旧凭据，接口不回显已存凭据。
3. 测试连接，查看原生客户端发现的工具。测试不发送模型提示，不产生模型请求；服务初始化本身仍会联系上游或安装声明的依赖。
4. 启用即允许使用该服务提供的全部工具，包括服务后续新增工具。没有自建工具白名单，范围应由上游账号和 scope 收敛。
5. 当前任务继续使用原环境；下次发送前会比较配置并重建环境。空闲时也可在会话详情点「重新加载 MCP」。保留聊天与工作区，不做运行中的热更新。只改显示名称不会重建环境。

停用连接或改密钥不会即时撤销正在运行的原生请求。需要立即停止本地任务时使用停止按钮；远程已提交写操作的完成情况不能由断线证明，必要时在上游撤销凭据。

## 远程 HTTP

管理员必须通过 `AH_MCP_ALLOWED_ORIGINS` 批准**全部**远程目标的精确 origin，包括公网，例如 `https://mcp.example.com`。默认列表为空；未批准目标拒绝保存或启动。URL 不接受 userinfo、query、fragment；需密钥时使用 headers。显式批准可以接入 HTTP 内网服务，管理员负责判断其可信性。

原生客户端持有真实上游凭据，运行配置和内存中存在副本；受保护的 `/platform` 用于防止项目命令直接读这些文件。原生 HTTP 不经过 Bash/srt 网络代理。本版没有原网关的 DNS 固定、逐跳重定向校验或逐调用撤销检查，批准 origin 也不是完整 SSRF 防护。仅对受信上游启用；不能用于任意互联网服务的安全隔离。通用 OAuth 配置界面后置，既有 WorkBuddy OAuth 沿用原服务，包内 HTTP 同样受管理员目标限制；包内任意 stdio 命令拒绝导入运行。

## 管理员本地模板

默认内置 `text-tools` 提供 `text_stats` 和 `sha256`。也可设置 `AH_MCP_TEMPLATES_FILE` 为管理员 JSON 文件：

```json
[
  {
    "id": "company-tool",
    "name": "公司工具",
    "command": ["/usr/local/bin/node", "/opt/company-tool/server.mjs"],
    "secretKeys": ["API_KEY"]
  }
]
```

命令与参数由管理员固定，首项为绝对可执行路径；不接受 shell/env 包装器、旧 Worker 镜像字段或用户命令片段。支持管理员指定 `npx --yes <固定版本包>` 等包管理器命令；必须自行评估下载、启动耗时及供应链。模板和解释器由管理员准备，不新增每个 MCP 一套镜像调度。

## 手写脚本

用户可在页面创建、编辑自己的 Node/Python 文本脚本包，保存文件 JSON、入口和可用凭据字段。单包最多 100 文件、1 MiB；不接受绝对路径、`..`、符号链接及已安装依赖目录。管理员则直接维护 `<AH_DATA_DIR>/mcp-scripts/admin/<id>/`，其中 `script.json` 声明元数据，其余文件为源码：

```json
{
  "name": "内部查询",
  "entry": "server.mjs",
  "runtime": "node",
  "install": "none",
  "secretKeys": ["API_KEY"]
}
```

管理员脚本对所有用户可选，用户脚本只对本人可见。修改脚本在下一次重建环境生效；原件不会挂载进容器，而是复制到本连接的可写 app 目录。脚本要自行实现 stdio MCP 协议；stdout 只写协议消息。

依赖安装和脚本运行都经过 srt：

| 配置 | 行为 |
| --- | --- |
| Node + none | 系统 Node 直接运行入口 |
| Node + npm | 要求 package.json/package-lock.json，执行 npm ci --ignore-scripts |
| Python + none | 系统 Python3 运行入口 |
| Python + uv | 要求 requirements.txt，创建连接专用 venv 并 uv pip install |

npm 禁用生命周期脚本；需要编译或自定义安装步骤的包可能无法使用。uv 的构建过程仍可能运行包代码，受同样的 srt 限制。网络沿用最终 Claude 受管策略，默认允许官方 npm/PyPI 域名。冷安装太慢可能超过原生 MCP 初始化时限；管理员应预装大型依赖，不自动延长或绕过限制。当前页面提供新增/编辑，尚未提供源码删除和版本回滚界面。

## 隔离与生命周期

`infra/managed-settings.base.json` 和目录约定生成受管策略；DockerBackend 合并会话获准网络后，把同一份最终配置交给 Claude Code，并通过 `mcpSandboxPolicy()` 转成 srt 设置。新增未知安全字段、不支持的凭据模式或沙箱能力不足会拒绝本地启动，没有非沙箱降级。

可信启动器先读受保护启动材料，然后重建干净环境，只交付明确声明的 MCP 参数。不要认为 srt 会自动清除父进程密钥。项目的 Bash 和本地 MCP 共用工作区、依赖缓存及文件/网络边界；不承诺同一用户同一会话中的 MCP 之间相互保密。`/workspace/.env` 等文件只有被管理员共同规则明确禁止才受保护。

本地 MCP 不另建 Worker，资源限制沿用整个会话容器。取消含本地 MCP 的任务会停止并确认清理整个环境，避免一个未完成工具在后台继续写工作区；下一轮从保留的聊天和文件恢复。Docker 查询未知时继续阻止复用。远程请求可能已经产生副作用，不能承诺强制回滚。本版不提供网关专属调用审计或独立 MCP 资源配额。

## 代码阅读与验证

按「保存连接 → 发送消息 → 启动本地进程」阅读：

- `src/service/mcp/http.ts` → `service.ts`：归属、凭据和当前启用配置。
- `src/service/mcp/scripts.ts`：脚本原件和路径检查。
- `src/service/session-manager.ts`：运行摘要变化后关闭原环境。
- `src/runtime/mcp-startup.ts`：复制脚本、生成受保护启动材料。
- `src/docker/docker.ts` → `src/shared/sandbox-policy.ts`：最终共享规则和容器。
- `src/agent/mcp-launcher.ts`：干净环境、srt、安装和 stdio 进程。
- `src/service/mcp/probe.ts` → `src/agent/mcp-probe.ts`：无模型的原生发现。

`npm test`、`npm run check` 为工程检查；`AH_TEST_DATABASE_URL=... AH_IMAGE=agent-harbor:0.6.2 npm run verify:mcp` 使用实际 Docker/Claude Code 与本地模型夹具验证原生调用、依赖和取消，不等同真实模型或第三方账号验收。资源目录与沙箱设计保留在仓库的 `docs/design/resource-layout.md` 与 `docs/design/mcp-native-sandbox.md`。
