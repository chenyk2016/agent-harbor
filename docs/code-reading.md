# 从一条消息阅读V3

先读正常执行，再读中断和故障。每层只承担自己的职责。

```text
clients/cli/main：用户提交
  → clients/service-client.send：HTTP，重试保留同一个请求ID
  → service/http-api：身份、归属、正文
  → service/session-manager.submit：去重、容量、保存accepted、占位
  → session-manager.execute：服务持有Conversation和取消控制器
  → runtime/conversation.run：准备、启动、等待结果、收尾
  → runtime/runner-channel.run：通过Docker管道发一行JSON
  → agent/resident-runner：异步输入源送给同一次query
```

回答沿相反方向返回：Runner事件→Conversation.recordEvent→SessionManager.notice→ServiceStore事务→event-stream→ServiceClient.events→CLI显示。SDK的result之后还要等运行层收尾，服务才保存message.finished。

## 按问题找模块

| 问题 | 文件/函数 |
| --- | --- |
| 客户端断开为何任务继续？ | session-manager的live表与服务自己的AbortController，event-stream只读库 |
| 请求重试为何不会重复执行？ | submit先查duplicate；ServiceStore.accept事务和唯一索引 |
| 多行消息为何不会切断？ | JSON.stringify编码换行；Runner按完整JSON行解析 |
| 为什么不用每轮启动Claude？ | resident-runner的userMessages持续yield，result后只清activeTask |
| 取消如何不关容器？ | conversation.cancelTurn请求interrupt，finishTurn保留已结束的原生中断环境 |
| 怎么防止迟到中断影响下一轮？ | resident-runner的interrupting，agent.result等待中断控制请求完成 |
| 谁负责最终关容器？ | conversation.stopEnvironment；DockerBackend.stop再次inspect确认 |
| 服务重启怎么办？ | recovery先取全部锁、停止旧环境、未完成消息标interrupted |
| 配置或事件落盘失败怎么办？ | ServiceStore.onFailure→storageFailure，阻止执行并直接清理 |

## 执行层主线

conversation.ts依次阅读open、run、prepareTurn、ensureRunnerStarted、cancelTurn、finishTurn和close。Turn只放本轮信息；session保存最近运行事实；tasksByAttempt将后台事件归回原轮次。

几个Promise用于等待实际完成：environmentCleanup统一清理、idleRecovery等待空闲故障收尾、sessionWrites串行保存状态、stderrWrites串行保存诊断、RunnerChannel.drained等待输出消费结束。它们不是额外任务队列。

两条顺序不能颠倒：

- 创建过程中取消，先等create结束，再按确定名称清理，防止迟到创建留下容器。
- 关闭环境先关闭输入、确认Docker停止/删除，再等输出消费完成并清凭证。中断回执不能代替整容器停止证明。
