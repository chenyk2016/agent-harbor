/** 部署（可变指针）指向不可变版本；密钥与售价独立版本化。 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import {
  llmProviders as providers,
  llmProviderSecrets as secrets,
  llmModelVersions as versions,
  llmDeployments as deployments,
  llmDeploymentPrices as prices,
  llmModelCosts as costs,
  llmBindings as bindings,
  llmPreferences as preferences,
  llmConfigAudit as audit,
} from "../db/schema/llm.js";
import type {
  GatewayConnection,
  ModelSnapshot,
  ModelCatalog,
  ModelOption,
} from "../../shared/llm.js";
import { McpSecrets } from "../mcp/secrets.js";
import { fail } from "../types.js";
import { LiteLLMClient, LiteLLMError, type LlmSettings } from "./client.js";
import { parsePrice } from "../wallet/service.js";
import { wallets } from "../db/schema/wallet.js";
import { gatewayUsageEvents, gatewaySyncState } from "../db/schema/gateway-usage.js";
import { users } from "../db/schema/identity.js";
import { gatewayUserId, modelPolicyFields } from "./policy.js";
import { deploymentSessionCount, lockDeploymentForUse, lockProviderForUse, providerModelCount } from "./deletion.js";

const text = (value: unknown, max = 200) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    fail(400, "INVALID_MODEL_INPUT");
  return value.trim();
};
const optionalText = (value: unknown, max = 1000) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f]/.test(value))
    fail(400, "INVALID_MODEL_INPUT");
  return value;
};
const LOGICAL_MODEL = "ah-session-model";
const formats = ["anthropic", "anthropic_compatible", "openai_chat", "openai_responses"];
const upstreamPrefix = (format: string) =>
  format === "anthropic"
    ? "anthropic"
    : format === "openai_chat"
      ? "custom_openai"
      : "openai";

const blockedDiscoveryHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  return (
    host === "metadata.google.internal" ||
    /^169\.254\./.test(host) ||
    /^fe80:/.test(host) ||
    host === "0.0.0.0"
  );
};

function digestOf(input: {
  providerId: string;
  upstreamModel: string;
  routeName: string;
  tools: boolean;
  streaming: boolean;
  params: Record<string, unknown>;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export interface DeploymentPriceView {
  id: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  effectiveFrom: number;
}

export class LlmService {
  private secrets: McpSecrets;
  readonly client: LiteLLMClient;
  // 同一宿主内串行同步和Key状态，数据库不跨网络持事务；服务根锁确保只有一个宿主。
  private queue = Promise.resolve();
  constructor(
    readonly db: Database,
    root: string,
    readonly settings: LlmSettings,
  ) {
    this.secrets = new McpSecrets(root + "/llm");
    this.client = new LiteLLMClient(settings.managementUrl, settings.masterKey);
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise((r) => {
      release = r;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private async record(
    actor: string,
    action: string,
    target: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason?: string,
    db: Database | Tx = this.db,
  ) {
    await db.insert(audit).values({
      id: randomUUID(),
      actor,
      action,
      target,
      before,
      after,
      reason: reason ?? null,
      createdAt: Date.now(),
    });
  }
  private async providerRow(id: string) {
    const [row] = await this.db.select().from(providers).where(and(eq(providers.id, id), isNull(providers.deletedAt)));
    if (!row) fail(404, "PROVIDER_NOT_FOUND");
    return row;
  }
  private async deploymentRow(id: string, includeDeleting = false) {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id));
    if (!row || row.deletionState === "deleted") fail(404, "DEPLOYMENT_NOT_FOUND");
    if (!includeDeleting && row.deletionState) fail(409, "MODEL_DELETE_PENDING");
    return row;
  }
  private async versionRow(id: string) {
    const [row] = await this.db.select().from(versions).where(eq(versions.id, id));
    if (!row) fail(404, "VERSION_NOT_FOUND");
    return row;
  }
  private async activeSecret(providerId: string) {
    const rows = await this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.providerId, providerId), sql`${secrets.retiredAt} is null`))
      .orderBy(desc(secrets.version));
    return rows[0];
  }
  async currentPrice(deploymentId: string): Promise<DeploymentPriceView | undefined> {
    const [row] = await this.db
      .select()
      .from(prices)
      .where(and(eq(prices.deploymentId, deploymentId), sql`${prices.effectiveFrom} <= ${Date.now()}`))
      .orderBy(desc(prices.effectiveFrom), desc(prices.createdAt))
      .limit(1);
    return row
      ? {
          id: row.id,
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          effectiveFrom: row.effectiveFrom,
        }
      : undefined;
  }
  /** 供应商成本：美元/Token；后台版本优先，策略文件作为兼容回退。 */
  async costForIdentity(providerId: string, upstreamModel: string, at = Date.now()) {
    const [row] = await this.db
      .select()
      .from(costs)
      .where(and(
        eq(costs.providerId, providerId),
        eq(costs.upstreamModel, upstreamModel),
        sql`${costs.effectiveFrom} <= ${at}`,
      ))
      .orderBy(desc(costs.effectiveFrom), desc(costs.createdAt))
      .limit(1);
    if (row)
      return {
        id: row.id,
        source: "database" as const,
        inputCostPerToken: row.inputUsdPerToken,
        outputCostPerToken: row.outputUsdPerToken,
        cacheReadCostPerToken: row.cacheReadUsdPerToken,
        cacheWriteCostPerToken: row.cacheWriteUsdPerToken,
        timeoutSeconds: row.timeoutSeconds,
        effectiveFrom: row.effectiveFrom,
      };
    const fallback = this.settings.policy?.models[upstreamModel];
    return fallback ? { ...fallback, source: "file" as const } : undefined;
  }
  async costForVersionAt(versionId: string, at = Date.now()) {
    const [version] = await this.db.select().from(versions).where(eq(versions.id, versionId));
    return version ? this.costForIdentity(version.providerId, version.upstreamModel, at) : undefined;
  }
  async costHistory(versionId: string) {
    const version = await this.versionRow(versionId);
    return this.db
      .select()
      .from(costs)
      .where(and(eq(costs.providerId, version.providerId), eq(costs.upstreamModel, version.upstreamModel)))
      .orderBy(desc(costs.effectiveFrom), desc(costs.createdAt));
  }
  private normalizedCost(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "INVALID_COST");
    const input = value as Record<string, unknown>;
    const allowed = [
      "inputUsdPerMillion",
      "outputUsdPerMillion",
      "cacheReadUsdPerMillion",
      "cacheWriteUsdPerMillion",
      "timeoutSeconds",
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, "INVALID_COST");
    const rate = (key: string) => {
      const value = input[key];
      if (typeof value !== "number" && typeof value !== "string") fail(400, "INVALID_COST");
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1000) fail(400, "INVALID_COST");
      return number / 1e6;
    };
    const timeoutSeconds = input.timeoutSeconds === undefined ? 180 : Number(input.timeoutSeconds);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
      fail(400, "INVALID_COST");
    return {
      inputUsdPerToken: rate("inputUsdPerMillion"),
      outputUsdPerToken: rate("outputUsdPerMillion"),
      cacheReadUsdPerToken: rate("cacheReadUsdPerMillion"),
      cacheWriteUsdPerToken: rate("cacheWriteUsdPerMillion"),
      timeoutSeconds,
    };
  }
  private costRow(
    version: { providerId: string; upstreamModel: string },
    cost: ReturnType<LlmService["normalizedCost"]>,
    actor: string,
  ) {
    const now = Date.now();
    return {
      id: randomUUID(),
      providerId: version.providerId,
      upstreamModel: version.upstreamModel,
      ...cost,
      effectiveFrom: now,
      createdBy: actor,
      createdAt: now,
    };
  }
  /** 成本按供应商 + 上游模型共享；发布后重写所有 ready 版本，失败保持 pending。 */
  async publishCost(versionId: string, input: Record<string, unknown>, actor: string) {
    return this.serial(async () => {
      const version = await this.versionRow(versionId);
      await this.deploymentRow(version.deploymentId);
      const cost = this.normalizedCost(input);
      const row = this.costRow(version, cost, actor);
      await this.db.insert(costs).values(row);
      await this.record(
        actor,
        "cost.create",
        version.deploymentId,
        null,
        { versionId, upstreamModel: version.upstreamModel, ...cost },
      );
      const rows = await this.db
        .select()
        .from(versions)
        .where(and(
          eq(versions.providerId, version.providerId),
          eq(versions.upstreamModel, version.upstreamModel),
          eq(versions.state, "ready"),
        ));
      for (const item of rows)
        await this.db.update(versions).set({ state: "pending" }).where(eq(versions.id, item.id));
      try {
        for (const item of rows) await this.syncVersionUnlocked(item.id);
      } catch (error) {
        fail(503, "COST_SYNC_UNCONFIRMED");
      }
      return this.deploymentDetail(version.deploymentId);
    });
  }
  async providerList() {
    const rows = await this.db.select().from(providers).where(isNull(providers.deletedAt)).orderBy(desc(providers.createdAt));
    const secretRows = await this.db.select().from(secrets);
    return rows.map((row) => ({
      ...row,
      secretVersion:
        secretRows
          .filter((secret) => secret.providerId === row.id)
          .reduce((max, secret) => Math.max(max, secret.version), 0) || null,
    }));
  }
  async addProvider(input: Record<string, unknown>, actor: string, setupId?: string) {
    const name = text(input.name),
      apiBase = text(input.apiBase, 2000),
      format = text(input.format),
      apiKey = text(input.apiKey, 4096);
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      fail(400, "INVALID_MODEL_URL");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(400, "INVALID_MODEL_URL");
    if (!formats.includes(format)) fail(400, "INVALID_MODEL_FORMAT");
    const id = setupId ?? randomUUID(),
      now = Date.now();
    const provider = {
      id,
      name,
      apiBase: apiBase.replace(/\/$/, ""),
      format,
      createdAt: now,
    };
    const sealed = await this.secrets.seal({ apiKey });
    // 安装中断时供应商与首个凭据必须同生同灭，不能留下无凭据供应商。
    const created = await this.db.transaction(async tx => {
      if (setupId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"llm-setup-provider:" + id}, 0))`);
        const [previous] = await tx.select().from(providers).where(eq(providers.id, id));
        if (previous) {
          const [active] = await tx.select().from(secrets)
            .where(and(eq(secrets.providerId, id), isNull(secrets.retiredAt)))
            .orderBy(desc(secrets.version)).limit(1);
          if (previous.deletedAt || previous.name !== name || previous.format !== format ||
              previous.apiBase !== provider.apiBase || !active ||
              (await this.secrets.open(active.secret)).apiKey !== apiKey)
            fail(409, "REQUEST_ID_CONFLICT");
          return { ...previous, secretVersion: active.version };
        }
      }
      await tx.insert(providers).values(provider);
      await tx.insert(secrets).values({
        id: randomUUID(), providerId: id, version: 1, secret: sealed,
        createdAt: now, retiredAt: null,
      });
    });
    if (created) return created;
    await this.record(actor, "provider.create", id, null, { name, apiBase, format });
    return { ...provider, secretVersion: 1 };
  }
  /** 地址和名称可维护；协议属于版本身份，变更请新增供应商与新版本。 */
  async updateProvider(providerId: string, input: Record<string, unknown>, actor: string) {
    return this.serial(async () => {
      const provider = await this.providerRow(providerId);
      const keys = Object.keys(input);
      if (!keys.length || keys.some((key) => !["name", "apiBase"].includes(key)))
        fail(400, "INVALID_MODEL_INPUT");
      const name = input.name === undefined ? provider.name : text(input.name);
      let apiBase = provider.apiBase;
      if (input.apiBase !== undefined) {
        apiBase = text(input.apiBase, 2000);
        let url: URL;
        try {
          url = new URL(apiBase);
        } catch {
          fail(400, "INVALID_MODEL_URL");
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          fail(400, "INVALID_MODEL_URL");
        apiBase = apiBase.replace(/\/$/, "");
      }
      if (name === provider.name && apiBase === provider.apiBase) return provider;
      await this.db.update(providers).set({ name, apiBase }).where(eq(providers.id, providerId));
      if (apiBase !== provider.apiBase) {
        const rows = await this.db
          .select()
          .from(versions)
          .where(and(eq(versions.providerId, providerId), eq(versions.state, "ready")));
        const synced: string[] = [];
        try {
          for (const version of rows) {
            await this.syncVersionUnlocked(version.id);
            synced.push(version.id);
          }
        } catch (error) {
          await this.db
            .update(providers)
            .set({ name: provider.name, apiBase: provider.apiBase })
            .where(eq(providers.id, providerId));
          let rolledBack = true;
          for (const id of synced) {
            try { await this.syncVersionUnlocked(id); }
            catch { rolledBack = false; }
          }
          if (!rolledBack) fail(503, "PROVIDER_UPDATE_ROLLBACK_UNCONFIRMED");
          throw error;
        }
      }
      await this.record(
        actor,
        "provider.update",
        providerId,
        { name: provider.name, apiBase: provider.apiBase },
        { name, apiBase },
      );
      return { ...provider, name, apiBase };
    });
  }
  /** 显式读取供应商模型列表；不落库、不自动创建。 */
  async discoverModels(providerId: string) {
    const provider = await this.providerRow(providerId);
    const secretRow = await this.activeSecret(providerId);
    if (!secretRow) fail(409, "PROVIDER_SECRET_REQUIRED");
    const { apiKey } = await this.secrets.open(secretRow.secret);
    const base = provider.apiBase.replace(/\/$/, "");
    const path = provider.format === "anthropic" ? "/v1/models" : "/models";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider.format === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.Authorization = `Bearer ${apiKey}`;
    const models = new Map<string, { id: string; displayName?: string }>();
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(base + path);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        fail(400, "DISCOVERY_INVALID_TARGET");
      if (blockedDiscoveryHost(url.hostname)) fail(400, "DISCOVERY_BLOCKED_ADDRESS");
      if (provider.format === "anthropic") {
        url.searchParams.set("limit", "1000");
        if (after) url.searchParams.set("after_id", after);
      }
      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        return fail(502, "DISCOVERY_UNREACHABLE");
      }
      if (!response.ok) {
        if ([401, 403].includes(response.status)) fail(502, "DISCOVERY_UNAUTHORIZED");
        fail(502, "DISCOVERY_FAILED");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 1_048_576) fail(502, "DISCOVERY_INVALID_RESPONSE");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        fail(502, "DISCOVERY_INVALID_RESPONSE");
      }
      const list = Array.isArray(parsed.data)
        ? parsed.data
        : Array.isArray(parsed.models)
          ? parsed.models
          : [];
      for (const item of list as Array<Record<string, unknown> | string>) {
        const id =
          typeof item === "string"
            ? item
            : typeof item.id === "string"
              ? item.id
              : typeof item.name === "string"
                ? item.name
                : typeof item.model === "string"
                  ? item.model
                  : undefined;
        if (!id || !id.trim() || id.length > 200 || /[\x00-\x1f]/.test(id)) continue;
        const displayName =
          typeof item === "object" && typeof item.display_name === "string"
            ? item.display_name
            : typeof item === "object" && typeof item.name === "string" && id !== item.name
              ? item.name
              : undefined;
        models.set(id.trim(), { id: id.trim(), ...(displayName ? { displayName } : {}) });
      }
      if (provider.format === "anthropic" && parsed.has_more === true && typeof parsed.last_id === "string") {
        after = parsed.last_id;
        continue;
      }
      break;
    }
    return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  }
  /** 轮换密钥不改变任何版本的路由身份；失败时旧密钥继续有效。 */
  async rotateProviderSecret(providerId: string, input: Record<string, unknown>, actor: string) {
    return this.serial(async () => {
      const provider = await this.providerRow(providerId);
      const apiKey = text(input.apiKey, 4096);
      const current = await this.activeSecret(providerId);
      if (!current) fail(409, "PROVIDER_SECRET_REQUIRED");
      const now = Date.now();
      const candidate = {
        id: randomUUID(),
        providerId,
        version: current.version + 1,
        secret: await this.secrets.seal({ apiKey }),
        createdAt: now,
        retiredAt: null,
      };
      await this.db.insert(secrets).values(candidate);
      const synced: string[] = [];
      try {
        const rows = await this.db
          .select()
          .from(versions)
          .where(eq(versions.providerId, providerId));
        for (const version of rows) {
          if (version.state !== "ready") continue;
          await this.syncVersionUnlocked(version.id, candidate);
          synced.push(version.id);
        }
      } catch (error) {
        // 已切换的版本尝试回滚到旧密钥；回滚失败保留候选密钥待人工核对，不能宣称旧密钥仍生效。
        let rolledBack = true;
        for (const id of synced) {
          try { await this.syncVersionUnlocked(id, current); }
          catch { rolledBack = false; }
        }
        if (rolledBack) {
          await this.db.delete(secrets).where(eq(secrets.id, candidate.id));
          throw error;
        }
        fail(503, "PROVIDER_SECRET_ROLLBACK_UNCONFIRMED");
      }
      await this.db
        .update(secrets)
        .set({ retiredAt: now })
        .where(eq(secrets.id, current.id));
      await this.record(actor, "secret.rotate", providerId, { version: current.version }, { version: candidate.version });
      return { providerId, secretVersion: candidate.version };
    });
  }
  async providerDeletionImpact(id: string) {
    await this.providerRow(id);
    return { models: await providerModelCount(this.db, id) };
  }
  async deleteProvider(id: string, actor: string) {
    return this.serial(() => this.db.transaction(async (tx) => {
      const [provider] = await tx.select().from(providers).where(eq(providers.id, id)).for("update");
      if (!provider) fail(404, "PROVIDER_NOT_FOUND");
      if (provider.deletedAt !== null) return { deleted: true };
      if (await providerModelCount(tx, id)) fail(409, "PROVIDER_IN_USE");
      const deletedAt = Date.now();
      await tx.delete(secrets).where(eq(secrets.providerId, id));
      await tx.update(providers).set({ deletedAt }).where(eq(providers.id, id));
      await this.record(actor, "provider.delete", id, { name: provider.name }, { deletedAt }, undefined, tx);
      return { deleted: true };
    }));
  }
  async gatewayVersions() {
    return this.db
      .select({
        routeName: versions.routeName,
        upstreamModel: versions.upstreamModel,
        providerId: versions.providerId,
        deploymentId: versions.deploymentId,
        versionId: versions.id,
        format: providers.format,
      })
      .from(versions)
      .innerJoin(providers, eq(versions.providerId, providers.id));
  }
  async gatewayIdentities() {
    const result = [];
    for (const row of await this.db.select().from(bindings)) {
      const secret = await this.secrets.open(row.secret);
      result.push({
        hash: createHash("sha256").update(secret.token).digest("hex"),
        ownerId: row.ownerId,
        sessionId: row.sessionId,
        deploymentId: row.deploymentId,
        versionId: row.versionId,
      });
    }
    return result;
  }
  /** 校验固定版本仍可用：部署未归档、已启用、用户可见、版本就绪且具备 Agent 能力。 */
  private async allowedVersion(user: string, deploymentId: string, versionId?: string) {
    const deployment = await this.deploymentRow(deploymentId);
    if (deployment.archivedAt) fail(409, "DEPLOYMENT_ARCHIVED");
    if (!deployment.enabled) fail(409, "MODEL_UNAVAILABLE");
    if (deployment.allowedUsers.length && !deployment.allowedUsers.includes(user))
      fail(404, "MODEL_NOT_FOUND");
    const id = versionId ?? deployment.currentVersionId;
    const [version] = await this.db
      .select()
      .from(versions)
      .where(and(eq(versions.id, id), eq(versions.deploymentId, deployment.id)));
    if (!version) fail(404, "VERSION_NOT_FOUND");
    if (version.state !== "ready") fail(409, "MODEL_UNAVAILABLE");
    if (!version.tools || !version.streaming) fail(409, "MODEL_AGENT_UNSUPPORTED");
    const provider = await this.providerRow(version.providerId);
    return { deployment, version, provider };
  }
  async catalog(user: string, admin = false): Promise<ModelCatalog> {
    const rows = await this.db
      .select()
      .from(deployments)
      .where(sql`${deployments.archivedAt} is null`)
      .orderBy(desc(deployments.createdAt));
    const modelRows = await this.db.select().from(versions);
    const providerRows = await this.db.select().from(providers);
    const options: ModelOption[] = [];
    for (const deployment of rows) {
      if (!deployment.enabled || deployment.setupPending) continue;
      if (deployment.allowedUsers.length && !deployment.allowedUsers.includes(user)) continue;
      const version = modelRows.find(
        (row) => row.id === deployment.currentVersionId && row.deploymentId === deployment.id,
      );
      if (!version || version.state !== "ready" || !version.tools || !version.streaming) continue;
      const provider = providerRows.find((row) => row.id === version.providerId);
      options.push({
        id: deployment.id,
        name: deployment.name,
        provider: provider?.name ?? "未知供应商",
        versionId: version.id,
        routeName: version.routeName,
        description: deployment.description,
        enabled: deployment.enabled,
        state: version.state,
        tools: version.tools,
        streaming: version.streaming,
      });
    }
    const [pref] = await this.db
      .select()
      .from(preferences)
      .where(eq(preferences.ownerId, user));
    const defaultModelId =
      [pref?.deploymentId, this.settings.defaultDeploymentId, options[0]?.id].find(
        (id) => !!id && options.some((option) => option.id === id),
      ) ?? null;
    return { enabled: true, admin, defaultModelId, models: options };
  }
  async setDefault(user: string, value: unknown) {
    const id = value === null ? null : text(value);
    if (id) {
      const { deployment } = await this.allowedVersion(user, id);
      if (deployment.setupPending) fail(409, "MODEL_SETUP_PENDING");
    }
    await this.db.transaction(async (tx) => {
      if (id) await lockDeploymentForUse(tx, id);
      await tx.insert(preferences).values({ ownerId: user, deploymentId: id })
        .onConflictDoUpdate({ target: preferences.ownerId, set: { deploymentId: id } });
    });
  }
  async select(user: string, requested?: string, setupTest = false): Promise<ModelSnapshot> {
    const id = requested ?? (await this.catalog(user)).defaultModelId;
    if (!id) fail(409, "NO_AVAILABLE_MODEL");
    const { deployment, version, provider } = await this.allowedVersion(user, id);
    if (deployment.setupPending && !setupTest) fail(409, "MODEL_SETUP_PENDING");
    if (this.settings.walletProxyUrl && !(await this.currentPrice(deployment.id)))
      fail(409, "PRICE_REQUIRED");
    return {
      deploymentId: deployment.id,
      deploymentName: deployment.name,
      versionId: version.id,
      providerName: provider.name,
      upstreamModel: version.upstreamModel,
      routeName: version.routeName,
    };
  }
  async createDeployment(input: Record<string, unknown>, actor: string, setupId?: string) {
    const name = text(input.name),
      description = optionalText(input.description),
      providerId = text(input.providerId),
      upstreamModel = text(input.upstreamModel);
    if (!/^[a-zA-Z0-9_.:/@-]+$/.test(upstreamModel)) fail(400, "INVALID_MODEL_INPUT");
    if (typeof input.tools !== "boolean" || typeof input.streaming !== "boolean")
      fail(400, "INVALID_MODEL_INPUT");
    const allowedUsers = setupId ? [actor] : this.allowedUsers(input.allowedUsers);
    const provider = await this.providerRow(providerId);
    const price = input.price === undefined ? undefined : parsePrice(input.price);
    const cost = input.cost === undefined ? undefined : this.normalizedCost(input.cost);
    const deploymentId = setupId ?? randomUUID(),
      versionId = randomUUID(),
      now = Date.now();
    const routeName = `ah-mv-${versionId}`;
    const params = this.object(input.params, "params");
    const capabilities = this.object(input.capabilities, "capabilities");
    const created = await this.db.transaction(async (tx) => {
      if (setupId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"llm-setup-model:" + deploymentId}, 0))`);
        const [previous] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId));
        if (previous) {
          const [version] = await tx.select().from(versions).where(eq(versions.id, previous.currentVersionId));
          if (previous.archivedAt || previous.deletionState || previous.name !== name ||
              version?.createdBy !== actor || version.providerId !== providerId ||
              version.upstreamModel !== upstreamModel)
            fail(409, "REQUEST_ID_CONFLICT");
          return false;
        }
        if (this.settings.walletProxyUrl && !price) fail(409, "PRICE_REQUIRED");
      }
      await lockProviderForUse(tx, providerId);
      await tx.insert(versions).values({
        id: versionId,
        deploymentId,
        providerId,
        upstreamModel,
        routeName,
        params,
        tools: input.tools as boolean,
        streaming: input.streaming as boolean,
        capabilities,
        digest: digestOf({ providerId, upstreamModel, routeName, tools: input.tools as boolean, streaming: input.streaming as boolean, params }),
        state: "pending",
        lastSyncedAt: null,
        createdBy: actor,
        createdAt: now,
      });
      await tx.insert(deployments).values({
        id: deploymentId,
        name,
        description,
        currentVersionId: versionId,
        enabled: true,
        setupPending: !!setupId,
        allowedUsers,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      if (price)
        await tx.insert(prices).values({
          id: randomUUID(),
          deploymentId,
          ...price,
          effectiveFrom: now,
          createdBy: actor,
          createdAt: now,
        });
      if (cost)
        await tx.insert(costs).values(this.costRow({ providerId, upstreamModel }, cost, actor));
      return true;
    });
    if (!created) return this.deploymentDetail(deploymentId);
    await this.record(actor, "deployment.create", deploymentId, null, {
      name,
      provider: provider.name,
      upstreamModel,
      versionId,
    });
    await this.syncVersion(versionId).catch(() => undefined);
    return this.deploymentDetail(deploymentId);
  }
  /** Publish only the exact version exercised by the administrator's successful test. */
  async completeSetup(id: string, versionId: string, actor: string) {
    const { deployment, version } = await this.allowedVersion(actor, id);
    if (version.id !== versionId) fail(409, "MODEL_PROBE_VERSION_CHANGED");
    if (!deployment.setupPending) return;
    const [updated] = await this.db.update(deployments)
      .set({ setupPending: false, updatedAt: Date.now() })
      .where(and(eq(deployments.id, id), eq(deployments.currentVersionId, versionId),
        eq(deployments.enabled, true), eq(deployments.setupPending, true),
        sql`${deployments.allowedUsers} = ${JSON.stringify([actor])}::jsonb`,
        isNull(deployments.archivedAt), isNull(deployments.deletionState)))
      .returning({ id: deployments.id });
    if (!updated) fail(409, "MODEL_PROBE_VERSION_CHANGED");
    await this.record(actor, "deployment.setup.complete", id, { setupPending: true }, { setupPending: false, versionId });
  }
  async createVersion(deploymentId: string, input: Record<string, unknown>, actor: string) {
    const deployment = await this.deploymentRow(deploymentId);
    if (deployment.archivedAt) fail(409, "DEPLOYMENT_ARCHIVED");
    const current = await this.versionRow(deployment.currentVersionId);
    const providerId = input.providerId === undefined ? current.providerId : text(input.providerId);
    const upstreamModel = input.upstreamModel === undefined ? current.upstreamModel : text(input.upstreamModel);
    if (!/^[a-zA-Z0-9_.:/@-]+$/.test(upstreamModel)) fail(400, "INVALID_MODEL_INPUT");
    if (
      (input.tools !== undefined && typeof input.tools !== "boolean") ||
      (input.streaming !== undefined && typeof input.streaming !== "boolean")
    )
      fail(400, "INVALID_MODEL_INPUT");
    const tools = input.tools === undefined ? current.tools : (input.tools as boolean);
    const streaming = input.streaming === undefined ? current.streaming : (input.streaming as boolean);
    await this.providerRow(providerId);
    const id = randomUUID(),
      now = Date.now(),
      routeName = `ah-mv-${id}`;
    const params = input.params === undefined ? current.params : this.object(input.params, "params");
    const capabilities =
      input.capabilities === undefined ? current.capabilities : this.object(input.capabilities, "capabilities");
    const cost = input.cost === undefined ? undefined : this.normalizedCost(input.cost);
    await this.db.transaction(async (tx) => {
      const locked = await lockDeploymentForUse(tx, deploymentId);
      if (locked.archivedAt) fail(409, "DEPLOYMENT_ARCHIVED");
      await lockProviderForUse(tx, providerId);
      await tx.insert(versions).values({
        id,
        deploymentId,
        providerId,
        upstreamModel,
        routeName,
        params,
        tools,
        streaming,
        capabilities,
        digest: digestOf({ providerId, upstreamModel, routeName, tools, streaming, params }),
        state: "pending",
        lastSyncedAt: null,
        createdBy: actor,
        createdAt: now,
      });
      if (cost) await tx.insert(costs).values(this.costRow({ providerId, upstreamModel }, cost, actor));
    });
    await this.record(actor, "version.create", deploymentId, null, { versionId: id, providerId, upstreamModel });
    await this.syncVersion(id).catch(() => undefined);
    return this.deploymentDetail(deploymentId);
  }
  /** 指针切换使用 CAS；已有会话固定旧版本，不随之改变。 */
  async pointDeployment(deploymentId: string, versionId: string, expectedVersionId: string | undefined, actor: string) {
    const deployment = await this.deploymentRow(deploymentId);
    if (deployment.archivedAt) fail(409, "DEPLOYMENT_ARCHIVED");
    const version = await this.versionRow(versionId);
    if (version.deploymentId !== deploymentId) fail(404, "VERSION_NOT_FOUND");
    if (expectedVersionId !== undefined && deployment.currentVersionId !== expectedVersionId)
      fail(409, "DEPLOYMENT_VERSION_CONFLICT");
    const updated = await this.db
      .update(deployments)
      .set({ currentVersionId: versionId, updatedAt: Date.now() })
      .where(and(eq(deployments.id, deploymentId), eq(deployments.currentVersionId, expectedVersionId ?? deployment.currentVersionId), isNull(deployments.deletionState)))
      .returning({ id: deployments.id });
    if (!updated.length) fail(409, "DEPLOYMENT_VERSION_CONFLICT");
    await this.record(
      actor,
      "deployment.point",
      deploymentId,
      { currentVersionId: deployment.currentVersionId },
      { currentVersionId: versionId },
    );
    return this.deploymentDetail(deploymentId);
  }
  async updateDeployment(deploymentId: string, input: Record<string, unknown>, actor: string) {
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !["name", "description", "enabled", "allowedUsers"].includes(key)))
      fail(400, "INVALID_MODEL_INPUT");
    const deployment = await this.deploymentRow(deploymentId);
    const update: Partial<typeof deployment> = { updatedAt: Date.now() };
    if (input.name !== undefined) update.name = text(input.name);
    if (input.description !== undefined) update.description = optionalText(input.description);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") fail(400, "INVALID_MODEL_INPUT");
      update.enabled = input.enabled;
    }
    if (input.allowedUsers !== undefined) update.allowedUsers = this.allowedUsers(input.allowedUsers);
    const updated = await this.db.update(deployments).set(update)
      .where(and(eq(deployments.id, deploymentId), isNull(deployments.deletionState))).returning({ id: deployments.id });
    if (!updated.length) fail(409, "MODEL_DELETE_PENDING");
    await this.record(
      actor,
      "deployment.update",
      deploymentId,
      deployment as unknown as Record<string, unknown>,
      update as Record<string, unknown>,
    );
    const rows = await this.db
      .select()
      .from(bindings)
      .where(and(eq(bindings.deploymentId, deploymentId), ne(bindings.state, "revoked")));
    for (const row of rows) {
      const disabled = update.enabled === false;
      const notAllowed =
        update.allowedUsers !== undefined &&
        update.allowedUsers.length > 0 &&
        !update.allowedUsers.includes(row.ownerId);
      if (disabled || notAllowed) await this.revokeSession(row.sessionId);
    }
    return this.deploymentDetail(deploymentId);
  }
  async createPrice(deploymentId: string, input: Record<string, unknown>, actor: string) {
    await this.deploymentRow(deploymentId);
    const price = parsePrice(input);
    const now = Date.now();
    await this.db.insert(prices).values({
      id: randomUUID(),
      deploymentId,
      ...price,
      effectiveFrom: now,
      createdBy: actor,
      createdAt: now,
    });
    await this.record(actor, "price.create", deploymentId, null, price as unknown as Record<string, unknown>);
    return this.deploymentDetail(deploymentId);
  }
  async archiveDeployment(deploymentId: string, actor: string) {
    const deployment = await this.deploymentRow(deploymentId);
    if (deployment.archivedAt) return this.deploymentDetail(deploymentId);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(bindings)
      .where(and(eq(bindings.deploymentId, deploymentId), ne(bindings.state, "revoked")));
    if (row.count > 0) fail(409, "DEPLOYMENT_IN_USE");
    const updated = await this.db.update(deployments)
      .set({ archivedAt: Date.now(), enabled: false, updatedAt: Date.now() })
      .where(and(eq(deployments.id, deploymentId), isNull(deployments.deletionState))).returning({ id: deployments.id });
    if (!updated.length) fail(409, "MODEL_DELETE_PENDING");
    await this.record(actor, "deployment.archive", deploymentId, { enabled: deployment.enabled }, { archived: true });
    return this.deploymentDetail(deploymentId);
  }
  async deploymentDeletionImpact(id: string) {
    await this.deploymentRow(id, true);
    return { sessions: await deploymentSessionCount(this.db, id) };
  }
  /** 先阻止新会话与网关授权，再清理外部路由；断线时保留可重试的删除状态。 */
  async deleteDeployment(id: string, actor: string) {
    return this.serial(async () => {
      const target = await this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(deployments).where(eq(deployments.id, id)).for("update");
        if (!row) fail(404, "DEPLOYMENT_NOT_FOUND");
        if (row.deletionState === "deleted") return null;
        if (await deploymentSessionCount(tx, id)) fail(409, "MODEL_IN_USE");
        if (row.deletionState === null) {
          await tx.update(deployments).set({ enabled: false, deletionState: "deleting", updatedAt: Date.now() })
            .where(eq(deployments.id, id));
          await tx.update(preferences).set({ deploymentId: null }).where(eq(preferences.deploymentId, id));
          await tx.update(versions).set({ state: "retiring" }).where(eq(versions.deploymentId, id));
        }
        return row;
      });
      if (!target) return { deleted: true };
      const modelIds = new Set((await this.db.select({ id: versions.id }).from(versions)
        .where(eq(versions.deploymentId, id))).map((version) => version.id));
      const gatewayModels = async () => {
        const response = await this.client.request<{ data: Array<{ model_info?: { id?: string } }> }>("/model/info");
        return response.data.filter((model) => model.model_info?.id && modelIds.has(model.model_info.id));
      };
      try {
        for (const model of await gatewayModels()) {
          try {
            await this.client.request("/model/delete", { id: model.model_info!.id });
          } catch {
            // 网关可能已执行但响应丢失；以下读回是删除成功的依据。
          }
        }
        if ((await gatewayModels()).length) fail(503, "MODEL_DELETE_UNCONFIRMED");
      } catch {
        fail(503, "MODEL_DELETE_UNCONFIRMED");
      }
      await this.db.transaction(async (tx) => {
        const now = Date.now();
        await tx.update(versions).set({ state: "retired" }).where(eq(versions.deploymentId, id));
        await tx.update(deployments).set({ deletionState: "deleted", updatedAt: now }).where(eq(deployments.id, id));
        await this.record(actor, "deployment.delete", id, { name: target.name }, { deletedAt: now }, undefined, tx);
      });
      return { deleted: true };
    });
  }
  async syncDeployment(deploymentId: string) {
    const deployment = await this.deploymentRow(deploymentId);
    await this.syncVersion(deployment.currentVersionId);
    return this.deploymentDetail(deploymentId);
  }
  async deploymentDetail(deploymentId: string) {
    const deployment = await this.deploymentRow(deploymentId, true);
    const versionRows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.deploymentId, deploymentId))
      .orderBy(desc(versions.createdAt));
    const versionsWithCost = await Promise.all(
      versionRows.map(async (version) => ({
        ...version,
        cost: (await this.costForIdentity(version.providerId, version.upstreamModel)) ?? null,
      })),
    );
    const priceRows = await this.db
      .select()
      .from(prices)
      .where(eq(prices.deploymentId, deploymentId))
      .orderBy(desc(prices.effectiveFrom), desc(prices.createdAt));
    const auditRows = await this.db
      .select()
      .from(audit)
      .where(eq(audit.target, deploymentId))
      .orderBy(desc(audit.createdAt))
      .limit(100);
    return { deployment, versions: versionsWithCost, prices: priceRows, audit: auditRows };
  }
  async adminOverview() {
    const providerRows = await this.providerList();
    const deploymentRows = await this.db
      .select()
      .from(deployments)
      .where(sql`${deployments.deletionState} is distinct from 'deleted'`)
      .orderBy(desc(deployments.createdAt));
    const versionRows = await this.db.select().from(versions);
    const priceRows = await this.db.select().from(prices);
    const costRows = await this.db.select().from(costs);
    const bindingRows = await this.db.select().from(bindings).where(ne(bindings.state, "revoked"));
    const providerMap = new Map(providerRows.map((row) => [row.id, row]));
    const now = Date.now();
    const costFor = (version?: (typeof versionRows)[number]) => {
      if (!version) return null;
      const row = costRows
        .filter((item) =>
          item.providerId === version.providerId &&
          item.upstreamModel === version.upstreamModel &&
          item.effectiveFrom <= now)
        .sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.createdAt - a.createdAt)[0];
      if (row)
        return {
          id: row.id,
          source: "database" as const,
          inputCostPerToken: row.inputUsdPerToken,
          outputCostPerToken: row.outputUsdPerToken,
          cacheReadCostPerToken: row.cacheReadUsdPerToken,
          cacheWriteCostPerToken: row.cacheWriteUsdPerToken,
          timeoutSeconds: row.timeoutSeconds,
          effectiveFrom: row.effectiveFrom,
        };
      const fallback = this.settings.policy?.models[version.upstreamModel];
      return fallback ? { ...fallback, source: "file" as const } : null;
    };
    return {
      providers: providerRows,
      costPolicyRequired: !!this.settings.policy,
      userRpmLimit: this.settings.policy?.userRpmLimit ?? null,
      deployments: deploymentRows.map((deployment) => {
        const current = versionRows.find((row) => row.id === deployment.currentVersionId);
        const latestPrice = priceRows
          .filter((row) => row.deploymentId === deployment.id)
          .sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.createdAt - a.createdAt)[0];
        const cost = costFor(current);
        return {
          ...deployment,
          providerName: current ? providerMap.get(current.providerId)?.name ?? "未知供应商" : null,
          currentVersion: current ? { ...current, cost } : null,
          price: latestPrice ?? null,
          cost,
          costMissing: !!current && !cost,
          versionCount: versionRows.filter((row) => row.deploymentId === deployment.id).length,
          liveSessions: bindingRows.filter((row) => row.deploymentId === deployment.id).length,
          state: current?.state ?? "pending",
        };
      }),
    };
  }
  private allowedUsers(value: unknown): string[] {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > 200 ||
      value.some((user) => typeof user !== "string" || !user.trim() || user.length > 200)
    )
      fail(400, "INVALID_MODEL_INPUT");
    return [...new Set(value as string[])];
  }
  private object(value: unknown, name: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 8000)
      fail(400, `INVALID_${name.toUpperCase()}`);
    return value as Record<string, unknown>;
  }
  /** 启动和新建授权收敛到同一份 operator policy；不重置任何费用。 */
  async applyBaseline() {
    if (!this.settings.policy) return;
    const rows = await this.db.select().from(deployments).where(sql`${deployments.archivedAt} is null`);
    for (const deployment of rows)
      if (deployment.enabled) await this.syncVersion(deployment.currentVersionId).catch(() => undefined);
    for (const user of await this.db.select({ id: users.id, disabled: users.disabled }).from(users))
      if (!user.disabled) await this.syncUser(user.id);
  }
  async syncUser(owner: string) {
    const policy = this.settings.policy;
    if (!policy) return;
    const id = gatewayUserId(owner);
    type UserInfo = { user_info?: { user_id?: string; rpm_limit?: number; tpm_limit?: number | null; max_parallel_requests?: number | null;
      budget_duration?: string | null; spend?: number; max_budget?: number | null } };
    const path = `/user/info?user_id=${encodeURIComponent(id)}`;
    let info: UserInfo | undefined;
    try { info = await this.client.request<UserInfo>(path); }
    catch (error) { if (!(error instanceof LiteLLMError) || error.status !== 404) throw error; }
    // 供应商 USD 是次级风险上限；人民币钱包仍是权威执行层。
    let maxBudget: number | undefined;
    if (this.settings.walletProxyUrl) {
      let ratio = 0;
      const deploymentRows = await this.db.select().from(deployments).where(sql`${deployments.archivedAt} is null`);
      const versionRows = await this.db.select().from(versions);
      const priceRows = await this.db.select().from(prices);
      for (const deployment of deploymentRows) {
        if (!deployment.enabled) continue;
        const version = versionRows.find((row) => row.id === deployment.currentVersionId);
        const price = priceRows
          .filter((row) => row.deploymentId === deployment.id)
          .sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.createdAt - a.createdAt)[0];
        const cost = version
          ? await this.costForIdentity(version.providerId, version.upstreamModel)
          : undefined;
        if (!version || !price || !cost) continue;
        for (const [rmb, usd] of [
          [price.input, cost.inputCostPerToken],
          [price.output, cost.outputCostPerToken],
          [price.cacheRead, cost.cacheReadCostPerToken],
          [price.cacheWrite, cost.cacheWriteCostPerToken],
        ])
          if (usd > 0) ratio = Math.max(ratio, rmb / (usd * 1e12));
      }
      const [wallet] = await this.db.select().from(wallets).where(eq(wallets.userId, owner));
      if (ratio > 0 && wallet)
        maxBudget = Math.max(1e-9, (info?.user_info?.spend ?? 0) + (wallet.balance - wallet.reserved) / 1e6 / ratio);
    }
    const fields = { user_id: id, user_role: "internal_user", rpm_limit: policy.userRpmLimit,
      tpm_limit: null, max_parallel_requests: null, budget_duration: null,
      ...(maxBudget === undefined ? {} : { max_budget: maxBudget }),
    };
    if (!info?.user_info) await this.client.request("/user/new", { ...fields, auto_create_key: false });
    else if (info.user_info.rpm_limit !== fields.rpm_limit || info.user_info.tpm_limit != null ||
      info.user_info.max_parallel_requests != null || info.user_info.budget_duration != null ||
      (maxBudget !== undefined && Math.abs((info.user_info.max_budget ?? 0) - maxBudget) > 1e-9))
      await this.client.request("/user/update", fields);
    const confirmed = (await this.client.request<UserInfo>(path)).user_info;
    if (confirmed?.user_id !== id || confirmed.rpm_limit !== fields.rpm_limit ||
      confirmed.tpm_limit != null || confirmed.max_parallel_requests != null || confirmed.budget_duration != null ||
      (maxBudget !== undefined && Math.abs((confirmed.max_budget ?? 0) - maxBudget) > 1e-9))
      fail(503, "GATEWAY_USER_UNCONFIRMED");
  }
  async syncVersion(versionId: string) {
    return this.serial(() => this.syncVersionUnlocked(versionId));
  }
  private async syncVersionUnlocked(
    versionId: string,
    secretOverride?: { secret: string; version: number },
  ) {
    const version = await this.versionRow(versionId);
    await this.deploymentRow(version.deploymentId);
    const provider = await this.providerRow(version.providerId);
    const secretRow = secretOverride ?? (await this.activeSecret(provider.id));
    if (!secretRow) fail(409, "PROVIDER_SECRET_REQUIRED");
    const { apiKey } = await this.secrets.open(secretRow.secret);
    const cost = await this.costForIdentity(provider.id, version.upstreamModel);
    if (this.settings.policy && !cost) fail(409, "MODEL_COST_REQUIRED");
    const modelName = `${upstreamPrefix(provider.format)}/${version.upstreamModel}`;
    const deepSeekOpenAi = provider.format === "openai_chat" &&
      ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(provider.apiBase);
    const allowedOpenAiParams = version.params.allowed_openai_params;
    const desired = {
      model: modelName,
      api_base: provider.apiBase,
      api_key: apiKey,
      ...version.params,
      // DeepSeek accepts this field, but LiteLLM's generic OpenAI route rejects it by default.
      ...(deepSeekOpenAi ? {
        allowed_openai_params: [...new Set([
          ...(Array.isArray(allowedOpenAiParams) ? allowedOpenAiParams : []),
          "reasoning_effort",
        ])],
      } : {}),
      ...(cost
        ? {
            ...modelPolicyFields(cost),
            timeout: cost.timeoutSeconds,
            stream_timeout: cost.timeoutSeconds,
            max_retries: 0,
          }
        : {}),
    };
    const info = await this.client.request<{ data: Array<{ model_info?: Record<string, unknown> }> }>("/model/info");
    const exists = info.data?.some((row) => row.model_info?.id === version.id);
    if (!exists)
      await this.client.request("/model/new", {
        model_name: version.routeName,
        litellm_params: desired,
        model_info: {
          id: version.id,
          harbor_deployment: version.deploymentId,
          ...(provider.format === "anthropic_compatible"
            ? { supported_endpoints: ["/v1/messages", "/v1/chat/completions"] }
            : {}),
        },
      });
    // 每次都写回完整期望配置，才能修复地址、密钥、能力或参数的漂移。
    const current = await this.client.request<{ data: Array<{ model_info?: Record<string, unknown> }> }>("/model/info");
    const currentInfo = current.data.find((row) => row.model_info?.id === version.id)?.model_info;
    await this.client.request("/model/update", {
      model_info: {
        ...currentInfo,
        id: version.id,
        ...(cost ? modelPolicyFields(cost) : {}),
      },
      litellm_params: desired,
    });
    const confirmed = await this.client.request<{
      data: Array<{ model_name?: string; model_info?: Record<string, unknown>; litellm_params?: Record<string, unknown> }>;
    }>("/model/info");
    const row = confirmed.data?.find((item) => item.model_info?.id === version.id);
    if (!row || row.model_name !== version.routeName) fail(503, "MODEL_SYNC_UNCONFIRMED");
    if (typeof row.litellm_params?.model === "string" && row.litellm_params.model !== modelName)
      fail(503, "MODEL_SYNC_UNCONFIRMED");
    if (typeof row.litellm_params?.api_base === "string" && row.litellm_params.api_base !== provider.apiBase)
      fail(503, "MODEL_SYNC_UNCONFIRMED");
    if (cost) {
      if (
        Object.entries(modelPolicyFields(cost)).some(([key, value]) => row.model_info?.[key] !== value) ||
        row.litellm_params?.timeout !== cost.timeoutSeconds ||
        row.litellm_params?.stream_timeout !== cost.timeoutSeconds ||
        row.litellm_params?.max_retries !== 0
      )
        fail(503, "MODEL_POLICY_UNCONFIRMED");
    }
    await this.db
      .update(versions)
      .set({ state: "ready", lastSyncedAt: Date.now() })
      .where(eq(versions.id, version.id));
  }
  /** 钱包授权Token只在Harbor有效；真实LiteLLM Key不会进入Runner。 */
  async walletConnection(token: string) {
    const hash = createHash("sha256").update(token).digest("hex");
    const [binding] = await this.db.select().from(bindings).where(eq(bindings.walletTokenHash, hash));
    if (!binding || binding.state !== "active") fail(401, "INVALID_INFERENCE_KEY");
    const [owner] = await this.db.select().from(users).where(eq(users.id, binding.ownerId));
    if (!owner || owner.disabled) fail(403, "ACCOUNT_DISABLED");
    const { deployment, version } = await this.allowedVersion(binding.ownerId, binding.deploymentId, binding.versionId);
    await this.syncUser(binding.ownerId);
    const secret = await this.secrets.open(binding.secret);
    const price = await this.currentPrice(deployment.id);
    if (!price) fail(409, "PRICE_REQUIRED");
    return {
      binding,
      deployment,
      version,
      price,
      upstreamToken: secret.token,
      logicalModel: secret.logicalModel ?? LOGICAL_MODEL,
    };
  }
  async runtime(session: {
    id: string;
    ownerId: string;
    modelSnapshot?: ModelSnapshot | null;
  }): Promise<GatewayConnection> {
    if (!session.modelSnapshot) fail(409, "SESSION_MODEL_NOT_BOUND");
    const snapshot = session.modelSnapshot;
    const requireOwner = async () => {
      const [owner] = await this.db.select().from(users).where(eq(users.id, session.ownerId));
      if (!owner || owner.disabled) fail(403, "ACCOUNT_DISABLED");
    };
    await requireOwner();
    return this.serial(async () => {
      const { deployment, version } = await this.allowedVersion(session.ownerId, snapshot.deploymentId, snapshot.versionId);
      await this.syncUser(session.ownerId);
      if (version.state !== "ready") await this.syncVersionUnlocked(version.id);
      let [row] = await this.db
        .select()
        .from(bindings)
        .where(and(eq(bindings.sessionId, session.id), ne(bindings.state, "revoked")));
      if (row?.state === "revoking") {
        await this.revokeRow(row);
        row = undefined!;
      }
      const routeName = version.routeName;
      type KeyInfo = { info?: { models?: string[]; aliases?: Record<string, string>; status?: string; expires?: string | null; blocked?: boolean;
        user_id?: string; tpm_limit?: number | null; max_parallel_requests?: number | null; budget_duration?: string | null } };
      const matches = (info: KeyInfo) => info.info?.status === "active" &&
        info.info.expires === null && info.info.blocked !== true &&
        info.info.models?.length === 1 && info.info.models[0] === routeName &&
        info.info.aliases?.[LOGICAL_MODEL] === routeName &&
        (!this.settings.policy || (info.info.user_id === gatewayUserId(session.ownerId) && info.info.tpm_limit == null &&
          info.info.max_parallel_requests == null && info.info.budget_duration == null));
      const priced = await this.pricedVersions();
      let secret: Record<string, string>;
      if (!row) {
        secret = {
          token: "sk-ah-" + randomBytes(32).toString("hex"),
          logicalModel: LOGICAL_MODEL,
          versionIds: JSON.stringify([version.id]),
          pricingKnown: priced.has(version.id) ? "true" : "false",
        };
        const walletToken = "ahw-" + randomBytes(32).toString("hex");
        secret.walletToken = walletToken;
        row = {
          id: randomUUID(),
          sessionId: session.id,
          ownerId: session.ownerId,
          deploymentId: deployment.id,
          versionId: version.id,
          secret: await this.secrets.seal(secret),
          walletTokenHash: createHash("sha256").update(walletToken).digest("hex"),
          state: "provisioning",
          expiresAt: null,
        };
        await this.db.insert(bindings).values(row);
      } else {
        secret = await this.secrets.open(row.secret);
      }
      const token = secret.token;
      let info: KeyInfo | undefined;
      try { info = await this.client.keyInfo<KeyInfo>(token); }
      catch (error) {
        if (!(error instanceof LiteLLMError) || error.status !== 404) throw error;
      }
      const legacyExpired = info?.info?.status === "expired" &&
        typeof info.info.expires === "string" && Number.isFinite(Date.parse(info.info.expires));
      if ((!info && row.state !== "provisioning") ||
          (info && ((!legacyExpired && info.info?.status !== "active") || info.info?.blocked === true)))
        fail(503, "MODEL_KEY_UNCONFIRMED");
      const knownVersions: string[] = JSON.parse(secret.versionIds ?? JSON.stringify([version.id]));
      if (!knownVersions.includes(version.id)) knownVersions.push(version.id);
      const nextSecret = {
        ...secret,
        logicalModel: LOGICAL_MODEL,
        versionIds: JSON.stringify(knownVersions),
        pricingKnown:
          secret.pricingKnown === "true" && knownVersions.every((id) => priced.has(id))
            ? "true"
            : "false",
        walletToken: secret.walletToken ?? "ahw-" + randomBytes(32).toString("hex"),
      };
      // 先落库意图，再进行外部写入；状态不明时绝不发送用户输入。
      await this.db
        .update(bindings)
        .set({
          deploymentId: deployment.id,
          versionId: version.id,
          state: info ? "updating" : "provisioning",
          secret: await this.secrets.seal(nextSecret),
          walletTokenHash: createHash("sha256").update(nextSecret.walletToken).digest("hex"),
        })
        .where(eq(bindings.id, row.id));
      const aliases = { [LOGICAL_MODEL]: routeName };
      if (!info) {
        await this.client.request("/key/generate", {
          key: token,
          key_alias: `harbor-${row.id}`,
          key_type: "llm_api",
          models: [routeName],
          aliases,
          duration: null,
          ...(this.settings.sessionBudgetUsd ? { max_budget: this.settings.sessionBudgetUsd } : {}),
          metadata: { harbor_owner: session.ownerId, harbor_session: session.id },
          ...(this.settings.policy
            ? { user_id: gatewayUserId(session.ownerId), tpm_limit: null, max_parallel_requests: null, budget_duration: null }
            : {}),
        });
      } else if (!matches(info)) {
        // 原地更新同一 Token；不重建容器、不重置累计费用。
        await this.client.request("/key/update", {
          key: token,
          models: [routeName],
          aliases,
          duration: null,
          ...(this.settings.policy
            ? { user_id: gatewayUserId(session.ownerId), tpm_limit: null, max_parallel_requests: null, budget_duration: null }
            : {}),
        });
      }
      const confirmed = await this.client.keyInfo<KeyInfo>(token);
      if (!matches(confirmed)) fail(503, "MODEL_KEY_UNCONFIRMED");
      await this.db
        .update(bindings)
        .set({
          state: "active",
          deploymentId: deployment.id,
          versionId: version.id,
          expiresAt: null,
          walletTokenHash: createHash("sha256").update(nextSecret.walletToken).digest("hex"),
        })
        .where(eq(bindings.id, row.id));
      // 管理员停用可能发生在远端 await 期间，返回前再次验证。
      await this.allowedVersion(session.ownerId, deployment.id, version.id);
      await requireOwner();
      return {
        url: this.settings.walletProxyUrl ?? this.settings.inferenceUrl,
        token: this.settings.walletProxyUrl ? nextSecret.walletToken : token,
        model: LOGICAL_MODEL,
        bindingId: row.id,
      };
    });
  }
  /** 读取 LiteLLM 中已具备输入/输出价格的版本 id；用于区分“未计价”和“免费”。 */
  private async pricedVersions(): Promise<Set<string>> {
    try {
      const result = await this.client.request<{
        data: Array<{
          model_info?: {
            id?: string;
            input_cost_per_token?: number;
            output_cost_per_token?: number;
          };
        }>;
      }>("/model/info");
      return new Set(
        result.data
          .filter((row) =>
            [
              row.model_info?.input_cost_per_token,
              row.model_info?.output_cost_per_token,
            ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
          )
          .map((row) => row.model_info!.id!),
      );
    } catch {
      return new Set();
    }
  }
  private async revokeRow(row: typeof bindings.$inferSelect) {
    await this.db
      .update(bindings)
      .set({ state: "revoking" })
      .where(eq(bindings.id, row.id));
    const { token } = await this.secrets.open(row.secret);
    try {
      await this.client.request("/key/delete", { keys: [token] });
    } catch (error) {
      if (!(error instanceof LiteLLMError) || error.status !== 404) throw error;
    }
    try {
      const info = await this.client.keyInfo<{ info?: { status?: string } }>(token);
      if (info.info?.status !== "deleted") fail(503, "MODEL_REVOKE_UNCONFIRMED");
    } catch (error) {
      if (!(error instanceof LiteLLMError) || error.status !== 404) throw error;
    }
    await this.db
      .update(bindings)
      .set({ state: "revoked" })
      .where(eq(bindings.id, row.id));
  }
  async revokeSession(id: string) {
    return this.serial(async () => {
      const rows = await this.db
        .select()
        .from(bindings)
        .where(and(eq(bindings.sessionId, id), ne(bindings.state, "revoked")));
      for (const row of rows) await this.revokeRow(row);
    });
  }
  async revokeUser(user: string) {
    const rows = await this.db
      .select()
      .from(bindings)
      .where(and(eq(bindings.ownerId, user), ne(bindings.state, "revoked")));
    const results = await Promise.allSettled(
      rows.map((row) => this.revokeSession(row.sessionId)),
    );
    if (results.some((result) => result.status === "rejected"))
      fail(503, "MODEL_REVOKE_UNCONFIRMED");
  }
  /** 单会话网关观测，逐凭据相加；缺失仍为unknown。 */
  async usage(sessionId: string, ownerId: string) {
    const rows = await this.db
      .select()
      .from(bindings)
      .where(and(eq(bindings.sessionId, sessionId), eq(bindings.ownerId, ownerId)));
    if (this.settings.policy) {
      const events = await this.db.select().from(gatewayUsageEvents).where(and(
        eq(gatewayUsageEvents.sessionId, sessionId), eq(gatewayUsageEvents.ownerId, ownerId),
      ));
      const source = createHash("sha256").update(this.settings.managementUrl).digest("hex").slice(0, 16);
      const [sync] = await this.db.select().from(gatewaySyncState).where(eq(gatewaySyncState.id, source));
      if (events.length) {
        const unknown = events.filter(event => !event.pricingKnown || event.spendUsd === null).length;
        return { source: "litellm", knownUsd: events.filter(event => event.pricingKnown).reduce((sum, event) => sum + (event.spendUsd ?? 0), 0),
          unknownCredentials: unknown, pricingKnown: unknown === 0, credentials: rows.length, complete: unknown === 0,
          observedAt: Date.now(), lastSyncedAt: sync?.lastSuccessAt ?? null,
          syncDelayed: !sync || Date.now() - sync.lastSuccessAt > 60_000 };
      }
    }
    let knownUsd = 0,
      unknown = 0,
      pricingKnown = rows.length > 0;
    for (const row of rows) {
      try {
        const secret = await this.secrets.open(row.secret),
          token = secret.token;
        if (secret.pricingKnown !== "true") {
          pricingKnown = false;
          unknown++;
          continue;
        }
        const info = await this.client.keyInfo<{ info?: { spend?: number } }>(token);
        if (
          typeof info.info?.spend === "number" &&
          Number.isFinite(info.info.spend) &&
          info.info.spend >= 0
        )
          knownUsd += info.info.spend;
        else unknown++;
      } catch {
        unknown++;
      }
    }
    return {
      source: "litellm",
      knownUsd,
      unknownCredentials: unknown,
      pricingKnown,
      credentials: rows.length,
      complete: rows.length > 0 && unknown === 0,
      observedAt: Date.now(),
    };
  }
  /** 宿主恢复已清理旧Runner，旧Key不再续用；失败让服务保持未就绪。 */
  async recover() {
    const rows = await this.db
      .select()
      .from(bindings)
      .where(ne(bindings.state, "revoked"));
    for (const row of rows) await this.revokeSession(row.sessionId);
  }
}
