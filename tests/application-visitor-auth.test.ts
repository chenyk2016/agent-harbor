import { fail } from "../src/service/types.js";
/** 真实控制库与 HTTP 入口。外部账号服务使用定向替身，固定 PocketBase 另做联调。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import express from "express";
import type { AddressInfo } from "node:net";
import { testDatabase } from "./pg.js";
import { ApplicationStore } from "../src/service/applications/store.js";
import type { ApplicationService } from "../src/service/applications/service.js";
import {
  visitorOrigin,
  visitorPath,
} from "../src/service/applications/visitor-auth/config.js";
import {
  createVisitorManagementRouter,
  createVisitorRouter,
  visitorReturnPath,
} from "../src/service/applications/visitor-auth/http.js";
import { VisitorAuthService } from "../src/service/applications/visitor-auth/service.js";
import {
  visitorProviders,
  type VisitorProvider,
} from "../src/service/applications/visitor-auth/policy.js";
import type { AppEnvironment } from "../src/service/applications/data.js";

test("visitor return URLs stay within their own application path", () => {
  const base = "/apps/app/";
  assert.equal(
    visitorReturnPath(base + "page?q=yes", base),
    base + "page?q=yes",
  );
  for (const value of [
    "//example.com",
    base + "../other",
    base + "%2e%2e/other",
    base + "__harbor/auth/finish",
    base + "%5cother",
  ])
    assert.equal(visitorReturnPath(value, base), base);
});

test("visitor callbacks and sessions are bound to an app, environment, browser and deployment", async () => {
  const database = await testDatabase();
  const keys = generateKeyPairSync("ed25519");
  const service = new VisitorAuthService(database.db, {
    authOrigin: "https://auth.example.com",
    appDomain: "apps.example.net",
    workbenchOrigin: "https://studio.example.net",
    pocketbase: "http://127.0.0.1:1",
    pocketbaseToken: "fixture-only",
    betterAuth: { secret: randomUUID().repeat(2), google: {
      preview: { clientId: "better-preview", clientSecret: "fixture-preview" },
      production: { clientId: "better-production", clientSecret: "fixture-production" },
    } },
    googleId: "fixture-id",
    googleSecret: "fixture-only",
    edgeDial: "127.0.0.1:1",
    edgeToken: "fixture-edge-secret",
    signingKey: keys.privateKey,
    publicKey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  });
  const store = new ApplicationStore(database.db);
  const apps = { store, visitorAuth: service } as ApplicationService;
  const collectionIds = new Map<string, string>();
  const collectionProviders = new Map<string, VisitorProvider>();
  const registrations = new Set<string>();
  const legacyCollection = "legacy_fixture";
  const accounts = service.accounts;
  accounts.provision = async (name, expected, provider) => {
    if (!collectionIds.has(name))
      collectionIds.set(name, expected ?? randomUUID().replaceAll("-", ""));
    const id = collectionIds.get(name)!;
    collectionProviders.set(id, provider);
    return id;
  };
  const user = (collectionId: string) => ({
    id: "record001",
    collectionId,
    email: "visitor@example.test",
    verified: collectionProviders.get(collectionId) !== "email_password",
  });
  accounts.user = async (collection) => user(collection);
  accounts.users = async (collection) => ({
    totalPages: 1,
    items: [user(collection)],
  });
  accounts.register = async (collection, _email, password) => {
    assert.equal(collectionProviders.get(collection), "email_password");
    assert.equal(password, "fixture-password");
    if (registrations.has(collection))
      fail(409, "APPLICATION_AUTH_REGISTRATION_REJECTED");
    registrations.add(collection);
    return user(collection);
  };
  accounts.password = async (collection, _email, password, requireVerified) => {
    if (password === "legacy-password" && collection !== legacyCollection)
      fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    if (collection === legacyCollection) assert.equal(requireVerified, true);
    return user(collection);
  };
  accounts.googleStart = async (collection) => {
    assert.equal(collectionProviders.get(collection), "google");
    const state = randomUUID();
    return {
      state,
      verifier: state,
      url: "https://accounts.google.com/?state=" + state,
    };
  };
  accounts.googleFinish = async (collection, code, verifier) => {
    assert.equal(collectionProviders.get(collection), "google");
    assert.equal(code, verifier);
    return { record: user(collection), subject: "google-subject" };
  };
  accounts.legacyGoogle = async (collection, subject) => {
    assert.equal(collection, legacyCollection);
    assert.equal(subject, "google-subject");
    return user(collection);
  };
  const api = express();
  api.use(visitorPath, createVisitorRouter(service));
  api.use(
    "/api",
    (request, response, next) => {
      response.locals.principal = { userId: request.get("fixture-owner") };
      next();
    },
    createVisitorManagementRouter(apps),
  );
  const server = api.listen(0, "127.0.0.1");

  let fresh: string | undefined;
  try {
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    // Use Node HTTP because fetch may rewrite the Host header used for scope validation.
    const request = (path: string, host: string, options: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(new Headers(options.headers));
        const body = options.body?.toString();
        if (body) headers["content-length"] = String(Buffer.byteLength(body));
        const client = httpRequest(
          origin + path,
          {
            method: options.method,
            headers: {
              host,
              "x-harbor-edge-proof": service.options.edgeToken,
              ...headers,
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("error", reject);
            incoming.on("end", () => {
              const received = new Headers();
              for (const [name, value] of Object.entries(incoming.headers))
                if (value !== undefined)
                  received.set(
                    name,
                    Array.isArray(value) ? value.join(", ") : value,
                  );
              resolve(
                new Response(
                  incoming.statusCode === 204 ? null : Buffer.concat(chunks),
                  { status: incoming.statusCode, headers: received },
                ),
              );
            });
          },
        );
        client.on("error", reject);
        client.end(body);
      });
    const seed = async (
      appId: string,
      environment: AppEnvironment,
      providers?: VisitorProvider[],
    ) => {
      const revision = randomUUID(),
        build = randomUUID(),
        deployment = randomUUID();
      const appOrigin = visitorOrigin(
        service.options.appDomain,
        appId,
        environment,
      );
      const pool = database.pool;
      await pool.query(
        `INSERT INTO app_revisions(id,"appId",number,source,manifest,summary,"createdAt")
        VALUES($1,$2,COALESCE((SELECT MAX(number)+1 FROM app_revisions WHERE "appId"=$2),1),'{}','{}','fixture',0)`,
        [revision, appId],
      );
      await pool.query(
        `INSERT INTO app_builds(id,"appId","revisionId",target,status,"createdAt","updatedAt")
        VALUES($1,$2,$3,$4,'succeeded',0,0)`,
        [build, appId, revision, environment],
      );
      await pool.query(
        `INSERT INTO app_deployments(id,"appId","buildId",environment,"desiredState","observedState",spec,epoch,"createdAt","updatedAt")
        VALUES($1,$2,$3,$4,'running','ready',$5,0,0,0)`,
        [
          deployment,
          appId,
          build,
          environment,
          { visitorAuth: { origin: appOrigin, providers } },
        ],
      );
      await pool.query(
        `INSERT INTO app_endpoints("appId",environment,"desiredDeploymentId","appliedDeploymentId",state)
        VALUES($1,$2,$3,$3,'ready')`,
        [appId, environment, deployment],
      );
      await service.provision(
        appId,
        "owner",
        environment,
        providers ?? [...visitorProviders],
      );
      const scope = (await service.scope(appId, environment))!;
      return {
        scope,
        origin: appOrigin,
        host: new URL(appOrigin).host,
        deployment,
        prefix: `${visitorPath}/app/${appId}/${environment}`,
        check: `${visitorPath}/check/${appId}/${environment}/${deployment}`,
        admin: `/api/applications/${appId}/auth/${environment}`,
      };
    };
    const a = randomUUID(),
      b = randomUUID(),
      legacyApp = randomUUID();
    for (const id of ["owner", "other"])
      await database.pool.query(
        'INSERT INTO users(id,name,"createdAt") VALUES($1,$1,0)',
        [id],
      );
    for (const id of [a, b, legacyApp])
      await database.pool.query(
        `INSERT INTO applications(id,"ownerId",title,status,"createdAt","updatedAt")
        VALUES($1,'owner','Fixture','active',0,0)`,
        [id],
      );
    const production = await seed(a, "production", ["google"]);
    const preview = await seed(a, "preview", ["email_password"]);
    const second = await seed(b, "production");
    assert.equal(
      new Set([
        production.scope.google_collection_id,
        preview.scope.password_collection_id,
        second.scope.google_collection_id,
      ]).size,
      3,
    );

    const authHost = new URL(service.options.authOrigin).host;
    const extractCookie = (response: Response) =>
      (response.headers.get("set-cookie") ?? "").split(";")[0];
    const begin = async (target: typeof production, query = "") => {
      const start = await request(target.prefix + "/start" + query, target.host);
      assert.equal(
        start.status,
        303,
        start.ok ? undefined : await start.text(),
      );
      const authLocation = new URL(start.headers.get("location")!);
      const login = await request(
        authLocation.pathname + authLocation.search,
        authHost,
      );
      assert.equal(login.status, 200);
      assert.equal(login.headers.get("referrer-policy"), "same-origin");
      const formAction = login.headers.get("content-security-policy")!
        .split(";")
        .find((rule) => rule.trim().startsWith("form-action"))!
        .trim();
      return {
        appCookie: extractCookie(start),
        authCookie: extractCookie(login),
        flow: authLocation.searchParams.get("flow")!,
        formAction,
        html: await login.text(),
      };
    };
    const credential = (
      action: string,
      flow: string,
      cookie: string,
      password = "fixture-password",
    ) =>
      request(visitorPath + "/" + action, authHost, {
        method: "POST",
        headers: {
          cookie,
          origin: service.options.authOrigin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          flow,
          email: "visitor@example.test",
          password,
        }),
      });
    const complete = async (
      target: typeof production,
      response: Response,
      appCookie: string,
      returnTo?: string,
    ) => {
      assert.equal(response.status, 303);
      const ticket = new URL(
        response.headers.get("location")!,
      ).searchParams.get("ticket")!;
      const finish = target.prefix + "/finish?ticket=" + ticket;
      assert.equal((await request(finish, target.host)).status, 400);
      const loggedIn = await request(finish, target.host, {
        headers: { cookie: appCookie },
      });
      assert.equal(loggedIn.status, 303);
      if (returnTo) assert.equal(loggedIn.headers.get("location"), returnTo);
      assert.match(
        loggedIn.headers.get("set-cookie")!,
        /; Secure; HttpOnly; SameSite=Lax;/,
      );
      assert.equal(
        (await request(finish, target.host, { headers: { cookie: appCookie } }))
          .status,
        400,
      );
      return extractCookie(loggedIn);
    };

    const googleLoginFor = async (target: typeof production) => {
      const login = await begin(target);
      const google = await credential("google", login.flow, login.authCookie);
      const state = new URL(google.headers.get("location")!).searchParams.get(
        "state",
      );
      const callback = await request(
        visitorPath + "/google/callback?state=" + state + "&code=" + state,
        authHost,
        { headers: { cookie: login.authCookie } },
      );
      return complete(target, callback, login.appCookie);
    };
    const profile = async (target: typeof production, cookie: string) => {
      const response = await request(target.prefix + "/me", target.host, {
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const signup = await begin(second);
    assert.equal(
      signup.formAction,
      `form-action 'self' ${second.origin} https://accounts.google.com`,
    );
    assert.match(signup.html, /<h1>登录<\/h1>/);
    assert.match(signup.html, /使用 Google 登录/);
    assert.doesNotMatch(signup.html, /Fixture|注册并登录|发送注册链接|邮箱未验证/);
    const registrationPath = signup.html.match(/href="([^"]+&amp;mode=register)"/)?.[1];
    assert.ok(registrationPath);
    const registration = await request(registrationPath.replace("&amp;", "&"), authHost, {
      headers: { cookie: signup.authCookie },
    });
    assert.equal(registration.status, 200);
    const registrationHtml = await registration.text();
    assert.match(registrationHtml, /<h1>创建账号<\/h1>/);
    assert.match(registrationHtml, /注册并登录/);
    assert.match(registrationHtml, /返回登录/);
    assert.doesNotMatch(registrationHtml, /Fixture|current-password|发送注册链接|邮箱未验证/);
    const emailCookie = await complete(
      second,
      await credential("register", signup.flow, signup.authCookie),
      signup.appCookie,
    );
    const googleCookie = await googleLoginFor(second);
    const passwordProfile = await profile(second, emailCookie);
    const googleProfile = await profile(second, googleCookie);
    assert.equal(passwordProfile.email, googleProfile.email);
    assert.notEqual(passwordProfile.id, googleProfile.id);
    assert.equal("verified" in passwordProfile, false);
    const duplicate = await begin(second);
    const rejectedRegistration = await credential("register", duplicate.flow, duplicate.authCookie);
    assert.equal(rejectedRegistration.status, 409);
    const rejection = await rejectedRegistration.text();
    assert.match(rejection, /<h1>创建账号<\/h1>/);
    assert.match(rejection, /role="alert">无法注册此邮箱/);
    const listedPassword = await request(second.admin + "/users", authHost, {
      headers: { "fixture-owner": "owner" },
    });
    const listedGoogle = await request(
      second.admin + "/users?page=2",
      authHost,
      { headers: { "fixture-owner": "owner" } },
    );
    const [passwordAccount] = (await listedPassword.json()).items;
    const [googleAccount] = (await listedGoogle.json()).items;
    assert.equal(passwordAccount.email, googleAccount.email);
    assert.notEqual(passwordAccount.id, googleAccount.id);
    const disabledPassword = await request(
      second.admin + "/users/" + passwordAccount.id,
      authHost,
      {
        method: "PATCH",
        headers: {
          "fixture-owner": "owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({ disabled: true }),
      },
    );
    assert.equal(disabledPassword.status, 204);
    assert.equal(
      (
        await request(second.check, second.host, {
          headers: { cookie: emailCookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(second.check, second.host, {
          headers: { cookie: googleCookie },
        })
      ).status,
      204,
    );

    const historical = await seed(legacyApp, "production");
    const historicalUser = randomUUID();
    await database.pool.query(
      "UPDATE app_auth_scopes SET collection_id=$1 WHERE id=$2",
      [legacyCollection, historical.scope.id],
    );
    await database.pool.query(
      `INSERT INTO app_auth_users(id,scope_id,collection_id,record_id) VALUES($1,$2,$3,'record001')`,
      [historicalUser, historical.scope.id, legacyCollection],
    );
    const oldGoogleCookie = await googleLoginFor(historical);
    assert.equal(
      (await profile(historical, oldGoogleCookie)).id,
      historicalUser,
    );
    const historicalLogin = await begin(historical);
    const oldPasswordCookie = await complete(
      historical,
      await credential(
        "password",
        historicalLogin.flow,
        historicalLogin.authCookie,
        "legacy-password",
      ),
      historicalLogin.appCookie,
    );
    assert.equal(
      (await profile(historical, oldPasswordCookie)).id,
      historicalUser,
    );

    const flow = await begin(production);
    assert.equal(
      flow.formAction,
      "form-action 'self' https://accounts.google.com",
    );
    assert.match(flow.html, /使用 Google 登录/);
    assert.doesNotMatch(flow.html, /name="password"|发送注册链接/);
    for (const action of ["password", "register"]) {
      const rejected = await credential(action, flow.flow, flow.authCookie);
      assert.equal(rejected.status, 403);
      assert.equal(
        (await rejected.json()).error,
        "APPLICATION_AUTH_PROVIDER_DISABLED",
      );
    }
    assert.equal(
      (
        await request(
          visitorPath +
            "/verify/" +
            production.scope.collection_name +
            "?token=abc.def.ghi",
          authHost,
        )
      ).status,
      404,
    );
    const legacy = await begin(second);
    assert.match(legacy.html, /name="password"/);
    assert.match(legacy.html, /使用 Google 登录/);
    const google = await credential("google", flow.flow, flow.authCookie);
    assert.equal(google.headers.get("referrer-policy"), "no-referrer");
    const opaqueOrigin = await request(visitorPath + "/google", authHost, {
      method: "POST",
      headers: { origin: "null", cookie: flow.authCookie },
    });
    assert.equal(opaqueOrigin.status, 403);
    assert.equal((await opaqueOrigin.json()).error, "ORIGIN_DENIED");
    const state = new URL(google.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback =
      visitorPath + "/google/callback?state=" + state + "&code=" + state;
    assert.equal((await request(callback, authHost)).status, 400);
    const googleLogin = await request(callback, authHost, {
      headers: { cookie: flow.authCookie },
    });
    const cookie = await complete(production, googleLogin, flow.appCookie);
    assert.equal(
      (
        await request(callback, authHost, {
          headers: { cookie: flow.authCookie },
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await request(production.check, production.host, {
          headers: { cookie, "x-harbor-edge-proof": "forged" },
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(production.check, preview.host, { headers: { cookie } }))
        .status,
      404,
    );
    assert.equal(
      (await request(preview.check, preview.host, { headers: { cookie } }))
        .status,
      401,
    );
    assert.equal(
      (await request(second.check, second.host, { headers: { cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await request(production.check, production.host, {
          headers: {
            cookie,
            "x-harbor-visitor-write": "1",
            origin: preview.origin,
          },
        })
      ).status,
      403,
    );
    const checked = await request(production.check, production.host, {
      headers: { cookie },
    });
    assert.equal(checked.status, 204);
    const [body, signature] = checked.headers
      .get("x-app-visitor-assertion")!
      .split(".");
    assert.equal(
      verify(
        null,
        Buffer.from(body),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    const assertion = JSON.parse(Buffer.from(body, "base64url").toString());
    assert.equal(assertion.appId, a);
    assert.equal(assertion.deploymentId, production.deployment);

    const embedded = "/embedded-session";
    const studio = service.options.workbenchOrigin!;
    const withoutSession = await request(preview.prefix + embedded, preview.host, {
      headers: { origin: studio },
    });
    assert.equal(withoutSession.status, 401);
    assert.equal(withoutSession.headers.get("access-control-allow-origin"), studio);
    assert.equal(withoutSession.headers.get("access-control-allow-credentials"), "true");
    assert.equal((await request(preview.prefix + embedded, preview.host, {
      headers: { origin: "https://untrusted.example.net" },
    })).status, 403);
    assert.equal((await request(production.prefix + embedded, production.host, {
      headers: { origin: studio, cookie },
    })).status, 404);
    const password = await begin(preview, "?workbench=1&return=https%3A%2F%2Fbad.example.net");
    assert.match(password.html, /name="password"/);
    assert.equal(password.formAction, `form-action 'self' ${preview.origin} ${studio}`);
    assert.ok(!password.formAction.includes("bad.example.net"));
    assert.doesNotMatch(password.html, /使用 Google 登录/);
    assert.equal(
      (await credential("google", password.flow, password.authCookie)).status,
      403,
    );
    const previewCookie = await complete(
      preview,
      await credential("password", password.flow, password.authCookie),
      password.appCookie,
      studio + "/applications/" + a,
    );
    assert.equal(
      (
        await request(preview.check, preview.host, {
          headers: { cookie: previewCookie },
        })
      ).status,
      204,
    );
    const signedIn = await request(preview.prefix + embedded, preview.host, {
      headers: { origin: studio, cookie: previewCookie },
    });
    assert.equal(signedIn.status, 204);
    assert.equal(await signedIn.text(), "");
    assert.equal((await request(preview.prefix + embedded, preview.host, {
      headers: { origin: studio, cookie },
    })).status, 401);
    const me = await request(production.prefix + "/me", production.host, {
      headers: { cookie },
    });
    assert.equal((await me.json()).id, assertion.userId);

    // Capture both an OAuth callback and a handoff before removing Google.
    const stale = await begin(production);
    const pendingGoogle = await credential(
      "google",
      stale.flow,
      stale.authCookie,
    );
    const pendingState = new URL(
      pendingGoogle.headers.get("location")!,
    ).searchParams.get("state");
    const staleCallback =
      visitorPath +
      "/google/callback?state=" +
      pendingState +
      "&code=" +
      pendingState;
    const pendingHandoff = await begin(production);
    const handoffGoogle = await credential(
      "google",
      pendingHandoff.flow,
      pendingHandoff.authCookie,
    );
    const handoffState = new URL(
      handoffGoogle.headers.get("location")!,
    ).searchParams.get("state");
    const handoff = await request(
      visitorPath +
        "/google/callback?state=" +
        handoffState +
        "&code=" +
        handoffState,
      authHost,
      { headers: { cookie: pendingHandoff.authCookie } },
    );
    assert.equal(handoff.status, 303);
    const ticket = new URL(handoff.headers.get("location")!).searchParams.get(
      "ticket",
    );
    await database.pool.query(
      `UPDATE app_deployments SET spec=jsonb_set(spec,'{visitorAuth,providers}','["email_password"]') WHERE id=$1`,
      [production.deployment],
    );
    assert.equal(
      (
        await request(staleCallback, authHost, {
          headers: { cookie: stale.authCookie },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          production.prefix + "/finish?ticket=" + ticket,
          production.host,
          { headers: { cookie: pendingHandoff.appCookie } },
        )
      ).status,
      403,
    );
    // Existing sessions remain usable; the deployment restricts new authentication.
    assert.equal(
      (
        await request(production.check, production.host, {
          headers: { cookie },
        })
      ).status,
      204,
    );

    assert.equal(
      (
        await request(production.admin + "/users", authHost, {
          headers: { "fixture-owner": "other" },
        })
      ).status,
      404,
    );
    const headers = {
      "fixture-owner": "owner",
      "content-type": "application/json",
    };
    const setDisabled = (disabled: boolean) =>
      request(
        production.admin +
          "/users/" +
          production.scope.google_collection_id +
          ".record001",
        authHost,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ disabled }),
        },
      );
    assert.equal((await setDisabled(true)).status, 204);
    assert.equal(
      (
        await request(production.check, production.host, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(preview.check, preview.host, {
          headers: { cookie: previewCookie },
        })
      ).status,
      204,
    );
    const listed = await request(production.admin + "/users", authHost, {
      headers,
    });
    assert.equal((await listed.json()).items[0].disabled, true);
    assert.equal((await setDisabled(false)).status, 204);
    assert.equal(
      (
        await request(production.check, production.host, {
          headers: { cookie },
        })
      ).status,
      401,
    );
    const logout = await request(preview.prefix + "/logout", preview.host, {
      method: "POST",
      headers: { origin: preview.origin, cookie: previewCookie },
    });
    assert.equal(logout.status, 204);
    assert.equal(
      (
        await request(preview.check, preview.host, {
          headers: { cookie: previewCookie },
        })
      ).status,
      401,
    );
    const audit = await database.pool.query(
      `SELECT payload FROM app_events WHERE type='visitor.user_status' AND "appId"=$1`,
      [a],
    );
    assert.deepEqual(audit.rows.map((row) => row.payload.disabled).sort(), [
      false,
      true,
    ]);

    // A fresh application uses Better Auth, while existing scopes keep PocketBase.
    service.options.defaultBackend = "better_auth";
    fresh = randomUUID();
    await database.pool.query(`INSERT INTO applications(id,"ownerId",title,status,"createdAt","updatedAt")
      VALUES($1,'owner','Better fixture','active',0,0)`, [fresh]);
    const betterPreview = await seed(fresh, "preview");
    const betterProduction = await seed(fresh, "production");
    assert.equal(betterPreview.scope.backend, "better_auth");
    assert.equal(betterProduction.scope.backend, "better_auth");
    await service.provision(a, "owner", "preview", ["email_password"]);
    assert.equal((await service.scope(a, "preview"))?.backend, "pocketbase");
    const betterPasswords = ["Better preview secret", "Better production secret"];
    const betterTargets = [betterPreview, betterProduction];
    const browserSessions = await Promise.all(betterTargets.map(async (target, index) => {
      const flow = await begin(target);
      const response = await credential("register", flow.flow, flow.authCookie, betterPasswords[index]);
      assert.equal(response.status, 303, await response.clone().text());
      return complete(target, response, flow.appCookie);
    }));
    assert.notEqual((await profile(betterPreview, browserSessions[0])).id, (await profile(betterProduction, browserSessions[1])).id);
    for (const [index, target] of betterTargets.entries()) {
      const flow = await begin(target);
      assert.equal((await credential("password", flow.flow, flow.authCookie, betterPasswords[1 - index])).status, 401);
      assert.equal((await request(target.check, target.host, { headers: { cookie: browserSessions[1 - index] } })).status, 401);
    }

    const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const codes = new Map<string, URL>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const outbound = new URL(input instanceof Request ? input.url : input);
      if (outbound.href === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }] });
      assert.equal(outbound.href, "https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(await new Request(input, init).text());
      const issued = codes.get(body.get("code")!);
      assert.ok(issued);
      codes.delete(body.get("code")!);
      assert.equal(body.get("redirect_uri"), issued.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
        issued.searchParams.get("code_challenge"));
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const payload = encode({ alg: "RS256", kid: "fixture" }) + "." + encode({
        iss: "https://accounts.google.com", aud: issued.searchParams.get("client_id"), sub: "google-fixture-subject",
        email: "visitor@example.test", email_verified: true, name: "Fixture visitor",
        iat: now, exp: now + 300, nonce: issued.searchParams.get("nonce"),
      });
      return Response.json({ id_token: payload + "." + sign("RSA-SHA256", Buffer.from(payload), signing.privateKey).toString("base64url"),
        access_token: "fixture", token_type: "Bearer", expires_in: 300, scope: "openid email profile" });
    };
    try {
      const googleSessions: string[] = [];
      for (const [index, target] of betterTargets.entries()) {
        const flow = await begin(target);
        const start = await credential("google", flow.flow, flow.authCookie);
        assert.equal(start.status, 303, await start.clone().text());
        const google = new URL(start.headers.get("location")!);
        assert.equal(google.searchParams.get("client_id"), index === 0 ? "better-preview" : "better-production");
        const callback = new URL(google.searchParams.get("redirect_uri")!);
        assert.equal(callback.pathname, visitorPath + "/better-auth/callback/google");
        const code = randomUUID();
        codes.set(code, google);
        callback.search = new URLSearchParams({ code, state: google.searchParams.get("state")! }).toString();
        const query = callback.pathname + callback.search;
        assert.equal((await request(query, authHost, { headers: { cookie: "fixture=wrong" } })).status, 400);
        assert.equal((await request(visitorPath + "/google/callback" + callback.search, authHost,
          { headers: { cookie: flow.authCookie } })).status, 400);
        const result = await request(query, authHost, { headers: { cookie: flow.authCookie } });
        assert.equal(result.status, 303, await result.clone().text());
        assert.equal(result.headers.get("set-cookie"), null);
        googleSessions.push(await complete(target, result, flow.appCookie));
        assert.equal((await request(query, authHost, { headers: { cookie: flow.authCookie } })).status, 400);
      }
      const ids = await Promise.all(betterTargets.flatMap((target, index) =>
        [browserSessions[index], googleSessions[index]].map(async session => (await profile(target, session)).id)));
      assert.equal(new Set(ids).size, 4);
      const listed = await request(betterPreview.admin + "/users", authHost, { headers });
      // The password realm is listed first. Disable its user while both Google sessions remain valid.
      const passwordUser = (await listed.json()).items[0];
      assert.equal(passwordUser.method, "email_password");
      const change = (disabled: boolean) => request(betterPreview.admin + "/users/" + passwordUser.id, authHost,
        { method: "PATCH", headers, body: JSON.stringify({ disabled }) });
      assert.equal((await change(true)).status, 204);
      const blocked = await begin(betterPreview);
      assert.equal((await credential("password", blocked.flow, blocked.authCookie, betterPasswords[0])).status, 403);
      assert.equal((await request(betterPreview.check, betterPreview.host, { headers: { cookie: browserSessions[0] } })).status, 401);
      assert.equal((await request(betterProduction.check, betterProduction.host, { headers: { cookie: browserSessions[1] } })).status, 204);
      for (const [index, target] of betterTargets.entries()) assert.equal(
        (await request(target.check, target.host, { headers: { cookie: googleSessions[index] } })).status, 204);
      assert.equal((await change(false)).status, 204);
      assert.equal((await request(betterPreview.check, betterPreview.host, { headers: { cookie: browserSessions[0] } })).status, 401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (fresh) await service.remove(fresh);
    } finally {
      await database.close();
    }
  }
});
