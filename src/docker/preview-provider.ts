import type { EnvironmentRef } from "../runtime/providers/contracts.js";
import type { PreviewLaunch, PreviewProvider } from "../runtime/providers/preview.js";
import type { AppDockerDriver } from "../service/applications/docker.js";
import { requireAppId } from "../service/applications/source-store.js";

export class DockerPreviewProvider implements PreviewProvider {
  readonly backendId = "docker-preview";

  constructor(private readonly docker: AppDockerDriver, private readonly network: string) {}

  private id(ref: EnvironmentRef) {
    if (ref.backendId !== this.backendId) throw new Error("Wrong preview backend");
    return ref.resourceId;
  }

  private async owned(ref: EnvironmentRef) {
    const id = this.id(ref);
    const state = await this.docker.inspect(id);
    if (state && (state.Config.Labels["harbor.app.environment"] !== "preview" ||
        "ah-app-" + state.Config.Labels["harbor.app.deployment"] !== id))
      throw new Error("Not an owned preview deployment");
    return state;
  }

  async findOwned(deploymentId: string) {
    requireAppId(deploymentId);
    const ref = { backendId: this.backendId, resourceId: "ah-app-" + deploymentId };
    return await this.owned(ref) ? [ref] : [];
  }

  async create({ build, deploymentId, databaseUrl }: PreviewLaunch) {
    if (build.target !== "preview") throw new Error("Preview build required");
    const deployment = await this.docker.create(build, deploymentId, databaseUrl);
    // AppDockerDriver creates in the default network. Place this pilot in a private
    // network before starting any untrusted process, including on a repeated create.
    const ref = { backendId: this.backendId, resourceId: deployment.container };
    const state = await this.owned(ref);
    if (!state || state.State.Running) throw new Error("Preview create requires a stopped candidate");
    const networks = state.NetworkSettings.Networks;
    if (Object.keys(networks).some(name => name !== "bridge" && name !== this.network))
      throw new Error("Unexpected network on Docker preview candidate");
    if (!Object.hasOwn(networks, this.network))
      await this.docker.command(["network", "connect", this.network, deployment.container]);
    if (Object.hasOwn(networks, "bridge"))
      await this.docker.command(["network", "disconnect", "bridge", deployment.container]);
    const ready = await this.owned(ref);
    if (Object.keys(ready?.NetworkSettings.Networks ?? {}).join() !== this.network)
      throw new Error("Private preview network not confirmed");
    await this.docker.start(deployment);
    return ref;
  }

  async inspect(ref: EnvironmentRef) {
    const state = await this.owned(ref);
    return !state ? "absent" : state.State.Running ? "running" : "stopped";
  }

  async stopAndConfirm(ref: EnvironmentRef) {
    if (await this.owned(ref)) await this.docker.stop(this.id(ref));
  }

  async remove(ref: EnvironmentRef) {
    if (await this.inspect(ref) === "running") throw new Error("Preview is still running");
    if (await this.owned(ref)) await this.docker.destroy(this.id(ref));
  }

  async resolvePrivateEndpoint(ref: EnvironmentRef) {
    const state = await this.owned(ref);
    const ports = state?.NetworkSettings.Ports?.["3000/tcp"];
    if (!state?.State.Running || Object.keys(state.NetworkSettings.Networks).join() !== this.network ||
        ports?.length !== 1 || ports[0].HostIp !== "127.0.0.1" ||
        !/^[0-9]{1,5}$/.test(ports[0].HostPort))
      throw new Error("Invalid Docker preview endpoint");
    return { url: new URL("http://127.0.0.1:" + ports[0].HostPort) };
  }
}
