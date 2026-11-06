# 构建与发布文档站

网站由 MkDocs 从 `docs/` 内的 Markdown 生成。导航在 `mkdocs.yml` 中维护。正式发布只包含导航中的页面和显式列出的资源，根目录的贡献、安全、许可文档直接复用。应用运行数据、工作区台账和草稿不进入站点产物。

## 本地预览

在仓库根运行。

```sh
python3 -m venv .cache/docs-venv
. .cache/docs-venv/bin/activate
python -m pip install -r requirements-docs.txt
python -m mkdocs serve --dev-addr 127.0.0.1:8000
```

访问 **http://127.0.0.1:8000/**。生成正式产物并检查站内链接与锚点时运行：

```sh
python -m mkdocs build --strict
```

输出在 `var/docs-site/`。如需模拟项目站的子路径，可设置 `HARBOR_DOCS_URL=https://example.github.io/agent-harbor/` 后预览。发布工作流读取实际 Pages 地址与仓库地址，单机预览可用 `HARBOR_DOCS_REPO` 指定。

## 在 GitHub Pages 发布

1. 将含文档站的提交推送到目标仓库的 `main`，由仓库管理员在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 打开 **Actions → Documentation Pages → Run workflow**，选择 `main`。工作流严格构建、上传静态产物并部署到 `github-pages` 环境。
3. 从部署任务打开实际 Pages URL，核对首页、安装页、搜索和下载示例。文档更新后再次手动运行工作流。

拉取请求中与文档相关的改动会构建检查。发布只在 `main` 的手动工作流中运行。应用服务和数据库独立部署，Pages 只托管静态产物。配置细节见 [GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 维护原则

新用户路径先提供可执行步骤、预期结果和下一步。管理章节分开写部署、配置、排障和恢复。命令、参数与功能状态以当前实现和验证记录为准。设计文档和历史验收保留在仓库各自位置。

结构参考 [Open WebUI 文档](https://docs.openwebui.com/)、[n8n 自托管文档](https://docs.n8n.io/deploy/host-n8n.md) 和 [Diátaxis](https://diataxis.fr/)。
