/** 新目录的实际 Docker 挂载和原生文件工具验收；不宣称 Bash 沙箱已通过。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Controller } from "../src/runtime/controller.js";
import { containerPaths } from "../src/shared/paths.js";
import { defaultProfile } from "../src/shared/types.js";
import { fixtureModel } from "./fixture-model.js";
const exec = promisify(execFile);
const evidence = resolve(
  process.env.AH_EVIDENCE_DIR ?? "var/evidence/layout",
);
await mkdir(evidence, { recursive: true });
const controller = new Controller(
  resolve("var/layout-verification", String(Date.now())),
);
const directory = await controller.store.prepare("probe");
const input = join(directory, "attempts", "inputs");
await mkdir(input);
await mkdir(join(directory, "claude-state", "nested"));
await writeFile(
  join(directory, "workspace", "public.txt"),
  "PUBLIC_LAYOUT_MARKER",
);
await writeFile(
  join(directory, "claude-state", "nested", "secret.txt"),
  "PRIVATE_STATE_MARKER",
);
await writeFile(join(input, "secret.txt"), "PRIVATE_RUN_MARKER");
const calls = [
  {
    name: "Read",
    input: { file_path: `${containerPaths.workspace}/public.txt` },
  },
  { name: "Read", input: { file_path: `${containerPaths.run}/secret.txt` } },
  {
    name: "Read",
    input: { file_path: `${containerPaths.state}/nested/secret.txt` },
  },
  {
    name: "Read",
    input: { file_path: `${containerPaths.runtime}/package.json` },
  },
  {
    name: "Read",
    input: {
      file_path: `${containerPaths.managedSettings}/managed-settings.json`,
    },
  },
  {
    name: "Write",
    input: {
      file_path: `${containerPaths.state}/nested/secret.txt`,
      content: "must not overwrite",
    },
  },
];
const fixture = fixtureModel(calls);
await new Promise<void>((resolve) =>
  fixture.server.listen(0, "0.0.0.0", resolve),
);
const port = (fixture.server.address() as { port: number }).port;
await writeFile(
  join(input, "connection.json"),
  JSON.stringify({
    url: `http://host.docker.internal:${port}`,
    token: "fake-layout-token",
  }),
);
const name = `ah-layout-${Date.now()}`;
try {
  const image = await controller.backend.imageId(
    `${defaultProfile.image}-test`,
  );
  const running = exec(
    "docker",
    [
      "run",
      "--name",
      name,
      "--init",
      "--user",
      "1000:1000",
      "--label",
      "io.agent-harbor.project=agent-harbor",
      "--label",
      `harbor.owner=${controller.backend.owner}`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m,mode=1777",
      "--mount",
      `type=bind,src=${directory}/workspace,dst=${containerPaths.workspace}`,
      "--mount",
      `type=bind,src=${directory}/claude-state,dst=${containerPaths.state}`,
      "--mount",
      `type=bind,src=${input},dst=${containerPaths.run},readonly`,
      "--entrypoint",
      "node",
      image,
      `${containerPaths.runtime}/dist/tests/policy-probe.js`,
    ],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const { stdout, stderr } = await running;
  await writeFile(join(evidence, "directory-probe-stderr.log"), stderr);
  const probe = JSON.parse(stdout);
  const inspect = JSON.parse(
    await controller.backend.command(["inspect", name]),
  )[0];
  const blocks =
    fixture.requests
      .at(-1)
      ?.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((block: any) => block.type === "tool_result") ?? [];
  await writeFile(
    join(evidence, "directory-probe.json"),
    JSON.stringify(
      {
        probe,
        toolResults: blocks,
        mounts: inspect.Mounts.map((mount: any) => ({
          destination: mount.Destination,
          writable: mount.RW,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  assert.equal(probe.result?.subtype, "success");
  assert.ok(
    probe.resolved.sources.some((source: any) => source.source === "managed"),
  );
  assert.deepEqual(probe.resolved.effective.sandbox.filesystem.denyRead, [
    "/platform",
    "/etc/claude-code",
  ]);
  assert.deepEqual(probe.mounts, { runtimeReadOnly: true, runReadOnly: true });
  assert.ok(Object.values(probe.oldPaths).every((value) => value === false));
  assert.deepEqual(
    inspect.Mounts.map((mount: any) => ({
      destination: mount.Destination,
      writable: mount.RW,
    })).sort((a: any, b: any) => a.destination.localeCompare(b.destination)),
    [
      { destination: "/platform/run", writable: false },
      { destination: "/platform/state", writable: true },
      { destination: "/workspace", writable: true },
    ],
  );
  const byId = new Map(blocks.map((block: any) => [block.tool_use_id, block]));
  const publicResult: any = byId.get("toolu_0");
  assert.ok(
    publicResult &&
      !publicResult.is_error &&
      JSON.stringify(publicResult.content).includes("PUBLIC_LAYOUT_MARKER"),
  );
  for (let index = 1; index < calls.length; index++)
    assert.equal(
      (byId.get(`toolu_${index}`) as any)?.is_error,
      true,
      `private tool ${index} must be denied`,
    );
  assert.ok(!JSON.stringify(blocks).includes("PRIVATE_STATE_MARKER"));
  assert.ok(!JSON.stringify(blocks).includes("PRIVATE_RUN_MARKER"));
  assert.equal(
    await readFile(join(directory, "claude-state/nested/secret.txt"), "utf8"),
    "PRIVATE_STATE_MARKER",
  );
  assert.equal(
    await readFile(join(directory, "claude-state/parent-state.txt"), "utf8"),
    "state writable by trusted parent",
  );
  console.log(
    "PASS: new mounts, old paths absent, managed policy loaded, public Read allowed, four private Reads and private Write denied.",
  );
} finally {
  await controller.backend.stop(name);
  await controller.backend.destroy(name);
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}
