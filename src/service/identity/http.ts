/** 登录/本人账户/管理接口。它不直接调用Docker，停止仍交给SessionManager。 */
import type { IncomingMessage } from "node:http";
import { Router, type RequestHandler } from "express";
import { jsonBody, jsonInput, parameter, principal } from "../http/shared.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { BrowserSessions, requireBrowserOrigin } from "../browser-sessions.js";
import { fail, ServiceError } from "../types.js";
import { parseLimits } from "../limits/policy.js";
import { WorkbenchAuth, workbenchIssuer } from "./workbench.js";
import { OidcLogin, type OidcSettings } from "./oidc.js";
export interface IdentityOptions {
  origin?: string;
  workbenchOrigin?: string;
  oidc?: OidcSettings;
  workbenchAuth?: WorkbenchAuth;
  adminUsers?: string[];
  keyLogin?: boolean;
}
export class IdentityHttp {
  readonly browsers: BrowserSessions;
  readonly oidc?: OidcLogin;
  private watchers = new Map<
    string,
    { userId: string; token: string; abort: AbortController }
  >();
  private workbenchSessions = new Map<string, {
    userId: string; subject: string; abort: AbortController;
  }>();
  private timer: ReturnType<typeof setInterval>;
  private checking = false;
  private readonly workbench?: URL;
  constructor(
    private manager: SessionManager,
    private files: WorkspaceFiles,
    readonly options: IdentityOptions = {},
  ) {
    this.workbench = options.workbenchOrigin ? new URL(options.workbenchOrigin) : undefined;
    this.browsers = new BrowserSessions(manager.identity, options.origin, undefined, this.workbench);
    if (options.oidc) this.oidc = new OidcLogin(options.oidc);
    // 已连接的Bearer SSE也必须响应到期/撤销，不能只验证握手那一次。
    this.timer = setInterval(() => {
      void this.expireCredentials();
    }, 1000);
    this.timer.unref();
  }
  /** 每秒核对一次已连接的密钥；上一次未结束时跳过，避免慢查询叠加。 */
  private async expireCredentials() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const [id, watch] of this.watchers) {
        try {
          await this.manager.identity.key(watch.token);
        } catch {
          watch.abort.abort();
          this.watchers.delete(id);
        }
      }
      for (const [id, watch] of this.workbenchSessions) {
        try {
          if (!await this.options.workbenchAuth!.sessionActive(id, watch.subject)) this.disconnectWorkbench(id);
        } catch {
          this.disconnectWorkbench(id);
        }
      }
    } finally {
      this.checking = false;
    }
  }
  close() {
    clearInterval(this.timer);
    this.browsers.close();
    for (const watch of this.watchers.values()) watch.abort.abort();
    this.watchers.clear();
    for (const id of this.workbenchSessions.keys()) this.disconnectWorkbench(id);
  }
  origin(request: IncomingMessage) {
    if (this.workbench && this.workbench.host === request.headers.host) return this.workbench.origin;
    return this.options.origin ?? `http://${request.headers.host}`;
  }
  private disconnectWorkbench(id: string) {
    this.workbenchSessions.get(id)?.abort.abort();
    this.workbenchSessions.delete(id);
  }
  private async logoutWorkbench(request: IncomingMessage) {
    const auth = this.options.workbenchAuth;
    if (!auth?.hasCookie(request)) return [];
    const session = await auth.session(request);
    const cookies = await auth.logout(request);
    if (session) this.disconnectWorkbench(session.session.id);
    return cookies;
  }
  async principal(request: IncomingMessage) {
    if (!request.headers.authorization) {
      const auth = this.options.workbenchAuth;
      if (!auth?.hasCookie(request)) return this.browsers.user(request);
      const value = await auth.session(request);
      if (!value) fail(401, "UNAUTHORIZED");
      const user = await this.manager.identity.external(workbenchIssuer, value.user.id, value.user.name);
      if (!await auth.sessionActive(value.session.id, value.user.id)) fail(401, "UNAUTHORIZED");
      let watch = this.workbenchSessions.get(value.session.id);
      if (!watch) {
        watch = { userId: user.id, subject: value.user.id, abort: new AbortController() };
        this.workbenchSessions.set(value.session.id, watch);
      }
      return { userId: user.id, signal: watch.abort.signal };
    }
    const token = request.headers.authorization.match(/^Bearer (\S+)$/)?.[1];
    if (!token) fail(401, "UNAUTHORIZED");
    const { userId, keyId } = await this.manager.identity.key(token);
    let watch = this.watchers.get(keyId);
    if (!watch) {
      watch = { userId, token, abort: new AbortController() };
      this.watchers.set(keyId, watch);
    }
    return { userId, signal: watch.abort.signal };
  }

  /**
   * 登录入口在“要求已登录”中间件之前挂载。
   * Cookie写操作仍先做Origin/客户端头检查，再解析正文；OIDC GET回调保持原握手规则。
   */
  publicRouter() {
    const router = Router({ caseSensitive: true });
    const browserWrite: RequestHandler = (request, _response, next) => {
      requireBrowserOrigin(request, this.origin(request));
      next();
    };
    router.get("/auth/config", (_request, response) => {
      response.json({
        oidc: !!this.oidc,
        keyLogin: this.options.keyLogin !== false,
        ...(this.options.workbenchAuth && {
          passwordLogin: true,
          registration: this.options.workbenchAuth.settings.registration,
        }),
      });
    });
    router.get("/auth/oidc/start", async (_request, response) => {
      if (!this.oidc) fail(404, "LOGIN_NOT_CONFIGURED");
      try {
        await this.oidc.start(response);
      } catch {
        fail(503, "LOGIN_UNAVAILABLE");
      }
    });
    router.get("/auth/oidc/callback", async (request, response) => {
      if (!this.oidc) fail(404, "LOGIN_NOT_CONFIGURED");
      try {
        const identity = await this.oidc.callback(
          request,
          response,
          request.originalUrl,
        );
        const user = await this.manager.identity.external(
          identity.issuer,
          identity.subject,
          identity.name,
        );
        const cookies = await this.logoutWorkbench(request);
        await this.browsers.login(request, response, user.id);
        if (cookies.length) response.appendHeader("Set-Cookie", cookies);
        response.writeHead(303, {
          Location: "/",
          "Referrer-Policy": "no-referrer",
        });
        response.end();
      } catch {
        // code/token或供应商个人资料不能进入日志和错误页面。
        response.writeHead(303, {
          Location: "/?login=failed",
          "Referrer-Policy": "no-referrer",
        });
        response.end();
      }
    });
    const passwordLogin = (register: boolean): RequestHandler => async (request, response) => {
      const auth = this.options.workbenchAuth;
      if (!auth) fail(404, "LOGIN_NOT_CONFIGURED");
      const { user, cookies } = await auth.credentials(request, jsonInput(request), register);
      try {
        await this.manager.identity.external(workbenchIssuer, user.id, user.name);
      } catch (error) {
        if (error instanceof ServiceError && error.code === "ACCOUNT_DISABLED") fail(401, "WORKBENCH_LOGIN_FAILED");
        throw error;
      }
      const previousCookies = await this.logoutWorkbench(request);
      await this.browsers.logout(request, response);
      response.appendHeader("Set-Cookie", [...previousCookies, ...cookies]);
      response.json({ signedIn: true });
    };
    router.post("/auth/register", browserWrite, ...jsonBody(4096), passwordLogin(true));
    router.post("/auth/password", browserWrite, ...jsonBody(4096), passwordLogin(false));
    router.post(
      "/auth/login",
      browserWrite,
      ...jsonBody(),
      async (request, response) => {
        if (this.options.keyLogin === false) fail(403, "KEY_LOGIN_DISABLED");
        const input = jsonInput(request);
        if (typeof input.accessKey !== "string")
          fail(400, "INVALID_ACCESS_KEY");
        const { userId } = await this.manager.identity.key(input.accessKey);
        const cookies = await this.logoutWorkbench(request);
        await this.browsers.login(request, response, userId);
        if (cookies.length) response.appendHeader("Set-Cookie", cookies);
        response.json({ userId });
      },
    );
    router.post("/auth/logout", browserWrite, async (request, response) => {
      const cookies = await this.logoutWorkbench(request);
      await this.browsers.logout(request, response);
      if (cookies.length) response.appendHeader("Set-Cookie", cookies);
      response.json({ signedOut: true });
    });
    return router;
  }

  /** 本人和管理员接口在统一认证之后挂载，真实身份只读response.locals.principal。 */
  accountRouter() {
    const router = Router({ caseSensitive: true });
    router.get("/auth/me", (_request, response) => {
      response.json({
        userId: principal(response).userId,
        capabilities: {
          managePlatform:
            this.options.adminUsers?.includes(principal(response).userId) ??
            false,
        },
      });
    });
    router.get("/account", async (_request, response) => {
      const { userId } = principal(response);
      const user = await this.manager.identity.require(userId);
      const owned = await this.manager.store.sessions(
        userId,
        Number.MAX_SAFE_INTEGER,
      );
      const workspaceBytes = await this.files.bytes(
        owned.map((session) => session.id),
        AbortSignal.timeout(15_000),
      );
      // 扫描可能耗时，结束后再核对账号是否已被停用。
      await this.manager.identity.require(userId);
      response.json({
        user: { id: user.id, name: user.name },
        limits: await this.manager.identity.policy(userId),
        counts: await this.manager.counts(userId),
        workspaceBytes,
        usage: await this.manager.usage.summary(userId),
        messages: await this.manager.store.messageCount(userId),
        messageQuota: await this.manager.store.messageQuota(userId),
      });
    });
    router.get("/account/keys", async (_request, response) => {
      response.json(
        await this.manager.identity.keys(principal(response).userId),
      );
    });
    router.post("/account/keys", ...jsonBody(), async (request, response) => {
      const { name } = jsonInput(request);
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        fail(400, "INVALID_KEY_NAME");
      response
        .status(201)
        .json(
          await this.manager.identity.createKey(
            principal(response).userId,
            name,
          ),
        );
    });
    router.delete("/account/keys/:keyId", async (request, response) => {
      const keyId = parameter(request, "keyId");
      await this.manager.identity.revokeKey(principal(response).userId, keyId);
      this.watchers.get(keyId)?.abort.abort();
      this.watchers.delete(keyId);
      response.json({ revoked: true });
    });

    // 管理员检查放在路径前缀上，也保护尚不存在的/admin子路径。
    router.use("/admin", (_request, response, next) => {
      if (!this.options.adminUsers?.includes(principal(response).userId))
        fail(403, "ADMIN_REQUIRED");
      next();
    });
    router.get("/admin/users", async (_request, response) => {
      response.json(
        await Promise.all(
          (await this.manager.identity.users()).map(async (user) => ({
            ...user,
            messageQuota: await this.manager.store.messageQuota(user.id),
          })),
        ),
      );
    });
    router.patch(
      "/admin/users/:userId",
      ...jsonBody(),
      async (request, response) => {
        const operator = principal(response).userId;
        const id = parameter(request, "userId");
        const input = jsonInput(request);
        await this.manager.identity.require(operator);
        if (
          !Object.keys(input).length ||
          Object.keys(input).some(
            (key) => !["disabled", "limits"].includes(key),
          )
        )
          fail(400, "INVALID_USER_UPDATE");
        if (input.disabled !== undefined && typeof input.disabled !== "boolean")
          fail(400, "INVALID_USER_UPDATE");
        if (id === operator && input.disabled === true)
          fail(409, "CANNOT_DISABLE_SELF");
        await this.manager.identity.update(id, {
          disabled: input.disabled as boolean | undefined,
          limits:
            input.limits === undefined ? undefined : parseLimits(input.limits),
        });
        if (input.disabled === true) {
          this.browsers.revokeUser(id);
          for (const [sessionId, watch] of this.workbenchSessions)
            if (watch.userId === id) this.disconnectWorkbench(sessionId);
          for (const [key, watch] of this.watchers)
            if (watch.userId === id) {
              watch.abort.abort();
              this.watchers.delete(key);
            }
          await this.manager.closeUser(id);
        }
        response.json({ updated: true });
      },
    );
    return router;
  }
}
