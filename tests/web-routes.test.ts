/** 深层链接必须返回应用入口；不能把 API、源码和运行文件当作页面回退。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serveWeb } from "../src/service/web-assets.js";

test("page deep links survive refresh while unknown files and API paths stay private", async () => {
  const server = createServer((request, response) => {
    void serveWeb(
      request,
      response,
      new URL(request.url!, "http://local").pathname,
    )
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const entry = await (await fetch(origin)).text();
    assert.match(entry, /Agent Harbor/);
    for (const path of [
      "/sessions",
      "/sessions/demo",
      "/skills",
      "/skills/123-abc",
      "/settings",
      "/experts",
      "/experts/new",
      "/experts/abc-123",
    ]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), entry, path);
      assert.match(response.headers.get("content-type")!, /text\/html/);
      const head = await fetch(origin + path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    for (const path of [
      "/api/skills",
      "/api/not-found",
      "/.env",
      "/src/main.ts",
      "/var/private.txt",
      "/assets/missing.js",
      "/skills/id/private.txt",
    ]) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
    assert.equal(
      (await fetch(origin + "/skills", { method: "POST" })).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
