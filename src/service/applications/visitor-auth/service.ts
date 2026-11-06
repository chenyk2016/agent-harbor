import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import type { Pool } from "pg";
import { BetterVisitorAccounts, visitorRealm } from "./better-auth.js";
import { sql, type SQL } from "drizzle-orm";
import type { Database, Tx } from "../../db/client.js";
import { fail, ServiceError } from "../../types.js";
import type { AppEnvironment } from "../data.js";
import { requireAppId } from "../source-store.js";
import { visitorOrigin, type VisitorAuthOptions } from "./config.js";
import { PocketBaseAccounts, type PocketUser } from "./pocketbase.js";
import { visitorProviders, type VisitorProvider } from "./policy.js";

export const sessionCookie = "__Host-ah_app";
export const appFlowCookie = "__Host-ah_app_flow";
export const authFlowCookie = "__Host-ah_auth_flow";
export const sessionSeconds = 8 * 3600;
export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** 应用与环境对应的私有账号集合及登录设置。 */
interface Scope {
  id: string;
  app_id: string;
  environment: AppEnvironment;
  backend: "pocketbase" | "better_auth";
  collection_name: string;
  collection_id: string | null;
  password_collection_id: string | null;
  google_collection_id: string | null;
  origin: string;
  enabled: boolean;
}

/** 托管登录只使用已确认部署的登录方式。 */
interface LiveScope extends Scope {
  providers: readonly VisitorProvider[];
}

/** 一次注册或登录流程的服务端绑定。回跳路径和 PKCE verifier 不由浏览器决定。 */
interface Flow extends Scope {
  flow_hash: string;
  return_path: string;
  code_verifier: string | null;
}

/** Harbor 内部访客编号与 PocketBase 记录的映射，同时记录停用状态。 */
interface Member {
  id: string;
  record_id: string;
  collection_id: string;
  google_alias_record_id: string | null;
  disabled_at: Date | null;
}

/** PocketBase owns credentials. Harbor owns application membership status and revocable sessions. */
export class VisitorAuthService {
  readonly accounts: PocketBaseAccounts;
  private readonly better?: BetterVisitorAccounts;

  constructor(
    readonly db: Database,
    readonly options: VisitorAuthOptions,
  ) {
    this.accounts = new PocketBaseAccounts(options);
    if (options.betterAuth) this.better = new BetterVisitorAccounts((db as Database & { $client: Pool }).$client, options);
  }

  private betterAccounts() {
    if (!this.better) fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    return this.better;
  }

  private readAccounts(scope: Scope) {
    return scope.backend === "better_auth" ? this.betterAccounts() : this.accounts;
  }

  private async rows<T>(query: SQL, db: Database | Tx = this.db) {
    return (await db.execute(query)).rows as T[];
  }

  async scope(
    appId: string,
    environment: AppEnvironment,
    db: Database | Tx = this.db,
  ) {
    return (
      await this.rows<Scope>(
        sql`SELECT * FROM app_auth_scopes
      WHERE app_id=${appId} AND environment=${environment}`,
        db,
      )
    )[0];
  }

  availableProviders(environment: AppEnvironment, backend = this.options.defaultBackend ?? "pocketbase"): VisitorProvider[] {
    if (backend === "better_auth" && !this.better) return [];
    const google = backend === "better_auth"
      ? this.better?.googleAvailable(environment)
      : this.options.googleId && this.options.googleSecret;
    return google ? [...visitorProviders] : ["email_password"];
  }

  /** 准备固定的环境账号集合。候选实例不会提前改变当前入口的登录设置。 */
  async provision(
    appId: string,
    owner: string,
    environment: AppEnvironment,
    providers: VisitorProvider[],
  ) {
    requireAppId(appId);
    const name =
      "ah_" +
      appId.replaceAll("-", "") +
      (environment === "preview" ? "_p" : "_r");
    const origin = visitorOrigin(this.options.appDomain, appId, environment);
    // 先保留确定的名称，远程请求超时后仍可查重或清理。
    await this.db.transaction(async (tx) => {
      await this.lockApp(tx, appId, owner);
      await tx.execute(sql`INSERT INTO app_auth_scopes(id,app_id,environment,collection_name,origin,backend)
        VALUES(${randomUUID()},${appId},${environment},${name},${origin},${this.options.defaultBackend ?? "pocketbase"})
        ON CONFLICT (app_id,environment) DO NOTHING`);
    });
    await this.db.transaction(async (tx) => {
      await this.lockApp(tx, appId, owner);
      const scope = (await this.scope(appId, environment, tx))!;
      if (scope.origin !== origin) fail(409, "APPLICATION_AUTH_ORIGIN_CHANGED");
      for (const provider of providers)
        await this.providerCollection(scope, provider, tx, true);
    });
    return { origin, publicKey: this.options.publicKey, providers,
      previewParentOrigin: environment === "preview" ? this.options.workbenchOrigin : undefined };
  }

  /** 每种登录方式只写自己的集合。确定性名称让未确认的远程创建可以安全重试。 */
  private async providerCollection(
    scope: Scope,
    provider: VisitorProvider,
    tx: Tx,
    refresh = false,
  ) {
    const password = provider === "email_password";
    const existing = password
      ? scope.password_collection_id
      : scope.google_collection_id;
    if (existing && !refresh) return existing;
    let collection: string;
    if (scope.backend === "better_auth") {
      if (!password && !this.betterAccounts().googleAvailable(scope.environment))
        fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
      this.betterAccounts();
      collection = visitorRealm(scope.id, provider);
      if (existing && existing !== collection) fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
      if (!existing) await tx.execute(sql`SELECT ah_create_visitor_realm(${collection})`);
    } else {
      if (!password && (!this.options.googleId || !this.options.googleSecret))
        fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
      collection = await this.accounts.provision(
        scope.collection_name + (password ? "_email" : "_google"),
        existing,
        provider,
      );
    }
    const column = password
      ? sql`password_collection_id`
      : sql`google_collection_id`;
    await tx.execute(
      sql`UPDATE app_auth_scopes SET ${column}=${collection} WHERE id=${scope.id}`,
    );
    return collection;
  }

  private async lockApp(tx: Tx, appId: string, owner?: string) {
    const [app] = await this.rows<{ ownerId: string; status: string }>(
      sql`SELECT "ownerId",status FROM applications WHERE id=${appId} FOR UPDATE`,
      tx,
    );
    if (!app || (owner !== undefined && app.ownerId !== owner))
      fail(404, "APPLICATION_NOT_FOUND");
    if (app.status !== "active") fail(409, "APPLICATION_NOT_ACTIVE");
  }

  /** The published deployment is the authority for the effective policy, including during a route switch. */
  async live(
    appId: string,
    environment: AppEnvironment,
    host: string,
    deploymentId?: string,
    db: Database | Tx = this.db,
  ): Promise<LiveScope> {
    const [scope] = await this.rows<
      Scope & { active_providers: VisitorProvider[] | null }
    >(
      sql`
      SELECT s.*, d.spec->'visitorAuth'->'providers' AS active_providers FROM app_auth_scopes s
      JOIN applications a ON a.id=s.app_id AND a.status='active'
      JOIN app_endpoints e ON e."appId"=s.app_id AND e.environment=s.environment
      JOIN app_deployments d ON d.id IN (e."desiredDeploymentId", e."appliedDeploymentId")
        AND d."appId"=s.app_id AND d.environment=s.environment
        AND d.spec->'visitorAuth'->>'origin'=s.origin
      WHERE s.app_id=${appId} AND s.environment=${environment}
        AND e.state IN ('ready','switching')
        AND COALESCE(s.collection_id,s.password_collection_id,s.google_collection_id) IS NOT NULL
        ${deploymentId ? sql`AND d.id=${deploymentId}` : sql`AND d.id=e."appliedDeploymentId"`}
      LIMIT 1`,
      db,
    );
    if (!scope || new URL(scope.origin).host !== host)
      fail(404, "APPLICATION_AUTH_NOT_AVAILABLE");
    return { ...scope, providers: scope.active_providers ?? visitorProviders };
  }

  /** 加载当前部署并拒绝关闭的方式，包括直接调用和旧回调。 */
  private async requireProvider(
    scope: Scope,
    provider: VisitorProvider,
    db: Database | Tx = this.db,
  ) {
    const active = await this.live(
      scope.app_id,
      scope.environment,
      new URL(scope.origin).host,
      undefined,
      db,
    );
    if (!active.providers.includes(provider))
      fail(403, "APPLICATION_AUTH_PROVIDER_DISABLED");
    return active;
  }

  /** 创建十五分钟握手，并绑定发起登录的应用浏览器。 */
  async start(scope: Scope, browser: string, returnPath: string) {
    const flow = randomToken();
    await this.db
      .execute(sql`INSERT INTO app_auth_flows(flow_hash,scope_id,app_browser_hash,return_path,expires_at)
      VALUES(${hash(flow)},${scope.id},${hash(browser)},${returnPath},now()+interval '15 minutes')`);
    return flow;
  }

  /** 让首次访问托管页的浏览器绑定握手，之后仅接受同一浏览器提交。 */
  async open(flow: string, browser: string) {
    const [row] = await this.rows<Flow>(sql`WITH bound AS (
      UPDATE app_auth_flows SET auth_browser_hash=${hash(browser)}
      WHERE flow_hash=${hash(flow)} AND expires_at>now() AND handoff_hash IS NULL
        AND (auth_browser_hash IS NULL OR auth_browser_hash=${hash(browser)}) RETURNING *
      ) SELECT s.*,b.flow_hash,b.return_path,b.code_verifier
      FROM bound b JOIN app_auth_scopes s ON s.id=b.scope_id`);
    if (!row) fail(400, "APPLICATION_AUTH_LINK_INVALID");
    const active = await this.live(
      row.app_id,
      row.environment,
      new URL(row.origin).host,
    );
    return { ...row, providers: active.providers };
  }

  /** 注册完成后走同一条一次性交接链路，密码和 PocketBase 凭据留在服务端。 */
  private async betterPassword(scope: Scope, flow: Flow, email: string, password: string, register: boolean) {
    if (!scope.password_collection_id) fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    const user = await this.betterAccounts().credentials(scope.password_collection_id, scope.environment, email, password, register);
    return this.db.transaction(async (tx) => {
      await this.lockApp(tx, scope.app_id);
      return this.handoff(flow, user, "email_password", tx);
    });
  }

  async register(flow: Flow, email: string, password: string) {
    if (flow.backend === "better_auth")
      return this.betterPassword(await this.requireProvider(flow, "email_password"), flow, email, password, true);
    return this.db.transaction(async (tx) => {
      await this.lockApp(tx, flow.app_id);
      const scope = await this.requireProvider(flow, "email_password", tx);
      const collection = await this.providerCollection(
        scope,
        "email_password",
        tx,
      );
      const user = await this.accounts.register(collection, email, password);
      return this.handoff(flow, user, "email_password", tx);
    });
  }

  async password(flow: Flow, email: string, password: string) {
    const scope = await this.requireProvider(flow, "email_password");
    if (scope.backend === "better_auth") return this.betterPassword(scope, flow, email, password, false);
    if (scope.password_collection_id) {
      const user = await this.accounts
        .password(scope.password_collection_id, email, password)
        .catch((error: unknown) => {
          if (!(
            error instanceof ServiceError &&
            error.code === "APPLICATION_AUTH_LOGIN_FAILED"
          ))
            throw error;
        });
      if (user) return this.handoff(flow, user, "email_password");
    }
    // 已验证的旧密码仍可登录原来的应用身份，不复制旧凭据到新集合。
    if (!scope.collection_id) fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    const user = await this.accounts.password(
      scope.collection_id,
      email,
      password,
      true,
    );
    return this.handoff(flow, user, "email_password");
  }

  async googleStart(flow: Flow) {
    if (flow.backend === "better_auth") {
      const scope = await this.requireProvider(flow, "google");
      if (!scope.google_collection_id) fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
      const google = await this.betterAccounts().googleStart(scope.google_collection_id, scope.environment);
      return this.storeGoogleFlow(flow, google);
    }
    return this.db.transaction(async (tx) => {
      await this.lockApp(tx, flow.app_id);
      const scope = await this.requireProvider(flow, "google", tx);
      const collection = await this.providerCollection(scope, "google", tx);
      const google = await this.accounts.googleStart(collection);
      return this.storeGoogleFlow(flow, google, tx);
    });
  }

  private async storeGoogleFlow(flow: Flow, google: { state: string; verifier: string; url: string }, db: Database | Tx = this.db) {
    const rows = await this.rows(sql`UPDATE app_auth_flows
      SET state_hash=${hash(google.state)},code_verifier=${google.verifier}
      WHERE flow_hash=${flow.flow_hash} AND expires_at>now() AND handoff_hash IS NULL RETURNING flow_hash`, db);
    if (!rows.length) fail(400, "APPLICATION_AUTH_LINK_INVALID");
    return google.url;
  }

  /** 先消费回调再做 OAuth 交换，历史账号只沿用已经绑定的 Google 身份。 */
  async googleFinish(state: string, code: string, browser: string, backend: Scope["backend"] = "pocketbase") {
    const [flow] = await this.rows<Flow>(sql`WITH consumed AS (
      UPDATE app_auth_flows SET state_hash=NULL
      WHERE state_hash=${hash(state)} AND auth_browser_hash=${hash(browser)} AND expires_at>now()
        AND handoff_hash IS NULL AND EXISTS(SELECT 1 FROM app_auth_scopes
          WHERE id=scope_id AND backend=${backend}) RETURNING *
      ) SELECT s.*,c.flow_hash,c.return_path,c.code_verifier
      FROM consumed c JOIN app_auth_scopes s ON s.id=c.scope_id`);
    if (!flow?.code_verifier) fail(400, "APPLICATION_AUTH_LINK_INVALID");
    if (flow.backend === "better_auth") {
      const scope = await this.requireProvider(flow, "google");
      if (!scope.google_collection_id) fail(503, "APPLICATION_AUTH_GOOGLE_UNAVAILABLE");
      const user = await this.betterAccounts().googleFinish(
        scope.google_collection_id, scope.environment, state, code, flow.code_verifier);
      return this.db.transaction(async (tx) => {
        await this.lockApp(tx, scope.app_id);
        return this.handoff(flow, user, "google", tx);
      });
    }
    const location = await this.db.transaction(async (tx) => {
      await this.lockApp(tx, flow.app_id);
      const scope = await this.requireProvider(flow, "google", tx);
      const collection = await this.providerCollection(scope, "google", tx);
      const { record, subject } = await this.accounts.googleFinish(
        collection,
        code,
        flow.code_verifier!,
      );
      if (scope.collection_id) {
        const [alias] = await this.rows<Member>(
          sql`SELECT * FROM app_auth_users
          WHERE scope_id=${scope.id} AND collection_id=${scope.collection_id} AND google_alias_record_id=${record.id}`,
          tx,
        );
        const legacy = alias
          ? await this.accounts.user(scope.collection_id, alias.record_id)
          : await this.accounts.legacyGoogle(scope.collection_id, subject);
        if (legacy)
          return this.handoff(flow, legacy, "google", tx, record.id).catch(
            (error: unknown) => {
              // 停用账号也保留已存在的关联，账号列表不会多出一条镜像记录。
              if (!(
                error instanceof ServiceError &&
                error.code === "APPLICATION_AUTH_USER_DISABLED"
              ))
                throw error;
            },
          );
      }
      return this.handoff(flow, record, "google", tx);
    });
    if (!location) fail(403, "APPLICATION_AUTH_USER_DISABLED");
    return location;
  }

  private async member(
    scope: Scope,
    user: PocketUser,
    db: Database | Tx,
    googleAlias?: string,
  ) {
    const [member] = await this.rows<Member>(
      sql`INSERT INTO app_auth_users(id,scope_id,collection_id,record_id,google_alias_record_id)
      VALUES(${randomUUID()},${scope.id},${user.collectionId},${user.id},${googleAlias ?? null})
      ON CONFLICT(scope_id,collection_id,record_id) DO UPDATE
      SET google_alias_record_id=COALESCE(excluded.google_alias_record_id,app_auth_users.google_alias_record_id)
      RETURNING *`,
      db,
    );
    return member;
  }

  private async handoff(
    flow: Flow,
    user: PocketUser,
    provider: VisitorProvider,
    db: Database | Tx = this.db,
    googleAlias?: string,
  ) {
    const scope = await this.requireProvider(flow, provider, db);
    const dedicated =
      provider === "google"
        ? scope.google_collection_id
        : scope.password_collection_id;
    if (
      !user.id ||
      !user.email ||
      (user.collectionId !== dedicated &&
        user.collectionId !== scope.collection_id) ||
      ((provider === "google" || user.collectionId === scope.collection_id) &&
        !user.verified)
    )
      fail(401, "APPLICATION_AUTH_LOGIN_FAILED");
    const member = await this.member(scope, user, db, googleAlias);
    if (member.disabled_at) fail(403, "APPLICATION_AUTH_USER_DISABLED");
    const code = randomToken();
    const rows = await this.rows(
      sql`UPDATE app_auth_flows
      SET handoff_hash=${hash(code)},handoff_provider=${provider},user_id=${member.id},state_hash=NULL,code_verifier=NULL,
        expires_at=now()+interval '60 seconds'
      WHERE flow_hash=${flow.flow_hash} AND expires_at>now() AND handoff_hash IS NULL RETURNING flow_hash`,
      db,
    );
    if (!rows.length) fail(400, "APPLICATION_AUTH_LINK_INVALID");
    const path = this.base(flow) + "__harbor/auth/finish";
    return flow.origin + path + "?ticket=" + code;
  }

  base(scope: Pick<Scope, "app_id" | "environment">) {
    return `/${scope.environment === "preview" ? "preview" : "apps"}/${scope.app_id}/`;
  }

  /** 仅在原应用与原浏览器消费交接码，同时替换旧会话。 */
  async finish(
    scope: Scope,
    code: string,
    browser: string,
    previousToken?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockApp(tx, scope.app_id);
      const [flow] = await this.rows<{
        user_id: string;
        return_path: string;
        handoff_provider: VisitorProvider | null;
      }>(
        sql`DELETE FROM app_auth_flows
        WHERE handoff_hash=${hash(code)} AND scope_id=${scope.id}
          AND app_browser_hash=${hash(browser)} AND expires_at>now() RETURNING user_id,return_path,handoff_provider`,
        tx,
      );
      if (!flow?.handoff_provider) fail(400, "APPLICATION_AUTH_LINK_INVALID");
      await this.requireProvider(scope, flow.handoff_provider, tx);
      const [member] = await this.rows<Member>(
        sql`SELECT * FROM app_auth_users
        WHERE id=${flow.user_id} AND scope_id=${scope.id} FOR UPDATE`,
        tx,
      );
      if (!member || member.disabled_at)
        fail(403, "APPLICATION_AUTH_USER_DISABLED");
      if (previousToken) await this.logout(scope, previousToken, tx);
      const token = randomToken();
      await tx.execute(sql`INSERT INTO app_auth_sessions(token_hash,user_id,expires_at)
        VALUES(${hash(token)},${member.id},now()+interval '8 hours')`);
      return { token, returnPath: flow.return_path };
    });
  }

  /** 从哈希查询当前范围内未过期且未停用的会话。 */
  async session(scope: Scope, token: string) {
    const [user] = await this
      .rows<Member>(sql`SELECT u.* FROM app_auth_sessions s
      JOIN app_auth_users u ON u.id=s.user_id
      WHERE s.token_hash=${hash(token)} AND u.scope_id=${scope.id}
        AND u.disabled_at IS NULL AND s.expires_at>now()`);
    if (!user) fail(401, "APPLICATION_AUTH_REQUIRED");
    return user;
  }

  /** 从已绑定的集合读访客资料，未验证邮箱的状态留在服务端。 */
  async profile(scope: Scope, member: Member) {
    if (
      ![
        scope.collection_id,
        scope.password_collection_id,
        scope.google_collection_id,
      ].includes(member.collection_id)
    )
      fail(401, "APPLICATION_AUTH_REQUIRED");
    const user = await this.readAccounts(scope).user(
      member.collection_id,
      member.record_id,
    );
    if (
      user.collectionId !== member.collection_id ||
      !user.email ||
      (member.collection_id !== scope.password_collection_id && !user.verified)
    )
      fail(401, "APPLICATION_AUTH_REQUIRED");
    return { id: member.id, email: user.email };
  }

  async logout(scope: Scope, token: string, db: Database | Tx = this.db) {
    await db.execute(sql`DELETE FROM app_auth_sessions s USING app_auth_users u
      WHERE s.user_id=u.id AND u.scope_id=${scope.id} AND s.token_hash=${hash(token)}`);
  }

  /** 签发十五秒身份断言，运行器只接收与自身部署一致的访客身份。 */
  assertion(scope: Scope, deployment: string, member: Member) {
    const body = Buffer.from(
      JSON.stringify({
        appId: scope.app_id,
        environment: scope.environment,
        deploymentId: deployment,
        userId: member.id,
        expires: Date.now() + 15000,
      }),
    ).toString("base64url");
    return (
      body +
      "." +
      sign(null, Buffer.from(body), this.options.signingKey).toString(
        "base64url",
      )
    );
  }

  /** 分页展示各集合。复用历史身份的 Google 镜像记录不会显示为另一个用户。 */
  async users(scope: Scope, page: number) {
    const collections = [
      scope.password_collection_id,
      scope.google_collection_id,
      scope.collection_id,
    ].filter((id): id is string => !!id);
    const accounts = this.readAccounts(scope);
    const results = await Promise.all(
      collections.map((id) => accounts.users(id, 1)),
    );
    const totalPages = results.reduce(
      (total, result) => total + result.totalPages,
      0,
    );
    let offset = page;
    for (const [index, first] of results.entries()) {
      if (offset > first.totalPages) {
        offset -= first.totalPages;
        continue;
      }
      const collection = collections[index];
      const result =
        offset === 1 ? first : await accounts.users(collection, offset);
      if (!result.items.length) break;
      const records = sql.join(
        result.items.map((user) => sql`${user.id}`),
        sql`, `,
      );
      const local = await this
        .rows<Member>(sql`SELECT * FROM app_auth_users WHERE scope_id=${scope.id}
        AND (collection_id=${collection} AND record_id IN (${records})
          OR ${collection}=${scope.google_collection_id} AND google_alias_record_id IN (${records}))`);
      const states = new Map(
        local
          .filter((user) => user.collection_id === collection)
          .map((user) => [user.record_id, user.disabled_at]),
      );
      const mirrors = new Set(local.map((user) => user.google_alias_record_id));
      const method =
        collection === scope.password_collection_id
          ? "email_password"
          : collection === scope.google_collection_id
            ? "google"
            : "legacy";
      return {
        totalPages,
        items: result.items
          .filter((user) => method !== "google" || !mirrors.has(user.id))
          .map((user) => ({
            id: collection + "." + user.id,
            email: user.email,
            method,
            disabled: !!states.get(user.id),
          })),
      };
    }
    return { items: [], totalPages };
  }

  /** 更改账号状态。停用、会话撤销及审计必须一起提交。 */
  async disable(
    scope: Scope,
    owner: string,
    identifier: string,
    disabled: boolean,
  ) {
    await this.db.transaction(async (tx) => {
      await this.lockApp(tx, scope.app_id, owner);
      const [first, second] = identifier.split(".");
      const collection = second ? first : scope.collection_id;
      const recordId = second ?? first;
      if (
        !collection ||
        ![
          scope.collection_id,
          scope.password_collection_id,
          scope.google_collection_id,
        ].includes(collection)
      )
        fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
      if (
        collection === scope.google_collection_id &&
        (
          await this.rows<Member>(
            sql`SELECT id FROM app_auth_users
        WHERE scope_id=${scope.id} AND google_alias_record_id=${recordId}`,
            tx,
          )
        ).length
      )
        fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
      const user = scope.backend === "better_auth"
        ? await this.betterAccounts().user(collection, recordId, tx)
        : await this.accounts.user(collection, recordId);
      if (user.collectionId !== collection || user.id !== recordId)
        fail(404, "APPLICATION_AUTH_USER_NOT_FOUND");
      const member = await this.member(scope, user, tx);
      await tx.execute(sql`UPDATE app_auth_users SET disabled_at=${disabled ? sql`now()` : sql`NULL`}
        WHERE id=${member.id}`);
      if (disabled)
        await tx.execute(
          sql`DELETE FROM app_auth_sessions WHERE user_id=${member.id}`,
        );
      await tx.execute(
        sql`UPDATE applications SET "lastEventId"="lastEventId"+1 WHERE id=${scope.app_id}`,
      );
      await tx.execute(sql`INSERT INTO app_events("appId","eventId",type,payload,"createdAt")
        SELECT id,"lastEventId",'visitor.user_status',${JSON.stringify({ environment: scope.environment, id: member.id, disabled })}::jsonb,
          ${Date.now()} FROM applications WHERE id=${scope.app_id}`);
    });
  }

  async cleanupExpired() {
    await this.db.execute(
      sql`DELETE FROM app_auth_flows WHERE expires_at <= now()`,
    );
    await this.db.execute(
      sql`DELETE FROM app_auth_sessions WHERE expires_at <= now()`,
    );
  }

  /** 永久删除应用时仅清理该应用预览和正式环境的集合。 */
  async remove(appId: string) {
    for (const environment of ["preview", "production"] as const) {
      const scope = await this.scope(appId, environment);
      if (!scope) continue;
      if (scope.backend === "better_auth") {
        for (const provider of visitorProviders) {
          const recorded = provider === "google" ? scope.google_collection_id : scope.password_collection_id;
          if (!recorded) continue;
          if (recorded !== visitorRealm(scope.id, provider)) fail(503, "APPLICATION_AUTH_COLLECTION_MISMATCH");
          await this.betterAccounts().remove(recorded);
        }
        continue;
      }
      await this.accounts.remove(
        scope.collection_name + "_email",
        scope.password_collection_id,
      );
      await this.accounts.remove(
        scope.collection_name + "_google",
        scope.google_collection_id,
      );
      await this.accounts.remove(scope.collection_name, scope.collection_id);
    }
  }
}
