import { randomBytes } from "node:crypto";
import type { ApplicationService } from "./service.js";
import { fail } from "../types.js";

const cookieSeconds = 600;
export const ownerPreviewCookie = "__Host-harbor-preview";
export const ownerPreviewSeconds = cookieSeconds;

interface Grant {
  userId: string;
  appId: string;
  deploymentId: string;
  expires: number;
  signal: AbortSignal;
}

export class PreviewAccess {
  private tickets = new Map<string, Grant>();
  private cookies = new Map<string, Grant>();

  constructor(private readonly apps: ApplicationService) {}

  private retain(map: Map<string, Grant>, grant: Grant) {
    const now = Date.now();
    for (const [token, entry] of map) if (entry.expires <= now || entry.signal.aborted) map.delete(token);
    if (map.size >= 4000) fail(503, "APPLICATION_PREVIEW_ACCESS_BUSY");
    const token = randomBytes(32).toString("base64url");
    map.set(token, grant);
    return token;
  }

  private async current(appId: string, deploymentId: string) {
    const app = await this.apps.store.byId(appId);
    const endpoint = await this.apps.store.endpoint(appId, "preview");
    const deployment = await this.apps.store.deployment(deploymentId);
    if (app?.status !== "active" || endpoint.appliedDeploymentId !== deploymentId ||
        endpoint.desiredDeploymentId !== deploymentId ||
        !["ready", "switching"].includes(endpoint.state) ||
        deployment?.appId !== appId || deployment.environment !== "preview" ||
        !deployment.spec?.ownerOnly || !deployment.spec.visitorAuth?.previewParentOrigin)
      fail(404, "APPLICATION_PREVIEW_UNAVAILABLE");
    return { app, auth: deployment.spec.visitorAuth };
  }

  async issue(userId: string, signal: AbortSignal, appId: string, deploymentId: string) {
    await this.apps.store.owned(userId, appId);
    const { auth } = await this.current(appId, deploymentId);
    const ticket = this.retain(this.tickets, { userId, signal, appId, deploymentId, expires: Date.now() + 60_000 });
    return { ticket, exchangeUrl: auth.origin + `/preview/${appId}/__harbor/preview-access` };
  }

  async exchange(appId: string, deploymentId: string, host: string, origin: string | undefined, ticket: string) {
    const { app, auth } = await this.current(appId, deploymentId);
    if (host !== new URL(auth.origin).host || origin !== auth.previewParentOrigin)
      fail(403, "ORIGIN_DENIED");
    const grant = this.tickets.get(ticket);
    if (!grant || grant.appId !== appId || grant.deploymentId !== deploymentId ||
        grant.userId !== app.ownerId || grant.signal.aborted || grant.expires <= Date.now())
      fail(401, "APPLICATION_PREVIEW_ACCESS_REQUIRED");
    this.tickets.delete(ticket);
    await this.apps.sessions.identity.require(grant.userId);
    return this.retain(this.cookies, { ...grant, expires: Date.now() + cookieSeconds * 1000 });
  }

  async authorize(appId: string, deploymentId: string, host: string, token: string | undefined, websocketOrigin?: string) {
    const { app, auth } = await this.current(appId, deploymentId);
    if (host !== new URL(auth.origin).host) fail(404, "APPLICATION_PREVIEW_UNAVAILABLE");
    if (websocketOrigin !== undefined && websocketOrigin !== auth.origin) fail(403, "ORIGIN_DENIED");
    const grant = token && this.cookies.get(token);
    if (!grant || grant.appId !== appId || grant.deploymentId !== deploymentId ||
        grant.userId !== app.ownerId || grant.signal.aborted || grant.expires <= Date.now())
      fail(401, "APPLICATION_PREVIEW_ACCESS_REQUIRED");
    await this.apps.sessions.identity.require(grant.userId);
  }
}
