# 维护文档站

产品文档使用 VitePress 默认主题，参考 kb-metabolism 的文档布局。内容写在 `docs/` 的 Markdown 文件中，使用主题自带的首页、分组侧栏、站内搜索和本页目录，不维护自定义样式、主题布局或页面组件。GitHub Pages 托管构建后的静态页面。

## 修改内容与目录

每篇公开页面使用以下页头，并在正文中明确写出一级标题：

```md
---
title: 页面名称
---

# 页面名称
```

首页使用主题内置的 `layout: home`，通过 `hero` 和 `features` 配置介绍、入口和功能卡片。顶部导航、分组侧栏、中文搜索文案和本页目录由 `docs/.vitepress/config.mts` 配置。站内正文链接保留 `.md` 后缀，构建时转换为 `.html`，同一份文件在 GitHub 中也能阅读。

页面按用户要解决的问题组织，先说明用途，再给操作、预期结果和相关入口。产品指南不放开发计划、测试记录、旧版迁移或代码阅读说明。这些工程资料留在仓库，由站点配置的 `srcExclude` 排除，不进入公开页面或搜索。

## 本地预览

准备 Node.js 24，在仓库根目录执行：

```sh
npm ci --prefix docs
npm run dev --prefix docs -- --host 127.0.0.1
```

打开 **http://127.0.0.1:5173/agent-harbor/**。检查正式构建时运行：

```sh
npm run build --prefix docs
npm run preview --prefix docs
```

正式预览地址为 **http://127.0.0.1:4173/agent-harbor/**，产物位于 `docs/.vitepress/dist/`。依赖版本固定在文档目录自己的 `package-lock.json` 中。检查首页、侧栏、搜索、站内链接、图片和手机菜单，确认产物及搜索没有工程资料。构建保留失效链接检查；最后更新时间来自 Git 历史。

更换仓库或自定义域名时，调整站点配置的 `base` 和 GitHub 链接。

## 发布到 GitHub Pages

仓库首次设置时，在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。之后按变更自动处理：

| 操作 | 结果 |
| --- | --- |
| 推送到 `main`，包含 `docs/**` 或文档发布工作流的变化 | 自动构建，成功后自动发布 |
| 对 `main` 提交同范围的拉取请求 | 只构建检查，不发布 |
| 仅修改业务代码、根目录 README、`.env.example` 或内部任务记录 | 不触发文档发布 |
| 需要重新发布现有文档 | 在 Actions → Documentation Pages → Run workflow 选择 `main` |

仅在本地提交不会触发 GitHub 工作流，推送后才生效。文档目录内的图片、主题配置和依赖也在触发范围内。历史设计稿虽然不进入站点，修改它们仍会触发构建；统一按目录匹配，避免新增页面被遗漏。

同一分支的构建与发布串行执行，正在运行的发布不会被中断，只保留最新待执行更新。构建或发布失败会在 Actions 中显示；不能把代码已推送当作文档已发布。

## 任务交付时怎么处理

影响用户功能、界面操作、默认值或配置的改动，需要同时检查并更新相关产品文档。文档和代码一起提交，在已获授权时推送到 `main`，即可触发自动发布；单纯更新内部任务单无需发布。

推送后跟进 **Documentation Pages** 的构建与发布结果，再打开线上首页和改动页面核对。失败时先修复并重试，交付记录分别说明代码推送和文档发布状态。私有任务记录不会复制到文档站。

Pages 只托管静态文档，Harbor 工作台及数据库的部署单独管理。

主题与发布方式见 [VitePress 默认主题](https://vuejs.github.io/vitepress/v1/reference/default-theme-config) 和 [GitHub Pages 部署说明](https://vuejs.github.io/vitepress/v1/guide/deploy#github-pages)。参考项目配置：[kb-metabolism](https://github.com/chenyk2016/kb-metabolism/blob/main/apps/docs/.vitepress/config.ts)。
