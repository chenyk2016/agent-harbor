---
layout: home
title: Agent Harbor 文档
description: 了解、安装和使用 Agent Harbor，完成文件任务、创建应用，并管理团队、模型和额度。

hero:
  name: Agent Harbor
  text: 把任务交给 Agent
  tagline: 自托管的 Claude Code 工作台。处理文件、创建 Web 应用，管理团队的模型、工具和使用额度。
  actions:
    - theme: brand
      text: 开始使用
      link: /getting-started
    - theme: alt
      text: 完成第一个任务
      link: /first-task
    - theme: alt
      text: 了解产品
      link: /product-overview

features:
  - icon: 📄
    title: 处理文件与任务
    details: 上传资料，让 Agent 分析、整理或生成文件。查看执行过程，下载结果，在同一会话中继续修改。
    link: /first-task
  - icon: 🛠️
    title: 创建并发布应用
    details: 通过对话创建 Web 应用，在预览中试用和调整，确认后发布到自己的服务器。
    link: /applications
  - icon: 🔑
    title: 管理团队的使用
    details: 为成员配置账号、模型和工具，管理权限与额度，查看请求和运行情况。
    link: /manage
  - icon: 🧭
    title: 按需要配置
    details: 从基本文件任务开始，再按需要接入技能、外部工具、应用托管和观测。
    link: /configuration
---

## 从一次文件任务开始

上传一份 CSV，让 Agent 按类别汇总并生成新文件。查看它用了哪些工具，下载结果，再继续提出修改要求。

![工作台中展示任务过程，右侧文件区提供生成的 CSV。](assets/product/workbench.png)

[跟着教程完成第一个任务 →](first-task.md)

## 找到你的入口

- **刚了解 Harbor**：[产品介绍](product-overview.md)讲清功能和适用范围，[设计理念](concepts.md)解释会话、技能、应用和数据的关系。
- **准备安装**：从[开始使用](getting-started.md)选择入口，按[安装与启动](quickstart.md)完成配置。
- **已有工作台账号**：查看[使用指南](guide.md)，了解文件、技能和应用怎么用。
- **负责团队管理**：查看[配置与管理](manage.md)，设置登录、模型、成员和额度。
- **遇到疑问**：先查[常见问题](faq.md)或[故障排查](troubleshooting.md)，也可以用顶部搜索。

## 使用前了解

Harbor 适合个人开发者和受信的小团队。服务和工作文件由你部署管理；使用远程模型或外部工具时，相应任务内容会发送给所选服务。模型费用由供应商收取，Harbor 中的额度用于管理平台内的使用。

[GitHub 仓库](https://github.com/chenyk2016/agent-harbor) · [安全说明](https://github.com/chenyk2016/agent-harbor/blob/main/SECURITY.md) · [Apache-2.0 许可证](https://github.com/chenyk2016/agent-harbor/blob/main/LICENSE)
