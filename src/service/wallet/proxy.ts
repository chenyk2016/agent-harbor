/** 原生Messages透明转发：不改变Agent循环，逐次调用预占并从完整usage结算。 */
import express, { Router } from "express";
import type { LlmService } from "../llm/service.js";
import { ServiceError } from "../types.js";
import { WalletService, cost, type TokenUsage } from "./service.js";
import type { ModelPrice } from "../db/schema/wallet.js";
import { sql } from "drizzle-orm";
import type { TracingService } from "../tracing/service.js";

/** Conservative local estimate; final billing still uses reported usage and the saved RMB price. */
export function estimateRequest(body: Record<string, unknown>, price: ModelPrice) {
  const output = body.max_tokens;
  if (!Number.isSafeInteger(output) || Number(output) <= 0 || Number(output) > 1_000_000)
    throw new ServiceError(400, "INVALID_MAX_TOKENS");
  // UTF-8 body bytes overestimate ordinary text tokens; this is not a tokenizer guarantee.
  const input = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
  return cost(price, { input, output: Number(output), cacheRead: 0, cacheWrite: 0 });
}

export function usageFrom(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const u = value as Record<string, unknown>;
  const input = u.input_tokens, output = u.output_tokens;
  const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
  if (![input, output, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return;
  return { input: Number(input), output: Number(output), cacheRead: Number(cacheRead), cacheWrite: Number(cacheWrite) };
}
/** SSE frame parser keeps only usage, never stores prompt or generated text. */
export class MessageMeter {
  private buffer = "";
  private usage: Record<string, unknown> = {};
  complete = false;
  private finalUsage = false;
  invalid = false;
  feed(chunk: string) {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    if (this.buffer.length > 8 * 1024 * 1024) { this.invalid = true; this.buffer = ""; return; }
    let index: number;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 2);
      const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        if (event.type === "message_start") this.usage = { ...event.message?.usage };
        if (event.type === "message_delta") { this.usage = { ...this.usage, ...event.usage }; this.finalUsage = Number.isSafeInteger(event.usage?.output_tokens); }
        if (event.type === "message_stop") this.complete = true;
        if (event.type === "error") this.invalid = true;
      } catch { this.invalid = true; }
    }
  }
  result() { return this.complete && this.finalUsage && !this.invalid ? usageFrom(this.usage) : undefined; }
}
export function createInferenceRouter(llm: LlmService, wallet: WalletService, tracing?: TracingService) {
  const router = Router();
  router.use(express.json({ limit: "20mb", strict: true, inflate: false }));
  router.post(["/v1/messages", "/v1/messages/count_tokens"], async (req, res) => {
    let requestId: string | undefined;
    const started = performance.now();
    let httpStatus: number | null = null, failureCode: string | null = null;
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", onClose);
    try {
      const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      const token = bearer ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "");
      const { binding, deployment, version, price, upstreamToken, logicalModel } = await llm.walletConnection(token);
      if (!req.body || Array.isArray(req.body) || typeof req.body !== "object" || req.body.model !== logicalModel) throw new ServiceError(400, "INVALID_INFERENCE_MODEL");
      // 固定实际 deployment route，避免本次计价和其他轮次修改的 alias 路由不同。
      const body = { ...req.body, model: version.routeName };
      // Client-controlled logging/destination settings must not override trusted telemetry.
      for (const key of ["litellm_metadata", "callbacks", "success_callback", "failure_callback", "no-log", "no_log", "trace_id", "existing_trace_id"]) delete body[key];
      const analysis = (await wallet.db.execute(sql`SELECT "analysisAppId" FROM sessions WHERE id=${binding.sessionId}`)).rows[0]?.analysisAppId;
      if (analysis) body["no-log"] = true;
      if (body.metadata && typeof body.metadata === "object") {
        const user = body.metadata.user_id;
        body.metadata = typeof user === "string" ? { user_id: user } : {};
      }
      if (req.path === "/v1/messages") {
        const estimate = llm.settings.policy ? estimateRequest(req.body, price) : undefined;
        const r = await wallet.reserve(binding.ownerId, binding.sessionId, {
          deploymentId: deployment.id,
          versionId: version.id,
          priceVersionId: price.id,
          name: deployment.name,
          price,
        }, estimate);
        requestId = r.id;
        // SDK assistant.request_id可回链本地请求；不依赖当前活跃轮次猜测归属。
        res.setHeader("request-id", requestId);
      }
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${upstreamToken}` };
      if (requestId && !analysis) Object.assign(headers, await tracing?.prepare(requestId, binding.sessionId, binding.ownerId));
      for (const key of ["anthropic-version", "anthropic-beta"]) if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
      const response = await fetch(llm.settings.managementUrl + req.path, {
        method: "POST", headers, body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(
          llm.settings.policy ? 630_000 : 180_000,
        )]),
      });
      httpStatus = response.status;
      if (!response.ok) failureCode = `UPSTREAM_HTTP_${response.status}`;
      const callId = response.headers.get("x-litellm-call-id");
      if (callId) {
        if (requestId) await wallet.attachGatewayCall(requestId, callId);
        res.setHeader("x-litellm-call-id", callId);
      }
      if (!response.ok) {
        // A verified gateway budget rejection happens before dispatch and must not pin RMB funds.
        const rejected = [422, 429].includes(response.status) ? await response.clone().json().catch(() => null) : null;
        const budgetRejected = response.status === 422 && typeof rejected?.error?.message === "string" && /^Budget has been exceeded!/.test(rejected.error.message);
        const rateRejected = response.status === 429 && (rejected?.error?.type === "rate_limit_error" || /rate.?limit|requests per minute/i.test(rejected?.error?.message ?? ""));
        if (requestId && (budgetRejected || rateRejected)) {
          await wallet.waiveInterrupted(requestId, budgetRejected ? "网关预算拒绝，未转发模型，本次不扣费" : "模型请求限流拒绝，本次免收");
          res.status(budgetRejected ? 402 : 429).json({ type: "error", error: { type: "invalid_request_error", message: budgetRejected
            ? "本次请求的预计费用超过可用额度，请减少输出或增加额度。" : "模型请求过于频繁，请稍后重试。" } });
          return;
        }
        // 不能把上游失败视为无消费；保留预占，用户明细提供待核对入口。
        if (requestId) await wallet.unknown(requestId);
        res.status(response.status).json({ type: "error", error: { type: "upstream_error", message: requestId ? `模型请求失败，额度待核对（${requestId}）` : "Token计数暂不可用" } });
        return;
      }
      const streaming = response.headers.get("content-type")?.includes("text/event-stream");
      if (streaming && response.body) {
        res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const meter = new MessageMeter(), decoder = new TextDecoder();
        for await (const chunk of response.body) {
          meter.feed(decoder.decode(chunk, { stream: true }));
          if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
            const closed = () => { cleanup(); reject(new Error("Client disconnected")); };
            const drained = () => { cleanup(); resolve(); };
            const cleanup = () => { res.off("close", closed); res.off("drain", drained); };
            res.once("drain", drained); res.once("close", closed);
          });
        }
        meter.feed(decoder.decode());
        const usage = meter.result();
        if (requestId) { if (usage) await wallet.settle(requestId, usage); else await wallet.unknown(requestId); }
        res.end();
      } else {
        const value = await response.json();
        const usage = usageFrom(value.usage);
        if (requestId) { if (usage) await wallet.settle(requestId, usage); else await wallet.unknown(requestId); }
        res.status(200).json(value);
      }
    } catch (error) {
      failureCode = error instanceof ServiceError ? error.code : abort.signal.aborted ? "CLIENT_DISCONNECTED" : "INFERENCE_UNCONFIRMED";
      if (requestId) {
        if (abort.signal.aborted) await wallet.waiveInterrupted(requestId).catch(() => {});
        else await wallet.unknown(requestId).catch(() => {});
      }
      if (!res.headersSent && !res.destroyed) {
        const code = error instanceof ServiceError ? error.code : "INFERENCE_UNCONFIRMED";
        // Native clients retry HTTP 409. Missing prices cannot recover by retrying.
        const status = code === "PRICE_REQUIRED" ? 400 : error instanceof ServiceError ? error.status : 503;
        const messages: Record<string, string> = {
          INSUFFICIENT_BALANCE: "可用余额不足，请联系管理员赠送额度或开通Plus。",
          WALLET_BUSY: "上一笔模型请求正在结算或待核对，请稍后再试。",
          PRICE_REQUIRED: "管理员尚未设置该模型的平台价格。",
          MODEL_UNAVAILABLE: "该模型当前不可用，请选择其他模型。",
          DEPLOYMENT_ARCHIVED: "该模型已归档，请选择其他模型。",
        };
        res.status(status).json({ type: "error", error: { type: "invalid_request_error", message: messages[code] ?? code } });
      } else res.destroy();
    } finally {
      res.off("close", onClose);
      if (requestId) await wallet.db.execute(sql`UPDATE wallet_requests SET "durationMs"=${Math.round(performance.now()-started)},"httpStatus"=${httpStatus},"failureCode"=${failureCode} WHERE id=${requestId}`).catch(() => console.error("Inference diagnostics unconfirmed"));
    }
  });
  return router;
}
