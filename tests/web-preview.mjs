/** 手动浏览器验收入口：真实服务、SQLite、Docker、SDK；模型响应由本地fixture提供。
 * 使用独立var目录和公开的测试密钥，不读取个人.env，不连接真实模型。
 * Ctrl+C停止本次测试服务，正常清理其容器；保留证据供检查。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tokenHash } from '../dist/src/service/auth.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';
const root = resolve('var/web-preview');
await mkdir(join(root, '.service'), { recursive: true, mode: 0o700 });
await writeFile(join(root, '.service/access-keys.json'), JSON.stringify([{ userId: 'web-test', tokenHash: tokenHash('web-fixture-only') }]), { mode: 0o600 });
const model = fixtureModel([{ name: 'Bash', input: { command: 'echo started > /workspace/web-started; sleep 45; echo finished > /workspace/web-finished', timeout: 55000 } }]);
await new Promise(done => model.server.listen(0, '0.0.0.0', done));
const child = spawn(process.execPath, ['dist/src/service/server.js'], { env: {
  ...process.env, AH_DATA_DIR: root, AH_GATEWAY_TOKEN: 'FIXTURE_ONLY', AH_IMAGE: 'agent-harbor:0.4.0',
  AH_GATEWAY_URL: `http://host.docker.internal:${model.server.address().port}`, AH_SERVICE_PORT: '8435', AH_TASK_TIMEOUT_MS: '60000', AH_IDLE_TIMEOUT_MS: '900000',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; process.stdout.write(data); });
child.stderr.on('data', data => { output += data; process.stderr.write(data); });
console.log('TEST ONLY: login web-fixture-only; local model fixture, real Docker/SDK.');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill('SIGTERM'));
child.once('exit', async code => {
  model.server.closeAllConnections(); model.server.close();
  await writeFile(join(root, 'preview.log'), output);
  await writeFile(join(root, 'model-summary.json'), JSON.stringify({ fixtureRequests: model.requests.length, realModelRequests: 0 }));
  process.exitCode = code ?? 1;
});
