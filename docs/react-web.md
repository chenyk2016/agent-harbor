# V7 React工作台

## 本次范围

用户要求参考FastGPT界面与实现，重构正式前端，重点解决文字看不清。使用React + TypeScript + Chakra UI + Vite，在同一仓库apps/web独立工程。参考FastGPT使用的React18/Chakra2与统一主题方法，自行实现Agent Harbor功能，不复制品牌、图标或原项目代码。

参考来源（2026-10-23）：
- https://github.com/labring/FastGPT/blob/main/projects/app/package.json
- https://github.com/labring/FastGPT/blob/main/packages/web/styles/theme.ts
- https://v2.chakra-ui.com/docs/styled-system/customize-theme
- https://vite.dev/guide/

## 视觉与功能约定

导航与工作内容分层，左侧稳定会话列表，中间宽阅读区；文件/详情按需右侧抽屉。基础正文16px，操作14–15px，辅助文字至少13px，中文系统字体、深色正文、清晰状态与焦点。登录、空态、错误、未知结果均有真实入口。

| 保留能力 | 行为约定 |
| --- | --- |
| 登录/退出/统一登录配置 | 使用已有身份接口，不新增账号密码后端 |
| 会话新建/模板/搜索/列表 | 同一会话身份、原模板，不假造模型选择 |
| 历史、流式与重连 | 沿用游标、generation和固定历史上界 |
| 多行输入、草稿、重试 | 沿用localStorage用户隔离和clientMessageId |
| 停止本轮/关闭环境 | 捕获messageId，保留两种操作的区别 |
| 文件上传/预览/下载 | 保留限额、原上传ID、未知核对与路径插入 |
| 账户用量与密钥 | 已有接口；明文仅在创建结果显示，关闭清除 |
| 窄屏 | 导航与侧边内容抽屉，正文保持16px |

已有Workspace/FileBrowser等状态逻辑移入前端state，保留测试；React只订阅状态变化并渲染，避免迁移时改写幂等和生命周期。接口客户端与服务类型继续复用，无新增执行引擎。

构建产物仍由Node同源提供；开发Vite代理/api。Chakra使用Emotion动态样式，正式CSP只为样式允许inline，继续禁止inline脚本、外部脚本和原始模型HTML执行。

## 验证

2026-10-23完成以下验证：

- `npm test`：69项通过；`npm run check`通过后端与前端类型检查。
- 真实Docker/SDK与本地模型夹具：服务4组回归、上传→工具处理→成果→容器关闭后下载均通过。未调用真实模型。
- 浏览器：开发密钥登录、新建、批量上传、路径插入、多行消息、工具事件与流式结果、原生停止、续聊、刷新恢复、成果预览和实际下载、账户用量读取、退出及A/B会话隔离通过。
- 1440桌面和375窄屏检查；正文/输入16px，375下页面无横向溢出；浏览器控制台无error/warn。
- 正式4318原数据根升级前后会话快照一致（1个），静态资源200，服务alive/ready均true。Vite开发代理健康接口200。
- 独立仅含根package/lock的目录执行`npm ci --omit=dev --workspaces=false`成功，确保执行镜像仍可仅装服务依赖；未为本轮前端改动重建执行镜像。

用户视觉/业务验收、真实OIDC/HTTPS、Linux宿主与生产隔离另验。密钥创建/撤销保留原接口及工程测试，本轮浏览器未再次创建凭证。历史公开审计仍有既存私有历史/文章技能目录拦截，未绕过；没有推送或发布。

## 开发和目录

仓库根执行：

```sh
npm ci
npm run build
npm run server
```

日常前端开发另外运行`npm run dev:web`，访问http://127.0.0.1:5173；API代理到4318。默认只绑定本机回环，正式仍从4318同源提供构建文件。`npm run build:web`只构建网页，不重编后端。Vite配置中的固定Origin转换只用于本机开发代理，不放宽后端校验。

```text
apps/web/
  src/
    app/       App登录分流、Workbench订阅hook、theme和全局样式
    features/  Workbench页面组合、Sidebar、Chat、Files、Details、Account、Login
    state/     Workspace/FileBrowser/API/localStorage/事件回放
    shared/    Markdown与少量展示组件
  vite.config.ts
  package.json
src/service/web-assets.ts   正式静态资源边界与CSP
```

从`features/Chat.tsx`的发送入口读起，进入`state/workspace.ts`，再看共享HTTP客户端；回答从同一状态对象经订阅hook回到React。状态对象负责消息顺序和恢复，组件只负责展示及用户操作。关键异步归属、关窗行为和主题约定写在相应代码注释中。

## 取舍

采用FastGPT所用的React18/Chakra2组件体系，统一主题与公共控件；不引入Next.js，因为已有独立Node会话服务，工作台不需要服务端页面渲染。保留成熟状态对象，减少界面迁移时重写生命周期的风险；不额外引入Redux/Zustand。

当前构建JS约724kB（gzip约233kB），Vite提示大于500kB；主要来自组件库、动画及Markdown。当前先保持简单的模块入口，未为消除提示加入复杂拆包策略。长历史尚无虚拟列表；后续根据实际加载性能再拆账户/文件与长列表。

## 页面路由与固定布局（2026-10-24）

前端使用 React Router 7 的嵌套路由。工作台外壳只创建一次，侧栏、右上角工具栏、会话状态和文件状态留在外壳中；中间的 `Outlet` 随 URL 切换内容。

| 地址 | 内容 |
| --- | --- |
| `/` | 总入口：对话 / 应用共用输入区，发送即创建 |
| `/sessions` | 全部会话 |
| `/sessions/:sessionId` | 指定会话的历史、输入和事件流 |
| `/skills` | 技能卡片目录 |
| `/skills/:skillId` | 技能详情、文件编辑和历史版本 |
| `/settings` | 用量与个人访问密钥 |

技能详情和个人设置已经从全屏弹窗改为内容页；新建、导入和未保存提醒仍是页面内弹窗。浏览器前进后退和导航链接统一经过路由；技能存在未保存修改时，确认离开或继续编辑。刷新/关页使用浏览器原生未保存提示。保存成功后生成版本的行为不变。

会话页以 URL 中的 ID 为准，列表初始化不自动抢选另一会话。技能和设置页仍保留上次会话作为工作文件/会话详情工具的上下文，刷新时从当前用户本地选择恢复；没有可用会话时，工具按钮保留但停用。页面导航不会向服务发送停止任务或关闭环境请求。

主要代码：`app/App.tsx` 定义路由，`features/Workbench.tsx` 保留外壳，`app/workbench-context.ts` 向内容页提供公共状态，`app/route-pages.tsx` 连接 URL 和会话选择，`features/SessionsPage.tsx` 展示会话列表。

正式服务 `src/service/web-assets.ts` 对这些页面地址返回构建后的入口，以支持直接访问和刷新；API、源码、运行目录和未知资源不采用页面回退。部署到反向代理时，也需要把上述页面地址转发给本服务。

本轮验证：114 项工程测试通过，新增页面深层链接/私有路径边界及路由接管会话选择测试；浏览器验证技能详情刷新、前进后退、未保存提醒两种选择、设置读取刷新、会话刷新、技能页工作文件工具和375px窄屏。没有模型调用，没有改动任务执行、SDK 或数据库结构。

参考：[React Router 路由与嵌套布局](https://reactrouter.com/7.18.4/start/declarative/routing)。

## 统一入口与对话/应用分流（2026-10-30）

- `/` 固定为总入口，不再自动跳转到上次会话；左侧会话列保留。输入区切换「对话 / 应用」，发送即创建，不再出现新建会话弹窗。
- 对话模式：首行派生会话名，创建会话后立即发送首条消息；消息失败时进入会话页并把原文留作草稿。
- 应用模式：首行派生应用名，调用 `POST /applications` 后直接进入 `/applications/:appId` 编辑页；无创建权限或应用服务未开启时禁用该模式并提示原因。
- `+`、⌘N、命令面板的「新建」都进入总入口；应用画廊的「新建应用」进入 `/?mode=app`，画廊内联创建区已移除。
- 会话列表通过 `GET /applications` 的 `developmentSessionId` 建立映射：普通会话显示对话图标，应用会话显示应用图标并直达编辑页；`/sessions/:appSessionId` 会 `replace` 重定向到应用编辑页。
- 应用编辑页与画廊不显示左侧会话列（沿用 V10）。
- 主要代码：`features/NewEntry.tsx`、`app/route-pages.tsx`、`features/shell/SessionList.tsx`、`state/workspace.ts`。规格见 `docs/specs/v11-unified-entry.md`。
