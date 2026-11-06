/** 实际 Docker/SDK 验证角色追加、持续对话与恢复；模型只用本地固定响应。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Controller} from '../dist/src/runtime/controller.js';
import {defaultProfile} from '../dist/src/shared/types.js';
import {fixtureModel} from '../dist/tests/fixture-model.js';
const stamp=String(Date.now()),root=resolve('var/experts-native',stamp),evidence=resolve('var/evidence/experts/2026-10-24',`native-${stamp}.json`);
await mkdir(root,{recursive:true});const calls=[],model=fixtureModel(calls),results=[];
await new Promise(done=>model.server.listen(0,'0.0.0.0',done));
const image=process.env.AH_VERIFY_IMAGE??'agent-harbor:0.5.3';
const controller=new Controller(root,{...defaultProfile,image,gatewayUrl:`http://host.docker.internal:${model.server.address().port}`,timeoutMs:45000,interruptTimeoutMs:10000});
const imageId=await controller.backend.imageId(image);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capabilities={schemaVersion:1,imageId,skills:[],digest:hash([imageId,[]])};
const expert={schemaVersion:1,expertId:randomUUID(),versionId:randomUUID(),version:1,name:'Reviewer',instructions:'HARBOR_EXPERT_ROLE_V1: review the supplied material.',examples:[],digest:hash('expert-v1')};
let conversation;
const wait=async check=>{for(let i=0;i<300;i++){if(await check())return;await new Promise(done=>setTimeout(done,50));}throw new Error('native state timeout');};
async function record(name,work){try{await work();results.push({name,passed:true});console.log('PASS',name);}catch(error){results.push({name,passed:false,error:String(error)});throw error;}}
async function bundle(id,snapshot){const dir=await controller.store.prepare(id);await mkdir(join(dir,'capabilities',snapshot.digest),{recursive:true});await writeFile(join(dir,'capabilities',snapshot.digest,'manifest.json'),JSON.stringify(snapshot));return dir;}
try {
 await record('role reaches Claude, two turns reuse Runner, and resume keeps the same expert',async()=>{
  await bundle('expert',capabilities);conversation=await controller.open('expert','FIXTURE_ONLY',{capabilities,expert});
  const first=await conversation.run('Review the first document');assert.equal(first.status,'succeeded',JSON.stringify(first));
  const second=await conversation.run('Continue reviewing');assert.equal(second.status,'succeeded',JSON.stringify(second));assert.equal(second.containerId,first.containerId);assert.equal(second.sdkSessionId,first.sdkSessionId);assert.equal(second.expertDigest,expert.digest);
  assert.ok(model.requests.length>=2);assert.ok(model.requests.every(body=>JSON.stringify(body.system).includes('HARBOR_EXPERT_ROLE_V1')));assert.ok(model.requests[0].tools.some(tool=>tool.name==='Skill'));
  await conversation.close();conversation=undefined;
  conversation=await controller.open('expert','FIXTURE_ONLY',{capabilities,expert});const resumed=await conversation.run('Resume the same expert');assert.equal(resumed.status,'succeeded',JSON.stringify(resumed));assert.equal(resumed.sdkSessionId,first.sdkSessionId);assert.equal(resumed.expertDigest,expert.digest);await conversation.close();conversation=undefined;
 });
 await record('changed expert cannot resume an old native conversation',async()=>{
  const count=model.requests.length;conversation=await controller.open('expert','FIXTURE_ONLY',{capabilities,expert:{...expert,instructions:'different',digest:'different'}});
  await assert.rejects(conversation.run('Do not execute'),/Session expert changed/);assert.equal(model.requests.length,count);await conversation.close();conversation=undefined;
 });
 await record('expert native interrupt retains the same role and environment for continuation',async()=>{
  const entry={skillId:randomUUID(),versionId:randomUUID(),version:1,buildId:randomUUID(),name:'slow-probe',namespace:'personal',invocationName:'personal:slow-probe',sourceHash:'fixture',buildHash:'fixture',userInvocable:true};
  const snapshot={...capabilities,skills:[entry],digest:hash([imageId,entry])},boundExpert={...expert,digest:hash([expert.digest,snapshot.digest])},directory=await bundle('expert-interrupt',snapshot),plugin=join(directory,'capabilities',snapshot.digest,'personal');
  await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await writeFile(join(plugin,'.claude-plugin/plugin.json'),'{"name":"personal","version":"1.0.0"}');await cp('tests/fixtures/skill-probe/personal/skills/slow-probe',join(plugin,'skills/slow-probe'),{recursive:true});
  await writeFile(join(plugin,'skills/slow-probe/scripts/slow.sh'),'#!/bin/sh\necho started > /workspace/started\nwhile true; do sleep .1; done\n');
  calls.splice(0,calls.length,{name:'Bash',input:{command:'bash /opt/harbor-skills/personal/skills/slow-probe/scripts/slow.sh',timeout:20000}});
  conversation=await controller.open('expert-interrupt','FIXTURE_ONLY',{capabilities:snapshot,expert:boundExpert});const abort=new AbortController(),running=conversation.run('Run the slow script',()=>{},abort.signal);
  await wait(async()=>{try{return (await readFile(join(directory,'workspace/started'),'utf8')).includes('started');}catch{return false;}});abort.abort();
  const stopped=await running;assert.equal(stopped.status,'cancelled',JSON.stringify(stopped));calls.splice(0);
  const next=await conversation.run('Continue as the same reviewer');assert.equal(next.status,'succeeded',JSON.stringify(next));assert.equal(next.containerId,stopped.containerId);assert.equal(next.expertDigest,boundExpert.digest);assert.ok(JSON.stringify(model.requests.at(-1).system).includes('HARBOR_EXPERT_ROLE_V1'));await conversation.close();conversation=undefined;
 });
 await record('old runtime fails before any model request instead of ignoring the expert',async()=>{
  const oldId=await controller.backend.imageId('agent-harbor:0.5.2'),old={...capabilities,imageId:oldId,digest:hash(oldId)};await bundle('old-runtime',old);
  const count=model.requests.length;conversation=await controller.open('old-runtime','FIXTURE_ONLY',{capabilities:old,expert});const result=await conversation.run('Do not execute');assert.equal(result.status,'failed');assert.match(result.error,/EXPERT_RUNTIME_UNSUPPORTED/);assert.equal(model.requests.length,count);await conversation.close();conversation=undefined;
 });
} finally {
 if(conversation)await conversation.close();model.server.closeAllConnections();await new Promise(done=>model.server.close(done));await writeFile(evidence,JSON.stringify({imageId,model:'local fixture',results},null,2));
}
