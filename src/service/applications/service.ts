/** 应用流程协调器：只组合现有会话、固定源码、Builder、数据与入口，不实现第二套Agent循环。 */
import {
  ObservationService,
  type ObservationOptions,
} from "../observability/service.js";
import { randomUUID, createHash } from "node:crypto";
import { applicationExpertId, applicationLoginCommand } from "../../shared/application-skills.js";
import { mkdir, cp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Controller } from "../../runtime/controller.js";
import type { SessionManager } from "../session-manager.js";
import { fail, ServiceError } from "../types.js";
import {
  ApplicationStore,
  type ApplicationOperation,
  type ApplicationRevision,
} from "./store.js";
import { ApplicationSources } from "./source-store.js";
import { ApplicationBuilder } from "./builder.js";
import {
  ApplicationData,
  type AppEnvironment,
  type DataEnvironment,
} from "./data.js";
import {
  AppDockerDriver,
  type AppBuild,
  type AppDeployment,
} from "./docker.js";
import { CaddyApplicationEdge } from "./edge.js";
import { VisitorAuthService } from "./visitor-auth/service.js";
import { visitorProviders } from "./visitor-auth/policy.js";
import type { VisitorAuthOptions } from "./visitor-auth/config.js";
import { parseManifest, migrationPlan } from "./manifest.js";
import { readBusinessData } from "./table-query.js";

/** 应用控制面的安装配置；由服务端提供存储、数据管理身份、网关和创作者白名单，不接受浏览器透传。 */
export interface ApplicationOptions {
  /** 平台私有应用存储根；不挂载给生成代码的 Agent。 */
  root: string;
  nodeBase: string;
  /** 平台用于建库和迁移的管理连接；不能交给应用运行实例。 */
  dataAdminUrl: string;
  databaseHost?: string;
  edge: CaddyApplicationEdge;
  /** 允许创作应用的内部用户编号集合。 */
  creators: Set<string>;
  templateDirectory?: string;
  downloadProxy?: string;
  observation?: ObservationOptions;
  visitorAuth?: VisitorAuthOptions;
}
/** 给模型的应用开发约定：限定修改位置、数据声明和平台接口。实际权限与数据校验仍由运行器及服务端执行。 */
const instructions = `你是应用创建助理。当前工作区是平台标准React/TypeScript应用模板。
按用户需求修改src/页面与样式、server/index.ts业务路由及harbor-app.json平台配置。
保留package-lock.json，前端使用import.meta.env.BASE_URL构造页面/API路径；X-App-Revision使用__APP_REVISION__。
业务观测使用harbor-app.json的analytics声明；前端通过window.harbor.track发送已声明行为，成功结果用table_created绑定或context.analytics.transaction在业务事务内emit。不要上传表单内容或个人资料。
新应用用 migrations/ 管理业务表：以三位数字排序并追加 .sql 文件，首版支持 CREATE TABLE 和 ALTER TABLE ADD COLUMN（可空）。不要改写旧脚本或在应用启动时执行DDL。formatVersion 1 的旧应用沿用原表声明，切换前保留旧表。
应用需要接入或调整访客登录时，使用 ${applicationLoginCommand} 技能，并在 harbor-app.json 声明登录设置。
不要生成Dockerfile、修改平台启动器或自行listen。模板构建和部署由平台完成。
后端仅导出register(router,context)，业务路由放在/api/下，保留平台健康入口。输入内容按文本渲染，不拼接HTML/SQL。
只运行必要检查，不启动跨轮后台服务。完成后用简短中文说明具体改动和局限。`;
/**
 * 应用创建内置的专家快照，结构对应 ExpertSnapshot；它是配置对象，本身不执行代码。
 * create() 将它交给 createPrepared()，随后保存为会话的 expertSnapshot。
 * SessionManager.execute() 读取快照，经 Conversation 的 Task.expert 传到 runnerOptions()，
 * 最终由 systemPrompt.append 把 instructions 追加到原生 claude_code 提示词。
 * 固定编号用于标识内置角色及版本；digest 是指令内容指纹，恢复原生对话时用于检查一致性。
 */
const appExpert = {
  schemaVersion: 1 as const,
  expertId: applicationExpertId,
  versionId: "ca26abe9-23fc-4389-bd22-1b78a414c436",
  version: 5,
  name: "应用创建助理",
  instructions,
  examples: [],
  digest: createHash("sha256").update(instructions).digest("hex"),
};
/** 暂停当前异步流程，供消息结束和环境停止的轮询使用；不占用数据库事务。 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 协调应用的创建、生成、版本和部署。Agent 执行复用 SessionManager，固定源码、数据与容器分别交给专门组件。 */
export class ApplicationService {
  analysis?: import("./analysis.js").ApplicationAnalysis;
  observation?: ObservationService;
  readonly visitorAuth?: VisitorAuthService;
  readonly sources: ApplicationSources;
  readonly builder: ApplicationBuilder;
  readonly data: ApplicationData;
  readonly driver: AppDockerDriver;
  // 以下 Map 记录本进程工作及完成凭据；可恢复事实保存在 ApplicationStore。
  private tasks = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  private pendingPreviews = new Map<string, string>();
  // Promise 队列分别串行化构建和入口切换；等待队列时不持有数据库事务。
  private builds = Promise.resolve();
  private edges = Promise.resolve();
  private closing = false;
  private buildsBlocked = false;
  private previewLeases = new Map<string, number>();
  private previewTimer?: ReturnType<typeof setInterval>;
  private refreshingEndpoints = false;
  private exports = new Map<string, Set<Promise<unknown>>>();
  /** 删除前取消本应用操作、停止开发写入者并撤下访问入口；等待进行中的导出结束后再交给删除流程清理。 */
  async stopForDeletion(appId: string) {
    this.pendingPreviews.delete(appId);
    this.previewLeases.delete(appId);
    const operations = await this.store.active(appId);
    for (const operation of operations) this.aborts.get(operation.id)?.abort();
    const app = await this.store.byId(appId);
    /** 在入口切换锁内撤下本应用两个环境的路由，避免删除清理与发布切换互相覆盖。 */
    const withdraw = async () => {
      const previous = this.edges;
      let release!: () => void;
      this.edges = new Promise<void>(done => { release = done; });
      await previous;
      try {
        for (const environment of ["preview", "production"] as const)
          await this.options.edge.replaceEndpoint(appId, environment, null);
      } finally { release(); }
    };
    // 凭据撤销、原生执行器与代理的故障互不短路，至少尝试撤下公开入口并停止写入者。
    const results = await Promise.allSettled([
      withdraw(),
      app?.developmentSessionId ? this.sessions.stopForDeletion(app.ownerId, app.developmentSessionId) : undefined,
      Promise.allSettled(operations.map(operation => this.tasks.get(operation.id))),
      Promise.allSettled([...(this.exports.get(appId) ?? [])]),
      this.observation?.store.revoke(appId),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  /** 组装源码、构建与数据组件，并给会话管理器安装应用写入门，确保生成只能从应用入口登记后提交。 */
  constructor(
    readonly store: ApplicationStore,
    readonly sessions: SessionManager,
    readonly controller: Controller,
    readonly options: ApplicationOptions,
  ) {
    this.visitorAuth = options.visitorAuth ? new VisitorAuthService(store.db, options.visitorAuth) : undefined;
    this.sources = new ApplicationSources(options.root);
    this.builder = new ApplicationBuilder(
      options.root,
      this.sources,
      options.nodeBase,
      resolve("infra/app-runtime"),
      options.downloadProxy,
    );
    this.driver = this.builder.driver;
    this.data = new ApplicationData(options.root, options.dataAdminUrl);
    sessions.onUserClose = (userId) => this.suspendUser(userId);
    sessions.applicationWriteGuard = async (sessionId, message) => {
      const app = await store.forSession(sessionId);
      if (!app) return;
      if (app.status !== "active") fail(409, "APPLICATION_NOT_ACTIVE");
      const operations = await store.active(app.id, "source");
      if (message) {
        const accepted = operations.find(
          (operation) =>
            operation.kind === "generate" &&
            operation.payload.clientMessageId === message.id &&
            operation.payload.text === message.text,
        );
        if (!accepted || !["queued", "running"].includes(accepted.state))
          fail(409, "USE_APPLICATION_MESSAGE_ENTRY");
      } else if (operations.length) fail(409, "APPLICATION_BUSY");
    };
  }
  /** 校验服务可接收操作、账号有效且在受信创作者白名单内；读取详情仍有自己的归属检查。 */
  private async allowed(userId: string) {
    if (this.closing) fail(503, "APPLICATION_SERVICE_STOPPING");
    await this.sessions.identity.require(userId);
    if (!this.options.creators.has(userId))
      fail(403, "APPLICATION_CREATOR_NOT_ENABLED");
  }
  /** 运行已登记的异步操作并保存进度；异常时区分失败、取消和待核对，清理完成凭据后再接续最新预览。 */
  private launch(
    operation: ApplicationOperation,
    work: () => Promise<Record<string, unknown>>,
  ) {
    if (this.tasks.has(operation.id)) return;
    const abort = new AbortController();
    this.aborts.set(operation.id, abort);
    const promise = Promise.resolve()
      .then(async () => {
        try {
          abort.signal.throwIfAborted();
          await this.store.progress(operation.id, "running", "starting");
          const result = await work();
          await this.store.progress(
            operation.id,
            "succeeded",
            "finished",
            result,
          );
        } catch (error) {
          const code =
            error instanceof ServiceError
              ? error.code
              : abort.signal.aborted
                ? "APPLICATION_OPERATION_CANCELLED"
                : "APPLICATION_OPERATION_FAILED";
          const active = await this.store
            .endpoints(operation.appId)
            .catch(() => []);
          const deployments = await this.store
            .deployments(operation.appId)
            .catch(() => []);
          const app = await this.store
            .byId(operation.appId)
            .catch(() => undefined);
          const session = app?.developmentSessionId
            ? await this.sessions.store
                .session(app.developmentSessionId)
                .catch(() => undefined)
            : undefined;
          const currentOperation = await this.store.operation(
            operation.ownerId,
            operation.appId,
            operation.id,
          );
          const state =
            (operation.kind === "restore" &&
              currentOperation.phase === "replacing_source") ||
            active.some((endpoint) => endpoint.state === "reconciling") ||
            deployments.some(
              (deployment) => deployment.observedState === "unknown",
            ) ||
            session?.environment === "reconciling" ||
            this.buildsBlocked
              ? "reconciling"
              : [
                    "APPLICATION_GENERATION_CANCELLED",
                    "APPLICATION_OPERATION_CANCELLED",
                  ].includes(code)
                ? "cancelled"
                : "failed";
          await mkdir(join(this.options.root, "operations"), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(
            join(this.options.root, "operations", operation.id + ".log"),
            String(error),
            { mode: 0o600 },
          );
          await this.store.progress(operation.id, state, code, undefined, code);
        }
      })
      .catch((error) =>
        console.error(
          "Application operation persistence failed",
          operation.id,
          error instanceof Error ? error.name : "unknown",
        ),
      )
      .finally(() => {
        this.tasks.delete(operation.id);
        this.aborts.delete(operation.id);
        const wanted = this.pendingPreviews.get(operation.appId);
        if (operation.resourceKey === "preview" && wanted)
          this.queuePreview(operation.appId, wanted);
      });
    this.tasks.set(operation.id, promise);
  }
  /** 登记应用后异步准备开发会话、复制模板并保存首版；有需求则提交生成，否则直接构建模板预览。返回值仅表示已接收。 */
  async create(
    userId: string,
    title: string,
    prompt: string,
    requestId: string,
    modelDeploymentId?: string,
  ) {
    await this.allowed(userId);
    const result = await this.store.create(userId, title, prompt, requestId, modelDeploymentId);
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        const sessionId = randomUUID();
        await this.store.progress(result.operation.id, "running", "preparing", {
          sessionId,
        });
        const session = await this.sessions.createPrepared(
          userId,
          title,
          sessionId,
          async () => {
            const directory = await this.controller.store.prepare(sessionId);
            await cp(
              this.options.templateDirectory ??
                resolve("templates/application-v1"),
              join(directory, "workspace"),
              { recursive: true },
            );
            if (!this.options.templateDirectory)
              await cp(resolve("templates/application-sql"), join(directory, "workspace"), { recursive: true });
          },
          // 专家在创建会话时固定；后续生成从会话快照恢复，不随每条用户消息重新选择。
          { expert: appExpert, deploymentId: modelDeploymentId },
        );
        await this.store.activate(result.app.id, session.id);
        const source = await this.sources.snapshot(
          result.app.id,
          join(this.controller.store.directory(session.id), "workspace"),
        );
        const manifest = parseManifest(
          JSON.parse(
            await readFile(
              join(
                this.controller.store.directory(session.id),
                "workspace/harbor-app.json",
              ),
              "utf8",
            ),
          ),
        );
        const revision = await this.store.addRevision(
          result.app.id,
          source,
          manifest,
          "创建应用模板",
          null,
        );
        await this.store.progress(
          result.operation.id,
          "succeeded",
          "prepared",
          { sessionId, revisionId: revision.id },
        );
        if (prompt.trim())
          await this.generate(
            userId,
            result.app.id,
            prompt,
            randomUUID(),
            revision.id,
          );
        else this.queuePreview(result.app.id, revision.id);
        return { sessionId, revisionId: revision.id };
      });
    return result;
  }
  /** 在应用源码写入门内接收需求，复用会话执行；成功后确认开发环境停止、保存固定版本，再自动排队预览。 */
  async generate(
    userId: string,
    appId: string,
    text: string,
    clientMessageId: string,
    expectedHead: string | null,
    modelDeploymentId?: string,
  ) {
    await this.allowed(userId);
    const app = await this.store.owned(userId, appId);
    if (!app.developmentSessionId) fail(409, "APPLICATION_NOT_READY");
    /** 登记本次源码操作及请求内容，重复提交沿用原请求。 */
    const register = () =>
      this.store.begin(userId, appId, "generate", clientMessageId, "source", {
        text,
        clientMessageId,
        expectedHeadRevisionId: expectedHead,
        ...(modelDeploymentId ? { modelDeploymentId } : {}),
      });
    const result = await this.sessions.admitApplicationChange(
      userId,
      app.developmentSessionId,
      register,
      async () =>
        (await this.store.request(userId, "generate", clientMessageId))
          ? register()
          : undefined,
    );
    if (result.duplicate) {
      const old = await this.sessions.store.duplicate(
        app.developmentSessionId,
        clientMessageId,
      );
      return {
        operation: result.operation,
        ...(old ? { message: old, duplicate: true } : {}),
      };
    }
    let accepted;
    try {
      accepted = await this.sessions.submit(
        userId,
        app.developmentSessionId,
        clientMessageId,
        text,
        modelDeploymentId,
      );
    } catch (error) {
      await this.store.progress(
        result.operation.id,
        "failed",
        "submission_failed",
        undefined,
        error instanceof ServiceError ? error.code : "SUBMISSION_FAILED",
      );
      throw error;
    }
    this.launch(result.operation, async () => {
      await this.store.progress(result.operation.id, "running", "generating", {
        messageId: accepted.message.id,
      });
      let message = await this.sessions.store.message(accepted.message.id);
      while (
        message &&
        ["accepted", "running", "finalizing"].includes(message.status)
      ) {
        if (this.closing) throw new Error("APPLICATION_SERVICE_STOPPING");
        await sleep(150);
        message = await this.sessions.store.message(accepted.message.id);
      }
      await this.sessions.awaitApplicationMessage(
        app.developmentSessionId!,
        accepted.message.id,
      );
      await this.closeDevelopment(app.ownerId, app.developmentSessionId!);
      if (message?.result && JSON.parse(message.result)?.reason === "task_timeout")
        fail(409, "APPLICATION_GENERATION_TIMEOUT");
      if (message?.status === "cancelled")
        fail(409, "APPLICATION_GENERATION_CANCELLED");
      if (message?.status !== "succeeded")
        fail(409, "APPLICATION_GENERATION_NOT_COMPLETED");
      await this.store.progress(
        result.operation.id,
        "running",
        "saving_version",
      );
      const revision = await this.capture(
        appId,
        app.developmentSessionId!,
        expectedHead,
        text.slice(0, 120),
        accepted.message.id,
      );
      void this.sessions.tracing?.observeArtifact(revision.id, accepted.message.id);
      this.queuePreview(appId, revision.id);
      return { revisionId: revision.id, messageId: accepted.message.id };
    });
    return { ...accepted, operation: result.operation };
  }
  /** 请求关闭开发环境并等待明确的 closed 状态；30 秒仍无法确认则报错，禁止继续截取可能被修改的源码。 */
  private async closeDevelopment(userId: string, sessionId: string) {
    const session = await this.sessions.owned(userId, sessionId);
    await this.sessions.close(userId, sessionId, session.lastMessageId);
    const deadline = Date.now() + 30000;
    while (
      (await this.sessions.owned(userId, sessionId)).environment !== "closed"
    ) {
      if (Date.now() > deadline)
        fail(503, "APPLICATION_DEVELOPMENT_STOP_UNCONFIRMED");
      await sleep(100);
    }
  }
  /** 读取已停止写入的工作区，保存 Git 快照和经过校验的数据声明，并以预期头版本登记新版本。 */
  private async capture(
    appId: string,
    sessionId: string,
    expectedHead: string | null,
    summary: string,
    messageId?: string,
    restoredFromId?: string,
  ) {
    const directory = join(
      this.controller.store.directory(sessionId),
      "workspace",
    );
    const source = await this.sources.snapshot(appId, directory);
    const manifest = parseManifest(
      JSON.parse(await readFile(join(directory, "harbor-app.json"), "utf8")),
    );
    return this.store.addRevision(
      appId,
      source,
      manifest,
      summary,
      expectedHead,
      messageId,
      restoredFromId,
    );
  }
  /** 合并同一应用待预览的版本，只保留最新需求；已有预览操作时等待其结束后接续。 */
  queuePreview(appId: string, revisionId: string) {
    this.pendingPreviews.set(appId, revisionId);
    void Promise.resolve()
      .then(async () => {
        if (this.closing || (await this.store.active(appId, "preview")).length)
          return;
        const wanted = this.pendingPreviews.get(appId),
          app = await this.store.byId(appId);
        if (!wanted || !app || app.status !== "active") return;
        this.pendingPreviews.delete(appId);
        await this.deploy(app.ownerId, appId, wanted, "preview", randomUUID());
      })
      .catch((error) =>
        console.error(
          "Application preview registration failed",
          appId,
          error instanceof Error ? error.name : "unknown",
        ),
      );
  }
  /** 登记预览或正式发布操作，检查入口代次后依次构建、准备候选实例并切换入口；重复请求复用原操作。 */
  async deploy(
    userId: string,
    appId: string,
    revisionId: string,
    environment: AppEnvironment,
    requestId: string,
    expectedGeneration?: number,
    allowPublic = false,
  ) {
    await this.allowed(userId);
    await this.store.owned(userId, appId);
    const revision = await this.store.revision(appId, revisionId);
    const endpoint = await this.store.endpoint(appId, environment);
    const kind = environment === "preview" ? "preview" : "publish";
    const old = await this.store.request(userId, kind, requestId);
    const generation =
      expectedGeneration ??
      (old?.payload.expectedGeneration as number | undefined) ??
      endpoint.generation;
    const result = await this.store.begin(
      userId,
      appId,
      kind,
      requestId,
      environment,
      { revisionId, expectedGeneration: generation, ...(allowPublic ? { allowPublic: true } : {}) },
    );
    if (!result.duplicate && generation !== endpoint.generation) {
      await this.store.progress(
        result.operation.id,
        "failed",
        "APPLICATION_ENDPOINT_CHANGED",
      );
      fail(409, "APPLICATION_ENDPOINT_CHANGED");
    }
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        if (revision.manifest.formatVersion === 2) {
          const files = await this.sources.migrations(revision.source);
          await this.data.checkSql(appId, environment, files);
        }
        const artifact = await this.build(
          result.operation,
          revision,
          environment,
        );
        this.aborts.get(result.operation.id)?.signal.throwIfAborted();
        const deployment = await this.prepareDeployment(
          result.operation,
          revision,
          artifact,
          endpoint.generation + 1,
        );
        await this.switchEndpoint(
          result.operation,
          environment,
          deployment,
          endpoint.generation,
        );
        return { deploymentId: deployment.id, revisionId };
      });
    return result;
  }
  /** 在本服务内串行构建固定版本并登记产物；构建容器清理不明时阻止后续构建，等待显式核对。 */
  private async build(
    operation: ApplicationOperation,
    revision: ApplicationRevision,
    target: AppEnvironment,
  ) {
    const previous = this.builds;
    let release!: () => void;
    this.builds = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const id = randomUUID();
    try {
      if (this.closing) throw new Error("APPLICATION_SERVICE_STOPPING");
      if (this.buildsBlocked) fail(503, "APPLICATION_BUILDER_RECONCILING");
      await this.store.progress(operation.id, "running", "building");
      await this.store.registerBuild(operation.appId, revision.id, target, id);
      const artifact = await this.builder.build(
        revision.source,
        target,
        revision.id,
        id,
        this.aborts.get(operation.id)?.signal,
      );
      await this.store.finishBuild(id, artifact);
      return artifact;
    } catch (error) {
      try {
        if (await this.driver.inspect("ah-app-build-" + id))
          this.buildsBlocked = true;
      } catch {
        this.buildsBlocked = true;
      }
      await this.store.finishBuild(
        id,
        undefined,
        "APPLICATION_BUILD_FAILED",
        this.buildsBlocked ? "reconciling" : "failed",
      );
      throw error;
    } finally {
      release();
    }
  }
  /** 按版本声明准备对应环境的数据，启动候选应用容器并验证身份与健康；失败时尝试销毁候选实例。 */
  private async prepareDeployment(
    operation: ApplicationOperation,
    revision: ApplicationRevision,
    artifact: AppBuild,
    epoch: number,
  ) {
    const currentEndpoint = await this.store.endpoint(operation.appId, artifact.target);
    const previous = currentEndpoint.appliedDeploymentId
      ? (await this.store.deployment(currentEndpoint.appliedDeploymentId))?.spec?.visitorAuth
      : undefined;
    const stored = (await this.store.authProtection(operation.appId))
      .find(policy => policy.environment === artifact.target);
    const protectedBefore = !!(previous || stored?.enabled);
    const retained = previous?.providers ?? stored?.providers ?? [...visitorProviders];
    const declaration = revision.manifest.auth;
    // 未声明的旧版本和回滚保留已生效的保护。只有明确的公开声明和所有者确认能取消它。
    if (protectedBefore && operation.kind !== "rollback" && declaration?.mode === "public" &&
        operation.payload.allowPublic !== true)
      fail(409, "APPLICATION_AUTH_PUBLIC_CONFIRMATION_REQUIRED");
    const providers = operation.kind === "rollback" && protectedBefore
      ? retained
      : declaration?.mode === "required" ? declaration.providers
      : declaration === undefined && protectedBefore ? retained
      : undefined;
    if (providers && !this.visitorAuth) fail(503, "APPLICATION_AUTH_UNAVAILABLE");
    if (providers && artifact.visitorAuthVersion !== 1)
      fail(409, "APPLICATION_AUTH_RUNTIME_REQUIRED");
    this.aborts.get(operation.id)?.signal.throwIfAborted();
    const visitorAuth = providers ? await this.visitorAuth!.provision(
      operation.appId, operation.ownerId, artifact.target, providers,
    ) : undefined;
    await this.store.progress(operation.id, "running", "preparing_data");
    let state: DataEnvironment;
    if (operation.kind === "rollback") {
      state = await this.data.open(operation.appId, artifact.target);
      // 回滚只验证原版本依赖，保留已经提交的数据迁移。
      if (revision.manifest.formatVersion === 2)
        await this.data.checkSql(operation.appId, artifact.target, await this.sources.migrations(revision.source), true);
      else migrationPlan(revision.manifest, state.schema!);
    } else {
      state = await this.data.provision(operation.appId, artifact.target, revision.manifest,
        revision.manifest.formatVersion === 2 ? await this.sources.migrations(revision.source) : []);
    }
    await this.store.dataState({ ...state, schema: state.schema ?? revision.manifest });
    const id = randomUUID();
    await this.store.registerDeployment(
      operation.appId,
      artifact.id,
      artifact.target,
      id,
      epoch,
    );
    await this.store.progress(operation.id, "running", "starting_container", {
      deploymentId: id,
    });
    try {
      const observation = await this.observation?.deployment(
        operation.appId,
        artifact.target,
        artifact.revisionId,
        id,
        revision.manifest.analytics,
      );
      const deployment = await this.driver.create(
        artifact,
        id,
        this.data.connection(state, false, this.options.databaseHost),
        observation,
        visitorAuth,
      );
      await this.driver.start(deployment);
      await this.store.deploymentState(id, "starting", deployment);
      await this.driver.healthy(deployment);
      await this.store.deploymentState(id, "healthy", deployment);
      return deployment;
    } catch (error) {
      try {
        await this.driver.destroy("ah-app-" + id);
        await this.store.deploymentState(id, "stopped", undefined, "stopped");
      } catch {
        await this.store.deploymentState(id, "unknown");
      }
      throw error;
    }
  }
  /** 串行切换一个应用入口并核对代次；确认新路由后才清理旧实例，外部状态不明时保留待核对状态。 */
  private async switchEndpoint(
    operation: ApplicationOperation,
    environment: AppEnvironment,
    deployment: AppDeployment | null,
    expected: number,
  ) {
    const previous = this.edges;
    let release!: () => void;
    this.edges = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let changed = false;
    try {
      const before = await this.store.endpoint(operation.appId, environment);
      if (before.state === "reconciling" && deployment) fail(503, "APPLICATION_EDGE_RECONCILING");
      const app = await this.store.byId(operation.appId);
      if (deployment && app) await this.sessions.identity.require(app.ownerId);
      if (deployment && app?.status !== "active")
        fail(409, "APPLICATION_NOT_ACTIVE");
      if (before.generation !== expected)
        fail(409, "APPLICATION_ENDPOINT_CHANGED");
      await this.store.desire(
        operation.appId,
        environment,
        deployment?.id ?? null,
        expected,
      );
      changed = true;
      await this.store.progress(operation.id, "running", "switching", {
        deploymentId: deployment?.id,
      });
      await this.options.edge.replaceEndpoint(operation.appId, environment, deployment);
      await this.store.observed(
        operation.appId,
        environment,
        expected + 1,
        deployment?.id ?? null,
      );
      if (deployment) await this.driver.activate(deployment);
      if (
        before.appliedDeploymentId &&
        before.appliedDeploymentId !== deployment?.id
      ) {
        const old = await this.store.deployment(before.appliedDeploymentId);
        if (old?.spec) {
          try {
            await this.driver.destroy(old.spec.container);
            await this.store.deploymentState(
              old.id,
              "stopped",
              undefined,
              "stopped",
            );
          } catch {
            await this.store.deploymentState(
              old.id,
              "unknown",
              undefined,
              "stopped",
            );
            fail(503, "APPLICATION_OLD_DEPLOYMENT_CLEANUP_UNCONFIRMED");
          }
        }
      }
    } catch (error) {
      if (changed) await this.store.uncertain(operation.appId, environment);
      else if (deployment) {
        await this.driver.destroy(deployment.container);
        await this.store.deploymentState(
          deployment.id,
          "stopped",
          undefined,
          "stopped",
        );
      }
      throw error;
    } finally {
      release();
    }
  }
  /** 登记正式下线操作并撤下 production 入口、停止旧实例；源码历史和业务数据库保留。 */
  async unpublish(
    userId: string,
    appId: string,
    requestId: string,
    expected: number,
  ) {
    await this.allowed(userId);
    const result = await this.store.begin(
      userId,
      appId,
      "unpublish",
      requestId,
      "production",
      { expectedGeneration: expected },
    );
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        await this.switchEndpoint(
          result.operation,
          "production",
          null,
          expected,
        );
        return {};
      });
    return result;
  }
  /** 停止开发环境，把历史源码恢复为新版本并重置原生对话状态；保留产品消息历史，业务数据不随源码回退。 */
  async restore(
    userId: string,
    appId: string,
    revisionId: string,
    requestId: string,
    expectedHead: string | null,
  ) {
    await this.allowed(userId);
    const app = await this.store.owned(userId, appId),
      revision = await this.store.revision(appId, revisionId);
    if (!app.developmentSessionId) fail(409, "APPLICATION_NOT_READY");
    const result = await this.sessions.admitApplicationChange(
      userId,
      app.developmentSessionId,
      () =>
        this.store.begin(userId, appId, "restore", requestId, "source", {
          revisionId,
          expectedHeadRevisionId: expectedHead,
        }),
    );
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        await this.closeDevelopment(userId, app.developmentSessionId!);
        const directory = this.controller.store.directory(
            app.developmentSessionId!,
          ),
          incoming = join(directory, "restore-" + result.operation.id),
          old = join(directory, "workspace-before-" + result.operation.id);
        await this.sources.export(revision.source, incoming);
        await this.store.progress(
          result.operation.id,
          "running",
          "replacing_source",
        );
        await rename(join(directory, "workspace"), old);
        await rename(incoming, join(directory, "workspace"));
        // 从服务层保留历史，清空底层原生会话，下一次query基于恢复文件重新读取。
        await rename(
          join(directory, "claude-state"),
          join(directory, "claude-state-before-" + result.operation.id),
        );
        await mkdir(join(directory, "claude-state"), { mode: 0o700 });
        const state = await this.controller.store.load(
          app.developmentSessionId!,
        );
        delete state.sdkSessionId;
        state.generation += 1;
        await this.controller.store.save(state);
        const next = await this.capture(
          appId,
          app.developmentSessionId!,
          expectedHead,
          "从v" + revision.number + "恢复",
          undefined,
          revision.id,
        );
        await rm(old, { recursive: true, force: true });
        this.queuePreview(appId, next.id);
        return { revisionId: next.id };
      });
    return result;
  }
  /** 手动保存当前工作区：取得源码操作占位、确认开发环境停止后生成版本，并自动准备预览。 */
  async snapshot(
    userId: string,
    appId: string,
    requestId: string,
    expectedHead: string | null,
  ) {
    await this.allowed(userId);
    const app = await this.store.owned(userId, appId);
    if (!app.developmentSessionId) fail(409, "APPLICATION_NOT_READY");
    /** 登记本次源码操作及请求内容；重复提交沿用原请求，避免网络重试触发第二轮生成或保存。 */
    const register = () =>
      this.store.begin(userId, appId, "snapshot", requestId, "source", {
        expectedHeadRevisionId: expectedHead,
      });
    const result = await this.sessions.admitApplicationChange(
      userId,
      app.developmentSessionId,
      register,
      async () =>
        (await this.store.request(userId, "snapshot", requestId))
          ? register()
          : undefined,
    );
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        await this.closeDevelopment(userId, app.developmentSessionId!);
        const revision = await this.capture(
          appId,
          app.developmentSessionId!,
          expectedHead,
          "手动保存版本",
        );
        this.queuePreview(appId, revision.id);
        return { revisionId: revision.id };
      });
    return result;
  }
  /** 复用历史正式部署的成功镜像启动新实例并切换入口；核对当前数据库兼容性，不反向迁移业务数据。 */
  async rollback(
    userId: string,
    appId: string,
    deploymentId: string,
    requestId: string,
    expectedGeneration: number,
  ) {
    await this.allowed(userId);
    await this.store.owned(userId, appId);
    const old = await this.store.deployment(deploymentId);
    if (old?.appId !== appId || old.environment !== "production" || !old.spec)
      fail(404, "APPLICATION_DEPLOYMENT_NOT_FOUND");
    const build = await this.store.build(appId, old.buildId);
    if (!build?.artifact || build.status !== "succeeded")
      fail(409, "APPLICATION_BUILD_NOT_READY");
    const revision = await this.store.revision(appId, build.revisionId);
    const result = await this.store.begin(
      userId,
      appId,
      "rollback",
      requestId,
      "production",
      { deploymentId, expectedGeneration },
    );
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        if (
          (await this.store.endpoint(appId, "production")).generation !==
          expectedGeneration
        )
          fail(409, "APPLICATION_ENDPOINT_CHANGED");
        const next = await this.prepareDeployment(
          result.operation,
          revision,
          build.artifact!,
          expectedGeneration + 1,
        );
        await this.switchEndpoint(
          result.operation,
          "production",
          next,
          expectedGeneration,
        );
        return { deploymentId: next.id, revisionId: revision.id };
      });
    return result;
  }
  /** 返回编辑页需要的应用、版本、入口和操作摘要，并续期预览访问；剔除宿主路径、运行配置及数据凭据。 */
  async detail(userId: string, appId: string) {
    await this.sessions.identity.require(userId);
    const app = await this.store.owned(userId, appId);
    this.previewLeases.set(appId, Date.now());
    const [revisions, endpoints, operations, deployments, authProtection] = await Promise.all([
      this.store.revisions(appId),
      this.store.endpoints(appId),
      this.store.operations(appId),
      this.store.deployments(appId),
      this.store.authProtection(appId),
    ]);
    // 不向浏览器返回容器spec、宿主路径、数据库账号或运行配置。
    return {
      app,
      analysisEnabled: !!this.analysis,
      revisions: revisions.map(({ source, ...revision }) => ({
        ...revision,
        commit: source.commit,
      })),
      endpoints: endpoints.map((endpoint) => {
        const auth = deployments.find(item => item.id === endpoint.appliedDeploymentId)?.spec?.visitorAuth;
        return {
          ...endpoint,
          requiresLogin: !!auth,
          previewParentOrigin: endpoint.environment === "preview" &&
            auth?.previewParentOrigin === this.visitorAuth?.options.workbenchOrigin
            ? auth?.previewParentOrigin : undefined,
          loginProviders: auth ? auth.providers ?? visitorProviders : [],
          publicReleaseNeedsConfirmation: !!auth || authProtection.some(
            policy => policy.environment === endpoint.environment && policy.enabled,
          ),
          url: (auth?.origin ?? this.options.edge.publicOrigin) +
            `/${endpoint.environment === "preview" ? "preview" : "apps"}/${appId}/`,
        };
      }),
      operations,
      deployments: deployments.map(({ spec, ...deployment }) => ({
        ...deployment,
        revisionId: spec?.build.revisionId,
      })),
    };
  }
  /** 跟踪一次固定版本导出的完成凭据，使删除流程可以等待正在执行的导出准备结束。 */
  async exportSource(userId: string, appId: string, revisionId: string) {
    const work = this.exportRevision(userId, appId, revisionId);
    const active = this.exports.get(appId) ?? new Set<Promise<unknown>>();
    this.exports.set(appId, active); active.add(work);
    try { return await work; }
    finally { active.delete(work); if (!active.size) this.exports.delete(appId); }
  }
  /** 鉴权后将指定 Git 版本导出到临时目录，返回下载信息及清理函数；导出失败立即清理目录。 */
  private async exportRevision(userId: string, appId: string, revisionId: string) {
    await this.sessions.identity.require(userId);
    await this.store.owned(userId, appId);
    const revision = await this.store.revision(appId, revisionId);
    const directory = join(this.options.root, "exports", appId, randomUUID());
    try {
      await this.sources.export(revision.source, directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      directory,
      number: revision.number,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
  /** 工作台使用与问数相同的表目录和受控读取。 */
  async tables(userId: string, appId: string, environment: AppEnvironment) {
    const { tables } = await readBusinessData(this, userId, appId, environment, { kind: "owner" });
    return { tables, migrations: await this.data.sqlHistory(appId, environment) };
  }

  async records(userId: string, appId: string, environment: AppEnvironment, table: string,
    limit: number, cursor?: string) {
    await this.store.owned(userId, appId);
    const identity = `data-page:${userId}:${appId}:${environment}:${table}`;
    const after = cursor ? await this.data.openCursor(identity, cursor) : undefined;
    const { rows, columns, next } = await readBusinessData(this, userId, appId, environment, { kind: "owner" },
      { table, limit, after });
    return { rows, columns, next: next && await this.data.sealCursor(identity, next) };
  }
  /** 生成操作转交会话取消；预览或发布只在可取消的构建阶段触发中止，不把已开始的切换冒充可撤销。 */
  async cancel(userId: string, appId: string, operationId: string) {
    await this.allowed(userId);
    const operation = await this.store.operation(userId, appId, operationId);
    if (!["queued", "running"].includes(operation.state))
      return { terminal: true };
    if (operation.kind === "generate") {
      const app = await this.store.owned(userId, appId);
      const message =
        app.developmentSessionId &&
        (await this.sessions.store.duplicate(
          app.developmentSessionId,
          String(operation.payload.clientMessageId),
        ));
      if (message && app.developmentSessionId)
        return this.sessions.cancel(
          userId,
          app.developmentSessionId,
          message.id,
        );
    }
    if (
      !["preview", "publish"].includes(operation.kind) ||
      !["accepted", "starting", "building"].includes(operation.phase)
    )
      fail(409, "APPLICATION_OPERATION_NOT_CANCELLABLE");
    const abort = this.aborts.get(operationId);
    if (!abort) fail(503, "APPLICATION_RECOVERY_REQUIRED");
    await this.store.progress(operationId, "cancelling", operation.phase);
    abort.abort();
    return { terminal: false };
  }
  /** 明确重试状态核对，不重放模型请求；只有容器、网关、源码均确认后才释放占位。 */
  async reconcile(userId: string, appId: string) {
    await this.allowed(userId);
    const app = await this.store.owned(userId, appId);
    const operations = await this.store.active(appId);
    if (operations.some((operation) => this.tasks.has(operation.id)))
      fail(409, "APPLICATION_BUSY");
    if (
      operations.some(
        (operation) =>
          operation.kind === "restore" &&
          operation.phase === "replacing_source",
      )
    )
      fail(503, "APPLICATION_SOURCE_RECOVERY_REQUIRED");
    if (operations.some((operation) => operation.kind === "create"))
      fail(503, "APPLICATION_CREATION_RECOVERY_REQUIRED");
    if (app.developmentSessionId) {
      const session = await this.sessions.owned(
        userId,
        app.developmentSessionId,
      );
      if (
        session.environment !== "closed" ||
        (await this.sessions.store.active(session.id))
      )
        fail(503, "APPLICATION_DEVELOPMENT_STOP_UNCONFIRMED");
    }
    for (const build of await this.store.builds(appId))
      if (["building", "reconciling"].includes(build.status)) {
        await this.driver.destroy("ah-app-build-" + build.id);
        await this.store.finishBuild(
          build.id,
          undefined,
          "APPLICATION_BUILD_INTERRUPTED",
        );
      }
    const previous = this.edges;
    let release!: () => void;
    this.edges = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const endpoints = await this.store.endpoints(appId), wanted: AppDeployment[] = [];
      for (const endpoint of endpoints) {
        const target = await this.recoverEndpoint(endpoint);
        if (target) wanted.push(target);
      }
      const retained = new Set(wanted.map((target) => target.id));
      for (const deployment of await this.store.deployments(appId))
        if (!retained.has(deployment.id)) {
          await this.driver.destroy(
            deployment.spec?.container ?? "ah-app-" + deployment.id,
          );
          await this.store.deploymentState(
            deployment.id,
            "stopped",
            undefined,
            "stopped",
          );
        }
      for (const operation of operations)
        await this.store.progress(
          operation.id,
          "failed",
          "interrupted_operation_reconciled",
          undefined,
          "APPLICATION_INTERRUPTED_RETRY_REQUIRED",
        );
      this.buildsBlocked = (await this.store.unfinishedBuilds()).length > 0;
      return { reconciled: true };
    } finally {
      release();
    }
  }
  /** 账号已禁用后走内部清理；不依赖被禁用账号再通过管理API授权。 */
  async suspendUser(userId: string) {
    for (const app of await this.store.list(userId)) {
      await this.store.status(app.id, "suspended");
      await this.observation?.store.revoke(app.id);
      const operations = await this.store.active(app.id);
      for (const operation of operations)
        this.aborts.get(operation.id)?.abort();
      await Promise.allSettled(
        operations.map((operation) => this.tasks.get(operation.id)),
      );
      const { operation } = await this.store.begin(
        userId,
        app.id,
        "archive",
        randomUUID(),
        "lifecycle",
        {},
      );
      try {
        for (const environment of ["preview", "production"] as const) {
          const endpoint = await this.store.endpoint(app.id, environment);
          await this.switchEndpoint(
            operation,
            environment,
            null,
            endpoint.generation,
          );
        }
        for (const deployment of await this.store.deployments(app.id)) {
          await this.driver.destroy(
            deployment.spec?.container ?? "ah-app-" + deployment.id,
          );
          await this.store.deploymentState(
            deployment.id,
            "stopped",
            undefined,
            "stopped",
          );
        }
        await this.store.progress(operation.id, "succeeded", "finished");
      } catch (error) {
        await this.store.progress(
          operation.id,
          "reconciling",
          "APPLICATION_SUSPEND_UNCONFIRMED",
          undefined,
          "APPLICATION_SUSPEND_UNCONFIRMED",
        );
        throw error;
      }
    }
  }
  /** 引擎端口、直连身份、代理身份依次确认后才提交ready；失败只污染自己的端点。 */
  private async recoverEndpoint(
    endpoint: Awaited<ReturnType<ApplicationStore["endpoints"]>>[number],
    timeout = 20000,
  ) {
    const environment = endpoint.environment as AppEnvironment;
    try {
      let spec: AppDeployment | null = null;
      if (endpoint.desiredDeploymentId) {
        const app = await this.store.byId(endpoint.appId);
        if (!app || app.status !== "active") fail(409, "APPLICATION_NOT_ACTIVE");
        await this.sessions.identity.require(app.ownerId);
        const target = await this.store.deployment(endpoint.desiredDeploymentId);
        if (!target?.spec) fail(503, "APPLICATION_ROUTE_TARGET_MISSING");
        if (target.appId !== endpoint.appId || target.environment !== environment ||
            target.spec.appId !== endpoint.appId || target.spec.environment !== environment)
          fail(503, "APPLICATION_DEPLOYMENT_UNCONFIRMED");
        spec = await this.driver.refresh(target.spec);
        await this.store.deploymentState(target.id, "starting", spec);
        await this.driver.healthy(spec, timeout);
        await this.store.deploymentState(target.id, "healthy", spec);
      }
      await this.options.edge.replaceEndpoint(endpoint.appId, environment, spec);
      await this.store.observed(endpoint.appId, environment, endpoint.generation, endpoint.desiredDeploymentId);
      if (spec) await this.driver.activate(spec);
      return spec;
    } catch (error) {
      // 失效旧端口可能已被别的容器复用；不把未知目标继续公开，也不删除其他应用的路由。
      await this.options.edge.replaceEndpoint(endpoint.appId, environment, null).catch(() => {});
      await this.store.uncertain(endpoint.appId, environment);
      throw error;
    }
  }
  /** 与发布切换共用锁，取锁后再读代际，防止周期核对覆盖正在发布的新意图。 */
  private async refreshEndpoints() {
    if (this.refreshingEndpoints || this.closing) return;
    this.refreshingEndpoints = true;
    const previous = this.edges;
    let release!: () => void;
    this.edges = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      await Promise.all((await this.store.endpoints()).map(async endpoint => {
        try { await this.recoverEndpoint(endpoint, 2000); }
        catch { /* recoverEndpoint已将失败限定在对应端点，其他应用继续确认。 */ }
      }));
    } finally {
      release();
      this.refreshingEndpoints = false;
    }
  }
  /** 初始化观测、核对持久化入口并把遗留操作标为待核对，再启动端口恢复和预览过期维护；不重放模型请求。 */
  async initialize() {
    if (this.options.observation) {
      const observation = new ObservationService(this, this.options.observation);
      try {
        await observation.initialize();
        this.observation = observation;
      } catch {
        await observation.close();
        console.error("OBSERVATION_UNAVAILABLE: application service remains active");
      }
    }
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await this.options.edge.actual();
    // 仅恢复已持久化的端点意图，不重放模型或构建；每个端点独立失败。
    await this.refreshEndpoints();
    this.buildsBlocked = (await this.store.unfinishedBuilds()).length > 0;
    // 旧模型/构建任务不自动重放；正式实例由单独资源标签核对，不能套用会话recover清理。
    for (const operation of await this.store.active()) {
      await this.store.progress(
        operation.id,
        "reconciling",
        operation.phase,
        undefined,
        "APPLICATION_RECOVERY_REQUIRED",
      );
    }
    for (const endpoint of await this.store.endpoints())
      if (endpoint.environment === "preview" && endpoint.appliedDeploymentId)
        this.previewLeases.set(endpoint.appId, Date.now());
    this.previewTimer = setInterval(() => {
      void this.refreshEndpoints().then(() => this.expirePreviews()).then(() => this.visitorAuth?.cleanupExpired()).catch(() =>
        console.error("Application preview expiry requires reconciliation"),
      );
    }, 60000);
    this.previewTimer.unref();
  }
  /** 登记暂停操作并撤下预览入口、清理对应实例；保留源码版本和预览数据以供后续重建。 */
  async pausePreview(
    userId: string,
    appId: string,
    requestId: string,
    expected: number,
  ) {
    await this.allowed(userId);
    const result = await this.store.begin(
      userId,
      appId,
      "pause_preview",
      requestId,
      "preview",
      { expectedGeneration: expected },
    );
    if (!result.duplicate)
      this.launch(result.operation, async () => {
        await this.switchEndpoint(result.operation, "preview", null, expected);
        return {};
      });
    return result;
  }
  /** 回收超过 30 分钟未访问且没有预览操作占位的实例；通过正常入口切换流程清理，不直接删除数据库。 */
  private async expirePreviews() {
    if (this.closing) return;
    for (const endpoint of await this.store.endpoints())
      if (
        endpoint.environment === "preview" &&
        endpoint.state === "ready" &&
        Date.now() - (this.previewLeases.get(endpoint.appId) ?? 0) > 30 * 60000
      ) {
        if ((await this.store.active(endpoint.appId, "preview")).length)
          continue;
        const app = await this.store.byId(endpoint.appId);
        if (!app || app.status !== "active") continue;
        const { operation } = await this.store.begin(
          app.ownerId,
          app.id,
          "pause_preview",
          randomUUID(),
          "preview",
          { expectedGeneration: endpoint.generation },
        );
        this.launch(operation, async () => {
          await this.switchEndpoint(
            operation,
            "preview",
            null,
            endpoint.generation,
          );
          return {};
        });
      }
  }
  /** 停止接收操作与周期维护，中止并等待本进程的异步工作及入口切换，最后关闭观测和数据连接池。 */
  async close() {
    this.closing = true;
    clearInterval(this.previewTimer);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled([...this.tasks.values()]);
    await this.edges;
    await this.observation?.close();
    await this.data.close();
  }
}
