import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'Agent Harbor',
  description: '自托管的 Claude Code 工作台：完成文件任务，创建并发布 Web 应用，管理团队、模型和额度。',
  base: '/agent-harbor/',
  cleanUrls: false,
  lastUpdated: true,
  // Keep engineering notes in the repository, outside the product site and search.
  srcExclude: [
    'articles/**', 'evidence/**', 'specs/**', 'spec/**', 'design/**', 'plans/**', 'theme/**',
    'architecture.md', 'code-reading.md', 'dependency-runtime.md', 'http-routing.md',
    'llm-baseline.md', 'migration.md', 'package-readme.md', 'pages-publishing.md',
    'product-quality.md', 'react-web.md', 'releasing.md', 'roadmap.md', 'service.md',
    'streaming-validation.md', 'testing.md', 'users-and-limits.md', 'web-client.md',
  ],
  themeConfig: {
    nav: [
      { text: '产品介绍', link: '/product-overview' },
      { text: '开始使用', link: '/getting-started' },
      { text: '使用指南', link: '/guide' },
      { text: '配置与管理', link: '/manage' },
      { text: '设计理念', link: '/concepts' },
    ],
    sidebar: [
      {
        text: '了解产品',
        items: [
          { text: '产品介绍', link: '/product-overview' },
          { text: '设计理念', link: '/concepts' },
        ],
      },
      {
        text: '开始使用',
        items: [
          { text: '选择你的使用入口', link: '/getting-started' },
          { text: '安装与启动', link: '/quickstart' },
          { text: '第一个任务', link: '/first-task' },
        ],
      },
      {
        text: '使用指南',
        collapsed: true,
        items: [
          { text: '使用指南总览', link: '/guide' },
          { text: '对话与任务', link: '/session-lifecycle' },
          { text: '工作区与文件', link: '/workspace-files' },
          { text: '技能', link: '/skills' },
          { text: '外部工具（MCP）', link: '/mcp' },
          { text: 'WorkBuddy 专家', link: '/workbuddy-experts' },
          { text: '创建与发布应用', link: '/applications' },
          { text: '应用访客登录', link: '/application-login' },
          { text: '应用数据与观测', link: '/application-observability' },
          { text: '删除会话与应用', link: '/deletion' },
          { text: '命令行使用', link: '/cli' },
        ],
      },
      {
        text: '配置与管理',
        collapsed: true,
        items: [
          { text: '配置与管理总览', link: '/manage' },
          { text: '账号与登录', link: '/identity' },
          { text: '模型与网关', link: '/llm-gateway' },
          { text: '管理后台', link: '/admin' },
          { text: '额度与计费', link: '/wallet' },
          { text: '应用功能配置', link: '/application-configuration' },
          { text: '模型与任务观测', link: '/llm-observability' },
          { text: '配置参考', link: '/configuration' },
          { text: '团队部署与备份', link: '/deployment' },
        ],
      },
      {
        text: '遇到问题',
        items: [
          { text: '常见问题', link: '/faq' },
          { text: '故障排查', link: '/troubleshooting' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/chenyk2016/agent-harbor' }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详情',
                resetButtonTitle: '清空搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到相关文档',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    outline: { label: '本页目录', level: [2, 3] },
    lastUpdatedText: '最后更新',
    docFooter: { prev: '上一页', next: '下一页' },
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换浅色模式',
    darkModeSwitchTitle: '切换深色模式',
    skipToContentLabel: '跳转到正文',
    footer: { message: 'Apache-2.0 License', copyright: 'Agent Harbor' },
  },
});
