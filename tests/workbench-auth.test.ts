import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Controller } from "../src/runtime/controller.js";
import { tokenHash } from "../src/service/auth.js";
import { WorkspaceFiles } from "../src/service/files/workspace-files.js";
import { createApi } from "../src/service/http-api.js";
import { WorkbenchAuth } from "../src/service/identity/workbench.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { WalletService, MICRO } from "../src/service/wallet/service.js";
import { testDatabase } from "./pg.js";

test("workbench self-registration, one-time credit, admin binding and revocation", async () => {
  const database = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "ah-workbench-"));
  const origin = "https://workbench.example.test";
  const auth = new WorkbenchAuth(database.pool, { origin, secret: randomBytes(32).toString("hex"), registration: true });
  const controller = new Controller(root);
  const files = new WorkspaceFiles(root);
  const manager = new SessionManager(new ServiceStore(database.db), controller, "fixture", 900000, 10);
  const wallet = new WalletService(database.db);
  const server = createApi(manager, controller, files, { origin, workbenchAuth: auth, adminUsers: ["developer"] });
  try {
    await auth.checkStorage();
    await wallet.configure({ signupYuan: 2, plusYuan: 10 });
    await manager.identity.importKeys([{ userId: "developer", tokenHash: tokenHash("fixture-admin") }]);
    const developer = { email: "developer@example.test", password: "Long fixture password" };
    const subject = await auth.createBindingIdentity(developer);
    await manager.identity.bindWorkbench(subject, "developer");
    assert.equal((await wallet.summary("developer")).balance, 2 * MICRO);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const send = (path: string, method = "GET", body?: object, cookie?: string, bearer?: string) =>
      fetch(url + path, { method, headers: {
        Origin: origin, "Content-Type": "application/json", "X-Harbor-Client": "web",
        ...(cookie && { Cookie: cookie }), ...(bearer && { Authorization: `Bearer ${bearer}` }),
      }, body: body && JSON.stringify(body) });
    const getCookie = (response: Response) => {
      const value = response.headers.getSetCookie().findLast((item) => item.startsWith("__Host-ah_workbench_session="));
      assert.ok(value?.includes("Secure") && value.includes("HttpOnly"), String(value));
      return value!.split(";", 1)[0];
    };

    assert.equal((await send("/auth/config")).status, 200);
    const adminLogin = await send("/auth/password", "POST", developer);
    assert.equal(adminLogin.status, 200, await adminLogin.clone().text());
    const adminCookie = getCookie(adminLogin);
    assert.deepEqual(await (await send("/auth/me", "GET", undefined, adminCookie)).json(),
      { userId: "developer", capabilities: { managePlatform: true } });

    const input = { email: " User@EXAMPLE.test ", password: "A long test password" };
    const parallel = await Promise.all([send("/auth/register", "POST", input), send("/auth/register", "POST", input)]);
    assert.deepEqual(parallel.map((response) => response.status).sort(), [200, 409]);
    const response = parallel.find((response) => response.ok)!;
    const cookie = getCookie(response);
    const me = await (await send("/auth/me", "GET", undefined, cookie)).json();
    assert.equal(me.capabilities.managePlatform, false);
    assert.notEqual(me.userId, "developer");
    assert.equal((await wallet.summary(me.userId)).balance, 10 * MICRO);
    assert.equal((await send("/auth/register", "POST", { ...input, email: "user@example.test" })).status, 409);
    assert.equal((await send("/admin/users", "GET", undefined, cookie)).status, 403);
    assert.equal((await send("/auth/password", "POST", { ...input, password: "Wrong test password" })).status, 401);
    const secondLogin = await send("/auth/password", "POST", input);
    assert.equal(secondLogin.status, 200);
    const second = getCookie(secondLogin);
    assert.equal((await send("/auth/logout", "POST", undefined, cookie)).status, 200);
    assert.equal((await send("/auth/me", "GET", undefined, cookie)).status, 401);
    assert.equal((await send("/auth/me", "GET", undefined, second)).status, 200);

    const own = await manager.create(me.userId, "private conversation");
    const other = await manager.create("developer", "admin conversation");
    assert.equal((await send("/sessions/" + other.id, "GET", undefined, second)).status, 404);
    const events = await send(`/sessions/${own.id}/events`, "GET", undefined, second);
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    await reader.read();
    const key = await manager.identity.createKey(me.userId, "test CLI");
    assert.equal((await send("/admin/users/" + me.userId, "PATCH", { disabled: true }, undefined, "fixture-admin")).status, 200);
    const streamClosed = await Promise.race([
      reader.read().then(({ done }) => done).catch(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000).unref()),
    ]);
    assert.equal(streamClosed, true);
    assert.equal((await send("/auth/me", "GET", undefined, second)).status, 401);
    assert.equal((await send("/auth/me", "GET", undefined, undefined, key.token)).status, 401);
    assert.equal((await send("/auth/password", "POST", input)).status, 401);
    assert.equal((await send("/admin/users/" + me.userId, "PATCH", { disabled: false }, undefined, "fixture-admin")).status, 200);
    assert.equal((await send("/auth/me", "GET", undefined, second)).status, 401);
    assert.equal((await send("/auth/password", "POST", input)).status, 200);
    assert.equal((await wallet.summary(me.userId)).balance, 10 * MICRO);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await files.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
