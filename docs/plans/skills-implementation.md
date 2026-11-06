# Skill 功能开工方案

日期：2026-10-23 · 依据：[Skill 完整规格](../specs/skills.md)、[专家规格](../specs/experts.md) · 状态：待用户确认后执行

规格第 19.1 节把阶段 A 定为硬门槛。本文不改规格，只回答一件事：**代码已经是什么样，第一步具体做什么，做到什么算通过。**

## 1. 结论

先做阶段 A（原生装载验证），与阶段 B1/B2（表结构、包校验）并行。理由：

- A 决定 D 的形态（插件怎么生成、怎么挂载、Skill 工具怎么放行）。A 不通过，D 要改设计。
- B1/B2 是纯本地逻辑（Drizzle 表、ZIP 边界、SKILL.md 解析），不依赖 Docker 和模型，A 失败也不浪费。
- C 里的 Python 依赖准备存在一个必须先解决的硬问题：**当前执行镜像没有 pip**（见第 2 节）。首版若只做无依赖技能，C 可以缩小到"复制 + 校验 + 生成装载包"。

不建议先做前端。页面依赖接口形状，接口依赖快照模型，快照模型依赖 A 的结论。

## 2. 已核实的起点

以下都来自当前代码和本机实测，不是规格转述。

| 项 | 事实 | 位置 |
| --- | --- | --- |
| 工具清单 | `Read/Write/Edit/Glob/Grep/Bash`，**没有 Skill** | `src/shared/types.ts:6` |
| Runner 配置 | 无 `plugins`、无 `skills`、无 `pluginDelivery`；`settingSources: []` | `src/agent/runner-options.ts` |
| 工具放行 | `canUseTool` 只放行 5 个文件工具，其余一律 deny | `src/agent/runner-options.ts:74` |
| Bash | 依赖管理员策略 `autoAllowBashIfSandboxed: true` 自动批准，不经过 `canUseTool` | `infra/managed-settings.json` |
| 容器挂载 | 只有 `workspace`、`claude-state`、`attempts`(ro)；无 `/opt/harbor-skills` | `src/docker/docker.ts:131-133` |
| 容器规格 | `--read-only`、非 root 1000、cap-drop ALL、2C/4G/256pids、`/tmp` 256m | `src/docker/docker.ts:101-136` |
| HTTP 路由 | 手工分支，`parts[1] !== "sessions"` 直接 404；JSON body 上限 256KB | `src/service/http-api.ts:28,80` |
| 数据库 | 10 张表（用户/身份/会话/消息/事件/用量），无 Skill 相关表 | `src/service/db/schema/` |
| 迁移机制 | `migrations/*.sql` + 校验值 + `npm run db:migrate`，服务启动不建表 | `src/service/db/migrate.ts` |
| 镜像 Python | Python 3.11.2，**无 pip、无 ensurepip，`python3 -m venv` 直接失败** | 实测 `agent-harbor:0.4.0` |
| 镜像 Node | Node 24.14.0、npm 11.9.0，可离线装本地包但无缓存 | 实测 |
| 镜像目录 | `/opt` 对 uid 1000 不可写；`/opt/harbor-skills` 不存在 | 实测 |
| 镜像版本约束 | 会话 `session.json` 记 `imageId`，镜像内容变化会导致 resume 拒绝 | `src/runtime/conversation.ts:193-195` |

SDK 0.3.306 类型里与本功能直接相关的四件事（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）：

1. `Options.skills?: string[] | 'all'`。注释明确：**省略不等于关闭**（CLI 默认仍会加载），传 `[]` 才是"一个都不启用"；同时注明这是**上下文过滤，不是沙箱**，未列出的技能文件仍在磁盘上，可被 Read/Bash 读到（`sdk.d.ts:2305-2322`）。
2. `Options.plugins?: SdkPluginConfig[]`，只支持 `{ type: 'local', path, skipMcpDiscovery? }`。`skipMcpDiscovery: true` 表示只加载 skills/hooks/agents/commands，不读该插件的 `.mcp.json`（`sdk.d.ts:5826-5841`）。这正好对应规格"上传方提供的 MCP 不交给 SDK"。
3. `Options.pluginDelivery?: 'argv' | 'initialize'`。`initialize` 要求 CLI ≥2.1.261（SDK 自带满足），并通过 `initializationResult().plugins_applied` 返回"每个插件都装上了"的布尔值（`sdk.d.ts:2069-2083, 4768-4773`）。这比解析 init 命令列表更可靠。
4. 管理员策略里有 `strictPluginOnlyCustomization?: boolean | ('skills'|'agents'|'hooks'|'mcp')[]`，可只允许插件来源的技能，屏蔽 `~/.claude/skills` 与项目 `.claude/skills`（`sdk.d.ts:7587`）。是否启用属于阶段 A 的加固项，不是前置条件。

## 3. 阶段 A：最小原生验证

目标不是"能跑一个技能"，而是**证明当前 SDK + 镜像 + 管理员策略这个组合，能把一份平台生成的只读技能包装进去、被模型看见、被调用、且写不进去**。

### 3.1 夹具

```text
tests/fixtures/skill-probe/
  personal/.claude-plugin/plugin.json      {"name":"personal","version":"0.0.1"}
  personal/skills/table-summary/SKILL.md   带 frontmatter，user-invocable: true
  personal/skills/table-summary/scripts/echo.py
  builtin/.claude-plugin/plugin.json       {"name":"builtin","version":"0.0.1"}
  builtin/skills/table-summary/SKILL.md    与 personal 同名，用于命名空间对照
```

挂载方式与正式实现一致：宿主目录 `--mount type=bind,...,dst=/opt/harbor-skills,readonly`。**不要**在探针里图省事挂成可写，否则 A4 的结论无效。

### 3.2 探针与判定

| 编号 | 做什么 | 通过标准 |
| --- | --- | --- |
| A1 | `plugins:[{type:'local',path:'/opt/harbor-skills/personal'}], pluginDelivery:'initialize', skills:['personal:table-summary']` | `initializationResult().plugins_applied === true` |
| A2 | 同一次 init 读 `commands` | 出现 `/personal:table-summary`；`builtin:table-summary` 不出现（未选） |
| A3 | 显式发送 `/personal:table-summary`，再发一句自然语言让它自动选 | 两次都产生 `Skill` 工具调用，且 `input.skill` 指向 personal 命名空间 |
| A4 | 让模型 `Read` 技能文件、`Bash cat`、`Bash echo >` 写回 | 前两个成功，写入返回只读错误；`/workspace` 写入成功 |
| A5 | personal 与 builtin 同名技能同时装载 | 两条命令分别可调用，互不覆盖 |
| A6 | 脚本执行中途 abort | query 结束，容器内进程不残留，后续消息仍可用 |
| A7 | SKILL.md 正文写一行动态命令语法（`!` 前缀） | 记录是否被执行。被执行则必须在导入侧拒绝，不能只靠文档声明 |
| A8 | 空选择：`skills: []` | 任何技能都不可见、不可调用（证明"空 = 不加载"，而不是"加载全部"） |

A1/A2 只需初始化，不必产生业务结果；A3/A4 需要真实模型调用，是唯一有成本的部分。建议每次 query 限 `maxTurns: 2`，用一个"读文件并回报内容"的极短任务，控制在个位数次调用。

### 3.3 产出

- `var/evidence/skills-phase-a/2026-10-23/REPORT.md`：逐项通过/失败、原始 init JSON 摘要、失败时的 stderr。
- `tests/fixtures/skill-probe/`：可重复执行的夹具，后续 C/D 直接复用。
- 一个临时脚本 `tests/skill-probe.mjs`（不进 `npm test`，避免 CI 依赖模型）。

### 3.4 实测结论（2026-10-23 已完成）

A1、A3、A4、A5、A6 通过；A2 与 A8 不通过，A7 确认为风险。完整证据见 `var/evidence/skills-phase-a/2026-10-23/REPORT.md`。

- `skills` 选项在本版本对插件技能**既不过滤命令表，也不阻止调用**：传 `['personal:table-summary']` 时 `/personal:dyn-probe` 仍被执行；传 `[]` 等同未指定。
- 隔离只能靠"不生成、不挂载"：每会话插件只放所选技能。
- SKILL.md 里的 `!`command`` 会在技能调用时执行，必须在校验阶段拒绝。
- 零技能会话若要去掉 CLI 自带的 19 个内置技能，用会话级 `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`，不改镜像。
- 装载证据要看两处：`plugins_applied` 证明插件装载，`system/init.skills` 证明技能被发现。

### 3.5 如果 A 不通过

按失败项分流，不改权限去迁就：

- A1 失败（插件没装上）：先查 `pluginDelivery` 与 CLI 版本，再退回 `argv` 方式；两者都不行说明插件路线不可用，D 改为"直接把技能目录放进 `CLAUDE_CONFIG_DIR/skills`"，但那样就失去 `skills` 过滤的命名空间语义，需要回到规格改设计。
- A3 失败（工具被拒）：`canUseTool` 要显式放行 `Skill`，但**不能**因此放开 Bash；Bash 仍走沙箱自动批准。
- A4 失败（能写）：说明只读挂载或沙箱写规则没生效，属于阻塞问题，必须先修再谈功能。

## 4. 阶段 B：内容管理（可与 A 并行）

**B1/B2 已完成（2026-10-23）**：`skills`、`skill_versions`、`skill_imports`、`user_skills` 四张表与 `migrations/0001_skills_library.sql` 已落地，slug 范围、版本号、请求键与外键约束有测试；`src/service/skills/manifest.ts` 完成 SKILL.md 解析、路径/体积边界、保留目录、动态命令拒绝与 `harbor-skill.json` 校验，12 项单测通过。B3 起未做。

按"能独立测试"切，不按表切。

| 序号 | 内容 | 依赖 | 可验证方式 |
| --- | --- | --- | --- |
| B1 | `skills`、`skill_versions`、`user_skills`、`skill_imports` 四张表 + 迁移 + Drizzle 类型 | 无 | 迁移在空库应用；唯一约束/部分索引有测试 |
| B2 | `manifest.ts`：SKILL.md frontmatter 解析、`harbor-skill.json` 校验、路径与体积边界、兼容报告 | 无 | 纯函数单测：穿越、大小写冲突、超限、缺字段、保留目录 |
| B3 | `package-store.ts`：ZIP 流式校验、暂存、草稿 revision、发布、导出 | B1/B2 | 真实 ZIP 夹具；发布失败不留半份版本 |
| B4 | `http.ts`：`/api/skills`、`/api/skill-imports`；ZIP 走原始字节路由，绕开 256KB JSON 上限 | B3 | 跨用户 404、幂等 apply、断线重查 |
| B5 | 前端「我的技能」：列表、详情、文件树、导入报告 | B4 | 375 窄屏、A→B→A |

B4 要注意现有路由是 `parts[1] !== "sessions"` 直接 404，需要在这行之前插入 skill 分支，而不是重写成通用路由器；`body()` 只能用于 JSON，ZIP 上传必须单独读流并自己限长。

B5 需要先给前端加一个最小视图切换。当前 `apps/web` 是单工作台，没有路由；建议在 `App.tsx` 里加一个 `view: "workbench" | "skills"` 状态 + 侧栏入口，不引入 react-router。

## 5. 阶段 C：准备与构建

拆成"无依赖"和"有依赖"两段，避免被镜像问题堵住整条链路。

**C1 无依赖技能（先做）**：准备 = 复制版本目录 → 生成 `.harbor-runtime/runtime.json` → 校验入口文件存在 → 发布产物 → `ready`。不需要下载容器，也不需要联网。这一步就能跑通"发布 → 准备 → 启用 → 新会话装载"的完整链路，只是技能里不能有第三方库。

**C2 有依赖技能（需要先补镜像）**：当前镜像没有 pip/ensurepip，`python3 -m venv` 失败，Python 依赖无法安装。两个选择：

- 在执行镜像里加 `python3-pip python3-venv`（体积增加，且**镜像 digest 变化**）；
- 新建专用运行档位镜像（推荐），执行镜像不动，技能会话使用新档位。

无论哪种，都要发新标签（例如 `agent-harbor:0.5.0`），不能让 `0.4.0` 的内容变掉：`conversation.ts:195` 会在 resume 时比对 `imageId`，镜像内容一变，现有会话恢复会被拒。新档位要连同 `runtimeProfileRevision` 一起进快照。

**C3 共享 build**：`skill_builds` + `skill_build_requests`，两个等待者共用一个构建，最后一个取消才停容器。C1 阶段可以先只做单请求，等 C2 有真实下载耗时后再引入共享语义——否则是在没有并发证据的情况下提前造调度器。

## 6. 阶段 D：会话与专家

| 序号 | 内容 | 说明 |
| --- | --- | --- |
| D1 | `capabilitySnapshot` + `sessions` 两个可空字段 + 创建接口扩展 | 快照里固定 `skillVersionId/buildId/namespace/slug/invocationName/sourceHash/buildDigest` |
| D2 | 会话装载包生成：`sessions/<id>/capabilities/<digest>/` | 只放本次选中的技能，不挂用户全部版本 |
| D3 | Docker 增加只读挂载 + Runner 传 `plugins`/`skills`/`tools` | 空快照显式 `skills: []` |
| D4 | `runtime/session.json` 记录 `capabilityDigest`，恢复时核对 | 摘要不符拒绝恢复，不静默换新版 |
| D5 | 专家绑定 | 依赖专家模块，排在最后 |

D3 的关键是"只有快照非空时才加挂载和插件参数"，普通会话的行为必须与今天完全一致，否则会把一个未启用功能的风险扩散到所有用户。

## 7. 建议的开工顺序

阶段 A 已完成（见 3.4），下一步从 B1/B2 开始，再做 D3 的最小改动。

1. ~~阶段 A 的夹具与探针脚本，先跑 A1/A2/A8（不需要模型）~~（已完成）
2. ~~再跑 A3–A6（需要模型），出 A 的报告~~（已完成）
3. 开 B1/B2：建表 + 迁移 + manifest 纯函数，这两块不碰容器，可以立刻写测试。
4. A 通过后接 D3 的最小改动（挂载 + Runner 参数），用探针夹具当"假技能"验证，再回头做 B3/B4/B5。
5. C1 在 B3 之后，C2 等镜像方案定了再做。

## 8. 需要先决定的三件事

1. **是否现在跑阶段 A**：需要几次真实模型调用（每次 1–2 轮，短提示），会产生少量费用。不跑就只能靠类型定义推断，规格明确说这不算验证。
2. **首版是否只支持无依赖技能**：如果是，C2 和镜像改造可以整体后置，首版范围变成"纯说明 + 自带脚本 + Node 依赖"（Node 有 npm，但没有 registry 缓存，仍要下载阶段）。如果首版必须支持 Python 库，镜像改造要先做。
3. **是否允许新增运行档位镜像**：新镜像意味着新标签、新档位、现有会话继续用 0.4.0。需要确认部署上能同时保留两个镜像。

## 9. 风险与需要修正的设计点

- **`skills` 不是过滤器**。实测：选一个技能时，同插件内未选中的技能仍出现在命令表并可被调用；传空数组等同未指定。隔离只能靠不生成、不挂载。
- **`canUseTool` 目前会拒绝 Skill**。加 `Skill` 到 `tools` 不够，回调也要放行；但放行 Skill 不能顺带放开 Bash 或任意工具。
- **Bash 的批准路径独立**。脚本能不能跑取决于沙箱自动批准，不是 `canUseTool`；A4/A6 必须实测，不能从配置推断。
- **上传与现有 body 限制冲突**。20MiB 的 ZIP 走不了 256KB 的 JSON body，必须新增原始字节路由。
- **前端没有路由**。加页面需要最小视图切换，不要为此引入路由库或全局状态库。
- **镜像 digest 与会话恢复绑定**。任何镜像改动都要新标签，否则老会话 resume 会被拒。
- **规格里的 `harbor-skill.json` 是平台扩展**，不是 Claude Skill 标准。导入第三方包时它多半不存在，首版要能在"没有它"的情况下完成发布（纯说明技能），只对声明了依赖的包要求它。

## 10. 不在本方案内

专家功能（`docs/specs/experts.md`）的专家表、表单、发布与激活流程；它依赖本方案的 D1/D2 产出，等 Skill 会话快照稳定后再开。本文也不改任何运行代码。
