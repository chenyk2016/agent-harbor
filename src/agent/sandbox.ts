/**
 * 容器内的启动前检查，由 Runner 在调用模型之前执行。
 * 只检查 bwrap 的基本命名空间能力；完整文件、凭证和网络隔离需另行验收。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/**
 * 实际创建用户/进程命名空间并执行空操作；失败时抛错，阻止 Runner 开始采样。
 * 仅安装了 bwrap 仍可能受 Docker/内核限制，因此需要执行而不只检查版本。
 */
export async function checkSandbox() {
  await exec(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "/bin/true",
    ],
    {
      timeout: 5_000,
      maxBuffer: 16_384,
    },
  );
}
