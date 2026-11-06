/** 平台不解析或审核技能调用，只验证与普通工具一致的权限和取消行为。 */
import test from "node:test";
import assert from "node:assert/strict";
import { runnerOptions } from "../src/agent/runner-options.js";
import type { Task } from "../src/shared/types.js";
const task: Task = {
  sessionId: "one",
  attemptId: "one",
  generation: 1,
  prompt: "test",
  model: "fixture",
  maxTurns: 10,
  maxBudgetUsd: 1,
  timeoutMs: 1000,
};
test("Skill dispatch belongs to Claude, while cancellation and generic permissions remain", async () => {
  let cancelled = false;
  const options = runnerOptions(
    task,
    { url: "http://fixture", token: "fixture" },
    () => {},
    () => cancelled,
  );
  const invoke = (name: string, input = {}) =>
    options.canUseTool!(name, input, {
      signal: new AbortController().signal,
      toolUseID: "test",
      requestId: "test",
    });
  // 不维护任何技能名字清单：包括未知名字，交给原生Skill返回自己的错误。
  for (const skill of [
    "claude-api",
    "plugin-authoring",
    "personal:unknown",
    "made-up",
  ])
    assert.equal((await invoke("Skill", { skill }))?.behavior, "allow");
  assert.equal((await invoke("WebFetch"))?.behavior, "deny");
  assert.equal(options.env!.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "0");
  assert.ok(Array.isArray(options.tools) && options.tools.includes("Skill"));
  cancelled = true;
  assert.equal(
    (await invoke("Skill", { skill: "claude-api" }))?.behavior,
    "deny",
  );
});

test("expert appends a fixed role without replacing native tools or default skills", () => {
  const expert={schemaVersion:1 as const,expertId:"expert",versionId:"version",version:1,name:"Reviewer",instructions:"EXPERT_ROLE_MARKER",examples:[],digest:"fixed"};
  const options=runnerOptions({...task,expert,capabilities:{schemaVersion:1,imageId:"image",skills:[],digest:"empty"}},{url:"http://fixture",token:"fixture"},()=>{},()=>false);
  assert.deepEqual(options.systemPrompt,{type:"preset",preset:"claude_code",append:"EXPERT_ROLE_MARKER"});
  assert.ok(Array.isArray(options.tools)&&options.tools.includes("Skill"));
  assert.equal(options.env!.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS,"0");
});

test("unlimited execution omits SDK caps, while explicit caps still apply", () => {
  const options = runnerOptions({ ...task, maxTurns: 0, maxBudgetUsd: 0 },
    { url: "http://fixture", token: "fixture" }, () => {}, () => false);
  assert.equal(Object.hasOwn(options, "maxTurns"), false);
  assert.equal(Object.hasOwn(options, "maxBudgetUsd"), false);
  const capped = runnerOptions(task, { url: "http://fixture", token: "fixture" }, () => {}, () => false);
  assert.equal(capped.maxTurns, 10);
  assert.equal(capped.maxBudgetUsd, 1);
});
