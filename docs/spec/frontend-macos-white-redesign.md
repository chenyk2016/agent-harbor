# 前端 macOS 白色风格重构（规格）

## 背景

当前 Web 前端是 React 18 + Vite + Chakra UI，分层已经比较健康（`app/` 外壳、`features/` 按业务域拆页、`shared/` 通用展示组件、`state/` 数据与接口层）。主要问题不在结构，而在**视觉基调与交互一致性**：

- 现有画布是暖米色（`#F6F5F2` 画布、`#FBFAF8` 悬浮、暖褐文字），不是"白"。
- 通用组件只收敛了状态 Pill/Status/Mark 等少数几个，各页面仍大量手写内联样式，间距、圆角、边框、阴影不统一，观感"不够工整"。
- 交互细节（hover/active、焦点态、空态、加载态、滚动条、选中态）在各页实现不一致。

目标是做一套**企业级 macOS 白色风格**界面：白色面板、发丝边框、柔和阴影、SF 字体、清晰的三栏/四栏工作台外壳，同时**保留并强化现有 feature 分层**，把跨页重复的样式收敛成共享设计系统与组件。

## 目标

1. **视觉**：换成 macOS 风格的冷白/浅灰中性色，白 surface，发丝边框，柔和阴影，圆角与间距成体系。
2. **交互**：对齐、间距、选中态、hover/active、焦点态、空态、加载态、滚动条、键盘快捷键统一且顺手。
3. **结构**：维持 `app/ features/ shared/ state/` 分层，通用组件进一步收敛（高内聚、低耦合），设计 token 保持单一来源。
4. **不破坏**：后端 API、状态逻辑、路由、功能行为一律不动；只重做前端呈现与交互外壳。

## 设计系统（token 单一来源）

颜色由"暖米"整体改为"冷白 / Apple 中性"，语义 token 名**保持不变**（页面不用改引用名，只换值）：

| token | 现值（暖） | 目标值（冷白 macOS） |
| --- | --- | --- |
| canvas | `#F6F5F2` | `#F5F5F7` |
| surface | `#FFFFFF` | `#FFFFFF` |
| surfaceHover | `#FBFAF8` | `#FAFAFC` |
| sunken | `#F1EFEB` | `#F2F2F7` |
| line | `#E9E6E0` | `#E5E5EA` |
| lineStrong | `#D8D4CC` | `#D1D1D6` |
| ink | `#1C1B19` | `#1D1D1F` |
| ink2 | `#56514B` | `#48484A` |
| muted | `#746E66` | `#86868B` |

强调色默认换为更"苹果"的蓝 `#0A84FF`（可选保留 Harbor 蓝 `#2E5AE0`，见「待确认决策」）。状态色语义保留、色相微调为更清亮的绿/橙/红。阴影从带色偏的褐影改为中性柔和阴影（`sm/md/lg` 三档）。圆角统一为 `6 / 8 / 10 / 14 / 18`。字体保持 SF/system 体系不变。

## 分层重构方案

### 1. 设计系统层
- `apps/web/src/app/theme.ts`：换 token 值，补齐统一组件基样式（Button/IconButton/Input/Select/Textarea/Badge/Menu/Modal/Tooltip/Switch/Tabs 等）。
- `apps/web/src/app/styles.css`：换 CSS 变量值；统一滚动条、选中态、发丝边框、阴影；Markdown 阅读样式微调。
- `apps/web/index.html`：`theme-color` 换成新画布色。
- `apps/web/src/app/theme-mode.tsx`：保留浅/深/跟随系统（见「待确认决策」）。

### 2. 共享组件层（`shared/`）
收敛跨页重复样式为原语，页面不再手写零散 box 样式：
- 升级 `shared/ui.tsx`：保留 Pill/Status/Mark 等，统一为新的视觉基调。
- 新增/收敛通用原语：`Button` 变体、`IconButton`、`Card`、`ListRow`/`SectionLabel`、`EmptyState`、`LoadingState`、`SegmentedControl`、`Toolbar`、`Tag`/`Chip`、`Field`（表单标签+控件）等。
- `shared/select.tsx`、`shared/Markdown.tsx` 同步新视觉。

### 3. 外壳层（`features/shell/`、`features/Workbench.tsx`）
这是"macOS 感"的核心，重点重做：
- `Rail.tsx`：一级图标栏，白 surface + 发丝分隔，选中态用浅蓝 tint + 左侧指示条；图标、圆角、Tooltip 统一。
- `Workbench.tsx`：三/四栏布局（图标栏 64px / 二级导航 292px / 主区 / 上下文面板 372px），发丝边框、白面板，抽屉/弹窗统一新视觉。
- `SessionList.tsx` / `LibraryNav.tsx` / `SettingsNav.tsx`：二级导航统一行高、选中态、图标、分组标题。
- `PageHeader.tsx` / `CommandPalette.tsx`：标题栏与命令面板统一 macOS 质感。
- `workspace/WorkspacePanel.tsx` / `Overview.tsx` / `Activity.tsx`：右侧上下文面板统一卡片、分组、状态展示。

### 4. 页面层（各 `features/*`）
逐页把内联样式替换为共享原语与新 token，不改变业务逻辑：
- 核心工作台页：`NewEntry`、`Chat`、`Composer`、`ToolTimeline`、`Files`、`Login`。
- 资料库页：`skills`、`experts`、`mcp`、`llm`。
- 管理/设置页：`admin/*`、`settings/*`、`applications/*`、`wallet/*`。

## 交互优化

- **选中/激活态**：统一"浅蓝 tint 背景 + 强调色文字/左侧指示条"，替代当前不一致的灰色态。
- **焦点态**：统一 `0 0 0 3px` 焦点环，键盘可达性一致。
- **空态/加载态**：统一空态组件（图标 + 说明 + 动作）与骨架/Spinner，替代散落文案。
- **滚动条**：统一细滚动条，仅悬浮时显示。
- **键盘**：保留并强化现有 `⌘K` 命令面板、`⌘N` 新建；快捷键提示统一。
- **动效**：尊重 `prefers-reduced-motion`，过渡时长统一、克制。

## 修改文件清单

- `apps/web/src/app/theme.ts`、`styles.css`、`theme-mode.tsx`
- `apps/web/index.html`
- `apps/web/src/shared/*`（ui/select/Markdown + 新增原语）
- `apps/web/src/features/shell/*`、`Workbench.tsx`、`workspace/*`
- `apps/web/src/features/{chat,skills,experts,mcp,llm,admin,settings,applications,wallet}/*`（逐页收敛）
- 不新增后端改动，`src/service/`、`src/clients/`、`src/state/*`（数据逻辑）不动。

## 不做什么

- 不改后端 API、数据库、状态流转、SSE/会话生命周期。
- 不重写路由与页面归属结构（feature 分层保留）。
- 不引入新 UI 框架；除非决策选"推倒重来"，否则保留 Chakra 作为渲染引擎，只重做主题与组件。
- 不一次性清空旧样式导致中途破相：设计系统与外壳先落地，页面逐批收敛，保证任意中间态可运行。

## 验收标准

- `npm run check`（类型检查）与 `npm run build`（含 `vite build`）通过。
- 关键流程视觉可跑通：登录 → 首页新会话 → 会话/文件 → 资料库 → 设置 → 管理后台 → 应用，浅色默认下整体是冷白 macOS 风格。
- 页面无残留暖米色、无样式引用报错；选中态/焦点态/空态/加载态统一。

## 待确认决策

1. **实现方式**：原地重构（推荐）还是推倒重来换自研组件库？
2. **深色模式**：保留浅/深/跟随系统（推荐，默认浅色），还是只做白色浅色？
3. **强调色**：默认换 Apple 蓝 `#0A84FF`，还是保留 Harbor 蓝 `#2E5AE0`？
