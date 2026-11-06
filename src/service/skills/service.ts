/** 个人技能库的业务主线：校验原件 → 保存不可变版本 → 安装启用。文件先发布，DB后引用。 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, or, sql, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  skills,
  skillVersions,
  skillImports,
  skillBuildRequests,
  skillBuilds,
  userSkills,
} from "../db/schema/index.js";
import { fail } from "../types.js";
import {
  PackageStore,
  type SourceFile,
  type CheckedPackage,
} from "./package-store.js";
import type { SkillManifest } from "./manifest.js";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const requireId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    fail(400, "INVALID_REQUEST_ID");
  return value;
};
export class SkillService {
  readonly packages: PackageStore;
  private mutation = Promise.resolve();
  constructor(
    readonly db: Database,
    readonly root: string,
  ) {
    this.packages = new PackageStore(root);
  }
  /** 文件发布不在SQL事务内等待；此短队列保护本服务的版本指针与请求去重。 */
  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async owned(userId: string, id: string, write = false) {
    const [skill] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.id, id));
    if (!skill || (skill.ownerId !== userId && skill.source !== "builtin"))
      fail(404, "SKILL_NOT_FOUND");
    if (
      write &&
      (skill.ownerId !== userId ||
        skill.source !== "private" ||
        skill.status === "deleted" ||
        skill.packageScope !== null)
    )
      fail(404, "SKILL_NOT_FOUND");
    return skill;
  }
  async version(userId: string, id: string) {
    const [version] = await this.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, id));
    if (!version) fail(404, "SKILL_NOT_FOUND");
    const skill = await this.owned(userId, version.skillId);
    return { skill, version, manifest: version.manifest as SkillManifest };
  }
  async list(userId: string) {
    const rows = await this.db
      .select()
      .from(skills)
      .where(
        and(
          or(eq(skills.ownerId, userId), eq(skills.source, "builtin")),
          sql`${skills.status} <> 'deleted'`,
          sql`${skills.packageScope} is null`,
        ),
      )
      .orderBy(desc(skills.updatedAt))
      .limit(100);
    const settings = await this.db
      .select()
      .from(userSkills)
      .where(eq(userSkills.userId, userId));
    const versions = rows.length
      ? await this.db
          .select()
          .from(skillVersions)
          .where(
            inArray(
              skillVersions.skillId,
              rows.map((row) => row.id),
            ),
          )
      : [];
    const pendingIds = settings.flatMap((setting) =>
      setting.pendingRequestId ? [setting.pendingRequestId] : [],
    );
    const installations = pendingIds.length
      ? await this.db
          .select({
            id: skillBuildRequests.id,
            state: skillBuildRequests.state,
            error: skillBuilds.error,
          })
          .from(skillBuildRequests)
          .innerJoin(
            skillBuilds,
            eq(skillBuildRequests.buildId, skillBuilds.id),
          )
          .where(inArray(skillBuildRequests.id, pendingIds))
      : [];
    return rows.map((skill) => ({
      ...skill,
      draftPath: undefined,
      draftRevision: undefined,
      description:
        (
          versions.find((version) => version.id === skill.currentVersionId)
            ?.manifest as SkillManifest | undefined
        )?.description ?? "",
      versionNumber: versions.find(
        (version) => version.id === skill.currentVersionId,
      )?.versionNumber,
      installation: installations.find(
        (item) =>
          item.id ===
          settings.find((setting) => setting.skillId === skill.id)
            ?.pendingRequestId,
      ),
      setting: settings.find((setting) => setting.skillId === skill.id) ?? null,
    }));
  }
  async detail(userId: string, id: string) {
    const skill = await this.owned(userId, id);
    const versions = await this.db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, id))
      .orderBy(desc(skillVersions.versionNumber));
    const [setting] = await this.db
      .select()
      .from(userSkills)
      .where(and(eq(userSkills.userId, userId), eq(userSkills.skillId, id)));
    return {
      ...skill,
      draftPath: undefined,
      draftRevision: undefined,
      versions: versions.map((version) => ({
        ...version,
        sourcePath: undefined,
      })),
      setting: setting ?? null,
    };
  }
  private checked(files: SourceFile[], slug?: string) {
    const checked = this.packages.check(files);
    if (!checked.report.ok) fail(400, "INVALID_SKILL_PACKAGE");
    if (slug && checked.report.manifest!.name !== slug)
      fail(400, "SKILL_SLUG_IMMUTABLE");
    return checked;
  }
  async create(
    userId: string,
    requestId: string,
    displayName: string,
    files: SourceFile[],
  ) {
    return this.mutate(() =>
      this.createIn(userId, requireId(requestId), displayName, files),
    );
  }
  private async createIn(
    userId: string,
    requestId: string,
    displayName: string,
    files: SourceFile[],
  ) {
    displayName = this.name(displayName);
    const checked = this.checked(files),
      requestHash = digest([displayName, checked.report.digest]);
    const [old] = await this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.ownerId, userId),
          eq(skills.creationRequestId, requestId),
        ),
      );
    if (old) {
      if (old.creationRequestHash !== requestHash)
        fail(409, "REQUEST_ID_CONFLICT");
      return this.detail(userId, old.id);
    }
    if (
      (await this.list(userId)).filter((skill) => skill.ownerId === userId)
        .length >= 50
    )
      fail(409, "SKILL_LIMIT");
    const slug = checked.report.manifest!.name;
    const [same] = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.ownerId, userId), eq(skills.slug, slug),sql`${skills.packageScope} is null`));
    if (same) fail(409, "SKILL_SLUG_EXISTS");
    const id = randomUUID(),
      versionId = randomUUID(),
      path = `${this.packages.skillPath(userId, id)}/versions/${versionId}`;
    await this.packages.sourceQuota(userId, checked.files);
    await this.packages.publish(path, checked.files);
    // 文件完整落盘后，再一次提交技能和 v1；读者不会看到半份版本。
    await this.db.transaction(async (tx) => {
      await tx
        .insert(skills)
        .values({
          id,
          ownerId: userId,
          source: "private",
          slug,
          displayName,
          currentVersionId: versionId,
          creationRequestId: requestId,
          creationRequestHash: requestHash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      await tx
        .insert(skillVersions)
        .values(
          this.versionValues(
            id,
            versionId,
            1,
            path,
            checked,
            requestId,
            requestHash,
          ),
        );
    });
    return this.detail(userId, id);
  }
  private name(value: string) {
    if (typeof value !== "string" || !value.trim() || value.length > 200)
      fail(400, "INVALID_SKILL_NAME");
    return value.trim();
  }
  private versionValues(
    skillId: string,
    id: string,
    number: number,
    path: string,
    checked: CheckedPackage,
    requestId: string,
    hash: string,
  ) {
    return {
      id,
      skillId,
      versionNumber: number,
      sourceHash: checked.report.digest!,
      manifest: checked.report.manifest!,
      fileCount: checked.files.length,
      sizeBytes: checked.report.manifest!.sizeBytes,
      sourcePath: path,
      // 沿用数据库历史列名，含义现在是“保存请求”，用于重复提交去重。
      publishRequestId: requestId,
      publishRequestHash: hash,
      createdAt: Date.now(),
    };
  }
  private async savedRequest(id: string, requestId: string, hash: string) {
    const [old] = await this.db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, id),
          eq(skillVersions.publishRequestId, requestId),
        ),
      );
    if (old && old.publishRequestHash !== hash)
      fail(409, "REQUEST_ID_CONFLICT");
    return old;
  }
  /** 每次保存生成新目录和版本；expectedVersionId 防止两个页面互相覆盖。 */
  async save(
    userId: string,
    id: string,
    expectedVersionId: string,
    requestId: string,
    changes: { path: string; text?: string; remove?: boolean }[],
    displayName?: string,
  ) {
    return this.mutate(async () => {
      const skill = await this.owned(userId, id, true);
      requireId(requestId);
      const hash = digest([expectedVersionId, changes, displayName ?? null]);
      if (await this.savedRequest(id, requestId, hash))
        return this.detail(userId, id);
      if (skill.currentVersionId !== expectedVersionId)
        fail(409, "VERSION_CONFLICT");
      const { version } = await this.version(userId, expectedVersionId);
      const files = new Map(
        (await this.packages.files(version.sourcePath)).map((file) => [
          file.path,
          file,
        ]),
      );
      for (const change of changes) {
        if (
          typeof change.path !== "string" ||
          change.path.length > 200 ||
          (change.text !== undefined &&
            (typeof change.text !== "string" ||
              Buffer.byteLength(change.text) > 1024 * 1024))
        )
          fail(400, "INVALID_SKILL_FILE");
        if (change.remove) files.delete(change.path);
        else if (change.text !== undefined)
          files.set(change.path, {
            path: change.path,
            content: Buffer.from(change.text),
          });
      }
      await this.appendVersion(
        skill,
        this.checked([...files.values()], skill.slug),
        requestId,
        hash,
        displayName === undefined ? skill.displayName : this.name(displayName),
      );
      return this.detail(userId, id);
    });
  }
  private async appendVersion(
    skill: typeof skills.$inferSelect,
    checked: CheckedPackage,
    requestId: string,
    hash: string,
    name = skill.displayName,
    imported?: { id: string; report: Record<string, unknown> },
  ) {
    const versionId = randomUUID(),
      path = `${this.packages.skillPath(skill.ownerId!, skill.id)}/versions/${versionId}`;
    await this.packages.sourceQuota(skill.ownerId!, checked.files);
    await this.packages.publish(path, checked.files);
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(skills)
        .where(eq(skills.id, skill.id))
        .for("update");
      if (current.currentVersionId !== skill.currentVersionId)
        fail(409, "VERSION_CONFLICT");
      const [last] = await tx
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skill.id))
        .orderBy(desc(skillVersions.versionNumber))
        .limit(1);
      await tx
        .insert(skillVersions)
        .values(
          this.versionValues(
            skill.id,
            versionId,
            (last?.versionNumber ?? 0) + 1,
            path,
            checked,
            requestId,
            hash,
          ),
        );
      await tx
        .update(skills)
        .set({
          currentVersionId: versionId,
          displayName: name,
          draftPath: null,
          updatedAt: Date.now(),
        })
        .where(eq(skills.id, skill.id));
      // 替换导入与版本指针一起提交，重试不会多出一个版本。
      if (imported)
        await tx
          .update(skillImports)
          .set({
            status: "applied",
            targetSkillId: skill.id,
            resultVersionId: versionId,
            report: imported.report,
            updatedAt: Date.now(),
          })
          .where(eq(skillImports.id, imported.id));
    });
  }
  /** 升级旧数据时离线调用：有未发布内容就保留为版本，不删除原文件。 */
  async migrateDrafts() {
    return this.mutate(async () => {
      const rows = await this.db
        .select()
        .from(skills)
        .where(
          and(
            eq(skills.source, "private"),
            sql`${skills.draftPath} is not null`,
            sql`${skills.status} <> 'deleted'`,
          sql`${skills.packageScope} is null`,
          ),
        );
      let promoted = 0;
      for (const skill of rows) {
        const checked = this.checked(
          await this.packages.files(skill.draftPath!),
          skill.slug,
        );
        const current = skill.currentVersionId
          ? (await this.version(skill.ownerId!, skill.currentVersionId)).version
          : undefined;
        if (current?.sourceHash !== checked.report.digest) {
          await this.appendVersion(
            skill,
            checked,
            randomUUID(),
            digest(["legacy", skill.draftPath]),
          );
          promoted++;
        } else
          await this.db
            .update(skills)
            .set({ draftPath: null })
            .where(eq(skills.id, skill.id));
      }
      return { scanned: rows.length, promoted };
    });
  }
  async newImport(
    userId: string,
    requestId: string,
    fileName: string,
    size: number,
    sha256: string,
  ) {
    return this.mutate(async () => {
      requireId(requestId);
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 20 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(sha256)
      )
        fail(400, "INVALID_IMPORT");
      const hash = digest([fileName, size, sha256]);
      const [old] = await this.db
        .select()
        .from(skillImports)
        .where(
          and(
            eq(skillImports.userId, userId),
            eq(skillImports.clientRequestId, requestId),
          ),
        );
      if (old) {
        if (old.clientRequestHash !== hash) fail(409, "REQUEST_ID_CONFLICT");
        return old;
      }
      const id = randomUUID();
      const [row] = await this.db
        .insert(skillImports)
        .values({
          id,
          userId,
          clientRequestId: requestId,
          clientRequestHash: hash,
          fileName: this.name(fileName),
          expectedSize: size,
          expectedSha256: sha256,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .returning();
      return row;
    });
  }
  async importRecord(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(skillImports)
      .where(and(eq(skillImports.id, id), eq(skillImports.userId, userId)));
    if (!row) fail(404, "IMPORT_NOT_FOUND");
    return row;
  }
  async upload(userId: string, id: string, content: Buffer) {
    return this.mutate(async () => {
      const row = await this.importRecord(userId, id);
      if (
        row.expectedSize !== content.length ||
        row.expectedSha256 !==
          createHash("sha256").update(content).digest("hex")
      )
        fail(409, "IMPORT_CONTENT_MISMATCH");
      if (row.status === "checked" || row.status === "applied") return row;
      const checked = await this.packages.unzip(content),
        path = `users/${this.packages.ownerKey(userId)}/skill-imports/${id}/${randomUUID()}`;
      if (checked.report.ok) {
        await this.packages.sourceQuota(userId, checked.files);
        await this.packages.publish(path, checked.files);
      }
      const [updated] = await this.db
        .update(skillImports)
        .set({
          status: "checked",
          report: checked.report,
          stagingPath: checked.report.ok ? path : null,
          updatedAt: Date.now(),
        })
        .where(eq(skillImports.id, id))
        .returning();
      return updated;
    });
  }
  async applyImport(
    userId: string,
    id: string,
    targetId?: string,
    expectedVersionId?: string,
  ) {
    return this.mutate(async () => {
      const row = await this.importRecord(userId, id),
        report = row.report as CheckedPackage["report"] | null;
      const applyHash = digest([targetId ?? null, expectedVersionId ?? null]);
      if (row.status === "applied") {
        if ((row.report as { appliedHash?: string })?.appliedHash !== applyHash)
          fail(409, "IMPORT_ALREADY_APPLIED");
        return this.detail(userId, row.targetSkillId!);
      }
      if (row.status !== "checked" || !report?.ok || !row.stagingPath)
        fail(409, "IMPORT_NOT_READY");
      let result;
      const files = await this.packages.files(row.stagingPath);
      if (targetId) {
        const skill = await this.owned(userId, targetId, true);
        if (skill.currentVersionId !== expectedVersionId)
          fail(409, "VERSION_CONFLICT");
        await this.appendVersion(
          skill,
          this.checked(files, skill.slug),
          row.clientRequestId,
          applyHash,
          skill.displayName,
          { id, report: { ...report, appliedHash: applyHash } },
        );
        return this.detail(userId, targetId);
      } else
        result = await this.createIn(
          userId,
          row.clientRequestId,
          report.manifest!.name,
          files,
        );
      await this.db
        .update(skillImports)
        .set({
          status: "applied",
          targetSkillId: result.id,
          report: { ...report, appliedHash: applyHash },
          updatedAt: Date.now(),
        })
        .where(eq(skillImports.id, id));
      return result;
    });
  }
  /** 管理员从本地审查过的源包分发内置内容；不执行包内代码，不自动替用户启用。 */
  async installBuiltin(displayName: string, files: SourceFile[]) {
    return this.mutate(async () => {
      const checked = this.checked(files),
        name = this.name(displayName),
        manifest = checked.report.manifest!;
      const [old] = await this.db
        .select()
        .from(skills)
        .where(
          and(eq(skills.source, "builtin"), eq(skills.slug, manifest.name)),
        );
      const id = old?.id ?? randomUUID();
      if (old?.currentVersionId) {
        const [current] = await this.db
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.id, old.currentVersionId));
        if (
          current?.sourceHash === checked.report.digest &&
          old.displayName === name
        )
          return { skillId: id, versionId: current.id };
      }
      const versionId = randomUUID(),
        path = `builtin/skills/${id}/versions/${versionId}`;
      await this.packages.publish(path, checked.files);
      await this.db.transaction(async (tx) => {
        if (!old)
          await tx.insert(skills).values({
            id,
            source: "builtin",
            slug: manifest.name,
            displayName: name,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        const [last] = await tx
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.skillId, id))
          .orderBy(desc(skillVersions.versionNumber))
          .limit(1);
        await tx.insert(skillVersions).values({
          id: versionId,
          skillId: id,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          sourceHash: checked.report.digest!,
          manifest,
          fileCount: checked.files.length,
          sizeBytes: manifest.sizeBytes,
          sourcePath: path,
          publishRequestId: randomUUID(),
          publishRequestHash: checked.report.digest!,
          createdAt: Date.now(),
        });
        await tx
          .update(skills)
          .set({
            displayName: name,
            currentVersionId: versionId,
            updatedAt: Date.now(),
          })
          .where(eq(skills.id, id));
      });
      return { skillId: id, versionId };
    });
  }
  async copyVersion(
    userId: string,
    versionId: string,
    requestId: string,
    displayName: string,
  ) {
    const { version } = await this.version(userId, versionId);
    return this.create(
      userId,
      requestId,
      displayName,
      await this.packages.files(version.sourcePath),
    );
  }
  async remove(userId: string, id: string) {
    return this.mutate(async () => {
      await this.owned(userId, id, true);
      await this.db.transaction(async (tx) => {
        await tx
          .update(skills)
          .set({ status: "deleted", updatedAt: Date.now() })
          .where(eq(skills.id, id));
        await tx
          .update(userSkills)
          .set({
            enabled: 0,
            desiredEnabled: 0,
            pendingRequestId: null,
            revision: sql`${userSkills.revision} + 1`,
          })
          .where(
            and(eq(userSkills.userId, userId), eq(userSkills.skillId, id)),
          );
      });
    });
  }
}
