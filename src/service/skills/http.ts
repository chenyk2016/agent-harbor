/** Skill路由只声明HTTP方法与路径；归属和准备作业仍由业务服务持有。
 * JSON编辑使用2MiB限额；ZIP上传不挂JSON解析器，按原始字节单独限长。 */
import { Router } from "express";
import { isUtf8 } from "node:buffer";
import { eq, and, sql } from "drizzle-orm";
import { sessions } from "../db/schema/index.js";
import { fail } from "../types.js";
import {
  jsonBody,
  jsonInput,
  parameter,
  principal,
  searchParams,
  binaryBody,
} from "../http/shared.js";
import { SkillService, requireId } from "./service.js";
import { SkillBuildManager } from "./build-manager.js";
export interface SkillModule {
  library: SkillService;
  builds: SkillBuildManager;
}
const revision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail(400, "INVALID_REVISION");
  return Number(value);
};
export function createSkillRouter(module: SkillModule) {
  const { library, builds } = module;
  const router = Router({ caseSensitive: true });
  // 个人选择与定义/版本分开；修改默认选择不会给旧会话扩权。
  router.get("/skill-selection", async (request, response) => {
    const userId = principal(response).userId;
    const query = searchParams(request);

    response
      .status(200)
      .json(
        await builds.selection(
          userId,
          query.has("version") ? query.getAll("version") : undefined,
        ),
      );
    return;
  });
  // 技能定义与保存版本：请求校验之后交给library，不在Router里写文件或安装依赖。
  router.get("/skills", async (_request, response) => {
    const userId = principal(response).userId;

    response.status(200).json(await library.list(userId));
    return;
  });
  router.post(
    "/skills",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      if (
        typeof input.skillMd !== "string" ||
        Buffer.byteLength(input.skillMd) > 1024 * 1024 ||
        typeof input.displayName !== "string"
      )
        fail(400, "INVALID_SKILL");
      response
        .status(201)
        .json(
          await library.create(
            userId,
            requireId(input.clientRequestId),
            input.displayName,
            [{ path: "SKILL.md", content: Buffer.from(input.skillMd) }],
          ),
        );
      return;
    },
  );
  router.get("/skills/:id", async (request, response) => {
    const userId = principal(response).userId;
    const id = parameter(request, "id");

    response.status(200).json(await library.detail(userId, id));
    return;
  });
  router.delete("/skills/:id", async (request, response) => {
    const userId = principal(response).userId;
    const id = parameter(request, "id");

    await library.remove(userId, id);
    response.status(200).json({ deleted: true });
    return;
  });
  router.post(
    "/skills/:id/versions",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;
      const id = parameter(request, "id");

      const input = jsonInput(request);
      if (
        !Array.isArray(input.changes) ||
        input.changes.length > 100 ||
        input.changes.some((change) => !change || typeof change !== "object") ||
        (input.displayName !== undefined &&
          typeof input.displayName !== "string")
      )
        fail(400, "INVALID_SKILL_EDIT");
      response
        .status(200)
        .json(
          await library.save(
            userId,
            id,
            requireId(input.expectedVersionId),
            requireId(input.clientRequestId),
            input.changes,
            input.displayName as string | undefined,
          ),
        );
      return;
    },
  );
  router.get("/skills/:id/references", async (request, response) => {
    const userId = principal(response).userId;
    const id = parameter(request, "id");

    await library.owned(userId, id);
    const referenced = await library.db
      .select({ id: sessions.id, title: sessions.title })
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, userId),
          sql`${sessions.capabilitySnapshot} @> ${JSON.stringify({ skills: [{ skillId: id }] })}::jsonb`,
        ),
      );
    response.status(200).json(referenced);
    return;
  });
  // 已发布版本的复制、导出和文本浏览。
  router.post(
    "/skill-versions/:id/copy",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(201)
        .json(
          await library.copyVersion(
            userId,
            parameter(request, "id"),
            requireId(input.clientRequestId),
            String(input.displayName ?? ""),
          ),
        );
      return;
    },
  );
  router.get("/skill-versions/:id/export", async (request, response) => {
    const userId = principal(response).userId;
    const { version } = await library.version(userId, parameter(request, "id"));

    const zip = await library.packages.export(version.sourcePath);
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="skill.zip"',
      "Cache-Control": "no-store",
    });
    response.end(zip);
    return;
  });
  router.get("/skill-versions/:id/files", async (request, response) => {
    const userId = principal(response).userId;
    const { version } = await library.version(userId, parameter(request, "id"));

    const files = await library.packages.files(version.sourcePath);
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
    return;
  });
  // 导入分两步：先登记元数据，再上传ZIP原始字节，最后显式应用。
  router.post(
    "/skill-imports",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(201)
        .json(
          await library.newImport(
            userId,
            requireId(input.clientRequestId),
            String(input.fileName ?? ""),
            Number(input.size),
            String(input.sha256 ?? ""),
          ),
        );
      return;
    },
  );
  router.get("/skill-imports/:id", async (request, response) => {
    const userId = principal(response).userId;

    const row = await library.importRecord(userId, parameter(request, "id"));
    response.status(200).json({ ...row, stagingPath: undefined });
    return;
  });
  // ZIP上传直接读取request流；不能在此路由之前挂express.json。
  router.put("/skill-imports/:id/content", async (request, response) => {
    const userId = principal(response).userId;

    await library.importRecord(userId, parameter(request, "id"));
    const bytes = await binaryBody(request, 20 * 1024 * 1024);
    const row = await library.upload(userId, parameter(request, "id"), bytes);
    response.status(200).json({ ...row, stagingPath: undefined });
    return;
  });
  router.post(
    "/skill-imports/:id/apply",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(200)
        .json(
          await library.applyImport(
            userId,
            parameter(request, "id"),
            input.targetSkillId === undefined
              ? undefined
              : requireId(input.targetSkillId),
            input.expectedVersionId === undefined
              ? undefined
              : requireId(input.expectedVersionId),
          ),
        );
      return;
    },
  );
  // 准备作业由builds持有生命周期，HTTP断开不代替作业取消。
  router.post(
    "/skill-build-requests",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await builds.request(
            userId,
            requireId(input.skillVersionId),
            requireId(input.clientRequestId),
          ),
        );
      return;
    },
  );
  router.get("/skill-build-requests/:id", async (request, response) => {
    const userId = principal(response).userId;

    response
      .status(200)
      .json(await builds.detail(userId, parameter(request, "id")));
    return;
  });
  router.post("/skill-build-requests/:id/cancel", async (request, response) => {
    const userId = principal(response).userId;

    response
      .status(200)
      .json(await builds.cancel(userId, parameter(request, "id")));
    return;
  });
  router.post(
    "/skill-build-requests/:id/retry",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await builds.retry(
            userId,
            parameter(request, "id"),
            revision(input.expectedAttempt),
          ),
        );
      return;
    },
  );
  // 修改默认选择只影响新会话；已有会话继续固定快照。
  router.patch(
    "/me/skills/:id",
    ...jsonBody(2 * 1024 * 1024),
    async (request, response) => {
      const userId = principal(response).userId;

      const input = jsonInput(request);
      if (typeof input.enabled !== "boolean")
        fail(400, "INVALID_SKILL_SETTING");
      response
        .status(200)
        .json(
          await builds.setDefault(
            userId,
            parameter(request, "id"),
            input.enabled,
            input.versionId === undefined
              ? undefined
              : requireId(input.versionId),
            revision(input.expectedRevision),
            requireId(input.clientRequestId),
          ),
        );
      return;
    },
  );
  return router;
}
