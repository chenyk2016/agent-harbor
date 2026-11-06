/** Authenticated configuration API only; Claude Code connects directly to the selected servers. */
import { Router } from "express";
import type { McpService } from "./service.js";
import { probeMcp } from "./probe.js";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";

export function createMcpRouter(service: McpService) {
  const router = Router({ caseSensitive: true });
  router.get("/mcp-templates", (_request, response) => {
    // 模板只公开可选项和凭据字段名，不接受用户指定宿主命令、镜像或挂载。
    response.json(
      service.templates.map((t) => ({
        id: t.id,
        name: t.name,
        secretKeys: t.secretKeys,
      })),
    );
  });
  router.get("/mcp-connections", async (_request, response) => {
    response.json(await service.list(principal(response).userId));
  });
  router.post("/mcp-connections", ...jsonBody(), async (request, response) => {
    response
      .status(201)
      .json(await service.save(principal(response).userId, jsonInput(request)));
  });
  router.put(
    "/mcp-connections/:connectionId",
    ...jsonBody(),
    async (request, response) => {
      response.json(
        await service.save(
          principal(response).userId,
          jsonInput(request),
          parameter(request, "connectionId"),
        ),
      );
    },
  );
  router.delete("/mcp-connections/:connectionId", async (request, response) => {
    await service.remove(
      principal(response).userId,
      parameter(request, "connectionId"),
    );
    response.json({ deleted: true });
  });
  router.post(
    "/mcp-connections/:connectionId/test",
    async (request, response) => {
      response.json(
        await probeMcp(
          service,
          principal(response).userId,
          parameter(request, "connectionId"),
        ),
      );
    },
  );
  router.get("/mcp-scripts", async (_request, response) =>
    response.json(await service.scripts.list(principal(response).userId)),
  );
  router.get("/mcp-scripts/:scriptId", async (request, response) =>
    response.json(
      await service.scripts.read(
        "user",
        principal(response).userId,
        parameter(request, "scriptId"),
      ),
    ),
  );
  router.post(
    "/mcp-scripts",
    ...jsonBody(1024 * 1024),
    async (request, response) =>
      response
        .status(201)
        .json(
          await service.scripts.save(
            principal(response).userId,
            jsonInput(request),
          ),
        ),
  );
  router.put(
    "/mcp-scripts/:scriptId",
    ...jsonBody(1024 * 1024),
    async (request, response) => {
      const user = principal(response).userId,
        id = parameter(request, "scriptId");
      await service.scripts.read("user", user, id);
      response.json(await service.scripts.save(user, jsonInput(request), id));
    },
  );
  return router;
}
