/** Python只供宿主服务调用，不能复制进可公开访问的dist/web。 */
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/src/service/files', { recursive: true });
await copyFile('src/service/files/workspace-access.py', 'dist/src/service/files/workspace-access.py');

await mkdir('dist/src/service/observability', { recursive: true });
for (const name of ['schema.sql', 'report-snapshots.sql'])
  await copyFile('src/service/observability/' + name, 'dist/src/service/observability/' + name);
