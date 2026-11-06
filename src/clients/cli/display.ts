import type { ClientEvent } from "../service-client.js";
export function display(event: ClientEvent) {
  if (event.type === "assistant.text.delta") process.stdout.write(String(event.data.text));
  else if (event.type === "tool.started") console.log(`\n[工具：${event.data.name}]`);
  else if (event.type === "message.finished") console.log(`\n[${event.data.status}]`);
  else if (event.type === "message.stopping") console.log("\n[正在停止当前任务]");
}
