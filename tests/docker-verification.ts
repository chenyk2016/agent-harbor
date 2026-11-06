import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Controller } from "../src/runtime/controller.js";
import { defaultProfile } from "../src/shared/types.js";
import { fixtureModel } from "./fixture-model.js";

const verificationId = String(Date.now());
const root = resolve("var/verification", verificationId);
const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? "var/evidence");
const fixtureImage = `${defaultProfile.image}-test`;
await mkdir(evidence, { recursive: true });
const results: Array<{ name: string; status: string; detail?: unknown }> = [];
async function check(name: string, action: () => Promise<unknown>) {
  try {
    results.push({ name, status: "PASS", detail: await action() });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: String(error) });
  }
  console.log(name, results.at(-1)?.status);
  await writeFile(
    join(evidence, "docker-verification.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
async function waitUntil(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(100);
  }
  throw new Error("Condition not observed within 15s");
}
const controller = new Controller(root, {
  ...defaultProfile,
  image: fixtureImage,
  timeoutMs: 30_000,
});

await check(
  "protocol-worker: files, final state, container removed",
  async () => {
    const result = await controller.run("basic", "first", "fake-test-token");
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.stopped, true);
    assert.equal(
      await readFile(join(root, "basic/workspace/result.txt"), "utf8"),
      "first",
    );
    assert.equal((await controller.backend.forSession("basic")).length, 0);
    return result;
  },
);
await check(
  "protocol-worker: new container preserves state and explicit resume ID",
  async () => {
    const before = await controller.store.load("basic");
    const result = await controller.run("basic", "continue", "fake-new-token");
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.generation, before.generation + 1);
    assert.equal(result.sdkSessionId, before.sdkSessionId);
    assert.equal(
      await readFile(join(root, "basic/workspace/result.txt"), "utf8"),
      "continued",
    );
    assert.equal(
      await readFile(join(root, "basic/claude-state/state.txt"), "utf8"),
      "preserved",
    );
  },
);
await check(
  "protocol-worker: concurrent writer rejected, cancellation kills ignored SIGTERM",
  async () => {
    const abort = new AbortController();
    const running = controller.run(
      "cancel",
      "long",
      "fake",
      () => {},
      abort.signal,
    );
    await waitUntil(
      async () => (await controller.store.load("cancel")).status === "running",
    );
    await assert.rejects(
      controller.run("cancel", "second", "fake"),
      /already running/,
    );
    await waitUntil(async () => {
      try {
        return (
          (await readFile(join(root, "cancel/workspace/ticks"))).length > 0
        );
      } catch {
        return false;
      }
    });
    abort.abort();
    const result = await running;
    assert.equal(result.status, "cancelled", result.error);
    assert.equal(result.stopped, true);
    const before = await readFile(join(root, "cancel/workspace/ticks"), "utf8");
    await delay(250);
    assert.equal(
      await readFile(join(root, "cancel/workspace/ticks"), "utf8"),
      before,
    );
  },
);
await check(
  "protocol-worker: normal result leaves no background writer",
  async () => {
    const result = await controller.run("background", "background", "fake");
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.stopped, true);
    assert.equal((await controller.backend.forSession("background")).length, 0);
  },
);
await check(
  "protocol-worker: malformed output fails and still stops environment",
  async () => {
    const result = await controller.run("malformed", "malformed", "fake");
    assert.equal(result.status, "failed");
    assert.equal(result.stopped, true);
  },
);
await check(
  "protocol-worker: Controller crash releases lock but reconciles old container",
  async () => {
    const cli = spawn(
      process.execPath,
      ["dist/src/clients/cli/local.js", "run", "crash", "long"],
      {
        env: {
          ...process.env,
          AH_IMAGE: fixtureImage,
          AH_DATA_DIR: root,
          AH_GATEWAY_TOKEN: "fake",
          AH_GATEWAY_URL: "http://fixture.invalid",
        },
        stdio: "ignore",
      },
    );
    const exited = once(cli, "exit");
    try {
      await waitUntil(
        async () => (await controller.store.load("crash")).status === "running",
      );
      const old = await controller.store.load("crash");
      assert.equal(
        (await controller.backend.inspect(old.containerId!))?.running,
        true,
      );
      cli.kill("SIGKILL");
      await exited;
      await delay(100); // Wait for the lock helper to observe closed stdin.
      const result = await controller.run("crash", "after-crash", "new-fake");
      assert.equal(result.status, "succeeded", result.error);
      assert.equal(
        await controller.backend.inspect(old.containerId!),
        undefined,
      );
    } finally {
      cli.kill("SIGKILL");
    }
  },
);
await check(
  "protocol-worker: separate sessions use separate state",
  async () => {
    const other = await controller.run("other", "first", "fake");
    assert.equal(other.status, "succeeded");
    assert.equal(
      await readFile(join(root, "other/workspace/result.txt"), "utf8"),
      "first",
    );
    assert.equal(
      await readFile(join(root, "basic/workspace/result.txt"), "utf8"),
      "continued",
    );
  },
);

// This is the actual SDK/CLI path, separate from the protocol-only lifecycle worker above.
const model = fixtureModel([
  { name: "Bash", input: { command: "printf SANDBOX_WORKS" } },
]);
await new Promise<void>((resolve) =>
  model.server.listen(0, "0.0.0.0", resolve),
);
const address = model.server.address() as { port: number };
const actual = new Controller(
  resolve("var/native-verification", verificationId),
  {
    ...defaultProfile,
    gatewayUrl: `http://host.docker.internal:${address.port}`,
  },
);
try {
  await check(
    "native SDK: strict sandbox starts, or fails closed before model request",
    async () => {
      const result = await actual.run(
        "sandbox",
        "Run the sandbox probe",
        "fake-native-token",
      );
      const directory = join(
        actual.store.directory("sandbox"),
        "attempts",
        result.attemptId!,
      );
      const stderr = await readFile(
        join(directory, "stderr.log"),
        "utf8",
      ).catch(() => "");
      await writeFile(
        join(evidence, "native-model-requests.json"),
        JSON.stringify(model.requests, null, 2),
      );
      await writeFile(join(evidence, "native-sandbox-stderr.log"), stderr);
      const detail = {
        result,
        modelRequests: model.requests.length,
        targetPositiveIsolation: "NOT_RUN",
      };
      await writeFile(
        join(evidence, "native-sandbox.json"),
        JSON.stringify(detail, null, 2) + "\n",
      );
      assert.equal(result.stopped, true);
      if (
        result.status === "failed" &&
        model.requests.length === 0 &&
        /sandbox|bwrap|namespace/i.test(stderr)
      ) {
        return {
          behavior: "fail-closed",
          targetIsolation: "BLOCKED",
          reason: "Native sandbox unavailable under strict Docker profile",
          ...detail,
        };
      }
      assert.equal(result.status, "succeeded", result.error);
      assert.ok(model.requests.length > 0);
      const toolResults = model.requests
        .flatMap((body) =>
          (body.messages ?? []).flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          ),
        )
        .filter((block: any) => block.type === "tool_result");
      assert.ok(
        toolResults.some(
          (block) =>
            !block.is_error &&
            JSON.stringify(block.content).includes("SANDBOX_WORKS"),
        ),
        "SDK success without a successful sandbox tool is not an isolation pass",
      );
      return { behavior: "native-executed", ...detail };
    },
  );
} finally {
  model.server.closeAllConnections();
  await new Promise<void>((resolve) => model.server.close(() => resolve()));
}

for (const control of [controller, actual]) {
  const ids = await control.backend.command([
    "ps",
    "-aq",
    "--filter",
    `label=harbor.owner=${control.backend.owner}`,
  ]);
  assert.equal(ids, "", "Verification left owned containers behind");
}
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
