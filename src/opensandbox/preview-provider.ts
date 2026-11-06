import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDockerDriver } from "../service/applications/docker.js";
import { requireAppId } from "../service/applications/source-store.js";
import type { EnvironmentRef } from "../runtime/providers/contracts.js";
import { applicationRuntimeAccess, applicationRuntimeHeader, type PreviewLaunch, type PreviewProvider } from "../runtime/providers/preview.js";

const sandboxLabel = "opensandbox.io/id";
const ownerLabel = "harbor.preview.owner";
const intentLabel = "harbor.preview.deployment";

/** OpenSandbox 1.2 on the isolated Docker runtime. SDK access stays in the composition root. */
export interface OpenSandboxPreviewClient {
  create(options: {
    image: string;
    configPath: string;
    metadata: Record<string, string>;
  }): Promise<string>;
  kill(id: string): Promise<void>;
  endpoint(id: string, port: number): Promise<URL>;
}

export const strictApplicationBackend = "opensandbox-app";
export const pilotApplicationBackend = "opensandbox-preview";

export class OpenSandboxPreviewProvider implements PreviewProvider {
  get backendId() {
    return this.accessKey ? strictApplicationBackend : pilotApplicationBackend;
  }

  constructor(
    private readonly client: OpenSandboxPreviewClient,
    private readonly docker: AppDockerDriver,
    private readonly configDirectory: string,
    private readonly managementOrigin: URL,
    private readonly accessKey?: string,
  ) {
    if (managementOrigin.protocol !== "http:" || managementOrigin.hostname !== "127.0.0.1" ||
        managementOrigin.username || managementOrigin.password || managementOrigin.href !== managementOrigin.origin + "/")
      throw new Error("OpenSandbox preview requires a loopback management endpoint");
  }

  private id(ref: EnvironmentRef) {
    if (ref.backendId !== this.backendId) throw new Error("Wrong preview backend");
    requireAppId(ref.resourceId);
    return ref.resourceId;
  }

  private async containers(label: string) {
    const rows = await this.docker.command(["ps", "-a", "--filter", "label=" + label,
      "--filter", "label=" + sandboxLabel, "--format", "{{json .}}"]);
    return rows ? rows.split("\n").map(row => JSON.parse(row) as {
      ID: string; Labels: string; State: string;
    }) : [];
  }

  /** Inventory sees allocated containers. An empty result cannot resolve an in-flight create. */
  async findOwned(deploymentId: string) {
    requireAppId(deploymentId);
    const containers = await this.containers(intentLabel + "=" + deploymentId);
    return containers.filter(row => row.Labels.split(",").includes(ownerLabel + "=" + this.docker.owner))
      .map(row => {
        const resourceId = row.Labels.split(",").find(label => label.startsWith(sandboxLabel + "="))!
          .slice(sandboxLabel.length + 1);
        requireAppId(resourceId);
        return { backendId: this.backendId, resourceId };
      });
  }

  async create({ build, deploymentId, databaseUrl, visitorAuth, observation }: PreviewLaunch) {
    requireAppId(build.appId);
    requireAppId(deploymentId);
    if ((!this.accessKey && build.target !== "preview") || !["preview", "production"].includes(build.target) ||
        build.basePath !== `/${build.target === "preview" ? "preview" : "apps"}/${build.appId}/` ||
        !/^sha256:[a-f0-9]{64}$/.test(build.imageId)) throw new Error("Invalid preview build");
    if ((await this.findOwned(deploymentId)).length) throw new Error("Preview already exists");
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    const configPath = join(this.configDirectory, deploymentId + ".json");
    // The private file contains only this app's database credential and deployment identity.
    await writeFile(configPath, JSON.stringify({
      appId: build.appId, revisionId: build.revisionId, buildId: build.id,
      deploymentId, basePath: build.basePath, databaseUrl,
      ...(this.accessKey ? { runtimeAccess: applicationRuntimeAccess(this.accessKey, deploymentId) } : {}),
      ...(visitorAuth ? { visitorAuth, environment: build.target } : {}),
      ...(observation ? { observation } : {}),
    }), { flag: "wx", mode: 0o444 });
    const resourceId = await this.client.create({
      image: build.imageId, configPath,
      metadata: { [ownerLabel]: this.docker.owner, [intentLabel]: deploymentId },
    });
    const ref = { backendId: this.backendId, resourceId };
    for (let tries = 0; tries < 80; tries++) {
      if (await this.inspect(ref) === "running") return ref;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("Sandbox start unconfirmed");
  }

  async inspect(ref: EnvironmentRef) {
    const rows = await this.containers(sandboxLabel + "=" + this.id(ref));
    if (!rows.length) return "absent";
    if (rows.length !== 1 || !rows[0].Labels.split(",").includes(ownerLabel + "=" + this.docker.owner))
      throw new Error("Sandbox ownership unconfirmed");
    const { State } = rows[0];
    if (State === "running") return "running";
    if (["created", "exited", "dead"].includes(State)) return "stopped";
    throw new Error("Sandbox runtime state unconfirmed");
  }

  async stopAndConfirm(ref: EnvironmentRef) {
    if (await this.inspect(ref) === "absent") return;
    await this.client.kill(this.id(ref));
    // SDK deletion acceptance is not proof. Query the independent engine until the writer is gone.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.inspect(ref) === "absent") return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("Sandbox deletion unconfirmed");
  }

  async remove(ref: EnvironmentRef) {
    if (await this.inspect(ref) !== "absent") throw new Error("Sandbox deletion unconfirmed");
    if (!this.accessKey) return;
    const id = this.id(ref);
    const name = "harbor-os-app-" + id;
    const absent = (error: unknown) =>
      /network .* not found/i.test(String((error as { stderr?: string }).stderr));
    let network;
    try {
      [network] = JSON.parse(await this.docker.command(["network", "inspect", name]));
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    if (network?.Labels?.["harbor.os.app-network"] !== id ||
        network.Labels["harbor.os.app-network-owner"] !== this.docker.owner)
      throw new Error("Application network ownership unconfirmed");
    await this.docker.command(["network", "rm", network.Id]).catch(error => {
      if (!absent(error)) throw error;
    });
  }

  /** Check engine state, because a correct proxy URL says nothing about raw host port exposure. */
  private async requirePrivateRuntime(ref: EnvironmentRef) {
    const rows = await this.containers(sandboxLabel + "=" + this.id(ref));
    if (rows.length !== 1 || !rows[0].Labels.split(",").includes(ownerLabel + "=" + this.docker.owner))
      throw new Error("Sandbox ownership unconfirmed");
    const [container] = JSON.parse(await this.docker.command(["inspect", rows[0].ID]));
    const host = container?.HostConfig;
    const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
    const bindings = Object.values(container?.NetworkSettings?.Ports ?? {}).flat() as
      ({ HostIp: string } | null)[];
    if (container?.State?.Running !== true || networks.length !== 1 ||
        ["host", "bridge", "none"].includes(networks[0]) || host.NetworkMode !== networks[0] ||
        bindings.length === 0 || bindings.some(binding => binding?.HostIp !== "127.0.0.1") ||
        host.Privileged !== false || !host.CapDrop?.includes("ALL") ||
        !host.SecurityOpt?.some((item: string) => item.startsWith("no-new-privileges")) ||
        container.Config?.User !== "node" ||
        (this.accessKey && (host.ReadonlyRootfs !== true || container.Config.Labels["harbor.os.app-profile"] !== "strict-v1" ||
          networks[0] !== "harbor-os-app-" + ref.resourceId)))
      throw new Error("OpenSandbox preview network or security profile is not private");
    return requireAppId(container.Config.Labels[intentLabel]);
  }

  async resolvePrivateEndpoint(ref: EnvironmentRef) {
    const deploymentId = await this.requirePrivateRuntime(ref);
    const id = this.id(ref);
    const url = await this.client.endpoint(id, 3000);
    if (url.origin !== this.managementOrigin.origin ||
        url.pathname.replace(/\/$/, "") !== `/v1/sandboxes/${id}/proxy/3000` ||
        url.username || url.password || url.search || url.hash)
      throw new Error("Unexpected sandbox preview endpoint");
    return { url, ...(this.accessKey ? {
      headers: { [applicationRuntimeHeader]: applicationRuntimeAccess(this.accessKey, deploymentId) },
    } : {}) };
  }
}
