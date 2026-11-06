import { testDatabase } from "../dist/tests/pg.js";
/** 隔离网页验收：独立PG schema与数据目录，不触碰4318现有用户数据。 */
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Controller } from "../dist/src/runtime/controller.js";
import { ServiceStore } from "../dist/src/service/service-store.js";
import { SessionManager } from "../dist/src/service/session-manager.js";
import { createApi } from "../dist/src/service/http-api.js";
import { tokenHash } from "../dist/src/service/auth.js";
import { McpService } from "../dist/src/service/mcp/service.js";
import { McpNetwork } from "../dist/src/service/mcp/network.js";
import { loadLocalTemplates } from "../dist/src/service/mcp/templates.js";
const database = await testDatabase(),
  root = resolve("var/mcp-preview");
await mkdir(root, { recursive: true });
const controller = new Controller(root),
  manager = new SessionManager(
    new ServiceStore(database.db),
    controller,
    "PREVIEW_ONLY",
  );
await manager.identity.importKeys([
  { userId: "preview-user", tokenHash: tokenHash("mcp-preview-only") },
]);
const templates = await loadLocalTemplates(),
  service = new McpService(
    database.db,
    join(root, ".service"),
    new McpNetwork(),
    templates,
  );
const server = createApi(
  manager,
  controller,
  undefined,
  {},
  undefined,
  service,
);
await new Promise((r) => server.listen(4322, "127.0.0.1", r));
console.log("MCP preview ready: http://127.0.0.1:4322/mcp");
process.on(
  "SIGTERM",
  () =>
    void (async () => {
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await database.close();
      process.exit(0);
    })(),
);
