import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerBackend } from "../docker/docker.js";
import type { EnvironmentRef } from "../runtime/providers/contracts.js";
import type { ResidentLaunch, ResidentProvider } from "../runtime/providers/resident.js";
import { prepareRunnerMounts, prepareRunnerPlugins } from "../docker/runner-mounts.js";
import { openRunnerSocket } from "./runner-transport.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sessionKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ownerLabel = "harbor.os.owner";
const sessionLabel = "harbor.os.session";
const attemptLabel = "harbor.os.attempt";
const sandboxLabel = "opensandbox.io/id";
const profileLabel = "harbor.os.profile";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Intent = { sessionId: string; epoch: string; id?: string };
type EngineRunner = { id: string; sessionId: string; attemptId: string; sandboxId: string; running: boolean; readOnly: boolean };
export type OpenSandboxRunnerSettings = { origin: URL; key: string };

export class OpenSandboxResidentProvider implements ResidentProvider {
  readonly backendId = "opensandbox-strict-runner";
  private readonly intents: string;
  private readonly bridges = new Map<string, string>();

  constructor(private readonly docker: DockerBackend, readonly settings?: OpenSandboxRunnerSettings) {
    this.intents = join(docker.root, ".opensandbox-intents");
  }

  plannedRef(attemptId: string): EnvironmentRef {
    if (!uuid.test(attemptId)) throw new Error("Invalid OpenSandbox Runner attempt");
    return { backendId: this.backendId, resourceId: attemptId };
  }

  private attempt(ref: EnvironmentRef) {
    if (ref.backendId !== this.backendId) throw new Error("Wrong resident backend");
    return this.plannedRef(ref.resourceId).resourceId;
  }

  private async api(path: string, method: string, body?: object) {
    if (!this.settings) throw new Error("OpenSandbox Runner is disabled");
    const response = await fetch(new URL(path, this.settings.origin), {
      method, headers: { "OPEN-SANDBOX-API-KEY": this.settings.key,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      await response.body?.cancel();
      throw new Error(`OpenSandbox Runner ${method} returned HTTP ${response.status}`);
    }
    if (method === "POST" || method === "GET") return response.json();
    await response.body?.cancel();
  }

  private async managerEpoch(required: string[] = []): Promise<string> {
    const profile = await this.api(`/harbor-runner/v1/${this.docker.owner}`, "GET");
    if (profile?.profile !== "strict-v1" || !uuid.test(profile.epoch))
      throw new Error("OpenSandbox strict Runner profile unconfirmed");
    if (required.some(feature => !Array.isArray(profile.features) || !profile.features.includes(feature)))
      throw new Error("OpenSandbox strict Runner profile does not support this workload");
    return profile.epoch;
  }

  private async intent(attempt: string): Promise<Intent | undefined> {
    const raw = await readFile(join(this.intents, attempt + ".json"), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (raw === undefined) return;
    const record = JSON.parse(raw) as Intent;
    if (!sessionKey.test(record.sessionId) || !uuid.test(record.epoch) ||
        (record.id !== undefined && !uuid.test(record.id)))
      throw new Error("Invalid OpenSandbox Runner intent");
    return record;
  }

  private async records() {
    const files = await readdir(this.intents).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = new Map<string, Intent>();
    for (const name of files.filter(name => name.endsWith(".json"))) {
      const attempt = this.plannedRef(name.slice(0, -5)).resourceId;
      const record = await this.intent(attempt);
      if (record) records.set(attempt, record);
    }
    return records;
  }

  private async inventory(filter?: [string, string]): Promise<EngineRunner[]> {
    const ids = await this.docker.command(["ps", "-aq", "--filter", `label=${ownerLabel}=${this.docker.owner}`,
      ...(filter ? ["--filter", `label=${filter[0]}=${filter[1]}`] : [])]);
    const entries = await Promise.all(ids.split("\n").filter(Boolean).map(async id => {
      let raw;
      try {
        raw = await this.docker.command(["inspect", "--type", "container", id]);
      } catch (error) {
        if (/no such (object|container)/i.test(String((error as { stderr?: string }).stderr))) return;
        throw error;
      }
      const [state] = JSON.parse(raw);
      const labels = state.Config.Labels;
      if (labels[ownerLabel] !== this.docker.owner || labels[profileLabel] !== "strict-v1" ||
          !sessionKey.test(labels[sessionLabel]) || !uuid.test(labels[attemptLabel]) ||
          !uuid.test(labels[sandboxLabel]) || typeof state.State.Running !== "boolean" ||
          (filter && labels[filter[0]] !== filter[1])) throw new Error("OpenSandbox Runner ownership unconfirmed");
      return { id: state.Id, sessionId: labels[sessionLabel], attemptId: labels[attemptLabel],
        sandboxId: labels[sandboxLabel], running: state.State.Running, readOnly: state.HostConfig.ReadonlyRootfs === true };
    }));
    return entries.filter(entry => entry !== undefined);
  }

  private async engine(attempt: string) {
    const states = await this.inventory([attemptLabel, attempt]);
    if (states.length > 1) throw new Error("Multiple OpenSandbox resources for one Runner attempt");
    return states[0];
  }

  async findOwned(sessionId: string) {
    if (!sessionKey.test(sessionId)) throw new Error("Invalid session ID");
    const records = await this.records();
    const states = await this.inventory([sessionLabel, sessionId]);
    return [...new Set([
      ...states.map(state => state.attemptId),
      ...[...records].filter(([, record]) => record.sessionId === sessionId).map(([attempt]) => attempt),
    ])].map(attempt => this.plannedRef(attempt));
  }

  async findOwnedSessions() {
    return [...new Set([
      ...(await this.inventory()).map(state => state.sessionId),
      ...[...(await this.records()).values()].map(record => record.sessionId),
    ])];
  }

  resolveImage(image: string) { return this.docker.imageId(image); }

  async create({ task, profile, directory, attemptDirectory, leaseId, job }: ResidentLaunch) {
    const ref = this.plannedRef(task.attemptId);
    await this.docker.validateRunnerImage(task, profile.image);
    const mode = job ?? (task.mcpProbe ? "mcp-probe" : undefined);
    const epoch = await this.managerEpoch([
      ...(task.capabilities || task.expert ? ["plugins"] : []),
      ...(mode ? [mode] : []),
    ]);
    const bridge = join(attemptDirectory, "bridge");
    await mkdir(bridge, { mode: 0o700 });
    const bridgeMount = [bridge, "/platform/bridge", false] as const;
    const attemptsMount = [join(directory, "attempts"), "/platform/run", true] as const;
    const jobMounts = {
      "app-analysis": [[join(attemptDirectory, "analysis"), "/platform/runtime/app-analysis", true]],
      "skill-build": [
        [join(attemptDirectory, "input"), "/source", true],
        [join(attemptDirectory, "materials"), "/downloads", true],
        [join(attemptDirectory, "output"), "/artifact", false],
        [join(attemptDirectory, "build.sh"), `/platform/run/${task.attemptId}/build.sh`, true],
      ],
      "app-build": [
        [join(attemptDirectory, "input"), "/input", true],
        [join(attemptDirectory, "builder"), "/platform/app-builder", true],
        [join(attemptDirectory, "output"), "/output", false],
        [join(attemptDirectory, "build-env.json"), `/platform/run/${task.attemptId}/build-env.json`, true],
      ],
    } as const;
    const leaseMount = [join(directory, "attempts", ".leases"), "/platform/run/.leases", true] as const;
    const mounts = [job ? leaseMount : attemptsMount, bridgeMount, ...(job
      ? jobMounts[job]
      : await this.runnerMounts(task, directory, attemptDirectory))];
    await mkdir(this.intents, { recursive: true, mode: 0o700 });
    const file = join(this.intents, task.attemptId + ".json");
    const intent = { sessionId: task.sessionId, epoch };
    await writeFile(file, JSON.stringify(intent), { mode: 0o600, flag: "wx", flush: true });
    const response = await this.api("/v1/sandboxes", "POST", {
      image: { uri: profile.image },
      entrypoint: ["node", "/opt/opensandbox/runner-bridge.cjs", task.attemptId, leaseId,
        ...(mode ? [mode] : [])],
      timeout: job === "skill-build" ? 720 : 3600,
      resourceLimits: { cpu: "2", memory: "4Gi" },
      metadata: { [ownerLabel]: this.docker.owner, [sessionLabel]: task.sessionId, [attemptLabel]: task.attemptId, "harbor.os.epoch": epoch },
      volumes: mounts.map(([path, mountPath, readOnly], index) => ({ name: "mount-" + index, host: { path }, mountPath, readOnly })),
    });
    if (!response || !uuid.test(response.id)) throw new Error("Unexpected OpenSandbox Runner ID");
    for (let tries = 0; tries < 100; tries++) {
      const state = await this.engine(task.attemptId);
      if (state && (state.sandboxId !== response.id || state.sessionId !== task.sessionId || !state.readOnly))
        throw new Error("OpenSandbox Runner identity or read-only root unconfirmed");
      if (state?.running) {
        const stat = await lstat(join(bridge, "runner.sock")).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        if (stat?.isSocket() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600) {
          await writeFile(file + ".tmp", JSON.stringify({ ...intent, id: response.id }), { mode: 0o600, flush: true });
          await rename(file + ".tmp", file);
          this.bridges.set(task.attemptId, bridge);
          return ref;
        }
      }
      await sleep(75);
    }
    throw new Error("OpenSandbox Runner did not become ready");
  }

  private async runnerMounts(task: ResidentLaunch["task"], directory: string, attemptDirectory: string) {
    const { cacheDirectory, policyFile } = await prepareRunnerMounts(this.docker.root, task, directory, attemptDirectory);
    const plugins = await prepareRunnerPlugins(task, directory, attemptDirectory);
    return [
      [join(directory, "workspace"), "/workspace", false],
      [join(directory, "claude-state"), "/platform/state", false],
      [join(directory, "dependency-env"), "/session-env", false],
      [cacheDirectory, "/dependency-cache", false],
      [policyFile, "/etc/claude-code/managed-settings.json", true],
      ...plugins.map(({ source, target }) => [source, target, true] as const),
    ] as const;
  }

  stopOnCancel() { return true; }

  async start(ref: EnvironmentRef) {
    if (await this.inspect(ref) !== "running") throw new Error("OpenSandbox Runner is not running");
  }

  async inspect(ref: EnvironmentRef) {
    const state = await this.engine(this.attempt(ref));
    return !state ? "absent" : state.running ? "running" : "stopped";
  }

  async stopAndConfirm(ref: EnvironmentRef) {
    const attempt = this.attempt(ref);
    const record = await this.intent(attempt);
    const state = await this.engine(attempt);
    if (!state) {
      if (!record || record.id) return;
      // A missing container cannot settle an ambiguous create during the same
      // manager lifetime. A new epoch fences the old request before admitting writes.
      if (!this.settings || await this.managerEpoch() === record.epoch)
        throw new Error("Previous OpenSandbox Runner create is unconfirmed");
      if (await this.engine(attempt)) throw new Error("OpenSandbox Runner changed during reconciliation");
      await rm(join(this.intents, attempt + ".json"), { force: true });
      return;
    }
    if (record && (record.sessionId !== state.sessionId || (record.id && record.id !== state.sandboxId)))
      throw new Error("OpenSandbox Runner does not match its creation intent");
    if (this.settings) await this.api("/v1/sandboxes/" + state.sandboxId, "DELETE").catch(() => {});
    // Manager restart or switchback may leave metadata unavailable. Exact local
    // engine ID and Harbor labels were verified before falling back to force removal.
    const remaining = await this.engine(attempt);
    if (remaining && remaining.id !== state.id) throw new Error("OpenSandbox Runner changed during cleanup");
    if (remaining) {
      await this.docker.command(["rm", "-f", state.id]).catch(error => {
        if (!/no such (object|container)/i.test(String(error.stderr))) throw error;
      });
    }
    if (await this.engine(attempt)) throw new Error("OpenSandbox Runner is still present");
    if (record && !record.id) await rm(join(this.intents, attempt + ".json"), { force: true });
  }

  async remove(ref: EnvironmentRef) {
    const attempt = this.attempt(ref);
    if (await this.engine(attempt)) throw new Error("OpenSandbox Runner is still present");
    const intent = await this.intent(attempt);
    if (intent && !intent.id) throw new Error("Previous OpenSandbox Runner create is unconfirmed");
    await rm(join(this.intents, attempt + ".json"), { force: true });
    this.bridges.delete(attempt);
  }

  openRunner(ref: EnvironmentRef, runnerId: string) {
    const attempt = this.attempt(ref);
    const bridge = this.bridges.get(attempt);
    if (!bridge || runnerId !== attempt) throw new Error("OpenSandbox Runner socket unconfirmed");
    return openRunnerSocket(bridge);
  }
}
