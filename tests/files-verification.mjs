/** 上传→原生工具读写→关闭容器→下载的完整链路。默认本地模型，--real显式使用真实网关。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { tokenHash } from '../dist/src/service/auth.js';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';
const real = process.argv.includes('--real');
const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/v5-files/2026-10-22', real ? 'gateway' : 'native');
const root = resolve('var/files-verification', `${Date.now()}-${real ? 'real' : 'fixture'}`);
await mkdir(evidence, { recursive: true }); await mkdir(join(root, '.service'), { recursive: true, mode: 0o700 });
const key = randomUUID(), uploadId = randomUUID();
await writeFile(join(root, '.service/access-keys.json'), JSON.stringify([{ userId: 'file-test', tokenHash: tokenHash(key) }]), { mode: 0o600 });
const source = `/workspace/uploads/${uploadId}/input.txt`, destination = '/workspace/outputs/result.txt';
const model = real ? undefined : fixtureModel([{ name: 'Bash', input: { command: `mkdir -p /workspace/outputs; cat ${source} > ${destination}; cat ${destination}`, timeout: 10000 } }]);
if (model) await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const child = spawn(process.execPath, ['dist/src/service/server.js'], { env: {
  ...process.env, AH_DATA_DIR: root, AH_SERVICE_PORT: '0', AH_IMAGE: defaultProfile.image,
  ...(model ? { AH_GATEWAY_URL: `http://host.docker.internal:${model.server.address().port}`, AH_GATEWAY_TOKEN: 'FIXTURE_ONLY' } : {}),
}, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', url, headers, sessionId;
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
const report = { passed: false, root, model: real ? 'real gateway' : 'local fixture' };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function wait(check, timeout = 130000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await pause(100); } throw new Error('Timed out'); }
async function request(path, method = 'GET', body, extra = {}) {
  const response = await fetch(url + '/api' + path, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`); return response;
}
try {
  await wait(() => /Agent Harbor: http:\/\/127.0.0.1:\d+ \(ready\)/.test(log) || child.exitCode !== null, 15000);
  assert.equal(child.exitCode, null, log);
  url = log.match(/http:\/\/127.0.0.1:\d+/)[0]; headers = { Origin: url, 'X-Harbor-Client': 'web', 'Content-Type': 'application/json' };
  const login = await request('/auth/login', 'POST', { accessKey: key }); headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  sessionId = (await (await request('/sessions', 'POST', { title: 'V5 file lifecycle acceptance' })).json()).id;
  const content = `V5-${randomUUID()}\n第一行资料\n  第二行缩进\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  const upload = await request(`/sessions/${sessionId}/files/uploads/${uploadId}?name=input.txt`, 'PUT', content, { 'Content-Type': 'application/octet-stream', 'X-Content-Sha256': digest });
  assert.equal(upload.status, 201);
  assert.equal((await (await request(`/sessions/${sessionId}`)).json()).environment, 'closed');
  const prompt = `请实际读取 ${source} 的资料。把原文字节不变地复制为 ${destination}（可以使用Bash的mkdir和cp），再读取成果核对。只操作这两个工作文件。最后说明结果。`;
  const message = (await (await request(`/sessions/${sessionId}/messages`, 'POST', { clientMessageId: randomUUID(), text: prompt })).json()).message;
  let detail;
  await wait(async () => { detail = await (await request(`/sessions/${sessionId}`)).json(); return !['accepted','running','finalizing','reconciling'].includes(detail.message.status); });
  assert.equal(detail.message.status, 'succeeded');
  const runtime = JSON.parse(await readFile(join(root, sessionId, 'session.json'), 'utf8'));
  await request(`/sessions/${sessionId}/close`, 'POST', { expectedMessageId: message.id });
  await wait(async () => (await (await request(`/sessions/${sessionId}`)).json()).environment === 'closed');
  const downloaded = Buffer.from(await (await request(`/sessions/${sessionId}/files/download?path=outputs%2Fresult.txt`)).arrayBuffer());
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), digest);
  assert.equal(downloaded.toString('utf8'), content);
  const events = []; let after = 0, through;
  do {
    const page = await (await request(`/sessions/${sessionId}/history?after=${after}${through === undefined ? '' : `&through=${through}`}`)).json();
    through ??= page.through; events.push(...page.events); if (!page.events.length) break; after = page.events.at(-1).eventId;
  } while (after < through);
  report.passed = true; Object.assign(report, { sessionId, uploadId, sha256: digest, bytes: downloaded.length, tools: events.filter(e => e.type === 'tool.started').map(e => e.payload.name), result: runtime.result, imageId: runtime.imageId, fileReadableAfterContainerClose: true });
  console.log(`PASS ${report.model}: uploaded bytes → native tools → persisted output → closed-container download`);
} catch (error) { report.error = String(error); console.error(report.error); process.exitCode = 1; }
finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  if (model) { model.server.closeAllConnections(); await new Promise(done => model.server.close(done)); }
  report.fixtureRequests = model?.requests.length ?? 0;
  report.remainingSessions = await new Controller(root).backend.ownedSessions();
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(report, null, 2)); await writeFile(join(evidence, 'server.log'), log);
}
