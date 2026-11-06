/** 只消费管理员配置的脱敏JSON日志；偏移落观测库，重放由文件位置去重。 */
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ObservationStore } from "./store.js";
export async function collectEdgeLog(store: ObservationStore, path: string) {
  const file = await open(path, "r");
  try {
    const meta = await file.stat();
    if (!meta.isFile()) throw new Error("EDGE_LOG_NOT_FILE");
    const saved = (
      await store.pool.query(
        "SELECT value FROM observation_state WHERE app_id='_host' AND environment='host' AND key='edge_cursor'",
      )
    ).rows[0]?.value;
    const fileIdentity =
      String(meta.dev) +
      ":" +
      String(meta.ino) +
      ":" +
      String(meta.birthtimeMs);
    const same = saved?.fileIdentity === fileIdentity;
    const truncated = same && saved.offset > meta.size;
    const generation =
      same && !truncated
        ? saved.generation
        : truncated
          ? String(meta.ctimeMs)
          : "0";
    const identity = fileIdentity + ":" + generation;
    const offset = same && !truncated ? saved.offset : 0;
    if (saved && (!same || truncated))
      await store.state("_host", "host", "edge_rotation", {
        at: Date.now(),
        gapPossible: true,
        truncated,
      });
    const buffer = Buffer.alloc(
      Math.min(1048576, Math.max(0, meta.size - offset)),
    );
    if (!buffer.length) return;
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    let end = 0;
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] === 10) {
        const line = bytes.subarray(end, i);
        const start = offset + end;
        end = i + 1;
        try {
          const log = JSON.parse(line.toString("utf8"));
          const deployment = log.harbor_deployment;
          if (typeof deployment !== "string") continue;
          const binding = await store.binding(deployment);
          if (!binding) continue;
          const occurredAt = Math.round(Number(log.ts) * 1000);
          if (!Number.isFinite(occurredAt)) continue;
          await store.ingest(binding, "edge", {
            eventId: createHash("sha256")
              .update(identity + ":" + start)
              .digest("hex"),
            eventName: "edge_request",
            occurredAt,
            properties: {
              status: Number(log.status) || 0,
              durationMs: Math.max(0, Number(log.duration) * 1000) || 0,
              method: [
                "GET",
                "HEAD",
                "POST",
                "PATCH",
                "DELETE",
                "PUT",
                "OPTIONS",
              ].includes(log.request?.method)
                ? log.request.method
                : "GET",
            },
          });
        } catch (e) {
          if (
            e instanceof SyntaxError ||
            (e instanceof Error && /INVALID_|DENIED/.test(e.message))
          ) {
            await store.state("_host", "host", "edge_rejected", {
              at: Date.now(),
            });
          } else throw e;
        }
      }
    // 没有换行的大行不无限占住游标，记显式丢弃。
    if (!end && bytesRead === buffer.length && buffer.length === 1048576) {
      end = bytesRead;
      await store.state("_host", "host", "edge_rejected", {
        at: Date.now(),
        oversized: true,
      });
    }
    await store.state("_host", "host", "edge_cursor", {
      identity,
      fileIdentity,
      generation,
      offset: offset + end,
    });
  } finally {
    await file.close();
  }
}
