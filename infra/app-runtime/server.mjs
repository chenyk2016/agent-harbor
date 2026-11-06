/** 固定应用入口：健康检查、受控CRUD、静态资源、源码业务路由均在独立应用容器内。 */
import express from "express";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { observations } from "./harbor-observe.mjs";
import { register } from "./server/index.mjs";

const configuration = JSON.parse(
  await readFile("/run/harbor-app.json", "utf8"),
);
const manifest = JSON.parse(await readFile("/app/harbor-app.json", "utf8"));
const pool = new Pool({
  connectionString: configuration.databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5000,
  options:
    "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
});
pool.on("error", (error) => console.error("APP_DATABASE_ERROR", error.code));
const app = express();
app.disable("x-powered-by");
const router = express.Router({ caseSensitive: true });
const observe = observations(configuration, manifest, pool);
const publicIdentity = observe.identity;
// 只有平台签发的测试部署配置能指定工作台，应用源码无权放开嵌入边界。
const frameParent = configuration.environment === "preview" && configuration.visitorAuth?.previewParentOrigin
  ? " " + new URL(configuration.visitorAuth.previewParentOrigin).origin : "";
// 健康检查既验证数据库可连，也返回固定部署身份，供平台核对端口指向。
router.get("/__harbor/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ ...publicIdentity, ...(configuration.visitorAuth ? { visitorAuthVersion: 1 } : {}) });
  } catch {
    response.status(503).json({ error: "APP_DATA_UNAVAILABLE" });
  }
});
router.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'${frameParent}; form-action 'self'; worker-src 'none'`,
  );
  response.setHeader("Cache-Control", "no-store");
  next();
});
/** A protected container rejects direct and forged API requests, even behind the private network. */
const visitorKey = configuration.visitorAuth
  ? createPublicKey({ key: Buffer.from(configuration.visitorAuth.publicKey, "base64"), format: "der", type: "spki" })
  : undefined;
router.use("/api", (request, response, next) => {
  const assertion = request.get("X-App-Visitor-Assertion");
  delete request.headers["x-app-visitor-assertion"];
  if (!visitorKey) return next();
  try {
    if (typeof assertion !== "string" || !/^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{86}$/.test(assertion))
      throw Error("Invalid visitor assertion");
    const [body, signature] = assertion.split(".");
    if (!verify(null, Buffer.from(body), visitorKey, Buffer.from(signature, "base64url")))
      throw Error("Invalid visitor signature");
    const visitor = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (visitor.appId !== configuration.appId || visitor.environment !== configuration.environment ||
        visitor.deploymentId !== configuration.deploymentId || typeof visitor.userId !== "string" ||
        !Number.isSafeInteger(visitor.expires) || visitor.expires <= Date.now())
      throw Error("Invalid visitor scope");
    request.harborUser = { id: visitor.userId };
  } catch {
    return response.status(401).json({ error: "APPLICATION_AUTH_REQUIRED" });
  }
  next();
});

observe.mount(router);
router.use(observe.requests);
router.use("/api", express.json({ limit: "16kb", strict: true }));
// 此内存窗口限制单实例 API 请求频率；写请求还必须携带本实例的源码版本。
const requests = new Map();
router.use("/api", (request, response, next) => {
  const key = request.ip,
    now = Date.now();
  if (requests.size > 2000)
    for (const [id, entry] of requests)
      if (now - entry.time > 60000) requests.delete(id);
  const entry = requests.get(key);
  if (entry && now - entry.time < 60000 && ++entry.count > 120)
    return response.status(429).json({ error: "RATE_LIMIT" });
  if (!entry || now - entry.time >= 60000)
    requests.set(key, { count: 1, time: now });
  if (
    !["GET", "HEAD"].includes(request.method) &&
    request.get("X-App-Revision") !== configuration.revisionId
  )
    return response.status(409).json({ error: "APP_VERSION_CHANGED" });
  next();
});
/** 只解析 manifest 已声明且名称合法的表，公开接口不能选择任意数据库表。 */
const tableName = (name) => {
  if (
    manifest.formatVersion !== 1 ||
    !Object.hasOwn(manifest.tables, name) ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(name)
  )
    return undefined;
  return manifest.tables[name];
};
// 通用公开读接口：仅允许 publicRead 表，最多返回最近 100 条。
router.get("/api/tables/:table", async (request, response) => {
  const table = tableName(request.params.table);
  if (!table) return response.status(404).json({ error: "TABLE_NOT_FOUND" });
  if (!table.publicRead)
    return response.status(403).json({ error: "DATA_READ_DENIED" });
  const result = await pool.query(
    `SELECT * FROM "${request.params.table}" ORDER BY created_at DESC,id DESC LIMIT 100`,
  );
  response.json({ rows: result.rows });
});
// 通用公开写接口：检查 publicCreate 和字段类型，业务写入与成功观测事件在同一事务提交。
router.post("/api/tables/:table", async (request, response) => {
  const table = tableName(request.params.table);
  if (!table) return response.status(404).json({ error: "TABLE_NOT_FOUND" });
  if (!table.publicCreate)
    return response.status(403).json({ error: "DATA_CREATE_DENIED" });
  const body = request.body;
  if (!body || Array.isArray(body) || typeof body !== "object")
    return response.status(400).json({ error: "INVALID_DATA" });
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !Object.hasOwn(table.fields, key)))
    return response.status(400).json({ error: "INVALID_FIELDS" });
  for (const key of keys) {
    const field = table.fields[key],
      value = body[key];
    if (value === null) continue;
    const valid =
      field.type === "text"
        ? typeof value === "string" &&
          value.length <= (field.maxLength ?? 10000)
        : field.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : field.type === "boolean"
            ? typeof value === "boolean"
            : typeof value === "string" &&
              value.length <= 40 &&
              Number.isFinite(Date.parse(value));
    if (!valid)
      return response.status(400).json({ error: "INVALID_FIELD_VALUE" });
  }
  const id = randomUUID(),
    values = [id, ...keys.map((key) => body[key])];
  await observe.transaction(async (client, emit) => {
    await client.query(
      `INSERT INTO "${request.params.table}" (id,${keys.map((key) => `"${key}"`).join(",")}) VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})`,
      values,
    );
    for (const [name, definition] of Object.entries(
      manifest.analytics?.events ?? {},
    ))
      if (
        definition.binding?.kind === "table_created" &&
        definition.binding.table === request.params.table
      )
        await emit(name, {}, observe.context(request));
  });
  response.status(201).json({ id, requestId: request.harborRequestId });
});
// 接入 Agent 修改的业务路由；应用不自行监听，也不接收控制面或模型凭据。
register(router, {
  ...publicIdentity,
  analytics: { transaction: observe.transaction, context: observe.context },
});
router.use("/api", (_request, response) =>
  response.status(404).json({ error: "API_NOT_FOUND" }),
);
router.use(
  express.static("/app/site", {
    index: false,
    dotfiles: "deny",
    redirect: false,
  }),
);
router.get(/.*/, (request, response) => {
  // 缺失资源必须404，SPA页面才返回index。
  if (
    request.path.includes("/assets/") ||
    /\.[a-z0-9]{1,8}$/i.test(request.path)
  )
    return response.status(404).end();
  response.sendFile("/app/site/index.html");
});
app.use(configuration.basePath, router);
app.use((_request, response) =>
  response.status(404).json({ error: "APP_PATH_NOT_FOUND" }),
);
app.use((error, _request, response, _next) => {
  const status =
    error.type === "entity.too.large"
      ? 413
      : error instanceof SyntaxError
        ? 400
        : 500;
  console.error("APP_REQUEST_ERROR", error.code ?? error.type ?? "unknown");
  response
    .status(status)
    .json({ error: status === 500 ? "APP_REQUEST_FAILED" : "INVALID_REQUEST" });
});
const server = app.listen(3000, "0.0.0.0");
/** 收到进程退出信号时停止接收 HTTP，关闭观测和数据连接池；不删除业务数据。 */
async function close() {
  server.close();
  await observe.close();
  await pool.end();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
