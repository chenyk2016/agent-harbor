/** Disposable strict server only. Verifies the two build profiles and their output handoff. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { SkillBuilder } from "../dist/src/docker/skill-builder.js";
import { DockerBackend } from "../dist/src/docker/docker.js";
import { ConfiguredResidentProvider } from "../dist/src/runtime/providers/configured-resident.js";
import { runBuildJob } from "../dist/src/runtime/providers/build-job.js";
import { residentFromEnvironment } from "../dist/src/service/config.js";

const root = process.env.AH_VERIFY_ROOT;
assert.match(root, /\/opensandbox-unified-test\.[a-zA-Z0-9]+\/data-/);
const engine = new DockerBackend(root);
const settings = residentFromEnvironment();
assert.ok(settings);
const resident = new ConfiguredResidentProvider(engine, settings);
const image = await resident.resolveImage(process.env.AH_IMAGE);
for (const type of ["skill-build", "app-build"]) {
  const id = randomUUID();
  const fixture = join(root, "fixture-" + type, id);
  const input = join(fixture, "source");
  const output = join(fixture, "output");
  const materials = join(fixture, "materials");
  const builder = join(fixture, "builder");
  for (const dir of [input, output, materials, builder]) await mkdir(dir, { recursive: true });
  await writeFile(join(input, "sample"), "fixture");
  await writeFile(join(builder, "launch.mjs"), `
    import { readFileSync, writeFileSync } from "node:fs";
    writeFileSync("/output/result", readFileSync("/input/sample", "utf8") + ":" + process.env.APP_REVISION);
    console.log("started");
    await new Promise(resolve => setTimeout(resolve, 800));
  `);
  const work = type === "skill-build"
    ? { type, materials, script: 'set -eu; cp /source/sample /artifact/result; echo started; sleep .8' }
    : { type, builder, env: { APP_REVISION: "build-job" } };
  let checked = false;
  await runBuildJob(resident, root, { id, image, input, output, work }, AbortSignal.timeout(15000), async text => {
    if (checked || !text.includes("started")) return;
    const container = await engine.command(["ps", "-q", "--filter", "label=harbor.os.session=" + id]);
    const [state] = JSON.parse(await engine.command(["inspect", container]));
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    if (type === "skill-build") assert.equal(state.HostConfig.NetworkMode, "none");
    assert.ok(!state.Mounts.some(m => m.Destination === "/var/run/docker.sock"));
    assert.ok(!state.Mounts.some(m => m.Destination === "/workspace"));
    checked = true;
  });
  assert.ok(checked);
  assert.equal(await readFile(join(output, "result"), "utf8"), type === "skill-build" ? "fixture" : "fixture:build-job");
  assert.deepEqual(await resident.findOwned(id), []);
  console.log("PASS", type, "on OpenSandbox with scoped mounts, readonly root and confirmed output handoff");
}

const skillId = randomUUID();
const skillRoot = join(root, "fixture-offline-wheel", skillId);
const source = join(skillRoot, "source"), materials = join(skillRoot, "downloads"), output = join(skillRoot, "artifact");
await mkdir(source, { recursive: true });
await mkdir(materials, { recursive: true });
const wheel = new ZipFile();
const metadata = "harbor_probe-1.0.dist-info/";
for (const [file, content] of [
  ["harbor_probe/__init__.py", "VALUE = 17\n"],
  [metadata + "METADATA", "Metadata-Version: 2.1\nName: harbor-probe\nVersion: 1.0\n"],
  [metadata + "WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"],
  [metadata + "RECORD", "harbor_probe/__init__.py,,\n"],
]) wheel.addBuffer(Buffer.from(content), file);
wheel.end();
const parts = [];
for await (const chunk of wheel.outputStream) parts.push(chunk);
const bytes = Buffer.concat(parts);
await writeFile(join(materials, "harbor_probe-1.0-py3-none-any.whl"), bytes);
await writeFile(join(source, "requirements.lock"),
  "harbor-probe==1.0 --hash=sha256:" + createHash("sha256").update(bytes).digest("hex") + "\n");
await writeFile(join(source, "SKILL.md"), "Offline Skill fixture");
const skills = new SkillBuilder(root, process.env.AH_IMAGE, resident);
try {
  assert.match(await skills.build({
    name: "ah-skill-" + skillId + "-1", imageId: image, source, materials, output, namespace: "fixture",
    manifest: { name: "offline-fixture", harbor: { dependencies: { python: { lockFile: "requirements.lock" } } } },
  }, AbortSignal.timeout(20000), async () => {}), /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(output, ".harbor-runtime/python-libs/harbor_probe/__init__.py"), "utf8"), "VALUE = 17\n");
  assert.deepEqual(await resident.findOwned(skillId), []);
  console.log("PASS actual SkillBuilder installs a hash-locked wheel offline");
} finally {
  await skills.close();
}

const cancelledId = randomUUID();
const cancelled = join(root, "fixture-cancel", cancelledId);
const cancelledOutput = join(cancelled, "output");
await mkdir(cancelledOutput, { recursive: true });
const cancel = new AbortController();
await assert.rejects(runBuildJob(resident, root, {
  id: cancelledId, image, input: source, output: cancelledOutput,
  work: { type: "skill-build", materials, script: "set -eu; touch /artifact/partial; echo started; sleep 60" },
}, AbortSignal.any([cancel.signal, AbortSignal.timeout(15000)]), async text => {
  if (text.includes("started")) cancel.abort();
}), { name: "AbortError" });
assert.equal(cancel.signal.aborted, true);
await assert.rejects(readFile(join(cancelledOutput, "partial")), { code: "ENOENT" });
assert.deepEqual(await resident.findOwned(cancelledId), []);
console.log("PASS cancelling a build stops its writer and withholds partial output");
