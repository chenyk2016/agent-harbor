# 应用创建：本地试用与部署

应用创建复用Harbor的Claude SDK会话与消息流。用户在`/applications`输入需求，平台准备标准React/Node模板、调用原生工具修改源码，确认开发写入者停止后创建Git快照，再构建预览镜像。正式发布走同一条固定源码到镜像链路，容器独立运行。

应用观测与运营分析首版见[观测指南](application-observability.md)：通用流量/转化/质量/版本面板、应用事件声明和独立观测数据库。默认关闭，需迁移和重新发布应用。

创建或编辑应用时，可以点「应用登录」或在对话里说「只允许 Google 登录」。内置 Skill 指导 Claude 修改 `harbor-app.json` 的 `auth` 配置，Harbor 按配置构建预览和发布。新应用省略 `auth` 时默认公开。登录方式使用 `"auth": { "mode": "required", "providers": ["email_password", "google"] }`，列表可只选择一种。登录页由 Harbor 托管。「工作台 → 用户」展示当前方式并管理访客账号。已受保护的应用改为 `"auth": { "mode": "public" }` 时，在构建预览或发布时确认开放。

## 当前可用范围

- 独立创建入口、应用列表、持续对话、右侧真实预览、桌面/手机宽度、文件浏览及上传。
- 编辑页左侧对话常驻，右侧在「工作台 / 预览」之间切换。工作台用竖向分区承载：数据分析、数据库、版本记录、发布与地址、文件、操作记录、设置；预览由地址栏统一提供刷新、桌面/手机、新窗口和专注预览。窄屏改为「对话 / 工作台 / 预览」单页切换。
- 版本时间线、固定源码下载、手动保存、恢复旧源码为新版本。相同文件内容不重复增加普通版本；恢复操作始终保留新的版本记录。
- 发布到`/apps/<appId>/`，预览用`/preview/<appId>/`；不需要增加域名或DNS记录。
- 源码、预览、线上版本分别显示。发布/构建异步登记，重复请求保持同一操作。失败候选不替换旧线上实例。
- 发布历史、下线、复用历史镜像回滚；代码回滚不回滚业务数据。
- 测试/正式数据独立数据库及DML身份，工作台读取最近100条。匿名公开读/写必须在manifest中分别声明。应用可选开启[访客登录](specs/application-visitor-auth.md)，用户在工作台的「用户」分区管理。业务数据工作台仅提供读取。
- 构建可取消；预览可暂停，编辑页30分钟未访问后回收预览实例。正式应用持续运行，退出页面或关闭开发环境不下线。
- 操作记录显示进度/失败码；待核对状态保留占位，可显式核对。SDK执行不明、部分源码恢复、创建中断需要人工检查，不能自动重发模型请求。

本次是受信本地试用版本。HTTPS实际域名、真实模型生成质量和生产业务验收单独执行。路径隔离不等于浏览器来源隔离，详见[技术设计的安全边界](design/app-builder-architecture.md#15-安全边界与可开放范围)。当前只向管理员指定的受信账号开放创作。

## 启用步骤

保持既有Harbor配置、模型网关和Agent运行镜像。应用数据库建议使用单独的PostgreSQL实例/管理员，避免给生成应用任何控制面权限。

1. 备份控制面数据库，构建代码，再用既有受控迁移入口应用`0006_applications.sql`。服务启动不会自动建表。
2. 准备应用用Node基础镜像（固定digest见配置），本机Docker必须能够inspect它。运行时不会自动选取任意模型提供的基础镜像。
3. 设置Caddy入口。应用子树必须位于Harbor代理前，带`@id=harbor-application-routes`，类型为`subroute`；只有这棵子树会被应用模块更新。[本地HTTP示例](../infra/app-edge.example.json)监听8080，管理服务仍在4318。已有Caddy部署只合并该子树，不用示例覆盖其他站点。
4. 配置以下变量后执行 `npm run db:migrate`，再重启Harbor。启用应用功能时，迁移命令会在应用 PostgreSQL 上默认初始化独立观测库；现有安装也可单独执行 `npm run observability:migrate`。网页和公开应用应经过同一公开来源，以便预览嵌入。正式域名在Caddy外层配置HTTPS，公网DNS/证书不由应用创建流程申请。

```dotenv
AH_APPLICATIONS_ENABLED=1
AH_APP_PUBLIC_ORIGIN=http://127.0.0.1:8080
AH_APP_CADDY_ADMIN=http://127.0.0.1:2019
AH_APP_CREATOR_IDS=developer
AH_APP_DATABASE_ADMIN_URL=postgres://app_admin:replace-me@127.0.0.1:5432/postgres
AH_APP_DATABASE_HOST=host.docker.internal
```

`AH_APP_CREATOR_IDS`是内部用户ID。`AH_APP_CADDY_ADMIN`也支持`unix:/absolute/socket/path`，该socket必须由运维限制访问；Unix socket配置只有类型/源码检查，本次真实网关验证走loopback HTTP。

若Caddy运行在容器中、Harbor和应用端口发布在宿主机，设置`AH_APP_EDGE_UPSTREAM_HOST=host.docker.internal`；否则保留默认`127.0.0.1`。Node基础镜像通过`AH_APP_NODE_BASE`配置，默认固定为：

```text
node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
```

应用运行的数据库主机名可用`AH_APP_DATABASE_HOST`覆盖；端口沿用数据库连接串。依赖下载代理只给Builder，通过`AH_APP_BUILD_PROXY`显式配置。不要把模型网关token、控制面数据库URL或Docker socket放入应用环境。

功能默认关闭。打开页面会说明未启用，不改变已有会话能力。普通会话不会安装应用写入门；已关联应用的旧会话入口只能观看，新增生成请求需要从应用入口提交。

## 固定存储与持久化

默认根目录是`AH_DATA_DIR/.applications`，可用`AH_APP_DATA_DIR`指定固定磁盘目录。它由宿主控制面持有，不挂载给Agent，不随开发或应用容器删除。宿主服务若容器化，需要将此目录和既有会话目录映射到持久卷，并保证Docker能访问实际bind源路径。

```text
.applications/
  sources/<appId>/repository.git/   平台拥有的bare Git库
  sources/<appId>/<commit>.json     固定源码指纹
  builds/<buildId>/                输入、产物、日志、操作清单
  deployments/<deploymentId>/     本部署私有运行配置
  data/<appId>/<environment>/      数据环境身份和迁移元数据
  secrets/.application-data-key    加密主密钥
  operations/<operationId>.log     控制面私有错误详情
  exports/<temporaryId>/           下载时导出，连接关闭后回收
```

业务数据实际位于PostgreSQL的数据卷。备份必须覆盖控制面数据库、应用数据数据库、会话工作区、上述应用目录和加密主密钥。源码、镜像和业务数据是不同产物，保留Git不等于保留报名记录。

正式镜像和历史构建当前保留以支持回滚；首版没有自动历史镜像/构建清理和总磁盘硬额度。下线及暂停预览只删除对应运行容器，不删除版本和业务数据库。应用归档/永久删除暂不提供，避免用下线冒充数据删除。

## 生命周期和故障

应用容器使用单独的`harbor.app.*`资源标签。普通Agent恢复和清理不会把线上应用当作开发容器删除。容器以非root、只读根、能力全部丢弃、有限CPU/内存/PID启动；正式容器在成功切换入口后设置`unless-stopped`。

一次应用只有一个源码写操作、一个预览操作和一个正式发布操作。构建全局串行，网关切换全局串行。短数据库事务登记幂等ID和占位，模型、Docker及网关调用不持有事务锁。固定Git版本导出给Builder，开发工作区后续改变不影响既有发布。

Caddy更新使用配置ETag比较后替换，随后读取实际路由并从公开入口核对部署身份。切换结果不明时保留`reconciling`，不直接标记成功或释放占位。手动“核对运行状态”只核查既有容器、目标路由及开发环境，不重发生成请求。目标实例缺失或不健康、部分恢复、创建中断等情况仍保留错误并需要运维检查。服务重启不会自动重放未完成请求。

启动时及服务内每分钟核对容器当前实际端口：先核验镜像、归属标签和loopback绑定，再确认直连与公开入口的部署身份，保存新端口后才标记就绪。仅重启应用容器时，下一次周期核对会更新路由；重启Harbor时则在初始化阶段核对。周期核对与发布切换共用锁，不覆盖正在发布的新代际。

路由变更与健康确认限定于一个应用端点，保留其他应用的路由。单个容器缺失、归属不符或不健康时，仅撤下它的失效路由并保留待核对状态，避免旧端口被其他容器复用后误转发；其他应用仍可访问、核对和切换。共享Docker、数据库或Caddy自身故障不属于单应用隔离保证。

账号被停用时，既有身份流程会撤销浏览器登录，关闭开发环境，并调用应用清理撤销该用户的公开入口和运行实例；业务数据保留。无法确认停止则返回清理待核。普通退出登录不下线应用。此功能不能代替不受信代码的网络/系统隔离。

数据库迁移仅允许新增表和可空字段；删除字段/表或改变类型会阻止部署。数据库内迁移记录优先于磁盘元数据，避免提交DDL后崩溃导致下次重复或倒退。恢复旧源码后若它与已扩展数据声明冲突，预览可能失败；应在对话中保留现有字段声明。生产回滚使用旧镜像配合当前兼容扩展的数据结构。

## SQL 迁移与旧应用切换

新应用使用 `formatVersion: 2`，把业务表结构保存在源码的 `migrations/NNN_name.sql` 中。Harbor 从固定版本读取脚本，在目标数据库的事务内执行和记账。首次支持建表、常用字段类型和新增可空字段；任意 SQL、改名、删表和数据重写暂不支持。已经执行的文件不可改写，预览与正式独立记账。v2 的业务接口由应用后端提供。工作台和问数查询选定环境的实际业务表，问数沿用字段授权。

旧应用按环境切换。保留真实表结构并生成 `000_baseline.sql`，写入 v2 清单和后续迁移。平台会核对库中表、列、约束及索引，再登记已存在的基线。只有后续新增迁移会改变旧库。空库会执行基线建表。旧应用如果调用通用表接口，切换前把调用改为自定义业务接口。回滚使用已发布的旧镜像并保留已提交的迁移。

## 验证入口与边界

```sh
npm run check
# AH_TEST_DATABASE_URL必须指向可丢弃的测试数据库
npm test
npm run verify:applications
npm run verify:applications:native
```

`verify:applications`创建隔离PostgreSQL和Caddy，构建真实镜像，验证两应用、两环境、迁移、更新、旧前端409、镜像回滚及清理。设置`AH_APP_FULL_REGRESSION=1`可在其隔离PG上执行完整回归。

`verify:applications:native`还使用真实Controller、原生Claude SDK/Write、HTTP管理入口和持续对话。模型响应由本地fixture提供，真实模型请求为0。可用`AH_APP_KEEP_OPEN=1`保留测试服务用于浏览器验证，Ctrl+C只清理本次创建的资源。测试生成的业务数据保存在可丢弃PG中，清理后网址不再可用。

类型、单元/集成回归、真实容器、浏览器、真实模型、公网部署是不同验证层，不能相互替代。完整设计及后续P01–P30矩阵见[架构方案](design/app-builder-architecture.md)。
