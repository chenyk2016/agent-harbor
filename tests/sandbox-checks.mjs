/** 验证原生追加过滤器不会误伤Node线程和普通子进程。 */
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
const checks = [];
const value = await new Promise((done, reject) => {
  const worker = new Worker('require("node:worker_threads").parentPort.postMessage(42)', { eval: true });
  worker.once('message', done);
  worker.once('error', reject);
});
checks.push({ name: 'Node worker thread works', passed: value === 42 });
const child = execFileSync(process.execPath, ['-e', 'process.stdout.write("CHILD_OK")'], { encoding: 'utf8' });
checks.push({ name: 'Node child process works', passed: child === 'CHILD_OK' });
let denied = false;
try {
  execFileSync('unshare', ['-Ur', '/bin/true'], { stdio: 'pipe', env: { ...process.env, SRT_ALLOW_NESTED_USERNS: '1' } });
} catch (error) {
  denied = error.status !== 0 && String(error.stderr).includes('Operation not permitted');
}
checks.push({ name: 'Node child cannot reopen user namespaces', passed: denied });
console.log(JSON.stringify({ checks }));
