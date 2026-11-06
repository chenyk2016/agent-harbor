/** 会话Router：只解析HTTP输入与准备快照，执行/取消/关闭仍交给SessionManager。 */
import { Router } from "express";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Controller } from "../../runtime/controller.js";
import type { SessionManager } from "../session-manager.js";
import { fail, isModelProbe, type ServiceSession } from "../types.js";
import { streamEvents } from "../event-stream.js";
import { createFileRouter } from "../files/http.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import type { SkillModule } from "../skills/http.js";
import { digest, requireId } from "../skills/service.js";
import type { ExpertService } from "../experts/service.js";
import { bundleExpertSource } from "../experts/packages.js";
import type { McpService } from "../mcp/service.js";
import type { ApplicationService } from "../applications/service.js";
import type { LlmService } from "../llm/service.js";
import { modelProbeRouter } from "../llm/setup-probe.js";
import { ResourceDeletions } from "../deletions/service.js";
import { deletionRouter } from "../deletions/http.js";
import {
  jsonBody,
  jsonInput,
  parameter,
  principal,
  searchParams,
} from "../http/shared.js";
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function integer(
  value: string | null,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (value === null) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    fail(400, "INVALID_CURSOR_OR_LIMIT");
  return Number(value);
}
export function createSessionRouter(
  manager: SessionManager,
  controller: Pick<Controller, "store">,
  files: WorkspaceFiles,
  skillModule?: SkillModule,
  experts?: ExpertService,
  mcp?: McpService,
  applications?: ApplicationService,
  llm?: LlmService,
) {
  const router = Router({ caseSensitive: true });
  const deletions = new ResourceDeletions(manager, controller.store.root, files, applications, llm);
  router.use(deletionRouter(deletions));
  if (llm) router.use(modelProbeRouter(llm, manager, controller.store, deletions));
  void deletions.resume().catch(() => console.error("Deletion recovery requires retry"));
  // 集合路由：查询列表或创建准备好的会话；尚未登记的目录不对外可见。
  router.get("/sessions", async (request, response) => {
    const userId = principal(response).userId;
    const query = searchParams(request);

    const limit = integer(query.get("limit"), 50, 100);
    const after = query.get("after");
    // 删除中的行仍可作本人列表的分页锚点，但不能借此读取其内容。
    const anchor = after ? await manager.store.session(after) : undefined;
    if (after && (!anchor || anchor.ownerId !== userId || anchor.analysisAppId || isModelProbe(anchor))) fail(404, "SESSION_NOT_FOUND");
    const sessions =
      query.get("order") === "created"
        ? await manager.store.sessionPage(userId, limit, anchor)
        : await manager.store.sessions(userId, limit, false);
    // 列表页一次取回最后一条消息，避免每个会话单独往返数据库。
    const lastIds = sessions.flatMap((session) =>
      session.lastMessageId ? [session.lastMessageId] : [],
    );
    const lastMessages = new Map(
      (await manager.store.messagesByIds(lastIds)).map((message) => [
        message.id,
        message,
      ]),
    );
    const deleting = new Map((await deletions.pending(userId))
      .map(job => [job.kind === "session" ? job.resourceId : job.sessionId, job.state]));
    response.status(200).json(
      sessions.map((session) => ({
        ...session,
        deletionState: deleting.get(session.id),
        expertSnapshot: deleting.has(session.id) ? null : session.expertSnapshot,
        capabilitySnapshot: deleting.has(session.id) ? null : session.capabilitySnapshot,
        modelSnapshot: deleting.has(session.id) ? null : session.modelSnapshot,
        message: !deleting.has(session.id) && session.lastMessageId
          ? (lastMessages.get(session.lastMessageId) ?? null)
          : null,
      })),
    );
    return;
  });
  router.post("/sessions", ...jsonBody(), async (request, response) => {
    const userId = principal(response).userId;

    const input = jsonInput(request);
    const title = input.title ?? "New session";
    if (typeof title !== "string" || title.length > 200)
      fail(400, "INVALID_TITLE");
    if (
      input.template !== undefined &&
      !["empty", "fix-project"].includes(String(input.template))
    )
      fail(400, "INVALID_TEMPLATE");
    const requestId =
      input.clientRequestId === undefined
        ? undefined
        : requireId(input.clientRequestId);
    if (
      input.deploymentId !== undefined &&
      (typeof input.deploymentId !== "string" || input.deploymentId.length > 200)
    )
      fail(400, "INVALID_MODEL_INPUT");
    const hash = digest(input);
    if (requestId) {
      const old = await manager.store.creation(userId, requestId);
      if (old) {
        if (old.creationRequestHash !== hash) fail(409, "REQUEST_ID_CONFLICT");
        response.status(200).json(old);
        return;
      }
    }
    let expert: import("../../shared/experts.js").ExpertSnapshot | undefined;
    let snapshot:
      import("../../shared/skills.js").CapabilitySnapshot | undefined;
    if (input.expertVersionId !== undefined) {
      if (!experts || !requestId || input.skillSelection !== undefined)
        fail(400, "INVALID_EXPERT_SELECTION");
      const resolved = await experts.resolve(
        userId,
        requireId(input.expertVersionId),
      );
      expert = resolved.expert;
      snapshot = resolved.capabilities;
    }
    if (input.skillSelection !== undefined) {
      if (!skillModule || !requestId) fail(400, "SKILL_SELECTION_UNAVAILABLE");
      const selection = input.skillSelection as {
        skillVersionIds?: unknown;
        expectedSelectionDigest?: unknown;
      };
      if (
        !selection ||
        typeof selection !== "object" ||
        (selection.skillVersionIds !== undefined &&
          (!Array.isArray(selection.skillVersionIds) ||
            selection.skillVersionIds.some((id) => typeof id !== "string")))
      )
        fail(400, "INVALID_SKILL_SELECTION");
      snapshot = await skillModule.builds.selection(
        userId,
        selection.skillVersionIds as string[] | undefined,
      );
      if (
        selection.expectedSelectionDigest &&
        selection.expectedSelectionDigest !== snapshot.digest
      )
        fail(409, "SELECTION_CHANGED");
    }
    // CLI等旧客户端未显式选择时也使用本人的默认技能；已有会话不补写快照。
    if (!snapshot && skillModule)
      snapshot = await skillModule.builds.selection(userId);
    if (input.mcpConnectionIds !== undefined)
      fail(
        400,
        "MCP_SESSION_SELECTION_REMOVED: configure enabled connections in MCP settings",
      );
    // 模板复制完成才登记为可见会话，避免其他连接提前向半初始化目录提交任务。
    const id = randomUUID();
    const session = await manager
      .createPrepared(
        userId,
        title,
        id,
        async () => {
          const directory = await controller.store.prepare(id);
          if (snapshot)
            await skillModule!.builds.bundle(
              userId,
              id,
              snapshot,
              Boolean(expert?.workbuddy),
            );
          if (expert?.workbuddy && snapshot)
            await bundleExpertSource(
              experts!,
              userId,
              expert.versionId,
              id,
              snapshot.digest,
            );
          if (input.template === "fix-project")
            await cp(
              fileURLToPath(
                new URL("../../../../examples/fix-project", import.meta.url),
              ),
              `${directory}/workspace`,
              { recursive: true },
            );
        },
        {
          snapshot,
          expert,
          deploymentId: input.deploymentId as string | undefined,
          requestId,
          hash: requestId ? hash : undefined,
        },
      )
      .catch(async (error) => {
        // 提交结果不明时先核对，不能删除可能已经被数据库引用的工作区。
        const old = requestId
          ? await manager.store.creation(userId, requestId)
          : undefined;
        if (old && old.creationRequestHash === hash) {
          if (old.id !== id)
            await rm(controller.store.directory(id), {
              recursive: true,
              force: true,
            });
          return old;
        }
        if (await manager.store.session(id)) throw error;
        // 此UUID尚未登记，其他客户端无法执行；失败清理不会碰已有会话。
        await rm(controller.store.directory(id), {
          recursive: true,
          force: true,
        });
        throw error;
      });
    response.status(201).json(session);
    return;
  });

  router.post(
    "/sessions/:sessionId/mcp/reload",
    ...jsonBody(),
    async (request, response) => {
      const user = principal(response).userId,
        id = parameter(request, "sessionId");
      const session = await manager.owned(user, id);
      if (await manager.store.active(id)) fail(409, "SESSION_BUSY");
      const body = jsonInput(request);
      if (body.expectedMessageId !== session.lastMessageId)
        fail(409, "STALE_RELOAD");
      response.json(await manager.close(user, id, session.lastMessageId));
    },
  );

  // 所有单会话路径先核对归属；子Router和handler共用该请求内的快照。
  router.use("/sessions/:sessionId", async (request, response, next) => {
    const id = parameter(request, "sessionId");
    if (!uuid(id)) fail(404, "SESSION_NOT_FOUND");
    response.locals.session = await manager.owned(
      principal(response).userId,
      id,
    );
    next();
  });
  router.use("/sessions/:sessionId/files", createFileRouter(manager, files));
  router.get("/sessions/:sessionId", async (_request, response) => {
    const session = response.locals.session as ServiceSession;

    response.status(200).json({
      ...session,
      message: session.lastMessageId
        ? await manager.store.message(session.lastMessageId)
        : null,
    });
    return;
  });
  router.get(
    "/sessions/:sessionId/messages/:messageId",
    async (request, response) => {
      const id = parameter(request, "sessionId");

      const message = await manager.store.message(
        parameter(request, "messageId"),
      );
      if (!message || message.sessionId !== id) fail(404, "MESSAGE_NOT_FOUND");
      response.status(200).json(message);
      return;
    },
  );
  router.get("/sessions/:sessionId/history", async (request, response) => {
    const id = parameter(request, "sessionId");
    const session = response.locals.session as ServiceSession;
    const query = searchParams(request);

    const after = integer(query.get("after"), 0);
    const through = integer(query.get("through"), session.lastEventId);
    const limit = integer(query.get("limit"), 100, 100);
    if (after > through || through > session.lastEventId)
      fail(400, "CURSOR_AHEAD");
    // 事件与消息在同一只读快照中读取，补看不会看到事件之后才提交的状态。
    const { events, messages } = await manager.store.history(
      id,
      after,
      through,
      limit,
    );
    response.status(200).json({
      session: {
        ...session,
        message: session.lastMessageId
          ? await manager.store.message(session.lastMessageId)
          : null,
      },
      through,
      events,
      messages,
    });
    return;
  });
  router.get("/sessions/:sessionId/messages", async (request, response) => {
    const id = parameter(request, "sessionId");
    const query = searchParams(request);

    response
      .status(200)
      .json(
        await manager.store.messages(
          id,
          integer(query.get("after"), 0),
          integer(query.get("limit"), 50, 100),
        ),
      );
    return;
  });
  router.post(
    "/sessions/:sessionId/messages",
    ...jsonBody(),
    async (request, response) => {
      const userId = principal(response).userId;
      const id = parameter(request, "sessionId");

      const input = jsonInput(request);
      if (
        !uuid(input.clientMessageId) ||
        typeof input.text !== "string" ||
        !input.text.trim() ||
        (input.deploymentId !== undefined && !uuid(input.deploymentId))
      )
        fail(400, "INVALID_MESSAGE");
      // 已接收的ID直接返回原结果；空间检查不能把一次安全重试变成新任务。
      if (!(await manager.store.duplicate(id, input.clientMessageId))) {
        const owned = await manager.store.sessions(
          userId,
          Number.MAX_SAFE_INTEGER,
        );
        const used = await files.bytes(
          owned.map((session) => session.id),
          AbortSignal.timeout(15_000),
        );
        await manager.identity.require(userId);
        if (used >= (await manager.identity.policy(userId)).workspaceBytes)
          fail(413, "WORKSPACE_LIMIT");
      }
      const result = await manager.submit(
        userId,
        id,
        input.clientMessageId,
        input.text,
        input.deploymentId as string | undefined,
      );
      response.status(result.duplicate ? 200 : 202).json(result);
      return;
    },
  );
  // SSE直接写响应流，不做JSON包装；退出登录只撤销观看连接。
  router.get("/sessions/:sessionId/events", async (request, response) => {
    const { signal } = principal(response);
    const id = parameter(request, "sessionId");
    const session = response.locals.session as ServiceSession;
    const query = searchParams(request);

    const after = integer(query.get("after"), 0);
    if (after > session.lastEventId) fail(400, "CURSOR_AHEAD");
    await streamEvents(response, manager.store, id, after, AbortSignal.any([signal, deletions.signal(id)]));
    return;
  });
  router.post(
    "/sessions/:sessionId/messages/:messageId/cancel",
    async (request, response) => {
      const { userId } = principal(response);
      const id = parameter(request, "sessionId");

      if (!uuid(parameter(request, "messageId")))
        fail(404, "MESSAGE_NOT_FOUND");
      const result = await manager.cancel(
        userId,
        id,
        parameter(request, "messageId"),
      );
      response.status(result.terminal ? 200 : 202).json(result);
      return;
    },
  );
  router.post(
    "/sessions/:sessionId/close",
    ...jsonBody(),
    async (request, response) => {
      const { userId } = principal(response);
      const id = parameter(request, "sessionId");

      const input = jsonInput(request);
      if (input.expectedMessageId !== null && !uuid(input.expectedMessageId))
        fail(400, "EXPECTED_MESSAGE_REQUIRED");
      const result = await manager.close(
        userId,
        id,
        input.expectedMessageId as string | null,
      );
      response.status(result.closed ? 200 : 202).json(result);
      return;
    },
  );
  return router;
}
