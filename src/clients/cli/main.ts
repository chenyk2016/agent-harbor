/** 默认CLI只访问会话服务，不读取模型凭证，不创建Docker容器。 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ServiceClient } from "../service-client.js";
import { chat } from "./chat.js";
import { display } from "./display.js";

const [command, id, ...words] = process.argv.slice(2);
try {
  const token = process.env.AH_SERVICE_TOKEN;
  if (!token) throw new Error("Set AH_SERVICE_TOKEN (service access key)");
  const client = new ServiceClient(process.env.AH_SERVICE_URL ?? "http://127.0.0.1:4318", token);
  if (command === "init") {
    console.log(JSON.stringify(await client.request("/sessions", "POST", { title: id ?? "New session", template: words[0] ?? "empty" }), null, 2));
  } else if (command === "list") {
    console.log(JSON.stringify(await client.request("/sessions"), null, 2));
  } else if (command === "status" && id) {
    console.log(JSON.stringify(await client.session(id), null, 2));
  } else if (command === "cancel" && id && words[0]) {
    console.log(JSON.stringify(await client.cancel(id, words[0])));
  } else if (command === "close" && id) {
    const session = await client.session(id);
    console.log(JSON.stringify(await client.close(id, session.lastMessageId)));
  } else if (command === "chat" && id) {
    await chat(client, id);
  } else if ((command === "run" || command === "watch") && id) {
    const watch = new AbortController();
    let messageId: string | undefined;
    let after = 0;
    if (command === "run") {
      const requestIndex = words.indexOf("--request-id");
      const clientMessageId = requestIndex >= 0 ? words.splice(requestIndex, 2)[1] : randomUUID();
      const text = words[0] === "--file" ? await readFile(words[1], "utf8") : words.join(" ");
      if (!text.trim()) throw new Error("Provide text or --file PATH");
      console.error(`[请求 ${clientMessageId}]`);
      const { message } = await client.send(id, clientMessageId, text);
      messageId = message.id;
      after = message.createdEventId - 1;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(message.status)) console.error(`[已有结果 ${message.status}，补看输出]`);
    } else if (words[0]) {
      after = Number(words[0]);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor");
    }
    const stop = () => {
      if (messageId) void client.cancel(id, messageId).catch(error => console.error(String(error)));
      else watch.abort();
    };
    const detach = () => watch.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", detach);
    process.on("SIGHUP", detach);
    try {
      for await (const event of client.events(id, after, watch.signal)) {
        display(event);
        if (command === "watch") console.error(`[事件 ${event.id}]`);
        if (event.type === "message.finished" && event.data.messageId === messageId) {
          if (event.data.status !== "succeeded") process.exitCode = 1;
          break;
        }
        if (event.type === "message.state" && event.data.messageId === messageId && event.data.status === "reconciling") {
          console.error("环境状态尚未确认，请查询status并协调后继续。");
          process.exitCode = 1;
          break;
        }
      }
    } finally {
      watch.abort();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", detach);
      process.removeListener("SIGHUP", detach);
    }
  } else throw new Error("Usage: cli init [TITLE] [empty|fix-project] | list | status SESSION | run SESSION TEXT [--request-id UUID] | run SESSION --file PATH | chat SESSION | watch SESSION [CURSOR] | cancel SESSION MESSAGE | close SESSION");
} catch (error) { console.error(String(error)); process.exitCode = 1; }
