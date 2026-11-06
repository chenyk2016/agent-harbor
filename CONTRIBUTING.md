# Contributing to Agent Harbor

欢迎提交问题和小范围、容易阅读的改动。先阅读 README、架构与安全说明；行为变更请说明触发条件、前后差异和验证范围。

## 本地开发

```sh
npm ci
AH_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/agent_harbor_test npm test
npm run check
npm run audit:public
```

测试连接串使用可丢弃的 PostgreSQL 数据库。Docker验证需要额外环境，见[测试指南](docs/testing.md)。请明确区分单元、Docker、原生SDK、真实模型和用户验收，不用本地夹具结果代替真实模型验证。

不要提交 `.env`、Token、用户输入与输出、工作区、原生会话、完整诊断日志或个人绝对路径。问题报告只使用脱敏后的最小复现。

保持简单实现和必要注释。修改取消、锁或恢复行为时，补充能验证实际停止和单写入者的测试。

提交贡献表示你有权按项目的Apache-2.0许可证提供该贡献。外部代码必须保留来源与许可，不能把第三方SDK的许可改成本项目许可。
