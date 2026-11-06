/** 真实Docker/SDK原生主Agent、技能预加载、原包短名及恢复验证；模型使用本地夹具。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {Controller} from '../dist/src/runtime/controller.js';
import {defaultProfile} from '../dist/src/shared/types.js';
import {fixtureModel} from '../dist/tests/fixture-model.js';
import {workBuddyFiles} from '../dist/tests/workbuddy-fixture.js';
import {parseWorkBuddy} from '../dist/src/service/experts/workbuddy.js';
const stamp=String(Date.now()),root=resolve('var/workbuddy-native',stamp),evidence=resolve('var/evidence/workbuddy/2026-10-24',`native-${stamp}.json`);
await mkdir(root,{recursive:true});const calls=[],model=fixtureModel(calls,(body,results)=>JSON.stringify(body.system).includes("cc_is_subagent=true")?undefined:calls[results.length]),results=[];
await new Promise(done=>model.server.listen(0,'0.0.0.0',done));
const image=process.env.AH_VERIFY_IMAGE??'agent-harbor:0.5.4';
const controller=new Controller(root,{...defaultProfile,image,gatewayUrl:`http://host.docker.internal:${model.server.address().port}`,timeoutMs:60000,interruptTimeoutMs:10000});
const imageId=await controller.backend.imageId(image),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parsed=parseWorkBuddy(workBuddyFiles(),Buffer.from('zip'));
const skill={skillId:randomUUID(),versionId:randomUUID(),version:1,buildId:randomUUID(),name:'reference',namespace:'personal',invocationName:'personal:reference',sourceHash:'fixture',buildHash:'fixture',userInvocable:true};
const capabilities={schemaVersion:1,imageId,skills:[skill],digest:hash([imageId,skill])};
const expert={schemaVersion:1,expertId:randomUUID(),versionId:randomUUID(),version:1,name:'WorkBuddy',instructions:parsed.package.agents.reviewer.prompt,examples:[],digest:hash('workbuddy-main'),workbuddy:{agentName:parsed.package.agentName,agents:parsed.package.agents,packageHash:parsed.package.archiveHash,preloadedSkills:[{name:"reference",body:"PRELOADED_WORKBUDDY_REFERENCE",directory:"/opt/harbor-skills/workbuddy-config/.claude/skills/reference"}]}};
let conversation,mcpServer;
async function record(name,work){try{await work();results.push({name,passed:true});console.log('PASS',name);}catch(error){results.push({name,passed:false,error:String(error)});throw error;}}
try {
 const directory=await controller.store.prepare('workbuddy'),bundle=join(directory,'capabilities',capabilities.digest),plugin=join(bundle,'personal');
 await mkdir(join(bundle,'workbuddy-source'),{recursive:true});await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await writeFile(join(plugin,'.claude-plugin/plugin.json'),'{"name":"personal","version":"1.0.0"}');
 for(const file of parsed.skills[0].files){const location=join(plugin,'skills/reference',file.path);await mkdir(join(location,'..'),{recursive:true});await writeFile(location,file.content);const alias=join(bundle,"workbuddy-config/.claude/skills/reference",file.path);await mkdir(join(alias,".."),{recursive:true});await writeFile(alias,file.content);}
 await writeFile(join(bundle,'manifest.json'),JSON.stringify(capabilities));
 await record('native main Agent uses exact entry body and preloads bundled legacy Skill',async()=>{
  conversation=await controller.open('workbuddy','FIXTURE_ONLY',{capabilities,expert});const result=await conversation.run('Review the supplied material');
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.ok(JSON.stringify(model.requests[0].system).includes('ORIGINAL_WORKBUDDY_ROLE'),'main body missing');
  assert.ok(!JSON.stringify(model.requests[0].system).includes('HELPER_ROLE'),'wrong main agent');
  assert.ok(JSON.stringify(model.requests).includes('PRELOADED_WORKBUDDY_REFERENCE'),'Skill preload missing');
 });
 await record('package short Skill name executes, then multiple turns and restored conversation retain role',async()=>{
  calls.push({name:'Skill',input:{skill:'reference',args:''}});
  const first=await conversation.run('Use reference');assert.equal(first.status,'succeeded',JSON.stringify(first));
  const toolResults=model.requests.flatMap(body=>body.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_result');
  assert.ok(!toolResults.some(block=>/Unknown skill|not found/i.test(JSON.stringify(block))),'package short Skill name not resolved');
  const next=await conversation.run('Continue');assert.equal(next.sdkSessionId,first.sdkSessionId);assert.equal(next.containerId,first.containerId);
  await conversation.close();conversation=await controller.open('workbuddy','FIXTURE_ONLY',{capabilities,expert});const resumed=await conversation.run('Resume');assert.equal(resumed.status,'succeeded',JSON.stringify(resumed));assert.equal(resumed.sdkSessionId,first.sdkSessionId);assert.ok(JSON.stringify(model.requests.at(-1).system).includes('ORIGINAL_WORKBUDDY_ROLE'));
 });
 await record('native team main Agent delegates to declared member without a second platform Agent loop',async()=>{
  await conversation.close();conversation=undefined;
  const team={...expert,digest:hash('team'),workbuddy:{...expert.workbuddy,expertType:'team'}};
  calls.splice(0,calls.length,{name:'Agent',input:{subagent_type:'helper',description:'Review a part',prompt:'WORKBUDDY_TEAM_SUBTASK',name:'reviewer-helper',run_in_background:false}});
  conversation=await controller.open('workbuddy-team','FIXTURE_ONLY',{capabilities,expert:team});
  const dir=controller.store.directory('workbuddy-team');
  const target=join(dir,'capabilities',capabilities.digest);await mkdir(join(target,'workbuddy-source'),{recursive:true});
  for(const file of parsed.skills[0].files){const location=join(target,'workbuddy-config/.claude/skills/reference',file.path);await mkdir(join(location,'..'),{recursive:true});await writeFile(location,file.content);}
  await writeFile(join(target,'manifest.json'),JSON.stringify(capabilities));
  const before=model.requests.length,result=await conversation.run('Delegate the review to helper and combine the result');assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.ok(model.requests.slice(before).some(request=>JSON.stringify(request.system).includes('HELPER_ROLE')),'member query not observed');
 });
 await record('expert network grants permit the required public reference download inside the native sandbox',async()=>{
  await conversation.close();conversation=undefined;
  const history=model.requests.filter(request=>!JSON.stringify(request.system).includes('workbuddy-tool-mapping')).at(-1);const count=(history?.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_result').length;calls.splice(0,calls.length);calls[count]={name:'Bash',input:{command:'curl -fsSL --max-time 20 https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md -o /workspace/stripe.md',timeout:30000}};
  conversation=await controller.open('workbuddy','FIXTURE_ONLY',{capabilities,expert,networkDomains:['raw.githubusercontent.com']});
  const result=await conversation.run('Download the declared design reference');assert.equal(result.status,'succeeded',JSON.stringify(result));
  const content=await readFile(join(directory,'workspace/stripe.md'),'utf8');assert.ok(content.length>100,'reference file not downloaded');
 });
 await record('native MCP tools use declared server and user connection credentials',async()=>{
  await conversation.close();conversation=undefined;
  let called=false;
  mcpServer=createServer((request,response)=>{void(async()=>{
   if(request.method==='GET'){response.writeHead(405);response.end();return;}
   if(request.headers.authorization!=='Bearer MCP_NATIVE_FIXTURE'){response.writeHead(401);response.end();return;}
   const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
   if(body.id===undefined){response.writeHead(202);response.end();return;}
   let result;
   if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
   else if(body.method==='tools/list')result={tools:[{name:'lookup',description:'Return fixture result',inputSchema:{type:'object',properties:{}}}]};
   else {called=true;result={content:[{type:'text',text:'MCP_NATIVE_OK'}]};}
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  })().catch(()=>{response.writeHead(500);response.end();});});
  await new Promise(done=>mcpServer.listen(0,'0.0.0.0',done));
  const history=model.requests.filter(request=>!JSON.stringify(request.system).includes('workbuddy-tool-mapping')).at(-1);const count=(history?.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_result').length;calls.splice(0,calls.length);calls[count]={name:'mcp__lookup__lookup',input:{}};
  conversation=await controller.open('workbuddy','FIXTURE_ONLY',{capabilities,expert,mcpServers:{lookup:{type:'http',url:`http://host.docker.internal:${mcpServer.address().port}/mcp`,headers:{Authorization:'Bearer MCP_NATIVE_FIXTURE'}}}});
  const result=await conversation.run('Use the configured lookup tool');assert.equal(result.status,'succeeded',JSON.stringify(result));assert.ok(called,'MCP tools/call not observed');assert.ok(JSON.stringify(model.requests).includes('MCP_NATIVE_OK'));
 });
} finally {
 if(conversation)await conversation.close();if(mcpServer){mcpServer.closeAllConnections();await new Promise(done=>mcpServer.close(done));}model.server.closeAllConnections();await new Promise(done=>model.server.close(done));
 await writeFile(evidence,JSON.stringify({imageId,model:'local fixture',results},null,2));
 await writeFile(join(root,'requests.json'),JSON.stringify(model.requests,null,2));
}
