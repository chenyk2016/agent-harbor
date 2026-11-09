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

1. 仓库管理员在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 将文档提交推送到 `main` 后，打开 **Actions → Documentation Pages → Run workflow**，选择 `main`。
3. 工作流使用 GitHub 官方 Jekyll 构建、上传和部署动作。完成后从部署结果打开站点，检查首页与主要阅读路径。

文档相关的拉取请求只构建检查；正式部署仅由 `main` 的手动工作流触发。Pages 托管静态文档，Agent Harbor 工作台及其数据运行在部署者自己的服务上。

主题与发布方式见 [GitHub Pages 的 Jekyll 说明](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll) 和 [Minima 主题说明](https://github.com/jekyll/minima/tree/v2.5.1)。
