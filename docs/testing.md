# Testing

单机交付统一入口见[部署与验收](deployment.md)。`tests/delivery-verification.mjs`使用两个独立Compose实例演练安装、初始化、标准任务、故障、备份恢复和通知；需要Docker及已构建的统一镜像。真实浏览器和真实模型分别记录，不由确定性夹具替代。CI已显式提供可丢弃PostgreSQL，缺少连接串应失败，不跳过数据库测试。

## 不需要Docker或真实模型

```sh
npm ci
AH_TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/agent_harbor_test npm test
npm run check
npm run audit:public
```

单元测试使用临时目录、真实宿主flock、真实PostgreSQL及必要的引擎故障注入；每个测试文件创建并删除独立schema，不会连接真实模型。数据库测试会拒绝空连接串，也不会自动创建数据库。公开内容检查扫描被追踪文件、索引和可达Git历史，不读取本地`.env`或用户会话作为公开内容。

## Docker与原生SDK

先构建正式与协议夹具镜像：

```sh
npm run build
docker build -f infra/Dockerfile -t agent-harbor:0.4.0 .
docker build -f tests/Dockerfile -t agent-harbor:0.4.0-test .
npm run verify:docker
npm run verify:layout
npm run verify:native
npm run verify:persistent
npm run verify:chat
npm run verify:resident
npm run verify:service
```

这些测试使用本地确定性模型服务器，调用实际SDK、工具和Docker，不需要真实账号。输出存放在`var/evidence/`，会含本机路径、任务和诊断，不应进入Git。

| 验证 | 证明什么 |
| --- | --- |
| verify:docker | 协议生命周期、隔离工作区、并发拒绝、故障和停止清理；部分为协议Runner |
| verify:layout | 挂载权限和原生文件工具对平台目录的限制 |
| verify:native | 原生Bash、同镜像resume、命名空间与正常并发、取消后不再写入 |
| verify:persistent | 实际容器ID跨轮复用、工作文件/原生ID、受信后台进程、原生中断后复用及SIGKILL回收 |
| verify:chat | 真实PTY输入、流式显示、恢复、Ctrl+C/EOF、空闲回收和SIGHUP；另有UI结果注入 |
| verify:resident | 正式持续输入、同Runner/原生PID、原生中断后续聊、空闲Runner崩溃的宿主回收 |
| verify:service | 实际服务/CLI、断开后完成、SSE补看、多行与去重、中断/关闭、空闲回收、数据根锁及服务SIGKILL协调 |

持久化测试的后台进程由受信`docker exec`夹具启动，不能据此宣称任意SDK Bash后台服务能跨轮存活。空闲测试使用缩短时限运行同一路径，不等待完整默认15分钟。

已验证的开发环境是Linux arm64容器与本地OrbStack Docker Engine；其他内核、架构与远程Docker需自行复验。测试配置依赖固定原生SDK，升级必须重复隔离和恢复检查。CI只跑不需要Docker/真实模型的检查。

## 真实模型与用户验收

真实模型任务需自行配置获准凭证和网关，单独核对文件变化、测试结果、成本、取消及用户目标是否实现。本地模型夹具的成功结果不等于模型自主能力验收，也不等于生产多租户安全通过。

## V4网页

`npm test`额外覆盖Cookie/Origin/归属、跨标签页身份变化、静态资源边界、固定历史分页、Markdown转义、草稿/请求编号、A→B→A迟到响应和提交结果未知。

```sh
# 浏览器人工验收，使用隔离目录和本地模型；不读取.env
npm run preview:web
# 打开 http://127.0.0.1:8435，测试密钥 web-fixture-only
# 确认Bash开始后可测试停止；同一会话可继续发送
```

这是实际服务、SQLite、Docker和Claude SDK链路。模型为确定性fixture，不证明自主推理。默认测试Bash等待45秒，便于观察中断/断开；结束时Ctrl+C清理测试容器。不要对该端口提交真实工作或私密资料。

```sh
# 显式真实模型验收，会产生费用；从.env读取获准网关
npm run verify:web:gateway
```

该命令使用新的独立数据根，经浏览器Cookie接口执行两轮写入/读回文件，核对同容器、Runner、原生会话ID与输出，结束后回收容器。报告在var/evidence/v4-web/；它是HTTP/原生/模型验收，浏览器布局和交互仍需另外检查。

## V5文件

```sh
npm test
npm run verify:files
# 显式真实模型验收，有费用
npm run verify:files:gateway
```

文件测试覆盖父目录软链接反复替换、硬链接/FIFO/越界/跨会话拒绝、完整暂存与流式限额、哈希冲突、停滞上传关机释放、预览截断和下载限额、A→B→A及上传编号恢复。原生链路在独立数据根上传随机资料，让工具生成输出，确认关闭容器后仍可下载且字节/哈希一致。浏览器需另行检查文件选择器、多选上传、路径入草稿、文本安全预览、实际下载和宽窄屏。

## V6用户与额度

npm test包含OIDC签名身份夹具（PKCE/state/nonce、签名、issuer/audience/过期、单次Cookie绑定）、用户权限、密钥撤销/到期/重启导入、持久登录、停用关闭连接和环境、任务/环境独立额度、异步创建占位、空间软额度和累计费用去重。tests/users-preview.mjs可启动8436独立浏览器测试根，不读取私有.env，不连接真实模型。

服务实际Docker/SDK回归继续使用verify:service；文件脚本可通过AH_EVIDENCE_DIR输出到本次目录，避免覆盖旧V5证据。协议夹具不等同实际企业身份供应商、HTTPS部署、真实模型或完整多租户安全验收。

## V7 React前端

`npm test`同时构建apps/web并验证实际Markdown组件、Vite静态资源与原消息/文件状态逻辑。`node tests/react-preview.mjs`启动8436独立浏览器夹具（合成账号、本地模型、真实Docker/SDK，不读取.env）；使用localhost避免与127.0.0.1正式服务共享Cookie。合成密钥react-fixture-a/b仅限该测试环境。完成后停止脚本会清理保留环境；不把夹具当正式登录服务。页面验收与限制见[React说明](react-web.md)。

## 异步迁移回归

`tests/concurrency.test.ts`使用真实PostgreSQL及不调用模型的受控执行器：覆盖同ID并发重试、不同正文冲突、用户/全局/环境额度、建会话预约、失败释放、真实行锁等待期间的上传、延迟旧取消与空闲计时器交错。长上传期间另一会话仍可执行，避免把接收锁误做成全服务任务队列。

`tests/migration.test.ts`另含三种完整性负例：事件引用不存在的消息、用量引用不存在的会话、会话最后事件位置不一致；导入必须整体回滚，不能留下导入指纹。上述测试使用独立schema，不操作开发库或发送模型请求。
