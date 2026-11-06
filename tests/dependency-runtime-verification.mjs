/** 原生Skill/专家共用依赖环境：真实包下载、SDK沙箱执行与离线复用；模型为固定夹具。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Controller} from '../dist/src/runtime/controller.js';
import {defaultProfile} from '../dist/src/shared/types.js';
import {fixtureModel} from '../dist/tests/fixture-model.js';
const evidence=resolve('var/evidence/dependency-runtime/2026-10-24');
const root=resolve('var/dependency-runtime-verification',String(Date.now()));
await mkdir(evidence,{recursive:true});
const queue=[], model=fixtureModel([],()=>queue.shift());
await new Promise(r=>model.server.listen(0,'0.0.0.0',r));
const controller=new Controller(root,{...defaultProfile,image:'agent-harbor:0.5.5',gatewayUrl:`http://host.docker.internal:${model.server.address().port}`,timeoutMs:120000,maxTurns:20});
const imageId=await controller.backend.imageId('agent-harbor:0.5.5');
const userA=createHash('sha256').update('fixture-user-a').digest('hex'),userB=createHash('sha256').update('fixture-user-b').digest('hex');
const entry={skillId:randomUUID(),versionId:randomUUID(),version:1,buildId:randomUUID(),name:'native-dependencies',namespace:'personal',invocationName:'personal:native-dependencies',sourceHash:'fixture',buildHash:'fixture',userInvocable:true};
const capabilities={schemaVersion:1,imageId,skills:[entry],digest:createHash('sha256').update('native-dependencies').digest('hex')};
const expert={schemaVersion:1,expertId:randomUUID(),versionId:randomUUID(),version:1,name:'Dependency expert',instructions:'DEPENDENCY_EXPERT: use the supplied native skill.',examples:[],digest:createHash('sha256').update('expert').digest('hex'),workbuddy:{agentName:'dependency-expert',packageHash:'fixture',agents:{'dependency-expert':{name:'dependency-expert',description:'Check native dependencies',prompt:'DEPENDENCY_EXPERT: use the supplied native skill.',skills:['native-dependencies']}},preloadedSkills:[]}};
let conversation;const results=[];
const bash=command=>({name:'Bash',input:{command,timeout:120000}});
async function prepare(id){
 const dir=await controller.store.prepare(id),plugin=join(dir,'capabilities',capabilities.digest,'personal');
 await mkdir(join(dir,'dependency-env/venv/bin'),{recursive:true});
 await writeFile(join(dir,'dependency-env/venv/bin/bwrap'),'#!/bin/sh\necho BAD > /workspace/native-path-hijack\nexec /usr/bin/bwrap "$@"\n',{mode:0o755});
 await writeFile(join(dir,'dependency-env/home/.bashrc'),'echo BAD > /workspace/native-startup-hijack\n');
 await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await mkdir(join(plugin,'skills/native-dependencies/scripts'),{recursive:true});
 await writeFile(join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'personal',version:'1.0.0'}));
 await writeFile(join(plugin,'skills/native-dependencies/SKILL.md'),'---\nname: native-dependencies\ndescription: Run native Python and Node package tools.\n---\nUse scripts/probe.sh to verify Python and Node. Use uv pip install and npm in the writable workspace.\n');
 await writeFile(join(plugin,'skills/native-dependencies/scripts/probe.sh'),'#!/bin/sh\nset -eu\npython -c \'import packaging; print("PYTHON_OK",packaging.__version__)\'\nnode -e \'console.log("NODE_OK", require("/workspace/node/node_modules/is-number")("42"))\'\n');
 await mkdir(join(dir,'capabilities',capabilities.digest,'workbuddy-config/.claude/skills'),{recursive:true});
 await mkdir(join(dir,'capabilities',capabilities.digest,'workbuddy-source'),{recursive:true});
 await cp(join(plugin,'skills/native-dependencies'),join(dir,'capabilities',capabilities.digest,'workbuddy-config/.claude/skills/native-dependencies'),{recursive:true});
 return dir;
}
async function run(name,id,key,commands,asExpert=false){
 const dir=await prepare(id);queue.splice(0,queue.length,...commands);
 conversation=await controller.open(id,'FIXTURE_ONLY',{dependencyCacheKey:key,capabilities,...(asExpert?{expert}: {})});
 const state=await conversation.run(name);assert.equal(state.status,'succeeded',JSON.stringify(state));
 const request=model.requests.at(-1),outputs=(request.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result');
 const last=outputs.at(-1);assert.ok(last&&!last.is_error,JSON.stringify(last));
 const current=outputs.slice(-commands.length); if(key===userB){assert.ok(current[0].is_error);assert.ok(current[1].is_error);assert.ok(current[2].is_error);} else assert.ok(current.every(item=>!item.is_error),JSON.stringify(current));
 for(const marker of ['native-path-hijack','native-startup-hijack']) assert.equal(await access(join(dir,'workspace',marker)).then(()=>true,()=>false),false,marker);
 const inspect=JSON.parse(await controller.backend.command(['inspect',state.containerId]))[0];
 const detail={name,state,mounts:inspect.Mounts.map(m=>({source:m.Source,target:m.Destination,rw:m.RW})),outputs};
 await writeFile(join(evidence,`case-${results.length+1}.json`),JSON.stringify(detail,null,2));
 await conversation.close();conversation=undefined;results.push({name,passed:true,containerId:state.containerId});return {dir,state,inspect};
}
const install=(offline=false)=>[
 bash(`uv pip install ${offline?'--offline ':''}packaging==25.0`),
 bash(`npm install --prefix /workspace/node ${offline?'--offline ':''}--ignore-scripts --no-audit --no-fund is-number@7.0.0`),
 bash('sh /opt/harbor-skills/personal/skills/native-dependencies/scripts/probe.sh > /workspace/dependency-result.txt'),
];
let failure;
try{
 const first=await run('standalone Skill native online install','skill-a',userA,[{name:'Skill',input:{skill:'personal:native-dependencies'}},...install()]);
 assert.match(await readFile(join(first.dir,'workspace/dependency-result.txt'),'utf8'),/PYTHON_OK 25.0[\s\S]*NODE_OK true/);
 const resumed=await run('same session restored without installing','skill-a',userA,[bash('sh /opt/harbor-skills/personal/skills/native-dependencies/scripts/probe.sh > /workspace/restored.txt')]);
 assert.notEqual(first.state.containerId,resumed.state.containerId);assert.equal(first.state.sdkSessionId,resumed.state.sdkSessionId);
 assert.match(await readFile(join(first.dir,'workspace/restored.txt'),'utf8'),/NODE_OK true/);
 const second=await run('WorkBuddy expert new session native offline cache reuse','expert-a',userA,[{name:'Skill',input:{skill:'native-dependencies'}},...install(true)],true);
 assert.match(await readFile(join(second.dir,'workspace/dependency-result.txt'),'utf8'),/NODE_OK true/);
 const cache=inspect=>inspect.Mounts.find(m=>m.Destination==='/dependency-cache').Source;
 assert.equal(cache(first.inspect),cache(second.inspect));
 const other=await run('different user cannot use cached packages or access other user path','skill-b',userB,[bash('uv pip install --offline packaging==25.0'),bash('npm install --prefix /workspace/node --offline --ignore-scripts --no-audit --no-fund is-number@7.0.0'),{name:'Bash',input:{command:'echo BAD > /workspace/bypass',dangerouslyDisableSandbox:true}},bash(`test ! -e /workspace/bypass && test ! -e /session-env/venv/lib/python3.11/site-packages/packaging && test ! -e '${cache(first.inspect)}' && echo ISOLATED > /workspace/isolated.txt`)]);
 assert.notEqual(cache(first.inspect),cache(other.inspect));assert.equal(await readFile(join(other.dir,'workspace/isolated.txt'),'utf8'),'ISOLATED\n');
} catch(error){failure=String(error);console.error(error);process.exitCode=1;}
finally{
 await conversation?.close().catch(()=>{});model.server.closeAllConnections();await new Promise(r=>model.server.close(r));
 await writeFile(join(evidence,'native-summary.json'),JSON.stringify({passed:!failure,failure,root,imageId,results,realModelRequests:0},null,2));
 await writeFile(join(evidence,'model-requests.json'),JSON.stringify(model.requests,null,2));
 console.log(JSON.stringify({passed:!failure,failure,results}));
}
