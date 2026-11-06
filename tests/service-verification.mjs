/** V3生产入口：真实服务进程、CLI、Docker及SDK，本地确定性模型，无真实模型费用。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { ServiceClient } from '../dist/src/clients/service-client.js';
import { tokenHash } from '../dist/src/service/auth.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';

const root = resolve('var/service-verification', String(Date.now()));
const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/v3/2026-10-22/service');
await mkdir(join(root, '.service'), { recursive: true, mode: 0o700 });
await mkdir(evidence, { recursive: true });
const token = randomUUID();
await writeFile(join(root, '.service/access-keys.json'), JSON.stringify([{ userId: 'test-user', tokenHash: tokenHash(token) }]), { mode: 0o600 });
const calls = [], results = [], services = [], clients = [];
const model = fixtureModel(calls);
await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const controller = new Controller(root);
let service, client, baseUrl;
const pause = ms => new Promise(done => setTimeout(done, ms));
const env = { ...process.env, AH_DATA_DIR: root, AH_SERVICE_TOKEN: token, AH_GATEWAY_TOKEN: 'FIXTURE_ONLY',
  AH_IMAGE: defaultProfile.image, AH_GATEWAY_URL: `http://host.docker.internal:${model.server.address().port}`,
  AH_SERVICE_PORT: '0', AH_IDLE_TIMEOUT_MS: '1800', AH_TASK_TIMEOUT_MS: '30000', AH_INTERRUPT_TIMEOUT_MS: '5000' };
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
async function boot() {
  const child = spawn(process.execPath, ['dist/src/service/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const record = { child, output: () => output };
  services.push(record);
  await wait(() => /Agent Harbor: http:\/\/127.0.0.1:\d+ \(ready\)/.test(output) || child.exitCode !== null, 'service ready');
  assert.equal(child.exitCode, null, output);
  const url = output.match(/http:\/\/127.0.0.1:\d+/)[0];
  service = child; baseUrl = url; client = new ServiceClient(url, token);
}
function bash(command) { calls.splice(0, calls.length, { name: 'Bash', input: { command, timeout: 20000 } }); }
async function terminal(sessionId, text) {
  const file = join(evidence, `${sessionId}-input.txt`);
  await writeFile(file, text);
  const child = spawn(process.execPath, ['dist/src/clients/cli/main.js', 'run', sessionId, '--file', file], {
    env: { ...env, AH_SERVICE_URL: baseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  clients.push({ child, output: () => output });
  return child;
}
async function session() { return client.request('/sessions', 'POST', { title: 'V3 fixture' }); }
async function finished(id, messageId, wanted) {
  await wait(async () => (await client.session(id)).message?.id === messageId && (await client.session(id)).message?.status === wanted, wanted);
  return client.session(id);
}
async function runtime(id) { return controller.store.load(id); }
async function record(name, action) {
  try { results.push({ name, passed: true, detail: await action() }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); throw error; }
  finally { await writeFile(join(evidence, 'summary.json'), JSON.stringify({ root, results, realModelRequests: 0 }, null, 2)); }
}
try {
  await boot();
  await record('CLI killed after tool starts: task finishes; SSE reconnect and multiline input preserved', async () => {
    const s = await session();
    bash('echo started > /workspace/started; sleep 2; echo finished > /workspace/finished');
    const cli = await terminal(s.id, '第一行请求\n  第二行保留缩进\n执行预设命令');
    await wait(async () => (await readFile(join(root, s.id, 'workspace/started')).catch(() => '')).length > 0, 'tool starts');
    const current = await client.session(s.id);
    const before = current.lastEventId;
    const exited = once(cli, 'exit'); cli.kill('SIGKILL'); await exited;
    await finished(s.id, current.message.id, 'succeeded');
    assert.match(await readFile(join(root, s.id, 'workspace/finished'), 'utf8'), /finished/);
    assert.equal((await client.request(`/sessions/${s.id}/messages`))[0].text, '第一行请求\n  第二行保留缩进\n执行预设命令');
    const abort = new AbortController();
    const events = [];
    try {
      for await (const event of client.events(s.id, before, abort.signal)) {
        events.push(event);
        if (event.type === 'message.finished') break;
      }
    } finally { abort.abort(); }
    assert.ok(events.some(event => event.type === 'assistant.text.delta'));
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    calls.splice(0);
    const retry = await client.send(s.id, current.message.clientMessageId, current.message.text);
    assert.equal(retry.message.id, current.message.id);
    assert.equal((await runtime(s.id)).generation, 1);
    return { id: s.id, before, resumedEvents: events.map(event => event.id), runtime: await runtime(s.id) };
  });
  await record('native cancel preserves container, Runner and native PID; close destroys environment', async () => {
    const s = await session();
    bash('echo running > /workspace/running; sleep 20; echo unexpected > /workspace/unexpected');
    const { message } = await client.send(s.id, randomUUID(), 'Run the configured command');
    await wait(async () => (await readFile(join(root, s.id, 'workspace/running')).catch(() => '')).length > 0, 'foreground task');
    const original = await runtime(s.id);
    await client.cancel(s.id, message.id);
    await finished(s.id, message.id, 'cancelled');
    const cancelled = await runtime(s.id);
    assert.equal(cancelled.environment, 'ready', JSON.stringify(cancelled));
    assert.equal(cancelled.stopped, false);
    calls.splice(0);
    const next = (await client.send(s.id, randomUUID(), 'Continue in the same environment')).message;
    await finished(s.id, next.id, 'succeeded');
    const continued = await runtime(s.id);
    assert.equal(continued.containerId, original.containerId);
    assert.equal(continued.runnerId, original.runnerId);
    const log = (await readFile(join(root, s.id, 'attempts', continued.runnerId, 'runner-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(log.filter(event => event.type === 'sdk.spawned').length, 1);
    await assert.rejects(readFile(join(root, s.id, 'workspace/unexpected')));
    await client.close(s.id, next.id);
    await wait(async () => (await client.session(s.id)).environment === 'closed', 'explicit close');
    assert.deepEqual(await controller.backend.forSession(s.id), []);
    return { original, cancelled, continued, native: log.find(event => event.type === 'sdk.spawned').payload };
  });
  await record('idle timer closes environment and preserves files; new message resumes', async () => {
    const s = await session();
    bash('echo kept > /workspace/kept');
    const first = (await client.send(s.id, randomUUID(), 'Write the configured file')).message;
    await finished(s.id, first.id, 'succeeded');
    const original = await runtime(s.id);
    await wait(async () => (await client.session(s.id)).environment === 'closed', 'idle reclaim');
    assert.deepEqual(await controller.backend.forSession(s.id), []);
    calls.splice(0);
    const second = (await client.send(s.id, randomUUID(), 'Continue after idle reclaim')).message;
    await finished(s.id, second.id, 'succeeded');
    const resumed = await runtime(s.id);
    assert.notEqual(resumed.containerId, original.containerId);
    assert.equal(resumed.sdkSessionId, original.sdkSessionId);
    assert.match(await readFile(join(root, s.id, 'workspace/kept'), 'utf8'), /kept/);
    return { original, resumed, testedIdleMs: 1800, productionDefaultMs: 900000 };
  });
  await record('second service is excluded; SIGKILL recovery confirms stop and never replays unfinished input', async () => {
    const second = spawn(process.execPath, ['dist/src/service/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; second.stderr.on('data', data => error += data);
    const [exit] = await once(second, 'exit'); assert.notEqual(exit, 0); assert.match(error, /already running/);
    const s = await session();
    bash('echo before > /workspace/crash; sleep 20; echo after >> /workspace/crash');
    const message = (await client.send(s.id, randomUUID(), 'Run once only')).message;
    await wait(async () => (await readFile(join(root, s.id, 'workspace/crash')).catch(() => '')).length > 0, 'crash task starts');
    const cursor = (await client.session(s.id)).lastEventId;
    const exited = once(service, 'exit'); service.kill('SIGKILL'); await exited;
    await boot();
    const restored = await client.session(s.id);
    assert.equal(restored.message.id, message.id);
    assert.equal(restored.message.status, 'interrupted');
    assert.ok(restored.lastEventId > cursor);
    assert.deepEqual(await controller.backend.forSession(s.id), []);
    assert.equal(await readFile(join(root, s.id, 'workspace/crash'), 'utf8'), 'before\n');
    calls.splice(0);
    const next = (await client.send(s.id, randomUUID(), 'A new explicit request')).message;
    await finished(s.id, next.id, 'succeeded');
    assert.equal((await runtime(s.id)).generation, 2);
    return { id: s.id, restoredMessageStatus: restored.message.status, cursor, restoredCursor: restored.lastEventId };
  });
} finally {
  for (const { child } of clients) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited;
  }
  for (const id of await controller.backend.ownedSessions()) for (const container of await controller.backend.forSession(id)) {
    await controller.backend.stop(container); await controller.backend.destroy(container);
  }
  model.server.closeAllConnections(); await new Promise(done => model.server.close(done));
  for (let i = 0; i < services.length; i++) await writeFile(join(evidence, `server-${i}.log`), services[i].output());
  for (let i = 0; i < clients.length; i++) await writeFile(join(evidence, `cli-${i}.log`), clients[i].output());
  await writeFile(join(evidence, 'final.json'), JSON.stringify({ root, results, imageId: await controller.backend.imageId(defaultProfile.image), remainingSessions: await controller.backend.ownedSessions(), fixtureRequests: model.requests.length, realModelRequests: 0 }, null, 2));
}
