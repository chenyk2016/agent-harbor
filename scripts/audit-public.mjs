/** 检查索引、工作文件与可达历史；只报告位置，不回显匹配到的秘密。 */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const roots = new Set(['apps', 'src', 'infra', 'tests', 'examples', 'docs', 'scripts', 'migrations', 'templates', 'LICENSES', '.github']);
const rootFiles = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'drizzle.config.ts', 'mkdocs.yml', 'requirements-docs.txt', '.env.example', '.gitignore', '.dockerignore']);
const findings = [];
const inspected = new Set();
const rules = [
  ['personal-path', /\/(?:Users|home)\/(?!node(?:\/|$))[A-Za-z0-9._-]+\//],
  ['temporary-attachment', /\/var\/folders\/|\/tmp\/codex|\/private\/tmp\//],
  ['provider-secret', /sk-ant-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['internal-workspace', new RegExp(['codex', 'space'].join('-') + '|' + ['\\.open', 'claw'].join(''))],
  ['old-brand', new RegExp(['claude', 'session', 'runtime'].join('-') + '|C' + 'SR_' + '|c' + 'sr\\.')],
  ['personal-gateway', new RegExp(String(15_721))],
];
function checkPath(path) {
  const parts = path.split('/');
  if ((!rootFiles.has(path) && !roots.has(parts[0])) ||
      parts.includes('evidence') || parts.includes('node_modules') || parts.includes('var') ||
      /(?:^|\/)(?:PROJECT\.md|AGENTS\.local\.md|\.env(?:\..*)?)$/.test(path) && path !== '.env.example' ||
      /\.(?:log|pem|key|p12|pfx|sqlite|db|zip|tar|gz|bundle)$/.test(path))
    findings.push({ location: path, rule: 'non-public-file' });
}
function checkText(text, location) {
  for (const [rule, pattern] of rules) if (pattern.test(text)) findings.push({ location, rule });
  if (Buffer.byteLength(text) > 1024 * 1024) findings.push({ location, rule: 'oversized-file' });
}
const indexed = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
for (const entry of indexed) {
  const [metadata, path] = entry.split('\t');
  const [mode, oid] = metadata.split(' ');
  checkPath(path);
  if (mode !== '100644' && mode !== '100755') findings.push({ location: path, rule: 'link-or-submodule' });
  checkText(git('show', ':' + path), 'index:' + path);
  inspected.add(oid);
  try {
    if (lstatSync(path).isSymbolicLink()) findings.push({ location: path, rule: 'symlink' });
    else checkText(readFileSync(path, 'utf8'), 'worktree:' + path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// 检查所有可达提交，避免删除当前文件却遗漏旧提交中的内容。
const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean);
for (const commit of commits) {
  checkText(git('show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit), 'commit:' + commit.slice(0, 12));
  const tree = git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean);
  for (const entry of tree) {
    const [metadata, path] = entry.split('\t');
    const [mode, type, oid] = metadata.split(' ');
    checkPath(path);
    if (type !== 'blob' || mode === '120000') findings.push({ location: path, rule: 'history-link-or-submodule' });
    if (type === 'blob' && !inspected.has(oid)) {
      checkText(git('cat-file', 'blob', oid), 'history:' + commit.slice(0, 12) + ':' + path);
      inspected.add(oid);
    }
  }
}
if (!indexed.length) findings.push({ location: 'index', rule: 'empty-public-index' });
if (findings.length) {
  console.error(JSON.stringify({ passed: false, findings }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ passed: true, files: indexed.length, commits: commits.length, blobs: inspected.size }));
