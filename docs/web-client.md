# 网页客户端与消息状态

先按[安装指南](quickstart.md)准备实例、管理员和模型。服务按实际环境文件启动，默认打开http://127.0.0.1:4318。页面、HTTP与SSE都由这个进程提供。现行前端代码位于 `apps/web/`。

## 使用

1. 使用已配置的密钥、邮箱密码或OIDC登录。首页选择「对话」或「应用」，描述目标并发送后创建；普通对话默认使用空工作区。
2. 点击发送或按Enter提交；Shift+Enter换行，中文输入法组词时不发送。一整段文字是一条消息。
3. 回答持续显示，工具记录可展开。一个会话同时执行一条消息，忙时输入只保存草稿。
4. 切换/刷新后恢复历史和草稿；关闭页面不停止任务。重新进入从已保存的事件补看。
5. 停止本轮优先原生中断，正常结束后保留环境。关闭环境停止容器内全部进程，文件和对话保留。

页面区分查看连接、消息执行、工作环境三个状态。提交返回202代表已接收，不表示完成；停止/关闭也必须等待最终事件确认。断线时可写草稿，核对当前状态后再恢复操作。

## 按一条消息阅读代码

```text
features/Chat.tsx：用户点击发送
  → state/workspace.ts：捕获会话、保存请求ID、调用API
  → state/api.ts / src/clients/service-client.ts：同源HTTP和Cookie
  → src/service/http-api.ts：检查身份、归属和正文
  → SessionManager → Conversation → 配置的执行后端 → 常驻Runner → SDK
  → PostgreSQL保存公开事件 → SSE
  → state/conversation-state.ts：按编号推进原消息
  → React订阅变化，重新显示回答、工具和状态
```

正式前端位于`apps/web`：`app`组合页面与统一主题，`features`按会话/文件/账户划分，`state`保存已有状态对象，`shared`放小型公共展示组件。没有新增全局状态库；异步响应归属和幂等请求ID沿用原实现。

`npm run build`先编译后端，再由Vite生成`dist/web`，Node同源提供静态文件。开发时另运行`npm run dev:web`使用热更新。Markdown采用react-markdown，不启用原始HTML。完整目录、开发方式与取舍见[React前端说明](react-web.md)。执行镜像由实例的`AH_IMAGE`指定，按[安装指南](quickstart.md)构建当前发行镜像；网页构建与任务镜像分别管理。

## 为什么保留这些小机制

- **先历史，后事件流**：历史每页固定同一through上界，避免翻页时遗漏正在产生的输出；SSE从最后编号接上。每次重连先查询当前快照，流追到快照编号才恢复操作。
- **编号先保存，再发送**：响应丢失后保留原clientMessageId和正文。刷新/补看可确认接受；显式重试也只使用原编号，不自动生成第二个任务。
- **按对象捕获异步动作**：A→B→A使用选择代数排除旧返回；发送成功只清除原会话、原文对应的草稿。弹窗保存会话和所见messageId，服务端再拒绝过时关闭请求。
- **连接不拥有任务**：页面关闭、SSE断开和Cookie退出只释放观看连接。服务拥有执行AbortController，取消必须通过明确接口。
- **可读模板与纯状态分开**：更换UI不会改中断逻辑；回放测试也不用启动浏览器。React中的动态文本统一转义，不接收模型HTML。

## 范围

当前工作台包括文件处理、技能、专家、MCP、应用和模型管理；管理员还可进入成员、额度、用量和运行状态页面。UI路由以`apps/web/src/app/App.tsx`为准。文件限制见[工作区与文件](workspace-files.md)，身份配置见[账号与登录](identity.md)，后台见[管理后台](admin.md)。

运行器与服务事件已记录工具发起、完成、失败和拒绝，生成及筛选位置分别为`src/agent/runner-options.ts`和`src/service/session-manager.ts`。但当前网页的`state/conversation-state.ts`与`features/chat/ToolTimeline.tsx`仍只展示发起记录、名称和可用摘要，不展示完整工具参数、返回或逐工具完成状态；执行结果需核对回答和工作文件。支持的工具正文可另外由管理员配置[Langfuse观测](llm-observability.md)。浏览器草稿不加密；有效登录会话和会话历史保存在PostgreSQL中。当前没有组织/RBAC和审批产品，长历史也没有虚拟列表。

真实网关验收可以证明有限任务的工具、文件与连续上下文；不能替代用户业务验收或生产隔离审查。分层步骤见[测试指南](testing.md)。
