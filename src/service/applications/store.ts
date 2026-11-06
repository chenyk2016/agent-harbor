/** 应用台账：接收/占位在短事务内完成，Docker/模型/网关调用一律不持有事务锁。 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { uniqueViolation } from "../db/client.js";
import {
  applications,
  appRevisions,
  appOperations,
  appEvents,
  appBuilds,
  appDeployments,
  appEndpoints,
  appDataEnvironments,
} from "../db/schema/applications.js";
import { fail } from "../types.js";
import type { AppManifest } from "./manifest.js";
import type { VisitorProvider } from "./visitor-auth/policy.js";
import type { SourceRevision } from "./source-store.js";
import type { AppBuild, AppDeployment } from "./docker.js";
import type { AppEnvironment, DataEnvironment } from "./data.js";

/** 从应用主表推导的记录类型，保存归属、开发会话和当前源码头版本。 */
export type Application = typeof applications.$inferSelect;
/** 从版本表推导的记录类型，关联固定源码、数据声明和触发该版本的消息。 */
export type ApplicationRevision = typeof appRevisions.$inferSelect;
/** 从操作表推导的异步任务记录；请求编号负责去重，resourceKey 负责同类资源的独占。 */
export type ApplicationOperation = typeof appOperations.$inferSelect;
/** 一个应用某个环境的访问入口记录；分别保存期望部署、已确认部署及切换代次。 */
export type ApplicationEndpoint = typeof appEndpoints.$inferSelect;
const active = ["queued", "running", "cancelling", "reconciling"];
/** 为请求内容生成稳定于当前序列化形式的摘要，防止同一个请求编号被重用于不同内容。 */
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 持久化应用归属、版本、异步操作和部署事实；短事务只登记状态，不执行模型、容器或网关调用。 */
export class ApplicationStore {
  /** 注入控制面数据库连接；本类不持有应用业务数据库的管理连接。 */
  constructor(readonly db: Database) {}
  /** 按用户归属读取可操作应用；无权访问统一返回不存在，删除中的应用拒绝继续操作。 */
  async owned(ownerId: string, id: string): Promise<Application> {
    const [app] = await this.db
      .select()
      .from(applications)
      .where(and(eq(applications.id, id), eq(applications.ownerId, ownerId)));
    if (!app) fail(404, "APPLICATION_NOT_FOUND");
    if (app.status === "deleting") fail(409, "RESOURCE_DELETING");
    return app;
  }
  /** 按最近更新时间列出当前用户最多 100 个应用，供应用画廊展示。 */
  async list(ownerId: string) {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.ownerId, ownerId))
      .orderBy(desc(applications.updatedAt))
      .limit(100);
  }
  /** 通过开发会话反查所属应用，供会话写入门识别需要应用协调的请求。 */
  async forSession(id: string) {
    return (
      await this.db
        .select()
        .from(applications)
        .where(eq(applications.developmentSessionId, id))
    )[0];
  }
  /** 按编号读取内部应用记录，不执行用户鉴权；对外入口应先调用 owned。 */
  async byId(id: string) {
    return (
      await this.db.select().from(applications).where(eq(applications.id, id))
    )[0];
  }
  /** 在当前事务内递增应用事件编号并追加操作事件，使台账状态与事件顺序一起提交。 */
  private async event(
    tx: Tx,
    appId: string,
    type: string,
    payload: Record<string, unknown>,
    operationId?: string,
  ) {
    const [app] = await tx
      .update(applications)
      .set({
        lastEventId: sql`${applications.lastEventId}+1`,
        updatedAt: Date.now(),
      })
      .where(eq(applications.id, appId))
      .returning();
    if (!app) fail(404, "APPLICATION_NOT_FOUND");
    await tx.insert(appEvents).values({
      appId,
      eventId: app.lastEventId,
      operationId,
      type,
      payload,
      createdAt: Date.now(),
    });
  }
  /** 按用户和请求编号加锁去重，在同一事务中建立应用、两个环境入口及创建操作；重复编号内容不同则拒绝。 */
  async create(
    ownerId: string,
    title: string,
    prompt: string,
    clientRequestId: string,
    modelDeploymentId?: string,
  ) {
    const hash = fingerprint({ title, prompt, ...(modelDeploymentId?{modelDeploymentId}:{}) });
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${"application-create:" + ownerId + ":" + clientRequestId},0))`,
      );
      const [existing] = await tx
        .select()
        .from(appOperations)
        .where(
          and(
            eq(appOperations.ownerId, ownerId),
            eq(appOperations.kind, "create"),
            eq(appOperations.clientRequestId, clientRequestId),
          ),
        );
      if (existing) {
        if (existing.requestHash !== hash)
          fail(409, "APPLICATION_REQUEST_CONFLICT");
        const [app] = await tx
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.id, existing.appId),
              eq(applications.ownerId, ownerId),
            ),
          );
        if (!app) fail(404, "APPLICATION_NOT_FOUND");
        return { app, operation: existing, duplicate: true };
      }
      const id = randomUUID(),
        now = Date.now(),
        operationId = randomUUID();
      const [app] = await tx
        .insert(applications)
        .values({ id, ownerId, title, createdAt: now, updatedAt: now })
        .returning();
      for (const environment of ["preview", "production"])
        await tx.insert(appEndpoints).values({ appId: id, environment });
      const [operation] = await tx
        .insert(appOperations)
        .values({
          id: operationId,
          appId: id,
          ownerId,
          kind: "create",
          clientRequestId,
          requestHash: hash,
          resourceKey: "source",
          state: "queued",
          phase: "accepted",
          payload: { prompt, ...(modelDeploymentId?{modelDeploymentId}:{}) },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.event(tx, id, "app.created", { title }, operationId);
      return { app, operation, duplicate: false };
    });
  }
  /** 模板及开发会话准备完成后绑定会话，并把应用主记录切为 active。 */
  async activate(id: string, sessionId: string) {
    await this.db
      .update(applications)
      .set({
        developmentSessionId: sessionId,
        status: "active",
        stateVersion: sql`${applications.stateVersion}+1`,
        updatedAt: Date.now(),
      })
      .where(eq(applications.id, id));
  }
  /** 核对用户应用归属后读取指定操作，避免跨应用取得或控制异步任务。 */
  async operation(ownerId: string, appId: string, id: string) {
    await this.owned(ownerId, appId);
    const [operation] = await this.db
      .select()
      .from(appOperations)
      .where(
        and(
          eq(appOperations.id, id),
          eq(appOperations.appId, appId),
          eq(appOperations.ownerId, ownerId),
        ),
      );
    if (!operation) fail(404, "APPLICATION_OPERATION_NOT_FOUND");
    return operation;
  }
  /** 登记一个有幂等编号的操作并占用对应资源；校验源码头及已有操作，唯一约束兜住并发写入窗口。 */
  async begin(
    ownerId: string,
    appId: string,
    kind: string,
    requestId: string,
    resourceKey: string,
    payload: Record<string, unknown>,
  ) {
    const hash = fingerprint({ appId, payload });
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM applications WHERE id=${appId} AND "ownerId"=${ownerId} FOR UPDATE`,
        );
        const [app] = await tx
          .select()
          .from(applications)
          .where(
            and(eq(applications.id, appId), eq(applications.ownerId, ownerId)),
          );
        if (!app) fail(404, "APPLICATION_NOT_FOUND");
        const [old] = await tx
          .select()
          .from(appOperations)
          .where(
            and(
              eq(appOperations.ownerId, ownerId),
              eq(appOperations.kind, kind),
              eq(appOperations.clientRequestId, requestId),
            ),
          );
        if (old) {
          if (old.requestHash !== hash)
            fail(409, "APPLICATION_REQUEST_CONFLICT");
          return { operation: old, duplicate: true };
        }
        if (app.status !== "active" && kind !== "archive")
          fail(409, "APPLICATION_NOT_ACTIVE");
        if (
          payload.expectedHeadRevisionId !== undefined &&
          payload.expectedHeadRevisionId !== app.headRevisionId
        )
          fail(409, "APPLICATION_SOURCE_CHANGED");
        const now = Date.now();
        const [operation] = await tx
          .insert(appOperations)
          .values({
            id: randomUUID(),
            appId,
            ownerId,
            kind,
            clientRequestId: requestId,
            requestHash: hash,
            resourceKey,
            state: "queued",
            phase: "accepted",
            payload,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await this.event(
          tx,
          appId,
          "operation.accepted",
          { operationId: operation.id, kind },
          operation.id,
        );
        return { operation, duplicate: false };
      });
    } catch (error) {
      if (uniqueViolation(error) === "app_operations_one_writer")
        fail(409, "APPLICATION_BUSY");
      throw error;
    }
  }
  /** 保存操作状态、阶段及可选结果或错误，并追加事件供客户端展示进度。 */
  async progress(
    id: string,
    state: string,
    phase: string,
    result?: Record<string, unknown>,
    error?: string,
  ) {
    await this.db.transaction(async (tx) => {
      const [operation] = await tx
        .update(appOperations)
        .set({ state, phase, result, error, updatedAt: Date.now() })
        .where(eq(appOperations.id, id))
        .returning();
      if (operation)
        await this.event(
          tx,
          operation.appId,
          "operation.changed",
          { operationId: id, state, phase, error },
          id,
        );
    });
  }
  /** 查询仍占用资源的操作，可按应用和资源筛选；待核对操作仍保留占位。 */
  async active(appId?: string, resourceKey?: string) {
    return this.db
      .select()
      .from(appOperations)
      .where(
        and(
          inArray(appOperations.state, active),
          appId ? eq(appOperations.appId, appId) : undefined,
          resourceKey ? eq(appOperations.resourceKey, resourceKey) : undefined,
        ),
      )
      .orderBy(asc(appOperations.createdAt));
  }
  /** 按用户、操作种类和客户端请求编号查找已接收请求，用于重试去重。 */
  async request(ownerId: string, kind: string, clientRequestId: string) {
    return (
      await this.db
        .select()
        .from(appOperations)
        .where(
          and(
            eq(appOperations.ownerId, ownerId),
            eq(appOperations.kind, kind),
            eq(appOperations.clientRequestId, clientRequestId),
          ),
        )
    )[0];
  }
  /** 读取指定应用最近的操作记录，供工作台展示执行阶段和失败原因。 */
  async operations(appId: string) {
    return this.db
      .select()
      .from(appOperations)
      .where(eq(appOperations.appId, appId))
      .orderBy(desc(appOperations.createdAt))
      .limit(100);
  }
  /** 按版本号倒序读取应用的源码版本历史。 */
  async revisions(appId: string) {
    return this.db
      .select()
      .from(appRevisions)
      .where(eq(appRevisions.appId, appId))
      .orderBy(desc(appRevisions.number))
      .limit(100);
  }
  /** 读取指定应用拥有的版本，不允许用其他应用的版本编号构建或恢复。 */
  async revision(appId: string, id: string) {
    const [revision] = await this.db
      .select()
      .from(appRevisions)
      .where(and(eq(appRevisions.appId, appId), eq(appRevisions.id, id)));
    if (!revision) fail(404, "APPLICATION_REVISION_NOT_FOUND");
    return revision;
  }
  /** 锁定应用并检查预期头版本，登记新源码版本并推进头指针；相同内容复用原版本，恢复操作保留新记录。 */
  async addRevision(
    appId: string,
    source: SourceRevision,
    manifest: AppManifest,
    summary: string,
    expectedHead: string | null,
    sourceMessageId?: string,
    restoredFromId?: string,
  ) {
    if (source.appId !== appId) fail(409, "SOURCE_OWNERSHIP_MISMATCH");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM applications WHERE id=${appId} FOR UPDATE`,
      );
      const [app] = await tx
        .select()
        .from(applications)
        .where(eq(applications.id, appId));
      if (!app || app.headRevisionId !== expectedHead)
        fail(409, "APPLICATION_SOURCE_CHANGED");
      if (app.headRevisionId && !restoredFromId) {
        const [head] = await tx
          .select()
          .from(appRevisions)
          .where(eq(appRevisions.id, app.headRevisionId));
        if (head.source.sourceHash === source.sourceHash) return head;
      }
      const [revision] = await tx
        .insert(appRevisions)
        .values({
          id: randomUUID(),
          appId,
          number: app.nextRevisionNumber,
          parentId: app.headRevisionId,
          restoredFromId,
          sourceMessageId,
          source,
          manifest,
          summary,
          createdAt: Date.now(),
        })
        .returning();
      await tx
        .update(applications)
        .set({
          headRevisionId: revision.id,
          nextRevisionNumber: app.nextRevisionNumber + 1,
          stateVersion: app.stateVersion + 1,
        })
        .where(eq(applications.id, appId));
      await this.event(tx, appId, "revision.created", {
        revisionId: revision.id,
        number: revision.number,
      });
      return revision;
    });
  }
  /** 为指定源码版本和目标环境登记构建占位；实际 Docker 构建由服务层在事务外执行。 */
  async registerBuild(
    appId: string,
    revisionId: string,
    target: AppEnvironment,
    id: string,
  ) {
    await this.revision(appId, revisionId);
    const now = Date.now();
    await this.db.insert(appBuilds).values({
      id,
      appId,
      revisionId,
      target,
      status: "building",
      createdAt: now,
      updatedAt: now,
    });
  }
  /** 将构建产物或失败状态写回台账；清理不明时保留待核对信息。 */
  async finishBuild(
    id: string,
    artifact?: AppBuild,
    error?: string,
    status?: string,
  ) {
    await this.db
      .update(appBuilds)
      .set({
        status: status ?? (artifact ? "succeeded" : "failed"),
        artifact,
        error,
        updatedAt: Date.now(),
      })
      .where(eq(appBuilds.id, id));
  }
  /** 列出应用历史构建记录，用于检查产物和后续恢复。 */
  async builds(appId?: string) {
    return this.db
      .select()
      .from(appBuilds)
      .where(appId ? eq(appBuilds.appId, appId) : undefined)
      .orderBy(desc(appBuilds.createdAt))
      .limit(100);
  }
  /** 限定应用归属读取单个构建记录，供发布或镜像回滚引用。 */
  async build(appId: string, id: string) {
    return (
      await this.db
        .select()
        .from(appBuilds)
        .where(and(eq(appBuilds.appId, appId), eq(appBuilds.id, id)))
    )[0];
  }
  /** 列出尚未明确结束的构建，服务启动时据此阻止未经核对的新构建。 */
  async unfinishedBuilds() {
    return this.db
      .select()
      .from(appBuilds)
      .where(inArray(appBuilds.status, ["building", "reconciling"]));
  }
  /** 读取应用指定环境的入口事实；缺失记录视为应用台账不完整。 */
  async endpoint(appId: string, environment: AppEnvironment) {
    return (
      await this.db
        .select()
        .from(appEndpoints)
        .where(
          and(
            eq(appEndpoints.appId, appId),
            eq(appEndpoints.environment, environment),
          ),
        )
    )[0];
  }
  /** 读取一个应用或全部应用的环境入口，供详情展示、启动恢复和维护使用。 */
  async endpoints(appId?: string) {
    return this.db
      .select()
      .from(appEndpoints)
      .where(appId ? eq(appEndpoints.appId, appId) : undefined);
  }
  /** 登记候选运行实例的构建、环境和切换代次，在启动容器前留下可追溯身份。 */
  async registerDeployment(
    appId: string,
    buildId: string,
    environment: AppEnvironment,
    id: string,
    epoch: number,
  ) {
    const [build] = await this.db
      .select()
      .from(appBuilds)
      .where(
        and(
          eq(appBuilds.id, buildId),
          eq(appBuilds.appId, appId),
          eq(appBuilds.target, environment),
        ),
      );
    if (!build?.artifact || build.status !== "succeeded")
      fail(409, "APPLICATION_BUILD_NOT_READY");
    const now = Date.now();
    await this.db.insert(appDeployments).values({
      id,
      appId,
      buildId,
      environment,
      epoch,
      desiredState: "running",
      observedState: "creating",
      createdAt: now,
      updatedAt: now,
    });
  }
  /** 内部按编号读取部署记录；调用方需核对应用归属后才能对外操作。 */
  async deployment(id: string) {
    return (
      await this.db
        .select()
        .from(appDeployments)
        .where(eq(appDeployments.id, id))
    )[0];
  }
  /** 读取应用的部署历史，区分期望状态和实际观测状态。 */
  async deployments(appId?: string) {
    return this.db
      .select()
      .from(appDeployments)
      .where(appId ? eq(appDeployments.appId, appId) : undefined)
      .orderBy(desc(appDeployments.createdAt));
  }
  /** 更新容器的观测状态、运行描述及可选期望状态，不把数据库写入当作 Docker 操作已完成。 */
  async deploymentState(
    id: string,
    observedState: string,
    spec?: AppDeployment,
    desiredState?: string,
  ) {
    await this.db
      .update(appDeployments)
      .set({
        observedState,
        ...(spec ? { spec } : {}),
        ...(desiredState ? { desiredState } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(appDeployments.id, id));
  }
  /** 核对当前入口代次后登记下一次切换意图，保留期望与已应用部署的差异供故障恢复。 */
  async desire(
    appId: string,
    environment: AppEnvironment,
    deploymentId: string | null,
    expected: number,
  ) {
    const [endpoint] = await this.db
      .update(appEndpoints)
      .set({
        generation: expected + 1,
        desiredDeploymentId: deploymentId,
        state: "switching",
      })
      .where(
        and(
          eq(appEndpoints.appId, appId),
          eq(appEndpoints.environment, environment),
          eq(appEndpoints.generation, expected),
        ),
      )
      .returning();
    if (!endpoint) fail(409, "APPLICATION_ENDPOINT_CHANGED");
    return endpoint;
  }
  /** 最近确认的入口保护策略，下线时保留，用于防止重新上线时意外公开。 */
  async authProtection(appId: string) {
    const result = await this.db.execute<{ environment: AppEnvironment; enabled: boolean; providers: VisitorProvider[] | null }>(
      sql`SELECT environment, enabled, providers FROM app_auth_scopes WHERE app_id=${appId}`,
    );
    return result.rows;
  }

  /** 在网关切换已核对后提交已应用部署和检查时间，同时校验入口代次及期望部署。 */
  async observed(
    appId: string,
    environment: AppEnvironment,
    generation: number,
    deploymentId: string | null,
  ) {
    return this.db.transaction(async tx => {
      // 认证回调也持有应用锁，更新生效方式时不会穿插提交旧认证。
      await tx.execute(sql`SELECT id FROM applications WHERE id=${appId} FOR UPDATE`);
      const [endpoint] = await tx
        .update(appEndpoints)
        .set({
          appliedDeploymentId: deploymentId,
          state: deploymentId ? "ready" : "offline",
          checkedAt: Date.now(),
        })
        .where(
          and(
            eq(appEndpoints.appId, appId),
            eq(appEndpoints.environment, environment),
            eq(appEndpoints.generation, generation),
            deploymentId
              ? eq(appEndpoints.desiredDeploymentId, deploymentId)
              : sql`${appEndpoints.desiredDeploymentId} IS NULL`,
          ),
        )
        .returning();
      if (!endpoint) fail(409, "APPLICATION_ENDPOINT_CHANGED");
      if (deploymentId) await tx.execute(sql`UPDATE app_auth_scopes s
        SET enabled = d.spec->'visitorAuth' IS NOT NULL, providers = d.spec->'visitorAuth'->'providers'
        FROM app_deployments d
        WHERE d.id=${deploymentId} AND s.app_id=${appId} AND s.environment=${environment}`);
      return endpoint;
    });
  }
  /** 把外部运行状态无法确认的入口标为待核对，阻止后续操作覆盖不明切换。 */
  async uncertain(appId: string, environment: AppEnvironment) {
    await this.db
      .update(appEndpoints)
      .set({ state: "reconciling" })
      .where(
        and(
          eq(appEndpoints.appId, appId),
          eq(appEndpoints.environment, environment),
        ),
      );
  }
  /** 保存数据环境的库名、角色和已应用声明摘要；控制面记录不保存明文密码。 */
  async dataState(state: DataEnvironment) {
    const value = {
      appId: state.appId,
      environment: state.environment,
      databaseName: state.database,
      role: state.role,
      schema: state.schema!,
      updatedAt: Date.now(),
    };
    await this.db
      .insert(appDataEnvironments)
      .values(value)
      .onConflictDoUpdate({
        target: [appDataEnvironments.appId, appDataEnvironments.environment],
        set: value,
      });
  }
  /** 读取应用指定环境的数据台账，用于工作台和状态核对。 */
  async dataEnvironment(appId: string, environment: AppEnvironment) {
    return (
      await this.db
        .select()
        .from(appDataEnvironments)
        .where(
          and(
            eq(appDataEnvironments.appId, appId),
            eq(appDataEnvironments.environment, environment),
          ),
        )
    )[0];
  }
  /** 更新应用生命周期状态，供恢复或管理流程使用。 */
  async status(appId: string, status: string) {
    await this.db
      .update(applications)
      .set({ status, updatedAt: Date.now() })
      .where(eq(applications.id, appId));
  }
  /** 按递增事件编号读取后续应用事件，支持客户端或运维续读进度。 */
  async events(appId: string, after: number) {
    return this.db
      .select()
      .from(appEvents)
      .where(and(eq(appEvents.appId, appId), gt(appEvents.eventId, after)))
      .orderBy(asc(appEvents.eventId))
      .limit(500);
  }
  /** 检查用户归属和预期状态版本后改名，防止旧页面覆盖另一个请求刚更新的名称。 */
  async rename(
    ownerId: string,
    appId: string,
    title: string,
    expected: number,
  ) {
    await this.owned(ownerId, appId);
    const [app] = await this.db
      .update(applications)
      .set({ title, stateVersion: expected + 1, updatedAt: Date.now() })
      .where(
        and(
          eq(applications.id, appId),
          eq(applications.stateVersion, expected),
        ),
      )
      .returning();
    if (!app) fail(409, "APPLICATION_CHANGED");
    return app;
  }
}
