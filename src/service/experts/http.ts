/** 专家Router只处理HTTP输入，包/版本/安装与凭据仍由ExpertService持有。
 * JSON编辑按2MiB限长，ZIP导入保留原始字节，OAuth回调保留原Origin和state核对。 */
import { Router, type RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import {
  importExpertPackage,
  originalExpertArchive,
  expertPackageFiles,
  editExpertPackage,
  createExpertPackage,
} from "./packages.js";
import { normalizePath } from "../skills/manifest.js";
import { ExpertService } from "./service.js";
import { requireId } from "../skills/service.js";
import { fail } from "../types.js";
import {
  jsonBody,
  jsonInput,
  parameter,
  principal,
  searchParams,
  binaryBody,
} from "../http/shared.js";
export function createExpertRouter(
  service: ExpertService,
  originFor: (request: IncomingMessage) => string,
  disconnected: (user: string) => Promise<void>,
) {
  const router = Router({ caseSensitive: true });
  router.get("/expert-versions/:id/avatar", async (request, response) => {
    const user = principal(response).userId;

    const { version } = await service.version(user, parameter(request, "id")),
      bundle = version.definition.workbuddy;
    if (!bundle || typeof bundle.manifest.avatar !== "string")
      fail(404, "AVATAR_NOT_FOUND");
    const path = normalizePath(bundle.manifest.avatar);
    if (!path) fail(400, "INVALID_PACKAGE_PATH");
    let bytes: Buffer;
    try {
      bytes = await readFile(
        service.library.packages.path(`${bundle.sourcePath}/source/${path}`),
      );
    } catch {
      fail(404, "AVATAR_NOT_FOUND");
    }
    const type = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216
        ? "image/jpeg"
        : undefined;
    if (!type) fail(415, "AVATAR_FORMAT_UNSUPPORTED");
    response.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    });
    response.end(bytes);
    return;
  });
  // GET和POST使用同一业务操作；只有POST挂JSON解析器。
  const network: RequestHandler = async (request, response) => {
    const user = principal(response).userId;

    const { version } = await service.version(user, parameter(request, "id")),
      bundle = version.definition.workbuddy;
    if (!bundle) fail(404, "EXPERT_PACKAGE_NOT_FOUND");
    let domains: string[] | undefined;
    if (request.method === "POST") {
      const input = jsonInput(request);
      if (
        !Array.isArray(input.domains) ||
        input.domains.some((value) => typeof value !== "string")
      )
        fail(400, "INVALID_NETWORK_DOMAINS");
      domains = input.domains as string[];
    }
    response.status(200).json({
      domains: await service.connections.network(user, bundle, domains),
    });
    return;
  };
  router.get("/expert-versions/:id/network", network);
  router.post(
    "/expert-versions/:id/network",
    ...jsonBody(2 * 1024 * 1024),
    network,
  );
  router.get("/expert-oauth/callback", async (request, response) => {
    const user = principal(response).userId;
    const origin = originFor(request);
    const query = searchParams(request);

    if (query.has("error")) fail(409, "MCP_OAUTH_DENIED");
    const bundles = (
      await Promise.all(
        (await service.list(user)).map((item) => service.detail(user, item.id)),
      )
    ).flatMap((item) =>
      item.versions.flatMap((version) =>
        version.definition.workbuddy ? [version.definition.workbuddy] : [],
      ),
    );
    await service.connections.finish(
      user,
      bundles,
      query.get("state") ?? "",
      query.get("code") ?? "",
      origin,
    );
    response.writeHead(303, { Location: "/experts" });
    response.end();
    return;
  });
  // 状态查询不返回token；连接与断开都先取得本人可访问的专家版本。
  router.get("/expert-versions/:id/connections", async (request, response) => {
    const user = principal(response).userId;

    const { version } = await service.version(user, parameter(request, "id")),
      bundle = version.definition.workbuddy;
    if (!bundle) fail(404, "EXPERT_PACKAGE_NOT_FOUND");
    response.status(200).json({
      items: await service.connections.status(user, bundle),
      unavailableConnectors: await service.connections.missing(bundle),
    });
  });
  router.post(
    "/expert-versions/:id/connections/:name",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;
      const origin = originFor(request);

      const { version } = await service.version(user, parameter(request, "id")),
        bundle = version.definition.workbuddy;
      if (!bundle) fail(404, "EXPERT_PACKAGE_NOT_FOUND");

      const input = jsonInput(request),
        values = input.values ?? {};
      if (
        !values ||
        typeof values !== "object" ||
        Array.isArray(values) ||
        Object.values(values).some((value) => typeof value !== "string")
      )
        fail(400, "INVALID_MCP_VALUES");
      response
        .status(200)
        .json(
          await service.connections.connect(
            user,
            bundle,
            parameter(request, "name"),
            values as Record<string, string>,
            origin,
          ),
        );
    },
  );
  router.delete(
    "/expert-versions/:id/connections/:name",
    async (request, response) => {
      const user = principal(response).userId;

      const { version } = await service.version(user, parameter(request, "id")),
        bundle = version.definition.workbuddy;
      if (!bundle) fail(404, "EXPERT_PACKAGE_NOT_FOUND");

      await service.connections.disconnect(
        user,
        bundle,
        parameter(request, "name"),
      );
      await disconnected(user);
      response.status(200).json({ disconnected: true });
    },
  );
  // 包创建、原始ZIP导入和版本编辑各自显式声明路径与正文类型。
  router.post(
    "/expert-packages",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;

      const input = jsonInput(request);
      if (
        typeof input.name !== "string" ||
        typeof input.description !== "string" ||
        typeof input.instructions !== "string"
      )
        fail(400, "INVALID_EXPERT");
      response.status(201).json(
        await createExpertPackage(
          service,
          user,
          requireId(input.clientRequestId),
          input as {
            name: string;
            description: string;
            instructions: string;
          },
        ),
      );
      return;
    },
  );
  // 二进制导入不经过JSON中间件，避免把ZIP当正文解析。
  router.post("/expert-packages/import", async (request, response) => {
    const user = principal(response).userId;
    const query = searchParams(request);
    const bytes = await binaryBody(request, 20 * 1024 * 1024);
    response
      .status(201)
      .json(
        await importExpertPackage(
          service,
          user,
          requireId(query.get("clientRequestId")),
          bytes,
        ),
      );
    return;
  });
  router.post(
    "/experts/:id/package-versions",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;

      const input = jsonInput(request);
      if (!Array.isArray(input.changes) || input.changes.length > 100)
        fail(400, "INVALID_EXPERT_EDIT");
      const changes = input.changes.map((value) => {
        if (!value || typeof value !== "object")
          fail(400, "INVALID_EXPERT_EDIT");
        const item = value as { path: unknown; text: unknown };
        if (
          typeof item.path !== "string" ||
          normalizePath(item.path) !== item.path ||
          (typeof item.text !== "string" && item.text !== null)
        )
          fail(400, "INVALID_EXPERT_EDIT");
        return { path: item.path, text: item.text as string | null };
      });
      response
        .status(201)
        .json(
          await editExpertPackage(
            service,
            user,
            parameter(request, "id"),
            requireId(input.expectedVersionId),
            requireId(input.clientRequestId),
            changes,
          ),
        );
      return;
    },
  );
  router.get("/expert-versions/:id/export", async (request, response) => {
    const user = principal(response).userId;

    const archive = await originalExpertArchive(
      service,
      user,
      parameter(request, "id"),
    );
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="expert.zip"',
      "Cache-Control": "no-store",
    });
    response.end(archive);
  });
  router.get("/expert-versions/:id/files", async (request, response) => {
    const user = principal(response).userId;

    const files = await expertPackageFiles(
      service,
      user,
      parameter(request, "id"),
    );
    response.status(200).json(
      files.map((file) => ({
        path: file.path,
        size: file.content.length,
        text:
          file.content.length <= 1024 * 1024 && isUtf8(file.content)
            ? file.content.toString("utf8")
            : undefined,
      })),
    );
  });
  router.get("/expert-skill-choices", async (_request, response) => {
    const user = principal(response).userId;

    response.status(200).json(await service.skillChoices(user));
    return;
  });
  // 普通专家定义与WorkBuddy包共用原有service，不在HTTP层复制版本规则。
  router.get("/experts", async (_request, response) => {
    const user = principal(response).userId;

    response.status(200).json(await service.list(user));
    return;
  });
  router.post(
    "/experts",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(201)
        .json(
          await service.save(
            user,
            requireId(input.clientRequestId),
            input.definition,
          ),
        );
      return;
    },
  );
  router.get("/experts/:id", async (request, response) => {
    const user = principal(response).userId;
    const id = parameter(request, "id");

    response.status(200).json(await service.detail(user, id));
    return;
  });
  router.delete("/experts/:id", async (request, response) => {
    const user = principal(response).userId;
    const id = parameter(request, "id");

    await service.remove(user, id);
    response.status(200).json({ deleted: true });
    return;
  });
  router.post(
    "/experts/:id/versions",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;
      const id = parameter(request, "id");

      const input = jsonInput(request);
      response
        .status(201)
        .json(
          await service.save(
            user,
            requireId(input.clientRequestId),
            input.definition,
            id,
            requireId(input.expectedVersionId),
          ),
        );
      return;
    },
  );
  router.post("/expert-versions/:id/install", async (request, response) => {
    const user = principal(response).userId;
    const id = parameter(request, "id");

    response.status(202).json(await service.install(user, requireId(id)));
    return;
  });
  router.get("/expert-versions/:id/installation", async (request, response) => {
    const user = principal(response).userId;
    const id = parameter(request, "id");

    response.status(200).json(await service.latestInstall(user, requireId(id)));
    return;
  });
  router.post(
    "/expert-versions/:id/copy",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;
      const id = parameter(request, "id");

      const input = jsonInput(request);
      response
        .status(201)
        .json(await service.copy(user, id, requireId(input.clientRequestId)));
      return;
    },
  );
  // 安装任务状态/取消/重试继续交给service，客户端断开不会自动终止安装。
  router.get("/expert-installs/:id", async (request, response) => {
    const user = principal(response).userId;

    response
      .status(200)
      .json(await service.installation(user, parameter(request, "id")));
    return;
  });
  router.post("/expert-installs/:id/cancel", async (request, response) => {
    const user = principal(response).userId;

    response
      .status(200)
      .json(await service.cancel(user, parameter(request, "id")));
    return;
  });
  router.post(
    "/expert-installs/:id/retry",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId;

      const input = jsonInput(request);
      if (
        !Number.isSafeInteger(input.expectedAttempt) ||
        Number(input.expectedAttempt) < 1
      )
        fail(400, "INVALID_REVISION");
      response
        .status(202)
        .json(
          await service.retry(
            user,
            parameter(request, "id"),
            requireId(input.requestId),
            Number(input.expectedAttempt),
          ),
        );
      return;
    },
  );
  return router;
}
