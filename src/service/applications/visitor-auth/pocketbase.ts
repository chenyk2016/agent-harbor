import { fail } from "../../types.js";
import { visitorPath, type VisitorAuthOptions } from "./config.js";
import type { VisitorProvider } from "./policy.js";

/** 已脱敏的 PocketBase 账号字段，只包含 Harbor 身份和用户列表需要的数据。 */
export interface PocketUser {
  id: string;
  collectionId: string;
  email: string;
  verified: boolean;
}

/** 认证集合的归属与类型，用于校验创建重试和删除目标。 */
interface Collection {
  id: string;
  name: string;
  type: string;
}

/** PocketBase 为当前集合返回的 Google 跳转地址和 PKCE 参数。 */
interface Provider {
  name: string;
  authURL: string;
  state: string;
  codeVerifier: string;
}

class PocketBaseError extends Error {
  constructor(readonly status: number) {
    super("PocketBase request failed");
  }
}

/** Only Harbor talks to PocketBase. Visitor calls never carry the superuser credential. */
export class PocketBaseAccounts {
  constructor(private options: VisitorAuthOptions) {}

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    admin = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.options.pocketbase + "/api/" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          ...(admin ? { Authorization: this.options.pocketbaseToken } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PocketBaseError(response.status);
    }
    try {
      return (response.status === 204 ? undefined : await response.json()) as T;
    } catch {
      fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    }
  }

  private async findCollection(name: string) {
    try {
      return await this.request<Collection>(
        "collections/" + name,
        "GET",
        undefined,
        true,
      );
    } catch (error) {
      if (!(error instanceof PocketBaseError) || error.status !== 404)
        throw error;
    }
  }

  /** 创建或更新指定环境的认证集合，并校验重试指向同一集合。 */
  async provision(
    name: string,
    expectedId: string | null,
    provider: VisitorProvider,
  ) {
    const existing = await this.findCollection(name);
    if (expectedId && existing?.id !== expectedId)
      fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
    if (existing && (existing.type !== "auth" || existing.name !== name))
      fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
    const password = provider === "email_password";
    const settings = {
      authRule: password ? "" : "verified = true",
      listRule: null,
      viewRule: null,
      updateRule: null,
      deleteRule: null,
      manageRule: null,
      createRule: password ? null : '@request.context = "oauth2"',
      passwordAuth: { enabled: password, identityFields: ["email"] },
      oauth2: password
        ? { enabled: false, providers: [] }
        : {
            enabled: true,
            providers: [
              {
                name: "google",
                clientId: this.options.googleId,
                clientSecret: this.options.googleSecret,
              },
            ],
          },
    };
    const collection = existing
      ? await this.request<Collection>(
          "collections/" + existing.id,
          "PATCH",
          settings,
          true,
        )
      : await this.request<Collection>(
          "collections",
          "POST",
          { ...settings, name, type: "auth" },
          true,
        );
    if (
      !/^[a-zA-Z0-9_]+$/.test(collection.id) ||
      collection.name !== name ||
      collection.type !== "auth"
    )
      fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
    return collection.id;
  }

  /** 仅在密码集合创建未验证账号，成功后由 Harbor 签发自己的会话。 */
  async register(collection: string, email: string, password: string) {
    try {
      const record = await this.request<PocketUser>(
        `collections/${collection}/records`,
        "POST",
        { email, password, passwordConfirm: password },
        true,
      );
      if (
        !record?.id ||
        record.collectionId !== collection ||
        record.email !== email ||
        record.verified !== false
      )
        fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
      return record;
    } catch (error) {
      if (error instanceof PocketBaseError && error.status === 400)
        fail(409, "APPLICATION_AUTH_REGISTRATION_REJECTED");
      throw error;
    }
  }

  async password(
    collection: string,
    identity: string,
    password: string,
    requireVerified = false,
  ) {
    return (
      await this.authenticate(
        collection,
        "auth-with-password",
        { identity, password },
        requireVerified,
      )
    ).record;
  }

  /** 在 PocketBase 生成的 PKCE 地址上填入平台唯一的 Google 回调地址。 */
  async googleStart(collection: string) {
    const result = await this.request<{ oauth2?: { providers: Provider[] } }>(
      `collections/${collection}/auth-methods`,
    );
    const provider = result.oauth2?.providers.find(
      (item) => item.name === "google",
    );
    if (!provider?.state || !provider.codeVerifier || !provider.authURL)
      fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    const url = new URL(provider.authURL);
    if (
      url.origin !== "https://accounts.google.com" ||
      url.searchParams.get("state") !== provider.state ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      !url.searchParams.get("code_challenge")
    )
      fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    url.searchParams.set("redirect_uri", this.callback);
    return {
      url: url.href,
      state: provider.state,
      verifier: provider.codeVerifier,
    };
  }

  async googleFinish(collection: string, code: string, codeVerifier: string) {
    const { record, meta } = await this.authenticate(
      collection,
      "auth-with-oauth2",
      {
        provider: "google",
        code,
        codeVerifier,
        redirectURL: this.callback,
      },
      true,
    );
    if (typeof meta?.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(meta.id))
      fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    return { record, subject: meta.id };
  }

  /** 旧 Google 账号仅按已绑定的 provider subject 找回，邮箱相同不会建立新绑定。 */
  async legacyGoogle(collection: string, subject: string) {
    const filter = encodeURIComponent(
      `collectionRef = ${JSON.stringify(collection)} && provider = "google" && providerId = ${JSON.stringify(subject)}`,
    );
    const result = await this.request<{ items: { recordRef: string }[] }>(
      `collections/_externalAuths/records?perPage=1&fields=recordRef&filter=${filter}`,
      "GET",
      undefined,
      true,
    );
    return result.items[0]
      ? this.user(collection, result.items[0].recordRef)
      : undefined;
  }

  private get callback() {
    return this.options.authOrigin + visitorPath + "/google/callback";
  }

  private async authenticate(
    collection: string,
    endpoint: string,
    body: object,
    requireVerified: boolean,
  ) {
    let result: { record: PocketUser; meta?: { id?: unknown } };
    try {
      result = await this.request<typeof result>(
        `collections/${collection}/${endpoint}`,
        "POST",
        body,
      );
    } catch (error) {
      if (
        error instanceof PocketBaseError &&
        [400, 401, 403].includes(error.status)
      )
        fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
      throw error;
    }
    const { record } = result;
    if (
      !record?.id ||
      record.collectionId !== collection ||
      (requireVerified && record.verified !== true) ||
      !record.email
    )
      fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    return result;
  }

  async users(collection: string, page: number) {
    return this.request<{ items: PocketUser[]; totalPages: number }>(
      `collections/${collection}/records?page=${page}&perPage=50&sort=id&fields=id,email,verified,collectionId`,
      "GET",
      undefined,
      true,
    );
  }

  async user(collection: string, id: string) {
    try {
      return await this.request<PocketUser>(
        `collections/${collection}/records/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        true,
      );
    } catch (error) {
      if (error instanceof PocketBaseError && error.status === 404)
        fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
      throw error;
    }
  }

  async remove(name: string, id: string | null) {
    const existing = await this.findCollection(name);
    if (!existing) return;
    if (
      existing.type !== "auth" ||
      existing.name !== name ||
      (id && existing.id !== id)
    )
      fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
    await this.request("collections/" + existing.id, "DELETE", undefined, true);
  }
}
