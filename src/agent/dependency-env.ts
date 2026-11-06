/** 固定会话目录里建立Python环境，不解析技能，不预装第三方包。 */
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containerPaths } from "../shared/paths.js";
const exec = promisify(execFile);
export async function prepareDependencyEnvironment() {
  // 保留旧镜像运行能力：它们没有uv，也不强制迁移已有Python环境。
  try { await access("/usr/local/bin/uv"); } catch { return; }
  const directory = `${containerPaths.dependencyEnv}/venv`;
  try { await access(`${directory}/pyvenv.cfg`); return; } catch {}
  await exec("/usr/bin/python3", ["-m", "venv", directory], { timeout: 30_000 });
}
