/** 用合成秘密验证检查器确实检查索引和已删除的历史，不使用真实凭证。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const script = resolve("scripts/audit-public.mjs");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ah-audit-"));
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init", "-b", "main");
  await git("config", "user.name", "Test Contributors");
  await git("config", "user.email", "contributors@example.invalid");
  await git("config", "commit.gpgsign", "false");
  return { root, git, audit: () => exec(process.execPath, [script], { cwd: root }) };
}

test("public audit rejects a tracked environment file without printing its contents", async () => {
  const f = await fixture();
  const secret = "sk-ant-" + "a".repeat(30);
  try {
    await writeFile(join(f.root, ".env"), "TOKEN=" + secret);
    await f.git("add", ".env");
    await assert.rejects(f.audit(), error => {
      assert.match(String(error), /non-public-file/);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("public audit rejects secrets removed from the current file but retained in history", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "README.md"), "sk-ant-" + "b".repeat(30));
    await f.git("add", "."); await f.git("commit", "-m", "fixture with synthetic secret");
    await writeFile(join(f.root, "README.md"), "public content");
    await f.git("add", "."); await f.git("commit", "-m", "remove synthetic secret");
    await assert.rejects(f.audit(), /provider-secret/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
