/** 实际SDK + Docker；确定性模型只驱动工具，不代表真实网关或模型验收。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';

const root = resolve('var/v2-verification', String(Date.now()));
const evidence = resolve('var/evidence/persistent');
const calls = [];
const model = fixtureModel(calls);
const results = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
const bash = command => ({ name: 'Bash', input: { command, timeout: 20000 } });
await mkdir(evidence, { recursive: true });
await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const profile = { ...defaultProfile, gatewayUrl: `http://host.docker.internal:${model.server.address().port}`, timeoutMs: 25000 };
const c = new Controller(root, profile);
let conversation;
async function waitFor(test, message, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await test()) return; await pause(100); }
  throw new Error(message);
}
try {
  conversation = await c.open('reuse', 'FAKE_V2_TOKEN');
  calls.push(bash('echo first > /workspace/value'));
  const first = await conversation.run('Run the fixed first tool');
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  const id = first.containerId;
  const engineId = await c.backend.command(['inspect', '--format', '{{.Id}}', id]);
  const config = JSON.parse(await c.backend.command(['inspect',id]))[0];
  assert.equal(config.Config.User, '1000:1000');
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
  assert.equal(config.HostConfig.PidsLimit, 256);
  assert.ok(config.HostConfig.SecurityOpt.some(rule=>rule.startsWith('no-new-privileges')));
  assert.ok(config.HostConfig.SecurityOpt.some(rule=>rule.startsWith('seccomp={')));
  assert.equal(config.Mounts.find(mount=>mount.Destination==='/platform/run').RW,false);
  await writeFile(join(evidence,'persistent-container.json'),JSON.stringify({image:config.Image,entrypoint:config.Config.Entrypoint,command:config.Config.Cmd,user:config.Config.User,hostConfig:config.HostConfig,mounts:config.Mounts},null,2)+'\n');
  await c.backend.command(['exec',id,'sh','-c','echo first > /tmp/v2-marker']);
  // 启动受信测试后台服务，直接验证容器中已有进程跨SDK进程存活。
  await c.backend.command(['exec', '-d', id, 'python3', '-c', 'import time;from pathlib import Path\nwhile True:\n with Path("/workspace/background").open("a") as f:f.write("tick\\n")\n time.sleep(.1)']);
  await waitFor(async () => (await readFile(join(root,'reuse/workspace/background')).catch(() => '')).length > 0, 'background absent');
  calls.push(bash('echo second >> /workspace/value'));
  const second = await conversation.run('Continue with the fixed second tool');
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.equal(second.containerId, id);
  assert.equal(await c.backend.command(['inspect','--format','{{.Id}}',id]), engineId);
  assert.equal(second.sdkSessionId, first.sdkSessionId);
  assert.equal(await c.backend.command(['exec',id,'cat','/tmp/v2-marker']), 'first');
  assert.equal(second.stopped, false);
  assert.equal(second.environment, 'ready');
  assert.equal(await readFile(join(root,'reuse/workspace/value'),'utf8'), 'first\nsecond\n');
  const ticks = await readFile(join(root,'reuse/workspace/background'),'utf8');
  await pause(300);
  assert.ok((await readFile(join(root,'reuse/workspace/background'),'utf8')).length > ticks.length);
  await assert.rejects(c.run('reuse','competing idle writer','fake'), /already running/);
  results.push({ name: 'two native Bash turns reuse exact Engine ID, /tmp, SDK session and background process; idle lock excludes another writer', passed: true, first, second, engineId, backgroundLayer: 'trusted docker exec fixture; not an SDK background-service claim' });
  await conversation.close(); conversation = undefined;
  const stable = await readFile(join(root,'reuse/workspace/background'),'utf8');
  await pause(300);
  assert.equal(await readFile(join(root,'reuse/workspace/background'),'utf8'), stable);
  assert.deepEqual(await c.backend.forSession('reuse'), []);
  results.push({ name: 'close kills background writer, confirms deletion and releases lock', passed: true });

  calls.splice(0, calls.length, bash('python3 /workspace/writer.py'));
  const dir = await c.store.prepare('cancel');
  await writeFile(join(dir,'workspace/writer.py'), 'import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.1)\n');
  conversation = await c.open('cancel', 'FAKE_V2_TOKEN');
  const abort = new AbortController();
  const running = conversation.run('Run the fixed writer', undefined, abort.signal);
  await waitFor(async () => (await readFile(join(dir,'workspace/ticks')).catch(() => '')).length>0, 'native writer absent');
  abort.abort();
  const stopped = await running;
  assert.equal(stopped.status,'cancelled', JSON.stringify(stopped));
  assert.equal(stopped.stopped,false);
  assert.equal(stopped.environment,"ready");
  const before = await readFile(join(dir,'workspace/ticks'),'utf8');
  await pause(300);
  assert.equal(await readFile(join(dir,'workspace/ticks'),'utf8'),before);
  calls.splice(0);
  const resumed = await conversation.run('Continue without replaying writer');
  assert.equal(resumed.status,'succeeded',JSON.stringify(resumed));
  assert.equal(resumed.containerId,stopped.containerId);
  assert.equal(resumed.sdkSessionId,stopped.sdkSessionId);
  results.push({ name:'cancel confirms native writer stopped; following turn keeps container without replay', passed:true, stopped, resumed });
  await conversation.close(); conversation = undefined;

  // 模拟宿主进程被强杀；keeper在失去心跳后停止容器，随后新持锁者核实并回收。
  const script = `import {Controller} from './dist/src/runtime/controller.js';const c=new Controller(${JSON.stringify(root)},${JSON.stringify(profile)});const chat=await c.open('orphan','FAKE_V2_TOKEN');const result=await chat.run('Reply only');console.log('ORPHAN_READY:'+JSON.stringify(result));`;
  const child = spawn(process.execPath,['--input-type=module','-e',script], {stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data', data => output+=data); child.stderr.on('data', data=>output+=data);
  await waitFor(()=>output.includes('ORPHAN_READY:'),'orphan child failed: '+output);
  const orphan = await c.store.load('orphan');
  child.kill('SIGKILL');
  await waitFor(async () => !(await c.backend.inspect(orphan.containerId))?.running,'keeper did not expire',45000);
  results.push({name:'SIGKILL host: keeper stops container within heartbeat grace',passed:true,containerId:orphan.containerId});
  conversation = await c.open('orphan','FAKE_V2_TOKEN');
  const recovered = await conversation.run('Continue after orphan cleanup');
  assert.equal(recovered.status,'succeeded',JSON.stringify(recovered));
  assert.equal(recovered.sdkSessionId,orphan.sdkSessionId);
  assert.notEqual(recovered.containerId,orphan.containerId);
  results.push({name:'next owner reconciles orphan and resumes native session',passed:true});
  await conversation.close(); conversation=undefined;
} finally {
  if (conversation) await conversation.close();
  for (const session of ['reuse','cancel','orphan']) for (const id of await c.backend.forSession(session)) {
    await c.backend.stop(id); await c.backend.destroy(id);
  }
  model.server.closeAllConnections();
  await new Promise(done=>model.server.close(done));
  await writeFile(join(evidence,'summary.json'),JSON.stringify({root,imageId:await c.backend.imageId(profile.image),results,fixtureRequests:model.requests.length,realGatewayRequests:0},null,2)+'\n');
}
console.log(JSON.stringify(results.map(({name,passed})=>({name,passed})),null,2));
