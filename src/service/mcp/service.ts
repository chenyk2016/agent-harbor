/** Personal connection configuration. Native Claude Code owns MCP transport and tool execution. */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpConnections, type McpDefinition } from "../db/schema/mcp.js";
import { fail } from "../types.js";
import { McpSecrets } from "./secrets.js";
import { McpNetwork } from "./network.js";
import { McpScripts, reservedEnv } from "./scripts.js";
import { mcpServerName, type McpRuntime } from "../../shared/mcp.js";
import type { LocalTemplate } from "./templates.js";
export type Connection = typeof mcpConnections.$inferSelect;
export class McpService {
  readonly secrets: McpSecrets;
  readonly scripts: McpScripts;
  constructor(
    readonly db: Database,
    root: string,
    readonly network: McpNetwork,
    readonly templates: LocalTemplate[] = [],
  ) {
    this.secrets = new McpSecrets(root);
    this.scripts = new McpScripts(dirname(root));
  }
  /** Legacy tool allow-lists cannot silently become whole-server grants. Preserve rows, disable until reviewed. */
  async migrateLegacy() {
    const rows = await this.db.select().from(mcpConnections);
    for (const row of rows)
      if (row.definition.schemaVersion !== 2)
        await this.db
          .update(mcpConnections)
          .set({
            enabled: 0,
            definition: {
              ...row.definition,
              schemaVersion: 2,
              migrationPending: true,
            },
            revision: row.revision + 1,
          })
          .where(
            and(
              eq(mcpConnections.id, row.id),
              eq(mcpConnections.revision, row.revision),
            ),
          );
  }
  view(row: Connection) {
    const { allowedTools, templateDigest, ...definition } = row.definition;
    return {
      id: row.id,
      ...definition,
      enabled: !!row.enabled,
      revision: row.revision,
      updatedAt: row.updatedAt,
      credentialsConfigured: row.hasCredentials === 1,
    };
  }
  async list(user: string) {
    return (
      await this.db
        .select()
        .from(mcpConnections)
        .where(
          and(eq(mcpConnections.ownerId, user), eq(mcpConnections.deleted, 0)),
        )
    ).map((r) => this.view(r));
  }
  async owned(user: string, id: string) {
    const [r] = await this.db
      .select()
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.id, id),
          eq(mcpConnections.ownerId, user),
          eq(mcpConnections.deleted, 0),
        ),
      );
    if (!r) fail(404, "MCP_NOT_FOUND");
    return r;
  }
  /** Native HTTP is outside the Bash sandbox. First release accepts administrator-approved origins only. */
  validateRemote(raw: string) {
    const url = this.network.url(raw);
    if (!this.network.allowedOrigins.includes(url.origin))
      fail(403, "MCP_ORIGIN_NOT_APPROVED");
    return url;
  }
  private async definition(
    user: string,
    input: Record<string, unknown>,
  ): Promise<McpDefinition> {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 80
    )
      fail(400, "INVALID_MCP_NAME");
    const base = { name: input.name.trim(), schemaVersion: 2 as const };
    if ((input.kind ?? "remote") === "remote") {
      if (typeof input.url !== "string") fail(400, "INVALID_MCP_URL");
      return {
        ...base,
        kind: "remote",
        url: this.validateRemote(input.url).href,
      };
    }
    if (input.kind === "local") {
      if (!this.templates.some((t) => t.id === input.templateId))
        fail(400, "MCP_TEMPLATE_UNAVAILABLE");
      return { ...base, kind: "local", templateId: String(input.templateId) };
    }
    if (
      input.kind === "script" &&
      typeof input.scriptId === "string" &&
      ["admin", "user"].includes(String(input.scriptScope))
    ) {
      await this.scripts.read(
        input.scriptScope as "admin" | "user",
        user,
        input.scriptId,
      );
      return {
        ...base,
        kind: "script",
        scriptId: input.scriptId,
        scriptScope: input.scriptScope as "admin" | "user",
      };
    }
    fail(400, "INVALID_MCP_KIND");
  }
  private async credentials(user: string, input: unknown, d: McpDefinition) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail(400, "INVALID_MCP_CREDENTIALS");
    const keys =
      d.kind === "local"
        ? this.templates.find((t) => t.id === d.templateId)!.secretKeys
        : d.kind === "script"
          ? (await this.scripts.read(d.scriptScope!, user, d.scriptId!))
              .secretKeys
          : undefined;
    const entries = Object.entries(input);
    if (
      entries.length > 20 ||
      entries.some(
        ([k, v]) =>
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(k) ||
          typeof v !== "string" ||
          v.length > 8192 ||
          /[\r\n\0]/.test(v) ||
          (keys
            ? !keys.includes(k) || reservedEnv(k)
            : [
                "host",
                "content-length",
                "connection",
                "transfer-encoding",
                "mcp-session-id",
                "mcp-protocol-version",
                "accept",
                "content-type",
                "proxy-authorization",
              ].includes(k.toLowerCase())),
      )
    )
      fail(400, "INVALID_MCP_CREDENTIALS");
    return Object.fromEntries(entries) as Record<string, string>;
  }
  async save(user: string, input: Record<string, unknown>, id?: string) {
    const old = id ? await this.owned(user, id) : undefined;
    if (old && input.expectedRevision !== old.revision)
      fail(409, "MCP_REVISION_CONFLICT");
    // Old clients must not save a tool subset and accidentally authorize the whole server.
    if (input.allowedTools !== undefined) fail(400, "MCP_TOOL_SELECTION_REMOVED");
    if (old?.definition.migrationPending && input.confirmAllTools !== true)
      fail(409, "MCP_REVIEW_REQUIRED");
    const definition = await this.definition(user, input);
    const targetChanged =
      old &&
      JSON.stringify([
        old.definition.kind,
        old.definition.url,
        old.definition.templateId,
        old.definition.scriptScope,
        old.definition.scriptId,
      ]) !==
        JSON.stringify([
          definition.kind,
          definition.url,
          definition.templateId,
          definition.scriptScope,
          definition.scriptId,
        ]);
    const credentials =
      input.credentials !== undefined
        ? await this.credentials(user, input.credentials, definition)
        : undefined;
    const sealed = credentials
      ? await this.secrets.seal(credentials)
      : targetChanged
        ? await this.secrets.seal({})
        : (old?.sealed ?? (await this.secrets.seal({})));
    const hasCredentials = credentials
      ? Object.keys(credentials).length > 0
      : targetChanged
        ? false
        : old?.hasCredentials === 1;
    const data = {
      definition,
      sealed,
      hasCredentials: hasCredentials ? 1 : 0,
      enabled: input.enabled === false ? 0 : 1,
      updatedAt: Date.now(),
    };
    if (old) {
      const [r] = await this.db
        .update(mcpConnections)
        .set({ ...data, revision: old.revision + 1 })
        .where(
          and(
            eq(mcpConnections.id, old.id),
            eq(mcpConnections.revision, old.revision),
          ),
        )
        .returning();
      if (!r) fail(409, "MCP_REVISION_CONFLICT");
      return this.view(r);
    }
    if ((await this.list(user)).length >= 30) fail(409, "MCP_CONNECTION_LIMIT");
    const [r] = await this.db
      .insert(mcpConnections)
      .values({
        id: randomUUID(),
        ownerId: user,
        ...data,
        createdAt: Date.now(),
      })
      .returning();
    return this.view(r);
  }
  async remove(user: string, id: string) {
    await this.owned(user, id);
    await this.db
      .update(mcpConnections)
      .set({ deleted: 1, enabled: 0, updatedAt: Date.now() })
      .where(eq(mcpConnections.id, id));
  }
  /** No Binding snapshot: every new environment resolves the user's current enabled connections. */
  async runtime(user: string, onlyId?: string): Promise<McpRuntime> {
    const rows = onlyId
      ? [await this.owned(user, onlyId)]
      : await this.db
          .select()
          .from(mcpConnections)
          .where(
            and(
              eq(mcpConnections.ownerId, user),
              eq(mcpConnections.deleted, 0),
              eq(mcpConnections.enabled, 1),
            ),
          );
    const result: McpRuntime = { mcpServers: {}, localMcp: [] };
    for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
      if (row.definition.migrationPending || row.definition.schemaVersion !== 2)
        fail(409, "MCP_REVIEW_REQUIRED");
      const d = row.definition,
        env = await this.secrets.open(row.sealed);
      if (d.kind === "remote") {
        this.validateRemote(d.url!);
        result.mcpServers[mcpServerName(row.id)] = {
          type: "http",
          url: d.url!,
          headers: env,
        };
      } else if (d.kind === "local") {
        const t = this.templates.find((t) => t.id === d.templateId);
        if (!t) fail(409, "MCP_TEMPLATE_UNAVAILABLE");
        await this.credentials(user, env, d);
        result.localMcp!.push({ id: row.id, command: t.command, env });
      } else {
        const script = await this.scripts.read(
          d.scriptScope!,
          user,
          d.scriptId!,
        );
        await this.credentials(user, env, d);
        result.localMcp!.push({
          id: row.id,
          command: [],
          env,
          script: {
            entry: script.entry,
            runtime: script.runtime,
            install: script.install,
            files: script.files,
          },
        });
      }
    }
    return result;
  }
}
