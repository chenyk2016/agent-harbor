/** Actual Docker/Caddy/PG: restart port drift and per-application failure containment; no model calls. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AppDockerDriver} from '../dist/src/service/applications/docker.js';
import {CaddyApplicationEdge} from '../dist/src/service/applications/edge.js';
import {ApplicationService} from '../dist/src/service/applications/service.js';
import {ApplicationStore} from '../dist/src/service/applications/store.js';
import {Controller} from '../dist/src/runtime/controller.js';
import {SessionManager} from '../dist/src/service/session-manager.js';
import {ServiceStore} from '../dist/src/service/service-store.js';
import {openDatabase} from '../dist/src/service/db/client.js';
import {applyMigrations} from '../dist/src/service/db/migrate.js';
const out=resolve(process.env.AH_PREVIEW_EVIDENCE??'var/evidence/preview-recovery/2026-11-05'),suffix=randomUUID().slice(0,8),root=join(out,'fixture-'+suffix);
await mkdir(root,{recursive:true,mode:0o700});
const driver=new AppDockerDriver(root),pg='ah-preview-pg-'+suffix,caddy='ah-preview-edge-'+suffix,blocker='ah-preview-port-'+suffix;
const containers=new Set(),deployments=[],checks=[],ports=[];let db,manager,service,report={passed:false,realModelRequests:0,checks,ports};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function wait(fn){let last;for(let i=0;i<100;i++){try{return await fn();}catch(e){last=e;await new Promise(r=>setTimeout(r,100));}}throw last;}
async function port(name,p){const x=JSON.parse(await driver.command(['inspect',name]))[0];return Number(x.NetworkSettings.Ports[p+'/tcp'][0].HostPort);}
async function child(command,args,env=process.env){const c=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let output='';c.stdout.on('data',b=>output+=b);c.stderr.on('data',b=>output+=b);const [code]=await once(c,'exit');await writeFile(join(out,command==='npm'?'regression.log':'tests.log'),output);assert.equal(code,0,command+' failed; see evidence log');}
try{
 const password=randomBytes(18).toString('hex');
 containers.add(pg);await driver.command(['run','-d','--name',pg,'--label','harbor.verification=preview-recovery','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','--tmpfs','/var/lib/postgresql:rw,size=512m','postgres:18-alpine']);
 const url=`postgres://postgres:${password}@127.0.0.1:${await port(pg,5432)}/postgres`;
 db=openDatabase(url);await wait(()=>db.pool.query('select 1'));await applyMigrations(db.pool);
 await child('npm',['test'],{...process.env,AH_TEST_DATABASE_URL:url});pass('full regression with disposable PostgreSQL');
 const cfg={admin:{listen:':2019'},apps:{http:{servers:{apps:{listen:[':8080'],routes:[{handle:[{handler:'subroute','@id':'harbor-application-routes',routes:[]}]},{handle:[{handler:'static_response',status_code:404,body:'Application not found'}]}]}}}}};
 await writeFile(join(root,'caddy.json'),JSON.stringify(cfg));containers.add(caddy);
 await driver.command(['run','-d','--name',caddy,'--label','harbor.verification=preview-recovery','-p','127.0.0.1::8080','-p','127.0.0.1::2019','--mount',`type=bind,src=${join(root,'caddy.json')},dst=/etc/caddy/app.json,readonly`,'caddy:2-alpine','caddy','run','--config','/etc/caddy/app.json']);
 const edge=new CaddyApplicationEdge(`http://127.0.0.1:${await port(caddy,2019)}`,`http://127.0.0.1:${await port(caddy,8080)}`,'host.docker.internal');await wait(()=>edge.actual());
 await writeFile(join(root,'server.cjs'),`const c=JSON.parse(require('fs').readFileSync('/run/harbor-app.json'));require('http').createServer((q,r)=>{if(q.url===c.basePath+'__harbor/health'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify(c));}else if(q.url===c.basePath){r.setHeader('Content-Type','text/html');r.end('<h1>'+c.appId+'</h1><p>'+c.deploymentId+'</p>');}else{r.statusCode=404;r.end();}}).listen(3000,'0.0.0.0');`);
 await writeFile(join(root,'Dockerfile'),`FROM agent-harbor:delivery-v29\nCOPY server.cjs /server.cjs\nUSER node\nENTRYPOINT ["node","/server.cjs"]\n`);
 const image='ah-preview-fixture:'+suffix;await driver.command(['build','--pull=false','-t',image,root],120000);const imageId=await driver.imageId(image);
 const store=new ApplicationStore(db.db),controller=new Controller(root);
 manager=new SessionManager(new ServiceStore(db.db),{open:async()=>{throw Error('No Agent execution');}},'fixture-only');
 await manager.identity.importKeys([{userId:'fixture',tokenHash:'fixture-only'}]);
 const opts={root,nodeBase:'fixture',dataAdminUrl:url,creators:new Set(['fixture']),edge};
 const reboot=async()=>{if(service)await service.close();service=new ApplicationService(store,manager,controller,opts);await service.initialize();};
 async function create(appId=randomUUID()){
  const now=Date.now(),revision=randomUUID(),build={id:randomUUID(),appId,revisionId:revision,target:'preview',basePath:`/preview/${appId}/`,imageId};
  if(!(await store.byId(appId))){await db.pool.query('INSERT INTO applications(id,"ownerId",title,status,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$5)',[appId,'fixture','Recovery fixture','active',now]);await db.pool.query('INSERT INTO app_revisions(id,"appId",number,source,manifest,summary,"createdAt") VALUES($1,$2,1,$3,$3,$4,$5)',[revision,appId,{},'fixture',now]);}
  else build.revisionId=(await db.pool.query('SELECT id FROM app_revisions WHERE "appId"=$1',[appId])).rows[0].id;
  await db.pool.query('INSERT INTO app_builds(id,"appId","revisionId",target,status,artifact,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[build.id,appId,build.revisionId,'preview','succeeded',build,now]);
  const d=await driver.create(build,randomUUID(),'postgres://unused');deployments.push(d);await driver.start(d);await driver.healthy(d);await store.registerDeployment(appId,build.id,'preview',d.id,1);await store.deploymentState(d.id,'healthy',d);
  await db.pool.query('INSERT INTO app_endpoints("appId",environment,generation,"desiredDeploymentId","appliedDeploymentId",state) VALUES($1,$2,1,$3,$3,$4) ON CONFLICT("appId",environment) DO UPDATE SET generation=app_endpoints.generation+1,"desiredDeploymentId"=$3,state=$4',[appId,'preview',d.id,'ready']);return d;
 }
 const a=await create(),b=await create();await edge.replace([a,b]);await reboot();
 async function visible(d){const h=await fetch(edge.publicOrigin+d.build.basePath+'__harbor/health');assert.equal(h.status,200);const j=await h.json();assert.equal(j.deploymentId,d.id);assert.equal(j.buildId,d.build.id);const page=await fetch(edge.publicOrigin+d.build.basePath);assert.equal(page.status,200);assert((await page.text()).includes(d.id));}
 await visible(a);await visible(b);pass('two independently routed Docker applications visible');
 const before=a.hostPort;await driver.command(['stop',a.container]);
 // Hold the released dynamic port in the same engine, forcing a real changed binding on start.
 containers.add(blocker);await driver.command(['run','-d','--name',blocker,'-p',`127.0.0.1:${before}:3000`,'--entrypoint','node',image,'-e',"require('http').createServer((q,r)=>{r.statusCode=502;r.end();}).listen(3000,'0.0.0.0')"]);
 await driver.command(['start',a.container]);const actual=await port(a.container,3000);assert.notEqual(actual,before);ports.push({before,after:actual});
 await driver.healthy({...a,hostPort:actual});const stale=await fetch(edge.publicOrigin+a.build.basePath+'__harbor/health');assert.notEqual(stale.status,200);pass('real container stop/start changed dynamic port and reproduced stale route');
 // The running service must notice an external container restart without a manual reconcile.
 await new Promise(r=>setTimeout(r,61000));await visible(a);pass('running service automatically repaired the changed port on its next maintenance tick');
 await reboot();const repaired=(await store.deployment(a.id)).spec;assert.equal(repaired.hostPort,actual);await visible(a);await visible(b);assert.equal((await store.endpoint(a.appId,'preview')).state,'ready');pass('service initialization persisted current port and restored public preview');
 await driver.command(['stop',a.container]);await reboot();assert.equal((await store.endpoint(a.appId,'preview')).state,'reconciling');assert.equal((await fetch(edge.publicOrigin+a.build.basePath)).status,404);await visible(b);pass('failed application quarantined; other preview remains reachable');
 await service.reconcile('fixture',b.appId);await visible(b);const b2=await create(b.appId);await service.reconcile('fixture',b.appId);await visible(b2);assert.equal((await store.endpoint(a.appId,'preview')).state,'reconciling');pass('healthy application reconciles and switches deployment while other application is failing');
 await driver.command(['start',a.container]);await service.reconcile('fixture',a.appId);await visible(a);await visible(b2);pass('failed application independently recovers without disturbing peer');
 await reboot();await visible(a);await visible(b2);pass('second service restart preserves both previews');report.passed=true;
}catch(e){report.error=e instanceof Error?e.message:'VERIFICATION_FAILED';console.log('FAIL '+report.error);process.exitCode=1;}
finally{
 await service?.close().catch(()=>{});await manager?.shutdown().catch(()=>{});await db?.close().catch(()=>{});
 for(const d of deployments)await driver.destroy(d.container).catch(()=>{report.cleanupFailed=true;});
 for(const name of containers)await driver.command(['rm','-f',name]).catch(()=>{report.cleanupFailed=true;});
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
}
