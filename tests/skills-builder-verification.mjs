/** 真实公开包下载 + 断网容器安装 + 正式SDK执行入口；仅模型部分使用本地夹具。 */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fetch,ProxyAgent} from 'undici';
import {SkillBuilder} from '../dist/src/docker/skill-builder.js';
import {PackageStore} from '../dist/src/service/skills/package-store.js';
import {Controller} from '../dist/src/runtime/controller.js';
import {defaultProfile} from '../dist/src/shared/types.js';
import {fixtureModel} from '../dist/tests/fixture-model.js';
const stamp=String(Date.now()),root=resolve('var/skills-dependency-verification',stamp),evidence=resolve('var/evidence/skills-dependencies',stamp);
await mkdir(evidence,{recursive:true});const proxy=process.env.AH_PACKAGE_PROXY?new ProxyAgent(process.env.AH_PACKAGE_PROXY):undefined;
const driver=new SkillBuilder(root),store=new PackageStore(root),imageId=await driver.imageId(),name='ah-skill-dependency-'+randomUUID();
let conversation,model;const logs=[];let result={passed:false,imageId,realModelRequests:0};
try {
 const metadata=await(await fetch('https://pypi.org/pypi/packaging/json',{dispatcher:proxy,signal:AbortSignal.timeout(30000)})).json();
 const wheel=metadata.urls.find(item=>item.packagetype==='bdist_wheel'&&item.filename.endsWith('py3-none-any.whl'));assert.ok(wheel);
 const npm=await(await fetch('https://registry.npmjs.org/is-number/7.0.0',{dispatcher:proxy,signal:AbortSignal.timeout(30000)})).json();
 const extension={schemaVersion:1,dependencies:{python:{lockFile:'requirements.lock',binaryOnly:true},node:{manifest:'package.json',lockFile:'package-lock.json',lifecycleScripts:'disabled'}},entrypoints:[{name:'python-check',language:'python',script:'scripts/check.py'},{name:'node-check',language:'node',script:'scripts/check.mjs'}]};
 const packageJson={name:'harbor-dependency-probe',version:'1.0.0',scripts:{postinstall:'touch /artifact/POSTINSTALL-RAN'},dependencies:{'is-number':'7.0.0'}};
 const lock={name:packageJson.name,version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':packageJson,'node_modules/is-number':{version:'7.0.0',resolved:npm.dist.tarball,integrity:npm.dist.integrity}}};
 const input={
  'SKILL.md':'---\nname: dependency-probe\ndescription: Verify isolated Python and Node dependencies.\n---\n\nUse the platform entrypoints.\n',
  'harbor-skill.json':JSON.stringify(extension),
  'requirements.lock':`packaging==${metadata.info.version} --hash=sha256:${wheel.digests.sha256}\n`,
  'package.json':JSON.stringify(packageJson),'package-lock.json':JSON.stringify(lock),
  'scripts/check.py':'from packaging.version import Version\nprint("PYTHON_DEPENDENCY_OK",Version("2.0")>Version("1.0"))\n',
  'scripts/check.mjs':'import isNumber from "is-number"; console.log("NODE_DEPENDENCY_OK",isNumber("42"));\n'
 };
 const checked=store.check(Object.entries(input).map(([path,text])=>({path,content:Buffer.from(text)})));assert.equal(checked.report.ok,true,JSON.stringify(checked.report));
 await store.publish('source',checked.files);const downloads=store.path('downloads');
 const materials=await driver.materials(checked.files,checked.report.manifest,downloads,AbortSignal.timeout(60000));
 const output=store.path('artifact');const hash=await driver.build({name,imageId,source:store.path('source'),output,materials:downloads,manifest:checked.report.manifest,namespace:'personal'},AbortSignal.timeout(120000),async text=>{logs.push(text);});
 await assert.rejects(access(join(output,'POSTINSTALL-RAN')));
 const config=JSON.parse(await driver.backend.command(['inspect',name]))[0];assert.equal(config.HostConfig.NetworkMode,'none');assert.equal(config.HostConfig.ReadonlyRootfs,true);assert.equal(config.Config.User,'1000:1000');
 await driver.stop(name);
 const id='dependencies',digest=createHash('sha256').update(hash).digest('hex'),plugin=join(root,id,'capabilities',digest,'personal');
 await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await writeFile(join(plugin,'.claude-plugin/plugin.json'),' {"name":"personal","version":"1.0.0"}');await cp(output,join(plugin,'skills/dependency-probe'),{recursive:true,verbatimSymlinks:true});
 const calls=[{name:'Bash',input:{command:'/opt/harbor-skills/personal/skills/dependency-probe/.harbor-runtime/bin/python-check && /opt/harbor-skills/personal/skills/dependency-probe/.harbor-runtime/bin/node-check',timeout:10000}}];
 model=fixtureModel(calls);await new Promise(done=>model.server.listen(0,'0.0.0.0',done));
 const controller=new Controller(root,{...defaultProfile,image:imageId,gatewayUrl:`http://host.docker.internal:${model.server.address().port}`,timeoutMs:30000});
 const snapshot={schemaVersion:1,digest,imageId,skills:[{skillId:randomUUID(),versionId:randomUUID(),version:1,buildId:randomUUID(),name:'dependency-probe',namespace:'personal',invocationName:'personal:dependency-probe',sourceHash:checked.report.digest,buildHash:hash,userInvocable:true}]};
 conversation=await controller.open(id,'FIXTURE_ONLY',{capabilities:snapshot});const turn=await conversation.run('Run the configured dependency entrypoints');assert.equal(turn.status,'succeeded',JSON.stringify(turn));
 const raw=JSON.stringify(model.requests);assert.match(raw,/PYTHON_DEPENDENCY_OK True/);assert.match(raw,/NODE_DEPENDENCY_OK true/);
 await conversation.close();conversation=undefined;
 await writeFile(join(evidence,'model-requests.json'),JSON.stringify(model.requests,null,2)+'\n');
 result={passed:true,imageId,pythonVersion:metadata.info.version,nodePackage:'is-number@7.0.0',materials,artifactHash:hash,postinstallExecuted:false,networkMode:config.HostConfig.NetworkMode,turn,realModelRequests:0};
 console.log('PASS real downloads, locked offline installation, scripts disabled, isolated dependency execution');
} catch(error) {result.error=String(error);throw error;}
finally {
 if(conversation)await conversation.close().catch(()=>{});await driver.stop(name).catch(()=>{});await driver.close();await proxy?.close();
 if(model){model.server.closeAllConnections();await new Promise(done=>model.server.close(done));}
 await writeFile(join(evidence,'summary.json'),JSON.stringify(result,null,2)+'\n');await writeFile(join(evidence,'build.log'),logs.join(''));
 await writeFile('var/evidence/skills-dependencies/latest.json',JSON.stringify({evidence})+'\n');
}
