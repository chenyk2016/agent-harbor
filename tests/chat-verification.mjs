/** 真PTY交互 + 实际SDK/Docker；模型仅使用本地确定性夹具。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Controller } from '../dist/src/runtime/controller.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';

const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/chat');
const root = resolve('var/chat-verification', String(Date.now()));
const controller = new Controller(root);
const calls = [];
const model = fixtureModel(calls);
const terminals = [];
const results = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
await mkdir(evidence, { recursive: true });
await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const env = { ...process.env, AH_DATA_DIR: root, AH_GATEWAY_TOKEN: 'FAKE_CHAT_TOKEN',
  AH_GATEWAY_URL: `http://host.docker.internal:${model.server.address().port}` };

// Python标准库只桥接PTY；输入的\x03真正由Node readline处理，不模拟chat函数。
function terminal(args, name) {
  // 显式观察子进程退出；不依赖macOS PTY master一定及时返回EOF。
  const bridge = `import os,pty,select,subprocess,sys
master,slave=pty.openpty()
child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
inputs=[master,sys.stdin.fileno()]
while True:
 ready,_,_=select.select(inputs,[],[],.1)
 for fd in ready:
  try: data=os.read(fd,65536)
  except OSError: data=b''
  if fd==master:
   if data: os.write(sys.stdout.fileno(),data)
  elif data: os.write(master,data)
  else:
   inputs.remove(fd)
   os.write(master,b'\\x04')
 if child.poll() is not None: break
os.close(master)
sys.exit(child.returncode)
`;
  const child = spawn('python3', ['-c', bridge, process.execPath, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const item = { child, name, output: '', closed: false };
  item.ended = new Promise(done => child.once('exit', code => { item.closed = true; done(code); }));
  child.stdout.on('data', data => item.output += data.toString());
  child.stderr.on('data', data => item.output += data.toString());
  terminals.push(item);
  return item;
}
async function waitFor(condition, message) {
  for (let i = 0; i < 450; i++) {
    if (await condition()) return;
    await pause(100);
  }
  throw new Error(message);
}
const prompts = item => item.output.split('你 > ').length - 1;
const bash = command => ({ name: 'Bash', input: { command, timeout: 30_000 } });
async function exit(item, input = '/exit\r') {
  item.child.stdin.write(input);
  await waitFor(() => item.closed, `terminal did not exit: ${item.output}`);
  return item.ended;
}

try {
  calls.push(bash(`python3 -c 'from pathlib import Path;Path("/workspace/chat.txt").write_text("first")'`));
  const first = terminal(['dist/src/clients/cli/local.js', 'chat', 'dialog'], 'multi-turn');
  await waitFor(() => prompts(first) === 1, 'initial prompt absent');
  first.child.stdin.write('\r');
  await waitFor(() => prompts(first) === 2, 'blank line did not return prompt');
  first.child.stdin.write('/help\r');
  await waitFor(() => prompts(first) === 3, 'help did not return prompt');
  assert.equal(model.requests.length, 0);
  first.child.stdin.write('first prompt\r');
  await waitFor(() => prompts(first) === 4, `first round failed: ${first.output}`);
  const before = await controller.store.load('dialog');
  assert.equal(before.status, 'succeeded');
  assert.ok(before.sdkSessionId);
  calls.push(bash(`python3 -c 'from pathlib import Path;p=Path("/workspace/chat.txt");p.write_text(p.read_text()+" second")'`));
  first.child.stdin.write('second prompt\r');
  await waitFor(() => prompts(first) === 5, `second round failed: ${first.output}`);
  const after = await controller.store.load('dialog');
  assert.equal(after.status, 'succeeded');
  assert.equal(after.sdkSessionId, before.sdkSessionId);
  assert.equal(after.generation, 2);
  assert.equal(after.containerId, before.containerId);
  assert.equal(after.stopped, false);
  assert.equal(after.environment, 'ready');
  assert.equal((await controller.backend.inspect(after.containerId)).running, true);
  assert.equal(await readFile(join(root, 'dialog/workspace/chat.txt'), 'utf8'), 'first second');
  assert.ok(first.output.includes('FIXTURE_DONE'));
  assert.ok(first.output.includes('[工具：Bash]'));
  assert.equal(await exit(first), 0);
  results.push({ name: 'real PTY blank/help, two native turns, same SDK ID and persisted files', passed: true });

  const reopened = terminal(['dist/src/clients/cli/local.js', 'chat', 'dialog'], 'reopen');
  await waitFor(() => prompts(reopened) === 1, 'reopen prompt absent');
  reopened.child.stdin.write('continue after reopen\r');
  await waitFor(() => prompts(reopened) === 2, `reopen round failed: ${reopened.output}`);
  const resumed = await controller.store.load('dialog');
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.sdkSessionId, before.sdkSessionId);
  assert.equal(resumed.generation, 3);
  assert.equal(await exit(reopened, '\x03'), 0);
  results.push({ name: 'reopen CLI restores native session; idle Ctrl+C exits', passed: true });

  // 新会话无旧tool_result，因此重置模型调用脚本；原会话此时已退出。
  calls.splice(0, calls.length, bash('python3 /workspace/writer.py'));
  const cancelDir = await controller.store.prepare('cancel');
  await writeFile(join(cancelDir, 'workspace/writer.py'), `import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=Path('/workspace/ticks')\nwhile True:\n with p.open('a') as f: f.write('tick\\n')\n time.sleep(.1)\n`);
  const cancelled = terminal(['dist/src/clients/cli/local.js', 'chat', 'cancel'], 'cancel-resume');
  await waitFor(() => prompts(cancelled) === 1, 'cancel prompt absent');
  cancelled.child.stdin.write('start writer\r');
  await waitFor(async () => (await readFile(join(cancelDir, 'workspace/ticks')).catch(() => '')).length > 0, 'writer never ran');
  cancelled.child.stdin.write('must not run while busy\r');
  await waitFor(() => cancelled.output.includes('输入未提交'), 'busy input not rejected');
  cancelled.child.stdin.write('\x03');
  await waitFor(() => prompts(cancelled) === 2, `cancel never settled: ${cancelled.output}`);
  const stopped = await controller.store.load('cancel');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.environment, "ready");
  assert.equal(stopped.generation, 1);
  const ticks = await readFile(join(cancelDir, 'workspace/ticks'), 'utf8');
  await pause(300);
  assert.equal(await readFile(join(cancelDir, 'workspace/ticks'), 'utf8'), ticks);
  assert.ok((await controller.backend.inspect(stopped.containerId)).running);
  // 恢复后仅回复文本，不能再次启动上轮有副作用的writer。
  calls.splice(0);
  cancelled.child.stdin.write('continue after cancel\r');
  await waitFor(() => prompts(cancelled) === 3, `resume after cancel failed: ${cancelled.output}`);
  const continued = await controller.store.load('cancel');
  assert.equal(continued.status, 'succeeded');
  assert.equal(continued.sdkSessionId, stopped.sdkSessionId);
  assert.equal(continued.generation, 2);
  assert.equal(await exit(cancelled), 0);
  results.push({ name: 'busy input ignored; keyboard Ctrl+C stops native writer; next turn succeeds', passed: true });

  calls.splice(0, calls.length, bash('python3 /workspace/writer.py'));
  const eofDir = await controller.store.prepare('eof');
  await writeFile(join(eofDir, 'workspace/writer.py'), await readFile(join(cancelDir, 'workspace/writer.py')));
  const eof = terminal(['dist/src/clients/cli/local.js', 'chat', 'eof'], 'active-eof');
  await waitFor(() => prompts(eof) === 1, 'EOF prompt absent');
  eof.child.stdin.write('start writer before EOF\r');
  await waitFor(async () => (await readFile(join(eofDir, 'workspace/ticks')).catch(() => '')).length > 0, 'EOF writer never ran');
  assert.equal(await exit(eof, '\x04'), 0);
  const eofState = await controller.store.load('eof');
  assert.equal(eofState.status, 'cancelled');
  assert.equal(eofState.stopped, true);
  const eofTicks = await readFile(join(eofDir, 'workspace/ticks'), 'utf8');
  await pause(300);
  assert.equal(await readFile(join(eofDir, 'workspace/ticks'), 'utf8'), eofTicks);
  assert.deepEqual(await controller.backend.forSession('eof'), []);
  results.push({ name: 'Ctrl+D during native writer waits for cancellation and confirmed cleanup', passed: true });

  calls.splice(0);
  const idleScript = `import {Controller} from './dist/src/runtime/controller.js';import {defaultProfile} from './dist/src/shared/types.js';import {chat} from './dist/src/clients/cli/local-chat.js';const c=new Controller(process.env.AH_DATA_DIR,{...defaultProfile,gatewayUrl:process.env.AH_GATEWAY_URL,idleTimeoutMs:1500});process.exitCode=await chat(c,'idle','fake');`;
  const idle = terminal(['--input-type=module', '-e', idleScript], 'idle-timeout');
  await waitFor(() => prompts(idle) === 1, 'idle prompt absent');
  idle.child.stdin.write('complete then wait idle\r');
  await waitFor(() => idle.closed, `idle timeout failed: ${idle.output}`);
  assert.equal(await idle.ended, 0);
  assert.ok(idle.output.includes('会话空闲超时'));
  assert.equal((await controller.store.load('idle')).stopped, true);
  assert.deepEqual(await controller.backend.forSession('idle'), []);
  results.push({ name: 'shortened idle timeout after native turn closes container and exits', passed: true, configuredIdleMs: 1500 });

  calls.splice(0, calls.length, bash('python3 /workspace/writer.py'));
  const signalDir = await controller.store.prepare('signal');
  await writeFile(join(signalDir,'workspace/writer.py'), await readFile(join(cancelDir,'workspace/writer.py')));
  const signalScript = `console.log('NODE_PID:'+process.pid);await import('./dist/src/clients/cli/local.js');`;
  const signalled = terminal(['--input-type=module','-e',signalScript,'cli','chat','signal'], 'active-sighup');
  // import CLI时argv保持与普通node脚本一致。
  await waitFor(() => prompts(signalled) === 1, `signal prompt absent: ${signalled.output}`);
  signalled.child.stdin.write('writer before disconnect\r');
  await waitFor(async () => (await readFile(join(signalDir,'workspace/ticks')).catch(() => '')).length > 0, 'signal writer absent');
  const nodePid = Number(signalled.output.match(/NODE_PID:(\d+)/)[1]);
  process.kill(nodePid,'SIGHUP');
  await waitFor(() => signalled.closed, 'SIGHUP failed to close CLI');
  assert.equal(await signalled.ended, 0);
  assert.equal((await controller.store.load('signal')).stopped,true);
  const signalTicks = await readFile(join(signalDir,'workspace/ticks'),'utf8');
  await pause(300);
  assert.equal(await readFile(join(signalDir,'workspace/ticks'),'utf8'),signalTicks);
  results.push({name:'SIGHUP during native writer cancels then confirms stopped',passed:true});

  // 仅对UI安全分支注入结果；不伪装成Docker停止故障实验。
  const uncertainScript = `import {Controller} from './dist/src/runtime/controller.js';import {chat} from './dist/src/clients/cli/local-chat.js';const c=new Controller(process.env.AH_DATA_DIR);c.open=async()=>({run:async()=>({sessionId:'uncertain',generation:1,status:'reconciling',stopped:false,error:'INJECTED_STOP_UNKNOWN'}),close:async()=>{}});process.exitCode=await chat(c,'uncertain','fake');`;
  const uncertain = terminal(['--input-type=module', '-e', uncertainScript], 'uncertain-ui');
  await waitFor(() => prompts(uncertain) === 1, 'uncertain UI prompt absent');
  uncertain.child.stdin.write('run once\r');
  await waitFor(() => uncertain.closed, 'uncertain UI did not exit');
  assert.equal(await uncertain.ended, 1);
  assert.equal(prompts(uncertain), 1);
  assert.ok(uncertain.output.includes('环境收尾尚未完成'));
  results.push({ name: 'injected uncertain finalization closes UI without a second prompt', passed: true, layer: 'UI result injection' });

  const failedScript = `import {Controller} from './dist/src/runtime/controller.js';import {chat} from './dist/src/clients/cli/local-chat.js';const c=new Controller(process.env.AH_DATA_DIR);c.open=async()=>({run:async()=>({sessionId:'failure',generation:1,status:'failed',stopped:true,error:'INJECTED_TASK_FAILURE'}),close:async()=>{}});process.exitCode=await chat(c,'failure','fake');`;
  const failure = terminal(['--input-type=module', '-e', failedScript], 'stopped-failure-ui');
  await waitFor(() => prompts(failure) === 1, 'failure prompt absent');
  failure.child.stdin.write('fail once\r');
  await waitFor(() => prompts(failure) === 2, 'stopped failure did not allow next input');
  assert.ok(failure.output.includes('[本轮失败]'));
  assert.equal(await exit(failure, '\x04'), 0);
  results.push({ name: 'injected stopped failure returns to prompt; Ctrl+D exits', passed: true, layer: 'UI result injection' });
} finally {
  // 失败时先取消CLI，再按本测试root归属停止容器，不碰其他会话。
  for (const item of terminals) if (!item.closed) item.child.stdin.write('\x03');
  for (const session of ['dialog', 'cancel', 'eof', 'idle', 'signal'])
    for (const id of await controller.backend.forSession(session)) {
      await controller.backend.stop(id);
      await controller.backend.destroy(id);
    }
  for (const item of terminals) {
    if (!item.closed) item.child.stdin.write('/exit\r');
    await waitFor(() => item.closed, `test terminal still open: ${item.name}`);
    await writeFile(join(evidence, `${item.name}.log`), item.output);
  }
  model.server.closeAllConnections();
  await new Promise(done => model.server.close(done));
  await writeFile(join(evidence, 'summary.json'), JSON.stringify({ root, results, modelRequests: model.requests.length, realGatewayRequests: 0 }, null, 2) + '\n');
}
assert.deepEqual(await controller.backend.forSession('dialog'), []);
assert.deepEqual(await controller.backend.forSession('cancel'), []);
assert.deepEqual(await controller.backend.forSession('eof'), []);
console.log(JSON.stringify(results, null, 2));
