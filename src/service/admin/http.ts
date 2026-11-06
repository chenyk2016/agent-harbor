/** 管理模块挂在统一身份/CSRF之后；所有新读取和写入均再次验证管理员。 */
import express, { Router, type RequestHandler } from "express";
import { AdminOperations } from "./service.js";
import { principal, jsonInput, parameter } from "../http/shared.js";
import { fail, ServiceError } from "../types.js";
import { filters, value } from "./queries.js";
export function adminGuard(admins: string[]): RequestHandler {
  return (_req, res, next) => {
    if (!admins.includes(principal(res).userId)) fail(403, "ADMIN_REQUIRED");
    next();
  };
}
export function adminAuditMiddleware(service: AdminOperations): RequestHandler {
  return async (req, res, next) => {
    if (
      ["GET", "HEAD"].includes(req.method) ||
      req.path === "/operations/preview"
    )
      return next();
    const path = "/admin" + req.path,
      input =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};
    const release = await service.acquireChange(path);
    try {
      const token = input.previewToken;
      delete input.previewToken;
      if (token !== undefined) {
        const preview = await service.preview(path, req.method, input);
        if (typeof token !== "string" || preview.token !== token)
          fail(409, "CHANGE_PREVIEW_EXPIRED");
      }
      const id = await service.auditStart(
        principal(res).userId,
        path,
        req.method,
        input,
      );
      let result: unknown = null;
      const json = res.json.bind(res);
      res.json = ((body: unknown) => {
        result = body;
        return json(body);
      }) as typeof res.json;
      res.once("close", release);
      res.once("finish", () => {
        release();
        void service
          .auditFinish(id, res.statusCode, result)
          .catch(() => console.error("Admin mutation outcome unconfirmed", id));
      });
    } catch (error) {
      release();
      throw error;
    }
    next();
  };
}
export function createAdminRouter(service: AdminOperations, admins: string[]) {
  const router = Router({ caseSensitive: true });
  router.use("/admin/operations", adminGuard(admins));
  router.get("/admin/operations/status", async (_req, res) =>
    res.json(await service.status(true)),
  );
  router.get("/admin/operations/requests", async (req, res) => {
    filters(req.query);
    res.json(
      await service.requests({
        ...req.query,
        limit: String(Math.min(filters(req.query).limit, 100)),
      }),
    );
  });
  router.get("/admin/operations/requests/:id", async (req, res) =>
    res.json(await service.evidence(parameter(req, "id"))),
  );
  router.get("/admin/operations/ledger", async (req, res) =>
    res.json(
      await service.ledger({
        ...req.query,
        limit: String(Math.min(filters(req.query).limit, 100)),
      }),
    ),
  );
  router.get("/admin/operations/audit", async (req, res) =>
    res.json(
      await service.audits({
        ...req.query,
        limit: String(Math.min(filters(req.query).limit, 100)),
      }),
    ),
  );
  router.get("/admin/operations/resources", async (req, res) =>
    res.json(
      await service.resources({
        ...req.query,
        limit: String(Math.min(filters(req.query).limit, 50)),
      }),
    ),
  );
  router.get("/admin/operations/resources/:id/size", async (req, res) =>
    res.json(await service.resourceSize(parameter(req, "id"))),
  );
  router.get("/admin/operations/usage", async (req, res) =>
    res.json(await service.usage(req.query)),
  );
  router.get("/admin/operations/export", async (req, res) => {
    const kind = value(req.query, "kind");
    const id = await service.auditStart(
      principal(res).userId,
      "/admin/operations/export",
      "EXPORT",
      { kind, filters: req.query },
    );
    let result;
    try {
      result = await service.export(kind, req.query);
    } catch (error) {
      await service.auditFinish(
        id,
        error instanceof ServiceError ? error.status : 500,
        { error: error instanceof ServiceError ? error.code : "EXPORT_FAILED" },
      );
      throw error;
    }
    await service.auditFinish(id, 200, {
      kind,
      total: result.total,
      exported: result.exported,
      partial: result.partial,
    });
    res.json(result);
  });
  router.post("/admin/operations/preview", async (req, res) => {
    const input = jsonInput(req);
    if (
      typeof input.path !== "string" ||
      typeof input.method !== "string" ||
      !input.input ||
      typeof input.input !== "object" ||
      Array.isArray(input.input)
    )
      fail(400, "INVALID_PREVIEW");
    res.json(
      await service.preview(
        input.path,
        input.method,
        input.input as Record<string, unknown>,
      ),
    );
  });
  router.patch("/admin/operations/incidents/:id", async (req, res) =>
    res.json(
      await service.updateIncident(
        parameter(req, "id"),
        principal(res).userId,
        jsonInput(req),
      ),
    ),
  );
  return router;
}
export const adminJson = express.json({
  limit: "256kb",
  type: () => true,
  strict: true,
  inflate: false,
});
