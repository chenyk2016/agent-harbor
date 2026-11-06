# 常驻 Runner 与持续输入

本文保留V2设计与0.3.0接入记录；V3已加入原生中断保留环境及独立服务，当前行为见[生命周期](../session-lifecycle.md)。

## 授权与依据

用户已授权：官方文档确认支持后实施，不再重复技术可行性实验。2026-10-21核对官方[流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)说明：推荐持久交互会话，TypeScript使用`query({prompt: AsyncIterable})`，支持多轮上下文和中断。固定SDK 0.3.306沿用上轮实验结果。

## 目标与范围

`chat`正常多轮复用容器、Runner和原生Claude进程；`run`保留一次性执行。CLI操作方式不变，尚不增加HTTP服务、认证或客户端断线保活。

## 实现约定

- Controller.open先持锁并协调遗留容器，再建立每次所有权独立的`.leases/<uuid>`心跳；Keeper只跟踪自己的租约。首条消息才启动容器和Runner。
- 宿主以`docker exec -i`建立后端管道。stdin逐行JSON：message携带Task；interrupt携带attemptId；close关闭输入。stdout携带sessionId、runnerId、全流seq和可选的attemptId/generation。
- Runner读取启动配置一次，创建一次query和异步消息队列。每轮只向队列提交SDKUserMessage，不重新query或resume。只接受一个前台请求，重复或忙时输入拒绝。
- SDK result结束一轮，不结束输入流。宿主保存每轮结果；原生task事件按task_id关联创建它的轮次，未知归属只保存在Runner级日志，不能投递给下一轮。
- 取消、超时和协议/进程错误沿用整容器停止确认；不会把interrupt回执当作全部后台任务停止证据。正常结果保留环境；取消后下一条新输入重建并resume，不重放上一条任务。
- 监控后端输出结束和exec失败，包括空闲期间；立即停止容器并保存失败/未知状态。停止不确定时阻止后续输入。
- Profile.maxBudgetUsd用于一个常驻query的累计估算预算；usage是每轮量，costUsd是原生会话累计估算，不能逐轮相加。不实现租户账本；拒绝会重置会话的原生/clear、/reset和/new。
- 连接凭证保存在启动attempt，只在环境关闭后清空；每条消息仍保留task/events记录。run保持原来的每轮凭证生命周期。
- 新镜像版本0.3.0，旧0.2.0镜像不覆盖；已有原生状态仍保留镜像兼容检查，不自动升级。

## 验收

- 单元测试覆盖复用同一后端进程、背景事件归属、忙时/重复与身份拒绝、取消与Runner故障清理、引擎未知阻止新写入者、新租约不会更新旧心跳。
- 类型检查、现有一次性运行测试与公开内容审计通过。
- 不重复运行旧10组可行性实验；新正式接入的Docker/SDK集成验证与真实模型验收单独记录，未执行不冒充通过。

## 后续

独立服务持有Conversation、客户端重连/事件回放、按任务停止、租户授权与预算账本分开实施；本次不把CLI宣称为后台服务。

## 官方核查补充

官方[费用与用量](https://code.claude.com/docs/en/agent-sdk/cost-tracking)说明：流式输入中每轮有result，usage属于本轮，total_cost_usd属于累计估算；resume恢复的历史费用包含在累计结果中，但不计入新query自身预算。估算不是正式账单。本项目固定版本仍以历史实测与本次接入检查为边界。

## 0.3.0接入结果

- 25项单元测试及类型检查通过，覆盖常驻复用、后台归属、取消创建竞态、空闲崩溃、未知停止和元数据失败。
- 正式Controller.open路径3组实际Docker/SDK检查通过：同Runner/原生PID两轮、取消写入者后重建resume、空闲Runner强杀后宿主回收并恢复。使用本地模型夹具，未调用真实模型。
- 镜像0.3.0独立构建，0.2.0保留；真实模型、跨旧镜像恢复、长期稳定性及多用户服务仍未验收。原始输出位于本机忽略的var/evidence/resident。
