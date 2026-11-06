/** 正式默认后端的原生运行、恢复和取消；本地假模型，不请求真实网关。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';

const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/native');
const root = resolve('var/native-lifecycle', String(Date.now()));
const results = [];
const controllers = [];
const createdConfigs = [];
const fixtures = [];
const pause = ms => new Promise(done => setTimeout(done, ms));

async function makeController(calls) {
  const fixture = fixtureModel(calls);
  fixtures.push(fixture);
  await new Promise(done => fixture.server.listen(0, '0.0.0.0', done));
  const controller = new Controller(root, { ...defaultProfile,
    gatewayUrl: `http://host.docker.internal:${fixture.server.address().port}`,
    timeoutMs: 20_000,
  });
  controllers.push(controller);
  const create = controller.backend.create.bind(controller.backend);
  controller.backend.create = async (...args) => {
    const name = await create(...args);
    // 只读核对正式后端产生的配置，不注入或修改容器。
    const data = JSON.parse(await controller.backend.command(['inspect', name]))[0];
    assert.equal(data.State.Running, false);
    assert.equal(data.Config.User, '1000:1000');
    assert.equal(data.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(data.HostConfig.CapDrop, ['ALL']);
    // CLI systempaths=unconfined 会取消全部路径遮蔽；不要误断言还保留 /sys 保护。
    assert.deepEqual(data.HostConfig.MaskedPaths, []);
    assert.deepEqual(data.HostConfig.ReadonlyPaths, []);
    assert.equal(data.HostConfig.PidsLimit, 256);
    assert.equal(data.HostConfig.Memory, 4 * 1024 ** 3);
    assert.ok(data.HostConfig.SecurityOpt.some(rule => rule.startsWith('seccomp={')));
    assert.ok(data.HostConfig.SecurityOpt.some(rule => rule.startsWith('no-new-privileges')));
    createdConfigs.push({ name, image: data.Image, user: data.Config.User, hostConfig: data.HostConfig, mounts: data.Mounts });
    return name;
  };
  return { controller, fixture };
}

function bash(command) { return { name: 'Bash', input: { command, timeout: 15_000 } }; }

try {
  const calls = [bash(`python3 -c 'from pathlib import Path;Path("/workspace/count.txt").write_text("first")'`)];
  const { controller, fixture } = await makeController(calls);
  const first = await controller.run('resume', 'Run the fixed first command', 'FAKE_LIFECYCLE_TOKEN');
  assert.equal(first.status, 'succeeded');
  assert.equal(first.stopped, true);
  assert.ok(first.sdkSessionId);
  assert.equal(await readFile(join(root, 'resume/workspace/count.txt'), 'utf8'), 'first');
  assert.deepEqual(await controller.backend.forSession('resume'), []);
  results.push({ name: 'native run and confirmed cleanup', passed: true, session: first });

  calls.push(bash(`python3 -c 'from pathlib import Path;p=Path("/workspace/count.txt");p.write_text(p.read_text()+" second")'`));
  const second = await controller.run('resume', 'Continue with the fixed second command', 'FAKE_LIFECYCLE_TOKEN');
  assert.equal(second.status, 'succeeded');
  assert.equal(second.stopped, true);
  assert.equal(second.sdkSessionId, first.sdkSessionId);
  assert.equal(second.generation, first.generation + 1);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(await readFile(join(root, 'resume/workspace/count.txt'), 'utf8'), 'first second');
  assert.deepEqual(await controller.backend.forSession('resume'), []);
  for (const session of [first, second])
    assert.deepEqual(JSON.parse(await readFile(join(root, 'resume/attempts', session.attemptId, 'connection.json'), 'utf8')), {});
  results.push({ name: 'new container resumes same native session and files', passed: true, session: second, fixtureRequests: fixture.requests.length });

  // 通过默认后端创建真实环境，验证放行初始化后项目命令仍受到后置限制。
  const isolation = await makeController([bash('python3 /workspace/checks.py && node /workspace/checks.mjs')]);
  const isolationDirectory = await isolation.controller.store.prepare('isolation');
  await writeFile(join(isolationDirectory, 'workspace/checks.py'), await readFile('tests/sandbox-checks.py'));
  await writeFile(join(isolationDirectory, 'workspace/checks.mjs'), await readFile('tests/sandbox-checks.mjs'));
  const isolated = await isolation.controller.run('isolation', 'Run the fixed isolation checks', 'FAKE_LIFECYCLE_TOKEN');
  assert.equal(isolated.status, 'succeeded', isolated.error);
  const toolResults = isolation.fixture.requests.flatMap(body => (body.messages ?? []).flatMap(message =>
    Array.isArray(message.content) ? message.content : [])).filter(block => block.type === 'tool_result');
  const output = toolResults.flatMap(block => Array.isArray(block.content)
    ? block.content.map(part => part.text ?? '') : [String(block.content)]).join('\n');
  const checks = output.split('\n').filter(line => line.startsWith('{"checks":')).flatMap(line => JSON.parse(line).checks);
  assert.equal(checks.length, 16, output);
  assert.ok(checks.every(check => check.passed), JSON.stringify(checks));
  assert.equal(isolated.stopped, true);
  results.push({ name: 'default backend namespace denial and ordinary concurrency', passed: true, checks });

  const cancelCase = await makeController([bash('python3 /workspace/writer.py')]);
  const cancelDirectory = await cancelCase.controller.store.prepare('cancel');
  await writeFile(join(cancelDirectory, 'workspace/writer.py'), `import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=Path('/workspace/heartbeat')\nwhile True:\n with p.open('a') as f: f.write('tick\\n')\n time.sleep(.1)\n`);
  const abort = new AbortController();
  const running = cancelCase.controller.run('cancel', 'Run the fixed writer', 'FAKE_LIFECYCLE_TOKEN', () => {}, abort.signal);
  let ready = false;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      ready = await stat(join(cancelDirectory, 'workspace/heartbeat')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (ready) break;
      await pause(100);
    }
  } finally {
    abort.abort();
  }
  const cancelled = await running;
  assert.ok(ready, 'writer never started');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stopped, true);
  const heartbeat = await readFile(join(cancelDirectory, 'workspace/heartbeat'), 'utf8');
  await pause(300);
  assert.equal(await readFile(join(cancelDirectory, 'workspace/heartbeat'), 'utf8'), heartbeat);
  assert.deepEqual(await cancelCase.controller.backend.forSession('cancel'), []);
  results.push({ name: 'cancel active native writer and confirm no further writes', passed: true, session: cancelled });
} finally {
  // 只处理本实验root拥有的会话容器；任何状态不确定都不直接删除。
  for (const controller of controllers) {
    for (const session of ['resume', 'cancel', 'isolation']) {
      for (const id of await controller.backend.forSession(session)) {
        await controller.backend.stop(id);
        await controller.backend.destroy(id);
      }
    }
  }
  for (const fixture of fixtures) {
    fixture.server.closeAllConnections();
    await new Promise(done => fixture.server.close(done));
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'native-lifecycle.json'), JSON.stringify({ root, results, createdConfigs }, null, 2) + '\n');
}
console.log(JSON.stringify(results.map(result => ({ name: result.name, passed: result.passed })), null, 2));
