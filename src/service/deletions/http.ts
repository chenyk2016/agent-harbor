import { Router } from "express";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";
import type { ResourceDeletions } from "./service.js";
export function deletionRouter(service: ResourceDeletions) {
  const router = Router({ caseSensitive: true });
  router.get("/deletions", async (_req, res) => {
    res.json(await service.list(principal(res).userId));
  });
  router.get("/deletions/:id", async (req, res) => {
    res.json(await service.job(principal(res).userId, parameter(req, "id")));
  });
  router.delete("/sessions/:id", async (req, res) => {
    res
      .status(202)
      .json(
        await service.request(
          principal(res).userId,
          "session",
          parameter(req, "id"),
        ),
      );
  });
  router.delete("/applications/:id", ...jsonBody(), async (req, res) => {
    const input = jsonInput(req);
    res
      .status(202)
      .json(
        await service.request(
          principal(res).userId,
          "application",
          parameter(req, "id"),
          typeof input.confirmName === "string" ? input.confirmName : undefined,
        ),
      );
  });
  return router;
}
