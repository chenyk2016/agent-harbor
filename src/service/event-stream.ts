/** 事件只从已提交记录读取。断开一个观看连接不会触碰执行控制器。 */
import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { ServiceStore } from "./service-store.js";

async function write(response: ServerResponse, frame: string) {
  if (response.writableLength > 1024 * 1024) throw new Error("Slow event reader");
  if (response.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      response.off("drain", drained);
      response.off("close", closed);
      error ? reject(error) : resolve();
    };
    const drained = () => finish();
    const closed = () => finish(new Error("Reader disconnected"));
    const timer = setTimeout(() => finish(new Error("Slow event reader")), 5_000);
    response.once("drain", drained);
    response.once("close", closed);
  });
}
export async function streamEvents(response: ServerResponse, store: ServiceStore, sessionId: string, after: number, loginSignal?: AbortSignal, authorize?: () => Promise<unknown>) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  response.flushHeaders();
  const abort = new AbortController();
  const closed = () => abort.abort();
  response.once("close", closed);
  loginSignal?.addEventListener("abort", closed, { once: true });
  if (loginSignal?.aborted) closed();
  let cursor = after, lastWrite = Date.now(), lastAuthorized = 0;
  try {
    while (!abort.signal.aborted) {
      const events = await store.events(sessionId, cursor);
      if (authorize && (events.length || Date.now() - lastAuthorized >= 2_000)) {
        await authorize();
        lastAuthorized = Date.now();
      }
      if (abort.signal.aborted) break;
      for (const event of events) {
        await write(response, `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify({ messageId: event.messageId, ...event.payload })}\n\n`);
        cursor = event.eventId;
        lastWrite = Date.now();
      }
      if (Date.now() - lastWrite >= 15_000) { await write(response, ": keepalive\n\n"); lastWrite = Date.now(); }
      if (events.length < 100) await sleep(200, undefined, { signal: abort.signal });
    }
  } catch (error) {
    if (!abort.signal.aborted) console.error("Event stream ended", error);
  } finally {
    response.off("close", closed);
    loginSignal?.removeEventListener("abort", closed);
    response.destroy();
  }
}
