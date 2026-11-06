/**
 * 各模块共用的HTTP小工具。
 * Express负责方法/路径匹配和JSON解析；这里统一平台的输入约束与错误格式。
 * 文件上传、ZIP与MCP transport不挂全局JSON解析器，保留原始请求流。
 */
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { IncomingMessage } from "node:http";
import { fail, ServiceError } from "../types.js";

export interface RequestPrincipal {
  userId: string;
  signal: AbortSignal;
}

/** 只有认证中间件写入locals；请求正文和查询参数不能伪造当前用户。 */
export function principal(response: Response): RequestPrincipal {
  const value = response.locals.principal as RequestPrincipal | undefined;
  if (!value) fail(401, "UNAUTHORIZED");
  return value;
}

/** Express 5的参数类型也覆盖通配数组；本项目的命名参数必须是单个字符串。 */
export function parameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") fail(400, "INVALID_PATH_PARAMETER");
  return value;
}

/** 使用originalUrl，避免Router挂载前缀后丢失查询串；重复version参数仍可getAll。 */
export function searchParams(request: Request): URLSearchParams {
  return new URL(request.originalUrl, "http://localhost").searchParams;
}

/**
 * 只挂到声明为JSON的路由上。旧客户端未填Content-Type也会按原契约解析JSON。
 * 不自动解压请求体，避免迁移后意外扩大可接受的编码和解压资源消耗。
 */
export function jsonBody(limit = 256 * 1024): RequestHandler[] {
  return [
    express.json({
      limit,
      strict: true,
      type: () => true,
      inflate: false,
      // Express默认把空正文当成{}；平台原契约要求有效JSON对象，因此显式拒绝空字节。
      verify: (_request, _response, bytes) => {
        if (!bytes.length) fail(400, "INVALID_JSON");
      },
    }),
    (request, _response, next) => {
      jsonInput(request);
      next();
    },
  ];
}

export function jsonInput(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_JSON");
  return value as Record<string, unknown>;
}

/** ZIP按原始字节限长；溢出后排空输入，保留返回413的机会。大文件上传另走流式文件层。 */
export async function binaryBody(
  request: IncomingMessage,
  limit: number,
  code = "PACKAGE_LIMIT",
): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      fail(413, code);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const notFound: RequestHandler = () => {
  fail(404, "NOT_FOUND");
};

/**
 * 最后一层错误边界。Express 5会把async handler的拒绝自动送到这里。
 * 解析错误对象可能包含原始正文/密钥，不能原样写日志或返回浏览器。
 */
export function apiErrors(
  storageUnavailable: () => boolean,
): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    request.resume();
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const chatSend =
      request.method === "POST" &&
      /^\/api\/sessions\/[^/?]+\/messages(?:\?|$)/.test(request.originalUrl);
    const reply = (status: number, code: string) => {
      if (chatSend) {
        const diagnosticCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "REQUEST_FAILED";
        // Record the rejection cause without a URL, session ID, prompt, or credentials.
        console.warn(JSON.stringify({ at: new Date().toISOString(), operation: "chat.send", status, code: diagnosticCode }));
      }
      response.status(status).json({ error: code });
    };
    if (error instanceof ServiceError) {
      reply(error.status, error.code);
      return;
    }
    const type = (error as { type?: string })?.type;
    if (type === "entity.too.large") {
      reply(413, "BODY_TOO_LARGE");
      return;
    }
    if (type === "encoding.unsupported" || type === "charset.unsupported") {
      reply(415, "UNSUPPORTED_CONTENT_ENCODING");
      return;
    }
    if (
      type === "entity.parse.failed" ||
      type === "request.size.invalid" ||
      type === "request.aborted"
    ) {
      reply(400, "INVALID_JSON");
      return;
    }
    if (error instanceof URIError) {
      reply(400, "INVALID_PATH_PARAMETER");
      return;
    }
    if (!chatSend) console.error("HTTP request failed", error);
    reply(503, storageUnavailable() ? "STORAGE_UNAVAILABLE" : "SERVICE_UNAVAILABLE");
  };
}
