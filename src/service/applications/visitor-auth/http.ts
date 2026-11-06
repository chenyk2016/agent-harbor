import type { VisitorProvider } from "./policy.js";
import { timingSafeEqual } from "node:crypto";
import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import {
  jsonBody,
  jsonInput,
  parameter,
  principal,
} from "../../http/shared.js";
import { fail, ServiceError } from "../../types.js";
import { ownerPreviewCookie, ownerPreviewSeconds, type PreviewAccess } from "../preview-access.js";
import type { ApplicationService } from "../service.js";
import type { AppEnvironment } from "../data.js";
import { requireAppId } from "../source-store.js";
import { visitorPath } from "./config.js";
import {
  appFlowCookie,
  authFlowCookie,
  randomToken,
  sessionCookie,
  sessionSeconds,
  type VisitorAuthService,
} from "./service.js";

function environment(input: string): AppEnvironment {
  if (input !== "preview" && input !== "production")
    fail(400, "INVALID_APP_ENVIRONMENT");
  return input;
}

function token(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,256}$/.test(value))
    fail(400, "APPLICATION_AUTH_LINK_INVALID");
  return value;
}

function cookie(request: Request, name: string) {
  const value = request
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);
  return value && /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : undefined;
}

function setCookie(
  response: Response,
  name: string,
  value: string,
  seconds: number,
) {
  response.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`,
  );
}

function origin(request: Request, expected: string) {
  if (request.get("origin") !== expected) fail(403, "ORIGIN_DENIED");
}

function redirect(response: Response, path: string) {
  response.status(303).setHeader("Location", path);
  response.end();
}

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

const visitorCsp =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** 服务端渲染统一登录页，登录与注册通过同一条短时流程切换。 */
function signInPage(
  response: Response,
  flow: string,
  context: { origin: string; providers: readonly VisitorProvider[]; workbenchReturnOrigin?: string },
  mode: "password" | "register",
  message = "",
  status = 200,
) {
  const passwordEnabled = context.providers.includes("email_password");
  const googleEnabled = context.providers.includes("google");
  const registering = passwordEnabled && mode === "register";
  const title = registering ? "创建账号" : "登录";
  const hiddenFlow = `<input type="hidden" name="flow" value="${escape(flow)}">`;
  const switchUrl = `${visitorPath}/login?flow=${encodeURIComponent(flow)}${registering ? "" : "&amp;mode=register"}`;

  // Chrome checks the final destination of a form redirect against form-action.
  const destinations = [
    passwordEnabled && new URL(context.origin).origin,
    googleEnabled && "https://accounts.google.com",
    context.workbenchReturnOrigin,
  ].filter(Boolean);
  response
    .status(status)
    .set("Content-Security-Policy", [visitorCsp, ...destinations].join(" "))
    // Preserve Origin for same-origin form POSTs without sending a referrer to Google.
    .set("Referrer-Policy", "same-origin")
    .type("html")
    .send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agent Harbor</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center;
    padding: 28px 16px; background: #f2f5f7; color: #172632;
    font: 16px/1.5 system-ui, sans-serif;
  }
  main {
    width: min(100%, 420px); padding: 32px; border: 1px solid #dce4e9; border-radius: 24px;
    background: #fff; box-shadow: 0 12px 40px #17324612;
  }
  header { margin-bottom: 24px; }
  .mark {
    width: 40px; height: 40px; display: grid; place-items: center; border-radius: 12px;
    background: #e6f1ef; color: #145c51; margin-bottom: 14px;
  }
  h1 { margin: 0; font-size: 28px; line-height: 1.25; }
  .intro, .switch { color: #495d69; font-size: 14px; margin: 8px 0 0; }
  form { display: grid; gap: 14px; margin: 0; }
  label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }
  input:not([type=hidden]), button {
    width: 100%; min-height: 44px; padding: 9px 12px; border: 1px solid #bac8d0;
    border-radius: 10px; font: inherit; color: inherit; background: #fff;
  }
  button { font-weight: 650; cursor: pointer; }
  button:hover { background: #f3f6f8; }
  button.primary { background: #145c51; border-color: #145c51; color: #fff; }
  button.primary:hover { background: #104a42; }
  :focus-visible { outline: 3px solid #397e8b; outline-offset: 3px; }
  .divider {
    display: flex; align-items: center; gap: 12px; margin: 16px 0;
    font-size: 13px; color: #495d69;
  }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #dce4e9; }
  .switch { text-align: center; margin-top: 20px; }
  a { color: #145c51; font-weight: 650; text-underline-offset: 3px; }
  .notice {
    margin: 0 0 16px; padding: 10px 12px; border-radius: 8px;
    background: #fff0ed; color: #8e3324; font-size: 14px;
  }
  @media (max-width: 420px) { main { padding: 24px; border-radius: 18px; } }
</style>
</head>
<body>
<main>
  <header>
    <span class="mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>
      </svg>
    </span>
    <h1>${title}</h1>
    <p class="intro">${registering ? "使用邮箱和密码创建账号。" : "登录后继续访问。"}</p>
  </header>
  ${message ? `<p class="notice" role="alert">${escape(message)}</p>` : ""}
  ${passwordEnabled ? `<form action="${visitorPath}/${registering ? "register" : "password"}" method="post">
    ${hiddenFlow}
    <label>邮箱<input name="email" type="email" autocomplete="username" required maxlength="254"></label>
    <label>${registering ? "设置密码" : "密码"}<input name="password" type="password"
      autocomplete="${registering ? "new-password" : "current-password"}" ${registering ? 'minlength="8"' : ""} required maxlength="72"></label>
    <button type="submit" class="primary">${registering ? "注册并登录" : "登录"}</button>
  </form>` : ""}
  ${passwordEnabled && googleEnabled ? '<div class="divider" aria-hidden="true">或</div>' : ""}
  ${googleEnabled ? `<form action="${visitorPath}/google" method="post">
    ${hiddenFlow}
    <button type="submit">使用 Google 登录</button>
  </form>` : ""}
  ${passwordEnabled ? `<p class="switch">${registering ? "已有账号？" : "还没有账号？"}
    <a href="${switchUrl}">${registering ? "返回登录" : "创建账号"}</a>
  </p>` : ""}
</main>
</body>
</html>`);
}

/** Keep redirects inside the deployment's registered path and origin. */
export function visitorReturnPath(value: unknown, base: string) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith(base) ||
    /[\\\x00-\x20]|%2f|%5c|%0[ad]/i.test(value)
  )
    return base;
  const url = new URL(value, "https://app.invalid");
  return url.origin === "https://app.invalid" &&
    url.pathname.startsWith(base) &&
    !url.pathname.startsWith(base + "__harbor/")
    ? url.pathname + url.search
    : base;
}

/** Keep provider responses, SQL bindings, and submitted credentials out of error logs. */
const visitorErrors: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  request.resume();
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof ServiceError) {
    response.status(error.status).json({ error: error.code });
    return;
  }
  const type = (error as { type?: string })?.type;
  if (type === "entity.too.large" || type === "parameters.too.many") {
    response.status(413).json({ error: "BODY_TOO_LARGE" });
    return;
  }
  response.status(503).json({ error: "APPLICATION_AUTH_UNAVAILABLE" });
};

/** These routes have their own host and session boundary, separate from the management API. */
export function createVisitorRouter(service: VisitorAuthService, ownerPreview?: PreviewAccess) {
  const router = Router({ caseSensitive: true });
  const authHost = new URL(service.options.authOrigin).host;
  router.use((_request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": visitorCsp,
    });
    const supplied = Buffer.from(_request.get("x-harbor-edge-proof") ?? "");
    const expected = Buffer.from(service.options.edgeToken);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      fail(404, "NOT_FOUND");
    next();
  });
  const authHostOnly = (request: Request) => {
    if (request.get("host") !== authHost) fail(404, "NOT_FOUND");
  };
  const incoming = (request: Request) =>
    service.live(
      requireAppId(parameter(request, "id")),
      environment(parameter(request, "env")),
      request.get("host") ?? "",
    );

  const limits = new Map<string, { count: number; until: number }>();
  function limit(key: string, maximum: number) {
    const now = Date.now();
    if (limits.size > 5000) {
      for (const [item, state] of limits)
        if (state.until <= now) limits.delete(item);
      if (limits.size > 5000) fail(429, "APPLICATION_AUTH_RATE_LIMIT");
    }
    let state = limits.get(key);
    if (!state || state.until <= now) {
      state = { count: 0, until: now + 60000 };
      limits.set(key, state);
    }
    if (++state.count > maximum) fail(429, "APPLICATION_AUTH_RATE_LIMIT");
  }

  const sourceIP = (request: Request) =>
    request.get("x-harbor-auth-ip") ||
    request.socket.remoteAddress ||
    "unknown";

  const previewReturn = (appId: string, environment: AppEnvironment) =>
    environment === "preview" && service.options.workbenchOrigin
      ? service.options.workbenchOrigin + "/applications/" + appId : undefined;

  router.get("/app/:id/:env/start", async (request, response) => {
    const scope = await incoming(request);
    limit("start:" + scope.id + ":" + sourceIP(request), 60);
    const browser = cookie(request, appFlowCookie) ?? randomToken();
    // 登录后的工作台地址只从平台配置和已验证的应用编号生成。
    const workbench = previewReturn(scope.app_id, scope.environment);
    const returnPath = workbench && request.query.workbench === "1"
      ? workbench
      : visitorReturnPath(request.query.return, service.base(scope));
    const flow = await service.start(scope, browser, returnPath);
    setCookie(response, appFlowCookie, browser, 15 * 60);
    redirect(
      response,
      service.options.authOrigin + visitorPath + "/login?flow=" + flow,
    );
  });
  router.get("/app/:id/:env/finish", async (request, response) => {
    const scope = await incoming(request);
    const browser = cookie(request, appFlowCookie);
    if (!browser) fail(400, "APPLICATION_AUTH_LINK_INVALID");
    const session = await service.finish(
      scope,
      token(request.query.ticket),
      browser,
      cookie(request, sessionCookie),
    );
    setCookie(response, sessionCookie, session.token, sessionSeconds);
    const workbenchReturn = previewReturn(scope.app_id, scope.environment);
    redirect(response, session.returnPath === workbenchReturn
      ? session.returnPath : visitorReturnPath(session.returnPath, service.base(scope)));
  });
  router.get("/app/:id/:env/me", async (request, response) => {
    const scope = await incoming(request);
    const value = cookie(request, sessionCookie);
    if (!value) fail(401, "APPLICATION_AUTH_REQUIRED");
    const member = await service.session(scope, value);
    response.json(await service.profile(scope, member));
  });
  /** 工作台只能探测当前预览是否已登录，不返回访客资料或任何凭据。 */
  router.get("/app/:id/:env/embedded-session", async (request, response) => {
    const parent = service.options.workbenchOrigin;
    if (!parent || parameter(request, "env") !== "preview") fail(404, "NOT_FOUND");
    origin(request, parent);
    const scope = await incoming(request);
    response.vary("Origin").set({
      "Access-Control-Allow-Origin": parent,
      "Access-Control-Allow-Credentials": "true",
    });
    const value = cookie(request, sessionCookie);
    if (!value) fail(401, "APPLICATION_AUTH_REQUIRED");
    await service.session(scope, value);
    response.status(204).end();
  });

  router.post("/app/:id/:env/logout", async (request, response) => {
    const scope = await incoming(request);
    origin(request, scope.origin);
    const value = cookie(request, sessionCookie);
    if (value) await service.logout(scope, value);
    setCookie(response, sessionCookie, "", 0);
    response.status(204).end();
  });

  router.post("/preview-access/:id/:deployment", express.text({ limit: "1kb" }), async (request, response) => {
    if (!ownerPreview) fail(404, "NOT_FOUND");
    const appId = requireAppId(parameter(request, "id"));
    const deployment = requireAppId(parameter(request, "deployment"));
    const origin = request.get("origin");
    const access = await ownerPreview.exchange(appId, deployment, request.get("host") ?? "", origin, token(request.body));
    response.vary("Origin").set({
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Credentials": "true",
    });
    setCookie(response, ownerPreviewCookie, access, ownerPreviewSeconds);
    response.status(204).end();
  });
  router.get("/preview-access/:id/:deployment", async (request, response) => {
    if (!ownerPreview) fail(404, "NOT_FOUND");
    await ownerPreview.authorize(requireAppId(parameter(request, "id")),
      requireAppId(parameter(request, "deployment")), request.get("host") ?? "",
      cookie(request, ownerPreviewCookie),
      request.get("x-harbor-preview-websocket") === "1" ? request.get("origin") ?? "" : undefined);
    response.status(204).end();
  });

  router.get("/check/:id/:env/:deployment", async (request, response) => {
    const deployment = requireAppId(parameter(request, "deployment"));
    const scope = await service.live(
      requireAppId(parameter(request, "id")),
      environment(parameter(request, "env")),
      request.get("host") ?? "",
      deployment,
    );
    if (request.get("x-harbor-visitor-write") === "1")
      origin(request, scope.origin);
    const value = cookie(request, sessionCookie);
    if (!value) fail(401, "APPLICATION_AUTH_REQUIRED");
    const member = await service.session(scope, value);
    response.setHeader(
      "X-App-Visitor-Assertion",
      service.assertion(scope, deployment, member),
    );
    response.status(204).end();
  });

  router.get("/login", async (request, response) => {
    authHostOnly(request);
    const flow = token(request.query.flow);
    const browser = cookie(request, authFlowCookie) ?? randomToken();
    const context = await service.open(flow, browser);
    setCookie(response, authFlowCookie, browser, 15 * 60);
    signInPage(
      response,
      flow,
      context,
      request.query.mode === "register" ? "register" : "password",
    );
  });

  const body = express.urlencoded({
    extended: false,
    limit: "4kb",
    parameterLimit: 6,
    inflate: false,
  });
  for (const action of ["password", "register", "google"] as const) {
    router.post("/" + action, body, async (request, response) => {
      authHostOnly(request);
      origin(request, service.options.authOrigin);
      const browser = cookie(request, authFlowCookie);
      if (!browser) fail(400, "APPLICATION_AUTH_LINK_INVALID");
      const flow = token(request.body?.flow);
      const context = await service.open(flow, browser);
      limit("form:" + context.id + ":" + sourceIP(request), 30);
      if (action === "google")
        return redirect(response, await service.googleStart(context));
      const email =
        typeof request.body.email === "string"
          ? request.body.email.trim().toLowerCase()
          : "";
      const password: unknown = request.body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        fail(400, "APPLICATION_AUTH_INVALID_CREDENTIALS");
      limit(
        action + ":" + context.id + ":" + email,
        action === "register" ? 4 : 12,
      );
      if (
        typeof password !== "string" ||
        password.length < (action === "register" ? 8 : 1) ||
        Buffer.byteLength(password) > 72
      )
        return signInPage(
          response,
          flow,
          context,
          action,
          action === "register"
            ? "请设置至少 8 个字符的密码。"
            : "邮箱或密码不正确。",
          400,
        );
      try {
        redirect(
          response,
          action === "register"
            ? await service.register(context, email, password)
            : await service.password(context, email, password),
        );
      } catch (error) {
        if (
          error instanceof ServiceError &&
          error.code === "APPLICATION_AUTH_REGISTRATION_REJECTED"
        )
          return signInPage(
            response,
            flow,
            context,
            action,
            "无法注册此邮箱，请检查填写的信息或尝试登录。",
            409,
          );
        if (error instanceof ServiceError && error.status === 401)
          return signInPage(
            response,
            flow,
            context,
            action,
            "邮箱或密码不正确。",
            401,
          );
        throw error;
      }
    });
  }
  for (const [path, backend] of [["/google/callback", "pocketbase"],
    ["/better-auth/callback/google", "better_auth"]] as const) router.get(path, async (request, response) => {
    authHostOnly(request);
    const browser = cookie(request, authFlowCookie);
    const code = request.query.code;
    if (!browser || typeof code !== "string" || !code || code.length > 2048)
      fail(400, "APPLICATION_AUTH_LINK_INVALID");
    redirect(
      response,
      await service.googleFinish(token(request.query.state), code, browser, backend),
    );
  });

  router.use(visitorErrors);
  return router;
}

/** Owner controls use the existing authenticated API, never the visitor session. */
export function createVisitorManagementRouter(apps: ApplicationService) {
  const router = Router({ caseSensitive: true });
  router.get("/applications/:id/auth/:env", async (request, response) => {
    const app = await apps.store.owned(
      principal(response).userId,
      requireAppId(parameter(request, "id")),
    );
    const env = environment(parameter(request, "env"));
    const scope = await apps.visitorAuth?.scope(app.id, env);
    response.json({
      available: !!apps.visitorAuth,
      enabled: !!scope?.enabled,
      origin: scope?.origin,
    });
  });
  router.get("/applications/:id/auth/:env/users", async (request, response) => {
    const app = await apps.store.owned(
      principal(response).userId,
      requireAppId(parameter(request, "id")),
    );
    const env = environment(parameter(request, "env"));
    const pageNumber = Number(request.query.page ?? "1");
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > 100000
    )
      fail(400, "INVALID_PAGE");
    const scope = await apps.visitorAuth?.scope(app.id, env);
    response.json(
      scope
        ? await apps.visitorAuth!.users(scope, pageNumber)
        : { items: [], totalPages: 0 },
    );
  });
  router.patch(
    "/applications/:id/auth/:env/users/:userId",
    ...jsonBody(4096),
    async (request, response) => {
      const user = principal(response).userId;
      const app = await apps.store.owned(
        user,
        requireAppId(parameter(request, "id")),
      );
      const id = parameter(request, "userId");
      const disabled = jsonInput(request).disabled;
      if (
        !/^[a-zA-Z0-9_]{1,64}(?:\.[a-zA-Z0-9_]{1,64})?$/.test(id) ||
        typeof disabled !== "boolean"
      )
        fail(400, "INVALID_APPLICATION_AUTH_USER");
      const scope = await apps.visitorAuth?.scope(
        app.id,
        environment(parameter(request, "env")),
      );
      if (!scope) fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
      await apps.visitorAuth!.disable(scope, user, id, disabled);
      response.status(204).end();
    },
  );
  router.use(visitorErrors);
  return router;
}
