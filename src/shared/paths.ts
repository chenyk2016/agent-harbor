/**
 * 容器内的平台目录约定。子目录各自挂载，读写权限和生命周期仍然分开。
 * 保护父目录即可覆盖新增子目录，避免在不同权限配置中重复维护路径。
 */
const platformRoot = "/platform";

export const containerPaths = {
  workspace: "/workspace",
  dependencyEnv: "/session-env",
  dependencyCache: "/dependency-cache",
  runtime: `${platformRoot}/runtime`,
  state: `${platformRoot}/state`,
  run: `${platformRoot}/run`,
  managedSettings: "/etc/claude-code",
};

// 文件工具和 Bash 沙箱共用这份保护根；具体规则由 infra/generate-policy.mjs 生成。
export const protectedRoots = [platformRoot, containerPaths.managedSettings];
