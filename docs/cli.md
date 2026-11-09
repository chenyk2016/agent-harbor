---
layout: page
title: 命令行客户端
---

CLI 连接已经启动的 Harbor，会话和任务仍由服务管理。先按 [安装与启动](quickstart.md) 启动服务，并在工作台「用量与密钥」创建一个访问密钥。在本机私有环境提供 `AH_SERVICE_TOKEN`，团队部署同时把 `AH_SERVICE_URL` 指向实际 HTTPS 地址。

```sh
export AH_SERVICE_URL=http://127.0.0.1:4318
# 在私有终端环境注入 AH_SERVICE_TOKEN，再执行下列命令。
npm run cli -- init "分析示例"
npm run cli -- list
```

`init` 返回会话 ID。下面各命令中的 `SESSION_ID` 替换成实际 ID。任务执行前需有可用 [模型和额度](llm-gateway.md)。

| 命令 | 用途 |
| --- | --- |
| `npm run cli -- chat SESSION_ID` | 在一个会话中连续对话 |
| `npm run cli -- run SESSION_ID "解释项目结构"` | 提交并跟踪单轮任务 |
| `npm run cli -- run SESSION_ID --file prompt.txt` | 从文件读取多行任务原文 |
| `npm run cli -- status SESSION_ID` | 查看当前会话、最近消息及状态 |
| `npm run cli -- watch SESSION_ID 0` | 从指定事件游标查看并跟踪输出 |
| `npm run cli -- cancel SESSION_ID MESSAGE_ID` | 停止指定消息 |
| `npm run cli -- close SESSION_ID` | 关闭当前工作环境，保留文件和对话 |

交互中使用 `/exit` 退出只断开客户端。需要终止当前消息时使用 Ctrl+C 或 `cancel`。请求状态不明时先查会话，再以原文和原 `--request-id` 重试。详情见 [会话生命周期](session-lifecycle.md) 和 [故障排查](troubleshooting.md)。

[返回使用指南](guide.md)
