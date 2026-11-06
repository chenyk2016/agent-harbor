/**
 * 会话容器的常驻主进程；工作通过 docker exec 执行。
 * CLI 异常消失时心跳停止，主进程退出，由 Docker 终止整个容器中的后代。
 * 心跳只是回收机制，确认停止仍以宿主 Docker inspect 为准。
 */
import { stat } from "node:fs/promises";
import { containerPaths } from "../shared/paths.js";

// 新容器只认自己的租约；缺省路径仅兼容旧的独立实验入口。
const leaseId = process.argv[2];
if (leaseId && !/^[a-f0-9-]{36}$/.test(leaseId)) throw new Error("Invalid lease ID");
const heartbeatPath = leaseId ? `${containerPaths.run}/.leases/${leaseId}` : `${containerPaths.run}/.heartbeat`;
const check = async () => {
  try {
    const heartbeat = await stat(heartbeatPath);
    if (Date.now() - heartbeat.mtimeMs > 30_000) process.exit(0);
  } catch {
    process.exit(1); // 失去租约文件时也不留下无人管理的工作环境。
  }
};
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
await check();
setInterval(() => void check(), 5_000);
