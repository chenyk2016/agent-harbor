/** 显式真实网关验收：读取已配置的获准网关，独立数据根；会产生模型调用费用。
 * 两轮核对写入文件、上下文延续、Cookie身份与历史补看。无自动业务重试。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokenHash } from '../dist/src/service/auth.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { Controller } from '../dist/src/runtime/controller.js';
const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/v4-web/2026-10-22/gateway');
const root = resolve('var/web-gateway-verification', String(Date.now()));
await mkdir(evidence, { recursive: true });
await mkdir(join(root, '.service'), { recursive: true, mode: 0o700 });
const key = randomUUID();
await writeFile(join(root, '.service/access-keys.json'), JSON.stringify([{ userId: 'gateway-test', tokenHash: tokenHash(key) }]), { mode: 0o600 });
const child = spawn(process.execPath, ['dist/src/service/server.js'], {
  env: { ...process.env, AH_DATA_DIR: root, AH_SERVICE_PORT: '0', AH_IMAGE: defaultProfile.image, AH_TASK_TIMEOUT_MS: '120000' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', url, headers, sessionId;
const report = { root, passed: false, rounds: [], verification: 'real gateway + actual Docker/SDK; browser authenticated HTTP contract' };
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function wait(check, timeout = 130000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await pause(100); } throw new Error('Verification timeout'); }
async function request(path, method = 'GET', body) {
  const response = await fetch(url + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.ok(response.ok, `${response.status} ${value.error}`); return value;
}
try {
  await wait(() => /Agent Harbor: http:\/\/127.0.0.1:\d+ \(ready\)/.test(log) || child.exitCode !== null, 15000);
  assert.equal(child.exitCode, null, 'Service did not start');
  url = log.match(/http:\/\/127.0.0.1:\d+/)[0];
  headers = { Origin: url, 'X-Harbor-Client': 'web', 'Content-Type': 'application/json' };
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ accessKey: key }) });
  assert.equal(login.status, 200); headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  sessionId = (await request('/sessions', 'POST', { title: 'V4 real gateway acceptance' })).id;
  const marker = `harbor-${randomUUID().slice(0, 8)}`;
  const prompts = [
    `这是隔离的开发验收任务。请用Bash把 ${marker} 写入 /workspace/v4-proof.txt，再实际读取这个文件核对。最后回复你实际读到的内容。只操作这个文件。`,
    '继续上轮。请告诉我上轮写入的文件名和标记，再用Read读取这个文件核对，最后回复同一标记。不要修改文件。',
  ];
  let previous;
  for (const text of prompts) {
    const { message } = await request(`/sessions/${sessionId}/messages`, 'POST', { clientMessageId: randomUUID(), text });
    let detail;
    await wait(async () => { detail = await request(`/sessions/${sessionId}`); return !['accepted','running','finalizing','reconciling'].includes(detail.message.status); });
    const runtime = JSON.parse(await readFile(join(root, sessionId, 'session.json'), 'utf8'));
    const history = { events: [] };
    let after = 0, through;
    do {
      const page = await request(`/sessions/${sessionId}/history?after=${after}${through === undefined ? '' : `&through=${through}`}`);
      through ??= page.through;
      history.events.push(...page.events);
      if (!page.events.length) break;
      after = page.events.at(-1).eventId;
    } while (after < through);
    const output = history.events.filter(e => e.messageId === message.id && e.type === 'assistant.text.delta').map(e => e.payload.text).join('');
    report.rounds.push({ messageId: message.id, status: detail.message.status, result: runtime.result, containerId: runtime.containerId, runnerId: runtime.runnerId, sdkSessionId: runtime.sdkSessionId, outputContainsMarker: output.includes(marker), tools: history.events.filter(e => e.messageId === message.id && e.type === 'tool.started').map(e => e.payload.name), error: runtime.error });
    assert.equal(detail.message.status, 'succeeded', `Task failed: ${runtime.error ?? runtime.result?.subtype}`);
    assert.equal((await readFile(join(root, sessionId, 'workspace/v4-proof.txt'), 'utf8')).trim(), marker);
    assert.ok(output.includes(marker), 'Model output did not match actual file');
    if (previous) { assert.equal(runtime.containerId, previous.containerId); assert.equal(runtime.runnerId, previous.runnerId); assert.equal(runtime.sdkSessionId, previous.sdkSessionId); }
    previous = runtime;
  }
  report.passed = true;
  console.log('PASS real gateway: two rounds, actual file verified, same container/Runner/SDK session');
} catch (error) { report.error = String(error); console.error(report.error); process.exitCode = 1; }
finally {
  if (url && sessionId) { const detail = await request(`/sessions/${sessionId}`).catch(() => null); if (detail) await request(`/sessions/${sessionId}/close`, 'POST', { expectedMessageId: detail.lastMessageId }).catch(() => {}); }
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  const controller = new Controller(root);
  report.remainingContainers = sessionId ? await controller.backend.forSession(sessionId) : [];
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, 'server.log'), log);
}
