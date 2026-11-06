/** 仅从已审查的提交导出；不把本机工作目录、.git或忽略文件打进源码包。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

execFileSync(process.execPath, ['scripts/audit-public.mjs'], { stdio: 'inherit' });
execFileSync('git', ['diff', '--quiet']);
execFileSync('git', ['diff', '--cached', '--quiet']);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim();
if (untracked) throw new Error('Commit or ignore untracked files before exporting source');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('var/releases', `agent-harbor-${version}.tar.gz`);
mkdirSync('var/releases', { recursive: true });
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=agent-harbor/', '-o', output, 'HEAD']);
console.log(output);
