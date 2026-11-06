/** 构建与等待请求分开：同一技能只准备一次，个人启用不等于会话已经加载。 */
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  cp,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  skillBuilds,
  skillBuildRequests,
  userSkills,
  skills,
  skillVersions,
} from "../db/schema/index.js";
import type { Tx } from "../db/client.js";
import { SkillBuilder } from "../../docker/skill-builder.js";
import { fail, ServiceError } from "../types.js";
import { SkillService, digest, requireId } from "./service.js";
import type {
  CapabilitySkill,
  CapabilitySnapshot,
} from "../../shared/skills.js";

export class SkillBuildManager {
  private tasks = new Map<
    string,
    { userId: string; abort: AbortController; done: Promise<void> }
  >();
  private scheduling = false;
  private scheduleAgain = false;
  private closing = false;
  constructor(
    readonly library: SkillService,
    readonly driver = new SkillBuilder(library.root),
  ) {}
  private get db() {
    return this.library.db;
  }
  async initialize() {
    // 丢失CLI管道后不能接管安装；确认旧容器停止，再把未完成准备标成需显式重试。
    const interrupted = await this.db
      .select()
      .from(skillBuilds)
      .where(
        inArray(skillBuilds.state, [
          "downloading",
          "building",
          "cancelling",
          "reconciling",
        ]),
      );
    for (const build of interrupted) {
      try {
        if (build.containerName) await this.driver.stop(build.containerName);
        await this.db
          .update(skillBuilds)
          .set({
            state: "failed",
            error: "服务重启，准备已停止，请重试",
            updatedAt: Date.now(),
          })
          .where(eq(skillBuilds.id, build.id));
        await this.db
          .update(skillBuildRequests)
          .set({ state: "failed" })
          .where(
            and(
              eq(skillBuildRequests.buildId, build.id),
              eq(skillBuildRequests.state, "waiting"),
            ),
          );
      } catch {
        await this.db
          .update(skillBuilds)
          .set({ state: "reconciling" })
          .where(eq(skillBuilds.id, build.id));
        throw new Error("Skill build cleanup unconfirmed");
      }
    }
    await this.adoptDefaults();
    await this.prepareEnabledDefaults();
    this.wake();
  }

  /** A runner upgrade keeps personal defaults and prepares them against the new immutable image. */
  private async prepareEnabledDefaults() {
    const imageId = await this.driver.imageId();
    const { rows } = await this.db.execute<{ userId: string; versionId: string }>(
      sql`SELECT u."userId", u."activeVersionId" AS "versionId"
        FROM user_skills u JOIN skills s ON s.id=u."skillId"
        JOIN users account ON account.id=u."userId"
        JOIN skill_versions v ON v.id=u."activeVersionId" AND v."skillId"=s.id
        WHERE u.enabled=1 AND u."desiredEnabled"=1 AND s.status='active'
          AND account.disabled=0
          AND NOT EXISTS (SELECT 1 FROM skill_builds b
            WHERE b."userId"=u."userId" AND b."versionId"=v.id AND b."imageId"=${imageId})`,
    );
    for (const { userId, versionId } of rows) {
      try {
        await this.db.transaction(tx =>
          this.registerRequest(tx, userId, versionId, randomUUID(), imageId),
        );
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "BUILD_QUEUE_LIMIT") throw error;
        // Respect the existing per-user queue cap. A user can retry from the skills page.
        console.warn("Default skill preparation deferred by queue limit");
      }
    }
  }
  async request(userId: string, versionId: string, clientRequestId: string) {
    const imageId = await this.driver.imageId();
    const request = await this.db.transaction((tx) =>
      this.registerRequest(tx, userId, versionId, clientRequestId, imageId),
    );
    this.wake();
    return this.detail(userId, request.id);
  }
  /** 只登记，不启动容器；专家批次可在同一事务登记全部技能，提交后统一 wake。 */
  async registerRequest(
    tx: Tx,
    userId: string,
    versionId: string,
    clientRequestId: string,
    imageId: string,
  ) {
    requireId(clientRequestId);
    const [source] = await tx
      .select({ skill: skills, version: skillVersions })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(eq(skillVersions.id, versionId));
    if (
      !source ||
      (source.skill.ownerId !== userId && source.skill.source !== "builtin")
    )
      fail(404, "SKILL_NOT_FOUND");
    const { skill, version } = source;
    if (skill.status !== "active") fail(409, "SKILL_DISABLED");
    const hash = digest([versionId, imageId]);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"skill:" + userId}, 0))`,
    );
    const [old] = await tx
      .select()
      .from(skillBuildRequests)
      .where(
        and(
          eq(skillBuildRequests.userId, userId),
          eq(skillBuildRequests.clientRequestId, clientRequestId),
        ),
      );
    if (old) {
      if (old.requestHash !== hash) fail(409, "REQUEST_ID_CONFLICT");
      return old;
    }
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(skillBuildRequests)
      .where(
        and(
          eq(skillBuildRequests.userId, userId),
          eq(skillBuildRequests.state, "waiting"),
        ),
      );
    if (count.n >= 20) fail(429, "BUILD_QUEUE_LIMIT");
    const key = digest([
      1,
      versionId,
      version.sourceHash,
      imageId,
      skill.source === "builtin" ? "builtin" : "personal",
      skill.slug,
    ]);
    let [build] = await tx
      .select()
      .from(skillBuilds)
      .where(and(eq(skillBuilds.userId, userId), eq(skillBuilds.buildKey, key)))
      .for("update");
    if (build && ["cancelling", "reconciling"].includes(build.state))
      fail(409, "BUILD_STOPPING");
    if (!build)
      [build] = await tx
        .insert(skillBuilds)
        .values({
          id: randomUUID(),
          userId,
          versionId,
          imageId,
          buildKey: key,
          state: "queued",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .returning();
    const [row] = await tx
      .insert(skillBuildRequests)
      .values({
        id: randomUUID(),
        userId,
        buildId: build.id,
        clientRequestId,
        requestHash: hash,
        state:
          build.state === "ready"
            ? "ready"
            : ["failed", "cancelled"].includes(build.state)
              ? "failed"
              : "waiting",
        createdAt: Date.now(),
      })
      .returning();
    return row;
  }
  async detail(userId: string, requestId: string) {
    const [request] = await this.db
      .select()
      .from(skillBuildRequests)
      .where(
        and(
          eq(skillBuildRequests.id, requestId),
          eq(skillBuildRequests.userId, userId),
        ),
      );
    if (!request) fail(404, "BUILD_NOT_FOUND");
    const [build] = await this.db
      .select()
      .from(skillBuilds)
      .where(eq(skillBuilds.id, request.buildId));
    const logPath = this.library.packages.path(
      `users/${this.library.packages.ownerKey(userId)}/skill-builds/${build.id}/attempts/${build.attempt}/build.log`,
    );
    const log = await readFile(logPath, "utf8").catch(() => "");
    return {
      request,
      build: { ...build, artifactPath: undefined, containerName: undefined },
      log: log.slice(-16_000),
    };
  }
  async cancel(userId: string, requestId: string) {
    const { request } = await this.detail(userId, requestId);
    let active: { abort: AbortController } | undefined;
    let stop = false;
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: skillBuilds.id })
        .from(skillBuilds)
        .where(eq(skillBuilds.id, request.buildId))
        .for("update");
      await tx
        .update(skillBuildRequests)
        .set({ state: "cancelled" })
        .where(
          and(
            eq(skillBuildRequests.id, requestId),
            eq(skillBuildRequests.state, "waiting"),
          ),
        );
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(skillBuildRequests)
        .where(
          and(
            eq(skillBuildRequests.buildId, request.buildId),
            eq(skillBuildRequests.state, "waiting"),
          ),
        );
      if (!left.n) {
        await tx
          .update(skillBuilds)
          .set({ state: "cancelled", updatedAt: Date.now() })
          .where(
            and(
              eq(skillBuilds.id, request.buildId),
              eq(skillBuilds.state, "queued"),
            ),
          );
        active = this.tasks.get(request.buildId);
        if (active) {
          const changed = await tx
            .update(skillBuilds)
            .set({ state: "cancelling", updatedAt: Date.now() })
            .where(
              and(
                eq(skillBuilds.id, request.buildId),
                inArray(skillBuilds.state, ["downloading", "building"]),
              ),
            )
            .returning({ id: skillBuilds.id });
          stop = changed.length > 0;
        }
      }
    });
    // 取消意图提交之后才触发外部停止；事务回滚不会误杀仍在等待的准备。
    if (stop) active!.abort.abort();
    return this.detail(userId, requestId);
  }
  async retry(userId: string, requestId: string, expectedAttempt: number) {
    const { request } = await this.detail(userId, requestId);
    await this.db.transaction(async (tx) => {
      const [build] = await tx
        .select()
        .from(skillBuilds)
        .where(eq(skillBuilds.id, request.buildId))
        .for("update");
      if (
        build.attempt !== expectedAttempt ||
        !["failed", "cancelled"].includes(build.state)
      )
        fail(409, "BUILD_ATTEMPT_CONFLICT");
      await tx
        .update(skillBuilds)
        .set({
          state: "queued",
          attempt: build.attempt + 1,
          error: null,
          containerName: null,
          updatedAt: Date.now(),
        })
        .where(eq(skillBuilds.id, build.id));
      await tx
        .update(skillBuildRequests)
        .set({ state: "waiting" })
        .where(eq(skillBuildRequests.id, requestId));
    });
    this.wake();
    return this.detail(userId, requestId);
  }
  /** 专家批次重试自己的等待者：共享构建已成功/仍在运行时直接重新加入。 */
  async rejoin(userId: string, requestId: string, expectedAttempt: number) {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${"skill:" + userId}, 0))`,
      );
      const [request] = await tx
        .select()
        .from(skillBuildRequests)
        .where(
          and(
            eq(skillBuildRequests.id, requestId),
            eq(skillBuildRequests.userId, userId),
          ),
        );
      if (!request) fail(404, "BUILD_REQUEST_NOT_FOUND");
      const [build] = await tx
        .select()
        .from(skillBuilds)
        .where(eq(skillBuilds.id, request.buildId))
        .for("update");
      if (build.attempt !== expectedAttempt)
        fail(409, "BUILD_ATTEMPT_CONFLICT");
      if (["waiting", "ready"].includes(request.state)) return;
      if (["cancelling", "reconciling"].includes(build.state))
        fail(409, "BUILD_STOPPING");
      if (build.state !== "ready") {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(skillBuildRequests)
          .where(
            and(
              eq(skillBuildRequests.userId, userId),
              eq(skillBuildRequests.state, "waiting"),
            ),
          );
        if (count.n >= 20) fail(429, "BUILD_QUEUE_LIMIT");
      }
      if (["failed", "cancelled"].includes(build.state))
        await tx
          .update(skillBuilds)
          .set({
            state: "queued",
            attempt: build.attempt + 1,
            error: null,
            containerName: null,
            updatedAt: Date.now(),
          })
          .where(eq(skillBuilds.id, build.id));
      await tx
        .update(skillBuildRequests)
        .set({ state: build.state === "ready" ? "ready" : "waiting" })
        .where(eq(skillBuildRequests.id, requestId));
    });
    this.wake();
  }
  async setDefault(
    userId: string,
    skillId: string,
    enabled: boolean,
    versionId: string | undefined,
    revision: number,
    requestId: string,
  ) {
    const skill = await this.library.owned(userId, skillId);
    requireId(requestId);
    if (skill.status !== "active") fail(409, "SKILL_DISABLED");
    if (
      enabled &&
      (!versionId ||
        (await this.library.version(userId, versionId)).skill.id !== skillId)
    )
      fail(400, "INVALID_SKILL_VERSION");
    const preparation = enabled
      ? await this.request(userId, versionId!, requestId)
      : undefined;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"skill:" + userId}, 0))`,
        );
        const [old] = await tx
          .select()
          .from(userSkills)
          .where(
            and(eq(userSkills.userId, userId), eq(userSkills.skillId, skillId)),
          );
        if (
          preparation &&
          (old?.pendingRequestId === preparation.request.id ||
            (preparation.request.state === "ready" &&
              old?.enabled === 1 &&
              old.activeVersionId === versionId))
        )
          return;
        if ((old?.revision ?? 0) !== revision)
          fail(409, "SKILL_REVISION_CONFLICT");
        const next = {
          desiredVersionId: versionId ?? null,
          desiredEnabled: enabled ? 1 : 0,
          pendingRequestId: preparation?.request.id ?? null,
          enabled: enabled ? (old?.enabled ?? 0) : 0,
          revision: revision + 1,
          updatedAt: Date.now(),
        };
        await tx
          .insert(userSkills)
          .values({ userId, skillId, ...next, createdAt: Date.now() })
          .onConflictDoUpdate({
            target: [userSkills.userId, userSkills.skillId],
            set: next,
          });
      });
    } catch (error) {
      if (preparation?.request.state === "waiting")
        await this.cancel(userId, preparation.request.id);
      throw error;
    }
    await this.adoptDefaults();
    return this.library.detail(userId, skillId);
  }
  private async adoptDefaults() {
    // 依据持久结果生效，重启也可恢复；只采用仍匹配的个人意图，专家请求不会影响它。
    await this.db
      .execute(sql`UPDATE user_skills u SET "activeVersionId"=u."desiredVersionId", enabled=1,
      "pendingRequestId"=NULL, revision=revision+1, "updatedAt"=${Date.now()}
      FROM skill_build_requests r WHERE r.id=u."pendingRequestId" AND r.state='ready' AND u."desiredEnabled"=1`);
  }
  wake() {
    // 调度查询期间新请求也可能到达，记下一次唤醒，不能因“正在调度”丢掉。
    this.scheduleAgain = true;
    void this.schedule().catch((error) =>
      console.error("Skill scheduling failed", error),
    );
  }
  private async schedule() {
    if (this.scheduling || this.closing) return;
    this.scheduling = true;
    this.scheduleAgain = false;
    try {
      const rows = await this.db
        .select()
        .from(skillBuilds)
        .where(eq(skillBuilds.state, "queued"))
        .orderBy(asc(skillBuilds.createdAt))
        .limit(100);
      for (const build of rows) {
        if (this.tasks.size >= 2) break;
        if (
          [...this.tasks.values()].some((task) => task.userId === build.userId)
        )
          continue;
        const abort = new AbortController(),
          done = Promise.resolve().then(() => this.run(build, abort));
        this.tasks.set(build.id, { userId: build.userId, abort, done });
        void done.catch((error) =>
          console.error("Skill preparation failed", error),
        );
      }
    } finally {
      this.scheduling = false;
      if (this.scheduleAgain && !this.closing) this.wake();
    }
  }
  private async run(
    build: typeof skillBuilds.$inferSelect,
    controller: AbortController,
  ) {
    const base = `users/${this.library.packages.ownerKey(build.userId)}/skill-builds/${build.id}`;
    const attempt = this.library.packages.path(
        `${base}/attempts/${build.attempt}`,
      ),
      output = join(attempt, "artifact"),
      materials = join(attempt, "downloads");
    const name = `ah-skill-${build.id}-${build.attempt}`;
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    let claimed = false;
    let state: typeof build.state = "failed",
      error = "",
      artifactPath: string | undefined,
      hash: string | undefined,
      logBytes = 0;
    try {
      const [row] = await this.db
        .update(skillBuilds)
        .set({
          state: "downloading",
          containerName: name,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(skillBuilds.id, build.id),
            eq(skillBuilds.state, "queued"),
            eq(skillBuilds.attempt, build.attempt),
          ),
        )
        .returning();
      if (!row) return;
      claimed = true;
      const { skill, version, manifest } = await this.library.version(
        build.userId,
        build.versionId,
      );
      // 同一用户只运行一个准备任务，预留本次最大2GiB产物及下载空间。
      if (
        (await this.library.packages.diskBytes(
          `users/${this.library.packages.ownerKey(build.userId)}/skill-builds`,
        )) >
        1536 * 1024 ** 2
      )
        throw new Error(
          "Skill build storage limit reached; administrator cleanup required",
        );
      await mkdir(attempt, { recursive: true });
      const source = await this.library.packages.files(version.sourcePath);
      if (
        this.library.packages.check(source).report.digest !== version.sourceHash
      )
        throw new Error("Published skill source hash mismatch");
      await this.driver.materials(
        source,
        manifest,
        materials,
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error("Preparation cancelled");
      await this.db
        .update(skillBuilds)
        .set({ state: "building", updatedAt: Date.now() })
        .where(eq(skillBuilds.id, build.id));
      hash = await this.driver.build(
        {
          name,
          imageId: build.imageId,
          source: this.library.packages.path(version.sourcePath),
          output,
          materials,
          manifest,
          namespace: skill.source === "builtin" ? "builtin" : "personal",
        },
        controller.signal,
        async (text) => {
          if (logBytes < 128 * 1024) {
            logBytes += Buffer.byteLength(text);
            await appendFile(join(attempt, "build.log"), text, { mode: 0o600 });
          }
        },
      );
      if (controller.signal.aborted) throw new Error("Preparation cancelled");
      artifactPath = `${base}/artifact-${build.attempt}`;
      await rename(output, this.library.packages.path(artifactPath));
      state = "ready";
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message.slice(0, 500)
          : "Preparation failed";
      state = controller.signal.aborted ? "cancelled" : "failed";
    } finally {
      clearTimeout(timer);
      if (!claimed) {
        this.tasks.delete(build.id);
        this.wake();
        return;
      }
      try {
        await this.driver.stop(name);
      } catch {
        state = "reconciling";
        error = "容器停止尚未确认，请先协调环境";
      }
      if (controller.signal.aborted && state === "ready") {
        state = "cancelled";
        error = "Preparation cancelled";
      }
      await this.db.transaction(async (tx) => {
        await tx
          .update(skillBuilds)
          .set({
            state,
            artifactPath: state === "ready" ? artifactPath : null,
            artifactHash: state === "ready" ? hash : null,
            error: error || null,
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(skillBuilds.id, build.id),
              eq(skillBuilds.attempt, build.attempt),
            ),
          );
        if (state !== "reconciling")
          await tx
            .update(skillBuildRequests)
            .set({
              state:
                state === "ready"
                  ? "ready"
                  : state === "cancelled"
                    ? "cancelled"
                    : "failed",
            })
            .where(
              and(
                eq(skillBuildRequests.buildId, build.id),
                eq(skillBuildRequests.state, "waiting"),
              ),
            );
      });
      await this.adoptDefaults();
      if (state !== "reconciling") this.tasks.delete(build.id);
      this.wake();
    }
  }
  async selection(userId: string, ids?: string[]) {
    const defaults = await this.db
      .select()
      .from(userSkills)
      .where(and(eq(userSkills.userId, userId), eq(userSkills.enabled, 1)));
    const selected =
      ids ??
      defaults.flatMap((setting) =>
        setting.activeVersionId ? [setting.activeVersionId] : [],
      );
    if (selected.length > 20 || new Set(selected).size !== selected.length)
      fail(400, "INVALID_SKILL_SELECTION");
    const imageId = await this.driver.imageId(),
      entries: CapabilitySkill[] = [];
    for (const id of [...selected].sort()) {
      const { skill, version, manifest } = await this.library.version(
        userId,
        id,
      );
      if (skill.status !== "active") fail(409, "SKILL_DISABLED");
      const [build] = await this.db
        .select()
        .from(skillBuilds)
        .where(
          and(
            eq(skillBuilds.userId, userId),
            eq(skillBuilds.versionId, id),
            eq(skillBuilds.imageId, imageId),
            eq(skillBuilds.state, "ready"),
          ),
        );
      if (!build?.artifactHash || !build.artifactPath)
        fail(409, "CAPABILITY_NOT_READY");
      const namespace = skill.source === "builtin" ? "builtin" : "personal";
      if (
        entries.some(
          (entry) => entry.invocationName === `${namespace}:${skill.slug}`,
        )
      )
        fail(400, "DUPLICATE_SKILL_SELECTION");
      entries.push({
        skillId: skill.id,
        versionId: id,
        version: version.versionNumber,
        buildId: build.id,
        name: skill.slug,
        namespace,
        invocationName: `${namespace}:${skill.slug}`,
        sourceHash: version.sourceHash,
        buildHash: build.artifactHash,
        userInvocable: manifest.userInvocable,
      });
    }
    return {
      schemaVersion: 1 as const,
      imageId,
      skills: entries,
      digest: digest([1, imageId, entries]),
    };
  }
  async bundle(
    userId: string,
    sessionId: string,
    snapshot: CapabilitySnapshot,
    workbuddy = false,
  ) {
    const base = join(
      this.library.root,
      sessionId,
      "capabilities",
      snapshot.digest,
    );
    for (const entry of snapshot.skills) {
      const [build] = await this.db
        .select()
        .from(skillBuilds)
        .where(
          and(
            eq(skillBuilds.id, entry.buildId),
            eq(skillBuilds.userId, userId),
            eq(skillBuilds.state, "ready"),
          ),
        );
      if (
        !build?.artifactPath ||
        build.artifactHash !== entry.buildHash ||
        (await this.driver.artifactHash(
          this.library.packages.path(build.artifactPath),
        )) !== entry.buildHash
      )
        fail(409, "CAPABILITY_ARTIFACT_MISSING");
      const plugin = join(base, entry.namespace);
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(plugin, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: entry.namespace, version: "1.0.0" }),
      );
      await cp(
        this.library.packages.path(build.artifactPath),
        join(plugin, "skills", entry.name),
        { recursive: true, dereference: false, verbatimSymlinks: true },
      );
    }
    if(workbuddy) {
      // 专家包短名在只读生成配置中注册；不读取用户workspace里的项目配置。
      const target=join(base,"workbuddy-config",".claude","skills");
      await mkdir(target,{recursive:true});
      for(const entry of snapshot.skills) await cp(join(base,entry.namespace,"skills",entry.name),join(target,entry.name),{recursive:true,dereference:false,verbatimSymlinks:true});
    }
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "manifest.json"), JSON.stringify(snapshot));
  }
  async close() {
    this.closing = true;
    for (const task of this.tasks.values()) task.abort.abort();
    await Promise.allSettled([...this.tasks.values()].map((task) => task.done));
    if (this.tasks.size) throw new Error("Skill cleanup unconfirmed");
    await this.driver.close();
  }
}
