import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { Kysely, PostgresDialect } from "kysely";
import { sql } from "drizzle-orm";
import type { Tx } from "../../db/client.js";
import type { Pool } from "pg";
import { fail } from "../../types.js";
import { visitorPath, type VisitorAuthOptions } from "./config.js";
import type { VisitorProvider } from "./policy.js";

export const betterVisitorPath = visitorPath + "/better-auth";
export const visitorRealm = (scope: string, provider: VisitorProvider) =>
  "ahv_" + scope.replaceAll("-", "") + (provider === "google" ? "_g" : "_e");

function realmName(realm: string) {
  if (!/^ahv_[a-f0-9]{32}_[eg]$/.test(realm)) fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
  return '"' + realm + '"';
}

export class BetterVisitorAccounts {
  private readonly database;
  constructor(private pool: Pool, private options: VisitorAuthOptions) {
    this.database = new Kysely({ dialect: new PostgresDialect({ pool }) });
  }

  googleAvailable(environment: "preview" | "production") {
    return !!this.options.betterAuth?.google[environment];
  }

  private auth(realm: string, environment: "preview" | "production") {
    realmName(realm);
    const config = this.options.betterAuth!;
    const password = realm.endsWith("_e");
    const google = config.google[environment];
    if (!password && !google) fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
    return betterAuth({
      database: { db: this.database, type: "postgres", schemaName: realm },
      secret: createHmac("sha256", config.secret).update(realm).digest("hex"),
      baseURL: this.options.authOrigin,
      basePath: betterVisitorPath,
      emailAndPassword: { enabled: password, requireEmailVerification: false, autoSignIn: true },
      ...(google && !password && { socialProviders: { google } }),
      account: { modelName: "ah_auth_account", encryptOAuthTokens: true, accountLinking: { enabled: false } },
      user: { modelName: "ah_auth_user" },
      session: { modelName: "ah_auth_session", expiresIn: 300, disableSessionRefresh: true },
      verification: { modelName: "ah_auth_verification" },
      advanced: { cookiePrefix: realm, useSecureCookies: true },
      rateLimit: { enabled: false },
      logger: { disabled: true }, telemetry: { enabled: false },
    });
  }

  private cookie(response: Response) {
    return response.headers.getSetCookie().filter(c => !/;\s*Max-Age=0(?:;|$)/i.test(c))
      .map(c => c.split(";", 1)[0]).join("; ");
  }

  private async identity(auth: ReturnType<BetterVisitorAccounts["auth"]>, realm: string, response: Response) {
    const cookie = this.cookie(response);
    if (!cookie) fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    const headers = new Headers({ cookie });
    const value = await auth.api.getSession({ headers });
    if (!value) fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    await auth.api.signOut({ headers });
    return { id: value.user.id, email: value.user.email, verified: value.user.emailVerified, collectionId: realm };
  }

  async credentials(realm: string, environment: "preview" | "production", email: string, password: string, register: boolean) {
    const auth = this.auth(realm, environment);
    const result = register
      ? await auth.api.signUpEmail({ body: { name: "访客", email, password }, asResponse: true })
      : await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    if (result.status >= 500) fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    if (!result.ok) fail(register ? 409 : 401, register ? "APPLICATION_AUTH_REGISTRATION_REJECTED" : "APPLICATION_AUTH_LOGIN_FAILED");
    return this.identity(auth, realm, result);
  }

  async googleStart(realm: string, environment: "preview" | "production") {
    const auth = this.auth(realm, environment);
    const result = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: this.options.authOrigin + betterVisitorPath },
      asResponse: true,
    });
    if (!result.ok) fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
    const url = new URL((await result.json() as { url: string }).url);
    const state = url.searchParams.get("state");
    const cookie = this.cookie(result);
    if (url.origin !== "https://accounts.google.com" || !state || !cookie)
      fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
    return { url: url.href, state, verifier: cookie };
  }

  async googleFinish(realm: string, environment: "preview" | "production", state: string, code: string, cookie: string) {
    const auth = this.auth(realm, environment);
    const origin = this.options.authOrigin;
    const url = origin + betterVisitorPath + "/callback/google?" + new URLSearchParams({ state, code });
    const response = await auth.handler(new Request(url, { headers: { cookie } }));
    if (response.headers.get("location") !== origin + betterVisitorPath)
      fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    return this.identity(auth, realm, response);
  }

  async user(realm: string, id: string, tx?: Tx) {
    const table = sql.raw(realmName(realm) + ".ah_auth_user");
    const result = tx
      ? await tx.execute(sql`SELECT id,email,"emailVerified" AS verified FROM ${table} WHERE id=${id}`)
      : await this.pool.query(`SELECT id,email,"emailVerified" AS verified FROM ${realmName(realm)}.ah_auth_user WHERE id=$1`, [id]);
    if (!result.rows[0]) fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
    return { ...result.rows[0] as { id: string; email: string; verified: boolean }, collectionId: realm };
  }

  async users(realm: string, page: number) {
    const table = realmName(realm) + ".ah_auth_user";
    const count = await this.pool.query(`SELECT count(*) AS count FROM ${table}`);
    const result = await this.pool.query(`SELECT id,email FROM ${table} ORDER BY id LIMIT 50 OFFSET $1`, [(page - 1) * 50]);
    return { items: result.rows as { id: string; email: string }[], totalPages: Math.ceil(Number(count.rows[0].count) / 50) };
  }

  async remove(realm: string) {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${realmName(realm)} CASCADE`);
  }
}
