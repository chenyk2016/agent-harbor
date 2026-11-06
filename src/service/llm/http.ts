import { Router } from "express";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";
import { fail } from "../types.js";
import type { LlmService } from "./service.js";
import { providerPresets } from "../../shared/provider-presets.js";
export function createLlmRouter(
  service?: LlmService,
  admins: string[] = [],
  owned?: (user: string, id: string) => Promise<unknown>,
) {
  const router = Router({ caseSensitive: true });
  router.get("/llm/models", async (_req, res) =>
    res.json(
      service
        ? await service.catalog(
            principal(res).userId,
            admins.includes(principal(res).userId),
          )
        : { enabled: false, models: [], defaultModelId: null, admin: false },
    ),
  );
  router.get("/sessions/:id/llm-usage", async (req, res) => {
    if (!service || !owned) fail(409, "LLM_DISABLED");
    const user = principal(res).userId,
      id = parameter(req, "id");
    await owned(user, id);
    res.json(await service.usage(id, user));
  });
  router.put("/llm/default", ...jsonBody(), async (req, res) => {
    if (!service) fail(409, "LLM_DISABLED");
    await service.setDefault(principal(res).userId, jsonInput(req).deploymentId);
    res.json({ saved: true });
  });
  router.use("/admin/llm", (_req, res, next) => {
    if (!admins.includes(principal(res).userId)) fail(403, "ADMIN_REQUIRED");
    if (!service) fail(409, "LLM_DISABLED");
    next();
  });
  router.get("/admin/llm", async (_req, res) => res.json(await service!.adminOverview()));
  router.get("/admin/llm/presets", async (_req, res) => res.json({ presets: providerPresets }));
  router.get("/admin/llm/deployments/:id", async (req, res) =>
    res.json(await service!.deploymentDetail(parameter(req, "id"))),
  );
  router.post("/admin/llm/providers", ...jsonBody(), async (req, res) =>
    res.status(201).json(await service!.addProvider(jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/providers/:id/discover", async (req, res) =>
    res.json(await service!.discoverModels(parameter(req, "id"))),
  );
  router.get("/admin/llm/providers/:id/deletion-impact", async (req, res) =>
    res.json(await service!.providerDeletionImpact(parameter(req, "id"))),
  );
  router.delete("/admin/llm/providers/:id", async (req, res) =>
    res.json(await service!.deleteProvider(parameter(req, "id"), principal(res).userId)),
  );
  router.patch("/admin/llm/providers/:id", ...jsonBody(), async (req, res) =>
    res.json(await service!.updateProvider(parameter(req, "id"), jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/providers/:id/secrets", ...jsonBody(), async (req, res) =>
    res.json(await service!.rotateProviderSecret(parameter(req, "id"), jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/deployments", ...jsonBody(), async (req, res) =>
    res.status(201).json(await service!.createDeployment(jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/deployments/:id/versions", ...jsonBody(), async (req, res) =>
    res.status(201).json(await service!.createVersion(parameter(req, "id"), jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/deployments/:id/current", ...jsonBody(), async (req, res) => {
    const input = jsonInput(req);
    if (typeof input.versionId !== "string" || !input.versionId)
      fail(400, "INVALID_MODEL_INPUT");
    if (typeof input.expectedVersionId !== "string" || !input.expectedVersionId)
      fail(400, "INVALID_MODEL_INPUT");
    res.json(
      await service!.pointDeployment(
        parameter(req, "id"),
        input.versionId,
        input.expectedVersionId,
        principal(res).userId,
      ),
    );
  });
  router.get("/admin/llm/deployments/:id/deletion-impact", async (req, res) =>
    res.json(await service!.deploymentDeletionImpact(parameter(req, "id"))),
  );
  router.delete("/admin/llm/deployments/:id", async (req, res) =>
    res.json(await service!.deleteDeployment(parameter(req, "id"), principal(res).userId)),
  );
  router.patch("/admin/llm/deployments/:id", ...jsonBody(), async (req, res) =>
    res.json(await service!.updateDeployment(parameter(req, "id"), jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/deployments/:id/prices", ...jsonBody(), async (req, res) =>
    res.json(await service!.createPrice(parameter(req, "id"), jsonInput(req), principal(res).userId)),
  );
  router.get("/admin/llm/versions/:versionId/costs", async (req, res) =>
    res.json({ costs: await service!.costHistory(parameter(req, "versionId")) }),
  );
  router.post("/admin/llm/versions/:versionId/costs", ...jsonBody(), async (req, res) =>
    res.json(await service!.publishCost(parameter(req, "versionId"), jsonInput(req), principal(res).userId)),
  );
  router.post("/admin/llm/deployments/:id/sync", async (req, res) => {
    res.json(await service!.syncDeployment(parameter(req, "id")));
  });
  router.post("/admin/llm/deployments/:id/archive", async (req, res) =>
    res.json(await service!.archiveDeployment(parameter(req, "id"), principal(res).userId)),
  );
  return router;
}
