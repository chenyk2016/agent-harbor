/** 标准登录只负责验证外部身份；用户和Cookie仍由本服务管理。 */
import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fail } from "../types.js";
export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
}
interface Pending {
  verifier: string;
  state: string;
  nonce: string;
  expires: number;
}
export class OidcLogin {
  private pending = new Map<string, Pending>();
  private configuration?: Promise<oidc.Configuration>;
  constructor(
    private settings: OidcSettings,
    private configure = () =>
      oidc.discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        oidc.ClientSecretPost(settings.clientSecret),
      ),
  ) {}
  private config() {
    return (this.configuration ??= this.configure()
      .then((config) => {
        oidc.enableNonRepudiationChecks(config);
        return config;
      })
      .catch((error) => {
        this.configuration = undefined;
        throw error;
      }));
  }
  private get secure() {
    return this.settings.origin.startsWith("https:") ? "; Secure" : "";
  }
  private cookie(response: ServerResponse, value: string, seconds: number) {
    // 供应商返回是跨站顶层导航；只有短期握手Cookie使用Lax，业务Cookie沿用Strict。
    response.setHeader(
      "Set-Cookie",
      `ah_oidc=${value}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure}`,
    );
  }
  async start(response: ServerResponse) {
    const config = await this.config();
    const now = Date.now();
    for (const [key, value] of this.pending)
      if (value.expires < now) this.pending.delete(key);
    if (this.pending.size >= 1000) fail(503, "LOGIN_BUSY");
    const key = randomBytes(32).toString("base64url");
    const pending = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      expires: now + 5 * 60_000,
    };
    const challenge = await oidc.calculatePKCECodeChallenge(pending.verifier);
    this.pending.set(key, pending);
    this.cookie(response, key, 300);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: `${this.settings.origin}/api/auth/oidc/callback`,
      scope: "openid profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: pending.state,
      nonce: pending.nonce,
    });
    response.writeHead(302, {
      Location: url.href,
      "Cache-Control": "no-store",
    });
    response.end();
  }
  /** requestUrl由HTTP边界提供：Express挂载会裁剪request.url，换码必须使用完整回调路径。 */
  async callback(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl = request.url!,
  ) {
    const key =
      request.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("ah_oidc="))
        ?.slice(8) ?? "";
    const pending = this.pending.get(key);
    this.pending.delete(key);
    this.cookie(response, "", 0);
    if (!pending || pending.expires < Date.now()) fail(401, "LOGIN_EXPIRED");
    const tokens = await oidc.authorizationCodeGrant(
      await this.config(),
      new URL(requestUrl, this.settings.origin),
      {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims()!;
    return {
      issuer: String(claims.iss),
      subject: claims.sub,
      name: typeof claims.name === "string" ? claims.name : claims.sub,
    };
  }
}
