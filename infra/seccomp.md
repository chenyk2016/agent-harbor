# Native sandbox initialization profile

`infra/seccomp.json`基于Moby默认seccomp规则，固定来源：

https://github.com/moby/moby/blob/8af9fe3/vendor/github.com/moby/profiles/seccomp/default.json

上游许可为Apache-2.0，原文随本仓库置于`LICENSES/moby-profiles-Apache-2.0.txt`。本项目修改了该JSON文件：保留其默认规则，末尾追加三条初始化规则：clone带NEWUSER；unshare仅NEWUSER、NEWPID、NEWNS组合；允许mount、umount2、pivot_root。

这些调用仅为可信bwrap/helper初始化提供条件，必须配合固定SDK和管理员`sandbox.allowNestedUserNamespaces=false`。原生helper在执行项目命令前追加不可撤销、后代继承的命名空间/挂载限制。不能只把这份外层配置交给未经验证的旧SDK。

## Docker CLI取舍

创建时加载该seccomp文件，并传入`--security-opt systempaths=unconfined`，使严格原生沙箱可以挂载新的/proc。CLI没有在这里逐项设置MaskedPaths/ReadonlyPaths；该选项取消全部两类路径保护，包括/sys/firmware与/sys/devices/virtual/powercap。

这比选择性放开/proc更宽。firmware可能暴露硬件信息，powercap在部分硬件与权限条件下有功耗信息侧信道风险。它不同于seccomp=unconfined；非root、cap-drop ALL、no-new-privileges、只读根和资源限制继续保留，但不能抵消所有被移除的路径保护。

当前这是本地开发兼容性取舍，不是生产多租户安全结论。需要在目标内核/硬件复验，并评估恢复选择性路径保护或使用更强外层隔离。

参考：[Docker CLI](https://docs.docker.com/reference/cli/docker/container/run/)、[Moby安全通告](https://github.com/moby/moby/security/advisories/GHSA-jq35-85cj-fj4p)。
