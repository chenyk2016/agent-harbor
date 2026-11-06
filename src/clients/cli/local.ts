/**
 * 宿主机上的开发命令入口，按命令调用 Controller。
 * init 建立示例项目；run 单次执行；chat 连续对话；status 查状态；cancel 请求停止。
 * 输出仅用于当前命令行，不承担后台任务的存活职责。
 */
import { cp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfiguredResidentProvider } from "../../runtime/providers/configured-resident.js";
import { Controller } from "../../runtime/controller.js";
import { lockSession } from "../../runtime/storage.js";
import { defaultProfile } from "../../shared/types.js";
import { chat } from "./local-chat.js";

/** 只有执行任务才需要凭证；init/status/cancel可独立使用。 */
function gatewayToken() {
  const token = process.env.AH_GATEWAY_TOKEN;
  if (!token || token === "replace-with-your-token")
    throw new Error("Set AH_GATEWAY_TOKEN in your environment or local .env file");
  return token;
}

const [command, sessionId, ...words] = process.argv.slice(2);
if (!command || !sessionId) {
  console.log(
    "Usage: npm run cli -- init|run|chat|status|cancel SESSION [prompt]\nSet AH_GATEWAY_URL, AH_MODEL, AH_GATEWAY_TOKEN for an authorized proxy.",
  );
  process.exitCode = 1;
} else {
  // 环境变量由受信开发者提供，覆盖本地初值；不将它们开放为用户启动参数。
  const controller = new Controller(
    process.env.AH_DATA_DIR ?? "var/sessions",
    {
      ...defaultProfile,
      gatewayUrl: process.env.AH_GATEWAY_URL ?? defaultProfile.gatewayUrl,
      model: process.env.AH_MODEL ?? defaultProfile.model,
      image: process.env.AH_IMAGE ?? defaultProfile.image,
    },
    engine => new ConfiguredResidentProvider(engine),
  );
  try {
    if (command === "init") {
      // 初始化也取得会话锁，避免复制文件时与正在运行的任务同时写工作区。
      const dir = await controller.store.prepare(sessionId);
      const release = await lockSession(dir);
      try {
        if ((await readdir(`${dir}/workspace`)).length)
          throw new Error("Workspace already initialized");
        await cp(resolve("examples/fix-project"), `${dir}/workspace`, {
          recursive: true,
        });
      } finally {
        await release();
      }
      console.log(`Workspace: ${dir}/workspace`);
    } else if (command === "status")
      console.log(
        JSON.stringify(await controller.store.load(sessionId), null, 2),
      );
    else if (command === "cancel") await controller.cancel(sessionId);
    else if (command === "chat") {
      process.exitCode = await chat(controller, sessionId, gatewayToken());
    } else if (command === "run") {
      // 凭证只从本地环境配置读取，不内置可用Token。
      const token = gatewayToken();
      if (!words.length) throw new Error("Provide a prompt");
      const abort = new AbortController();
      // Ctrl+C 经 Controller 取消任务并确认容器停止，不只退出当前 CLI。
      process.on("SIGINT", () => abort.abort());
      const result = await controller.run(
        sessionId,
        words.join(" "),
        token,
        (event) => {
          if (event.type === "assistant.text.delta")
            process.stdout.write(String(event.payload.text));
          else if (event.type === "runner.failed")
            console.error(`\n[${event.payload.code}] ${event.payload.message}`);
          else console.log(`\n[${event.type}]`);
        },
        abort.signal,
      );
      console.log("\n" + JSON.stringify(result, null, 2));
      if (result.status !== "succeeded") process.exitCode = 1;
    } else throw new Error("Unknown command");
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
