# Releasing source

此仓库用于发布Agent Harbor自有源码。安装后的SDK、Claude Code二进制、镜像层、模型凭证、会话与验证原始日志不属于源码发布包。

## 分支与版本

统一在 `main` 开发和提交，不再创建版本分支或功能分支，除非用户明确改变规则。

对经过验证的版本可在本地创建附注 Semantic Versioning 标签。已有标签保留在原提交。创建标签与上传源码是独立操作。上传前核对目标引用及其全部可达历史。

## 发布前

先区分源码、可运行服务包和镜像。源码包含仓库追踪的文件。可运行服务包另带编译后的服务、网页、迁移与文件清单。Runner 镜像由部署者按固定 Dockerfile 构建。分发带有上游组件的镜像前，另外核对相关条款与许可证。

1. 检查Apache-2.0和NOTICE，保留第三方许可证；核对外部SDK的独立条款。
2. 在可丢弃的 PostgreSQL 上执行 `npm test` 和 `npm run check`，执行 `npm run audit:public` 核对源码和可达历史。另用 `npm audit --omit=dev` 查看运行依赖安全公告，核对实际安装路径，处置高危项并记录结果。
3. 检查Git diff与所有准备上传的分支/标签。源码检查脚本不能替代人工安全审阅。
4. 从独立目录解包，执行[快速开始](quickstart.md)并验证 Docker 冷启动、任务、停止、备份和空实例恢复。可选 OpenSandbox 单独执行对应验证。使用本地模型夹具时注明覆盖范围。
5. 确认公开内容全部提交，工作树干净。运行 `python -m mkdocs build --strict`，核对文档链接、示例下载和导航。

## 导出

```sh
npm run release:source
```

脚本先检查公开内容和历史，再从HEAD使用git archive导出带有`agent-harbor/`顶层目录的源码包，保存为 `var/releases/agent-harbor-<版本>-<提交前12位>.tar.gz`。不会把整个工作目录打包，也不会包含`.git`、本地环境文件、依赖或用户数据。

上传前用 `tar -tzf` 检查目录，并核对压缩包的 SHA-256。解包后可直接按源码安装，源码包没有 Git 历史。在 Git 克隆中使用 `harbor package` 生成带文件清单和固定镜像 ID 的可运行服务包。 [发行包安装](deployment.md#固定版本与安装)

创建GitHub仓库或上传Git分支是另一个明确动作，本地导出不执行这些操作。仓库保持`private: true`，防止意外npm publish；这不影响通过Git公开源码。

## 不要上传

`.env`、私钥、完整事件/诊断、用户工作区、原生会话、内部交接与私人台账、本机路径与账户信息。已进入历史的敏感文件不能仅靠.gitignore消失，必须检查准备上传的整个可达历史。如果凭证曾泄露，还须在相应服务撤销或轮换。
