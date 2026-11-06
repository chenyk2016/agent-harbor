/** Real native SDK + Docker + local model fixture. No gateway, external account, or model spend. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Controller } from "../dist/src/runtime/controller.js";
import { defaultProfile } from "../dist/src/shared/types.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
import { McpService } from "../dist/src/service/mcp/service.js";
import { McpNetwork } from "../dist/src/service/mcp/network.js";
import { loadLocalTemplates } from "../dist/src/service/mcp/templates.js";
import { IdentityStore } from "../dist/src/service/identity/store.js";
import { mcpServerName } from "../dist/src/shared/mcp.js";
import { recoverLegacyWorkers } from "../dist/src/service/mcp/legacy.js";
import { probeMcp } from "../dist/src/service/mcp/probe.js";
import { testDatabase } from "../dist/tests/pg.js";
const evidence = resolve(
    process.env.AH_MCP_EVIDENCE_DIR ?? "var/evidence/mcp-native/2026-10-27",
  ),
  root = resolve("var/mcp-native", String(Date.now()));
await mkdir(evidence, { recursive: true });
await mkdir(root, { recursive: true });
const db = await testDatabase();
let next;
const model = fixtureModel([], () => {
  const c = next;
  next = undefined;
  return c;
});
await new Promise((r) => model.server.listen(0, "0.0.0.0", r));
const transports = [];
const upstream = createServer((req, res) => {
  void (async () => {
    assert.equal(req.headers.authorization, "Bearer FAKE_REMOTE_KEY");
    const s = new Server(
      { name: "echo", version: "1" },
      { capabilities: { tools: {} } },
    );
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    }));
    s.setRequestHandler(CallToolRequestSchema, async (r) => ({
      content: [{ type: "text", text: "REMOTE_OK:" + r.params.arguments.text }],
    }));
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.push(t);
    await s.connect(t);
    await t.handleRequest(req, res);
  })().catch(() => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, "0.0.0.0", r));
const origin = `http://host.docker.internal:${upstream.address().port}`,
  templates = await loadLocalTemplates(),
  service = new McpService(
    db.db,
    join(root, ".service"),
    new McpNetwork([origin]),
    templates,
  );
const controller = new Controller(root, {
  ...defaultProfile,
  image: process.env.AH_IMAGE ?? "agent-harbor:mcp-native-verify",
  gatewayUrl: `http://host.docker.internal:${model.server.address().port}`,
  timeoutMs: 60000,
});
const cases = [];
let conversation, legacyName;
const scriptSource = `import {createInterface} from 'node:readline';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const read=p=>{try{return {ok:true,text:fs.readFileSync(p,'utf8')}}catch(e){return {ok:false,code:e.code}}};
for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id===undefined)continue;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'script-fixture',version:'1'}};
else if(r.method==='tools/list')result={tools:[{name:'privacy_probe',description:'Probe fake files',inputSchema:{type:'object',properties:{wait:{type:'boolean'}}}}]};
else if(r.method==='tools/call'){
 if(r.params.arguments?.wait){setInterval(()=>fs.appendFileSync('/workspace/heartbeat','x'),100);continue;}
 let child;try{execFileSync('node',['-e',"require('fs').readFileSync('/platform/state/private-probe')"],{stdio:'ignore'});child=true;}catch{child=false;}
 fs.appendFileSync(process.argv[1],'\\n// runtime edit');fs.mkdirSync('/dependency-cache/npm',{recursive:true});fs.writeFileSync('/dependency-cache/npm/native-marker','CACHE_OK');result={content:[{type:'text',text:JSON.stringify({public:read('/workspace/public-probe'),private:read('/platform/state/private-probe'),child,modelSecret:process.env.ANTHROPIC_AUTH_TOKEN??null,ownKey:process.env.API_KEY,cache:process.env.npm_config_cache,scriptSource:read(process.argv[1]).ok})}]};
}else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));}
`;
try {
  await new IdentityStore(db.db).ensure("native-user");
  const remote = await service.save("native-user", {
    name: "remote",
    url: origin + "/mcp",
    credentials: { Authorization: "Bearer FAKE_REMOTE_KEY" },
  });
  const local = await service.save("native-user", {
    name: "local",
    kind: "local",
    templateId: "text-tools",
  });
  const script = await service.scripts.save("native-user", {
    name: "Private tool",
    entry: "server.mjs",
    runtime: "node",
    install: "none",
    secretKeys: ["API_KEY"],
    files: { "server.mjs": scriptSource },
  });
  const custom = await service.save("native-user", {
    name: "script",
    kind: "script",
    scriptScope: "user",
    scriptId: script.id,
    credentials: { API_KEY: "FAKE_SCRIPT_KEY" },
  });
  const npmFiles = {
    "package.json":
      '{"name": "mcp-fixture", "version": "1.0.0", "type": "module", "dependencies": {"is-number": "7.0.0"}}',
    "package-lock.json":
      '{"name": "mcp-fixture", "lockfileVersion": 3, "requires": true, "packages": {"": {"dependencies": {"is-number": "7.0.0"}}, "node_modules/is-number": {"version": "7.0.0", "resolved": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", "integrity": "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==", "license": "MIT", "engines": {"node": ">=0.12.0"}}}}',
  };
  const npmScript = await service.scripts.save("native-user", {
    name: "npm dependency",
    entry: "server.mjs",
    runtime: "node",
    install: "npm",
    secretKeys: ["API_KEY"],
    files: {
      ...npmFiles,
      "server.mjs":
        "import number from 'is-number';if(!number('42'))throw Error('dependency missing');\n" +
        scriptSource,
    },
  });
  const npmConnection = await service.save("native-user", {
    name: "npm",
    kind: "script",
    scriptScope: "user",
    scriptId: npmScript.id,
    credentials: { API_KEY: "FAKE_SCRIPT_KEY" },
  });
  const pythonSource = `import sys,json,packaging
for line in sys.stdin:
 r=json.loads(line)
 if "id" not in r: continue
 if r["method"]=="initialize": result={"protocolVersion":r["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"python-fixture","version":"1"}}
 elif r["method"]=="tools/list": result={"tools":[{"name":"version","inputSchema":{"type":"object"}}]}
 elif r["method"]=="tools/call": result={"content":[{"type":"text","text":"PYTHON_OK:"+packaging.__version__}]}
 else: result={}
 print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":result}),flush=True)
`;
  const pyScript = await service.scripts.save("native-user", {
    name: "Python dependency",
    entry: "server.py",
    runtime: "python",
    install: "uv",
    files: {
      "server.py": pythonSource,
      "requirements.txt": "packaging==25.0\n",
    },
  });
  const pyConnection = await service.save("native-user", {
    name: "python",
    kind: "script",
    scriptScope: "user",
    scriptId: pyScript.id,
  });
  const cacheKey = createHash("sha256")
    .update("user:native-user")
    .digest("hex");
  for (const [c, tool, input, marker] of [
    [remote, "echo", { text: "hello" }, "REMOTE_OK"],
    [local, "text_stats", { text: "hello" }, "characters"],
    [custom, "privacy_probe", {}, "CACHE_OK_UNUSED"],
    [npmConnection, "privacy_probe", {}, ""],
    [pyConnection, "version", {}, "PYTHON_OK:25.0"],
    [npmConnection, "privacy_probe", {}, ""],
    [pyConnection, "version", {}, "PYTHON_OK:25.0"],
  ]) {
    const id = crypto.randomUUID();
    await controller.store.prepare(id);
    await writeFile(
      join(controller.store.directory(id), "workspace/public-probe"),
      "PUBLIC_OK",
    );
    await writeFile(
      join(controller.store.directory(id), "claude-state/private-probe"),
      "PRIVATE_FAKE",
    );
    const runtime = await service.runtime("native-user", c.id);
    next = { name: `mcp__${mcpServerName(c.id)}__${tool}`, input };
    const before = model.requests.length;
    conversation = await controller.open(id, "FAKE_MODEL_KEY", {
      ...runtime,
      dependencyCacheKey: cacheKey,
    });
    const state = await conversation.run("Use the configured MCP tool once.");
    const results = model.requests
      .slice(before)
      .flatMap((r) => r.messages ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    assert.equal(state.status, "succeeded", JSON.stringify(state));
    assert(
      results.some((r) => !r.is_error),
      JSON.stringify(results),
    );
    if (c !== custom && c !== npmConnection)
      assert(JSON.stringify(results).includes(marker), JSON.stringify(results));
    else {
      const text = results.at(-1).content.find((t) => t.type === "text").text;
      const data = JSON.parse(text);
      assert.equal(data.private.ok, false);
      assert.equal(data.child, false);
      assert.equal(data.modelSecret, null);
      assert.equal(data.ownKey, "FAKE_SCRIPT_KEY");
      assert.equal(data.cache, "/dependency-cache/npm");
      assert.equal(data.public.text, "PUBLIC_OK");
    }
    cases.push({
      name: c.name + ":" + tool,
      passed: true,
      status: state.status,
    });
    await conversation.close();
    conversation = undefined;
  }
  // Discovery is a real disposable native container, without a model prompt.
  const count = model.requests.length;
  const probe = await probeMcp(service, "native-user", local.id);
  assert(probe.tools.some((t) => t.name === "text_stats"));
  assert.equal(model.requests.length, count);
  cases.push({ name: "native-discovery-no-model", passed: true });
  // A local tool that never replies must not survive cancellation.
  const id = crypto.randomUUID(),
    runtime = await service.runtime("native-user", custom.id);
  conversation = await controller.open(id, "FAKE_MODEL_KEY", {
    ...runtime,
    dependencyCacheKey: cacheKey,
  });
  next = {
    name: `mcp__${mcpServerName(custom.id)}__privacy_probe`,
    input: { wait: true },
  };
  const abort = new AbortController();
  const running = conversation.run(
    "Run the long tool.",
    undefined,
    abort.signal,
  );
  let started = false;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await readFile(
            join(controller.store.directory(id), "workspace/heartbeat"),
          )
        ).length
      ) {
        started = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(started, "slow MCP started");
  abort.abort();
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.environment, "closed");
  assert.equal(
    await controller.backend.inspect(
      cancelled.containerId ?? "ah-" + cancelled.attemptId,
    ),
    undefined,
  );
  cases.push({ name: "cancel-stops-local-environment", passed: true });
  await conversation.close();
  conversation = undefined;
  // Migration stops only an exactly owned legacy worker, and keeps an unknown owner untouched.
  const legacyRoot = join(root, ".service"),
    bindingId = crypto.randomUUID(),
    epoch = crypto.randomUUID();
  legacyName = "ah-mcp-" + bindingId;
  const owner = createHash("sha256")
    .update(legacyRoot)
    .digest("hex")
    .slice(0, 20);
  const imageId = await controller.backend.imageId(
    process.env.AH_IMAGE ?? "agent-harbor:mcp-native-verify",
  );
  await mkdir(join(legacyRoot, "mcp-workers"), { recursive: true });
  const record = join(legacyRoot, "mcp-workers", bindingId + ".json");
  await writeFile(
    record,
    JSON.stringify({ bindingId, epoch, image: imageId, name: legacyName }),
  );
  const createLegacy = async (label) => {
    await controller.backend.command([
      "create",
      "--name",
      legacyName,
      "--label",
      "harbor.mcp.owner=" + label,
      "--label",
      "harbor.mcp.binding=" + bindingId,
      "--label",
      "harbor.mcp.epoch=" + epoch,
      "--entrypoint",
      "node",
      imageId,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    await controller.backend.command(["start", legacyName]);
  };
  await createLegacy("different-test-owner");
  await assert.rejects(
    () => recoverLegacyWorkers(legacyRoot),
    /MCP_LEGACY_STOP_UNCONFIRMED/,
  );
  assert.equal(
    await controller.backend.command([
      "inspect",
      "--format",
      "{{.State.Running}}",
      legacyName,
    ]),
    "true",
  );
  await controller.backend.command(["rm", "--force", legacyName]);
  await createLegacy(owner);
  await recoverLegacyWorkers(legacyRoot);
  assert.equal(
    await controller.backend.command([
      "ps",
      "-aq",
      "--filter",
      "name=^/" + legacyName + "$",
    ]),
    "",
  );
  assert.equal(JSON.parse(await readFile(record, "utf8")).state, "stopped");
  legacyName = undefined;
  cases.push({
    name: "legacy-worker-owner-and-confirmed-cleanup",
    passed: true,
  });
  const source = await service.scripts.read("user", "native-user", script.id);
  assert.equal(source.files["server.mjs"], scriptSource);
  cases.push({ name: "source-original-unchanged", passed: true });
  await writeFile(
    join(evidence, "native.json"),
    JSON.stringify(
      {
        passed: true,
        model: "local-fixture",
        cases,
        requests: model.requests.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(cases));
} catch (error) {
  await writeFile(
    join(evidence, "native-failure.json"),
    JSON.stringify({ error: String(error), cases }, null, 2),
  );
  throw error;
} finally {
  await conversation?.terminate();
  if (legacyName)
    await controller.backend
      .command(["rm", "--force", legacyName])
      .catch(() => {});
  await Promise.allSettled(transports.map((t) => t.close()));
  model.server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise((r) => model.server.close(r)),
    new Promise((r) => upstream.close(r)),
  ]);
  await db.close();
}
