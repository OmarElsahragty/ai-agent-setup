// P10 provider-lifecycle tests (WO-1): the 8 spec cases plus the session-forking
// audit gaps GAP-1/2/3/10, all against the REAL patched Claude provider, chat
// run registry and session writer on a stub tree with a fake SDK whose
// interrupt() ends only the current turn (the CLI keeps running), like the
// real streaming-input CLI.
//
// The tree is built from the stock fixture with THIS patches dir's apply.sh and
// apply.d/p10.sh (so the suite is portable to a merge tree).
// Negative control: P10_PREPATCHED_TREE=<cloudcli pkg dir with P0..P9r only>
// runs the suite against that tree; it must FAIL (exit 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockSrc } from './stock-src.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.dirname(HERE);
const PROVIDER_REL = 'dist-server/server/modules/providers/list/claude';
const WS_REL = 'dist-server/server/modules/websocket/services';
let root;
let pkg;
let home;
let stateFile;
let fake;
let A;
let B;
let registry;

const FAKE_SDK = `
export const state = { spawns: [] };
export function resetFake() {
    state.spawns.length = 0;
}
export function query(config) {
    const inst = {
        options: config.options,
        sid: config.options?.resume || null,
        aliveAtSpawn: state.spawns.filter((i) => !i._done).length,
        _stdin: [],
        _stdinClosed: false,
        _events: [],
        _waiters: [],
        _done: false,
        _error: null,
        _turnOpen: false,
        interrupts: 0,
        control: [],
        emit(msg) {
            if (msg.type === 'result') {
                inst._turnOpen = false;
            }
            else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
                inst._turnOpen = true;
            }
            inst._events.push(msg);
            wake();
        },
        end(error = null) {
            inst._error = error;
            inst._done = true;
            wake();
        },
        // Real streaming-input CLI: interrupt ends the CURRENT turn with an
        // error result; the process (and its background work) keeps running.
        async interrupt() {
            inst.interrupts += 1;
            if (inst._turnOpen) {
                inst.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] interrupted'], session_id: inst.sid });
            }
        },
        async setPermissionMode(mode) {
            inst.control.push(['setPermissionMode', mode]);
        },
        async setModel(model) {
            inst.control.push(['setModel', model]);
        },
        async applyFlagSettings(settings) {
            inst.control.push(['applyFlagSettings', settings]);
        },
        async next() {
            for (;;) {
                if (inst._events.length > 0) {
                    return { value: inst._events.shift(), done: false };
                }
                if (inst._done) {
                    if (inst._error) {
                        const err = inst._error;
                        inst._error = null;
                        throw err;
                    }
                    return { done: true, value: undefined };
                }
                await new Promise((resolve) => inst._waiters.push(resolve));
            }
        },
        [Symbol.asyncIterator]() {
            return inst;
        },
    };
    function wake() {
        const waiters = inst._waiters;
        inst._waiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }
    (async () => {
        try {
            for await (const message of config.prompt) {
                inst._stdin.push(message);
                inst._turnOpen = true;
            }
        }
        catch {
            // aborted mid-write
        }
        finally {
            inst._stdinClosed = true;
            Promise.resolve().then(() => {
                if (!inst._done) {
                    inst.end();
                }
            });
        }
    })();
    state.spawns.push(inst);
    return inst;
}
`;

function buildSandbox(name) {
    const sb = path.join(root, name);
    const write = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(sb, rel)), { recursive: true });
        fs.writeFileSync(path.join(sb, rel), text);
    };
    const copy = (fromRel, toRel) => {
        fs.mkdirSync(path.dirname(path.join(sb, toRel)), { recursive: true });
        fs.copyFileSync(path.join(pkg, fromRel), path.join(sb, toRel));
    };
    write('package.json', JSON.stringify({ type: 'module' }));
    // D4 + F6b: globalThis.__d4FailBuild(command) makes the prompt build fail. A truthy result is a
    // TRANSIENT busy failure (code EBUSY: the push retries); 'permanent' is a permanent one (the turn fails at once).
    write('server/shared/image-attachments.js', "export const appendFilesInputTag = (command) => { const d4Fail = globalThis.__d4FailBuild?.(command); if (d4Fail === 'permanent') { throw new Error('f6b: permanent prompt build failure'); } if (d4Fail) { throw Object.assign(new Error('d4: transient prompt build failure'), { code: 'EBUSY' }); } return command; };\nexport const buildClaudeUserContent = async (prompt) => prompt;\nexport const normalizeImageDescriptors = () => [];\n");
    write('server/shared/claude-cli-path.js', 'export const resolveClaudeCodeExecutablePath = () => null;\n');
    write('server/shared/utils.js', "export const createCompleteMessage = (m) => ({ kind: 'complete', ...m });\nexport const createNormalizedMessage = (m) => ({ ...m });\nexport const readObjectRecord = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);\n");
    write('server/modules/notifications/index.js', 'export const createNotificationEvent = (e) => e;\nexport const notifyUserIfEnabled = () => { };\nexport const notifyBackgroundWorkCompleted = () => { };\nexport const notifyRunFailed = () => { };\nexport const notifyRunStopped = () => { };\n');
    write('server/modules/providers/list/claude/claude-models.provider.js', "export const CLAUDE_PREDEFINED_MODELS = { DEFAULT: 'test-model', OPTIONS: [] };\nexport const CLAUDE_ULTRACODE_EFFORT = 'ultracode';\n");
    write('server/modules/database/index.js', 'export const sessionsDb = { assignProviderSessionId() { } };\n');
    write('server/modules/websocket/services/session-upsert-broadcast.service.js', 'export const broadcastSessionUpserted = async () => { };\n');
    write('server/modules/websocket/services/websocket-state.service.js', 'export const WS_OPEN_STATE = 1;\n');
    copy(`${PROVIDER_REL}/claude-runtime.provider.js`, 'server/modules/providers/list/claude/claude-runtime.provider.js');
    copy(`${PROVIDER_REL}/claude-prompt-queue.js`, 'server/modules/providers/list/claude/claude-prompt-queue.js');
    copy(`${WS_REL}/chat-run-registry.service.js`, 'server/modules/websocket/services/chat-run-registry.service.js');
    copy(`${WS_REL}/chat-session-writer.service.js`, 'server/modules/websocket/services/chat-session-writer.service.js');
    write('node_modules/@anthropic-ai/claude-agent-sdk/package.json', JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', main: 'index.js', exports: './index.js' }));
    write('node_modules/@anthropic-ai/claude-agent-sdk/index.js', `export { query, state, resetFake } from ${JSON.stringify(path.join(root, 'fake-sdk.mjs'))};\n`);
    return {
        provider: path.join(sb, 'server/modules/providers/list/claude/claude-runtime.provider.js'),
        registry: path.join(sb, 'server/modules/websocket/services/chat-run-registry.service.js'),
    };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, what, timeoutMs = 4000) {
    const start = Date.now();
    for (;;) {
        if (fn()) {
            return;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timeout: ${what}`);
        }
        await tick();
    }
}
function conn() {
    const c = { readyState: 1, sent: [], send(payload) { c.sent.push(JSON.parse(payload)); } };
    return c;
}
const ctx = (nativeId) => ({
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (sid, model) => model,
    getProviderModels: async () => ({ OPTIONS: [] }),
    normalizeMessage: (m) => [{ kind: 'stream_event', t: m?.type || 'unknown' }],
    isProviderInstalled: async () => true,
});
const opts = (sid, extra = {}) => ({
    sessionId: sid,
    sessionSummary: 'p10-test',
    model: 'test-model',
    permissionMode: 'default',
    cwd: '/tmp',
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    ...extra,
});
// Mirrors chat-websocket dispatchRun: registry run -> runtime.run -> safety-net complete.
function dispatch(mod, sid, c, text, extra, nativeId) {
    const run = registry.startRun({ appSessionId: sid, provider: 'claude', providerSessionId: nativeId, connection: c, userId: 'u1' });
    if (!run) {
        return { run: null, done: Promise.resolve('RUN_IN_PROGRESS') };
    }
    const done = mod.queryClaudeSDK(text, opts(sid, extra), run.writer, ctx(nativeId))
        .catch((error) => error)
        .finally(() => registry.completeRunIfCurrent(run, { exitCode: 1 }));
    return { run, done };
}
// Mirrors chat-websocket handleChatAbort (the Stop button).
async function stop(mod, sid) {
    const run = registry.getRun(sid);
    if (!run || run.status !== 'running') {
        return 'NO_ACTIVE_RUN';
    }
    const ok = await mod.abortClaudeSDKSession(sid);
    registry.completeRun(sid, { exitCode: ok ? 0 : 1, aborted: true });
    return ok;
}
const last = () => fake.state.spawns[fake.state.spawns.length - 1];
function assistant(inst, text, extraContent = []) {
    inst.emit({ type: 'assistant', session_id: inst.sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }, ...extraContent] } });
}
function finish(inst, { bg = null, text = 'ok' } = {}) {
    const extra = [];
    if (bg === 'bash') {
        extra.push({ type: 'tool_use', id: 'tu-bg', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } });
    }
    if (bg === 'wakeup') {
        extra.push({ type: 'tool_use', id: 'tu-wake', name: 'ScheduleWakeup', input: { delaySeconds: 60 } });
    }
    assistant(inst, text, extra);
    inst.emit({ type: 'result', subtype: 'success', is_error: false, session_id: inst.sid });
}
async function seed(mod, sid, c, nativeId, extra = {}, { bg = null } = {}) {
    const before = fake.state.spawns.length;
    const d = dispatch(mod, sid, c, 'first turn', extra, nativeId);
    await waitFor(() => fake.state.spawns.length === before + 1 && last()._stdin.length >= 1, 'seed spawned and consumed');
    const inst = last();
    inst.sid = nativeId || `native-${sid}`;
    inst.emit({ type: 'system', subtype: 'init', session_id: inst.sid });
    finish(inst, { bg });
    await waitFor(() => d.run.status === 'completed', 'seed run completed');
    return { d, inst };
}
const completesAfter = (c, seq) => c.sent.filter((m) => m.kind === 'complete' && m.seq > seq);
const userRows = (inst, text) => inst._stdin.filter((m) => m?.message?.content === text).length;
function readState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    catch {
        return [];
    }
}
const stateOf = (sid) => readState().find((entry) => entry.appSessionId === sid)?.state;
async function cleanup() {
    for (const inst of fake.state.spawns) {
        if (!inst._done) {
            inst.end();
        }
    }
    await tick(40);
    fake.resetFake();
}
function p10test(name, fn) {
    test(name, async () => {
        try {
            await fn();
        }
        finally {
            await cleanup();
        }
    });
}

before(async () => {
    root = `/var/tmp/claude/p10-test-${process.pid}-${Date.now()}`;
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    stateFile = path.join(root, 'run', 'runtime-state.json');
    if (process.env.P10_PREPATCHED_TREE) {
        pkg = process.env.P10_PREPATCHED_TREE;
    }
    else {
        pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
        fs.mkdirSync(path.dirname(pkg), { recursive: true });
        fs.cpSync(stockSrc(), pkg, { recursive: true });
        const base = spawnSync('bash', [path.join(PATCHES, 'apply.sh'), root], { encoding: 'utf8' });
        assert.equal(base.status, 0, `apply.sh failed:\n${base.stdout}\n${base.stderr}`);
        const p10 = spawnSync('bash', [path.join(PATCHES, 'apply.d', 'p10.sh'), root], { encoding: 'utf8' });
        assert.equal(p10.status, 0, `p10.sh failed:\n${p10.stdout}\n${p10.stderr}`);
        const again = spawnSync('bash', [path.join(PATCHES, 'apply.d', 'p10.sh'), root], { encoding: 'utf8' });
        assert.equal(again.status, 0, 'p10.sh is idempotent');
        assert.ok(!again.stdout.includes('P10 patched:'), `second apply changed files:\n${again.stdout}`);
        const check = spawnSync('bash', [path.join(PATCHES, 'apply.d', 'p10.sh'), '--check', root], { encoding: 'utf8' });
        assert.equal(check.status, 0, `p10.sh --check failed:\n${check.stdout}\n${check.stderr}`);
    }
    process.env.HOME = home;
    process.env.CLOUDCLI_RUNTIME_STATE = stateFile;
    process.env.CLOUDCLI_BG_WAIT_CEILING_MS = '86400000';
    process.env.CLOUDCLI_RETIRE_BACKSTOP_MS = '1500';
    process.env.CLOUDCLI_IDLE_HOLD_MS = '60000';
    fs.writeFileSync(path.join(root, 'fake-sdk.mjs'), FAKE_SDK);
    fake = await import(path.join(root, 'fake-sdk.mjs'));
    const a = buildSandbox('sb-a');
    A = await import(a.provider);
    registry = (await import(a.registry)).chatRunRegistry;
    process.env.CLOUDCLI_IDLE_HOLD_MS = '400';
    B = await import(buildSandbox('sb-b').provider);
    process.env.CLOUDCLI_IDLE_HOLD_MS = '60000';
});

after(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

p10test('P10 spec 1 (C1): a self-driven turn opens a registry run (processing, seq continues) and closes it with exactly one complete; heartbeats do not', async () => {
    const sid = 'app-t1';
    const c = conn();
    const { d, inst } = await seed(A, sid, c, 'native-t1', {}, { bg: 'bash' });
    inst.emit({ type: 'system', subtype: 'task_progress', session_id: inst.sid });
    await tick(40);
    assert.equal(registry.isProcessing(sid), false, 'a task_progress heartbeat does not start a turn');
    const seqBefore = d.run.lastSeq;
    assistant(inst, 'background task finished; here is the report');
    await waitFor(() => registry.isProcessing(sid), 'self-driven turn shows processing (chat_subscribed isProcessing)');
    const run2 = registry.getRun(sid);
    assert.notEqual(run2, d.run, 'a new registry run');
    assert.ok(run2.lastSeq > seqBefore, 'seq continues from the previous run');
    inst.emit({ type: 'result', subtype: 'success', is_error: false, session_id: inst.sid });
    await waitFor(() => run2.status === 'completed', 'self-driven run completed');
    await tick(40);
    assert.equal(completesAfter(c, seqBefore).length, 1, 'exactly one complete for the self-driven turn');
    const seqStop = run2.lastSeq;
    assistant(inst, 'second background follow-up');
    await waitFor(() => registry.isProcessing(sid), 'second self-driven turn shows processing');
    assert.equal(await stop(A, sid), true, 'Stop reaches the self-driven turn');
    assert.equal(inst.interrupts, 1, 'Stop interrupted the self-driven turn');
    await tick(60);
    const stopCompletes = completesAfter(c, seqStop);
    assert.equal(stopCompletes.length, 1, 'exactly one complete for the stopped self-driven turn');
    assert.equal(stopCompletes[0].aborted, true);
    assert.equal(fake.state.spawns.length, 1, 'no spawn');
    assert.equal(inst._stdinClosed, false, 'process kept');
});

p10test('P10 spec 2 (R7): an incompatible turn during background work spawns exactly once, AFTER the old process fully exits', async () => {
    const sid = 'app-t2';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-t2', {}, { bg: 'bash' });
    const d2 = dispatch(A, sid, c, 'same chat, other cwd', { cwd: '/var/tmp' }, 'native-t2');
    await tick(300);
    assert.equal(fake.state.spawns.length, 1, 'no second process while the old one runs background work');
    assert.equal(inst._stdinClosed, false, 'background work is not killed by the retire');
    assert.equal(registry.isProcessing(sid), true, 'the waiting turn is visible and abortable');
    assistant(inst, 'background work done');
    inst.emit({ type: 'result', subtype: 'success', is_error: false, session_id: inst.sid });
    await waitFor(() => fake.state.spawns.length === 2, 'exactly one spawn after the old exit');
    const inst2 = last();
    assert.equal(inst._stdinClosed, true, 'old process released once its work reported back');
    assert.equal(inst2.aliveAtSpawn, 0, 'no live process existed when the new one spawned');
    await waitFor(() => inst2._stdin.length >= 1, 'new process got the turn');
    inst2.sid = 'native-t2';
    finish(inst2);
    await waitFor(() => d2.run.status === 'completed', 'incompatible turn completed');
    assert.equal(fake.state.spawns.length, 2);
});

p10test('P10 spec 3 (R7): an owner send while background work runs is PUSHED - 0 spawns, 0 aborts', async () => {
    const sid = 'app-t3';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-t3', {}, { bg: 'bash' });
    const d2 = dispatch(A, sid, c, 'owner follow-up', {}, 'native-t3');
    await waitFor(() => inst._stdin.length === 2, 'pushed into the same process');
    finish(inst);
    await d2.done;
    assert.equal(d2.run.status, 'completed');
    assert.equal(fake.state.spawns.length, 1);
    assert.equal(inst.interrupts, 0);
    assert.equal(inst._stdinClosed, false, 'background work still held');
});

p10test('P10 spec 4 (C2) + req 8: Stop interrupts the turn only - 0 spawns, stdin kept, entry kept; a later [ede_diagnostic] exit is a cancel, not an error', async () => {
    const sid = 'app-t4';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-t4', {}, { bg: 'bash' });
    const d2 = dispatch(A, sid, c, 'long owner turn', {}, 'native-t4');
    await waitFor(() => inst._stdin.length === 2, 'owner turn pushed');
    assert.equal(await stop(A, sid), true);
    await d2.done;
    await tick(40);
    assert.equal(inst.interrupts, 1);
    assert.equal(inst._stdinClosed, false, 'Stop never closes stdin: background work survives');
    assert.equal(A.isClaudeSDKSessionActive(sid), true, 'entry kept until the process exits');
    assert.equal(fake.state.spawns.length, 1);
    const errorsBefore = c.sent.filter((m) => m.kind === 'error').length;
    inst.end(new Error('Claude Code returned an error result: [ede_diagnostic] interrupted'));
    await waitFor(() => !A.isClaudeSDKSessionActive(sid), 'process exit removes the entry');
    await tick(40);
    assert.equal(c.sent.filter((m) => m.kind === 'error').length, errorsBefore, 'no error frame after our own interrupt');
});

p10test('P10 req 4: a push still waiting behind the in-flight turn when Stop arrives is rejected (never delivered later); 0 spawns, process kept', async () => {
    const sid = 'app-t4w';
    const c = conn();
    const { d, inst } = await seed(A, sid, c, 'native-t4w', {}, { bg: 'bash' });
    const seqBefore = d.run.lastSeq;
    assistant(inst, 'self-driven follow-up in flight');
    await waitFor(() => registry.isProcessing(sid), 'self-driven turn in flight');
    const direct = { userId: 'u1', sent: [], send(m) { direct.sent.push(m); }, setSessionId() { } };
    const waiting = A.queryClaudeSDK('waiting message', opts(sid), direct, ctx('native-t4w')).then(() => 'settled', (error) => error);
    await tick(60);
    assert.equal(userRows(inst, 'waiting message'), 0, 'parked behind the in-flight turn');
    assert.equal(await stop(A, sid), true);
    assert.equal(await waiting, 'settled', 'the waiting turn ends quietly');
    await tick(80);
    assert.equal(userRows(inst, 'waiting message'), 0, 'a turn rejected by Stop is never delivered');
    assert.equal(fake.state.spawns.length, 1, '0 spawns');
    assert.equal(inst._stdinClosed, false, 'process kept');
    assert.equal(direct.sent.filter((m) => m.kind === 'error').length, 0, 'no error frame for the rejected turn');
    const completes = completesAfter(c, seqBefore);
    assert.equal(completes.length, 1, 'the stopped turn gets exactly one complete');
    assert.equal(completes[0].aborted, true, 'the rejection did not steal the interrupted turn abort flag');
});

p10test('P10 spec 5 (R4): an "Always allow" grant, then a same-profile turn carrying it - pushed, 0 spawns', async () => {
    const sid = 'app-t5';
    const c = conn();
    const d = dispatch(A, sid, c, 'first turn', {}, 'native-t5');
    await waitFor(() => fake.state.spawns.length === 1 && last()._stdin.length >= 1, 'spawned');
    const inst = last();
    inst.sid = 'native-t5';
    const decision = inst.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    await waitFor(() => c.sent.some((m) => m.kind === 'permission_request'), 'permission request');
    const request = c.sent.find((m) => m.kind === 'permission_request');
    A.resolveToolApproval(request.requestId, { allow: true, rememberEntry: 'Bash(ls:*)' });
    assert.equal((await decision).behavior, 'allow');
    finish(inst);
    await waitFor(() => d.run.status === 'completed', 'turn 1 completed');
    const d2 = dispatch(A, sid, c, 'same profile', { toolsSettings: { allowedTools: ['Bash(ls:*)'], disallowedTools: [], skipPermissions: false } }, 'native-t5');
    await waitFor(() => inst._stdin.length === 2, 'grant did not force a respawn');
    finish(inst);
    await d2.done;
    assert.equal(fake.state.spawns.length, 1);
});

p10test('P10 spec 6 (R4): permission-mode and model switches are applied IN PLACE - 0 spawns', async () => {
    const sid = 'app-t6';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-t6');
    const d2 = dispatch(A, sid, c, 'now accept edits', { permissionMode: 'acceptEdits' }, 'native-t6');
    await waitFor(() => inst._stdin.length === 2, 'mode switch pushed');
    assert.deepEqual(inst.control[0], ['setPermissionMode', 'acceptEdits']);
    finish(inst);
    await d2.done;
    const d3 = dispatch(A, sid, c, 'other model', { permissionMode: 'acceptEdits', model: 'other-model' }, 'native-t6');
    await waitFor(() => inst._stdin.length === 3, 'model switch pushed');
    assert.ok(inst.control.some(([kind, value]) => kind === 'setModel' && value === 'other-model'));
    finish(inst);
    await d3.done;
    assert.equal(fake.state.spawns.length, 1);
});

p10test('P10 spec 7 (req 7): a content-identical settings rewrite keeps reuse; a real content change respawns after the old exit', async () => {
    const sid = 'app-t7';
    const c = conn();
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{"a":1,"b":[1,2]}');
    try {
        const { inst } = await seed(A, sid, c, 'native-t7');
        fs.writeFileSync(settings, '{\n  "b": [1, 2],\n  "a": 1\n}\n');
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(settings, future, future);
        const d2 = dispatch(A, sid, c, 'after a same-content touch', {}, 'native-t7');
        await waitFor(() => inst._stdin.length === 2, 'reused after the touch');
        finish(inst);
        await d2.done;
        assert.equal(fake.state.spawns.length, 1);
        fs.writeFileSync(settings, '{"a":2}');
        dispatch(A, sid, c, 'after a real change', {}, 'native-t7');
        await waitFor(() => fake.state.spawns.length === 2, 'real change respawns');
        assert.equal(last().aliveAtSpawn, 0, 'respawn only after the old exit');
    }
    finally {
        fs.rmSync(settings, { force: true });
    }
});

p10test('P10 GAP-1 (req 9): spawn guard - a live ~/.claude/sessions marker on the same sid blocks (0 spawns, session_busy_external); dead pid or malformed marker does not', async () => {
    const sessions = path.join(home, '.claude', 'sessions');
    const liveMarker = path.join(sessions, `${process.pid}.json`);
    fs.writeFileSync(liveMarker, JSON.stringify({ pid: process.pid, sessionId: 'native-g1', kind: 'interactive' }));
    const deadMarker = path.join(sessions, '999999999.json');
    const badMarker = path.join(sessions, '4242.json');
    try {
        const c = conn();
        const d = dispatch(A, 'app-g1', c, 'hello', {}, 'native-g1');
        const outcome = await Promise.race([
            d.done.then(() => 'refused'),
            waitFor(() => fake.state.spawns.length > 0, 'spawn', 5000).then(() => 'spawned', () => 'timeout'),
        ]);
        assert.equal(outcome, 'refused', 'the turn is refused, not spawned beside the live CLI');
        assert.equal(fake.state.spawns.length, 0, '0 spawns while a live CLI holds the session');
        assert.ok(c.sent.some((m) => m.kind === 'error' && String(m.content).includes('session_busy_external')), 'turn refused with session_busy_external');
        assert.equal(d.run.status, 'completed');
        fs.rmSync(liveMarker);
        fs.writeFileSync(deadMarker, JSON.stringify({ pid: 999999999, sessionId: 'native-g1b' }));
        dispatch(A, 'app-g1b', conn(), 'hello', {}, 'native-g1b');
        await waitFor(() => fake.state.spawns.length === 1, 'dead pid does not block');
        fs.writeFileSync(badMarker, '{not json');
        dispatch(A, 'app-g1c', conn(), 'hello', {}, 'native-g1c');
        await waitFor(() => fake.state.spawns.length === 2, 'malformed marker does not block');
    }
    finally {
        for (const file of [liveMarker, deadMarker, badMarker]) {
            fs.rmSync(file, { force: true });
        }
    }
});

p10test('P10 GAP-2 (22:34 incident): Stop during a bg-work hold, then the queued send flushed 0-500 ms later - 0 spawns, exactly 1 user row, bg task still running', async () => {
    for (const delay of [0, 300]) {
        fake.resetFake();
        const sid = `app-g2-${delay}`;
        const native = `native-g2-${delay}`;
        const c = conn();
        const { inst } = await seed(A, sid, c, native, {}, { bg: 'bash' });
        const d2 = dispatch(A, sid, c, 'owner turn', {}, native);
        await waitFor(() => inst._stdin.length === 2, 'owner turn pushed');
        assert.equal(await stop(A, sid), true);
        await tick(delay);
        const d3 = dispatch(A, sid, c, 'queued message', {}, native);
        assert.ok(d3.run, 'the flushed send is admitted');
        await waitFor(() => inst._stdin.length === 3, `queued send pushed into the same process (delay ${delay})`);
        finish(inst);
        await d3.done;
        await d2.done;
        assert.equal(fake.state.spawns.length, 1, `0 spawns (delay ${delay})`);
        assert.equal(userRows(inst, 'queued message'), 1, 'owner message delivered exactly once');
        assert.equal(inst._stdinClosed, false, 'background task still running');
        assert.equal(d3.run.status, 'completed');
        const finalComplete = c.sent.filter((m) => m.kind === 'complete').pop();
        assert.equal(finalComplete.exitCode, 0, 'the queued turn completes normally');
        assert.notEqual(finalComplete.aborted, true);
        inst.end();
        await tick(40);
    }
});

p10test('D4 item 1: Stop cancels a send waiting in the push-retry loop - it is never pushed later; 0 spawns, process kept', async () => {
    const sid = 'app-d4r';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-d4r', {}, { bg: 'bash' });
    let failing = true;
    globalThis.__d4FailBuild = (text) => failing && text === 'queued after a failed push';
    try {
        const d2 = dispatch(A, sid, c, 'queued after a failed push', {}, 'native-d4r');
        await tick(200);
        assert.equal(userRows(inst, 'queued after a failed push'), 0, 'still waiting in the push-retry loop');
        assert.equal(await stop(A, sid), true);
        failing = false;
        await tick(300);
        assert.equal(userRows(inst, 'queued after a failed push'), 0, 'a send the owner stopped is never pushed later');
        assert.equal(fake.state.spawns.length, 1, '0 spawns');
        assert.equal(inst._stdinClosed, false, 'process kept');
        assert.equal(await Promise.race([d2.done.then(() => 'settled'), tick(500).then(() => 'pending')]), 'settled', 'the cancelled turn ends');
        assert.equal(c.sent.filter((m) => m.kind === 'error').length, 0, 'no error frame for the cancelled turn');
    }
    finally {
        delete globalThis.__d4FailBuild;
    }
});

p10test('D4 item 1: Stop during the spawn wait wins even when the session frees up before the next pass - 0 spawns', async () => {
    const liveMarker = path.join(home, '.claude', 'sessions', `${process.pid}.json`);
    fs.writeFileSync(liveMarker, JSON.stringify({ pid: process.pid, sessionId: 'native-d4s', kind: 'interactive' }));
    try {
        const c = conn();
        const d = dispatch(A, 'app-d4s', c, 'hello', {}, 'native-d4s');
        await tick(120);
        assert.equal(fake.state.spawns.length, 0, 'waiting behind the live CLI');
        assert.equal(await stop(A, 'app-d4s'), true, 'Stop reaches the waiting spawn');
        fs.rmSync(liveMarker);
        await Promise.race([d.done, tick(2500)]);
        await tick(100);
        assert.equal(fake.state.spawns.length, 0, 'a stopped turn never spawns');
        assert.equal(c.sent.filter((m) => m.kind === 'error').length, 0, 'no error frame');
    }
    finally {
        fs.rmSync(liveMarker, { force: true });
    }
});

p10test('D4 item 1: the spawn wait backs off its ~/.claude/sessions scan (50 ms -> 1 s) instead of a 50 ms readdir loop', async () => {
    const sessions = path.join(home, '.claude', 'sessions');
    const liveMarker = path.join(sessions, `${process.pid}.json`);
    fs.writeFileSync(liveMarker, JSON.stringify({ pid: process.pid, sessionId: 'native-d4b', kind: 'interactive' }));
    const realReaddir = fs.readdirSync;
    let scans = 0;
    fs.readdirSync = function d4CountingReaddir(dir, ...rest) {
        if (String(dir) === sessions) {
            scans += 1;
        }
        return realReaddir.call(this, dir, ...rest);
    };
    try {
        const c = conn();
        const d = dispatch(A, 'app-d4b', c, 'hello', {}, 'native-d4b');
        await d.done;
        assert.ok(c.sent.some((m) => m.kind === 'error' && String(m.content).includes('session_busy_external')), 'still refused at the backstop');
        assert.equal(fake.state.spawns.length, 0);
        assert.ok(scans >= 3 && scans <= 10, `marker scans during the 1.5 s wait: ${scans} (a 50 ms loop does ~30)`);
    }
    finally {
        fs.readdirSync = realReaddir;
        fs.rmSync(liveMarker, { force: true });
    }
});

p10test('D4 item 1: despite the backoff, a spawn waiting for the own retiring process starts as soon as that process exits', async () => {
    const sid = 'app-d4x';
    const c = conn();
    const { inst } = await seed(A, sid, c, 'native-d4x', {}, { bg: 'bash' });
    dispatch(A, sid, c, 'other cwd', { cwd: '/var/tmp' }, 'native-d4x');
    await tick(900);
    assert.equal(fake.state.spawns.length, 1, 'still waiting for the old process');
    const exitAt = Date.now();
    assistant(inst, 'background work done');
    inst.emit({ type: 'result', subtype: 'success', is_error: false, session_id: inst.sid });
    await waitFor(() => fake.state.spawns.length === 2, 'one spawn after the old exit');
    const latency = Date.now() - exitAt;
    assert.ok(latency < 300, `respawn latency ${latency} ms (the exit wakes the paused wait)`);
    assert.equal(last().aliveAtSpawn, 0, 'no live process at spawn');
});

p10test('F6b: a permanent push failure fails the turn at once with its real cause - never retried until the backstop, never session_busy_external; 0 spawns, process kept', async () => {
    // transientFirst 0: the very first push fails permanently; 2: two transient
    // (EBUSY) failures first, then a permanent one inside the retry loop.
    for (const transientFirst of [0, 2]) {
        fake.resetFake();
        const sid = `app-f6b-perm-${transientFirst}`;
        const native = `native-f6b-perm-${transientFirst}`;
        const text = `permanently unbuildable ${transientFirst}`;
        const c = conn();
        const { inst } = await seed(A, sid, c, native, {}, { bg: 'bash' });
        let builds = 0;
        globalThis.__d4FailBuild = (command) => {
            if (command !== text) {
                return false;
            }
            builds += 1;
            return builds > transientFirst ? 'permanent' : true;
        };
        try {
            const started = Date.now();
            const d2 = dispatch(A, sid, c, text, {}, native);
            const outcome = await Promise.race([d2.done.then(() => 'settled'), tick(1000).then(() => 'pending')]);
            assert.equal(outcome, 'settled', `the turn fails at once (${Date.now() - started} ms), not after the 1.5 s backstop`);
            assert.equal(builds, transientFirst + 1, 'the permanent failure is never retried');
            const errors = c.sent.filter((m) => m.kind === 'error').map((m) => String(m.content));
            assert.ok(errors.some((e) => e.includes('f6b: permanent prompt build failure')), `the real cause is reported: ${JSON.stringify(errors)}`);
            assert.ok(!errors.some((e) => e.includes('session_busy_external')), 'never reported as session_busy_external');
            assert.equal(fake.state.spawns.length, 1, '0 spawns');
            assert.equal(userRows(inst, text), 0, 'nothing pushed');
            assert.equal(inst._stdinClosed, false, 'the live process is kept');
        }
        finally {
            delete globalThis.__d4FailBuild;
        }
        inst.end();
        await tick(40);
    }
});

p10test('F6b: the push retry backs off 50 ms -> 1 s between transient busy/lock failures (not a fixed 50 ms loop) and pushes once the cause clears - 0 spawns', async () => {
    // A provider instance with a longer retire backstop, so the retry reaches the 1 s cap.
    const prevBackstop = process.env.CLOUDCLI_RETIRE_BACKSTOP_MS;
    process.env.CLOUDCLI_RETIRE_BACKSTOP_MS = '8000';
    let C;
    try {
        C = await import(buildSandbox('sb-f6b-backoff').provider);
    }
    finally {
        if (prevBackstop === undefined) {
            delete process.env.CLOUDCLI_RETIRE_BACKSTOP_MS;
        }
        else {
            process.env.CLOUDCLI_RETIRE_BACKSTOP_MS = prevBackstop;
        }
    }
    const sid = 'app-f6b-backoff';
    const native = 'native-f6b-backoff';
    const text = 'pushed after a busy spell';
    const c = conn();
    const { inst } = await seed(C, sid, c, native, {}, { bg: 'bash' });
    const at = [];
    globalThis.__d4FailBuild = (command) => {
        if (command !== text) {
            return false;
        }
        at.push(Date.now());
        return at.length <= 7; // 7 transient (EBUSY) failures, then the build succeeds
    };
    try {
        const d2 = dispatch(C, sid, c, text, {}, native);
        await waitFor(() => userRows(inst, text) === 1, 'pushed into the same process once the busy cause cleared', 8000);
        assert.equal(at.length, 8, 'one prompt build per pass');
        // at[0] is the first push, at[1] the immediate re-check; then one pass per pause.
        const gaps = at.slice(2).map((t, i) => t - at[i + 1]);
        const expected = [50, 100, 200, 400, 800, 1000];
        for (let i = 0; i < expected.length; i += 1) {
            assert.ok(gaps[i] >= expected[i] - 5, `pause ${i + 1} is ${gaps[i]} ms, expected >= ${expected[i]} ms (gaps ${JSON.stringify(gaps)})`);
        }
        assert.ok(gaps[5] < 1500, `the pause is capped at 1 s, not doubled to 1.6 s (gaps ${JSON.stringify(gaps)})`);
        finish(inst);
        await d2.done;
        assert.equal(fake.state.spawns.length, 1, '0 spawns');
        assert.equal(userRows(inst, text), 1, 'delivered exactly once');
        assert.equal(c.sent.filter((m) => m.kind === 'error').length, 0, 'no error frame');
    }
    finally {
        delete globalThis.__d4FailBuild;
    }
});

p10test('P10 GAP-3 (req 1/10): a ScheduleWakeup-driven turn shows processing, Stop interrupts it, exactly 1 complete; runtime-state bg-work -> in-turn -> idle-held (0600)', async () => {
    const sid = 'app-g3';
    const c = conn();
    const { d, inst } = await seed(A, sid, c, 'native-g3', {}, { bg: 'wakeup' });
    const heldState = stateOf(sid);
    const heldEntry = readState().find((e) => e.appSessionId === sid) || null;
    const seqBefore = d.run.lastSeq;
    assistant(inst, 'woke up from ScheduleWakeup');
    await waitFor(() => registry.isProcessing(sid), 'wake-up turn shows processing');
    const turnState = stateOf(sid);
    assert.equal(inst._stdin.length, 1, 'no CloudCLI prompt drove this turn');
    assert.equal(await stop(A, sid), true, 'Stop reaches the self-driven turn');
    assert.equal(inst.interrupts, 1);
    await tick(60);
    const completes = completesAfter(c, seqBefore);
    assert.equal(completes.length, 1, 'exactly one complete');
    assert.equal(completes[0].aborted, true);
    assert.equal(inst._stdinClosed, false, 'process kept');
    assert.equal(heldState, 'bg-work', 'runtime-state bg-work while the wake-up is pending');
    assert.equal(heldEntry.providerSessionId, 'native-g3');
    assert.ok(Number.isInteger(heldEntry.pid) && heldEntry.pid > 0 && Number.isInteger(heldEntry.since), 'pid is an int > 0 (p11 reader contract)');
    assert.equal(turnState, 'in-turn', 'runtime-state in-turn during the wake-up turn');
    await waitFor(() => stateOf(sid) === 'idle-held', 'runtime-state idle-held after the interrupted wake-up turn');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, 'runtime-state file is 0600');
});

p10test('P10 GAP-10: abort 200 ms into the FIRST turn of a new chat keeps the process; the next send continues the SAME provider session (no new transcript)', async () => {
    const sid = 'app-g10';
    const c = conn();
    const d = dispatch(A, sid, c, 'first message of a new chat', {}, null);
    await waitFor(() => fake.state.spawns.length === 1 && last()._stdin.length >= 1, 'spawned');
    const inst = last();
    inst.sid = 'native-g10';
    await tick(200);
    assert.equal(await stop(A, sid), true);
    await tick(40);
    assert.equal(inst._stdinClosed, false, 'first-turn abort keeps the CLI (no orphaned transcript)');
    assert.equal(A.isClaudeSDKSessionActive(sid), true);
    const d2 = dispatch(A, sid, c, 'second message', {}, 'native-g10');
    await waitFor(() => inst._stdin.length === 2, 'next send goes to the same process');
    finish(inst);
    await d2.done;
    assert.equal(fake.state.spawns.length, 1, 'still one CLI process and one transcript');
    assert.equal(inst.options.resume, undefined, 'no second --resume process');
    void d;
});

p10test('P10 spec 8 (R3): the idle hold expires at CLOUDCLI_IDLE_HOLD_MS even with CLOUDCLI_BG_WAIT_CEILING_MS=86400000 (ceiling only reaches the CLI env)', async () => {
    const ws = { userId: 'u1', sent: [], send(m) { ws.sent.push(m); }, setSessionId() { } };
    const run = B.queryClaudeSDK('plain turn', opts('app-t8'), ws, ctx('native-t8'));
    await waitFor(() => fake.state.spawns.length === 1 && last()._stdin.length >= 1, 'spawned');
    const inst = last();
    inst.sid = 'native-t8';
    assert.equal(inst.options.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '86400000');
    const started = Date.now();
    finish(inst);
    await waitFor(() => inst._stdinClosed, 'idle hold released stdin', 3000);
    const held = Date.now() - started;
    assert.ok(held >= 300 && held < 2500, `idle hold lasted ${held} ms (expected ~400)`);
    await run;
});
