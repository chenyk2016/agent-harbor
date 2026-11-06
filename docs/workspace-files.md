# V5文件工作区

V5宿主包0.6.0为现有会话增加上传、目录浏览、文本预览和单文件下载。执行镜像继续使用agent-harbor:0.4.0，不需要因为文件界面升级而重建已有镜像。Python辅助程序只由宿主调用，Docker构建上下文排除该程序。

## 使用

1. 在会话输入框旁点“上传资料”，或打开右侧“文件”页上传；可多选，顺序传输。
2. 上传完成后点“插入消息”，文件路径进入草稿，再写清任务并发送。上传本身不会触发Agent。
3. 在文件页按目录浏览，点击普通文件预览UTF-8文本；用下载按钮保存文件。
4. HTML/SVG显示源文本，PDF/Office/ZIP可原样传输，不在网页执行或自动转换。
5. 任务执行期间不能新上传，可以看已有文件；文件变化会提示重新获取。需要稳定成果时先关闭环境，再下载。

上传资料保存在`workspace/uploads/<uploadId>/<原文件名>`，不会覆盖同名项目文件。它是可被Agent修改的工作副本，不是不可变原件。成果建议放workspace/outputs，但任何合规普通工作文件都可下载。上传与下载不要求容器存在。

当前限制：单文件上传20MiB、文本预览前256KiB、单文件下载100MiB、单目录最多1000项。没有目录上传、自动解压、在线编辑/删除、目录压缩或断点续传；这些限制不等于租户总磁盘配额。

## 从一次上传阅读代码

```text
网页选择File
  → web/files.ts：捕获会话/编号、算SHA-256、保存待确认元数据
  → web/api.ts：二进制请求，复用Cookie和身份头
  → service/http-api.ts：身份/Origin/会话归属
  → service/files/http.ts：上传路由
  → SessionManager.withFileWrite：先占位，防止新任务插入
  → WorkspaceFiles.upload：流式接收到私有暂存、限额、校验
  → workspace-access.py：固定目录描述符，发布完整目录
  → /workspace/uploads/...：通过已有挂载供原生工具使用
```

| 文件 | 职责与需要理解的原因 |
| --- | --- |
| service/files/http.ts | 参数、传输、HTTP头；不复制身份逻辑，不走小JSON正文解析器 |
| service/files/workspace-files.ts | 限额、私有暂存、辅助进程与清理；不启动或取消Agent |
| service/files/workspace-access.py | 固定根下逐级打开目录/文件，拒绝链接与特殊文件，读取前后核对变化 |
| service/files/types.ts | 文件接口记录及上传限额，不包含宿主私有路径 |
| service/session-manager.ts | 上传占位与submit协调；常驻Conversation仍持有原OS锁，不重复加锁 |
| web/files.ts | 按会话保存目录和上传状态；选择代数拦住旧目录/预览返回 |
| web/file-view.ts | 文件列表、上传卡片与文本预览；预览内容只写textContent |

路径验证集中一次完成。不能只做realpath后按字符串读取，因为父目录可能在检查后被Agent换成软链接。描述符逐级打开不跟随链接；普通文件再核对类型和链接数。它以Agent只能改workspace挂载为前提，不宣称能防御恶意宿主进程移动整个目录。

## 未知结果和并发

上传编号和原文内容哈希在请求前保存。响应丢失时卡片显示“结果待确认”，可查询当前文件；重新选择相同名字/大小/内容的文件沿用原ID。相同ID但已存在不同内容返回冲突，不覆盖。刷新不自动重新上传；File字节不进入localStorage。上传后来被Agent移动/修改时，只能核对当前文件，不能把它当作完整历史审计。

正在接收的文件放在`<AH_DATA_DIR>/.service/file-transfers`，不挂载到容器。完整且校验通过后才发布。失败、断开和服务退出清理暂存；启动时在取得数据根锁后清理上次遗留。单次请求60秒时限，Python操作15秒时限；服务关闭主动中止停滞上传，不能一直等待客户端继续发数据。

下载先把普通文件流式复制到私有临时位置，核对复制前后同一文件的大小、mtime和ctime，再发送副本；传输完成/断开后清理。运行时读取不是事务快照；需要冻结全部容器写入者时仍需“关闭环境”。

## 接口

所有路径前缀/api/sessions/:id，沿用V4身份和归属；API不能选择宿主根。

| 方法与路径 | 用途 |
| --- | --- |
| GET /files?path= | 一级目录，返回entries及truncated |
| GET /files/preview?path= | UTF-8源文本，可能截断；二进制返回415 |
| GET /files/download?path= | application/octet-stream附件，nosniff、no-store |
| PUT /files/uploads/:uploadId?name= | application/octet-stream正文，X-Content-Sha256头；201新发布、200当前内容相同 |
| GET /files/uploads/:uploadId?name= | 核对当前文件的名字、大小和SHA-256 |

不暴露.service、claude-state、attempts、session.json；同名文件如果本来就在workspace里则是普通用户文件，目录边界由实际位置决定。预览/下载不做整盘扫描，也不把工作目录挂成静态资源。

## 验证

`npm test`包括真实HTTP/磁盘/Python文件边界，以及网页状态测试；`npm run verify:files`使用真实Docker、SDK及本地模型打通完整流程。`npm run verify:files:gateway`显式使用.env中的真实网关，会产生费用，使用独立数据根，验证上传资料→原生工具复制/核对→关闭环境→下载并校验哈希。

服务全根锁、会话锁、消息去重、中断和重连继续沿用V4。宿主Python需支持Unix目录描述符；当前macOS实测，Linux宿主需按部署环境复验，Windows不在此实现的支持范围。
