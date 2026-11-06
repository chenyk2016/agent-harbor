/**
 * 文件路由在统一登录与会话归属检查之后挂载。
 * Express只匹配路径；上传继续消费原始流，下载继续使用pipeline和背压。
 */
import { Router, type RequestHandler } from "express";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { SessionManager } from "../session-manager.js";
import { fail } from "../types.js";
import { WorkspaceFiles, checkFilename } from "./workspace-files.js";
import { uploadLimit } from "./types.js";
import { parameter, principal, searchParams } from "../http/shared.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function createFileRouter(
  manager: SessionManager,
  files: WorkspaceFiles,
) {
  // sessionId来自上级挂载路径；mergeParams保证子Router仍能读取它。
  const router = Router({ caseSensitive: true, mergeParams: true });
  router.use(async (request, response, next) => {
    const id = parameter(request, "sessionId");
    const login = principal(response);
    await manager.fileAccess(login.userId, id);
    const disconnected = new AbortController();
    const closed = () => {
      if (!response.writableFinished) disconnected.abort();
    };
    const signal = AbortSignal.any([
      disconnected.signal,
      files.signal,
      login.signal,
      AbortSignal.timeout(60_000),
    ]);
    const aborted = () => {
      request.destroy();
      response.destroy();
    };
    // signal既传给文件层，也主动打断停滞上传，避免退出登录后继续占用写入名额。
    response.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    const release = () => {
      response.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    response.once("finish", release);
    response.once("close", release);
    response.locals.fileSignal = signal;
    next();
  });
  router.get("/", async (request, response) => {
    response.json(
      await files.list(
        parameter(request, "sessionId"),
        searchParams(request).get("path") ?? "",
        response.locals.fileSignal,
      ),
    );
  });
  router.get("/preview", async (request, response) => {
    response.json(
      await files.preview(
        parameter(request, "sessionId"),
        searchParams(request).get("path") ?? "",
        response.locals.fileSignal,
      ),
    );
  });
  router.get("/download", async (request, response) => {
    const path = searchParams(request).get("path") ?? "";
    await files.download(
      parameter(request, "sessionId"),
      path,
      response.locals.fileSignal,
      async (file, size, transferSignal) => {
        const name = path.split("/").at(-1)!;
        const encoded = encodeURIComponent(name).replace(
          /['()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16)}`,
        );
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": size,
          "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
        await pipeline(createReadStream(file), response, {
          signal: transferSignal,
        });
      },
    );
  });

  // 两个方法使用同一组参数校验；校验失败不能进入文件写入服务。
  const uploadParameters: RequestHandler = (request, response, next) => {
    if (!uuid.test(parameter(request, "uploadId"))) fail(404, "NOT_FOUND");
    const name = searchParams(request).get("name") ?? "";
    checkFilename(name);
    response.locals.uploadName = name;
    next();
  };
  router.get(
    "/uploads/:uploadId",
    uploadParameters,
    async (request, response) => {
      response.json(
        await files.uploaded(
          parameter(request, "sessionId"),
          parameter(request, "uploadId"),
          response.locals.uploadName,
          response.locals.fileSignal,
        ),
      );
    },
  );
  router.put(
    "/uploads/:uploadId",
    uploadParameters,
    async (request, response) => {
      const id = parameter(request, "sessionId"),
        uploadId = parameter(request, "uploadId");
      const userId = principal(response).userId;
      const name = response.locals.uploadName as string;
      const signal = response.locals.fileSignal as AbortSignal;
      if (request.headers["content-type"] !== "application/octet-stream")
        fail(415, "UPLOAD_TYPE_REQUIRED");
      if (Number(request.headers["content-length"] ?? 0) > uploadLimit)
        fail(413, "FILE_TOO_LARGE");
      const result = await manager.withFileWrite(userId, id, async () => {
        // 同ID重试先查已发布文件，不能因为空间已满而失去幂等性。
        const old = await files
          .uploaded(id, uploadId, name, signal)
          .catch((error) => {
            if (error.code === "FILE_NOT_FOUND") return undefined;
            throw error;
          });
        if (old && old.sha256 !== request.headers["x-content-sha256"])
          fail(409, "UPLOAD_CONFLICT");
        const owned = await manager.store.sessions(
          userId,
          Number.MAX_SAFE_INTEGER,
        );
        const used = await files.bytes(
          owned.map((session) => session.id),
          signal,
        );
        const allowance =
          (await manager.identity.policy(userId)).workspaceBytes - used;
        if (!old && allowance <= 0) fail(413, "WORKSPACE_LIMIT");
        return files.upload(
          id,
          uploadId,
          name,
          String(request.headers["x-content-sha256"] ?? ""),
          request.iterator({ destroyOnReturn: false }),
          signal,
          old ? old.size : allowance,
        );
      });
      response.status(result.duplicate ? 200 : 201).json(result);
    },
  );
  return router;
}
