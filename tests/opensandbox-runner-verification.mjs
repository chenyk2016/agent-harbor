/** Ordered real Docker/OpenSandbox qualification. Run only on a disposable Linux engine. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { stopAndRemove } from "../dist/src/runtime/providers/contracts.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
import { QualificationProvider, until } from "./fixtures/opensandbox-resident.mjs";

assert.equal(process.platform, "linux");
assert.equal(process.env.AH_OPENSANDBOX_DISPOSABLE, "1");
assert.equal(process.getuid(), 1000, "Use the same Linux UID as the non-root Runner");
const root = resolve(process.env.AH_RUNNER_FIXTURE_ROOT);
const origin = new URL(process.env.AH_STRICT_OPENSANDBOX_ORIGIN);
assert.equal(origin.hostname, "127.0.0.1");
const apiKey = process.env.AH_STRICT_OPENSANDBOX_KEY;
assert.ok(apiKey);
const token = "ISOLATED_MODEL_FIXTURE_ONLY";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bash = command => ({ name: "Bash", input: { command, timeout: 20000 } });
const writer = `import signal,time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
  with Path("/workspace/ticks").open("a") as file: file.write("tick\\n")
  time.sleep(.04)
`;
function controller(profile, mode = "bridge") {
  const c = new Controller(root, profile);
  const provider = new QualificationProvider(c.backend, origin, apiKey, mode);
  Object.defineProperty(c, "resident", { value: provider });
  return { c, provider };
}
function succeeded(result) {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
}
if (process.argv[2] === "crash-child") {
  const profile = JSON.parse(process.env.AH_RUNNER_TEST_PROFILE);
  const { c } = controller(profile);
  const chat = await c.open("crash", token);
  const first = await chat.run("Seed a resumable native conversation");
  succeeded(first);
  process.send({ sdkSessionId: first.sdkSessionId });
  await once(process, "message");
  await chat.run("Start the active writer before the host crash");
  process.send({ unexpected: true });
} else {
  // Keep a mutable fixture script, no model credentials or network provider.
  const planned = [];
  const fixture = fixtureModel(planned);
  await new Promise(resolve => fixture.server.listen(0, "0.0.0.0", resolve));
  const profile = { ...defaultProfile, image: process.env.AH_RUNNER_TEST_IMAGE,
    gatewayUrl: `http://host.docker.internal:${fixture.server.address().port}`, timeoutMs: 30000 };
  assert.ok(profile.image);
  const { c, provider } = controller(profile);
  const checks = [];
  const pass = name => { checks.push(name); console.log("PASS", name); };
  let chat, child, probeRef;
  try {
    const attempt = randomUUID(), lease = randomUUID();
    const directory = await c.store.prepare("rootfs");
    const attemptDirectory = join(directory, "attempts", attempt);
    await mkdir(attemptDirectory);
    const leases = join(directory, "attempts", ".leases");
    await mkdir(leases);
    await writeFile(join(leases, lease), "");
    probeRef = await provider.create({ task: { attemptId: attempt, sessionId: "rootfs" },
      profile: { ...profile, image: await provider.resolveImage(profile.image) }, directory, attemptDirectory, leaseId: lease });
    const state = await provider.engine(attempt);
    const options = state.HostConfig;
    assert.equal(options.ReadonlyRootfs, true);
    assert.equal(options.Init, true);
    assert.equal(options.Memory, 4 * 1024 ** 3);
    assert.equal(options.NanoCpus, 2_000_000_000);
    assert.equal(options.PidsLimit, 256);
    assert.equal(options.Tmpfs["/tmp"], "rw,nosuid,size=256m,mode=1777");
    assert.deepEqual(options.CapDrop, ["ALL"]);
    assert.ok(!options.CapAdd?.length);
    assert.ok(options.SecurityOpt.some(item => item.startsWith("seccomp={")));
    assert.ok(options.SecurityOpt.some(item => item.startsWith("no-new-privileges")));
    assert.equal(state.Mounts.find(item => item.Destination === "/opt/opensandbox").RW, false);
    assert.equal(state.Mounts.find(item => item.Destination === "/platform/run").RW, false);
    assert.equal(await c.backend.command(["exec", state.Id, "id", "-u"]), "1000");
    await assert.rejects(c.backend.command(["exec", "--user", "0", state.Id, "touch", "/var/tmp/forbidden"]),
      error => /read-only file system/i.test(error.stderr));
    await c.backend.command(["exec", state.Id, "touch", "/tmp/allowed", "/workspace/allowed"]);
    const [published] = state.NetworkSettings.Ports["44772/tcp"];
    assert.equal(published.HostIp, "127.0.0.1");
    const execd = new URL(`http://127.0.0.1:${published.HostPort}/`);
    // This fixed execd version also protects /ping. A daemon-specific 401 proves
    // the process is listening without disclosing its token to the fixture.
    await until(async () => {
      const reply = await fetch(new URL("ping", execd)).catch(() => undefined);
      return reply?.status === 401 && (await reply.text()).includes("X-EXECD-ACCESS-TOKEN");
    }, "Execd did not start with authentication required");
    await stopAndRemove(provider, probeRef); probeRef = undefined;
    pass("01 read-only root from creation, protected mounts, bounded tmpfs, original outer permissions and authenticated execd");

    const native = controller(profile, "engine");
    chat = await native.c.open("native", token);
    planned.push(bash("printf native-ok > /workspace/native"));
    const firstNative = await chat.run("Use the native Bash tool");
    succeeded(firstNative);
    assert.ok(firstNative.sdkSessionId);
    assert.equal(await readFile(join(root, "native/workspace/native"), "utf8"), "native-ok");
    await chat.close(); chat = undefined;
    pass("02 real Claude SDK Runner and native isolated Bash work on the hardened OpenSandbox container");

    chat = await c.open("dialog", token);
    planned.splice(0, planned.length, bash(
      "test -z \"$EXECD_ACCESS_TOKEN\" && test ! -S /platform/bridge/runner.sock && printf '双向通过' > /workspace/bridge",
    ));
    const first = await chat.run("Write a first turn through the private socket");
    succeeded(first);
    assert.equal(await readFile(join(root, "dialog/workspace/bridge"), "utf8"), "双向通过");
    planned.push({ name: "Read", input: { file_path: "/workspace/bridge" } });
    const second = await chat.run("Read the previous result in a second turn");
    succeeded(second);
    assert.equal(first.runnerId, second.runnerId);
    assert.equal(first.sdkSessionId, second.sdkSessionId);
    const events = (await readFile(join(root, "dialog/attempts", first.runnerId, "runner-events.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.type === "sdk.spawned").length, 1);
    assert.equal(events.filter(e => e.type === "input.accepted").length, 2);
    assert.equal(events.filter(e => e.type === "agent.result").length, 2);
    const lastToolResults = fixture.requests.at(-1).messages.flatMap(message => message.content)
      .filter(block => block.type === "tool_result");
    assert.ok(JSON.stringify(lastToolResults.at(-1)).includes("双向通过"));
    await chat.close(); chat = undefined;
    pass("03 bidirectional socket transports two native turns without reconnect or duplicate input");

    const legacy = new Controller(root, profile);
    planned.splice(0, planned.length, bash("printf old-state > /workspace/legacy"));
    chat = await legacy.open("legacy", token);
    const before = await chat.run("Create a session under the original Docker adapter");
    succeeded(before);
    await chat.close(); chat = undefined;
    const countBeforeOpen = fixture.requests.length;
    planned.length = 0;
    chat = await c.open("legacy", token);
    assert.equal(fixture.requests.length, countBeforeOpen);
    const resumed = await chat.run("Resume the existing native session");
    succeeded(resumed);
    assert.equal(resumed.sdkSessionId, before.sdkSessionId);
    assert.equal(resumed.imageId, before.imageId);
    assert.equal(resumed.generation, before.generation + 1);
    assert.equal(await readFile(join(root, "legacy/workspace/legacy"), "utf8"), "old-state");
    await chat.close(); chat = undefined;
    pass("04 actual legacy Docker session resumes on the same image with native session ID and file intact");

    const directoryCancel = await c.store.prepare("cancel");
    await writeFile(join(directoryCancel, "workspace/writer.py"), writer);
    const ticks = join(directoryCancel, "workspace/ticks");
    planned.splice(0, planned.length, bash("python3 /workspace/writer.py"));
    chat = await c.open("cancel", token);
    const abort = new AbortController();
    const pending = chat.run("Start the cancellable writer", undefined, abort.signal);
    await until(async () => (await readFile(ticks, "utf8").catch(() => "")).length > 20, "Cancel writer did not start");
    abort.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
    const stoppedAt = await readFile(ticks, "utf8");
    await wait(600);
    assert.equal(await readFile(ticks, "utf8"), stoppedAt);
    planned.length = 0;
    succeeded(await chat.run("Run another turn after cancellation"));
    assert.equal(await readFile(ticks, "utf8"), stoppedAt);
    await chat.close(); chat = undefined;
    pass("05 cancelling a native writer stops further writes and admits the next explicit turn");

    const directoryCrash = await c.store.prepare("crash");
    await writeFile(join(directoryCrash, "workspace/writer.py"), writer);
    const crashTicks = join(directoryCrash, "workspace/ticks");
    child = fork(fileURLToPath(import.meta.url), ["crash-child"], {
      env: { ...process.env, AH_RUNNER_TEST_PROFILE: JSON.stringify(profile) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = once(child, "exit");
    const [seed] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Crash fixture failed before its writer"); })]);
    assert.ok(seed.sdkSessionId);
    planned.push(bash("python3 /workspace/writer.py"));
    child.send("start");
    await until(async () => (await readFile(crashTicks, "utf8").catch(() => "")).length > 20, "Crash writer did not start");
    const old = (await c.store.load("crash")).containerId;
    assert.equal(await provider.inspect(provider.plannedRef(old)), "running");
    const requestCount = fixture.requests.length;
    child.kill("SIGKILL"); await exited;
    await until(async () => (await provider.inspect(provider.plannedRef(old))) !== "running", "Crashed owner left a running writer");
    const stable = await readFile(crashTicks, "utf8");
    await wait(800);
    assert.equal(await readFile(crashTicks, "utf8"), stable);
    chat = await c.open("crash", token);
    assert.equal(await provider.inspect(provider.plannedRef(old)), "absent");
    assert.equal(fixture.requests.length, requestCount);
    planned.length = 0;
    const recovered = await chat.run("Explicitly resume after cleanup");
    succeeded(recovered);
    assert.equal(recovered.sdkSessionId, seed.sdkSessionId);
    assert.notEqual(recovered.containerId, old);
    assert.equal(await readFile(crashTicks, "utf8"), stable);
    await chat.close(); chat = undefined;
    pass("06 SIGKILL active host stops the old writer, removes its environment and resumes without replay");

    chat = await legacy.open("legacy", token);
    const back = await chat.run("Resume under the original Docker adapter again");
    succeeded(back);
    assert.equal(back.sdkSessionId, before.sdkSessionId);
    assert.equal(back.imageId, before.imageId);
    assert.equal(back.generation, resumed.generation + 1);
    assert.equal(await readFile(join(root, "legacy/workspace/legacy"), "utf8"), "old-state");
    await chat.close(); chat = undefined;
    pass("07 switches the same native session back to Docker with its image and file intact");
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    if (chat) await chat.close().catch(console.error);
    if (probeRef) await stopAndRemove(provider, probeRef).catch(console.error);
    for (const session of await provider.findOwnedSessions())
      for (const ref of await provider.findOwned(session)) await stopAndRemove(provider, ref).catch(console.error);
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    await writeFile(join(root, "qualification.json"), JSON.stringify({
      checks, fixtureRequests: fixture.requests.length, realModelRequests: 0,
      remaining: await provider.findOwnedSessions(),
    }, null, 2) + "\n");
  }
}
