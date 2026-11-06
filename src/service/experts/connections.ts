/** 按用户保存MCP授权。包中只有声明，凭据密文与专家原件分开。 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "../db/client.js";
import { expertConnections } from "../db/schema/index.js";
import type { WorkBuddyPackage } from "../../shared/experts.js";
import { digest } from "../skills/service.js";
import { fail } from "../types.js";
import { localized } from "./workbuddy.js";
interface Credentials {
  values?: Record<string, string>;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  oauthOrigin?: string;
  client?: OAuthClientInformationMixed;
  verifier?: string;
  state?: string;
  expiresAt?: number;
  ready?: boolean;
}
interface ConnectionDefinition {
  key: string;
  name: string;
  config: Record<string, unknown>;
  auth: Record<string, unknown>;
}
export class ExpertConnectionService {
  private keyPromise?: Promise<Buffer>;
  private writes = new Map<string, Promise<void>>();
  private async serial<T>(user: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(user) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writes.set(user, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.writes.get(user) === current) this.writes.delete(user);
    }
  }
  constructor(
    readonly db: Database,
    readonly root: string,
  ) {}
  private key() {
    return (this.keyPromise ??= this.loadKey());
  }
  private async loadKey() {
    const path = join(this.root, ".connection-key");
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32),
      temp = `${path}.${randomUUID()}`;
    await writeFile(temp, key, { mode: 0o600 });
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temp, { force: true });
    }
    return readFile(path);
  }
  private async seal(value: Credentials) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private async open(value: string): Promise<Credentials> {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv(
        "aes-256-gcm",
        await this.key(),
        data.subarray(0, 12),
      );
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  private async providers(): Promise<Record<string, Record<string, unknown>>> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "connector-providers.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      fail(503, "CONNECTOR_CATALOG_INVALID");
    }
  }
  async missing(bundle: WorkBuddyPackage) {
    const providers = await this.providers();
    return bundle.connectors.filter((id) => !providers[id]);
  }
  async definitions(bundle: WorkBuddyPackage): Promise<ConnectionDefinition[]> {
    const providers = await this.providers();
    const servers = {
      ...bundle.mcpServers,
      ...Object.fromEntries(
        bundle.connectors
          .filter((id) => providers[id])
          .map((id) => [`connector-${id}`, providers[id]]),
      ),
    };
    return Object.entries(servers).map(([name, config]) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) fail(400, "INVALID_MCP_NAME");
      const meta = config["x-workbuddy"] as Record<string, unknown> | undefined;
      return {
        name,
        config,
        key: digest(config),
        auth: (meta?.auth ?? { type: "none" }) as Record<string, unknown>,
      };
    });
  }
  private async row(user: string, definition: ConnectionDefinition) {
    const [row] = await this.db
      .select()
      .from(expertConnections)
      .where(
        and(
          eq(expertConnections.userId, user),
          eq(expertConnections.definitionHash, definition.key),
          eq(expertConnections.name, definition.name),
        ),
      );
    return row;
  }
  async network(user: string, bundle: WorkBuddyPackage, domains?: string[]) {
    const definition = {
      name: "__network__",
      key: bundle.archiveHash,
      config: {},
      auth: {},
    };
    const row = await this.row(user, definition);
    if (domains !== undefined) {
      if (
        domains.length > 64 ||
        domains.some(
          (domain) => !/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(domain),
        )
      )
        fail(400, "INVALID_NETWORK_DOMAINS");
      await this.persist(user, definition, row?.id ?? randomUUID(), {
        values: { domains: JSON.stringify([...new Set(domains)]) },
        ready: true,
      });
      return [...new Set(domains)];
    }
    return row
      ? (JSON.parse(
          (await this.open(row.sealed)).values?.domains ?? "[]",
        ) as string[])
      : [];
  }
  async status(user: string, bundle: WorkBuddyPackage) {
    return Promise.all(
      (await this.definitions(bundle)).map(async (definition) => {
        const row = await this.row(user, definition),
          credentials = row ? await this.open(row.sealed) : {};
        const meta = definition.config["x-workbuddy"] as
          Record<string, unknown> | undefined;
        return {
          name: definition.name,
          displayName: localized(meta?.displayName, definition.name),
          description: localized(meta?.description),
          auth: definition.auth,
          ready: credentials.ready === true,
          url: definition.config.url,
        };
      }),
    );
  }
  private async persist(
    user: string,
    definition: ConnectionDefinition,
    id: string,
    credentials: Credentials,
  ) {
    await this.db
      .insert(expertConnections)
      .values({
        id,
        userId: user,
        definitionHash: definition.key,
        name: definition.name,
        sealed: await this.seal(credentials),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [
          expertConnections.userId,
          expertConnections.definitionHash,
          expertConnections.name,
        ],
        set: { sealed: await this.seal(credentials), updatedAt: Date.now() },
      });
  }
  private headers(definition: ConnectionDefinition, credentials: Credentials) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (definition.config.headers as Record<string, unknown>) ?? {},
    )) {
      if (typeof value !== "string") fail(400, "INVALID_MCP_HEADERS");
      result[key] = value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        const value = credentials.values?.[key];
        if (!value) fail(409, "MCP_TOKEN_REQUIRED");
        return value;
      });
    }
    if (credentials.tokens)
      result.Authorization = `Bearer ${credentials.tokens.access_token}`;
    return result;
  }
  private url(definition: ConnectionDefinition) {
    if (typeof definition.config.url !== "string")
      fail(409, "MCP_TRANSPORT_UNSUPPORTED");
    const url = new URL(definition.config.url);
    if (!["http:", "https:"].includes(url.protocol))
      fail(400, "INVALID_MCP_URL");
    return url;
  }
  private transport(
    definition: ConnectionDefinition,
    credentials: Credentials,
    provider?: OAuthClientProvider,
  ) {
    const options = {
      requestInit: { headers: this.headers(definition, credentials) },
      authProvider: provider,
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(this.headers(definition, credentials));
        new Headers(init?.headers).forEach((value, key) =>
          headers.set(key, value),
        );
        return fetch(url, {
          ...init,
          headers,
          signal: AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
      },
    };
    return definition.config.type === "sse"
      ? new SSEClientTransport(this.url(definition), options)
      : new StreamableHTTPClientTransport(this.url(definition), options);
  }
  private provider(
    origin: string,
    id: string,
    credentials: Credentials,
    onRedirect: (url: URL) => void,
  ): OAuthClientProvider {
    const redirectUrl = `${origin}/api/expert-oauth/callback`;
    return {
      redirectUrl,
      clientMetadata: {
        client_name: "Agent Harbor",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => credentials.state!,
      clientInformation: () => credentials.client,
      saveClientInformation: (value) => {
        credentials.client = value;
      },
      tokens: () => credentials.tokens,
      saveTokens: (value) => {
        credentials.tokens = value;
        credentials.tokenExpiresAt =
          typeof value.expires_in === "number"
            ? Date.now() + value.expires_in * 1000
            : undefined;
      },
      redirectToAuthorization: onRedirect,
      saveCodeVerifier: (value) => {
        credentials.verifier = value;
      },
      codeVerifier: () => {
        if (!credentials.verifier) fail(409, "MCP_OAUTH_EXPIRED");
        return credentials.verifier;
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "tokens")
          credentials.tokens = undefined;
        if (scope === "all" || scope === "client")
          credentials.client = undefined;
      },
    };
  }
  connect(
    user: string,
    bundle: WorkBuddyPackage,
    name: string,
    values: Record<string, string>,
    origin: string,
  ) {
    return this.serial(user, () =>
      this.connectIn(user, bundle, name, values, origin),
    );
  }
  private async connectIn(
    user: string,
    bundle: WorkBuddyPackage,
    name: string,
    values: Record<string, string>,
    origin: string,
  ) {
    const definition = (await this.definitions(bundle)).find(
      (item) => item.name === name,
    );
    if (!definition) fail(404, "MCP_NOT_FOUND");
    const row = await this.row(user, definition),
      id = row?.id ?? randomUUID(),
      credentials = row ? await this.open(row.sealed) : {};
    credentials.ready = false;
    credentials.oauthOrigin = origin;
    if (definition.auth.type === "token") {
      const schema = definition.auth.tokenSchema as
        { fields?: { key: string; required?: boolean }[] } | undefined;
      credentials.values = Object.fromEntries(
        (schema?.fields ?? []).map((field) => {
          if (field.required && !values[field.key])
            fail(400, "MCP_TOKEN_REQUIRED");
          return [field.key, values[field.key] ?? ""];
        }),
      );
    }
    let authorizationUrl: string | undefined;
    credentials.state = `${id}.${randomBytes(24).toString("hex")}`;
    credentials.expiresAt = Date.now() + 10 * 60000;
    const provider =
      definition.auth.type === "oauth"
        ? this.provider(origin, id, credentials, (url) => {
            authorizationUrl = url.href;
          })
        : undefined;
    const transport = this.transport(definition, credentials, provider),
      client = new Client({ name: "agent-harbor", version: "0.8.0" });
    try {
      await client.connect(transport, { timeout: 15000 });
      await client.listTools(undefined, { timeout: 15000 });
      credentials.ready = true;
    } catch (error) {
      if (!authorizationUrl) fail(409, "MCP_CONNECTION_FAILED");
    } finally {
      await client.close().catch(() => {});
    }
    await this.persist(user, definition, id, credentials);
    return { ready: credentials.ready, authorizationUrl };
  }
  finish(
    user: string,
    bundles: WorkBuddyPackage[],
    state: string,
    code: string,
    origin: string,
  ) {
    return this.serial(user, () =>
      this.finishIn(user, bundles, state, code, origin),
    );
  }
  private async finishIn(
    user: string,
    bundles: WorkBuddyPackage[],
    state: string,
    code: string,
    origin: string,
  ) {
    const id = state.split(".")[0];
    const [row] = await this.db
      .select()
      .from(expertConnections)
      .where(
        and(eq(expertConnections.id, id), eq(expertConnections.userId, user)),
      );
    if (!row) fail(404, "MCP_NOT_FOUND");
    const credentials = await this.open(row.sealed),
      expected = Buffer.from(credentials.state ?? ""),
      received = Buffer.from(state);
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received) ||
      (credentials.expiresAt ?? 0) < Date.now()
    )
      fail(409, "MCP_OAUTH_EXPIRED");
    const definition = (
      await Promise.all(bundles.map((bundle) => this.definitions(bundle)))
    )
      .flat()
      .find(
        (item) => item.key === row.definitionHash && item.name === row.name,
      );
    if (!definition) fail(404, "MCP_NOT_FOUND");
    const provider = this.provider(origin, id, credentials, () => {}),
      transport = this.transport(definition, credentials, provider);
    try {
      await transport.finishAuth(code);
      credentials.ready = true;
      credentials.state = undefined;
      credentials.verifier = undefined;
      await this.persist(user, definition, id, credentials);
    } catch {
      fail(409, "MCP_OAUTH_FAILED");
    } finally {
      await transport.close().catch(() => {});
    }
  }
  disconnect(user: string, bundle: WorkBuddyPackage, name: string) {
    return this.serial(user, () => this.disconnectIn(user, bundle, name));
  }
  private async disconnectIn(
    user: string,
    bundle: WorkBuddyPackage,
    name: string,
  ) {
    const definition = (await this.definitions(bundle)).find(
      (item) => item.name === name,
    );
    if (!definition) fail(404, "MCP_NOT_FOUND");
    await this.db
      .delete(expertConnections)
      .where(
        and(
          eq(expertConnections.userId, user),
          eq(expertConnections.definitionHash, definition.key),
          eq(expertConnections.name, name),
        ),
      );
  }
  async runtime(
    user: string,
    bundle: WorkBuddyPackage,
  ): Promise<Record<string, McpServerConfig>> {
    if ((await this.missing(bundle)).length)
      fail(409, "WORKBUDDY_CONNECTOR_UNAVAILABLE");
    const result: Record<string, McpServerConfig> = {};
    for (const definition of await this.definitions(bundle)) {
      const row = await this.row(user, definition);
      let credentials = row ? await this.open(row.sealed) : {};
      if (
        definition.auth.type === "oauth" &&
        credentials.ready &&
        (credentials.tokenExpiresAt ?? Infinity) < Date.now() + 30000
      ) {
        const refreshed = await this.connect(
          user,
          bundle,
          definition.name,
          {},
          credentials.oauthOrigin!,
        );
        if (!refreshed.ready) fail(409, "WORKBUDDY_CONNECTIONS_REQUIRED");
        credentials = await this.open(
          (await this.row(user, definition))!.sealed,
        );
      }
      if (!credentials.ready) fail(409, "WORKBUDDY_CONNECTIONS_REQUIRED");
      // WorkBuddy运行在桌面，容器内loopback需指回同一台电脑的服务。
      const url = this.url(definition);
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        url.hostname = "host.docker.internal";
      result[definition.name] = {
        type: definition.config.type === "sse" ? "sse" : "http",
        url: url.href,
        headers: this.headers(definition, credentials),
      };
    }
    return result;
  }
}
