// Protocol-only test worker. It never imports Claude SDK and cannot prove Agent behavior.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Task } from "../src/shared/types.js";
import { containerPaths } from "../src/shared/paths.js";
const task: Task = JSON.parse(
  await readFile(`${containerPaths.run}/task.json`, "utf8"),
);
let seq = 0;
const emit = (type: string, payload: Record<string, unknown>) =>
  process.stdout.write(
    JSON.stringify({
      type,
      seq: ++seq,
      sessionId: task.sessionId,
      attemptId: task.attemptId,
      generation: task.generation,
      payload,
    }) + "\n",
  );
emit("runner.ready", { fixture: true });
emit("sdk.session", { id: task.resumeId ?? "fixture-session" });
if (task.prompt === "malformed") {
  console.log("invalid-json");
  setInterval(() => {}, 1000);
} else if (task.prompt === "long") {
  // Ignore soft termination to require the supervisor's hard-stop path.
  process.on("SIGTERM", () => {});
  setInterval(() => {
    void appendFile("/workspace/ticks", "tick\n");
  }, 50);
} else {
  if (task.prompt === "background") {
    spawn(
      "node",
      [
        "-e",
        "setInterval(()=>require('fs').appendFileSync('/workspace/ticks','tick\\n'),50)",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
  }
  await writeFile(
    "/workspace/result.txt",
    task.resumeId ? "continued" : "first",
  );
  await writeFile(`${containerPaths.state}/state.txt`, "preserved");
  emit("agent.result", { subtype: "success", costUsd: 0 });
}
