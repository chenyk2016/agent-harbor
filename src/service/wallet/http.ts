import { Router } from "express";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";
import { fail } from "../types.js";
import { users, wallets, walletRequests } from "../db/schema/index.js";
import { eq, asc, sql } from "drizzle-orm";
import { WalletService, yuan } from "./service.js";
import { requestWhere, filters } from "../admin/queries.js";
export function createWalletRouter(
  wallet: WalletService,
  admins: string[],
  enabled: boolean,
  reservationMode: "estimated" | "full" = "full",
) {
  const router = Router();
  router.get("/wallet", async (_req, res) =>
    res.json({ enabled, ...(await wallet.summary(principal(res).userId)) }),
  );
  router.use("/admin/wallet", (_req, res, next) => {
    if (!admins.includes(principal(res).userId)) fail(403, "ADMIN_REQUIRED");
    next();
  });
  router.get("/admin/wallet", async (_req, res) => {
    await wallet.tick();
    const rows = await wallet.db
      .select({
        id: users.id,
        name: users.name,
        disabled: users.disabled,
        balance: wallets.balance,
        reserved: wallets.reserved,
        plusUntil: wallets.plusUntil,
      })
      .from(users)
      .leftJoin(wallets, eq(users.id, wallets.userId));
    res.json({ enabled, reservationMode, settings: await wallet.settings(), users: rows });
  });
  // 全局待核对队列不受个人最近100条限制；不返回凭据或对话内容。
  router.get("/admin/wallet/requests", async (req, res) => {
    const query = { ...req.query, state: "unknown", limit: "50" };
    const f = filters(query), where = requestWhere(query);
    const result = await wallet.db.execute(sql`SELECT w.id,w."userId",w."modelName",w.reserved::float8,w.note,w."createdAt"::float8 FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE ${where} ORDER BY w."createdAt",w.id LIMIT 51 OFFSET ${f.offset}`);
    const counts = await wallet.db.execute(sql`SELECT count(*)::int AS total FROM wallet_requests w LEFT JOIN users u ON u.id=w."userId" WHERE ${where}`);
    res.json({ requests: result.rows.slice(0, 50), total: counts.rows[0].total, nextOffset: result.rows.length > 50 ? f.offset + 50 : null, sampledAt: Date.now() });
  });
  router.put("/admin/wallet/settings", ...jsonBody(), async (req, res) => {
    await wallet.configure(jsonInput(req));
    res.json({ saved: true });
  });
  router.post("/admin/wallet/gifts", ...jsonBody(), async (req, res) => {
    res.json(await wallet.gift(principal(res).userId, jsonInput(req)));
  });
  router.get("/admin/wallet/users/:id", async (req, res) => {
    const id = parameter(req, "id");
    if (!(await wallet.db.select().from(users).where(eq(users.id, id))).length)
      fail(404, "USER_NOT_FOUND");
    res.json(await wallet.summary(id));
  });
  router.put(
    "/admin/wallet/users/:id/plus",
    ...jsonBody(),
    async (req, res) => {
      await wallet.setPlus(parameter(req, "id"), jsonInput(req).until);
      res.json({ saved: true });
    },
  );
  router.post(
    "/admin/wallet/requests/:id/resolve",
    ...jsonBody(),
    async (req, res) => {
      const input = jsonInput(req),
        note = String(input.note ?? "").trim();
      if (!note || note.length > 200) fail(400, "REASON_REQUIRED");
      await wallet.settle(parameter(req, "id"), undefined, {
        amount: yuan(input.amountYuan),
        note,
        actor: principal(res).userId,
      });
      res.json({ saved: true });
    },
  );
  return router;
}
