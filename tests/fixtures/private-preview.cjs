/** Fixed application used by both preview backends. */
const { createServer } = require("node:http");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { Pool } = require("pg");

const { deploymentId, buildId, basePath, databaseUrl } = JSON.parse(
  readFileSync("/run/harbor-app.json", "utf8"),
);
const db = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
const server = createServer(async (req, res) => {
  if (req.headers.cookie || req.headers.authorization || req.headers["open-sandbox-api-key"]) {
    res.writeHead(500).end("Credential reached app");
    return;
  }
  try {
    switch (req.url) {
      case basePath + "__harbor/health":
        await db.query("select 1");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ deploymentId, buildId }));
        break;
      case basePath + "value": {
        const sql = req.method === "POST"
          ? "update preview_probe set value = value + 1 returning value"
          : "select value from preview_probe";
        res.end(String((await db.query(sql)).rows[0].value));
        break;
      }
      case basePath + "asset.js":
        res.setHeader("Content-Type", "text/javascript");
        res.end("globalThis.previewAsset = true;");
        break;
      case basePath:
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.end(`<!doctype html><title>Private preview</title><script src="${basePath}asset.js"></script>`);
        break;
      default:
        res.writeHead(404).end();
    }
  } catch {
    res.writeHead(503).end("Database unavailable");
  }
});
server.on("upgrade", (req, socket) => {
  if (req.url !== basePath + "socket" || !req.headers["sec-websocket-key"] ||
      req.headers.cookie || req.headers.authorization || req.headers["open-sandbox-api-key"]) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from("ok")]));
  socket.on("error", () => {});
  socket.on("data", () => socket.end());
});
server.listen(3000, "0.0.0.0");
