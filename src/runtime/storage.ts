/**
 * 宿主机上的会话文件存储与独占锁。
 * 每个会话分别保存 workspace、claude-state、attempts 和 session.json。
 * 这里只管理目录与元数据；真实容器是否停止，由 Controller 查询 Docker 确认。
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Session } from "../shared/types.js";

export class Store {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  directory(sessionId: string) {
    // 会话 ID 只能是目录名，避免把路径片段作为宿主目录或 Docker 挂载来源。
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionId))
      throw new Error("Invalid session ID");
    return join(this.root, sessionId);
  }
  /** 建立会话目录；已有工作文件与 Claude 状态原样保留。 */
  async prepare(sessionId: string) {
    const dir = this.directory(sessionId);
    for (const name of ["workspace", "claude-state", "attempts", "dependency-env", "dependency-env/home"])
      await mkdir(join(dir, name), {
        recursive: true,
        mode: name === "workspace" ? 0o755 : 0o700,
      });
    return dir;
  }
  /** 首次运行返回初始状态；已有元数据损坏时直接报错，避免丢失原会话映射。 */
  async load(sessionId: string): Promise<Session> {
    try {
      return JSON.parse(
        await readFile(join(this.directory(sessionId), "session.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { sessionId, generation: 0 };
      throw error;
    }
  }
  /** 写临时文件并 sync 后再 rename，减少读者遇到半份 session.json 的风险。 */
  async save(session: Session) {
    const path = join(this.directory(session.sessionId), "session.json");
    const file = await open(`${path}.tmp`, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(session, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(`${path}.tmp`, path);
  }
}

/**
 * 取得会话独占锁，返回异步释放函数；已被占用时立即报错。
 * 使用 Python 的 flock 持有文件描述符：Controller 退出后管道关闭，辅助进程释放锁。
 * 这个锁控制宿主并发；旧 Docker 容器可能仍在运行，下一次必须另行协调。
 */
export async function lockSession(
  directory: string,
): Promise<() => Promise<void>> {
  const program = `import fcntl,sys
f=open(sys.argv[1], 'a')
try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(2)
print('locked', flush=True)
sys.stdin.read()
`;
  const child = spawn("python3", ["-c", program, join(directory, ".lock")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ended = once(child, "exit");
  // 辅助进程输出后才算拿到锁；提前退出表示锁被占用或无法建立。
  const ready = await Promise.race([
    once(child.stdout, "data").then(() => true),
    ended.then(() => false),
  ]);
  if (!ready)
    throw new Error("Session is already running (or flock is unavailable)");
  return async () => {
    child.stdin.end();
    await ended;
  };
}
/** 检查取消标记等小文件；读取失败仅在文件不存在时返回 false。 */
export async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
