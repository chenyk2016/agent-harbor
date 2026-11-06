import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerBackend } from '../src/docker/docker.js';
import { defaultProfile, type Task } from '../src/shared/types.js';
import { runnerOptions } from '../src/agent/runner-options.js';

test('cache mounts follow authenticated user, while dependency environments remain session-specific', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ah-dependencies-'));
  try {
    const docker = new DockerBackend(root);
    docker.inspect = async () => undefined;
    const creations: string[][] = [];
    docker.command = async args => { creations.push(args); return 'created'; };
    for (const [sessionId, key] of [['one', 'a'.repeat(64)], ['two', 'a'.repeat(64)], ['three', 'b'.repeat(64)]]) {
      const directory = join(root, sessionId), attempt = join(directory, 'attempt');
      await mkdir(attempt, {recursive:true});
      await docker.create({sessionId, attemptId:sessionId, dependencyCacheKey:key, networkDomains:['example.com']} as Task, defaultProfile, directory, attempt);
      const policy = JSON.parse(await readFile(join(attempt, 'managed-settings.json'), 'utf8'));
      assert.ok(policy.sandbox.network.allowedDomains.includes('pypi.org'));
      assert.ok(policy.sandbox.network.allowedDomains.includes('example.com'));
      assert.ok(policy.sandbox.filesystem.denyRead.includes('/platform'));
    }
    const mount = (args:string[], target:string) => args.find(arg=>arg.endsWith(`dst=${target}`));
    assert.equal(mount(creations[0], '/dependency-cache'), mount(creations[1], '/dependency-cache'));
    assert.notEqual(mount(creations[0], '/dependency-cache'), mount(creations[2], '/dependency-cache'));
    assert.notEqual(mount(creations[0], '/session-env'), mount(creations[1], '/session-env'));
    await assert.rejects(docker.create({sessionId:'bad',attemptId:'bad',dependencyCacheKey:'../escape'} as Task, defaultProfile, root, root), /Invalid dependency cache key/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('SDK keeps Claude config protected while package tools use writable session and cache paths', () => {
  const options = runnerOptions({} as Task, {url:'http://fixture',token:'unused'},()=>{},()=>false);
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, '/platform/state');
  assert.equal(options.env?.HOME, '/platform/state');
  assert.equal(options.env?.PATH, '/usr/local/bin:/usr/bin:/bin');
});

test('dependency environment is scoped to sandbox commands and explicit sandbox bypass is refused', async () => {
  const options = runnerOptions({} as Task, {url:'http://fixture',token:'unused'},()=>{},()=>false);
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const input = {hook_event_name:'PreToolUse' as const,session_id:'fixture',transcript_path:'fixture',cwd:'/workspace',tool_name:'Bash',tool_use_id:'fixture',tool_input:{command:'python script.py'}};
  const result = await hook(input, 'fixture', {signal:new AbortController().signal});
  assert.ok('hookSpecificOutput' in result);
  const output = (result as {hookSpecificOutput:{updatedInput:Record<string,unknown>;permissionDecision:string}}).hookSpecificOutput;
  assert.match(String(output.updatedInput.command), /PATH='\/session-env\/venv\/bin:/);
  assert.equal(output.updatedInput.dangerouslyDisableSandbox, false);
  const denied = await hook({...input,tool_input:{command:'echo unsafe',dangerouslyDisableSandbox:true}},'fixture',{signal:new AbortController().signal});
  assert.equal((denied as {hookSpecificOutput:{permissionDecision:string}}).hookSpecificOutput.permissionDecision,'deny');
});
