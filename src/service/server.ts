import { WorkbenchAuth } from "./identity/workbench.js";
/** 长期服务入口。单独启动，生命周期不跟随某个CLI或浏览器连接。 */
import { mkdir, chmod, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { ConfiguredResidentProvider } from "../runtime/providers/configured-resident.js";
import { Controller } from "../runtime/controller.js";
import { lockSession } from "../runtime/storage.js";
import { ExpertService } from "./experts/service.js";
import { SkillService } from "./skills/service.js";
import { SkillBuilder } from "../docker/skill-builder.js";
import { SkillBuildManager } from "./skills/build-manager.js";
import { ServiceStore } from "./service-store.js";
import { SessionManager } from "./session-manager.js";
import { fail } from "./types.js";
import { WorkspaceFiles } from "./files/workspace-files.js";
import { Auth, tokenHash, validBootstrapAdminKey } from "./auth.js";
import { McpService } from "./mcp/service.js";
import { McpNetwork } from "./mcp/network.js";
import { loadLocalTemplates } from "./mcp/templates.js";
import { recoverLegacyWorkers } from "./mcp/legacy.js";
import { createApi } from "./http-api.js";
import { recover } from "./recovery.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  profileFromEnvironment,
  residentFromEnvironment,
  numberFromEnvironment,
  identityFromEnvironment,
} from "./config.js";
import { ApplicationService } from "./applications/service.js";
import { ApplicationStore } from "./applications/store.js";
import { applicationOptions } from "./applications/config.js";

import { LlmService } from "./llm/service.js";
import { resolveLlmSettings } from "./llm/client.js";
import { GatewayUsageSync } from "./llm/usage-sync.js";

import { startInferenceListener } from "./wallet/listener.js";
import { WalletService } from "./wallet/service.js";
import { TracingService } from "./tracing/service.js";

const root = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions");
const serviceDirectory = join(root, ".service");
await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
await chmod(serviceDirectory, 0o700);
const release = await lockSession(serviceDirectory);
let database: DatabaseHandle | undefined;

let applications: ApplicationService | undefined;
let tracing: TracingService | undefined;
try {
  const { settings: llmConfig, missing, allowLegacyGateway } = (() => {
    try {
      return resolveLlmSettings();
    } catch (error) {
      const detail = error instanceof Error && /^Invalid AH_[A-Z_]+$/.test(error.message)
        ? error.message : "Invalid managed gateway configuration";
      console.error("MODEL_GATEWAY_UNAVAILABLE: " + detail);
      return { settings: undefined, missing: [], allowLegacyGateway: false };
    }
  })();
  if (missing.length) console.error("MODEL_GATEWAY_CONFIGURATION_REQUIRED: " + missing.join(", "));
  const legacyToken = allowLegacyGateway ? process.env.AH_GATEWAY_TOKEN : undefined;
  const token = legacyToken === "replace-with-your-token" ? undefined : legacyToken;
  if (!llmConfig && !token) console.error("MODEL_GATEWAY_UNAVAILABLE: configure a model gateway to run tasks");
  const identity = identityFromEnvironment(process.env, !!llmConfig?.walletProxyUrl);
  for (const issue of identity.issues) console.error(issue);
  const auth = await Auth.load(
    join(serviceDirectory, "access-keys.json"),
  ).catch((error) => {
    if (error.code === "ENOENT") return new Auth([]);
    throw error;
  });
  const configuredKey = process.env.AH_BOOTSTRAP_ADMIN_KEY;
  delete process.env.AH_BOOTSTRAP_ADMIN_KEY;
  const [configuredAdmin] = identity.adminUsers;
  if (configuredKey !== undefined && !validBootstrapAdminKey(configuredKey))
    throw new Error("Invalid AH_BOOTSTRAP_ADMIN_KEY");
  if (configuredKey && identity.adminUsers.length !== 1)
    throw new Error("AH_BOOTSTRAP_ADMIN_KEY requires exactly one AH_ADMIN_USERS entry");
  if (!configuredKey && !auth.keys.length && !identity.oidc && !identity.workbench)
    throw new Error("No login credentials. For a new managed instance, set AH_BOOTSTRAP_ADMIN_KEY and run harbor init before starting.");
  // 表结构由受控迁移步骤建立；服务启动只连接，不自动建表或争抢执行迁移。
  database = openDatabase();
  let workbenchAuth: WorkbenchAuth | undefined;
  if (identity.workbench) {
    try {
      const candidate = new WorkbenchAuth(database.pool, identity.workbench);
      await candidate.checkStorage();
      workbenchAuth = candidate;
    } catch {
      console.error("WORKBENCH_AUTH_UNAVAILABLE: check control database migrations");
    }
  }
  if (!configuredKey && !auth.keys.length && !identity.oidc && !workbenchAuth)
    throw new Error("No login credentials: workbench authentication is unavailable");
  tracing = new TracingService(database.db);
  await tracing.initialize();
  if (tracing.config.state === "invalid") console.error("Langfuse configuration invalid: " + tracing.config.issues.join(","));
  tracing.start();
  const wallet = new WalletService(database.db);
  await wallet.recover();
  await wallet.tick();
  const walletTimer = setInterval(() => { void wallet.tick().catch(() => console.error("Wallet monthly grants require retry")); }, 60_000);
  walletTimer.unref();
  const store = new ServiceStore(database.db);
  const resident = residentFromEnvironment();
  const controller = new Controller(root, profileFromEnvironment(), engine => new ConfiguredResidentProvider(engine, resident));
  const manager = new SessionManager(
    store,
    controller,
    token ?? "",
    numberFromEnvironment("AH_IDLE_TIMEOUT_MS", 15 * 60_000),
    numberFromEnvironment("AH_CAPACITY", 4),
  );
  // 旧V3-V5会话的所有者先补身份记录，再导入开发密钥，避免密钥归属到不存在的用户。
  await manager.identity.adoptSessionOwners();
  await manager.identity.pruneLogins();
  await manager.identity.importKeys(auth.keys);
  if (configuredKey && configuredAdmin) {
    // Retire only the key written by the old managed initializer, leaving other keys alone.
    const firstKey = await readFile(join(root, "..", "first-admin.key"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const legacyHash = tokenHash(firstKey.trim());
    const legacy = auth.keys.find(key => key.userId === configuredAdmin && key.tokenHash === legacyHash);
    await manager.identity.configureAdminKey(configuredAdmin, tokenHash(configuredKey), legacy?.tokenHash);
  }
  manager.recoveryFailed = !(await recover(store, controller));
  const files = new WorkspaceFiles(root);
  if (!(await files.initialize()))
    console.error("Workspace file access unavailable");
  const library = new SkillService(database.db, root);
  const builds = new SkillBuildManager(library, new SkillBuilder(root, undefined, resident ? controller.resident : undefined));
  await builds.initialize();
  await new ExpertService(library, builds).initialize();
  const templates = await loadLocalTemplates(process.env.AH_MCP_TEMPLATES_FILE);
  const connections = new McpService(
    database.db,
    serviceDirectory,
    new McpNetwork(
      (process.env.AH_MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    templates,
  );
  // Root lock is already held. Confirm legacy Workers stopped before enabling the new native path.
  await recoverLegacyWorkers(serviceDirectory);
  await connections.migrateLegacy();
  let applicationsUnavailable: string | undefined;
  const appOptions = await applicationOptions(root, (feature, reason) => {
    if (feature === "applications") applicationsUnavailable = reason;
    console.error(feature + ": " + reason);
  });
  const appStore = new ApplicationStore(database.db);
  if (appOptions) {
    const { onUserClose } = manager;
    let candidate: ApplicationService | undefined;
    try {
      candidate = new ApplicationService(appStore, manager, controller, appOptions);
      await candidate.data.checkReady();
      await candidate.initialize();
      applications = candidate;
    } catch {
      await candidate?.close().catch(() => console.error("Application cleanup requires attention"));
      manager.onUserClose = onUserClose;
      applicationsUnavailable = "Check the application database and Caddy connectivity.";
      console.error("APPLICATIONS_UNAVAILABLE: " + applicationsUnavailable);
    }
  }
  if (!applications) {
    // Disabled applications must not allow editing their development sessions as ordinary chat.
    manager.applicationWriteGuard = async (sessionId) => {
      if (await appStore.forSession(sessionId)) fail(503, "APPLICATIONS_UNAVAILABLE");
    };
  }
  let llm: LlmService | undefined;
  if (llmConfig) {
    try {
      const candidate = new LlmService(database.db, serviceDirectory, llmConfig);
      await candidate.recover();
      await candidate.applyBaseline();
      llm = candidate;
    } catch {
      console.error("MODEL_GATEWAY_UNAVAILABLE: check the managed gateway and control database");
    }
  }
  let inferenceServer: Awaited<ReturnType<typeof startInferenceListener>> | undefined;
  if (process.env.AH_INFERENCE_BIND_HOST && llm?.settings.walletProxyUrl) {
    try {
      inferenceServer = await startInferenceListener(process.env.AH_INFERENCE_BIND_HOST,
        numberFromEnvironment("AH_INFERENCE_PORT", 4317), llm, wallet, tracing);
    } catch {
      console.error("MODEL_GATEWAY_UNAVAILABLE: check the wallet bridge address and port");
      llm = undefined;
    }
  }
  if (!llm && workbenchAuth?.settings.registration) workbenchAuth.settings.registration = false;
  if (!llm && !token) manager.modelSelection = async () => fail(503, "MODEL_GATEWAY_UNAVAILABLE");
  const gatewaySync = llm?.settings.policy ? new GatewayUsageSync(llm) : undefined;
  let syncDone: Promise<void> = Promise.resolve();
  let syncRunning = false;
  const syncUsage = () => {
    if (!gatewaySync || syncRunning) return;
    syncRunning = true;
    syncDone = gatewaySync.run().catch(() => console.error("Gateway usage sync requires retry"))
      .finally(() => { syncRunning = false; });
  };
  if (gatewaySync) syncUsage();
  const gatewaySyncTimer = gatewaySync ? setInterval(syncUsage, 5_000) : undefined;
  gatewaySyncTimer?.unref();
  const server = createApi(
    manager,
    controller,
    files,
    { ...identity, workbenchAuth },
    { library, builds },
    connections,
    applications,
    llm,
    tracing,
    applicationsUnavailable,
  );
  server.listen(numberFromEnvironment("AH_SERVICE_PORT", 4318, 0), "127.0.0.1");
  await once(server, "listening");
  console.log(
    `Agent Harbor: http://127.0.0.1:${(server.address() as { port: number }).port} (${manager.ready ? "ready" : "recovery required"})`,
  );
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 目标30秒；超时退出不宣称停止成功。Keeper随后兜底，下次启动仍查询Docker。
    const deadline = setTimeout(() => {
      console.error("Shutdown deadline exceeded; cleanup remains unconfirmed");
      process.exit(1);
    }, 30_000);
    try {
      clearInterval(walletTimer);
      clearInterval(gatewaySyncTimer);
      await syncDone;
      manager.stopping = true;
      await files.close();
      await manager.shutdown();
      await applications?.close();
      await builds.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      inferenceServer?.closeAllConnections();
      if (inferenceServer) await new Promise<void>(resolve => inferenceServer!.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tracing?.close();
      await database!.close();
      await release();
      clearTimeout(deadline);
    }
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
} catch (error) {
  await tracing?.close();
  await applications?.close();

  await database?.close();
  await release();
  throw error;
}
