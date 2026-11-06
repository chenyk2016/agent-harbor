/** 实际Docker/SDK常驻会话实验；本地模型夹具，不请求真实厂商服务。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { Controller } from '../dist/src/runtime/controller.js';
import { lockSession } from '../dist/src/runtime/storage.js';
import { defaultProfile } from '../dist/src/shared/types.js';
import { fixtureModel } from '../dist/tests/fixture-model.js';
const validationId = String(Date.now());
const root = resolve('var/streaming-validation', validationId);
const evidenceBase = resolve(process.env.AH_EVIDENCE_DIR ?? 'var/evidence/streaming');
const evidence = join(evidenceBase, validationId);
const image = 'agent-harbor:streaming-test';
const pause = ms => new Promise(done => setTimeout(done, ms));
const results = [];
const sessions = [];
await mkdir(evidence, { recursive: true });
async function waitFor(test, message, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await test())
            return;
        await pause(50);
    }
    throw new Error(message);
}
async function start(name, calls = [], config = {}, stateName = name) {
    const model = fixtureModel(calls);
    await new Promise(done => model.server.listen(0, '0.0.0.0', done));
    const c = new Controller(root, { ...defaultProfile, image, gatewayUrl: `http://host.docker.internal:${model.server.address().port}` });
    const directory = await c.store.prepare(stateName);
    const release = await lockSession(directory);
    const inputs = join(directory, 'attempts');
    await chmod(directory, 0o700);
    await chmod(inputs, 0o755);
    const heartbeat = () => writeFile(join(inputs, '.heartbeat'), 'lease\n', { mode: 0o644 });
    await heartbeat();
    const timer = setInterval(() => void heartbeat(), 5000);
    const task = { sessionId: stateName, attemptId: randomUUID(), generation: 1, prompt: 'streaming experiment', model: defaultProfile.model, maxTurns: 12, maxBudgetUsd: 1, timeoutMs: 120000 };
    const item = { name, sessionId: stateName, c, model, calls, directory, events: [], output: '', stderr: '', timer, release, id: `ah-${task.attemptId}`, closed: false };
    sessions.push(item);
    await writeFile(join(inputs, 'streaming-config.json'), JSON.stringify({ url: c.profile.gatewayUrl, token: 'FAKE_STREAMING_TOKEN', model: task.model, ...config }));
    await c.backend.create(task, c.profile, directory, inputs, true);
    await c.backend.startSession(item.id);
    item.engineId = await c.backend.command(['inspect', '--format', '{{.Id}}', item.id]);
    item.child = spawn('docker', ['exec', '-i', item.id, 'node', '/platform/runtime/dist/tests/streaming-runner.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    item.exited = once(item.child, 'exit');
    item.child.once('exit', () => item.closed = true);
    item.child.stdout.on('data', chunk => item.output += chunk);
    item.child.stderr.on('data', chunk => item.stderr += chunk);
    const lines = createInterface({ input: item.child.stdout });
    lines.on('line', line => { try {
        item.events.push(JSON.parse(line));
    }
    catch {
        item.events.push({ type: 'invalid-json', line });
    } });
    item.send = command => item.child.stdin.write(JSON.stringify(command) + '\n');
    item.turn = async (text) => {
        const id = randomUUID();
        item.send({ type: 'message', id, text });
        await waitFor(() => item.events.some(e => e.type === 'turn.result' && e.turnId === id) || item.closed, `turn timed out: ${name}`, 30000);
        const result = item.events.find(e => e.type === 'turn.result' && e.turnId === id);
        assert.ok(result, `stream exited without result: ${name}: ${item.stderr}`);
        return result;
    };
    await waitFor(() => item.events.some(e => e.type === 'runner.ready') || item.closed, `Runner not ready: ${name}`);
    assert.equal(item.closed, false, item.stderr);
    return item;
}
async function close(item) {
    if (item.cleaned)
        return;
    item.cleaned = true;
    clearInterval(item.timer);
    try {
        if (!item.closed) {
            item.send({ type: 'close' });
            try {
                await waitFor(() => item.closed, 'close needs container fallback', 8000);
            }
            catch {
                await item.c.backend.stop(item.id);
            }
        }
        await item.c.backend.stop(item.id);
        await item.c.backend.destroy(item.id);
        assert.deepEqual(await item.c.backend.forSession(item.sessionId), []);
    }
    finally {
        await item.release();
        item.model.server.closeAllConnections();
        await new Promise(done => item.model.server.close(done));
        await writeFile(join(evidence, item.name + '-events.jsonl'), item.output);
        await writeFile(join(evidence, item.name + '-stderr.log'), item.stderr);
        await writeFile(join(evidence, item.name + '-model.json'), JSON.stringify(item.model.requests, null, 2) + '\n');
        await writeFile(join(item.directory, 'attempts', 'streaming-config.json'), '{}');
    }
}
const bash = command => ({ name: 'Bash', input: { command, timeout: 20000 } });
async function record(name, action) {
    try {
        const detail = await action();
        results.push({ name, passed: true, detail });
        console.log('PASS', name);
    }
    catch (error) {
        results.push({ name, passed: false, error: String(error) });
        console.error('FAIL', name, String(error));
    }
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ root, image, results, realModelRequests: 0 }, null, 2) + '\n');
}
try {
    await record('same Runner and native Claude process accept two streamed inputs', async () => {
        const s = await start('multi');
        s.calls.push(bash('echo first > /workspace/value'));
        const first = await s.turn('First streamed message: run the configured tool');
        assert.equal(first.payload.subtype, 'success');
        s.calls.push({ name: 'Read', input: { file_path: '/workspace/value' } });
        const second = await s.turn('Second streamed message: read the same file');
        assert.equal(second.payload.subtype, 'success');
        assert.equal(second.runnerPid, first.runnerPid);
        assert.equal(second.nativePid, first.nativePid);
        assert.equal(second.payload.sdkSessionId, first.payload.sdkSessionId);
        assert.equal(s.events.filter(e => e.type === 'sdk.spawned').length, 1);
        assert.equal(await readFile(join(s.directory, 'workspace/value'), 'utf8'), 'first\n');
        assert.ok(JSON.stringify(s.model.requests.at(-1)).includes('First streamed message'));
        assert.ok(JSON.stringify(s.model.requests.at(-1)).includes('first\\n'));
        assert.ok(second.payload.costUsd >= first.payload.costUsd);
        const detail = { runnerPid: first.runnerPid, nativePid: first.nativePid, sdkSessionId: first.payload.sdkSessionId, engineId: s.engineId, costs: [first.payload.costUsd, second.payload.costUsd], nativeSpawns: 1 };
        await close(s);
        return detail;
    });
    await record('native file tools and private path enforcement remain active in a stream', async () => {
        const s = await start('files');
        s.calls.push({ name: 'Write', input: { file_path: '/workspace/edit.txt', content: 'alpha\n' } });
        assert.equal((await s.turn('Create the fixed file')).payload.subtype, 'success');
        s.calls.push({ name: 'Edit', input: { file_path: '/workspace/edit.txt', old_string: 'alpha', new_string: 'beta' } });
        assert.equal((await s.turn('Edit the fixed file')).payload.subtype, 'success');
        assert.equal(await readFile(join(s.directory, 'workspace/edit.txt'), 'utf8'), 'beta\n');
        s.calls.push({ name: 'Read', input: { file_path: '/platform/run/streaming-config.json' } });
        await s.turn('Try the fixed private path');
        const request = s.model.requests.at(-1);
        const blocks = (request.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []);
        const tool = blocks.filter(block => block.type === 'tool_result').at(-1);
        assert.equal(tool.is_error, true, JSON.stringify(tool));
        assert.equal(JSON.stringify(tool).includes('FAKE_STREAMING_TOKEN'), false);
        await close(s);
        return { write: true, edit: true, privateReadDenied: true };
    });
    await record('busy and stale input rejected; soft interrupt settles before next turn', async () => {
        const s = await start('interrupt', [bash('python3 /workspace/writer.py')]);
        await writeFile(join(s.directory, 'workspace/writer.py'), 'import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        const id = randomUUID();
        s.send({ type: 'message', id, text: 'Run the fixed writer' });
        const file = join(s.directory, 'workspace/ticks');
        await waitFor(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length > 0, 'writer did not start');
        const rejected = randomUUID();
        s.send({ type: 'message', id: rejected, text: 'BUSY_INPUT_MUST_NOT_RUN' });
        s.send({ type: 'interrupt', id: rejected });
        await waitFor(() => s.events.some(e => e.type === 'input.rejected') && s.events.some(e => e.type === 'interrupt.rejected'), 'rejection missing');
        s.send({ type: 'interrupt', id });
        let softCompleted = true;
        try {
            await waitFor(() => s.events.some(e => e.type === 'turn.result' && e.turnId === id) && s.events.some(e => e.type === 'interrupt.receipt' && e.turnId === id), 'soft interrupt unsettled', 10000);
        }
        catch {
            softCompleted = false;
        }
        const before = await readFile(file, 'utf8');
        await pause(500);
        const writerStopped = (await readFile(file, 'utf8')) === before;
        let continued = false;
        if (softCompleted && writerStopped) {
            const result = await s.turn('Reply after cancellation without replaying the writer');
            assert.equal(result.payload.subtype, 'success');
            continued = true;
            assert.equal(s.events.filter(e => e.type === 'sdk.spawned').length, 1);
            s.send({ type: 'message', id, text: 'DUPLICATE_INPUT_MUST_NOT_RUN' });
            await waitFor(() => s.events.some(e => e.type === 'input.rejected' && e.payload.reason === 'duplicate'), 'duplicate not rejected');
        }
        assert.equal(JSON.stringify(s.model.requests).includes('BUSY_INPUT_MUST_NOT_RUN'), false);
        const result = s.events.find(e => e.type === 'turn.result' && e.turnId === id);
        const receipt = s.events.find(e => e.type === 'interrupt.receipt' && e.turnId === id);
        await close(s);
        const stopped = await readFile(file, 'utf8');
        await pause(300);
        assert.equal(await readFile(file, 'utf8'), stopped);
        return { softCompleted, writerStoppedBeforeContainerClose: writerStopped, continuedInSameQuery: continued, sdkSubtype: result?.payload.subtype, receipt: receipt?.payload.receipt, hardStopRequired: !softCompleted || !writerStopped };
    });
    await record('native background task spans turns; interrupt and stopTask boundary observed', async () => {
        const s = await start('background', [{ name: 'Bash', input: { command: 'python3 /workspace/background.py', run_in_background: true } }]);
        await writeFile(join(s.directory, 'workspace/background.py'), 'import time\nfrom pathlib import Path\nwhile True:\n with Path("/workspace/background").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        await writeFile(join(s.directory, 'workspace/foreground.py'), 'import time\nfrom pathlib import Path\nwhile True:\n with Path("/workspace/foreground").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        const first = await s.turn('Start the native background task');
        const file = join(s.directory, 'workspace/background');
        await waitFor(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length > 0, 'native background did not start');
        const before = await readFile(file, 'utf8');
        const second = await s.turn('Reply while the native background task is running');
        await pause(300);
        assert.ok((await readFile(file, 'utf8')).length > before.length);
        assert.equal(first.nativePid, second.nativePid);
        s.calls.push(bash('python3 /workspace/foreground.py'));
        const id = randomUUID();
        s.send({ type: 'message', id, text: 'Run foreground work while background keeps running' });
        await waitFor(async () => (await readFile(join(s.directory, 'workspace/foreground')).catch(() => Buffer.alloc(0))).length > 0, 'foreground did not start');
        s.send({ type: 'interrupt', id });
        await waitFor(() => s.events.some(e => e.type === 'turn.result' && e.turnId === id), 'background-case interrupt unsettled', 10000);
        const mark = await readFile(file, 'utf8');
        await pause(400);
        const backgroundContinuesAfterInterrupt = (await readFile(file, 'utf8')).length > mark.length;
        const started = s.events.find(e => e.type === 'sdk.task' && e.payload.subtype === 'task_started');
        const taskId = started?.payload.task_id;
        let stoppedByTaskApi = false;
        if (backgroundContinuesAfterInterrupt && taskId) {
            s.send({ type: 'stopTask', taskId });
            await waitFor(() => s.events.some(e => e.type === 'task.stop.receipt') || s.closed, 'stopTask unacknowledged');
            await pause(250);
            const mark = await readFile(file, 'utf8');
            await pause(400);
            stoppedByTaskApi = (await readFile(file, 'utf8')) === mark;
        }
        await close(s);
        const final = await readFile(file, 'utf8');
        await pause(300);
        assert.equal(await readFile(file, 'utf8'), final);
        return { nativeBackgroundSpansTurns: true, backgroundContinuesAfterInterrupt, taskId, stoppedByTaskApi, containerStopConfirmed: true };
    });
    await record('maxBudgetUsd and cumulative cost scope across streamed messages', async () => {
        const s = await start('budget', [], { maxBudgetUsd: 0.0008 });
        const responses = [];
        for (let i = 0; i < 4; i++) {
            if (s.closed)
                break;
            const result = await s.turn('Budget probe message ' + i);
            responses.push(result.payload);
            if (result.payload.subtype === 'error_max_budget_usd')
                break;
        }
        assert.ok(responses.some(result => result.subtype === 'error_max_budget_usd'), JSON.stringify(responses));
        const before = s.model.requests.length;
        const exhausted = await s.turn('This message must not reset the exhausted query budget');
        assert.equal(exhausted.payload.subtype, 'error_max_budget_usd');
        assert.equal(s.model.requests.length, before);
        const detail = { configuredBudget: 0.0008, results: responses, modelRequests: s.model.requests.length, streamClosedAfterLimit: s.closed, subsequentInputStillLimited: true, extraRequestsAfterLimit: 0 };
        await close(s);
        return detail;
    });
    await record('maxTurns error result and subsequent stream usability', async () => {
        const s = await start('turn-limit', [bash('echo limit > /workspace/limit')], { maxTurns: 1 });
        const limited = await s.turn('Run one fixed tool with a one-turn limit');
        assert.equal(limited.payload.subtype, 'error_max_turns');
        await pause(200);
        let nextSubtype = null;
        if (!s.closed)
            nextSubtype = (await s.turn('Reply after the maxTurns result')).payload.subtype;
        assert.equal(nextSubtype, 'success');
        assert.equal(s.events.filter(e => e.type === 'sdk.spawned').length, 1);
        const detail = { limited: limited.payload, nextSubtype, streamClosed: s.closed };
        await close(s);
        return detail;
    });
    await record('stdin EOF during work closes Runner; container stop confirms no writer', async () => {
        const s = await start('eof', [bash('python3 /workspace/writer.py')]);
        await writeFile(join(s.directory, 'workspace/writer.py'), 'import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        s.send({ type: 'message', id: randomUUID(), text: 'Run fixed writer before EOF' });
        const file = join(s.directory, 'workspace/ticks');
        await waitFor(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length > 0, 'EOF writer absent');
        s.child.stdin.end();
        let runnerExited = true;
        try {
            await waitFor(() => s.closed, 'Runner did not exit after EOF', 8000);
        }
        catch {
            runnerExited = false;
        }
        const before = await readFile(file, 'utf8');
        await pause(400);
        const writerContinuesAfterEOF = (await readFile(file, 'utf8')).length > before.length;
        await close(s);
        const stopped = await readFile(file, 'utf8');
        await pause(300);
        assert.equal(await readFile(file, 'utf8'), stopped);
        return { runnerExited, writerContinuesAfterEOF, containerStopConfirmed: true };
    });
    await record('resistant foreground interrupt has bounded container fallback', async () => {
        const s = await start('resistant', [bash('python3 /workspace/resistant.py')]);
        await writeFile(join(s.directory, 'workspace/resistant.py'), 'import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        const id = randomUUID();
        s.send({ type: 'message', id, text: 'Run fixed signal-resistant writer' });
        const file = join(s.directory, 'workspace/ticks');
        await waitFor(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length > 0, 'resistant writer absent');
        s.send({ type: 'interrupt', id });
        let softCompleted = true;
        try {
            await waitFor(() => s.events.some(e => e.type === 'turn.result' && e.turnId === id), 'resistant interrupt unsettled', 3000);
        }
        catch {
            softCompleted = false;
        }
        const before = await readFile(file, 'utf8');
        await pause(300);
        const softStoppedWriter = (await readFile(file, 'utf8')) === before;
        if (!softCompleted || !softStoppedWriter)
            await s.c.backend.stop(s.id);
        await close(s);
        const final = await readFile(file, 'utf8');
        await pause(300);
        assert.equal(await readFile(file, 'utf8'), final);
        return { softCompleted, softStoppedWriter, fallbackUsed: !softCompleted || !softStoppedWriter, containerStopConfirmed: true };
    });
    await record('Runner SIGKILL does not replace host-side container cleanup', async () => {
        const s = await start('runner-crash', [bash('python3 /workspace/writer.py')]);
        await writeFile(join(s.directory, 'workspace/writer.py'), 'import time\nfrom pathlib import Path\nwhile True:\n with Path("/workspace/ticks").open("a") as f:f.write("tick\\n")\n time.sleep(.05)\n');
        s.send({ type: 'message', id: randomUUID(), text: 'Run writer then crash only Runner' });
        const file = join(s.directory, 'workspace/ticks');
        await waitFor(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length > 0, 'crash writer absent');
        const pid = s.events.find(e => e.type === 'runner.ready').runnerPid;
        await s.c.backend.command(['exec', s.id, 'node', '-e', 'process.kill(Number(process.argv[1]),"SIGKILL")', String(pid)]);
        await waitFor(() => s.closed, 'Runner exec did not exit');
        const before = await readFile(file, 'utf8');
        await pause(400);
        const writerContinuesAfterRunnerCrash = (await readFile(file, 'utf8')).length > before.length;
        const containerStillRunning = (await s.c.backend.inspect(s.id)).running;
        await close(s);
        const final = await readFile(file, 'utf8');
        await pause(300);
        assert.equal(await readFile(file, 'utf8'), final);
        return { writerContinuesAfterRunnerCrash, containerStillRunning, hostCleanupConfirmed: true };
    });
    await record('new streamed query resumes saved native session after container replacement', async () => {
        const first = await start('resume-first', [bash('echo preserved > /workspace/resumed')], {}, 'resume');
        const original = await first.turn('Remember STREAMED_RESUME_MARKER and run fixed tool');
        await close(first);
        const second = await start('resume-second', [], { resumeId: original.payload.sdkSessionId }, 'resume');
        const resumed = await second.turn('Continue the saved streamed session');
        assert.equal(resumed.payload.subtype, 'success');
        assert.equal(resumed.payload.sdkSessionId, original.payload.sdkSessionId);
        assert.notEqual(second.engineId, first.engineId);
        assert.equal(await readFile(join(second.directory, 'workspace/resumed'), 'utf8'), 'preserved\n');
        assert.ok(JSON.stringify(second.model.requests).includes('STREAMED_RESUME_MARKER'));
        const detail = { sdkSessionId: resumed.payload.sdkSessionId, oldEngineId: first.engineId, newEngineId: second.engineId };
        await close(second);
        return detail;
    });
}
finally {
    for (const item of sessions)
        await close(item);
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ root, image, imageId: await new Controller(root).backend.imageId(image), results, realModelRequests: 0 }, null, 2) + '\n');
    await writeFile(join(evidenceBase, 'latest.json'), JSON.stringify({ validationId, evidence, passed: results.every(result => result.passed), groups: results.length }, null, 2) + '\n');
    console.log('Evidence:', evidence);
}
assert.ok(results.every(result => result.passed), JSON.stringify(results));
