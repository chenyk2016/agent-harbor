/** CLI与未来网页共用的传输层；重连只补看事件，不重发用户任务。 */
import type { Message, ServiceSession } from "../service/types.js";
export interface ClientEvent { id: number; type: string; data: Record<string, unknown> & { messageId: string | null } }
export type SessionDetail = ServiceSession & { message: Message | null };
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`${status} ${code}`); }
}
export class ServiceClient {
  constructor(readonly url: string, private token?: string) {}
  protected headers(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "X-Harbor-Client": "web" };
  }
  async request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url}/api${path}`, {
      method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    const value = await response.json() as { error?: string };
    if (!response.ok) throw new ApiError(response.status, value.error ?? "REQUEST_FAILED");
    return value as T;
  }
  async uploadExpert<T>(file: Blob, requestId: string): Promise<T> {
    const response = await fetch(`${this.url}/api/expert-packages/import?clientRequestId=${requestId}`, {
      method:"POST",headers:{...this.headers(),"Content-Type":"application/zip"},body:file,signal:AbortSignal.timeout(60000),
    });
    const value=await response.json() as {error?:string};
    if(!response.ok) throw new ApiError(response.status,value.error??"IMPORT_FAILED");
    return value as T;
  }
  session(id: string) { return this.request<SessionDetail>(`/sessions/${id}`); }
  async send(id: string, clientMessageId: string, text: string, deploymentId?: string) {
    // 只重试传输失败，并保留原来的ID；服务错误、冲突不自动重试。
    try { return await this.request<{ message: Message }>(`/sessions/${id}/messages`, "POST", { clientMessageId, text, deploymentId }); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      return this.request<{ message: Message }>(`/sessions/${id}/messages`, "POST", { clientMessageId, text, deploymentId });
    }
  }
  cancel(id: string, messageId: string) { return this.request(`/sessions/${id}/messages/${messageId}/cancel`, "POST"); }
  close(id: string, expectedMessageId: string | null) { return this.request(`/sessions/${id}/close`, "POST", { expectedMessageId }); }

  /** UTF-8片段不等于一条事件；先组完整SSE帧，再解析JSON正文及其换行。 */
  async *events(id: string, after: number, signal: AbortSignal, onConnection: (state: "connecting" | "connected" | "disconnected") => void | Promise<void> = () => {}): AsyncGenerator<ClientEvent> {
    yield* this.eventsAt(`/sessions/${id}/events`, after, signal, onConnection);
  }

  async *eventsAt(path: string, after: number, signal: AbortSignal, onConnection: (state: "connecting" | "connected" | "disconnected") => void | Promise<void> = () => {}): AsyncGenerator<ClientEvent> {
    let cursor = after;
    while (!signal.aborted) {
      try {
        onConnection("connecting");
        const response = await fetch(`${this.url}/api${path}?after=${cursor}`, { headers: this.headers(), signal });
        if (!response.ok) {
          const body = await response.json() as { error: string };
          throw new ApiError(response.status, body.error);
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          await onConnection("connected");
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const lines = frame.split("\n");
              const eventId = Number(lines.find(line => line.startsWith("id: "))?.slice(4));
              const data = lines.find(line => line.startsWith("data: "))?.slice(6);
              if (!data || !Number.isSafeInteger(eventId) || eventId <= cursor) continue;
              yield { id: eventId, type: lines.find(line => line.startsWith("event: "))!.slice(7), data: JSON.parse(data) };
              cursor = eventId;
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError) throw error;
      }
      if (!signal.aborted) onConnection("disconnected");
      if (!signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 1_000);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
