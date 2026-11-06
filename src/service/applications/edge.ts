/** 只修改预先登记的应用路由子树；固定来源配置由安装者提供，不接受用户指定代理目标。 */
import type { AppDeployment } from "./docker.js";
import { requireAppId } from "./source-store.js";
import { request as httpRequest } from "node:http";
import { visitorOrigin, visitorPath, type VisitorAuthOptions } from "./visitor-auth/config.js";

type VisitorEdgeOptions = Pick<VisitorAuthOptions, "appDomain" | "edgeDial" | "edgeToken">;

/** Route only reserved endpoints to Harbor, then protect API requests before proxying their body. */
function protectedRoutes(deployment: AppDeployment, base: string, auth: VisitorEdgeOptions) {
  const scope = `${deployment.appId}/${deployment.environment}`;
  const forward = (uri: string, check = false, write = false) => ({
    handler: "reverse_proxy",
    upstreams: [{ dial: auth.edgeDial }],
    rewrite: { uri, ...(check ? { method: "GET" } : {}) },
    headers: { request: { set: {
      "X-Harbor-Edge-Proof": [auth.edgeToken],
      "X-Harbor-Auth-IP": ["{http.request.remote.host}"],
      ...(check ? { "X-Harbor-Visitor-Write": [write ? "1" : "0"] } : {}),
    } } },
    ...(check ? {
      handle_response: [{
        match: { status_code: [2] },
        routes: [{ handle: [{ handler: "headers", request: {
          set: { "X-App-Visitor-Assertion": ["{http.reverse_proxy.header.X-App-Visitor-Assertion}"] },
        } }] }],
      }],
    } : {}),
  });
  const checkPath = visitorPath + "/check/" + scope + "/" + deployment.id;
  const paths = [base + "api", base + "api/*"];
  const actions = ["start", "finish", "me", "logout", "embedded-session"];
  if (deployment.environment === "preview") actions.push("embedded-start", "embedded-complete");
  return [
    ...actions.map(action => ({
      match: [{ path: [base + "__harbor/auth/" + action] }],
      handle: [
        { handler: "vars", log_skip: true },
        forward(visitorPath + "/app/" + scope + "/" + action),
      ],
    })),
    { match: [{ path: paths, method: ["GET", "HEAD"] }], handle: [forward(checkPath, true)] },
    { match: [{ path: paths, not: [{ method: ["GET", "HEAD"] }] }], handle: [forward(checkPath, true, true)] },
  ];
}

function ownerRoutes(deployment: AppDeployment, base: string, auth: VisitorEdgeOptions, health: unknown[]) {
  const target = visitorPath + `/preview-access/${deployment.appId}/${deployment.id}`;
  const forward = (check: boolean, websocket = false) => ({
    handler: "reverse_proxy",
    upstreams: [{ dial: auth.edgeDial }],
    rewrite: { uri: target, ...(check ? { method: "GET" } : {}) },
    headers: { request: { set: {
      "X-Harbor-Edge-Proof": [auth.edgeToken],
      "X-Harbor-Preview-Websocket": [websocket ? "1" : "0"],
    }, ...(check ? { delete: ["Upgrade", "Connection"] } : {}) } },
    ...(check ? { handle_response: [{
      match: { status_code: [2] },
      routes: [{ handle: [{ handler: "vars", harbor_preview_allowed: true }] }],
    }] } : {}),
  });
  return [
    { match: [{ path: [base + "__harbor/health"], method: ["GET"],
      header: { "X-Harbor-Preview-Probe": [auth.edgeToken] } }], handle: health, terminal: true },
    { match: [{ path: [base + "__harbor/preview-access"], method: ["POST"] }],
      handle: [forward(false)], terminal: true },
    { group: "harbor-preview-owner", match: [{ header: { Upgrade: ["websocket"] } }],
      handle: [forward(true, true)] },
    { group: "harbor-preview-owner", handle: [forward(true)] },
  ];
}

/** 根据已校验的部署描述生成 Caddy 路由：补齐尾斜杠、代理应用端口并移除平台身份相关请求头。 */
export function applicationRoutes(
  deployments: AppDeployment[],
  upstreamHost: string,
  visitor?: VisitorEdgeOptions,
  publicOrigin?: string,
  openSandboxPort?: number,
) {
  if (!["127.0.0.1", "host.docker.internal"].includes(upstreamHost))
    throw new Error("INVALID_EDGE_UPSTREAM_HOST");
  const identities = new Set<string>();
  return deployments.flatMap((deployment) => {
    requireAppId(deployment.appId);
    requireAppId(deployment.id);
    const base = `/${deployment.environment === "preview" ? "preview" : "apps"}/${deployment.appId}/`;
    const key = deployment.appId + ":" + deployment.environment;
    if (
      !["preview", "production"].includes(deployment.environment) ||
      deployment.build.target !== deployment.environment ||
      identities.has(key) ||
      deployment.build.basePath !== base ||
      deployment.appId !== deployment.build.appId ||
      !Number.isSafeInteger(deployment.hostPort) ||
      deployment.hostPort < 1 ||
      deployment.hostPort > 65535
    )
      throw new Error("INVALID_EDGE_DEPLOYMENT");
    identities.add(key);
    const protectedApp = deployment.visitorAuth;
    if (protectedApp && (!visitor || deployment.build.visitorAuthVersion !== 1 ||
        protectedApp.origin !== visitorOrigin(visitor.appDomain, deployment.appId, deployment.environment)))
      throw new Error("APPLICATION_AUTH_EDGE_UNAVAILABLE");
    const origin = protectedApp?.origin ?? (visitor ? publicOrigin : undefined);
    const host = origin ? { host: [new URL(origin).hostname] } : {};
    const runtime = deployment.runtime;
    if (runtime) {
      requireAppId(runtime.resourceId);
      if (runtime.backendId !== "opensandbox-preview" || deployment.hostPort !== openSandboxPort ||
          upstreamHost !== "127.0.0.1" || !deployment.ownerOnly)
        throw new Error("INVALID_OPENSANDBOX_UPSTREAM");
    }
    if (deployment.ownerOnly && (!protectedApp?.previewParentOrigin || deployment.environment !== "preview" || !visitor))
      throw new Error("APPLICATION_PREVIEW_AUTH_UNAVAILABLE");
    const proxy = {
      handler: "reverse_proxy",
      upstreams: [{ dial: `${upstreamHost}:${deployment.hostPort}` }],
      ...(runtime ? { rewrite: { uri: `/v1/sandboxes/${runtime.resourceId}/proxy/3000{http.request.uri}` } } : {}),
      headers: {
        request: { delete: ["Cookie", "Authorization", "X-Harbor-*", "Open-Sandbox-Api-Key", "X-Execd-Access-Token",
          ...(!protectedApp ? ["X-App-Visitor-Assertion"] : [])] },
        response: { delete: ["Set-Cookie", "Service-Worker-Allowed", "X-App-Visitor-Assertion"] },
      },
    };
    const forward = [
      { handler: "log_append", key: "harbor_deployment", value: deployment.id },
      proxy,
    ];
    return [
      {
        match: [{ ...host, path: [base.slice(0, -1)] }],
        handle: [{
          handler: "static_response", status_code: 308,
          headers: { Location: [base] },
        }],
      },
      {
        "@id": "application-" + deployment.id,
        match: [{ ...host, path: [base + "*"] }],
        handle: protectedApp ? [{
          handler: "subroute",
          routes: [
            ...(deployment.ownerOnly ? ownerRoutes(deployment, base, visitor!, forward) : []),
            { handle: [{ handler: "headers", request: { delete: ["X-Harbor-*", "X-App-Visitor-Assertion"] } }] },
            ...protectedRoutes(deployment, base, visitor!),
            { handle: forward },
          ],
        }] : forward,
      },
    ];
  });
}

/** 通过受限 Caddy 管理入口维护平台拥有的应用路由子树，并从公开入口回读部署身份。 */
export class CaddyApplicationEdge {
  private pending = Promise.resolve();
  private readonly socketPath?: string;
  /** 校验管理入口为本机 HTTP 或指定 Unix socket，并固定公开来源、代理目标及路由子树编号。 */
  constructor(
    readonly adminOrigin: string,
    readonly publicOrigin: string,
    readonly upstreamHost = "127.0.0.1",
    readonly routeId = "harbor-application-routes",
    readonly visitor?: VisitorEdgeOptions,
    readonly openSandboxPort?: number,
  ) {
    if (adminOrigin.startsWith("unix:/"))
      this.socketPath = adminOrigin.slice(5);
    else {
      const admin = new URL(adminOrigin);
      if (
        !["127.0.0.1", "localhost"].includes(admin.hostname) ||
        admin.protocol !== "http:" ||
        admin.username ||
        admin.password
      )
        throw new Error("INVALID_EDGE_ADMIN");
    }
    if (!/^[a-z0-9-]+$/.test(routeId)) throw new Error("INVALID_EDGE_ADMIN");
  }
  /** 原生服务端请求不发送浏览器Sec-Fetch头；不通过禁用Caddy来源检查来绕过保护。 */
  private request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const input = body === undefined ? undefined : JSON.stringify(body);
      const options = {
        method,
        headers: {
          ...(input === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...headers,
        },
      };
      const target = this.socketPath
        ? { ...options, socketPath: this.socketPath, path }
        : {
            ...options,
            hostname: new URL(this.adminOrigin).hostname,
            port: new URL(this.adminOrigin).port,
            path,
          };
      const outgoing = httpRequest(target, (incoming) => {
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2 * 1024 * 1024)
            outgoing.destroy(new Error("EDGE_RESPONSE_LIMIT"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = Object.fromEntries(
            Object.entries(incoming.headers)
              .filter(
                (entry): entry is [string, string | string[]] =>
                  entry[1] !== undefined,
              )
              .map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : value,
              ]),
          );
          const status = incoming.statusCode ?? 500;
          resolve(
            new Response(
              status === 204 ? null : Buffer.concat(chunks).toString("utf8"),
              { status, headers: responseHeaders },
            ),
          );
        });
      });
      outgoing.setTimeout(10000, () =>
        outgoing.destroy(new Error("EDGE_ADMIN_TIMEOUT")),
      );
      outgoing.on("error", reject);
      outgoing.end(input);
    });
  }
  /** 读取平台拥有的实际路由子树及 ETag；返回值用于比较和有条件更新，缺失子树视为配置错误。 */
  async actual() {
    // 空routes可能被Caddy规范化省略；读取拥有@id的子树，而不是假定空数组字段仍存在。
    const response = await this.request(`/id/${this.routeId}`);
    if (!response.ok)
      throw new Error(
        "EDGE_ROUTE_SUBTREE_UNAVAILABLE: " +
          response.status +
          ": " +
          (await response.text()).slice(0, 300),
      );
    const body = (await response.json()) as {
      handler?: string;
      routes?: unknown[];
    };
    if (body.handler !== "subroute")
      throw new Error("EDGE_ROUTE_SUBTREE_MISMATCH");
    return { routes: body.routes ?? [], etag: response.headers.get("etag") };
  }
  /** 规范化实际和预期路由后比较是否一致；只核对配置，不代替应用健康检查。 */
  async matches(deployments: AppDeployment[]) {
    return (
      canonical((await this.actual()).routes) ===
      canonical(applicationRoutes(deployments, this.upstreamHost, this.visitor, this.publicOrigin, this.openSandboxPort))
    );
  }
  /** 用给定部署集合替换整棵应用路由子树并核对这些实例；单应用变更应使用 replaceEndpoint。 */
  async replace(deployments: AppDeployment[]) {
    return this.update(() => applicationRoutes(deployments, this.upstreamHost, this.visitor, this.publicOrigin, this.openSandboxPort), deployments);
  }
  /** CAS仍保护共享子树，但只替换一个端点；其他应用的未知/失效路由保持原样，不参与本次健康确认。 */
  async replaceEndpoint(appId: string, environment: "preview" | "production", deployment: AppDeployment | null) {
    requireAppId(appId);
    if (!["preview", "production"].includes(environment) ||
        (deployment && (deployment.appId !== appId || deployment.environment !== environment)))
      throw new Error("INVALID_EDGE_DEPLOYMENT");
    const base = `/${environment === "preview" ? "preview" : "apps"}/${appId}/`;
    const replacement = applicationRoutes(deployment ? [deployment] : [], this.upstreamHost, this.visitor, this.publicOrigin, this.openSandboxPort);
    return this.update(routes => [
      ...routes.filter(route => {
        const paths = (route as { match?: { path?: string[] }[] })?.match;
        return !paths?.some(match => match.path?.some(path => path === base.slice(0, -1) || path === base + "*"));
      }),
      ...replacement,
    ], deployment ? [deployment] : []);
  }
  /** Keep legacy public apps on the management host before serving any login-enabled origin. */
  private scopeLegacyRoutes(routes: unknown[]) {
    const publicHost = new URL(this.publicOrigin).hostname;
    return routes.map(route => {
      const current = route as { match?: { path?: string[]; host?: string[] }[] };
      if (!current.match?.some(match => match.path && !match.host)) return route;
      return { ...current, match: current.match.map(match =>
        match.path && !match.host ? { ...match, host: [publicHost] } : match) };
    });
  }
  /** 串行读取路由并用 ETag 有条件更新，冲突时重读重试；回读配置及目标健康身份后才确认成功。 */
  private async update(routesFor: (routes: unknown[]) => unknown[], verify: AppDeployment[]) {
    const before = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const actual = await this.actual();
        const routes = routesFor(this.visitor ? this.scopeLegacyRoutes(actual.routes) : actual.routes);
        if (!actual.etag) throw new Error("EDGE_ETAG_REQUIRED");
        const response = await this.request(
          `/id/${this.routeId}`,
          "PATCH",
          { "@id": this.routeId, handler: "subroute", routes },
          { "If-Match": actual.etag },
        );
        if (response.status === 412) continue;
        if (!response.ok) {
          const details = await response.text();
          const safe = this.visitor ? details.replaceAll(this.visitor.edgeToken, "[redacted]") : details;
          throw new Error("EDGE_UPDATE_FAILED: " + safe.slice(0, 500));
        }
        const observed = await this.actual();
        if (canonical(observed.routes) !== canonical(routes))
          throw new Error("EDGE_UPDATE_UNCONFIRMED");
        for (const deployment of verify) {
          const health = await fetch(
            (deployment.visitorAuth?.origin ?? this.publicOrigin) + deployment.build.basePath + "__harbor/health",
            { signal: AbortSignal.timeout(5000), redirect: "error",
              ...(deployment.ownerOnly ? { headers: { "X-Harbor-Preview-Probe": this.visitor!.edgeToken } } : {}) },
          );
          if (!health.ok) throw new Error("EDGE_DEPLOYMENT_UNCONFIRMED:HTTP_" + health.status);
          const body = (await health.json().catch(() => null)) as { deploymentId?: string; visitorAuthVersion?: number } | null;
          if (body?.deploymentId !== deployment.id || (deployment.visitorAuth && body.visitorAuthVersion !== 1))
            throw new Error("EDGE_DEPLOYMENT_UNCONFIRMED");
        }
        return;
      }
      throw new Error("EDGE_UPDATE_CONFLICT");
    } finally {
      release();
    }
  }
}

/** 递归排序对象键并保留数组顺序，生成稳定表示，避免仅因 JSON 键顺序不同误判路由变化。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
