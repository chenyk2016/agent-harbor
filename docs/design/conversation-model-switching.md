> **历史设计范围（2026-11-09核对）**：本文保留2026-10-28模型切换设计与当时验收，不是当前部署/计费总说明。当前首页也支持选择模型并发送即创建；模型配置见[模型与网关](../llm-gateway.md)，费用见[额度与计费](../wallet.md)。

# 输入框模型选择与网关路由切换

2026-10-28实施。用户选择下一条消息的模型，由会话Key级映射改变实际上游；Claude逻辑模型不变。实现任务T-20261028-agent-harbor-model-switching。

## 交互

输入框右下角常驻模型选择。目录只包含当前用户获准且同步就绪的模型。选择保存在本人浏览器的单会话草稿中；不立即改网关，也不改变个人默认。发送时冻结正文、modelId和clientMessageId。

生成中可选择下一条草稿模型，当前轮不变；不增加排队或并行Runner。消息记录展示本轮请求/网关确认模型，历史未记录则显示未知。目录读取失败/所选模型不可用会禁用新发送；服务器仍重新验证权限。空会话保留原新建流程，选择器在现有会话输入框中工作。

## 调用链

```text
输入框发送 text + modelId + clientMessageId
    → 归属、权限、忙状态、重复请求校验
    → messages固定请求模型快照
    → LiteLLM Key aliases和models更新并读回
    → 保存model.activated事件和本轮确认模型
    → 同一Runner继续Claude原生循环
```

新Key给Runner的逻辑名为ah-session-model。Key aliases将其映射为当前实际deployment alias，models只放行这个实际模型。Key的URL、Token、逻辑名和bindingId在普通模型切换中保持不变，因此已有connectionDigest不会触发环境重建。主/辅助模型在启动时都使用同一逻辑名，网关统一映射。

映射只改该会话Key，不改全局别名；同用户不同会话也独立。Key过期、连接/MCP变更、运行失败等仍可能按原生命周期重建环境，不能承诺所有情形都永不重建。

## 持久化与失败

0008迁移新增messages.requestedModelId、modelSnapshot、activatedModelSnapshot，字段可空以兼容旧数据。sessions.modelSnapshot表示最近网关确认的目标，不改写旧消息。model.activated说明路由确认，不证明供应商底层权重身份或任务成功。

去重包含正文和原始modelId；相同ID换模型返回409。省略modelId的旧客户端首次接受时固定会话选择，重复请求返回原消息，不重新解析默认。浏览器待确认请求保存原模型，后来改草稿不影响重试。

网关写前保存provisioning意图；更新失败或读回不一致则不发送用户提示。不会自动在旧模型执行；既有异常清理会撤销Key、终止环境，清理未知保持reconciling。服务崩溃沿用停止旧环境和撤销旧Key的恢复流程，不自动重放消息。

SDK报告task_started/task_progress时记录后台任务，task_notification移除；仍有已知后台任务则拒绝改变模型，返回MODEL_BACKGROUND_BUSY。进程级任意后台程序不是模型任务，不以它们推断模型请求完成。对未上报的后台模型调用不作完全隔离承诺。

同一Key可能用于多个模型，费用保留会话累计总额；所有曾选择模型都参与计价完整性判断，缺失计价不可显示免费。未实现精确每轮费用、供应商结算或用户累计硬预算。

## 修改与验证

- UI：ComposerModelPicker、Chat、LocalState、Workspace、ConversationState。
- 服务：消息接口、SessionManager、ServiceStore与消息模型字段。
- 网关：LlmService按会话稳定Key动态设置aliases/models并读回，旧逻辑名兼容从原绑定解析。
- 原生Agent循环、工具和Runner不改造，不调用setModel来模拟上游切换。

确定性验证包含固定LiteLLM v1.106.1的/v1/messages A→B→A、预热缓存失效和双Key隔离。真实Docker/SDK验证同容器/Runner/原生会话/Key、聊天内事实保留和工具目标一致；浏览器验证生成中改下一轮、刷新保存、桌面/手机布局。

现有4318服务进一步用获准DeepSeek Flash→V4 Pro→Flash三轮验证，聊天暗号保留，Write/Read成功；此小样本不证明所有模型的thinking、图片、压缩历史、上下文窗口或复杂任务兼容。

复现入口：tests/model-switching-verification.mjs；必须使用隔离LiteLLM/PG。本轮私有证据在var/evidence/model-switching/2026-10-28，配置/Key/运行记录不入Git。启动及迁移参见../llm-gateway.md。

## 取舍

用户指出可在网关转发层切换后，采用本方案取代此前“每次换模型重建环境”的建议。原生setModel或原生resume不作为此功能主路线。必要验证集中在真实Messages转发、Key授权、缓存失效、后台请求边界和按轮记录。

官方机制：https://docs.litellm.ai/docs/proxy/virtual_keys#model-aliases 。以固定部署测试为准，不能只依赖文档或/key/info声明成功。
