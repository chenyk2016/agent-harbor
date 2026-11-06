/** 专家只描述工作方式与固定技能引用，不携带权限、路径或 SDK 启动参数。 */
export interface ExpertDefinition {
  name: string;
  description: string;
  role: string;
  workflow: string;
  output: string;
  examples: string[];
  skillVersionIds: string[];
  workbuddy?: WorkBuddyPackage;
}
/** 创建会话时固定的专家内容。instructions 进入普通专家的系统提示词，digest 用于阻止旧对话静默换指令；本对象不授予工具权限。 */
export interface ExpertSnapshot {
  schemaVersion: 1;
  /** 专家身份；与具体内容版本的 versionId 分开。 */
  expertId: string;
  /** 创建会话时选定的固定版本身份，用于追溯该次配置。 */
  versionId: string;
  version: number;
  name: string;
  /** 普通专家追加到原生系统提示词的正文；WorkBuddy 使用下方独立运行配置。 */
  instructions: string;
  examples: string[];
  /** 内容一致性指纹；恢复时不一致会拒绝继续旧原生对话，不是鉴权令牌。 */
  digest: string;
  /** 有值时走原生 Agent / 团队配置分支，普通 instructions 追加分支不启用。 */
  workbuddy?: WorkBuddyRuntime;
}

/** 原件的解析索引；原文件保存在sourcePath，不从这些字段反向重写源包。 */
export interface WorkBuddyAgent {
  name: string;
  description: string;
  prompt: string;
  skills: string[];
  maxTurns?: number;
}
/** 导入专家原包的解析结果与原件索引，包含主 Agent、技能和连接声明，供构建运行快照使用。 */
export interface WorkBuddyPackage {
  sourcePath: string;
  archiveHash: string;
  rootPrefix: string;
  manifest: Record<string, unknown>;
  agents: Record<string, WorkBuddyAgent>;
  agentName: string;
  expertType: "agent" | "team";
  skillPaths: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  connectors: string[];
  warnings: string[];
}
/** 运行器使用的 WorkBuddy 主 Agent、团队配置和预载技能上下文，与普通 instructions 追加路径分开处理。 */
export interface WorkBuddyRuntime {
  expertType?: "agent" | "team";
  agentName: string;
  agents: Record<string, WorkBuddyAgent>;
  packageHash: string;
  preloadedSkills?: { name: string; body: string; directory: string }[];
}
