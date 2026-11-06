import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseWorkBuddy } from "../src/service/experts/workbuddy.js";
import { PackageStore } from "../src/service/skills/package-store.js";
import { runnerOptions } from "../src/agent/runner-options.js";
import { workBuddyFiles } from "./workbuddy-fixture.js";
import type { Task } from "../src/shared/types.js";

test("WorkBuddy parsing preserves source, chooses named main agent and adapts legacy Skill headers only in derived files", () => {
  const input = workBuddyFiles(),
    original = input.map((file) => file.content.toString("base64"));
  const parsed = parseWorkBuddy(input, Buffer.from("original archive"));
  assert.equal(parsed.package.agentName, "reviewer");
  assert.match(
    parsed.package.agents.reviewer.prompt,
    /^# ORIGINAL_WORKBUDDY_ROLE/,
  );
  assert.equal(
    parsed.package.manifest.unknownExtension instanceof Object,
    true,
  );
  assert.equal(parsed.skills.length, 1);
  assert.match(parsed.skills[0].files[0].content.toString(), /name: reference/);
  assert.ok(
    parsed.package.warnings.some((warning) => warning.includes("头像")),
  );
  assert.deepEqual(
    input.map((file) => file.content.toString("base64")),
    original,
  );
  assert.equal(
    parsed.files.find((file) => file.path === "avatars/other.png")!.content[3],
    255,
  );
});
test("WorkBuddy main role and native preload use declared entry, not the first Agent or appended three-field role", () => {
  const parsed = parseWorkBuddy(workBuddyFiles(), Buffer.from("zip"));
  const task = {
    model: "fixture",
    maxTurns: 5,
    expert: {
      instructions: "DO_NOT_APPEND",
      workbuddy: {
        agentName: parsed.package.agentName,
        agents: parsed.package.agents,
        packageHash: "hash",
      },
    },
    capabilities: {
      skills: [
        {
          name: "reference",
          invocationName: "personal:reference",
          namespace: "personal",
        },
      ],
    },
  } as unknown as Task;
  const options = runnerOptions(
    task,
    { url: "http://fixture", token: "fixture" },
    () => {},
    () => false,
  );
  assert.equal(options.agent, "reviewer");
  assert.ok(
    options.agents!.reviewer.prompt.startsWith(
      parsed.package.agents.reviewer.prompt,
    ),
  );
  assert.deepEqual(options.agents!.reviewer.skills, ["reference"]);
  assert.equal(options.agents!.reviewer.maxTurns, 5);
  assert.ok(!JSON.stringify(options.systemPrompt).includes("DO_NOT_APPEND"));
});
test("WorkBuddy required paths, duplicate Agents and unresolved entry are refused without rewriting source", () => {
  const files = workBuddyFiles();
  assert.throws(
    () =>
      parseWorkBuddy(
        files.filter((file) => !file.path.endsWith("reviewer.md")),
        Buffer.alloc(0),
      ),
    /WORKBUDDY_FILE_MISSING/,
  );
  const manifest = files.find((file) => file.path.endsWith("plugin.json"))!;
  const data = JSON.parse(manifest.content.toString());
  data.agents.push("../outside.md");
  assert.throws(
    () =>
      parseWorkBuddy(
        files.map((file) =>
          file === manifest
            ? { ...file, content: Buffer.from(JSON.stringify(data)) }
            : file,
        ),
        Buffer.alloc(0),
      ),
    /INVALID_PACKAGE_PATH/,
  );
});
// 真实官方ZIP作为额外验收输入，从环境指定，保持第三方原件不进入公开源码。
if (process.env.AH_WORKBUDDY_SAMPLE)
  test("official WorkBuddy ZIP imports without modifying historical metadata or Skill format", async () => {
    const store = new PackageStore("/unused"),
      archive = await readFile(process.env.AH_WORKBUDDY_SAMPLE!);
    const parsed = parseWorkBuddy(await store.unzipFiles(archive), archive);
    assert.equal(parsed.package.agentName, "design-md-architect");
    assert.equal(parsed.skills[0].name, "design-reference");
    assert.ok(store.check(parsed.skills[0].files).report.ok);
    assert.ok(
      parsed.package.warnings.some((warning) => warning.includes("头像")),
    );
  });

test("WorkBuddy executable files retain their mode and do not reuse a non-executable Skill build key", async () => {
  const store = new PackageStore("/unused"),
    base = parseWorkBuddy(workBuddyFiles(), Buffer.from("zip")).skills[0].files;
  const plain = [
    ...base,
    {
      path: "bin/helper",
      content: Buffer.from("#!/bin/sh\necho fixture\n"),
      mode: 0o644,
    },
  ];
  const executable = plain.map((file) =>
    file.path === "bin/helper" ? { ...file, mode: 0o755 } : file,
  );
  assert.notEqual(
    store.check(plain).report.digest,
    store.check(executable).report.digest,
  );
  const files = await store.unzipFiles(await store.pack(executable));
  assert.equal(files.find((file) => file.path === "bin/helper")!.mode, 0o755);
});
