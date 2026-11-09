# MCP、Skill 的目录与缓存

2026-10-27 实施方案。基础 MCP 沿用已有 Skill 存储和 npm/uv/pip 原生缓存，不引入 `/opt/harbor-resources`、通用产物库或全目录迁移。

## 宿主数据根

以下路径均相对于 `AH_DATA_DIR`，只有选中脚本的运行副本进入容器。

```text
<AH_DATA_DIR>/
├── .service/
│   └── .mcp-key                  # 数据库MCP凭据的加密主密钥
├── mcp-scripts/admin/<id>/        # 管理员手写原件
│   ├── script.json               # 入口、运行时、安装方式、凭据字段
│   └── server.mjs / server.py ...
├── users/<owner-key>/mcp-scripts/<id>/
│   ├── script.json               # 用户自己的元数据
│   └── server.mjs / server.py ... # 用户自己的原件
├── .dependency-caches/<cache-key>/
│   ├── npm/                      # npm自带的下载缓存
│   ├── uv/                       # uv自带的缓存
│   └── pip/                      # pip自带的缓存
└── <session-id>/
    ├── workspace/                # 会话文件与成果
    ├── claude-state/             # 原生对话/状态，受保护
    ├── dependency-env/           # 会话可写依赖环境，兼容原Skill路径
    │   ├── home/ venv/ node-global/ ...
    │   └── mcp/<connection-id>/
    │       ├── app/              # 源码运行副本和自然生成的node_modules
    │       ├── home/             # 本连接HOME
    │       └── venv/             # 选择uv安装时的Python环境
    ├── capabilities/             # 原Skill/专家装配路径不变
    └── attempts/<attempt-id>/
        ├── connection.json       # 可信SDK使用的MCP配置，含远程凭据
        ├── mcp-<connection-id>.json # 可信启动器读取的本地参数
        ├── managed-settings.json # 本环境最终受管策略
        └── mcp-sandbox.json      # 从同一策略派生的srt规则
```

owner-key 由用户ID做 SHA256 后取前32位；cache-key 由 `user:<用户ID>` 做完整 SHA256。CLI 没有用户身份时退回会话独享缓存。哈希只是稳定目录键，归属授权仍由服务完成。

## 容器视角

| 路径 | 内容与权限 |
| --- | --- |
| /workspace | 本会话可写工作区 |
| /session-env | 本会话可写运行环境，MCP运行副本在mcp子目录 |
| /dependency-cache | 同一用户在任务中的原生包缓存，Bash与本地MCP共用；不同用户分开挂载 |
| /platform/state | Claude状态，仅可信Runner使用，沙箱内禁止读取 |
| /platform/run | 启动材料，只读挂载且沙箱内禁止读取 |
| /platform/runtime | 平台Runner代码，沙箱内禁止读取 |
| /etc/claude-code | 受管设置，只读且沙箱内禁止读取 |
| /opt/harbor-runtime | 镜像内可信srt、启动器和内置MCP程序，不存用户密钥 |

启动器给包管理器设置 `npm_config_cache=/dependency-cache/npm`、`UV_CACHE_DIR=/dependency-cache/uv`、`PIP_CACHE_DIR=/dependency-cache/pip`；由工具自己维护索引、下载和去重。`nvm` 管理解释器版本，本版固定镜像中的 Node，不引入可写 nvm 安装。uv 禁止自动下载 Python，使用镜像解释器。

技能安装器按锁文件下载的准备材料和断网构建产物另由技能模块管理，不使用本表的运行时npm/uv缓存。缓存不是已安装依赖环境。node_modules 留在各 app 的自然路径，Python venv 留在本连接目录，不把可写安装目录跨用户或跨会话共用。缓存的并发由包管理器负责；同一用户的程序仍可以读写自己的共享缓存，不承诺防止同用户缓存污染。

源码编辑写回原件；环境重建会从原件刷新 app，运行时对 app 的修改不会回写源码。聊天、工作区与依赖根保留，app重建时 node_modules需要重新安装并复用缓存。脚本原件、密钥和数据库应备份；运行材料与包缓存不是正式源码。关闭环境后清空其中的运行凭据，未知清理状态不得重用会话。
