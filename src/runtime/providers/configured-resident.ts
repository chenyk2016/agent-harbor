import type { DockerBackend } from "../../docker/docker.js";
import { DockerResidentProvider } from "../../docker/resident-provider.js";
import { OpenSandboxResidentProvider, type OpenSandboxRunnerSettings } from "../../opensandbox/resident-provider.js";
import type { EnvironmentRef } from "./contracts.js";
import type { ResidentLaunch, ResidentProvider } from "./resident.js";

/** New environments use the selected provider. Old environments keep their original lifecycle. */
export class ConfiguredResidentProvider implements ResidentProvider {
  private readonly docker: DockerResidentProvider;
  private readonly openSandbox: OpenSandboxResidentProvider;

  constructor(engine: DockerBackend, private readonly settings?: OpenSandboxRunnerSettings) {
    this.docker = new DockerResidentProvider(engine);
    this.openSandbox = new OpenSandboxResidentProvider(engine, settings);
  }

  get backendId() { return this.selected().backendId; }

  private selected() {
    return this.settings ? this.openSandbox : this.docker;
  }

  private backend(ref: EnvironmentRef): ResidentProvider {
    if (ref.backendId === this.docker.backendId) return this.docker;
    if (ref.backendId === this.openSandbox.backendId) return this.openSandbox;
    throw new Error("Unknown resident backend");
  }

  plannedRef(attemptId: string) {
    return this.selected().plannedRef(attemptId);
  }

  async findOwned(sessionId: string) {
    const [docker, openSandbox] = await Promise.all([
      this.docker.findOwned(sessionId), this.openSandbox.findOwned(sessionId),
    ]);
    return [...docker, ...openSandbox];
  }

  async findOwnedSessions() {
    const [docker, openSandbox] = await Promise.all([
      this.docker.findOwnedSessions(), this.openSandbox.findOwnedSessions(),
    ]);
    return [...new Set([...docker, ...openSandbox])];
  }

  resolveImage(image: string) { return this.docker.resolveImage(image); }
  create(launch: ResidentLaunch) { return this.selected().create(launch); }
  stopOnCancel(ref: EnvironmentRef) { return this.backend(ref).stopOnCancel?.(ref) ?? false; }
  start(ref: EnvironmentRef) { return this.backend(ref).start(ref); }
  inspect(ref: EnvironmentRef) { return this.backend(ref).inspect(ref); }
  stopAndConfirm(ref: EnvironmentRef) { return this.backend(ref).stopAndConfirm(ref); }
  remove(ref: EnvironmentRef) { return this.backend(ref).remove(ref); }
  openRunner(ref: EnvironmentRef, runnerId: string) { return this.backend(ref).openRunner(ref, runnerId); }
}
