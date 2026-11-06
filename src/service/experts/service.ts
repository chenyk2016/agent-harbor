/** 专家是角色版本与Skill引用的薄层；安装和停止依旧由Skill模块持有。 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  experts,
  expertVersions,
  expertInstalls,
  expertInstallSkills,
  skills,
  skillVersions,
} from "../db/schema/index.js";
import type { ExpertDefinition, ExpertSnapshot } from "../../shared/experts.js";
import { SkillService, digest, requireId } from "../skills/service.js";
import { SkillBuildManager } from "../skills/build-manager.js";
import { localized } from "./workbuddy.js";
import { ExpertConnectionService } from "./connections.js";
import type { PreparedExpertPackage } from "./packages.js";
import { importExpertPackage, originalExpertArchive } from "./packages.js";
import { definition, instructions } from "./definition.js";
import { fail } from "../types.js";
export class ExpertService {
  readonly connections: ExpertConnectionService;
  private installationWrites = new Map<string, Promise<void>>();
  /** 同用户的取消和重试不能交错，避免取消后重新加入等待；跨用户不互相阻塞。 */
  private async mutateInstallation<T>(
    user: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.installationWrites.get(user) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.installationWrites.set(user, next);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.installationWrites.get(user) === next)
        this.installationWrites.delete(user);
    }
  }

  constructor(
    readonly library: SkillService,
    readonly builds: SkillBuildManager,
  ) {
    this.connections = new ExpertConnectionService(library.db, library.root);
  }
  private get db() {
    return this.library.db;
  }
  private async lock(tx: import("../db/client.js").Tx, key: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"expert:" + key}, 0))`,
    );
  }
  async owned(user: string, id: string, write = false) {
    const [row] = await this.db
      .select()
      .from(experts)
      .where(eq(experts.id, id));
    if (
      !row ||
      (row.ownerId !== user && row.source !== "builtin") ||
      (write &&
        (row.ownerId !== user ||
          row.source !== "private" ||
          row.status !== "active"))
    )
      fail(404, "EXPERT_NOT_FOUND");
    return row;
  }
  async version(user: string, id: string) {
    const [version] = await this.db
      .select()
      .from(expertVersions)
      .where(eq(expertVersions.id, id));
    if (!version) fail(404, "EXPERT_NOT_FOUND");
    return { expert: await this.owned(user, version.expertId), version };
  }
  private async bindings(
    user: string,
    value: ExpertDefinition,
    builtin = false,
  ) {
    const names = new Set<string>();
    for (const id of value.skillVersionIds) {
      const { skill } = await this.library.version(user, id);
      if (skill.status !== "active") fail(409, "SKILL_DISABLED");
      if (builtin && skill.source !== "builtin")
        fail(400, "PRIVATE_SKILL_IN_BUILTIN");
      const name = `${skill.source}:${skill.slug}`;
      if (names.has(name)) fail(400, "DUPLICATE_SKILL_SELECTION");
      names.add(name);
    }
  }
  async skillChoices(user: string) {
    return this.db
      .select({
        id: skillVersions.id,
        skillId: skills.id,
        name: skills.displayName,
        source: skills.source,
        version: skillVersions.versionNumber,
      })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(
        and(
          or(eq(skills.ownerId, user), eq(skills.source, "builtin")),
          eq(skills.status, "active"),
          sql`${skills.packageScope} is null`,
        ),
      )
      .orderBy(skills.displayName, desc(skillVersions.versionNumber));
  }
  async list(user: string) {
    const rows = await this.db
      .select({ expert: experts, definition: expertVersions.definition })
      .from(experts)
      .innerJoin(
        expertVersions,
        eq(experts.currentVersionId, expertVersions.id),
      )
      .where(
        and(
          or(eq(experts.ownerId, user), eq(experts.source, "builtin")),
          eq(experts.status, "active"),
        ),
      )
      .orderBy(desc(experts.updatedAt))
      .limit(100);
    return rows.map(({ expert, definition }) => {
      const bundle = definition.workbuddy,
        manifest = bundle?.manifest;
      return {
        ...expert,
        ...(manifest
          ? {
              profession: localized(manifest.profession),
              categoryId:
                typeof manifest.categoryId === "string"
                  ? manifest.categoryId
                  : undefined,
              tags: Array.isArray(manifest.tags)
                ? manifest.tags.map((value) => localized(value)).filter(Boolean)
                : [],
              expertType: bundle!.expertType,
              avatar:
                typeof manifest.avatar === "string" &&
                !bundle!.warnings.some((warning) => warning.includes("头像"))
                  ? `/api/expert-versions/${expert.currentVersionId}/avatar`
                  : undefined,
            }
          : {}),
      };
    });
  }
  async detail(user: string, id: string) {
    const expert = await this.owned(user, id);
    const versions = await this.db
      .select()
      .from(expertVersions)
      .where(eq(expertVersions.expertId, id))
      .orderBy(desc(expertVersions.versionNumber));
    return { ...expert, versions };
  }
  async save(
    user: string,
    requestId: string,
    value: unknown,
    id?: string,
    expectedVersionId?: string,
    prepared?: PreparedExpertPackage,
  ) {
    requireId(requestId);
    const input = prepared?.definition ?? definition(value),
      hash = digest([
        id ?? null,
        expectedVersionId ?? null,
        prepared ? prepared.definition.workbuddy!.archiveHash : input,
      ]);
    return this.db.transaction(async (tx) => {
      await this.lock(tx, user);
      if (id) {
        const old = await this.owned(user, id, true);
        const [duplicate] = await tx
          .select()
          .from(expertVersions)
          .where(
            and(
              eq(expertVersions.expertId, id),
              eq(expertVersions.clientRequestId, requestId),
            ),
          );
        if (duplicate) {
          if (duplicate.requestHash !== hash) fail(409, "REQUEST_ID_CONFLICT");
          return this.detail(user, id);
        }
        if (old.currentVersionId !== expectedVersionId)
          fail(409, "EXPERT_VERSION_CONFLICT");
      } else {
        const [old] = await tx
          .select()
          .from(experts)
          .where(
            and(
              eq(experts.ownerId, user),
              eq(experts.creationRequestId, requestId),
            ),
          );
        if (old) {
          if (old.creationRequestHash !== hash)
            fail(409, "REQUEST_ID_CONFLICT");
          return this.detail(user, old.id);
        }
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(experts)
          .where(and(eq(experts.ownerId, user), eq(experts.status, "active")));
        if (count.n >= 50) fail(409, "EXPERT_LIMIT");
      }
      if (!prepared) await this.bindings(user, input);
      const expertId = id ?? randomUUID(),
        versionId = randomUUID();
      const [last] = id
        ? await tx
            .select()
            .from(expertVersions)
            .where(eq(expertVersions.expertId, id))
            .orderBy(desc(expertVersions.versionNumber))
            .limit(1)
        : [];
      if (!id)
        await tx.insert(experts).values({
          id: expertId,
          ownerId: user,
          source: "private",
          name: input.name,
          description: input.description,
          currentVersionId: versionId,
          creationRequestId: requestId,
          creationRequestHash: hash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      // 包内技能和专家修订原子登记，安装继续复用原有构建引擎。
      for (const item of prepared?.skills ?? []) {
        const manifest = item.checked.report.manifest!;
        await tx.insert(skills).values({
          id: item.id,
          ownerId: user,
          source: "private",
          slug: manifest.name,
          packageScope: prepared!.scope,
          displayName: manifest.name,
          currentVersionId: item.versionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await tx.insert(skillVersions).values({
          id: item.versionId,
          skillId: item.id,
          versionNumber: 1,
          sourceHash: item.checked.report.digest!,
          sourcePath: item.sourcePath,
          manifest,
          fileCount: item.checked.files.length,
          sizeBytes: manifest.sizeBytes,
          publishRequestId: requestId,
          publishRequestHash: hash,
          createdAt: Date.now(),
        });
      }
      await tx.insert(expertVersions).values({
        id: versionId,
        expertId,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        definition: input,
        instructions: instructions(input),
        contentHash: digest([1, input]),
        clientRequestId: requestId,
        requestHash: hash,
        createdAt: Date.now(),
      });
      await tx
        .update(experts)
        .set({
          name: input.name,
          description: input.description,
          currentVersionId: versionId,
          updatedAt: Date.now(),
        })
        .where(eq(experts.id, expertId));
      // 返回事务中刚保存的内容，不用另一个连接读取尚未提交的版本。
      return {
        ...(await tx.select().from(experts).where(eq(experts.id, expertId)))[0],
        versions: await tx
          .select()
          .from(expertVersions)
          .where(eq(expertVersions.expertId, expertId))
          .orderBy(desc(expertVersions.versionNumber)),
      };
    });
  }
  async copy(user: string, versionId: string, requestId: string) {
    const { version } = await this.version(user, versionId);
    if (version.definition.workbuddy)
      return importExpertPackage(
        this,
        user,
        requestId,
        await originalExpertArchive(this, user, versionId),
      );
    return this.save(user, requestId, version.definition);
  }
  /** 受信离线分发入口：内置专家只允许引用平台技能，不执行包内脚本。 */
  async installBuiltin(value: unknown) {
    const input = definition(value);
    await this.bindings("", input, true);
    return this.db.transaction(async (tx) => {
      await this.lock(tx, "builtin");
      const [old] = await tx
        .select()
        .from(experts)
        .where(
          and(eq(experts.source, "builtin"), eq(experts.name, input.name)),
        );
      const [last] = old
        ? await tx
            .select()
            .from(expertVersions)
            .where(eq(expertVersions.id, old.currentVersionId))
        : [];
      const contentHash = digest([1, input]);
      if (last?.contentHash === contentHash)
        return { id: old.id, versionId: last.id };
      const id = old?.id ?? randomUUID(),
        versionId = randomUUID();
      if (!old)
        await tx.insert(experts).values({
          id,
          source: "builtin",
          name: input.name,
          description: input.description,
          currentVersionId: versionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      await tx.insert(expertVersions).values({
        id: versionId,
        expertId: id,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        definition: input,
        instructions: instructions(input),
        contentHash,
        clientRequestId: randomUUID(),
        requestHash: contentHash,
        createdAt: Date.now(),
      });
      await tx
        .update(experts)
        .set({
          description: input.description,
          currentVersionId: versionId,
          updatedAt: Date.now(),
        })
        .where(eq(experts.id, id));
      return { id, versionId };
    });
  }
  async remove(user: string, id: string) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, user);
      await this.owned(user, id, true);
      await tx
        .update(experts)
        .set({ status: "deleted", updatedAt: Date.now() })
        .where(eq(experts.id, id));
    });
  }
  install(user: string, versionId: string) {
    return this.mutateInstallation(user, () => this.installIn(user, versionId));
  }
  private async installIn(user: string, versionId: string) {
    const { expert, version } = await this.version(user, versionId);
    if (expert.status !== "active") fail(409, "EXPERT_DISABLED");
    const imageId = await this.builds.driver.imageId();
    const id = await this.db.transaction(async (tx) => {
      await this.lock(tx, user);
      const [current] = await tx
        .select()
        .from(experts)
        .where(eq(experts.id, expert.id));
      if (current.status !== "active") fail(409, "EXPERT_DISABLED");
      const [old] = await tx
        .select()
        .from(expertInstalls)
        .where(
          and(
            eq(expertInstalls.userId, user),
            eq(expertInstalls.versionId, versionId),
            eq(expertInstalls.imageId, imageId),
            sql`${expertInstalls.status} <> 'cancelled'`,
          ),
        );
      if (old) return old.id;
      const id = randomUUID();
      await tx.insert(expertInstalls).values({
        id,
        userId: user,
        versionId,
        imageId,
        createdAt: Date.now(),
      });
      for (const skillId of version.definition.skillVersionIds) {
        const request = await this.builds.registerRequest(
          tx,
          user,
          skillId,
          randomUUID(),
          imageId,
        );
        await tx.insert(expertInstallSkills).values({
          id: randomUUID(),
          installId: id,
          versionId: skillId,
          requestId: request.id,
        });
      }
      return id;
    });
    this.builds.wake();
    return this.installation(user, id);
  }
  async installation(user: string, id: string) {
    const [install] = await this.db
      .select()
      .from(expertInstalls)
      .where(and(eq(expertInstalls.id, id), eq(expertInstalls.userId, user)));
    if (!install) fail(404, "EXPERT_INSTALL_NOT_FOUND");
    const links = await this.db
      .select()
      .from(expertInstallSkills)
      .where(eq(expertInstallSkills.installId, id));
    const items = await Promise.all(
      links.map(async (link) => ({
        name: (await this.library.version(user, link.versionId)).skill
          .displayName,
        versionId: link.versionId,
        ...(await this.builds.detail(user, link.requestId)),
      })),
    );
    const state =
      install.status !== "active"
        ? install.status
        : items.some((item) => item.request.state === "waiting")
          ? "installing"
          : items.every(
                (item) =>
                  item.request.state === "ready" &&
                  item.build.state === "ready",
              )
            ? "ready"
            : "failed";
    return { ...install, state, items };
  }
  async latestInstall(user: string, versionId: string) {
    await this.version(user, versionId);
    const imageId = await this.builds.driver.imageId();
    const [row] = await this.db
      .select()
      .from(expertInstalls)
      .where(
        and(
          eq(expertInstalls.userId, user),
          eq(expertInstalls.versionId, versionId),
          eq(expertInstalls.imageId, imageId),
        ),
      )
      .orderBy(desc(expertInstalls.createdAt))
      .limit(1);
    return row ? this.installation(user, row.id) : null;
  }
  cancel(user: string, id: string) {
    return this.mutateInstallation(user, () => this.cancelIn(user, id));
  }
  private async cancelIn(user: string, id: string) {
    const current = await this.installation(user, id);
    if (current.status === "cancelled") return current;
    await this.db
      .update(expertInstalls)
      .set({ status: "cancelling" })
      .where(eq(expertInstalls.id, id));
    // 先持久化取消意图；重启后继续完成未取消完的子请求。
    for (const item of current.items)
      await this.builds.cancel(user, item.request.id);
    await this.db
      .update(expertInstalls)
      .set({ status: "cancelled" })
      .where(eq(expertInstalls.id, id));
    return this.installation(user, id);
  }
  retry(user: string, id: string, requestId: string, attempt: number) {
    return this.mutateInstallation(user, () =>
      this.retryIn(user, id, requestId, attempt),
    );
  }
  private async retryIn(
    user: string,
    id: string,
    requestId: string,
    attempt: number,
  ) {
    const install = await this.installation(user, id);
    if (
      install.status !== "active" ||
      !install.items.some((item) => item.request.id === requestId)
    )
      fail(409, "EXPERT_INSTALL_INACTIVE");
    await this.builds.rejoin(user, requestId, attempt);
    return this.installation(user, id);
  }
  async initialize() {
    const rows = await this.db
      .select()
      .from(expertInstalls)
      .where(eq(expertInstalls.status, "cancelling"));
    for (const row of rows) await this.cancel(row.userId, row.id);
  }
  async runtimeConnections(user: string, versionId: string) {
    const { version } = await this.version(user, versionId);
    return version.definition.workbuddy
      ? this.connections.runtime(user, version.definition.workbuddy)
      : {};
  }
  async resolve(user: string, versionId: string) {
    const { expert, version } = await this.version(user, versionId);
    if (expert.status !== "active") fail(409, "EXPERT_DISABLED");
    const install = await this.latestInstall(user, versionId);
    if (!install || install.state !== "ready") fail(409, "EXPERT_NOT_READY");
    const capabilities = await this.builds.selection(
      user,
      version.definition.skillVersionIds,
    );
    const bundle = version.definition.workbuddy;
    if (bundle) await this.connections.runtime(user, bundle);
    if (bundle) {
      const names = new Set(capabilities.skills.map((skill) => skill.name));
      for (const agent of Object.values(bundle.agents))
        for (const name of agent.skills)
          if (!names.has(name)) fail(409, "WORKBUDDY_PRELOAD_MISSING");
    }
    const preloadedSkills = [];
    if (bundle)
      for (const entry of capabilities.skills) {
        const { manifest } = await this.library.version(user, entry.versionId);
        preloadedSkills.push({
          name: entry.name,
          body: manifest.body,
          directory: `/opt/harbor-skills/workbuddy-config/.claude/skills/${entry.name}`,
        });
      }
    const snapshot: ExpertSnapshot = {
      ...(bundle
        ? {
            workbuddy: {
              expertType: bundle.expertType,
              agentName: bundle.agentName,
              agents: bundle.agents,
              packageHash: bundle.archiveHash,
              preloadedSkills,
            },
          }
        : {}),
      schemaVersion: 1,
      expertId: expert.id,
      versionId: version.id,
      version: version.versionNumber,
      name: version.definition.name,
      instructions: version.instructions,
      examples: version.definition.examples,
      digest: digest([1, version.id, version.contentHash, capabilities.digest]),
    };
    return { expert: snapshot, capabilities };
  }
}
