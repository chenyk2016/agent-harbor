/** Isolated real LiteLLM + SDK/Docker + optional browser; deterministic model fixtures, no vendor spend. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const config={gateway:process.env.AH_VERIFY_LITELLM_URL,master:process.env.AH_VERIFY_LITELLM_KEY};
if(!config.gateway || !config.master)throw Error('Use an isolated LiteLLM and set AH_VERIFY_LITELLM_URL/KEY plus AH_TEST_DATABASE_URL');
const evidence=resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/model-switching/2026-10-28');
await mkdir(evidence,{recursive:true});
const {testDatabase}=await import('../dist/tests/pg.js');
const {fixtureModel}=await import('../dist/tests/fixture-model.js');
const {LlmService}=await import('../dist/src/service/llm/service.js');
const {ServiceStore}=await import('../dist/src/service/service-store.js');
const {SessionManager}=await import('../dist/src/service/session-manager.js');
const {Controller}=await import('../dist/src/runtime/controller.js');
const {defaultProfile}=await import('../dist/src/shared/types.js');
const {createApi}=await import('../dist/src/service/http-api.js');
const {tokenHash}=await import('../dist/src/service/auth.js');
const fixtures=['a','b'].map(name=>fixtureModel([],body=>{
 const last=body.messages?.at(-1);const content=last?.content;
 const lastUserTextIndex=body.messages.findLastIndex(m=>m.role==='user' && (typeof m.content==='string' || (Array.isArray(m.content)&&m.content.some(b=>b.type==='text' && /Remember HISTORY_ONLY_|Continue the previous conversation/.test(b.text)))));
 const tail=body.messages.slice(lastUserTextIndex);
 if(tail.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')))return undefined;
 return {name:'Write',input:{file_path:'/workspace/route.txt',content:'target-'+name}};
}));
for(const f of fixtures)await new Promise(r=>f.server.listen(0,'0.0.0.0',r));
const root=join(evidence,'native-'+Date.now());await mkdir(root,{recursive:true});
const db=await testDatabase();const store=new ServiceStore(db.db),controller=new Controller(root,{...defaultProfile,image:process.env.AH_VERIFY_IMAGE ?? 'agent-harbor:model-switch-verify',timeoutMs:90000});
const manager=new SessionManager(store,controller,'fixture-legacy',120000,4);
const llm=new LlmService(db.db,join(root,'.service'),{managementUrl:config.gateway,inferenceUrl:config.gateway.replace('127.0.0.1','host.docker.internal'),masterKey:config.master});
const access='fixture-'+randomUUID();await manager.identity.importKeys([{userId:'switch-fixture',tokenHash:tokenHash(access)}]);
const server=createApi(manager,controller,undefined,{adminUsers:['switch-fixture']},undefined,undefined,undefined,llm);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
async function api(path,method='GET',body){const r=await fetch(origin+'/api'+path,{method,headers:{Authorization:'Bearer '+access,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();assert(r.ok,JSON.stringify({path,status:r.status,v}));return v;}
const models=[],rounds=[];
try{
 for(let i=0;i<2;i++){
 const p=await api('/admin/llm/providers','POST',{name:'Fixture '+i,format:'anthropic_compatible',apiBase:'http://host.docker.internal:'+fixtures[i].server.address().port,apiKey:'fixture-only'});
 const detail=await api('/admin/llm/deployments','POST',{name:'Route '+i,providerId:p.id,upstreamModel:'target-'+['a','b'][i],tools:true,streaming:true});models.push({id:detail.deployment.id,versionId:detail.versions[0].id,alias:detail.versions[0].routeName});
 }
 const session=await api('/sessions','POST',{title:'A-B-A switch',deploymentId:models[0].id});
 const other=await api('/sessions','POST',{title:'Independent',deploymentId:models[0].id});
 const otherKey=await llm.runtime(other);
 const marker='HISTORY_ONLY_'+randomUUID();
 let nativeId,containerId,runnerId,token;
 for(const [index,which]of[0,1,0].entries()){
 const text=index===0?'Remember '+marker+' and write the route marker.':'Continue the previous conversation round '+index;
 const m=await api('/sessions/'+session.id+'/messages','POST',{clientMessageId:randomUUID(),text,deploymentId:models[which].id});
 let terminal;for(let i=0;i<360;i++){const d=await api('/sessions/'+session.id);if(d.message&&!['accepted','running','finalizing','reconciling'].includes(d.message.status)){terminal=d;break;}await new Promise(r=>setTimeout(r,250));}
 assert.equal(terminal?.message.status,'succeeded',JSON.stringify(terminal));
 const runtime=JSON.parse(await readFile(join(root,session.id,'session.json'),'utf8'));
 const connection=await llm.runtime(terminal);
 const output=await readFile(join(root,session.id,'workspace/route.txt'),'utf8');
 assert.equal(output,'target-'+['a','b'][which]);assert.equal(terminal.message.activatedModelSnapshot.deploymentId,models[which].id);
 if(index===0){nativeId=runtime.sdkSessionId;containerId=runtime.containerId;runnerId=runtime.runnerId;token=connection.token;}
 else{assert.equal(runtime.sdkSessionId,nativeId);assert.equal(runtime.containerId,containerId);assert.equal(runtime.runnerId,runnerId);assert.equal(connection.token,token);assert(JSON.stringify(fixtures[which].requests.at(-1)).includes(marker),'history survives without reading files');}
 rounds.push({index,target:which,status:terminal.message.status,sdkSessionId:runtime.sdkSessionId,containerId:runtime.containerId,runnerId:runtime.runnerId});
 }
 const info=await llm.client.keyInfo(otherKey.token);assert.equal(info.info.aliases[otherKey.model],models[0].alias);
 await writeFile(join(evidence,'native-result.json'),JSON.stringify({passed:true,rounds,requests:fixtures.map(f=>f.requests.length),checks:['same container/Runner/native session/key','history-only marker preserved','actual tool write reflects A-B-A','other session route unchanged']},null,2));
 if(process.env.AH_PLAYWRIGHT_MODULE){
 const {chromium}=await import(process.env.AH_PLAYWRIGHT_MODULE);const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(origin);await page.getByPlaceholder('输入管理员提供的访问密钥').fill(access);await page.getByRole('button',{name:'登录工作台',exact:true}).click();
 await page.goto(origin+'/sessions/'+session.id);
 const picker=page.getByRole('combobox',{name:'下一条消息使用的模型'});await picker.waitFor();
 await picker.click();await page.getByRole('option',{name:'Route 1',exact:true}).click();
 await page.getByRole('textbox',{name:'消息内容'}).fill('Continue the previous conversation browser turn');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByRole('button',{name:'停止本轮',exact:true}).waitFor();
 // During generation only the next draft changes; the in-flight target stays Route 1.
 await picker.click();await page.getByRole('option',{name:'Route 0',exact:true}).click();
 await page.getByRole('button',{name:'发送消息',exact:true}).waitFor({timeout:60000});
 const d=await api('/sessions/'+session.id);assert.equal(d.message.status,'succeeded');assert.equal(d.message.activatedModelSnapshot.id,models[1].id);
 const runtime=JSON.parse(await readFile(join(root,session.id,'session.json'),'utf8'));assert.equal(runtime.containerId,containerId);
 assert.equal(await picker.textContent(),'Route 0');
 await page.screenshot({path:join(evidence,'browser-model-picker.png'),fullPage:true});
 await page.reload();await picker.waitFor();assert.equal(await picker.textContent(),'Route 0');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'browser-model-picker-mobile.png'),fullPage:true});
 assert.equal(errors.length,0,JSON.stringify(errors));
 await writeFile(join(evidence,'browser-result.json'),JSON.stringify({passed:true,checks:['composer selector','selection during active turn affects only next draft','server used sent model','same container','selection survives reload','desktop and mobile'],errors},null,2));
 }finally{await browser.close();}
 }
 console.log(JSON.stringify({passed:true,rounds,origin}));
}finally{
 await writeFile(join(evidence,'fixture-messages.json'),JSON.stringify(fixtures.map(f=>f.requests.map(r=>({model:r.model,messages:r.messages.slice(-3)}))),null,2));
 await manager.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));
 for(const f of fixtures){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}
 await llm.recover();await db.close();
}
