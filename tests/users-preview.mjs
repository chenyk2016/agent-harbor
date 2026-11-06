/** V6浏览器验收专用服务：独立测试数据，无真实网关，不触碰开发用户。 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tokenHash } from '../dist/src/service/auth.js';
const root = resolve('var/users-preview');
await mkdir(join(root,'.service'),{recursive:true,mode:0o700});
await writeFile(join(root,'.service/access-keys.json'),JSON.stringify([
  {userId:'v6-test-a',tokenHash:tokenHash('v6-fixture-a')},
  {userId:'v6-test-b',tokenHash:tokenHash('v6-fixture-b')},
]),{mode:0o600});
const child=spawn(process.execPath,['dist/src/service/server.js'],{env:{...process.env,AH_DATA_DIR:root,AH_GATEWAY_TOKEN:'FIXTURE_UNUSED',AH_SERVICE_PORT:'8436',AH_IMAGE:'agent-harbor:0.4.0',AH_ADMIN_USERS:'v6-test-a'},stdio:'inherit'});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill('SIGTERM'));
child.once('exit',code=>{process.exitCode=code??1;});
