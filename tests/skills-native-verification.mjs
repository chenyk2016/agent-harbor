/** 正式Controller/Runner的Skill验收：真实Docker/SDK，固定本地模型，不花费真实模型额度。 */
import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { Controller } from '../dist/src/runtime/controller.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { applicationExpertId, applicationLoginCommand, applicationSkillPluginPath } from '../dist/src/shared/application-skills.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';
const stamp=String(Date.now()), root=resolve('var/skills-native',stamp), evidence=resolve('var/evidence/skills-native',stamp);
await mkdir(evidence,{recursive:true});const calls=[], model=fixtureModel(calls), results=[],events=[];
await new Promise(done=>model.server.listen(0,'0.0.0.0',done));
const controller=new Controller(root,{...defaultProfile,image:process.env.AH_VERIFY_IMAGE??'agent-harbor:0.5.2',gatewayUrl:`http://host.docker.internal:${model.server.address().port}`,timeoutMs:45000,interruptTimeoutMs:10000});
const imageId=await controller.backend.imageId(process.env.AH_VERIFY_IMAGE??'agent-harbor:0.5.2');
const entries=['table-summary','slow-probe'].map(name=>({skillId:randomUUID(),versionId:randomUUID(),version:1,buildId:randomUUID(),name,namespace:'personal',invocationName:'personal:'+name,sourceHash:'fixture',buildHash:'fixture',userInvocable:true}));
const snapshot={schemaVersion:1,imageId,skills:entries,digest:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
let conversation;
const wait=async test=>{for(let i=0;i<300;i++){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out waiting for native state');};
async function bundle(id){
 const directory=await controller.store.prepare(id),plugin=join(directory,'capabilities',snapshot.digest,'personal');
 await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await writeFile(join(plugin,'.claude-plugin/plugin.json'),' {"name":"personal","version":"1.0.0"}');
 for(const name of ['table-summary','slow-probe'])await cp(`tests/fixtures/skill-probe/personal/skills/${name}`,join(plugin,'skills',name),{recursive:true});
 await writeFile(join(plugin,'skills/slow-probe/scripts/slow.sh'),'#!/bin/sh\necho started > /workspace/slow-started\nwhile true; do echo tick >> /workspace/ticks; sleep .05; done\n');
 await writeFile(join(directory,'workspace/probe.csv'),'region,amount\nnorth,10\nsouth,25\n');
 return directory;
}
const bash=command=>({name:'Bash',input:{command,timeout:20000}});
function allResults(){return model.requests.flatMap(body=>(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[])).filter(b=>b.type==='tool_result');}
async function record(name,fn){try{const detail=await fn();results.push({name,passed:true,detail});console.log('PASS',name);}catch(error){results.push({name,passed:false,error:String(error)});throw error;}}
try{
 await record('native Skill, Read, readonly writes and absent unselected files',async()=>{
  const directory=await bundle('permissions');
  calls.push({name:'Skill',input:{skill:'personal:table-summary'}},{name:'Read',input:{file_path:'/opt/harbor-skills/personal/skills/table-summary/SKILL.md'}},bash('python3 /opt/harbor-skills/personal/skills/table-summary/scripts/summarize.py /workspace/probe.csv'),bash('test ! -e /opt/harbor-skills/personal/skills/dyn-probe/SKILL.md && echo UNSELECTED_ABSENT; echo OK > /workspace/skill-output.txt'),bash('echo bad > /opt/harbor-skills/personal/skills/table-summary/blocked.txt'),{name:'Write',input:{file_path:'/opt/harbor-skills/personal/skills/table-summary/blocked-native.txt',content:'bad'}},{name:'Skill',input:{skill:'personal:dyn-probe'}});
  conversation=await controller.open('permissions','FIXTURE_ONLY',{capabilities:snapshot});
  const first=await conversation.run('Use the fixed configured tools',event=>events.push(event));
  assert.equal(first.status,'succeeded',JSON.stringify(first));
  const outputs=allResults();const text=JSON.stringify(outputs);
  assert.match(text,/rows=2/);assert.match(text,/region,amount/);assert.match(text,/UNSELECTED_ABSENT/);
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_1'&&!b.is_error),'Read did not succeed');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_4'&&b.is_error),'Bash write was not rejected');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_5'&&b.is_error),'Write was not rejected');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_6'&&b.is_error),'Unselected Skill was not rejected');
  assert.equal(await readFile(join(directory,'workspace/skill-output.txt'),'utf8'),'OK\n');
  const stream=(await readFile(join(directory,'attempts',first.runnerId,'runner-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!stream.some(e=>e.type==='capabilities.loaded'),'Platform must not add a skill-load checkpoint');
  const inspected=JSON.parse(await controller.backend.command(['inspect',first.containerId]))[0];
  assert.ok(inspected.Mounts.some(m=>m.Destination==='/opt/harbor-skills'&&m.RW===false));
  await conversation.close();conversation=undefined;
  // 同一原生对话恢复时仍绑定旧快照，不重新解析个人默认。
  calls.splice(0);conversation=await controller.open('permissions','FIXTURE_ONLY',{capabilities:snapshot});
  const resumed=await conversation.run('Continue the same capability snapshot');
  assert.equal(resumed.status,'succeeded',JSON.stringify(resumed));assert.equal(resumed.sdkSessionId,first.sdkSessionId);
  await conversation.close();conversation=undefined;return {first,resumed,imageId};
 });
 await record('native interrupt after script starts preserves same Runner for next turn',async()=>{
  const directory=await bundle('interrupt');calls.splice(0,calls.length,bash('bash /opt/harbor-skills/personal/skills/slow-probe/scripts/slow.sh'));
  conversation=await controller.open('interrupt','FIXTURE_ONLY',{capabilities:snapshot});
  const abort=new AbortController();const pending=conversation.run('Run configured long skill script',event=>events.push(event),abort.signal);
  await wait(async()=>!!(await readFile(join(directory,'workspace/ticks')).catch(()=>'' )).length);
  abort.abort();const stopped=await pending;
  assert.equal(stopped.status,'cancelled',JSON.stringify(stopped));assert.equal(stopped.environment,'ready');assert.equal(stopped.stopped,false);
  const ticks=await readFile(join(directory,'workspace/ticks'),'utf8');await new Promise(r=>setTimeout(r,250));assert.equal(await readFile(join(directory,'workspace/ticks'),'utf8'),ticks);
  calls.splice(0);const next=await conversation.run('Continue without restarting the writer',event=>events.push(event));
  assert.equal(next.status,'succeeded',JSON.stringify(next));for(const key of ['containerId','runnerId','sdkSessionId'])assert.equal(next[key],stopped[key]);
  const stream=(await readFile(join(directory,'attempts',stopped.runnerId,'runner-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(stream.some(e=>e.type==='interrupt.receipt'));assert.equal(stream.filter(e=>e.type==='sdk.spawned').length,1);
  await conversation.close();conversation=undefined;return {stopped,next};
 });
 await record('native default Skill works without personal skills; Claude reports unknown skills',async()=>{
  const id='defaults', empty={...snapshot,skills:[],digest:createHash('sha256').update('defaults').digest('hex')};
  await controller.store.prepare(id);
  await mkdir(join(root,id,'capabilities',empty.digest),{recursive:true});
  calls.splice(0,calls.length,{name:'Skill',input:{skill:'claude-api'}},{name:'Skill',input:{skill:'personal:not-selected'}});
  conversation=await controller.open(id,'FIXTURE_ONLY',{capabilities:empty});
  const turn=await conversation.run('Use the configured native default skill',event=>events.push(event));
  assert.equal(turn.status,'succeeded',JSON.stringify(turn));
  const requests=model.requests.filter(body=>JSON.stringify(body).includes('Use the configured native default skill'));
  const outputs=requests.flatMap(body=>(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[])).filter(b=>b.type==='tool_result');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_0'&&!b.is_error),'Native claude-api Skill did not succeed');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_1'&&b.is_error),'Unknown personal skill was not rejected');
  const directory=controller.store.directory(id);
  const stream=(await readFile(join(directory,'attempts',turn.runnerId,'runner-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!stream.some(e=>e.type==='capabilities.loaded'));
  await conversation.close();conversation=undefined;return {turn};
 });
 await record('native dynamic skill preprocessing is left to Claude',async()=>{
  const id='dynamic', entry={...entries[0],name:'dyn-probe',invocationName:'personal:dyn-probe'};
  const selected={...snapshot,skills:[entry],digest:createHash('sha256').update('dynamic').digest('hex')};
  const directory=await controller.store.prepare(id),plugin=join(directory,'capabilities',selected.digest,'personal');
  await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await writeFile(join(plugin,'.claude-plugin/plugin.json'),'{"name":"personal","version":"1.0.0"}');
  await cp('tests/fixtures/skill-probe/personal/skills/dyn-probe',join(plugin,'skills/dyn-probe'),{recursive:true});
  calls.splice(0,calls.length,{name:'Skill',input:{skill:'personal:dyn-probe'}});
  conversation=await controller.open(id,'FIXTURE_ONLY',{capabilities:selected});
  const turn=await conversation.run('Use the exposed dynamic skill');assert.equal(turn.status,'succeeded',JSON.stringify(turn));
  assert.match(await readFile(join(directory,'workspace/dyn-ran.txt'),'utf8'),/^\d+/);
  await conversation.close();conversation=undefined;return {turn};
 });
 await record('Claude owns skill discovery without a platform initialization gate',async()=>{
  const directory=await bundle('missing'),bad={...snapshot,skills:[{...entries[0],name:'missing',invocationName:'personal:missing'}]};
  const before=model.requests.length;calls.splice(0);conversation=await controller.open('missing','FIXTURE_ONLY',{capabilities:bad});
  const result=await conversation.run('Continue with the skills present in the exposed directory');assert.equal(result.status,'succeeded');assert.ok(model.requests.length>before);
  await conversation.close();conversation=undefined;return {result,requests:model.requests.length-before};
 });
 await record('application slash command loads the platform Skill and ordinary chats cannot invoke it',async()=>{
  const instructions='Build the requested application using the native application skill.';
  const expert={schemaVersion:1,expertId:applicationExpertId,versionId:'fixture-v1',version:1,name:'Application expert',instructions,examples:[],digest:createHash('sha256').update(instructions).digest('hex')};
  const applicationStart=model.requests.length;
  calls.splice(0);
  conversation=await controller.open('application-skill','FIXTURE_ONLY',{expert});
  const turn=await conversation.run(applicationLoginCommand+' 为报名页接入访客登录');
  assert.equal(turn.status,'succeeded',JSON.stringify(turn));
  const requests=JSON.stringify(model.requests.slice(applicationStart));
  assert.match(requests,/只允许 Google 登录写/);
  assert.match(requests,/为报名页接入访客登录/);
  const inspected=JSON.parse(await controller.backend.command(['inspect',turn.containerId]))[0];
  assert.ok(inspected.Mounts.some(m=>m.Destination===applicationSkillPluginPath&&m.RW===false));
  await conversation.close();conversation=undefined;
  const ordinaryStart=model.requests.length;
  calls.push({name:'Skill',input:{skill:applicationLoginCommand.slice(1)}});
  conversation=await controller.open('no-application-skill','FIXTURE_ONLY');
  const ordinary=await conversation.run('Try to invoke the application skill');
  assert.equal(ordinary.status,'succeeded',JSON.stringify(ordinary));
  const ordinaryRequests=model.requests.slice(ordinaryStart);
  const outputs=ordinaryRequests.flatMap(body=>body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');
  assert.ok(outputs.some(b=>b.tool_use_id==='toolu_0'&&b.is_error));
  assert.doesNotMatch(JSON.stringify(ordinaryRequests),/只允许 Google 登录写/);
  await conversation.close();conversation=undefined;
  return {turn,ordinary};
 });
}finally{
 if(conversation)await conversation.close().catch(()=>{});
 for(const id of ['permissions','interrupt','defaults','dynamic','missing','application-skill','no-application-skill'])for(const name of await controller.backend.forSession(id)){await controller.backend.stop(name);await controller.backend.destroy(name);}
 model.server.closeAllConnections();await new Promise(done=>model.server.close(done));
 await writeFile(join(evidence,'summary.json'),JSON.stringify({root,imageId,results,fixtureRequests:model.requests.length,realModelRequests:0},null,2)+'\n');
 await writeFile(join(evidence,'model-requests.json'),JSON.stringify(model.requests,null,2)+'\n');
 await writeFile(join(evidence,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 await writeFile('var/evidence/skills-native/latest.json',JSON.stringify({evidence})+'\n');
}
