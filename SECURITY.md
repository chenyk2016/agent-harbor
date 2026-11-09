# Security

Agent Harbor 面向个人与受信小团队的自托管部署。公开注册和自建应用均须按部署环境核对权限，面向陌生用户的多租户生产安全验收仍待完成。

## 当前隔离

- 每个会话使用独立工作区与原生状态挂载，宿主会话锁防止同一工作区出现第二个执行控制者。
- 容器非root、cap-drop ALL、no-new-privileges、只读根，限制CPU、内存、进程数和/tmp大小，不挂载Docker socket。
- 管理员策略放在项目之外且镜像内只读。文件工具和原生命令沙箱共同保护`/platform`及`/etc/claude-code`。
- 原生helper初始化后，禁止项目命令继续创建用户命名空间；配置依赖固定SDK版本和实际目标环境验证。
- 关闭环境、强制取消及失败清理须核对Docker实际停止；可保留环境的原生中断须等本轮完成。未知状态不能启动同工作区新写入者。

默认 Docker 和可选 OpenSandbox 均由宿主 Docker 引擎执行。OpenSandbox 管理服务持有高权限，仅供本机控制面使用。应用运行使用单独网络和每次部署独有的代理凭据，应用入口验证凭据后才处理请求。底层 Docker 网络应按目标环境复测。 [OpenSandbox 运维手册](infra/opensandbox/README.md)

## 已知限制

Docker CLI的`systempaths=unconfined`取消全部MaskedPaths/ReadonlyPaths，以支持严格原生沙箱挂载/proc；这也取消/sys/firmware和/sys/devices/virtual/powercap的遮蔽。它比选择性放开/proc更宽，可能暴露硬件信息；在特定硬件和权限条件下，功耗信息具有侧信道风险。自定义seccomp并不能自动恢复这些路径保护。详见[配置来源](infra/seccomp.md)。

Docker bridge 提供基础网络划分。完整出站限制和磁盘硬配额需要宿主侧补充。HTTP 层核对用户身份和资源归属，工作区写入由运行层独占控制。访问密钥和登录会话支持撤销。已验证的权限和故障场景以对应版本的证据为准。

同一会话跨轮允许后台进程存在，后台写入不受“提交消息串行”约束。SDK也可能自行清理工具后代，不保证任意Bash后台服务长期存活。普通Docker任务的原生中断可能保留后台进程；本地MCP、OpenSandbox任务及强制清理会关闭环境。关闭网页、CLI断开或网页登录退出不会主动取消任务；明确关闭环境才会终止其中的全部进程。

## 凭证和数据

网关凭证从本地环境配置读取，没有内置有效Token。不要提交`.env`或`var/`；任务、事件、诊断、用户工作文件和原生会话可能包含敏感信息。连接文件收尾清空不等于网关已撤销凭证，实际有效期与撤销由获准服务管理。

第三方 SDK、Claude Code 和模型服务适用各自条款。面向外部用户提供 Claude Code 托管、共享模型凭据或代付时，先核对使用方式与结算是否符合上游协议。Apache-2.0 适用于本项目自有源码。 [Anthropic 官方使用条款说明](https://code.claude.com/docs/en/legal-and-compliance)

## 报告漏洞

公开仓库建立后，请优先使用托管平台的私密漏洞报告功能或维护者明确提供的私密渠道。尚无私密渠道时，不要在公开issue中贴Token、用户文件、完整日志或可直接利用的攻击细节；可以先提交不含敏感细节的联系方式请求。当前不虚构维护邮箱或安全响应SLA。
