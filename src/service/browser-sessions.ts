/** Cookie哈希持久化，活动连接在内存登记。重启保留登录，退出只断开观看。 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenHash } from "./auth.js";
import { IdentityStore } from "./identity/store.js";
import { fail } from "./types.js";
const cookieName = "ah_browser";
export class BrowserSessions {
  private connections = new Map<string, { userId: string; abort: AbortController; timer: ReturnType<typeof setTimeout> }>();
  constructor(private store: IdentityStore, private origin?: string,
    private lifetimeMs = 8 * 60 * 60_000, private workbenchOrigin?: URL) {}
  /** 同站预览的兄弟域名不能设置工作台的 __Host Cookie。 */
  private name(request: IncomingMessage) {
    return this.workbenchOrigin?.host === request.headers.host ? "__Host-" + cookieName : cookieName;
  }
  private cookie(request: IncomingMessage) {
    const name = this.name(request);
    return request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  }
  private disconnect(hash: string) {
    const live = this.connections.get(hash);
    if (live) { clearTimeout(live.timer); live.abort.abort(); this.connections.delete(hash); }
  }
  private async remove(hash: string) { await this.store.logout(hash); this.disconnect(hash); }
  private cookieHeader(request: IncomingMessage, value: string, seconds: number) {
    const name = this.name(request);
    const secure = name !== cookieName || this.origin?.startsWith("https:");
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`;
  }
  async login(request: IncomingMessage, response: ServerResponse, userId: string) {
    const old = this.cookie(request); if (old) await this.remove(tokenHash(old));
    const token = randomBytes(32).toString("base64url");
    await this.store.login(tokenHash(token), userId, Date.now() + this.lifetimeMs);
    // append保留OIDC握手Cookie的删除指令。
    response.appendHeader("Set-Cookie", this.cookieHeader(request, token, Math.floor(this.lifetimeMs / 1000)));
  }
  async user(request: IncomingMessage) {
    const token = this.cookie(request); if (!token) fail(401, "UNAUTHORIZED");
    const hash = tokenHash(token), record = await this.store.session(hash);
    let live = this.connections.get(hash);
    if (!live) {
      const timer = setTimeout(() => { void this.remove(hash); }, Math.max(0, record.expiresAt - Date.now())); timer.unref();
      live = { userId: record.userId, abort: new AbortController(), timer }; this.connections.set(hash, live);
    }
    return { userId: record.userId, signal: live.abort.signal };
  }
  async logout(request: IncomingMessage, response: ServerResponse) {
    const token = this.cookie(request); if (token) await this.remove(tokenHash(token));
    response.setHeader("Set-Cookie", this.cookieHeader(request, "", 0));
  }
  revokeUser(id: string) { for (const [hash, live] of this.connections) if (live.userId === id) this.disconnect(hash); }
  close() { for (const hash of this.connections.keys()) this.disconnect(hash); }
}
export function requireBrowserOrigin(request: IncomingMessage, origin = `http://${request.headers.host}`) {
  if (request.headers.origin !== origin || request.headers["x-harbor-client"] !== "web") fail(403, "ORIGIN_DENIED");
}
