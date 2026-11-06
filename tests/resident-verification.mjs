/** 正式chat接入验收，非重复可行性实验：实际Docker/SDK，本地确定性模型。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';

const id = String(Date.now());
const root = resolve('var/resident-verification', id);
const evidence = resolve('var/evidence/resident', id);
await mkdir(evidence, { recursive: true });
const calls = [];
const model = fixtureModel(calls);
await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const c = new Controller(root, { ...defaultProfile,
  gatewayUrl: `http://host.docker.internal:${model.server.address().port}`, timeoutMs: 30000 });
const results = [];
const events = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
const bash = command => ({ name: 'Bash', input: { command, timeout: 20000 } });
let conversation;
async function waitFor(test, message) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await test()) return;
    await pause(50);
  }
  throw new Error(message);
}
async function record(name, action) {
  try {
    const detail = await action();
    results.push({ name, passed: true, detail });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    throw error;
  }
}
try {
  await record('production chat retains exact Runner/native PID, routes turns and closes', async () => {
    conversation = await c.open('dialog', 'FAKE_RESIDENT_TOKEN');
    calls.push(bash('echo first > /workspace/value'));
    const first = await conversation.run('Run the configured first command', e => events.push(e));
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    const runnerFile = join(root, 'dialog/attempts', first.runnerId, 'runner-events.jsonl');
    const engine = await c.backend.command(['inspect', first.containerId]);
    const config = JSON.parse(engine)[0];
    assert.ok(config.Config.Cmd.some(arg => /^[a-f0-9-]{36}$/.test(arg)));
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.equal(config.Config.User, '1000:1000');
    calls.push({ name: 'Read', input: { file_path: '/workspace/value' } });
    const second = await conversation.run('Read the file from the prior turn', e => events.push(e));
    assert.equal(second.status, 'succeeded', JSON.stringify(second));
    assert.equal(first.containerId, second.containerId);
    assert.equal(first.runnerId, second.runnerId);
    assert.equal(first.sdkSessionId, second.sdkSessionId);
    const stream = (await readFile(runnerFile, 'utf8')).trim().split('\n').map(JSON.parse);
    const native = stream.filter(e => e.type === 'sdk.spawned');
    assert.equal(native.length, 1);
    assert.ok(native[0].payload.nativePid);
    const inits = stream.filter(e => e.type === 'sdk.session');
    assert.ok(inits.length >= 1);
    assert.equal(new Set(inits.map(e => e.payload.nativePid)).size, 1);
    assert.equal(new Set(inits.map(e => e.payload.runnerPid)).size, 1);
    assert.equal(stream.filter(e => e.type === 'input.accepted').length, 2);
    assert.equal(events.filter(e => e.type === 'agent.result' && e.attemptId === first.attemptId).length, 1);
    assert.equal(events.filter(e => e.type === 'agent.result' && e.attemptId === second.attemptId).length, 1);
    await assert.rejects(c.run('dialog', 'competing idle input', 'fake'), /already running/);
    await conversation.close(); conversation = undefined;
    assert.deepEqual(await c.backend.forSession('dialog'), []);
    assert.equal(await readFile(join(root, 'dialog/attempts', first.runnerId, 'connection.json'), 'utf8'), '{}');
    return { first, second, native: native[0].payload, engineId: config.Id };
  });
  await record('production native interruption stops foreground writer and preserves Runner for next input', async () => {
    calls.splice(0, calls.length, bash('python3 /workspace/writer.py'));
    const directory = await c.store.prepare('cancel');
    const file = join(directory, 'workspace/ticks');
    await writeFile(join(directory, 'workspace/writer.py'), 'import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
    conversation = await c.open('cancel', 'FAKE_RESIDENT_TOKEN');
    const abort = new AbortController();
    const pending = conversation.run('Run the configured writer', e => events.push(e), abort.signal);
    await waitFor(async () => (await readFile(file).catch(() => '')).length > 0, 'writer did not start');
    abort.abort();
    const stopped = await pending;
    assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped));
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.environment, 'ready');
    assert.ok((await c.backend.inspect(stopped.containerId)).running);
    const stable = await readFile(file, 'utf8');
    await pause(250);
    assert.equal(await readFile(file, 'utf8'), stable);
    calls.splice(0);
    const next = await conversation.run('Continue without restarting that writer');
    assert.equal(next.status, 'succeeded', JSON.stringify(next));
    assert.equal(next.sdkSessionId, stopped.sdkSessionId);
    assert.equal(next.runnerId, stopped.runnerId);
    assert.equal(next.containerId, stopped.containerId);
    await conversation.close(); conversation = undefined;
    return { stopped, next };
  });
  await record('idle resident Runner death triggers host cleanup before accepting another input', async () => {
    calls.splice(0);
    conversation = await c.open('crash', 'FAKE_RESIDENT_TOKEN');
    const first = await conversation.run('Reply before the injected idle crash', e => events.push(e));
    assert.equal(first.status, 'succeeded', JSON.stringify(first));
    const raw = await readFile(join(root, 'crash/attempts', first.runnerId, 'runner-events.jsonl'), 'utf8');
    const pid = raw.trim().split('\n').map(JSON.parse).find(e => e.type === 'runner.ready').payload.runnerPid;
    await c.backend.command(['exec', first.containerId, 'node', '-e', 'process.kill(Number(process.argv[1]),"SIGKILL")', String(pid)]);
    await waitFor(async () => (await c.store.load('crash')).stopped === true, 'host did not confirm idle crash cleanup');
    assert.deepEqual(await c.backend.forSession('crash'), []);
    const next = await conversation.run('A new message after confirmed cleanup');
    assert.equal(next.status, 'succeeded', JSON.stringify(next));
    assert.equal(next.sdkSessionId, first.sdkSessionId);
    assert.notEqual(next.containerId, first.containerId);
    await conversation.close(); conversation = undefined;
    return { first, next, killedRunnerPid: pid };
  });
} finally {
  if (conversation) await conversation.close();
  for (const name of ['dialog', 'cancel', 'crash'])
    for (const container of await c.backend.forSession(name)) {
      await c.backend.stop(container);
      await c.backend.destroy(container);
    }
  model.server.closeAllConnections();
  await new Promise(done => model.server.close(done));
  const summary = { id, root, imageId: await c.backend.imageId(defaultProfile.image),
    results, realModelRequests: 0, fixtureRequests: model.requests.length };
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(evidence, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(evidence, 'model-requests.json'), JSON.stringify(model.requests, null, 2) + '\n');
  await writeFile(resolve('var/evidence/resident/latest.json'), JSON.stringify({ id, evidence }, null, 2) + '\n');
}
