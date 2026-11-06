/** 已认证应用管理入口。公开页面由独立网关处理，不经过管理API。 */
import { Router } from "express";
import {
  jsonBody,
  jsonInput,
  parameter,
  principal,
  searchParams,
} from "../http/shared.js";
import { fail } from "../types.js";
import { streamEvents } from "../event-stream.js";
import type { ApplicationService } from "./service.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { Readable } from "node:stream";

/** 校验管理接口中的应用、版本和请求编号；这里只接受 UUID 形状，资源归属由服务层继续核对。 */
const uuid = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
  )
    fail(400, "INVALID_APPLICATION_ID");
  return value;
};
/** 校验字符串类型、长度、空值策略和空字符，不替代具体业务的数据校验。 */
const text = (value: unknown, limit: number, empty = false): string => {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!empty && !value.trim()) ||
    value.includes("\0")
  )
    fail(400, "INVALID_APPLICATION_TEXT");
  return value;
};
/** 校验入口代次等参数为非负安全整数，拒绝小数、负数或超出精确范围的值。 */
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(400, "INVALID_APPLICATION_GENERATION");
  return value;
};
/** 解析预期源码头版本；null 表示尚无版本，其余值必须是有效编号。 */
const head = (value: unknown) => (value === null ? null : uuid(value));

/** 组装已认证的应用管理 API，解析请求参数并交给服务协调；公开应用页面由独立网关处理。 */
export function createApplicationRouter(service: ApplicationService) {
  const router = Router({ caseSensitive: true });
  router.get("/applications/config", (_request, response) =>
    response.json({
      enabled: true,
      canCreate: service.options.creators.has(principal(response).userId),
      loginProviders: service.creationLoginProviders(),
    }),
  );
  router.post("/applications/:id/preview-access", ...jsonBody(), async (request, response) => {
    const appId = uuid(parameter(request, "id"));
    const deploymentId = uuid(jsonInput(request).deploymentId);
    const { userId, signal } = principal(response);
    response.json(await service.previewAccess.issue(userId, signal, appId, deploymentId));
  });
  router.get("/applications", async (_request, response) =>
    response.json(await service.store.list(principal(response).userId)),
  );
  router.post("/applications", ...jsonBody(), async (request, response) => {
    const input = jsonInput(request);
    response
      .status(202)
      .json(
        await service.create(
          principal(response).userId,
          text(input.title, 120),
          text(input.prompt, 16000, true),
          uuid(input.clientRequestId),
          input.modelDeploymentId===undefined?undefined:text(input.modelDeploymentId,200),
        ),
      );
  });
  const analysisScope = (request: import("express").Request, response: import("express").Response) => {
    if (!service.analysis) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
    const appId = uuid(parameter(request, "id"));
    const environment = parameter(request, "environment");
    if (environment !== "preview" && environment !== "production") fail(400, "INVALID_OBSERVATION_RANGE");
    return { appId, environment, owner: principal(response).userId, analysis: service.analysis } as const;
  };
  const analysisMessages = "/applications/:id/analysis/:environment/messages";
  router.get(analysisMessages, async (request, response) => {
    const { analysis, owner, appId, environment } = analysisScope(request, response);
    const session = await analysis.session(owner, appId, environment);
    if (!session) return void response.json({ messages: [], events: [], through: 0, hasSession: false });
    const store = service.sessions.store;
    const messages = await store.analysisMessages(session.id);
    const events = await store.analysisEvents(session.id, messages.map(message => message.id), session.lastEventId);
    await analysis.scope(owner, appId);
    response.json({ messages, events, through: session.lastEventId, hasSession: true });
  });
  router.post(analysisMessages, ...jsonBody(), async (request, response) => {
    const { analysis, owner, appId, environment } = analysisScope(request, response);
    const input = jsonInput(request);
    const result = await analysis.send(owner, appId, environment, uuid(input.clientMessageId), text(input.text, 4000),
      input.modelDeploymentId === undefined ? undefined : text(input.modelDeploymentId, 200));
    response.status(result.duplicate ? 200 : 202).json(result);
  });
  router.post(analysisMessages + "/:messageId/cancel", async (request, response) => {
    const { analysis, owner, appId, environment } = analysisScope(request, response);
    const session = await analysis.session(owner, appId, environment);
    if (!session) fail(404, "MESSAGE_NOT_FOUND");
    response.json(await service.sessions.cancel(owner, session.id, uuid(parameter(request, "messageId")), true));
  });
  router.get("/applications/:id/analysis/:environment/events", async (request, response) => {
    const { analysis, owner, appId, environment } = analysisScope(request, response);
    const session = await analysis.session(owner, appId, environment);
    if (!session) fail(404, "SESSION_NOT_FOUND");
    const after = integer(Number(searchParams(request).get("after") ?? 0));
    if (after > session.lastEventId) fail(400, "CURSOR_AHEAD");
    await streamEvents(response, service.sessions.store, session.id, after, AbortSignal.any([principal(response).signal,
      ...(service.sessions.deletions ? [service.sessions.deletions.signal(session.id)] : [])]),
      () => analysis.scope(owner, appId));
  });
  router.get("/applications/:id/observability/reports/:reportId", async (request, response) => {
    if (!service.analysis) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
    response.json(await service.analysis.report(principal(response).userId,
      uuid(parameter(request, "id")), uuid(parameter(request, "reportId"))));
  });
  router.get(
    "/applications/:id/observability/summary",
    async (request, response) => {
      const owner = principal(response).userId,
        appId = uuid(parameter(request, "id"));
      await service.store.owned(owner, appId);
      if (!service.observation)
        return void response.json({ enabled: false, status: "disabled" });
      const query = searchParams(request);
      response.json(
        await service.observation.summary(
          owner,
          appId,
          query.get("environment") ?? "production",
          Number(query.get("days") ?? 7),
        ),
      );
    },
  );
  router.put(
    "/applications/:id/observability/analysis-config",
    ...jsonBody(),
    async (request, response) => {
      if (!service.observation) fail(409, "OBSERVATION_DISABLED");
      response.json(
        await service.observation.configure(
          principal(response).userId,
          uuid(parameter(request, "id")),
          String(jsonInput(request).environment),
          jsonInput(request),
        ),
      );
    },
  );
  router.post(
    "/applications/:id/observability/data-deletions",
    ...jsonBody(),
    async (request, response) => {
      const owner = principal(response).userId,
        appId = uuid(parameter(request, "id"));
      await service.store.owned(owner, appId);
      if (!service.observation) fail(409, "OBSERVATION_DISABLED");
      const input = jsonInput(request),
        environment = input.environment;
      if (
        !["production", "preview"].includes(String(environment)) ||
        input.confirmAppId !== appId
      )
        fail(400, "OBSERVATION_DELETE_CONFIRMATION_REQUIRED");
      await service.observation.store.erase(
        appId,
        String(environment),
        Date.now(),
      );
      response.json({ deleted: true });
    },
  );
  router.get("/applications/:id", async (request, response) =>
    response.json(
      await service.detail(
        principal(response).userId,
        uuid(parameter(request, "id")),
      ),
    ),
  );
  router.get(
    "/applications/:id/revisions/:revisionId/export",
    async (request, response) => {
      const source = await service.exportSource(
        principal(response).userId,
        uuid(parameter(request, "id")),
        uuid(parameter(request, "revisionId")),
      );
      const zip = new ZipFile();
      /** 递归把已导出的固定源码目录加入 ZIP；文件传输结束后的临时目录回收由外围下载流程负责。 */
      const add = async (relative = ""): Promise<void> => {
        for (const entry of await readdir(join(source.directory, relative), {
          withFileTypes: true,
        })) {
          const path = relative ? relative + "/" + entry.name : entry.name;
          if (entry.isDirectory()) await add(path);
          else zip.addFile(join(source.directory, path), path);
        }
      };
      try {
        await add();
        response.setHeader("Content-Type", "application/zip");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="application-v${source.number}.zip"`,
        );
        zip.outputStream.on("error", (error) => response.destroy(error));
        zip.on("error", (error) => response.destroy(error));
        response.once("close", () => {
          (zip.outputStream as Readable).destroy();
          void source
            .cleanup()
            .catch(() => console.error("Application export cleanup failed"));
        });
        zip.outputStream.pipe(response);
        zip.end();
      } catch (error) {
        await source.cleanup();
        throw error;
      }
    },
  );
  router.patch(
    "/applications/:id",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response.json(
        await service.store.rename(
          principal(response).userId,
          uuid(parameter(request, "id")),
          text(input.title, 120),
          integer(input.expectedStateVersion),
        ),
      );
    },
  );
  router.post(
    "/applications/:id/messages",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      const result = await service.generate(
        principal(response).userId,
        uuid(parameter(request, "id")),
        text(input.text, 16000),
        uuid(input.clientMessageId),
        head(input.expectedHeadRevisionId),
        input.modelDeploymentId === undefined ? undefined : text(input.modelDeploymentId, 200),
      );
      if (!result.message) fail(409, "APPLICATION_MESSAGE_NOT_ACCEPTED");
      response.status(202).json(result);
    },
  );
  router.post(
    "/applications/:id/snapshots",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await service.snapshot(
            principal(response).userId,
            uuid(parameter(request, "id")),
            uuid(input.clientRequestId),
            head(input.expectedHeadRevisionId),
          ),
        );
    },
  );
  router.post(
    "/applications/:id/restore",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await service.restore(
            principal(response).userId,
            uuid(parameter(request, "id")),
            uuid(input.revisionId),
            uuid(input.clientRequestId),
            head(input.expectedHeadRevisionId),
          ),
        );
    },
  );
  for (const environment of ["preview", "production"] as const) {
    router.post(
      `/applications/:id/${environment}`,
      ...jsonBody(),
      async (request, response) => {
        const input = jsonInput(request);
        response
          .status(202)
          .json(
            await service.deploy(
              principal(response).userId,
              uuid(parameter(request, "id")),
              uuid(input.revisionId),
              environment,
              uuid(input.clientRequestId),
              integer(input.expectedGeneration),
              input.confirmPublicRevisionId === uuid(input.revisionId),
            ),
          );
      },
    );
    router.get(`/applications/:id/data/${environment}`, async (request, response) => {
      response.json(await service.tables(
        principal(response).userId, uuid(parameter(request, "id")), environment,
      ));
    });
    router.get(
      `/applications/:id/data/${environment}/:table`,
      async (request, response) => {
        const query = searchParams(request);
        const limit = Number(query.get("limit") ?? 100);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, "INVALID_DATASET_QUERY");
        const cursor = query.get("cursor");
        if (cursor !== null && !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) fail(400, "INVALID_DATASET_CURSOR");
        response.json(await service.records(principal(response).userId,
          uuid(parameter(request, "id")), environment, parameter(request, "table"), limit, cursor ?? undefined));
      },
    );
  }
  router.post(
    "/applications/:id/unpublish",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await service.unpublish(
            principal(response).userId,
            uuid(parameter(request, "id")),
            uuid(input.clientRequestId),
            integer(input.expectedGeneration),
          ),
        );
    },
  );
  router.post(
    "/applications/:id/pause-preview",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await service.pausePreview(
            principal(response).userId,
            uuid(parameter(request, "id")),
            uuid(input.clientRequestId),
            integer(input.expectedGeneration),
          ),
        );
    },
  );
  router.post(
    "/applications/:id/rollback",
    ...jsonBody(),
    async (request, response) => {
      const input = jsonInput(request);
      response
        .status(202)
        .json(
          await service.rollback(
            principal(response).userId,
            uuid(parameter(request, "id")),
            uuid(input.deploymentId),
            uuid(input.clientRequestId),
            integer(input.expectedGeneration),
          ),
        );
    },
  );
  router.post(
    "/applications/:id/operations/:operationId/cancel",
    async (request, response) => {
      response.json(
        await service.cancel(
          principal(response).userId,
          uuid(parameter(request, "id")),
          uuid(parameter(request, "operationId")),
        ),
      );
    },
  );
  router.post("/applications/:id/reconcile", async (request, response) => {
    response.json(
      await service.reconcile(
        principal(response).userId,
        uuid(parameter(request, "id")),
      ),
    );
  });
  router.get("/applications/:id/events", async (request, response) => {
    const appId = uuid(parameter(request, "id"));
    await service.store.owned(principal(response).userId, appId);
    const cursor = Number(searchParams(request).get("after") ?? 0);
    response.json(await service.store.events(appId, integer(cursor)));
  });
  return router;
}
