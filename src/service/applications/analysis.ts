import { ApplicationAnalysisRecords, analysisTableGrants } from "./analysis-records.js";
import type { ApplicationService } from "./service.js";
import type { GatewayConnection } from "../../shared/llm.js";
import { runAnalysis } from "../../runtime/app-analysis.js";
import { lockSession } from "../../runtime/storage.js";
import { fail, type Message, type ServiceSession } from "../types.js";
import { sql } from "drizzle-orm";
import { modelReport, openSnapshot, reportParameters, snapshotReport, type AnalysisEnvironment } from "../observability/report-snapshots.js";

export class ApplicationAnalysis {
  private readonly tableGrants = analysisTableGrants(process.env.AH_APP_ANALYSIS_TABLE_FIELDS);

  constructor(readonly apps: ApplicationService, readonly infer: (path: string, body: string,
    headers: Record<string, string>, token: string, signal: AbortSignal) => Promise<Response>) {
    apps.sessions.analysisScope = (owner, id) => this.scope(owner, id).then(() => {});
    apps.sessions.analysisRun = (session, message, gateway, signal) => this.run(session, message, gateway, signal);
  }

  async scope(owner: string, appId: string) {
    await this.apps.sessions.identity.require(owner);
    const app = await this.apps.store.owned(owner, appId);
    if (app.status !== "active") fail(409, "APPLICATION_NOT_ACTIVE");
    const observation = this.apps.observation;
    if (!observation) fail(503, "APPLICATION_ANALYSIS_UNAVAILABLE");
    if (!(await observation.store.pool.query("SELECT version FROM observation_migrations WHERE version=2")).rowCount)
      fail(503, "APPLICATION_ANALYSIS_MIGRATION_REQUIRED");
    return observation;
  }

  async session(owner: string, appId: string, environment: AnalysisEnvironment) {
    await this.scope(owner, appId);
    return (await this.apps.sessions.store.analysisSessions(appId)).find(
      session => session.ownerId === owner && session.analysisEnvironment === environment);
  }

  async send(owner: string, appId: string, environment: AnalysisEnvironment, clientId: string, text: string, model?: string) {
    const session = await this.apps.sessions.analysisSession(owner, appId, environment);
    return this.apps.sessions.submit(owner, session.id, clientId, text, model, true);
  }

  async report(owner: string, appId: string, id: string) {
    const observation = await this.scope(owner, appId);
    return openSnapshot(observation, appId, id);
  }

  private async run(session: ServiceSession, message: Message, gateway: GatewayConnection, signal: AbortSignal) {
    const { id, ownerId, analysisAppId: appId, analysisEnvironment: env } = session;
    if (!appId || !env) fail(404, "APPLICATION_NOT_FOUND");
    const observation = await this.scope(ownerId, appId);
    const store = this.apps.sessions.store;
    const controller = this.apps.controller;
    const directory = await controller.store.prepare(id);
    const unlock = await lockSession(directory);
    try {
      const history = await store.recentAnalysisHistory(id);
      const context = [];
      let bytes = 0;
      for (const turn of history.reverse()) {
        const response = (await store.analysisAnswer(id, turn.id)).slice(0, 1800);
        const pair = { question: turn.text.slice(0, 500), answer: response };
        bytes += Buffer.byteLength(JSON.stringify(pair));
        if (bytes > 8192) break;
        context.unshift(pair);
      }
      const active = async () => {
        signal.throwIfAborted();
        await this.scope(ownerId, appId);
        const current = await store.message(message.id);
        if (!current || current.sessionId !== id || current.status !== "running" || current.cancelRequested)
          fail(409, "APPLICATION_ANALYSIS_STOPPED");
      };
      const records = new ApplicationAnalysisRecords(this.apps, observation.store.pool, ownerId, appId, env, this.tableGrants);
      await runAnalysis(controller.backend, {
        sessionId: id, messageId: message.id, image: controller.profile.image, model: gateway.model,
        prompt: JSON.stringify({ environment: env, previousAnswersMayBeStale: context, question: message.text }),
        signal,
        tool: async (name, args, roundSignal) => {
          const timeout = AbortSignal.any([roundSignal, AbortSignal.timeout(5000)]);
          await active();
          if (name !== "read_report") {
            const result = name === "list_datasets" ? await records.catalog(args) : await records.read(args);
            await active();
            timeout.throwIfAborted();
            return result;
          }
          const { days, section } = reportParameters(args);
          const snapshot = await snapshotReport(observation, ownerId, appId, env, message.id, days, timeout);
          await active();
          timeout.throwIfAborted();
          if (!snapshot) return { status: "not_instrumented", environment: env, days };
          await store.event(id, message.id, "analysis.report", { reportId: snapshot.id, section, days, environment: env },
            `analysis:${message.id}:${snapshot.id}:${section}`);
          return modelReport(snapshot, section);
        },
        infer: async (path, body, headers, timeout) => {
          await active();
          return this.infer(path, body, headers, gateway.token, timeout);
        },
        text: async (text) => {
          signal.throwIfAborted();
          await store.event(id, message.id, "assistant.text.delta", { text });
        },
        receipt: async (requestId) => {
          await store.db.execute(sql`UPDATE wallet_requests SET "messageId"=${message.id}
            WHERE id=${requestId} AND "sessionId"=${id} AND ("messageId" IS NULL OR "messageId"=${message.id})`);
        },
      });
    } finally {
      await unlock();
    }
  }
}
