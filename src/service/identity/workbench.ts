/** Better Auth owns credentials and sessions; only Harbor maps them to business users. */
import { betterAuth } from "better-auth";
import { parseCookies } from "better-auth/cookies";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { tokenHash } from "../auth.js";
import { fail } from "../types.js";

export const workbenchIssuer = "urn:agent-harbor:workbench";
const cookiePrefix = "ah_workbench";
const minimumPasswordLength = 12;
const maximumPasswordLength = 128;
export interface WorkbenchSettings { origin: string; secret: string; registration: boolean }

export function workbenchCredentials(input: Record<string, unknown>) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = input.password;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== "string" || password.length < minimumPasswordLength || password.length > maximumPasswordLength)
    fail(400, "INVALID_WORKBENCH_CREDENTIALS");
  return { email, password };
}

export class WorkbenchAuth {
  private readonly auth;
  private readonly sessionCookie: string;
  private readonly limits = new Map<string, { count: number; expires: number }>();
  constructor(private pool: Pool, readonly settings: WorkbenchSettings) {
    const secure = settings.origin.startsWith("https:");
    this.sessionCookie = secure ? "__Host-ah_workbench_session" : "ah_workbench_session";
    this.auth = betterAuth({
      database: pool,
      secret: settings.secret,
      baseURL: settings.origin,
      basePath: "/api/workbench-auth",
      emailAndPassword: { enabled: true, requireEmailVerification: false, autoSignIn: true,
        minPasswordLength: minimumPasswordLength, maxPasswordLength: maximumPasswordLength },
      user: { modelName: "ah_auth_user" },
      account: { modelName: "ah_auth_account" },
      session: { modelName: "ah_auth_session", expiresIn: 8 * 3600, disableSessionRefresh: true },
      verification: { modelName: "ah_auth_verification" },
      advanced: {
        cookiePrefix,
        useSecureCookies: false,
        defaultCookieAttributes: { secure, sameSite: "strict" },
        cookies: { session_token: { name: this.sessionCookie } },
      },
      logger: { disabled: true },
      telemetry: { enabled: false },
    });
  }

  async checkStorage() {
    await this.pool.query("SELECT 1 FROM ah_auth_user, ah_auth_account, ah_auth_session, ah_auth_verification LIMIT 0");
  }

  hasCookie(request: IncomingMessage) {
    return parseCookies(request.headers.cookie ?? "").has(this.sessionCookie);
  }

  async session(request: IncomingMessage) {
    return this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  async sessionActive(id: string, subject: string) {
    const result = await this.pool.query('SELECT 1 FROM ah_auth_session WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()', [id, subject]);
    return result.rowCount === 1;
  }

  private limit(key: string, max: number, windowMs: number) {
    const now = Date.now();
    if (this.limits.size >= 4096) {
      for (const [id, item] of this.limits) if (item.expires <= now) this.limits.delete(id);
      if (this.limits.size >= 4096 && !this.limits.has(key)) fail(429, "WORKBENCH_AUTH_LIMIT");
    }
    let item = this.limits.get(key);
    if (!item || item.expires <= now) {
      item = { count: 0, expires: now + windowMs };
      this.limits.set(key, item);
    }
    if (item.count >= max) fail(429, "WORKBENCH_AUTH_LIMIT");
    item.count++;
  }

  async credentials(request: IncomingMessage, input: Record<string, unknown>, register: boolean) {
    if (register && !this.settings.registration) fail(403, "WORKBENCH_REGISTRATION_DISABLED");
    // Never trust a client-supplied proxy header. The aggregate limit also protects reverse-proxy deployments.
    this.limit(register ? "register" : "login", register ? 20 : 120, 60_000);
    this.limit((register ? "register:" : "login:") + request.socket.remoteAddress, register ? 10 : 60, 60_000);
    const credentials = workbenchCredentials(input);
    this.limit("email:" + tokenHash(credentials.email), 10, 60_000);
    const headers = fromNodeHeaders(request.headers);
    const result = register
      ? await this.auth.api.signUpEmail({ body: { ...credentials, name: "Harbor 用户" }, headers, asResponse: true })
      : await this.auth.api.signInEmail({ body: credentials, headers, asResponse: true });
    if (result.status >= 500) fail(503, "WORKBENCH_AUTH_UNAVAILABLE");
    if (!result.ok) fail(register ? 409 : 401, register ? "WORKBENCH_REGISTRATION_FAILED" : "WORKBENCH_LOGIN_FAILED");
    const data = await result.json() as { user: { id: string; name: string } };
    return { user: data.user, cookies: result.headers.getSetCookie() };
  }

  async logout(request: IncomingMessage) {
    const result = await this.auth.api.signOut({ headers: fromNodeHeaders(request.headers), asResponse: true });
    if (!result.ok) fail(503, "WORKBENCH_AUTH_UNAVAILABLE");
    return result.headers.getSetCookie();
  }

  async discardUnboundIdentity(subject: string) {
    await this.pool.query(`DELETE FROM ah_auth_user WHERE id = $1 AND NOT EXISTS (
      SELECT 1 FROM external_identities WHERE issuer = $2 AND subject = $1
    )`, [subject, workbenchIssuer]);
  }

  /** The local operator creates a fresh credential without returning a browser session. */
  async createBindingIdentity(input: Record<string, unknown>) {
    const result = await this.auth.api.signUpEmail({
      body: { ...workbenchCredentials(input), name: "Harbor 管理员", rememberMe: false },
      asResponse: true,
    });
    if (!result.ok) fail(result.status >= 500 ? 503 : 409, "WORKBENCH_BIND_CREATE_FAILED");
    const data = await result.json() as { user: { id: string } };
    // Discard the temporary session created by sign-up before exposing the credential.
    await this.pool.query('DELETE FROM ah_auth_session WHERE "userId" = $1', [data.user.id]);
    return data.user.id;
  }
}
