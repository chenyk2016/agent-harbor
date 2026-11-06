import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);

test("init copies the fixture into an empty workspace and refuses to overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-init-"));
  const env = { ...process.env, AH_DATA_DIR: root };
  try {
    await exec(process.execPath, ["dist/src/clients/cli/local.js", "init", "demo"], { env });
    const before = await readFile(join(root, "demo/workspace/sum.js"), "utf8");
    await assert.rejects(
      exec(process.execPath, ["dist/src/clients/cli/local.js", "init", "demo"], { env }),
      /already initialized/,
    );
    assert.equal(
      await readFile(join(root, "demo/workspace/sum.js"), "utf8"),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run/chat reject absent or placeholder credentials before starting execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-token-"));
  try {
    for (const token of ["", "replace-with-your-token"]) {
      for (const args of [["run", "demo", "work"], ["chat", "demo"]]) {
        await assert.rejects(
          exec(process.execPath, ["dist/src/clients/cli/local.js", ...args], {
            env: { ...process.env, AH_DATA_DIR: root, AH_GATEWAY_TOKEN: token },
          }),
          /Set AH_GATEWAY_TOKEN/,
        );
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
