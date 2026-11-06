import { stopAndRemove } from "../runtime/providers/contracts.js";
/** 服务崩溃不会被当作任务成功；先确认旧写入者停止，再允许新消息。 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Controller } from "../runtime/controller.js";
import { clearStartupCredentials } from "../runtime/mcp-startup.js";
import { lockSession } from "../runtime/storage.js";
import type { ServiceStore } from "./service-store.js";
export async function recover(store: ServiceStore, controller: Controller) {
  const directories = await readdir(controller.store.root, { withFileTypes: true });
  // Source libraries are siblings of sessions. Discover only runtime directories, never turn a library into a session.
  const diskIds = await Promise.all(directories
    .filter(dir => dir.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(dir.name))
    .map(async dir => {
      const files = await readdir(join(controller.store.root, dir.name));
      return files.includes("session.json") || files.includes("attempts") ? dir.name : undefined;
    }));
  const ids = new Set([
    ...(await store.sessions()).map(session => session.id),
    ...diskIds.filter((id): id is string => id !== undefined),
    ...await controller.resident.findOwnedSessions(),
  ]);
  const releases: (() => Promise<void>)[] = [];
  try {
    // 先取得全部锁。发现仍在工作的本地CLI时，不清理其环境，不偷走所有权。
    for (const id of ids) {
      const directory = await controller.store.prepare(id);
      try { releases.push(await lockSession(directory)); }
      catch { throw new Error("DATA_DIR_IN_USE: another runtime owns a session"); }
    }
    let ready = true;
    for (const id of ids) {
      try {
        const session = await controller.store.load(id); // 损坏元数据不能覆盖为空记录。
        for (const ref of await controller.resident.findOwned(id)) {
          await stopAndRemove(controller.resident, ref);
        }
        for (const attempt of new Set([session.runnerId, session.attemptId])) if (attempt) {
          await clearStartupCredentials(join(controller.store.directory(id), "attempts", attempt));
        }
        session.stopped = true;
        session.environment = "closed";
        if (["starting", "running", "finalizing", "reconciling"].includes(session.status ?? "")) {
          session.status = "failed";
          session.error = "Service restarted; unfinished input was not replayed";
        }
        await controller.store.save(session);
        // 旧V2目录没有owner，保留在磁盘，不自动授予服务用户。
        if (await store.session(id)) {
          await store.environment(id, "closed");
          const active = await store.active(id);
          if (active) await store.transition(active.id, "interrupted");
        }
      } catch (error) {
        console.error("Recovery unconfirmed", error);
        ready = false;
        if (await store.session(id)) {
          await store.environment(id, "reconciling");
          const active = await store.active(id);
          if (active) await store.transition(active.id, "reconciling");
        }
      }
    }
    return ready;
  } finally { for (const release of releases.reverse()) await release(); }
}
