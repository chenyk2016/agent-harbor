# Releasing source

此仓库用于发布Agent Harbor自有源码。安装后的SDK、Claude Code二进制、镜像层、模型凭证、会话与验证原始日志不属于源码发布包。

## 分支与版本

统一在 `main` 开发和提交，不再创建版本分支或功能分支，除非用户明确改变规则。

每完成并验证一个大功能，先提交代码，再创建下一个连续编号的附注里程碑标签（`v10`、`v11`……）。标签说明写明功能和验证边界。例如：

```sh
git tag -a v10 -m "Agent Harbor v10: application creation and container publishing"
git show v10
```

里程碑编号独立于 `package.json` 版本，不为创建里程碑标签自动修改包版本。正式包发布时再单独更新包版本和对应发布标签。

已发布标签不移动、不覆盖。历史 `v1`–`v9` 标签保留原分支尖端；两个 `codex/resident-runner*` 标签保留旧验证分支，`main-baseline` 保留迁移前的 main，原有 `v2-baseline` 不变。

创建本地标签不会自动发布。推送分支或标签仍需用户授权；逐个确认待推送标签与其可达历史，不能因为改成标签就认为旧内部历史可以公开。

## 发布前

1. 检查Apache-2.0和NOTICE，保留第三方许可证；核对外部SDK的独立条款。
2. 运行`npm test`、`npm run check`和`npm run audit:public`；涉及容器/权限/恢复时执行对应Docker验证。
3. 检查Git diff与所有准备上传的分支/标签。源码检查脚本不能替代人工安全审阅。
4. 确认公开内容全部提交，工作树中没有未提交的公开改动。

## 导出

```sh
npm run release:source
```

脚本先检查公开内容和历史，再从HEAD使用git archive导出带有`agent-harbor/`顶层目录的源码包，保存到被忽略的`var/releases/`。不会把整个工作目录打包，也不会包含`.git`、本地环境文件、依赖或用户数据。

上传前可用`tar -tzf`检查目录。创建GitHub仓库或上传Git分支是另一个明确动作，本地导出不执行这些操作。仓库保持`private: true`，防止意外npm publish；这不影响通过Git公开源码。

## 不要上传

`.env`、私钥、完整事件/诊断、用户工作区、原生会话、内部交接与私人台账、本机路径与账户信息。已进入历史的敏感文件不能仅靠.gitignore消失，必须检查准备上传的整个可达历史。如果凭证曾泄露，还须在相应服务撤销或轮换。
