/** 直接删除的可重入清理器：检查点不是回收站，不提供恢复，确认外部资源清除后才删除内容记录。 */
import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { SessionManager } from "../session-manager.js";
import type { ApplicationService } from "../applications/service.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import type { LlmService } from "../llm/service.js";
import { stopAndRemove } from "../../runtime/providers/contracts.js";
import type { ResidentProvider } from "../../runtime/providers/resident.js";
import { ConfiguredResidentProvider } from "../../runtime/providers/configured-resident.js";
import { DockerBackend } from "../../docker/docker.js";
import { Store, lockSession } from "../../runtime/storage.js";
import { fail } from "../types.js";
export interface DeletionJob {
  id: string;
  ownerId: string;
  kind: "session" | "application";
  resourceId: string;
  sessionId: string | null;
  state: "running" | "failed" | "completed";
  phase: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export class ResourceDeletions {
  readonly resident: ResidentProvider;
  private tasks = new Map<string, Promise<void>>();
  private readers = new Map<string, AbortController>();
  private closing = false;
  constructor(
    readonly manager: SessionManager,
    readonly root: string,
    readonly files: WorkspaceFiles,
    readonly applications?: ApplicationService,
    readonly llm?: LlmService,
    resident?: ResidentProvider,
  ) {
    this.resident = resident ?? new ConfiguredResidentProvider(new DockerBackend(root));
    manager.deletions = this;
  }
  private async rows<T = DeletionJob>(query: SQL) {
    return (await this.manager.store.db.execute(query)).rows as T[];
  }
  async list(owner: string) {
    return this.rows(
      sql`SELECT * FROM resource_deletions WHERE "ownerId"=${owner} ORDER BY "createdAt" DESC LIMIT 100`,
    );
  }
  async pending(owner: string) {
    return this.rows(
      sql`SELECT * FROM resource_deletions WHERE "ownerId"=${owner} AND state<>'completed'`,
    );
  }
  async job(owner: string, id: string) {
    const [job] = await this.rows(
      sql`SELECT * FROM resource_deletions WHERE id=${id} AND "ownerId"=${owner}`,
    );
    if (!job) fail(404, "DELETION_NOT_FOUND");
    return job;
  }
  async guardSession(id: string) {
    const [job] = await this.rows(
      sql`SELECT id FROM resource_deletions WHERE state<>'completed' AND ((kind='session' AND "resourceId"=${id}) OR "sessionId"=${id}) LIMIT 1`,
    );
    if (job) fail(409, "RESOURCE_DELETING");
  }
  signal(id: string) {
    const signal = this.readers.get(id) ?? new AbortController();
    this.readers.set(id, signal);
    return signal.signal;
  }
  private abortReaders(id: string) {
    this.signal(id);
    this.readers.get(id)!.abort();
  }
  async request(
    owner: string,
    kind: DeletionJob["kind"],
    id: string,
    confirmName?: string,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, "INVALID_RESOURCE_ID");
    if (this.closing || this.manager.stopping) fail(503, "SERVICE_STOPPING");
    const [old] = await this.rows(
      sql`SELECT * FROM resource_deletions WHERE kind=${kind} AND "resourceId"=${id}`,
    );
    if (old && old.ownerId !== owner) fail(404, "RESOURCE_NOT_FOUND");
    if (old?.state === "completed" || (old && this.tasks.has(old.id)))
      return old;
    const app =
      kind === "application"
        ? await this.applications?.store.byId(id)
        : undefined;
    if (app && app.ownerId !== owner) fail(404, "APPLICATION_NOT_FOUND");
    const sessionId =
      kind === "session"
        ? id
        : (app?.developmentSessionId ?? old?.sessionId ?? null);
    const job = await this.manager.admitDeletion(
      owner,
      sessionId,
      () =>
        this.manager.store.db.transaction(async (tx) => {
          if (kind === "session") {
            const linked = await tx.execute(
              sql`SELECT id FROM applications WHERE "developmentSessionId"=${id} UNION ALL SELECT id FROM sessions WHERE id=${id} AND "analysisAppId" IS NOT NULL`,
            );
            if (linked.rowCount) fail(409, "DELETE_APPLICATION_INSTEAD");
          } else {
            const result = await tx.execute(
              sql`SELECT title,"ownerId" FROM applications WHERE id=${id} FOR UPDATE`,
            );
            const row = result.rows[0] as
              { title: string; ownerId: string } | undefined;
            if (!row || row.ownerId !== owner)
              fail(404, "APPLICATION_NOT_FOUND");
            if (confirmName !== row.title) fail(409, "DELETE_NAME_CHANGED");
            await tx.execute(
              sql`UPDATE applications SET status='deleting',"updatedAt"=${Date.now()} WHERE id=${id}`,
            );
          }
          const result =
            await tx.execute(sql`INSERT INTO resource_deletions(id,"ownerId",kind,"resourceId","sessionId",state,phase,"createdAt","updatedAt")
        VALUES(${randomUUID()},${owner},${kind},${id},${sessionId},'running','stopping',${Date.now()},${Date.now()})
        ON CONFLICT(kind,"resourceId") DO UPDATE SET state='running',error=NULL,"updatedAt"=EXCLUDED."updatedAt" RETURNING *`);
          return result.rows[0] as unknown as DeletionJob;
        }),
      async () => {
        const [current] = await this.rows(
          sql`SELECT * FROM resource_deletions WHERE kind=${kind} AND "resourceId"=${id} AND "ownerId"=${owner}`,
        );
        return current &&
          (current.state === "completed" || this.tasks.has(current.id))
          ? current
          : undefined;
      },
    );
    if (sessionId) this.abortReaders(sessionId);
    if (job.state !== "completed") this.launch(job);
    return job;
  }
  async resume() {
    for (const job of await this.rows(
      sql`SELECT * FROM resource_deletions WHERE state='running'`,
    )) {
      if (this.closing) return;
      if (job.sessionId) this.abortReaders(job.sessionId);
      this.launch(job);
    }
  }
  private launch(job: DeletionJob) {
    if (this.tasks.has(job.id) || this.closing) return;
    const work = this.clean(job)
      .catch(async (error) => {
        const interrupted = error?.code === "SERVICE_STOPPING";
        console.error(
          "Deletion cleanup unconfirmed",
          job.id,
          error?.code ?? error?.cause?.code ?? error?.name,
          error instanceof Error
            ? error.stack
                ?.split("\n")
                .filter((line) => /^\s+at /.test(line))
                .slice(0, 3)
                .join("\n")
            : "",
        );
        await this.manager.store.db.execute(
          sql`UPDATE resource_deletions SET state=${interrupted ? "running" : "failed"},error=${interrupted ? null : "RESOURCE_CLEANUP_UNCONFIRMED"},"updatedAt"=${Date.now()} WHERE id=${job.id}`,
        );
      })
      .finally(() => this.tasks.delete(job.id));
    this.tasks.set(job.id, work);
    void work.catch(() =>
      console.error("Deletion checkpoint unavailable", job.id),
    );
  }
  private async phase(job: DeletionJob, phase: string) {
    await this.manager.store.db.execute(
      sql`UPDATE resource_deletions SET phase=${phase},"updatedAt"=${Date.now()} WHERE id=${job.id}`,
    );
  }
  /** 父目录由平台拥有；拒绝链接形式的资源根，rm不跟随内部符号链接。 */
  private async remove(base: string, ...parts: string[]) {
    let path = base;
    for (const part of parts) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")
        throw Error("RESOURCE_PATH_UNSAFE");
      path = join(path, part);
      try {
        if ((await lstat(path)).isSymbolicLink())
          throw Error("RESOURCE_PATH_UNSAFE");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
    }
    await rm(path, { recursive: true, force: true });
  }
  private async sessionFiles(job: DeletionJob, id: string) {
    const stops = await Promise.allSettled([
      this.manager.stopForDeletion(job.ownerId, id),
      this.files.stopSession(id),
    ]);
    const revocations = await Promise.allSettled([this.llm?.revokeSession(id)]);
    const failures = [...stops, ...revocations];
    for (const ref of await this.resident.findOwned(id)) {
      const [result] = await Promise.allSettled([stopAndRemove(this.resident, ref)]);
      failures.push(result);
    }
    if ((await this.resident.findOwned(id)).length)
      throw Error("SESSION_STOP_UNCONFIRMED");
    const failure = failures.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const path = new Store(this.root).directory(id);
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw Error("RESOURCE_PATH_UNSAFE");
      const release = await lockSession(path);
      try {
        await this.remove(this.root, id);
      } finally {
        await release();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private async appFiles(job: DeletionJob) {
    const apps = this.applications!;
    const [control] = await Promise.allSettled([
      apps.stopForDeletion(job.resourceId),
    ]);
    const app = await apps.store.byId(job.resourceId);
    if (!app || app.ownerId !== job.ownerId || app.status !== "deleting")
      throw Error("APPLICATION_DELETE_CHANGED");
    const analysis = await this.manager.store.analysisSessions(app.id);
    if (analysis.length && !apps.observation) fail(503, "APPLICATION_OBSERVATION_UNAVAILABLE");
    for (const session of analysis) {
      this.abortReaders(session.id);
      await this.sessionFiles(job, session.id);
    }
    const builds = await apps.store.builds(app.id),
      deployments = await apps.store.deployments(app.id);
    const destroy = async (
      name: string,
      buildId?: string,
      deploymentId?: string,
    ) => {
      const state = await apps.driver.inspect(name);
      if (!state) return;
      const labels = state.Config.Labels;
      if (
        buildId
          ? labels["harbor.app.build"] !== buildId ||
            (labels["harbor.app.id"] && labels["harbor.app.id"] !== app.id)
          : labels["harbor.app.id"] !== app.id ||
            (deploymentId && labels["harbor.app.deployment"] !== deploymentId)
      )
        throw Error("APPLICATION_RESOURCE_OWNERSHIP_MISMATCH");
      await apps.driver.destroy(name);
    };
    const stopped = [
      control,
      ...(await Promise.allSettled([
        ...builds.map((build) => destroy("ah-app-build-" + build.id, build.id)),
        ...deployments.map(deployment => apps.destroyDeployment(deployment)),
      ])),
    ];
    const survivors = await apps.driver.command([
      "ps",
      "-a",
      "--filter",
      `label=harbor.app.store=${apps.driver.owner}`,
      "--filter",
      `label=harbor.app.id=${app.id}`,
      "--format",
      "{{.Names}}",
    ]);
    stopped.push(
      ...(await Promise.allSettled(
        survivors
          .split("\n")
          .filter(Boolean)
          .map((name) => destroy(name)),
      )),
    );
    const failure = stopped.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (app.developmentSessionId) {
      job.sessionId = app.developmentSessionId;
      await this.manager.admitDeletion(job.ownerId, job.sessionId, async () => {
        await this.manager.store.db.execute(
          sql`UPDATE resource_deletions SET "sessionId"=${job.sessionId} WHERE id=${job.id}`,
        );
      });
      this.abortReaders(job.sessionId);
      await this.sessionFiles(job, job.sessionId);
    }
    await this.phase(job, "deleting_data");
    const authScopes = await this.rows(sql`SELECT id FROM app_auth_scopes WHERE app_id=${app.id}`);
    if (authScopes.length && !apps.visitorAuth) fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    await apps.visitorAuth?.remove(app.id);
    for (const env of ["preview", "production"] as const)
      await apps.data.destroyOwned(app.id, env);
    if (apps.observation) {
      const pool = apps.observation.store.pool,
        c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const table of [
          "observation_events",
          "observation_state",
          "observation_dedup",
          "observation_deletions",
          "observation_bindings",
        ])
          await c.query(`DELETE FROM ${table} WHERE app_id=$1`, [app.id]);
        if ((await c.query("SELECT to_regclass('observation_report_snapshots') AS name")).rows[0]?.name)
          await c.query("DELETE FROM observation_report_snapshots WHERE app_id=$1", [app.id]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    await this.phase(job, "deleting_files");
    for (const build of builds) {
      const tag = "agent-harbor-app:" + build.id;
      const image = await apps.driver.command([
        "image",
        "ls",
        "-q",
        "--no-trunc",
        tag,
      ]);
      if (image) {
        if (build.artifact) {
          if (image !== build.artifact.imageId)
            throw Error("APPLICATION_IMAGE_CHANGED");
        } else {
          const info = JSON.parse(
            await apps.driver.command(["image", "inspect", tag]),
          )[0];
          const labels = info.Config?.Labels;
          if (
            labels?.["harbor.app.store"] !== apps.driver.owner ||
            labels?.["harbor.app.id"] !== app.id ||
            labels?.["harbor.app.build"] !== build.id
          )
            throw Error("APPLICATION_IMAGE_CHANGED");
        }
        // Remove only this build's named reference. Docker refuses removal while a sole image is still in use.
        await apps.driver.command(["image", "rm", tag]);
      }
      await this.remove(apps.options.root, "builds", build.id);
    }
    for (const d of deployments)
      await this.remove(apps.options.root, "deployments", d.id);
    const allOperations = await this.rows<{ id: string }>(
      sql`SELECT id FROM app_operations WHERE "appId"=${app.id}`,
    );
    for (const op of allOperations)
      await this.remove(apps.options.root, "operations", op.id + ".log");
    for (const dir of ["sources", "data", "exports"])
      await this.remove(apps.options.root, dir, app.id);
  }
  private async clean(job: DeletionJob) {
    await this.phase(job, "stopping");
    if (job.kind === "application") {
      if (!this.applications) throw Error("APPLICATIONS_UNAVAILABLE");
      await this.appFiles(job);
    } else await this.sessionFiles(job, job.resourceId);
    await this.phase(job, "deleting_records");
    await this.manager.store.db.transaction(async (tx) => {
      if (job.kind === "application") {
        // 当前版本与版本历史互相引用，先断开头指针，再按依赖顺序清除历史。
        await tx.execute(
          sql`UPDATE applications SET "headRevisionId"=NULL WHERE id=${job.resourceId}`,
        );
        for (const table of [
          "app_events",
          "app_operations",
          "app_endpoints",
          "app_deployments",
          "app_builds",
          "app_revisions",
          "app_data_environments",
        ])
          await tx.execute(
            sql`DELETE FROM ${sql.raw(table)} WHERE "appId"=${job.resourceId}`,
          );
        await tx.execute(
          sql`DELETE FROM applications WHERE id=${job.resourceId} AND "ownerId"=${job.ownerId}`,
        );
      }
      const ids = job.kind === "session" ? [job.resourceId] : [
        job.sessionId,
        ...(await tx.execute(sql`SELECT id FROM sessions WHERE "analysisAppId"=${job.resourceId}`)).rows.map(row => String(row.id)),
      ];
      for (const sid of ids) {
        if (!sid) continue;
        for (const table of [
          "events",
          "messages",
          "mcp_calls",
          "mcp_bindings",
          "mcp_selections",
          "llm_bindings",
          "usage_baselines",
        ])
          await tx.execute(
            sql`DELETE FROM ${sql.raw(table)} WHERE "sessionId"=${sid}`,
          );
        await tx.execute(
          sql`DELETE FROM sessions WHERE id=${sid} AND "ownerId"=${job.ownerId}`,
        );
      }
      await tx.execute(
        sql`UPDATE resource_deletions SET state='completed',phase='completed',error=NULL,"updatedAt"=${Date.now()} WHERE id=${job.id}`,
      );
    });
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.tasks.values()]);
  }
}
