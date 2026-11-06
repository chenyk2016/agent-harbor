# Resident Runner and streaming-input validation

> 本文记录66f9475时的历史可行性实验。0.3.0已接入正式chat，当前行为见[生命周期](session-lifecycle.md)，正式接入检查为`npm run verify:resident`。以下旧镜像复现命令应在66f9475源码下运行，不要用当前源码覆盖0.2.0镜像。

固定SDK：0.3.306。此实验保留V2默认行为，验证常驻Runner和常驻原生Claude进程的可行性。V2基线提交为`ee932e7`，标签`v2-baseline`；实验位于独立验证分支，没有替换`src/agent/runner.ts`、Controller或CLI。

## 实验结构

```text
验证宿主：持锁、更新心跳、检查实际Docker状态
    │  stdin：message / interrupt / stopTask / close
    │  stdout：带turnId的逐行事件
    ▼
同一容器中的常驻实验Runner
    └── 一次query(AsyncIterable)，同一个原生Claude进程
```

容器由正式DockerBackend创建，沿用原有非root、只读根、自定义seccomp及管理员规则；Keeper仍保留。Runner仅在tests中，通过docker exec -i启动；只读配置文件在初始化时读取一次。每条消息通过持续输入流提交，不逐轮启动Runner，也不逐轮使用resume；整个进程/容器重建后才使用原生resume。

Runner用SDK提供的spawnClaudeCodeProcess接口原样启动原生程序，只额外记录PID，以核实两轮之间没有悄悄重启Claude。身份检查同时使用Runner PID、原生PID、SDK会话ID和Docker实际ID。实验中system/init可以随新消息重复出现，因此不能凭init事件次数判断是否启动了新进程。

模型是本地确定性夹具，真实执行SDK和工具；不使用模型账号、不请求厂商服务，也不把模拟usage换算值当实际账单。

## 运行

先安装依赖，并确保有可用的V2基础镜像：

```sh
npm ci
npm run build
docker build -f infra/Dockerfile -t agent-harbor:0.2.0 .
docker build -f tests/streaming.Dockerfile -t agent-harbor:streaming-test .
npm run verify:streaming
```

结果按运行编号保存在`var/evidence/streaming/<run-id>/`，`latest.json`指向最新一次；旧实验与失败原件保留。不要把这些原始输出提交到Git。

## 实测结果

10组实际Docker/SDK实验通过：

| 场景 | 观察 |
| --- | --- |
| 同进程多轮 | 两条持续输入、原生Bash/Read、同Runner/原生PID/会话ID，只有一次原生进程启动 |
| 文件权限 | 原生Write/Edit正常，读取平台配置被拒绝，未向模型返回测试Token |
| 输入控制与软中断 | 忙时新消息、错误轮次中断、重复消息ID被拒绝；普通前台写入者中断后停止，同一进程接收下一轮，still_queued为空 |
| 原生后台任务 | 使用原生Bash的run_in_background；跨轮继续运行，中断前台后仍运行，stopTask单独停止它 |
| 预算 | 同一次query内跨用户消息累计，耗尽后新消息仍受限，不再发起模型请求 |
| maxTurns | 返回error_max_turns后，同一流可以处理下一条消息，仍是同一个原生进程 |
| 后端输入EOF | 实验Runner退出，受控前台写入者未继续写；宿主仍执行容器停止确认 |
| 抗软信号 | 本例抗SIGINT/SIGTERM前台进程仍可被SDK中断；保留有界容器强停兜底 |
| Runner强杀 | 仅强杀Runner后，写入者与容器仍存活；宿主强停后确认无续写 |
| 环境重建恢复 | 关闭并替换容器后，流式query通过原生resume恢复相同会话ID、对话与工作文件 |

这10组是场景组，不是10条简单断言。信号抵抗和Runner强杀分别单列执行，普通中断与文件权限也分别检查。短时无续写仅证明所用受控探针的行为，不代表任意工作负载的停止证明。

## 影响正式设计的结论

**可以进入正式实现设计。** SDK持续输入和原生任务控制可用，无需自行实现模型工具循环。但以下语义必须单独落实：

- `interrupt()`中断当前前台执行，不等于关闭全部后台任务。后台任务需要按task_id归属、跟踪与停止，不能收到回执就认定环境静止。
- 本版本普通中断返回`error_during_execution`，所以产品需要结合自己记录的取消意图判断cancelled，不能只看SDK结果子类型。
- `total_cost_usd`在同一query内累计，不应逐轮相加；恢复原生状态后还需核对计费基线。maxBudgetUsd也不是默认每条用户消息重置的预算。
- 实验预算0.0008时，两次模拟模型调用的累计估算达到0.0012后返回预算错误；不能将SDK预算当作不会超支的硬账本。后续输入仍受限且没有额外模型请求。
- Runner进程死亡不证明其原生子进程和容器停止。宿主必须监控后端通道/exec退出，失效时执行容器清理并确认，之后才能释放锁或恢复。
- 当前原型只允许一个前台请求；后台通知可在无前台轮次时出现，需保留task_id关联，不能把它误认为下一条用户消息的结果。
- 实验输入通道是“宿主到Runner”的后端通道，不是最终用户连接。实现多用户服务时应由独立服务持有该通道；客户端断开保留多久，须单独制定。
- 之前发现的V2心跳文件复用/遗留容器协调时机问题仍在基线中，本实验没有修改它。正式实现应在新租约生效前处理旧环境，使用每次服务所有权独立的租约身份。

## 验证边界与保留失败

只覆盖固定SDK、当前本地Docker/Linux组合和测试工具；未做吞吐/延迟基准，未请求真实模型，未验证高并发多租户、长时间稳定性、服务端鉴权或账本。

第一次补充强杀Runner实验时，镜像没有独立kill可执行文件，故障注入命令失败；该轮9/10，未将注入失败算通过。确认工具缺失后改为受信Node进程发送SIGKILL，复验10/10；旧记录留在对应运行编号下。

官方输入模式说明：<https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>。这里的结论以固定版本实测为准，不假定将来版本保持相同行为。
