/** 构建容器入口：复制固定源码、禁用依赖安装脚本，再调用平台构建器；整个过程不在宿主执行。 */
import { cp } from "node:fs/promises";
import { spawn } from "node:child_process";
await cp("/input", "/work", { recursive: true, force: true });
for (const args of [
  [
    "npm",
    [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ],
  ],
  [
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      "web-vitals@6.2.3",
    ],
  ],
  ["node", ["/platform/build.mjs"]],
]) {
  await new Promise((resolve, reject) => {
    const child = spawn(args[0], args[1], { cwd: "/work", stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("APP_BUILD_STEP_FAILED: " + args[0] + ": " + code)),
    );
  });
}
