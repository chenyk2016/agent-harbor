/**
 * Express 5应用装配入口。业务路由各自放在模块的http.ts，不在这里逐项拆pathname。
 * 顺序是安全契约：公开健康检查 → Origin → 登录入口 → 认证/CSRF → 业务Router → 错误边界。
 */
import express, { Router } from "express";
import { createServer } from "node:http";
import type { SessionManager } from "./session-manager.js";
import type { Controller } from "../runtime/controller.js";
import { fail } from "./types.js";
import { requireBrowserOrigin } from "./browser-sessions.js";
import { WorkspaceFiles } from "./files/workspace-files.js";
import { IdentityHttp, type IdentityOptions } from "./identity/http.js";
import { createSkillRouter, type SkillModule } from "./skills/http.js";
import { ExpertService } from "./experts/service.js";
import { createExpertRouter } from "./experts/http.js";
import type { McpService } from "./mcp/service.js";
import { createMcpRouter } from "./mcp/http.js";
import { createSessionRouter } from "./sessions/http.js";
import { createWebRouter } from "./web-assets.js";
import { apiErrors, notFound } from "./http/shared.js";
import { ApplicationAnalysis } from "./applications/analysis.js";
import type { ApplicationService } from "./applications/service.js";
import { createVisitorManagementRouter, createVisitorRouter } from "./applications/visitor-auth/http.js";
import { visitorPath } from "./applications/visitor-auth/config.js";
import { createApplicationRouter } from "./applications/http.js";

import { createLlmRouter } from "./llm/http.js";
import type { LlmService } from "./llm/service.js";

import { WalletService } from "./wallet/service.js";
import { createWalletRouter } from "./wallet/http.js";
import { createInferenceRouter } from "./wallet/proxy.js";
import { AdminOperations } from "./admin/service.js";
import type { TracingService } from "./tracing/service.js";
import { adminGuard, adminAuditMiddleware, adminJson, createAdminRouter } from "./admin/http.js";

export function createApi(
  manager: SessionManager,
  controller: Pick<Controller, "store">,
  files = new WorkspaceFiles(controller.store.root),
  identityOptions: IdentityOptions = {},
  skillModule?: SkillModule,
  mcp?: McpService,
  applications?: ApplicationService,
  llm?: LlmService,
  tracing?: TracingService,
  applicationsUnavailable?: string,
) {
  manager.tracing = tracing;
  const wallet = new WalletService(manager.store.db);
  const walletEnabled = !!llm?.settings.walletProxyUrl;
  const operations = new AdminOperations(manager.store.db, manager, files, llm, tracing);
  const experts = skillModule
    ? new ExpertService(skillModule.library, skillModule.builds)
    : undefined;
  if (experts || mcp)
    manager.runtimeConnections = async (session) => {
      const configured = mcp
        ? await mcp.runtime(session.ownerId)
        : { mcpServers: {} };
      if (!session.expertSnapshot?.workbuddy || !experts) return configured;
      const { version } = await experts.version(
        session.ownerId,
        session.expertSnapshot.versionId,
      );
      const legacy = await experts.runtimeConnections(
        session.ownerId,
        session.expertSnapshot.versionId,
      );
      // Package commands are not trusted launchers. Only approved remote connections are carried over.
      for (const config of Object.values(
        legacy,
      ) as import("@anthropic-ai/claude-agent-sdk").McpServerConfig[]) {
        if (config.type !== "http")
          fail(409, "MCP_EXPERT_TRANSPORT_UNSUPPORTED");
        if (!mcp) fail(503, "MCP_UNAVAILABLE");
        mcp.validateRemote(config.url);
      }
      return {
        ...configured,
        mcpServers: { ...configured.mcpServers, ...legacy },
        networkDomains: await experts.connections.network(
          session.ownerId,
          version.definition.workbuddy!,
        ),
      };
    };

  if (llm) {
    manager.modelSelection = async (user, id, setupTest) => {
      if (walletEnabled) {
        const balance = await wallet.summary(user);
        if (!llm.settings.policy && balance.reserved > 0) fail(429, "WALLET_BUSY");
        if (balance.available <= 0) fail(402, "INSUFFICIENT_BALANCE");
      }
      return llm.select(user, id, setupTest);
    };
    manager.modelConnection = (session) => llm.runtime(session);
    const closeEnvironment = manager.onEnvironmentClose;
    manager.onEnvironmentClose = async (id) => {
      const results = await Promise.allSettled([
        closeEnvironment?.(id),
        llm.revokeSession(id),
      ]);
      if (results.some((r) => r.status === "rejected"))
        fail(503, "MODEL_REVOKE_UNCONFIRMED");
    };
    const closeUser = manager.onUserClose;
    manager.onUserClose = async (user) => {
      const results = await Promise.allSettled([
        closeUser?.(user),
        llm.revokeUser(user),
      ]);
      if (results.some((r) => r.status === "rejected"))
        fail(503, "MODEL_REVOKE_UNCONFIRMED");
    };
  }
  const visitor = applications?.visitorAuth?.options;
  const identity = new IdentityHttp(manager, files, {
    ...identityOptions, workbenchOrigin: visitor?.workbenchOrigin,
  });
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("case sensitive routing", true);
  if (llm && walletEnabled) app.use("/inference", createInferenceRouter(llm, wallet, tracing));
  if (applications?.visitorAuth) app.use(visitorPath, createVisitorRouter(applications.visitorAuth));
  const api = Router({ caseSensitive: true });
  api.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  // 不意外启用Express的GET→HEAD兜底；只有静态页面明确支持HEAD。
  api.use((request, _response, next) => {
    if (request.method === "HEAD") fail(404, "NOT_FOUND");
    next();
  });
  api.get("/health", (_request, response) => {
    response.json({ alive: true, ready: manager.ready });
  });
  api.use((request, _response, next) => {
    // 使用固定部署origin，不信任反向代理转发头。健康检查不受此限制。
    if (
      request.headers.origin &&
      request.headers.origin !== identity.origin(request)
    )
      fail(403, "ORIGIN_DENIED");
    next();
  });
  api.use(identity.publicRouter());
  api.use(async (request, response, next) => {
    const principal = await identity.principal(request);
    if (
      !request.headers.authorization &&
      request.headers["x-harbor-user"] &&
      request.headers["x-harbor-user"] !== principal.userId
    )
      fail(401, "LOGIN_CHANGED");
    if (
      !request.headers.authorization &&
      !["GET", "HEAD"].includes(request.method)
    )
      requireBrowserOrigin(request, identity.origin(request));
    // 下面所有Router读取同一份已认证身份和撤销signal，不接受客户端指定userId。
    response.locals.principal = principal;
    next();
  });
  api.use("/admin", adminGuard(identityOptions.adminUsers ?? []), adminJson, adminAuditMiddleware(operations));
  api.use(createAdminRouter(operations, identityOptions.adminUsers ?? []));
  api.use(identity.accountRouter());
  api.use(createWalletRouter(wallet, identityOptions.adminUsers ?? [], walletEnabled, llm?.settings.policy ? "estimated" : "full"));
  api.use(
    createLlmRouter(llm, identityOptions.adminUsers, (user, id) =>
      manager.owned(user, id),
    ),
  );
  if (applications) {
    api.use(createApplicationRouter(applications));
    api.use(createVisitorManagementRouter(applications));
  } else {
    api.get("/applications/config", (_request, response) =>
      response.json({ enabled: false, canCreate: false, reason: applicationsUnavailable }),
    );
  }
  if (mcp) api.use(createMcpRouter(mcp));
  if (skillModule) api.use(createSkillRouter(skillModule));
  if (experts)
    api.use(
      createExpertRouter(
        experts,
        (request) => identity.origin(request),
        (user) => manager.disconnectExpertConnections(user),
      ),
    );
  api.use(
    createSessionRouter(manager, controller, files, skillModule, experts, mcp, applications, llm),
  );
  api.use(notFound);
  app.use("/api", api);
  // 页面回退只注册已知页面/构建资源，未知API和私有文件不会被当作SPA页面。
  app.use(createWebRouter(visitor));
  app.use(notFound);
  app.use(apiErrors(() => manager.storageUnavailable));

  // 保持原Server返回值，启动、SSE和关机代码不需要更换生命周期所有者。
  const server = createServer(app);
  if (applications && !["0", "false"].includes(process.env.AH_APP_ANALYSIS_ENABLED ?? "")) {
    if (!applications.observation || !walletEnabled) {
      console.error("APPLICATION_ANALYSIS_UNAVAILABLE: requires application observations and the managed wallet gateway");
    } else {
      try {
        applications.analysis = new ApplicationAnalysis(applications, (path, body, headers, token, signal) => {
          const address = server.address();
          if (!address || typeof address === "string") fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
          return fetch(`http://127.0.0.1:${address.port}/inference${path}`, {
            method: "POST", body, headers: { ...headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
            signal, redirect: "error",
          });
        });
      } catch {
        console.error("APPLICATION_ANALYSIS_UNAVAILABLE: check AH_APP_ANALYSIS_TABLE_FIELDS");
      }
    }
  }
  server.once("listening", () => operations.start());
  server.once("close", () => {
    operations.stop();
    identity.close();
    void files.close();
  });
  return server;
}
