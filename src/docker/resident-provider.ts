import type { EnvironmentRef } from "../runtime/providers/contracts.js";
import type { ResidentLaunch, ResidentProvider, RunnerTransport } from "../runtime/providers/resident.js";
import { dockerSessionName, type DockerBackend } from "./docker.js";

export class DockerResidentProvider implements ResidentProvider {
  readonly backendId = "docker";

  constructor(private readonly docker: DockerBackend) {}

  private ref(resourceId: string): EnvironmentRef {
    return { backendId: this.backendId, resourceId };
  }

  private id(ref: EnvironmentRef) {
    if (ref.backendId !== this.backendId) throw new Error("Wrong resident backend");
    return ref.resourceId;
  }

  plannedRef(attemptId: string) {
    return this.ref(dockerSessionName(attemptId));
  }

  async findOwned(sessionId: string) {
    return (await this.docker.forSession(sessionId)).map(id => this.ref(id));
  }

  findOwnedSessions() {
    return this.docker.ownedSessions();
  }

  resolveImage(image: string) {
    return this.docker.imageId(image);
  }

  async create({ task, profile, directory, attemptDirectory, leaseId }: ResidentLaunch) {
    return this.ref(await this.docker.create(task, profile, directory, attemptDirectory, true, leaseId));
  }

  start(ref: EnvironmentRef) {
    return this.docker.startSession(this.id(ref));
  }

  async inspect(ref: EnvironmentRef) {
    const state = await this.docker.inspect(this.id(ref));
    return !state ? "absent" : state.running ? "running" : "stopped";
  }

  stopAndConfirm(ref: EnvironmentRef) {
    return this.docker.stop(this.id(ref));
  }

  remove(ref: EnvironmentRef) {
    return this.docker.destroy(this.id(ref));
  }

  openRunner(ref: EnvironmentRef, runnerId: string): RunnerTransport {
    const child = this.docker.connect(this.id(ref), runnerId);
    return {
      output: child.stdout,
      diagnostics: child.stderr,
      onFailure(listener) {
        child.on("error", listener);
        child.stdin.on("error", listener);
        child.once("exit", code => listener(new Error(`Resident Runner exited with ${code}`)));
      },
      send: line => { child.stdin.write(line); },
      end: () => { child.stdin.end(); },
      disconnect: () => { child.kill(); },
    };
  }
}
