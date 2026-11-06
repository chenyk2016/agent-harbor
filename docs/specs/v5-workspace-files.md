# V5：文件入口和成果出口

2026-10-22。状态：用户已确认并实施；使用与代码入口见../workspace-files.md。代码基线V4=a14e94e；本方案保留当前会话/常驻Runner/SDK协议。

## 目标与范围

用户能够上传工作资料，让Agent在当前会话中处理，再浏览和下载工作文件。网页和CLI沿用同一个会话身份；文件服务仅开放该会话workspace。

V5建议默认：多选普通文件逐个上传、按层浏览目录、文本/代码预览、单文件下载、把路径插入消息。ZIP/PDF/Office可作为原样二进制文件上传/下载；本版不自动解压、不转换Office/PDF、不运行HTML/SVG、不加网页编辑/删除/重命名或目录打包。上传资料不等于Agent已经阅读，更不等于自动启动任务。

以下拟议范围已按本轮确认落地；V4没有这些能力，验证结果单列。

## 现有事实与接入位置

- src/runtime/storage.ts的Store.prepare已建立workspace、claude-state、attempts。
- src/docker/docker.ts将该会话workspace直接bind mount到容器/workspace。
- src/service/http-api.ts已统一完成Cookie/Bearer身份、Origin和manager.owned归属检查。
- src/service/session-manager.ts已在submit中同步检查、占位active，防止多条消息并发进入。
- src/clients/web/workspace.ts已经处理会话缓存、选择代数、草稿和clientMessageId；文件请求沿用相同归属原则。

因此，新增宿主文件服务就能访问Agent使用的工作目录；不需要docker cp，不需要启动容器才能传文件，也不需要把文件字节交给SDK输入流。

```mermaid
flowchart LR
  UI[网页：上传 / 文件面板 / 下载] --> API[现有HTTP身份与会话归属]
  API --> F[文件服务：限额、暂存、目录访问]
  F --> W[(当前会话 workspace)]
  W <-->|已有bind mount| C[容器 /workspace]
  C <--> A[常驻Runner / Claude Code]
  UI -->|文件路径 + 用户任务| M[现有消息接口]
  M --> A
```

文件传输与消息执行是两条路线，最终落在同一个工作区。

## 页面流程

保留V4的主导航与对话区域。右侧增加“详情 / 文件”切换，文件页包含当前位置、上级目录、刷新、上传按钮和文件列表；点击文本文件打开预览弹窗，下载作用到当前选中文件。窄屏复用现有右侧抽屉。

输入框旁增加上传入口，复用相同上传逻辑。上传完成显示文件名、相对路径和“插入消息”按钮；插入的是清楚标注的工作副本路径，例如：

```text
请阅读下面的资料，整理为一份说明：
/workspace/uploads/<upload-id>/需求说明.md
```

用户仍需明确点发送。上传失败保留已写草稿；正在上传时不能发送本会话新任务。切换会话可保留原会话上传进度，迟到结果只能更新原会话；退出登录取消观看/上传连接，不对Agent发送取消。

列表在打开、手动刷新、上传完成、本轮结束时重新读取，不加目录监听器。列表和预览表示当前工作文件，不把任意文件存在标成“任务成果验收通过”。

## 存储与命名

```text
<AH_DATA_DIR>/
├── .service/
│   ├── control.sqlite             仍保存会话、消息与事件，不镜像整个文件系统
│   └── file-transfers/<request>/  私有上传暂存和下载副本，不挂载容器
└── <session-id>/
    ├── workspace/
    │   ├── uploads/<upload-id>/<原文件名>  新上传的工作副本
    │   ├── outputs/               推荐的成果目录，Agent可按任务写入
    │   └── ...                    原有项目与Agent生成文件均可浏览
    ├── claude-state/              不开放给文件接口
    ├── attempts/                  不开放给文件接口
    └── session.json               不开放给文件接口
```

uploads/outputs是约定，不能设为平台保密目录。Agent可以修改工作副本，不保证上传后文件永久不变；若需要原件归档和不可变成果，另行增加存储版本功能。outputs不强制，下载允许workspace内任何合规普通文件。

不同上传用不同UUID目录，保留原文件名，避免“同名文件覆盖了项目源码”。不新增文件索引表，磁盘是当前文件列表的事实来源。

## 上传：先收完整，再公开

1. 前端捕获userId、sessionId、uploadId、原文件名，计算SHA-256；文件大小检查后请求上传。
2. 服务先检查归属与当前任务状态，同步占用本会话文件写入位，再开始接收正文。
3. 原始字节以流写入.service/file-transfers的私有目录，逐块计数、校验哈希；不经过现有256KiB JSON解析器。
4. 完成后将整个暂存文件夹原子发布为workspace/uploads/<uploadId>；两个位置须同一宿主文件系统，不用复制兜底暴露半文件。
5. 发布成功才响应201并显示文件卡片；中断/超限/校验失败清理暂存，不公开半份文件。

每个请求一个文件，多选在前端顺序发送。采用application/octet-stream，不引入multipart解析依赖。文件名不是路径：拒绝斜杠、反斜杠、控制字符、.和..，允许普通中文与空格；建议上限180个UTF-8字节。

uploadId由前端生成且重试不换ID。目标已存在时，只有当前文件名、大小、哈希都相同才返回200；不一致返回409，不覆盖。网络结果未知时先按原ID查询当前文件再决定是否重传；刷新后不自动发送文件或任务。浏览器只持久化待确认上传的编号、名字、大小、哈希和会话，不把File对象或文件字节塞进localStorage；确需重传时用户重新选择文件并核对哈希。

这是当前路径上的去重，不宣称完整上传审计或外部副作用恰好一次。文件后来被Agent移走/改写时，保留冲突/未知提示，不能据此自动重建或覆盖旧文件。

## 读写并发与生命周期

建议门禁：

| 会话状态 | 列表 / 预览 / 下载 | 新上传 |
| --- | --- | --- |
| closed：首次运行前或环境已关闭 | 允许 | 允许，不启动容器 |
| ready且无活跃消息 | 允许 | 允许，不重启常驻环境 |
| accepted / running / finalizing | 允许，提示文件可能变化 | 409拒绝，避免改动当前输入 |
| stopping / reconciling或服务正在关闭 | 暂不开放，保留已显示内容 | 拒绝，先确认环境状态 |

SessionManager增加一个小的withFileWrite入口和每会话文件写入占位。检查与占位必须在await之前；submit发现占位后返回409 FILE_TRANSFER_BUSY。接收中断或超时在finally释放，不占用运行容器容量。单次上传建议60秒时限；正常错误不得把文件操作当作Agent取消。

不能重新调用现有lockSession来做每次文件操作：常驻Conversation空闲时也持有该锁。服务已通过数据根锁持有本实例；本服务内上传/新消息协调由SessionManager负责。其他宿主程序手动改文件不受本服务占位保护。

无活跃消息仍可能存在后台进程，所以不声称“空闲即没有写入者”。上传采用新UUID目录和原子发布，避免覆盖已有文件；预览/下载检查读取前后文件身份、大小、mtime和ctime，检测变化返回409 FILE_CHANGED。下载先生成私有有限大小副本，再开始HTTP响应，避免把截断或混合内容直接当成成功下载。运行中的读取不是事务快照；需要稳定交付时使用已有“关闭环境”，确认全部容器进程停止后再下载。

## 文件边界：集中实现一次

浏览器只传相对路径，服务根据已授权sessionId取得workspace根；请求不能指定宿主根或AH_DATA_DIR。路径按组件检查，不用字符串startsWith作为目录归属判断。绝对路径、..、反斜杠和NUL拒绝，不做重复URL解码。

不能只做realpath检查后再按字符串打开：Agent可以在两个操作之间把父目录换成软链接。也不能把最终文件上的O_NOFOLLOW当作所有父目录都受保护。

建议新增一个小的Python标准库辅助程序，专门处理目录边界：固定workspace根，从已打开的目录描述符逐级open，不跟随任一组件的符号链接。最终只接受普通文件，拒绝硬链接（nlink>1）、FIFO、socket和设备；列表可显示“链接/特殊文件不可访问”，不解析其目标。必要的非阻塞打开和打开前后类型核对避免FIFO挂起。目录描述符固定的对象可能被改名，实施测试需核对本项目“Agent只能在workspace挂载内改动”的前提，不把此机制泛化为对恶意宿主进程的隔离保证。

辅助程序不承担HTTP、身份、状态或数据库职责；Node仅用spawn参数调用固定程序，不拼shell、不传凭证；所有接口复用这一个边界。现有宿主锁已依赖Python3，不新增包管理依赖，也不引入C插件。Unix能力在启动时检查，缺失时文件能力报不可用，不能静默退化成不安全路径拼接。首期支持当前macOS/Linux路线，Windows不在已确认范围。

Python官方os接口提供dir_fd、相对目录描述符操作及scandir(fd)；Node官方提供O_NOFOLLOW，但本方案仍需逐级保护父目录。本机Python 3.13.4只读能力查询确认open/stat/rename支持dir_fd，scandir支持目录描述符，所需O_DIRECTORY/O_NOFOLLOW/O_NONBLOCK常量存在。实施阶段已补本机目录边界、父目录替换与实际传输验证；Linux宿主和恶意宿主进程不在已验证范围。

预览以JSON返回有限UTF-8文本，前端textContent/pre展示；二进制与超限文件提示下载。HTML/SVG只显示源文或下载，不在主站源内执行。下载统一application/octet-stream、Content-Disposition: attachment、nosniff、no-store，文件名用安全编码，不把磁盘目录直接挂成静态站点。

## 建议限制

| 项目 | V5拟议默认 |
| --- | --- |
| 单次上传 | 20MiB，每次一个文件，批量顺序上传 |
| 文本预览 | 最多读取256KiB，超出提示截断，不读取整个大文件 |
| 单文件下载副本 | 100MiB，超出明确拒绝；流式复制，宿主不全量载入内存 |
| 单目录 | 最多1000项，不递归扫描；超出给出明确提示，不假装完整列表 |
| 临时传输 | 成功/失败/断开后清理；启动清理旧传输，不自动再上传 |

这些是首期有限资源边界，不是租户硬磁盘配额。大目录分页、断点续传、目录压缩下载、上传总配额和存储保留另行设计。

## 接口草案

所有接口沿用现有Cookie/Bearer、Origin和会话归属验证；二进制正文只走新增上传路由。

| 方法与路径（前缀/api/sessions/:id） | 含义 |
| --- | --- |
| GET /files?path= | 列出一级目录，返回相对path、name、kind、size、mtime、可用操作及truncated |
| GET /files/preview?path= | 返回有限文本、读取版本信息、truncated |
| GET /files/download?path= | 验证后创建临时副本，再下载普通文件 |
| PUT /files/uploads/:uploadId?name= | 原始字节；头携带SHA-256；201新发布，200当前内容相同 |
| GET /files/uploads/:uploadId?name= | 查询当前已发布文件信息和SHA-256，核对未知上传结果 |

常见错误：404 SESSION_NOT_FOUND/FILE_NOT_FOUND，400 INVALID_PATH/INVALID_FILENAME，409 SESSION_BUSY/FILE_TRANSFER_BUSY/FILE_CHANGED/UPLOAD_CONFLICT，413 FILE_TOO_LARGE，415 PREVIEW_UNSUPPORTED，422 CHECKSUM_MISMATCH，503 RECONCILING/FILE_ACCESS_UNAVAILABLE。错误不回显宿主绝对路径、凭证或原始异常栈。

## 改哪些文件

```text
src/service/files/
  http.ts                 文件路由、参数与流式传输；复用上层已验证身份
  workspace-files.ts      列表/上传/预览/下载编排、限额、暂存清理、辅助进程
  workspace-access.py     小范围描述符文件访问；不承担HTTP或身份
src/service/http-api.ts    在已有身份/归属之后分发文件请求
src/service/session-manager.ts  文件写入占位与submit门禁
src/service/server.ts      注入文件服务、能力检查、启动/退出暂存清理
src/clients/web/
  api.ts                  增加二进制上传/下载与文件查询；复用身份头
  files.ts                每会话文件状态、请求代数、上传进度/未知结果
  file-view.ts            目录/文件卡片/文本预览，与对话渲染分开
  app.ts                  绑定上传、切换、插入路径和下载动作
  index.html / styles.css 文件页、预览弹窗和窄屏抽屉
scripts/build-web.mjs      仍只构建/拷贝网页资源
scripts/copy-service-assets.mjs  将Python辅助程序复制到dist/src/service/files，绝不放进dist/web
package.json               build增加宿主资源复制；源码包包含辅助程序与新增测试入口
```

Python辅助程序属于宿主服务，不进入agent/执行镜像。方案不要求修改DockerBackend、Runner、SDK持续输入、原生工具、安全管理员策略或消息表；不把二进制文件写进SSE和SQLite。

## 实施顺序与验收

1. 文件边界与API：确认本机macOS/Linux能力；覆盖../、绝对路径、父目录软链接替换、硬链接和特殊文件，验证不能读到其他会话、.service、attempts和claude-state。不能只靠正则测试判定完成。
2. 传输与占位：关闭容器时可上传/下载；中文同名文件分别保留；上传中断/超限/哈希不一致无半文件；未知响应复用ID；上传和新任务同时到达只有一方取得写入资格；服务重启清理临时文件。
3. 网页：A→B→A慢返回不覆盖新目录/预览；上传结果属于原会话；未完成上传不进入消息；普通文本保持换行；HTML/SVG不执行；窄屏操作可用。
4. 实际链路：上传随机标记资料 → 明确发消息 → 原生工具读取 → Agent写成果 → 关闭/回收环境 → 浏览器下载，逐字节/哈希核对。测试模型与真实网关分层记录，不用HTTP201替代Agent读取证明。
5. 回归V4消息去重、Cookie身份、连续会话、停止/关闭、重连和CLI；确认native执行协议与镜像不必因网页文件功能重建。

## 取舍与参考

- 直接访问会话workspace：复用已有挂载和持久化，容器停止时也能用；代价是宿主文件边界必须认真封装。
- 不用docker cp：它依赖容器存在，还要维护额外路径与传输流程，不能解决会话文件的长期入口。
- 首期不加对象存储/文件索引DB：当前单机服务不需要双份文件同步；未来多机调度和不可变原件再引入。
- 新目录不覆盖旧文件：比做冲突合并、版本回滚更容易理解，也减少无意改项目的风险。
- 小型Python辅助程序：把必要的路径并发保护集中起来；比各路由分散realpath检查更可靠，仍需实际验证，不等于已完成生产沙箱审查。

官方文档核查于2026-10-22：
- [Python os：目录描述符与不跟随链接](https://docs.python.org/3/library/os.html#files-and-directories)
- [Python os.scandir](https://docs.python.org/3/library/os.html#os.scandir)
- [Node24文件系统常量](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-open-constants)
