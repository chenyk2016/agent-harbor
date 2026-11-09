# 维护文档站

产品文档使用 GitHub Pages 原生支持的 Jekyll 和 Minima 主题。内容写在 `docs/` 的 Markdown 文件中，不维护自定义样式、脚本或页面模板。

## 修改内容与目录

每篇公开页面使用以下页头，正文从介绍或二级标题开始：

```yaml
---
layout: page
title: 页面名称
---
```

首页使用 `layout: default`。顶部五个入口由 `docs/_config.yml` 的 `header_pages` 排序，各入口用普通 Markdown 链接列出相关页面。站内链接保留 `.md` 后缀，`jekyll-relative-links` 在构建时转换为网页地址，因此同一份文件在 GitHub 中也能阅读。

页面按用户要解决的问题组织，先说明用途，再给操作、预期结果和相关入口。产品指南不放开发计划、测试记录、旧版迁移或代码阅读说明。这些工程资料留在仓库，由 `_config.yml` 的 `exclude` 排除，不进入公开站点。

## 本地预览

准备 Ruby 3.3 和 Bundler，在 `docs/` 目录执行：

```sh
bundle install
bundle exec jekyll serve --host 127.0.0.1
```

打开 **http://127.0.0.1:4000/agent-harbor/**。仅构建时，在同一目录运行：

```sh
bundle exec jekyll build --destination ../var/docs-site
```

构建依赖与 GitHub 官方 `actions/jekyll-build-pages` 使用的 `github-pages` 版本一致。检查顶部导航、站内链接、图片和手机菜单，并确认产物中没有被排除的工程资料。更换仓库或自定义域名时，修改 `_config.yml` 的 `url`、`baseurl` 和 `repository`。

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

主题与发布方式见 [GitHub Pages 的 Jekyll 说明](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll) 和 [Minima 主题说明](https://github.com/jekyll/minima/tree/v2.5.1)。
