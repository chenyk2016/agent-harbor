/** Qualification-only adapter. Production composition still selects its existing backend. */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DockerResidentProvider } from "../../dist/src/docker/resident-provider.js";

const backendId = "opensandbox-strict-runner";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(75);
  }
  throw new Error(description);
}

export function socketTransport(path) {
  const socket = createConnection({ path });
  const output = new PassThrough(), diagnostics = new PassThrough();
  let notify = () => {};
  void (async () => {
    let pending = Buffer.alloc(0);
    for await (const chunk of socket) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1);
        const destination = pending[0] === 1 ? output : pending[0] === 2 ? diagnostics : undefined;
        if (!destination || size > 1024 * 1024) throw new Error("Invalid Runner bridge frame");
        if (pending.length < size + 5) break;
        const bytes = pending.subarray(5, size + 5);
        pending = pending.subarray(size + 5);
        if (!destination.write(bytes)) await once(destination, "drain");
      }
    }
    throw new Error(pending.length ? "Truncated Runner bridge frame" : "Runner bridge closed");
  })().catch(error => {
    notify(error);
    socket.destroy();
  }).finally(() => {
    output.end();
    diagnostics.end();
  });
  return {
    output, diagnostics,
    onFailure(listener) { notify = listener; },
    send(line) {
      if (socket.destroyed || socket.writableEnded || socket.writableLength + Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Runner bridge cannot accept input");
      socket.write(line);
    },
    end() { socket.end(); },
    disconnect() { socket.destroy(); },
  };
}

export class QualificationProvider {
  backendId = backendId;
  engineByAttempt = new Map();

  constructor(docker, origin, apiKey, transport = "bridge") {
    this.docker = docker;
    this.legacy = new DockerResidentProvider(docker);
    this.origin = origin;
    this.apiKey = apiKey;
    this.transport = transport;
    this.intents = join(docker.root, ".opensandbox-intents");
  }

  plannedRef(attempt) {
    if (!uuid.test(attempt)) throw new Error("Invalid Runner attempt");
    return { backendId, resourceId: attempt };
  }

  async api(path, method, body) {
    const response = await fetch(new URL("/v1" + path, this.origin), {
      method, headers: { "OPEN-SANDBOX-API-KEY": this.apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404))
      throw new Error(`OpenSandbox ${method} HTTP ${response.status}: ${(await response.text()).slice(0, 450)}`);
    if (method === "POST") return response.json();
    await response.body?.cancel();
  }

  async records() {
    const files = await readdir(this.intents).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(files.filter(name => /^[0-9a-f-]+\.json$/.test(name))
      .map(async name => JSON.parse(await readFile(join(this.intents, name), "utf8"))));
  }

  async engine(attempt) {
    const ids = await this.docker.command(["ps", "-aq", "--filter", "label=harbor.os.owner=" + this.docker.owner,
      "--filter", "label=harbor.os.attempt=" + attempt]);
    if (!ids) return;
    if (ids.includes("\n")) throw new Error("Multiple resources for Runner attempt");
    const [state] = JSON.parse(await this.docker.command(["inspect", ids]));
    const labels = state.Config.Labels;
    if (labels["harbor.os.owner"] !== this.docker.owner || labels["harbor.os.attempt"] !== attempt ||
        !uuid.test(labels["opensandbox.io/id"])) throw new Error("Runner ownership not confirmed");
    return state;
  }

  async findOwned(sessionId) {
    const records = (await this.records()).filter(record => record.sessionId === sessionId);
    return [...await this.legacy.findOwned(sessionId), ...records.map(record => this.plannedRef(record.attempt))];
  }

  async findOwnedSessions() {
    return [...new Set([...await this.legacy.findOwnedSessions(), ...(await this.records()).map(r => r.sessionId)])];
  }

  resolveImage(image) { return this.legacy.resolveImage(image); }

  async create({ task, profile, directory, attemptDirectory, leaseId }) {
    if (task.hasLocalMcp || task.capabilities || task.expert || task.networkDomains?.length)
      throw new Error("Qualification covers ordinary sessions only");
    const attempt = task.attemptId;
    const ref = this.plannedRef(attempt);
    const bridge = join(attemptDirectory, "bridge");
    const cacheKey = createHash("sha256").update(`session:${task.sessionId}`).digest("hex");
    const cache = join(this.docker.root, ".dependency-caches", cacheKey);
    await mkdir(bridge, { mode: 0o700 });
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const policy = join(attemptDirectory, "managed-settings.json");
    await writeFile(policy, await readFile(new URL("../../infra/managed-settings.json", import.meta.url)), { mode: 0o644 });
    const mounts = [
      [join(directory, "workspace"), "/workspace", false],
      [join(directory, "claude-state"), "/platform/state", false],
      [join(directory, "attempts"), "/platform/run", true],
      [join(directory, "dependency-env"), "/session-env", false],
      [cache, "/dependency-cache", false],
      [bridge, "/platform/bridge", false],
      [policy, "/etc/claude-code/managed-settings.json", true],
    ];
    await mkdir(this.intents, { recursive: true, mode: 0o700 });
    const file = join(this.intents, attempt + ".json");
    const intent = { sessionId: task.sessionId, attempt };
    await writeFile(file, JSON.stringify(intent), { mode: 0o600, flag: "wx", flush: true });
    const profileResponse = await fetch(new URL(`/harbor-runner/v1/${this.docker.owner}`, this.origin), {
      headers: { "OPEN-SANDBOX-API-KEY": this.apiKey },
    });
    if (!profileResponse.ok) throw new Error("Strict Runner profile unavailable");
    const { epoch } = await profileResponse.json();
    const response = await this.api("/sandboxes", "POST", {
      image: { uri: profile.image },
      entrypoint: ["node", "/opt/opensandbox/runner-bridge.cjs", attempt, leaseId],
      timeout: 300,
      resourceLimits: { cpu: "2", memory: "4Gi" },
      metadata: { "harbor.os.owner": this.docker.owner, "harbor.os.session": task.sessionId, "harbor.os.attempt": attempt, "harbor.os.epoch": epoch },
      volumes: mounts.map(([path, mountPath, readOnly], index) => ({ name: "mount-" + index, host: { path }, mountPath, readOnly })),
    });
    if (!uuid.test(response.id)) throw new Error("Unexpected OpenSandbox resource ID");
    await writeFile(file + ".tmp", JSON.stringify({ ...intent, id: response.id }), { mode: 0o600, flush: true });
    await rename(file + ".tmp", file);
    const state = await until(async () => {
      const candidate = await this.engine(attempt);
      if (candidate && candidate.Config.Labels["opensandbox.io/id"] !== response.id) throw new Error("Sandbox resource mismatch");
      return candidate?.State.Running && candidate;
    }, "Sandbox did not start");
    const socket = join(bridge, "runner.sock");
    if (this.transport === "bridge") {
      await until(async () => {
        const stat = await lstat(socket).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        return stat?.isSocket() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600;
      }, "Private Runner socket did not become ready");
    }
    this.engineByAttempt.set(attempt, { id: state.Id, bridge: socket });
    return ref;
  }

  async start(ref) {
    if (await this.inspect(ref) !== "running") throw new Error("Runner is not running");
  }

  async inspect(ref) {
    if (ref.backendId === "docker") return this.legacy.inspect(ref);
    const state = await this.engine(ref.resourceId);
    return !state ? "absent" : state.State.Running ? "running" : "stopped";
  }

  async stopAndConfirm(ref) {
    if (ref.backendId === "docker") return this.legacy.stopAndConfirm(ref);
    const attempt = ref.resourceId;
    const record = (await this.records()).find(item => item.attempt === attempt);
    const state = await this.engine(attempt);
    if (!state) {
      if (record && !record.id) throw new Error("Previous OpenSandbox create is unconfirmed");
      return;
    }
    const id = state.Config.Labels["opensandbox.io/id"];
    if (!record || (record.id && record.id !== id)) throw new Error("Unowned Runner resource");
    await this.api("/sandboxes/" + id, "DELETE");
    await until(async () => !await this.engine(attempt), "Old writer still exists");
  }

  async remove(ref) {
    if (ref.backendId === "docker") return this.legacy.remove(ref);
    if (await this.engine(ref.resourceId)) throw new Error("Old Runner not absent");
    await rm(join(this.intents, ref.resourceId + ".json"), { force: true });
    this.engineByAttempt.delete(ref.resourceId);
  }

  openRunner(ref, runnerId) {
    const selected = this.engineByAttempt.get(ref.resourceId);
    if (!selected) throw new Error("Unconfirmed Runner endpoint");
    return this.transport === "engine"
      ? this.legacy.openRunner({ backendId: "docker", resourceId: selected.id }, runnerId)
      : socketTransport(selected.bridge);
  }
}
