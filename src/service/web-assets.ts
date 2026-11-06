/** 只服务构建后的网页资源，不把源码根、运行目录或.env作为静态目录暴露。 */
import { Router } from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const root = fileURLToPath(new URL("../../web/", import.meta.url));
export async function serveWeb(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  previewSources = "",
  authFrameSource = "",
) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const page =
    path === "/" ||
    /^\/(?:sessions|skills|experts|applications)(?:\/[a-zA-Z0-9_-]+)?\/?$/.test(
      path,
    ) ||
    /^\/admin(?:\/(?:models|users|billing|requests|operations|activity|usage|audit))?\/?$/.test(path) ||
    /^\/settings\/(?:account|keys|appearance|about)\/?$/.test(path) ||
    path === "/settings" ||
    path === "/models" ||
    path === "/models/setup" ||
    path === "/mcp";
  const file = page
    ? "index.html"
    : path.startsWith("/assets/")
      ? path.slice(1)
      : undefined;
  if (
    !file ||
    (file !== "index.html" && !/^assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(file))
  )
    return false;
  try {
    const content = await readFile(join(root, file));
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    response.writeHead(200, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Chakra/Emotion动态生成样式；只开放inline样式，脚本仍仅允许同源构建文件。
      "Content-Security-Policy":
        `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${previewSources}; frame-src 'self' http://127.0.0.1:*${previewSources}${authFrameSource}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 路由匹配由Express完成；serveWeb只按白名单读取构建资源，保留CSP与HEAD响应。 */
export function createWebRouter(visitor?: { workbenchOrigin?: string; embeddedAuthOrigin?: string; appDomain: string }) {
  const workbenchHost = visitor?.workbenchOrigin ? new URL(visitor.workbenchOrigin).host : undefined;
  const sources = workbenchHost ? ` https://*.${visitor!.appDomain}` : "";
  const authSource = visitor?.embeddedAuthOrigin ? ` ${new URL(visitor.embeddedAuthOrigin).origin}` : "";
  const router = Router({ caseSensitive: true });
  const pages = [
    "/",
    "/admin",
    "/admin/models",
    "/admin/users",
    "/admin/billing",
    "/admin/requests",
    "/admin/operations",
    "/admin/activity",
    "/admin/usage",
    "/admin/audit",
    "/settings/account",
    "/settings/keys",
    "/settings/appearance",
    "/settings/about",
    "/settings",
    "/mcp",
    "/models",
    "/models/setup",
    "/sessions",
    "/sessions/:id",
    "/skills",
    "/skills/:id",
    "/experts",
    "/experts/:id",
    "/applications",
    "/applications/:id",
  ];
  const render = async (
    request: import("express").Request,
    response: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    const path = new URL(request.originalUrl, "http://localhost").pathname;
    const workbench = !!workbenchHost && workbenchHost === request.headers.host;
    if (!(await serveWeb(request, response, path, workbench ? sources : "", workbench ? authSource : ""))) next();
  };
  router.get(pages, render);
  router.get(/^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/, render);
  return router;
}
