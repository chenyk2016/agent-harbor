# 会话依赖与缓存

专家包内Skill、独立Skill和普通会话使用同一套运行时依赖规则。普通技能不强制要求`harbor-skill.json`；提供该文件时，技能安装流程会按明确锁文件准备依赖。未声明依赖的技能不会由平台猜测安装，仍可在任务中按说明使用包管理器。

当前发行镜像包含Python、Node、npm、pip、uv。会话启动时建立/session-env/venv；Bash沙箱内的python/pip默认使用它。SDK父进程仍使用受保护的HOME和系统PATH；PreToolUse只在强制沙箱中的命令前导出依赖环境，拒绝显式禁用沙箱。uv项目使用UV_PROJECT_ENVIRONMENT；uv脚本等由uv原生命令管理。npm项目依赖保存在可写workspace，npm全局前缀在/session-env/node-global。

/session-env映射会话dependency-env，工作区仍映射workspace；容器删除后重新挂载。/dependency-cache映射数据根.dependency-caches/<用户SHA256>，包含uv/npm/pip下载缓存，同用户会话共享，不跨用户。CLI没有认证身份时按会话隔离。

缓存不是跨会话统一可写venv。uv可能按自己的规则在缓存中保存脚本环境，这些内容也限定在当前用户。UV_LINK_MODE=copy避免会话通过硬链接修改包缓存。不同会话仍不共享项目venv和node_modules。

技能原件只读。需要npm ci等原地写入时，复制所需技能文件到workspace再按原说明执行；不会自动修改原包或猜测依赖。命令环境注入由受信Hook处理，强制沙箱命令由Hook批准；禁止退出沙箱和失败后无沙箱重试。文件工具、MCP等仍走既有权限流程。默认允许pypi.org、files.pythonhosted.org、registry.npmjs.org下载；私有源、Git依赖和其他地址需明确授权。原生沙箱、Claude状态与其他用户目录保护保留。

同会话恢复要求兼容且相同的运行镜像；旧会话保持旧镜像，不原地升级。会话临时/tmp仍会消失；安装到/tmp的环境不在持久化承诺内。会话工作文件已有软额度，但运行依赖与缓存尚无自动硬磁盘配额或GC，运维清理应在对应用户会话停止后执行包管理器支持的清理操作，不在活跃缓存中手工删文件。

当前发行镜像按[安装指南](quickstart.md)构建，不依赖本机历史镜像：

```sh
npm run build
docker build -f infra/Dockerfile.release -t agent-harbor:local .
```

有需要时通过`BUILD_PROXY`传入容器可达的构建代理。手工配置时，`AH_IMAGE`和`AH_SKILL_IMAGE`都应指向已构建的固定镜像；托管`configure --image`会同时设置二者。已有会话继续使用原镜像和能力快照。
