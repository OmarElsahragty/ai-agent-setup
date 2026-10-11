// P9: one process per conversation. A new turn for a session whose CLI is
// still alive (stdin held open while background agents run) must be PUSHED
// into that live process (no second spawn) and stream to the session's
// CURRENT writer; background completions reach the same (rebound) writer.
// A push that arrives while a SELF-DRIVEN turn (background follow-up) is
// streaming must wait for that turn's boundary: the follow-up's result goes
// through the bg-completion branch and never settles the pushed waiter, the
// pushed waiter settles only on its OWN result, and stdin is never released
// under a queued push. Incompatible options, edited messages (resume anchor /
// scratch) and changed settings CONTENT retire the live process; since P10
// (apply.d/p10.sh, chained by apply.sh) the replacement spawns exactly once and
// only AFTER the old process has fully exited, background work included -
// never two live processes (single writer). The fake SDK has no in-place
// setModel / setPermissionMode, so a model switch takes that respawn-after-exit
// path here (P10's in-place switch is covered by p10-lifecycle spec 6). Abort
// still interrupts the live instance; the BG ceiling still reaps abandoned
// background-work holds; a mid-run stream error drains pushed turns.
// P10 writes a runtime-state file and reads ~/.claude markers: this suite
// points CLOUDCLI_RUNTIME_STATE and HOME at its temp root, never at the live
// /run/cloudcli/runtime-state.json or the owner's ~/.claude.
//
// The patched (and, for negative controls, the UNPATCHED stock or PRE-PATCHED
// v1 tree via P9_PREPATCHED_TREE) provider is run for real inside a stub tree
// laid out at the provider's relative import paths, with a fake
// @anthropic-ai/claude-agent-sdk that consumes the prompt iterable like the
// real SDK writes to CLI stdin and lets the test drive the message stream.
// No cloudcli service, database, or real CLI is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockSrc } from './stock-src.mjs';
import { createPushablePromptStream, computeSpawnFingerprint } from '../files/claude-prompt-queue.js';

// The patch set this test file belongs to (live: ${AI_SETUP_ROOT}/cloudcli/patches).
const PATCHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = stockSrc();
const REL = 'dist-server/server/modules/providers/list/claude';
// The queue-import insertion as the full apply chain writes it: P9's import
// line as apply.d/p10.sh rewrites it, plus P10's synchronous fs import.
const QUEUE_IMPORT_BLOCK = [
    "import { createPushablePromptStream, computeSpawnFingerprint, computeContentFingerprint as p10ComputeContentFingerprint } from './claude-prompt-queue.js';",
    '// P10: synchronous fs for the runtime-state file and ~/.claude/sessions markers',
    "// (the provider's own `fs` binding is fs.promises).",
    "import p10fs from 'fs';",
    '',
].join('\n');
let root; // apply target + sandboxes, removed in after()
let pkg; // patched package
let provider; // patched dist provider module
let stockProvider; // unpatched stock provider module (negative control)
let fake; // fake sdk state module
let savedEnv; // HOME / CLOUDCLI_RUNTIME_STATE before this suite, restored in after()

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

async function tick() {
    await new Promise((resolve) => setTimeout(resolve, 10));
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 5000, what = 'condition') {
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

function makeWs(name) {
    const ws = {
        name,
        userId: 'u1',
        sent: [],
        _cbs: [],
        send(m) {
            ws.sent.push(m);
            for (const cb of ws._cbs) {
                cb(m);
            }
        },
        setSessionId() { },
        waitKind(kind, timeoutMs = 5000) {
            const found = ws.sent.find((m) => m.kind === kind);
            if (found) {
                return Promise.resolve(found);
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind} on ${name}; saw kinds: ${ws.sent.map((m) => m.kind ?? m.type).join(',')}`)), timeoutMs);
                ws._cbs.push((m) => {
                    if (m.kind === kind) {
                        clearTimeout(timer);
                        resolve(m);
                    }
                });
            });
        },
        countKind(kind) {
            return ws.sent.filter((m) => m.kind === kind).length;
        },
    };
    return ws;
}

const ctx = (nativeId) => ({
    resolveProviderSessionId: () => nativeId,
    // Resolves like the real service: the model the session picked for THIS turn.
    resolveResumeModel: async (sid, model) => model,
    getProviderModels: async () => ({ OPTIONS: [] }),
    normalizeMessage: (m) => [m],
    isProviderInstalled: async () => true,
});

const baseOptions = (sid, extra = {}) => ({
    sessionId: sid,
    sessionSummary: 'p9-test',
    model: 'test-model',
    effort: 'high',
    permissionMode: 'default',
    cwd: '/tmp',
    ...extra,
});

const bgToolUse = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { run_in_background: true } }] } });

// Builds a stub tree so the provider's relative imports resolve: the fake SDK
// lives at a shared absolute path re-exported by each sandbox's node_modules.
// providerSourceFile: null = copy the patched provider from pkg (plus the
// queue module); a path = copy that provider file instead (stock fixture).
function buildSandbox(name, providerSourceFile = null) {
    const sb = path.join(root, name);
    fs.mkdirSync(path.join(sb, 'server', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'server', 'modules', 'providers', 'list', 'claude'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'server', 'modules', 'notifications'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(sb, 'server', 'shared', 'image-attachments.js'), `
export const appendFilesInputTag = (command) => command;
export const buildClaudeUserContent = async (prompt) => prompt;
export const normalizeImageDescriptors = () => [];
`);
    fs.writeFileSync(path.join(sb, 'server', 'shared', 'claude-cli-path.js'), `
export const resolveClaudeCodeExecutablePath = () => null;
`);
    fs.writeFileSync(path.join(sb, 'server', 'shared', 'utils.js'), `
export const createCompleteMessage = (m) => ({ kind: 'complete', ...m });
export const createNormalizedMessage = (m) => ({ ...m });
`);
    fs.writeFileSync(path.join(sb, 'server', 'modules', 'notifications', 'index.js'), `
import rec from ${JSON.stringify(path.join(root, 'rec-notifications.mjs'))};
export const createNotificationEvent = (e) => e;
export const notifyUserIfEnabled = (x) => rec({ fn: 'notifyUserIfEnabled', ...x });
export const notifyBackgroundWorkCompleted = (x) => rec({ fn: 'notifyBackgroundWorkCompleted', ...x });
export const notifyRunFailed = (x) => rec({ fn: 'notifyRunFailed', ...x });
export const notifyRunStopped = (x) => rec({ fn: 'notifyRunStopped', ...x });
`);
    fs.writeFileSync(path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-models.provider.js'), `
export const CLAUDE_PREDEFINED_MODELS = { DEFAULT: 'test-model', OPTIONS: [] };
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';
`);
    const providerTarget = path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-runtime.provider.js');
    fs.copyFileSync(providerSourceFile || path.join(pkg, REL, 'claude-runtime.provider.js'), providerTarget);
    if (!providerSourceFile) {
        fs.copyFileSync(path.join(pkg, REL, 'claude-prompt-queue.js'), path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-prompt-queue.js'));
    }
    const sdkDir = path.join(sb, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', type: 'module', main: 'index.js', exports: './index.js' }));
    fs.writeFileSync(path.join(sdkDir, 'index.js'), `export { query, state, resetFake } from ${JSON.stringify(path.join(root, 'fake-sdk.mjs'))};\n`);
    return path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-runtime.provider.js');
}

const FAKE_SDK = `
export const state = { spawns: [] };
export function resetFake() {
    state.spawns.length = 0;
}
export function query(config) {
    const inst = {
        _stdin: [],
        _stdinClosed: false,
        _events: [],
        _waiters: [],
        _done: false,
        _error: null,
        emit(msg) {
            inst._events.push(msg);
            wake();
        },
        end() {
            inst._done = true;
            wake();
        },
        async interrupt() {
            inst._error = new Error('aborted by test');
            inst._done = true;
            wake();
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
    // The real SDK pulls the prompt iterable and writes it to the CLI's stdin;
    // when the iterable ends (release) the CLI exits and its message stream ends.
    (async () => {
        try {
            for await (const message of config.prompt) {
                inst._stdin.push(message);
            }
        }
        catch {
            // aborted mid-write
        }
        finally {
            inst._stdinClosed = true;
            Promise.resolve().then(() => inst.end());
        }
    })();
    // Live (not yet exited) processes at the moment this one was spawned:
    // the P10 single-writer guard requires 0.
    inst.aliveAtSpawn = state.spawns.filter((other) => !other._done).length;
    state.spawns.push(inst);
    return inst;
}
`;

function readNotifications(fn) {
    const file = path.join(root, 'notifications.ndjson');
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !fn || e.fn === fn);
}

// Starts turn 1 and walks it to the held state: one spawn, seed message on
// stdin, background work started, result processed, complete sent, held open.
async function startHeldRun(providerMod, sid, ws, nativeId, extra = {}) {
    const run = providerMod.queryClaudeSDK('first turn', baseOptions(sid, extra), ws, ctx(nativeId));
    await waitFor(() => fake.state.spawns.length >= 1 && fake.state.spawns[fake.state.spawns.length - 1]._stdin.length >= 1, 5000, 'seed message consumed');
    const inst = fake.state.spawns[fake.state.spawns.length - 1];
    inst.emit({ ...bgToolUse(), session_id: nativeId });
    inst.emit({ type: 'result', session_id: nativeId });
    await ws.waitKind('complete');
    assert.equal(inst._stdinClosed, false, 'process held open (background work pending)');
    return { run, inst };
}

// The held process's background work reports back on its own: a self-driven
// follow-up turn (assistant text, then its result).
function finishBackgroundWork(inst, nativeId) {
    inst.emit({ type: 'assistant', session_id: nativeId, message: { role: 'assistant', content: [{ type: 'text', text: 'bg work finished' }] } });
    inst.emit({ type: 'result', session_id: nativeId });
}

before(async () => {
    root = `/var/tmp/claude/p9-apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    // P9_PREPATCHED_TREE: run the suite against an already-patched tree (the
    // v1 fixture or plain stock) WITHOUT applying — negative-control mode.
    if (process.env.P9_PREPATCHED_TREE) {
        fs.cpSync(process.env.P9_PREPATCHED_TREE, pkg, { recursive: true });
    }
    else {
        fs.cpSync(SRC, pkg, { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'fake-sdk.mjs'), FAKE_SDK);
    fs.writeFileSync(path.join(root, 'rec-notifications.mjs'), `
import fs from 'node:fs';
const file = ${JSON.stringify(path.join(root, 'notifications.ndjson'))};
export default (value) => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
`);
    if (!process.env.P9_PREPATCHED_TREE) {
        const applied = runApply([root]);
        assert.equal(applied.status, 0, `apply stdout:\\n${applied.stdout}\\nstderr:\\n${applied.stderr}`);
        assert.ok(applied.stdout.includes('P9 patched:'), applied.stdout);
    }
    // P10 runtime state + ~/.claude markers stay inside the temp root.
    savedEnv = { HOME: process.env.HOME, CLOUDCLI_RUNTIME_STATE: process.env.CLOUDCLI_RUNTIME_STATE };
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    process.env.HOME = path.join(root, 'home');
    process.env.CLOUDCLI_RUNTIME_STATE = path.join(root, 'run', 'runtime-state.json');
    fake = await import(path.join(root, 'fake-sdk.mjs'));
    provider = await import(buildSandbox('sb-patched'));
    stockProvider = await import(buildSandbox('sb-stock', path.join(SRC, REL, 'claude-runtime.provider.js')));
});

after(async () => {
    for (const [key, value] of Object.entries(savedEnv || {})) {
        if (value === undefined) {
            delete process.env[key];
        }
        else {
            process.env[key] = value;
        }
    }
    await fsp.rm(root, { recursive: true, force: true });
});

test('queue: hold semantics unchanged when nothing is pushed', async () => {
    const q = createPushablePromptStream([{ n: 1 }, { n: 2 }]);
    assert.equal(q.isReleased(), false);
    const it = q.stream[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: { n: 1 }, done: false });
    assert.deepEqual(await it.next(), { value: { n: 2 }, done: false });
    let parkedResolved = false;
    const third = it.next().then((r) => {
        parkedResolved = true;
        return r;
    });
    await tick();
    assert.equal(parkedResolved, false, 'parks after the seed messages, exactly like the old held stream');
    q.release();
    assert.deepEqual(await third, { value: undefined, done: true });
    assert.equal(q.isReleased(), true);
});

test('queue: push appends in order; release stops delivery', async () => {
    const q = createPushablePromptStream([{ n: 1 }]);
    const it = q.stream[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: { n: 1 }, done: false });
    const second = it.next();
    q.push([{ n: 2 }, { n: 3 }]);
    assert.deepEqual(await second, { value: { n: 2 }, done: false });
    assert.deepEqual(await it.next(), { value: { n: 3 }, done: false });
    q.release();
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    q.push([{ n: 4 }]);
    assert.deepEqual(await it.next(), { value: undefined, done: true }, 'nothing is delivered after release');
});

test('queue fingerprint: changes with settings file mtime/size, stat-only', async () => {
    const home = fs.mkdtempSync('/var/tmp/claude/p9-fph-');
    const proj = fs.mkdtempSync('/var/tmp/claude/p9-fpp-');
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
        fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), '{}\n');
        const fp1 = await computeSpawnFingerprint(proj);
        assert.equal(await computeSpawnFingerprint(proj), fp1, 'stable while untouched');
        const future = new Date(Date.now() + 5000);
        await fsp.utimes(path.join(proj, '.claude', 'settings.json'), future, future);
        const fp2 = await computeSpawnFingerprint(proj);
        assert.notEqual(fp2, fp1, 'mtime change alters the fingerprint');
        fs.appendFileSync(path.join(proj, '.claude', 'settings.json'), '{"x":1}\n');
        assert.notEqual(await computeSpawnFingerprint(proj), fp2, 'size change alters the fingerprint');
        // Missing files contribute stable markers; no file CONTENT is included.
        assert.ok(!fp1.includes('{'), 'stat data only, never file content');
        // ~/.claude.json churn (written by every CLI on the host) must NOT break reuse.
        const fp3 = await computeSpawnFingerprint(proj);
        fs.writeFileSync(path.join(home, '.claude.json'), '{"numStartups":7}\n');
        assert.equal(await computeSpawnFingerprint(proj), fp3, '~/.claude.json writes do not alter the fingerprint');
        // The resolved MCP set is hashed: key order is irrelevant, any value change alters it, no content leaks.
        const m1 = { a: { url: 'http://h/a', headers: { T: 'secret-value' } }, b: { url: 'http://h/b' } };
        const m2 = { b: { url: 'http://h/b' }, a: { headers: { T: 'secret-value' }, url: 'http://h/a' } };
        const fm1 = await computeSpawnFingerprint(proj, m1);
        assert.equal(await computeSpawnFingerprint(proj, m2), fm1, 'MCP key order does not matter');
        assert.notEqual(await computeSpawnFingerprint(proj, { ...m1, c: { url: 'http://h/c' } }), fm1, 'MCP change alters it');
        assert.notEqual(await computeSpawnFingerprint(proj, null), fm1, 'MCP removal alters it');
        assert.ok(!fm1.includes('secret-value') && !fm1.includes('http://h'), 'MCP content never in the fingerprint');
    }
    finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(proj, { recursive: true, force: true });
    }
});

test('P9: a compatible second turn is pushed into the live process (no 2nd spawn) and streams to the NEW writer', async () => {
    fake.resetFake();
    const sid = 'app-push';
    const ws1 = makeWs('ws1');
    const ws2 = makeWs('ws2');
    const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-push');
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-push'));
    await waitFor(() => inst._stdin.length === 2, 5000, 'pushed message on stdin');
    assert.equal(fake.state.spawns.length, 1, 'NO second spawn for a compatible follow-up turn');
    assert.equal(inst._stdin[1].message.content, 'second turn', 'the turn-2 prompt went into the SAME process');
    assert.equal(inst._stdin[1].message.role, 'user');
    inst.emit({ type: 'assistant', session_id: 'native-push', message: { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] } });
    inst.emit({ type: 'result', session_id: 'native-push' });
    await t2;
    assert.ok(ws2.sent.some((m) => JSON.stringify(m).includes('answer 2')), 'turn-2 assistant event reached the NEW writer');
    const complete2 = await ws2.waitKind('complete');
    assert.equal(complete2.exitCode, 0, 'turn 2 reported its own complete');
    assert.equal(ws1.sent.filter((m) => JSON.stringify(m).includes('answer 2')).length, 0, 'the OLD writer saw nothing of turn 2');
    // Turn 2 started no NEW background work, but turn 1's background work is
    // still owed, so the process must stay held until it reports back.
    await tick();
    assert.equal(inst._stdinClosed, false, 'heldForBackgroundWork survives the push');
    inst.emit({ type: 'assistant', session_id: 'native-push', message: { role: 'assistant', content: [{ type: 'text', text: 'bg work finished' }] } });
    inst.emit({ type: 'result', session_id: 'native-push' });
    await waitFor(() => ws2.sent.some((m) => JSON.stringify(m).includes('bg work finished')), 5000, 'bg completion on ws2');
    // P9r: even with nothing owed any more the process STAYS held for reuse
    // (idle-ceiling bounded) instead of being released at the result.
    await tick();
    assert.equal(inst._stdinClosed, false, 'P9r: stays held for reuse once the owed work reported');
    inst.end(); // in production the idle ceiling reaps the hold; simulate the CLI exit
    await t1;
    assert.ok(!provider.getActiveClaudeSDKSessions().includes(sid), 'session entry removed when the run ends');
});

test('P9 regression: a push arriving while a background follow-up streams waits for the turn boundary', async () => {
    fake.resetFake();
    const sid = 'app-blk';
    const ws1 = makeWs('ws1');
    const ws2 = makeWs('ws2');
    const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-blk');
    // The held process starts a SELF-DRIVEN follow-up turn (the background
    // agent reporting in) and it is still streaming.
    inst.emit({ type: 'assistant', session_id: 'native-blk', message: { role: 'assistant', content: [{ type: 'text', text: 'bg progress' }] } });
    await tick();
    // Turn 2 arrives MID-FLIGHT. It must NOT steal this turn's result.
    let done2 = false;
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-blk')).then(() => {
        done2 = true;
    });
    await tick();
    await tick();
    assert.equal(inst._stdin.length, 1, 'the push waits for the in-flight self-driven turn');
    assert.equal(ws2.countKind('complete'), 0, 'no complete for turn 2 yet');
    // The follow-up turn ends: its result belongs to IT, not to turn 2.
    inst.emit({ type: 'result', session_id: 'native-blk' });
    await waitFor(() => inst._stdin.length === 2, 5000, 'push lands only after the boundary');
    assert.equal(done2, false, 'no early resolve: the follow-up result did not settle turn 2');
    assert.equal(ws2.countKind('complete'), 0, 'the self-driven result produced no false complete');
    assert.equal(inst._stdinClosed, false, 'stdin stays open for the queued push');
    assert.ok(readNotifications('notifyBackgroundWorkCompleted').some((e) => e.sessionId === sid), 'the follow-up went through the bg-completion branch');
    // Turn 2 finally runs and answers on the new writer.
    inst.emit({ type: 'assistant', session_id: 'native-blk', message: { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] } });
    inst.emit({ type: 'result', session_id: 'native-blk' });
    await t2;
    assert.ok(ws2.sent.some((m) => JSON.stringify(m).includes('answer 2')), 'turn 2 answer reached the new writer');
    assert.equal(ws2.countKind('complete'), 1, 'exactly one complete for turn 2');
    assert.equal(fake.state.spawns.length, 1, 'still exactly one process');
    // P9r: nothing is owed any more, but the process stays held for reuse.
    await tick();
    assert.equal(inst._stdinClosed, false, 'P9r: held for reuse after the last turn (nothing owed)');
    inst.end(); // the idle ceiling reaps the hold in production; simulate the CLI exit
    await t1;
});

test('P9: a background completion on the held process reaches the CURRENT (rebound) writer', async () => {
    fake.resetFake();
    const sid = 'app-bg';
    const ws1 = makeWs('ws1');
    const ws2 = makeWs('ws2');
    const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-bg');
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-bg'));
    await waitFor(() => inst._stdin.length === 2, 5000, 'turn 2 pushed');
    // Turn 2 also starts background work, so the process stays held afterwards.
    inst.emit({ ...bgToolUse(), session_id: 'native-bg' });
    inst.emit({ type: 'result', session_id: 'native-bg' });
    await t2;
    await ws2.waitKind('complete');
    // The background agent finishes: the CLI pushes a follow-up turn on its own.
    inst.emit({ type: 'assistant', session_id: 'native-bg', message: { role: 'assistant', content: [{ type: 'text', text: 'bg work finished' }] } });
    inst.emit({ type: 'result', session_id: 'native-bg' });
    await waitFor(() => ws2.sent.some((m) => JSON.stringify(m).includes('bg work finished')), 5000, 'bg completion on ws2');
    assert.ok(readNotifications('notifyBackgroundWorkCompleted').some((e) => e.sessionId === sid), 'notifyBackgroundWorkCompleted fired');
    assert.equal(ws1.sent.filter((m) => JSON.stringify(m).includes('bg work finished')).length, 0, 'old writer skipped');
    // P9r: the process stays held for reuse after the bg completion turn.
    await tick();
    assert.equal(inst._stdinClosed, false, 'P9r: held for reuse after the bg completion turn');
    inst.end(); // the idle ceiling reaps the hold in production; simulate the CLI exit
    await t1;
});

// P10 single writer: a turn that cannot reuse the live process (an option the
// process cannot switch in place, an edited message, changed settings CONTENT)
// retires it and spawns exactly once, only after the retired process fully
// exited - here, once its owed background work has reported back. The turn is
// never pushed into the retiring process.
async function respawnAfterExit(oldInst, nativeId, prompt, stdinBefore) {
    await sleep(300);
    assert.equal(fake.state.spawns.length, 1, 'no second process while the retired one still owes background work');
    assert.equal(oldInst._stdin.length, stdinBefore, 'the turn was not pushed into the retired process');
    assert.equal(oldInst._stdinClosed, false, 'retire never releases stdin over pending background work');
    finishBackgroundWork(oldInst, nativeId);
    await waitFor(() => fake.state.spawns.length === 2, 5000, 'one spawn once the retired process exited');
    const next = fake.state.spawns[1];
    assert.equal(oldInst._stdinClosed, true, 'the retired process released stdin once its work reported back');
    assert.equal(next.aliveAtSpawn, 0, 'never two live processes: the retired one had exited before the spawn');
    await waitFor(() => next._stdin.length === 1, 5000, 'turn prompt consumed by the new process');
    assert.ok(JSON.stringify(next._stdin[0]).includes(prompt), 'the new process received this turn');
    return next;
}

test('P9 + P10: incompatible options (different model) respawn exactly once, only after the live process exits', async () => {
    fake.resetFake();
    const sid = 'app-incompat';
    const ws1 = makeWs('ws1');
    const { run: t1, inst: inst1 } = await startHeldRun(provider, sid, ws1, 'native-incompat');
    const ws2 = makeWs('ws2');
    // The fake has no setModel, so P10's in-place switch fails and the turn
    // takes the respawn-after-exit path.
    const t2 = provider.queryClaudeSDK('other model turn', baseOptions(sid, { model: 'other-model' }), ws2, ctx('native-incompat'));
    const inst2 = await respawnAfterExit(inst1, 'native-incompat', 'other model turn', 1);
    assert.notEqual(inst1, inst2);
    inst2.emit({ type: 'result', session_id: 'native-incompat' });
    await ws2.waitKind('complete');
    inst2.end(); // P9r: the new process is held for reuse after its result; end it
    await t2;
    await t1; // the retired run wound down once its background work reported back
    assert.equal(fake.state.spawns.length, 2, 'exactly one respawn');
    assert.ok(ws2.sent.some((m) => m.kind === 'complete'), 'the new process reported completion');
});

test('P9 + P10: edited-message turns (resumeAnchorId / resumeFromScratch) never reuse the live process and respawn only after it exits', async () => {
    for (const extra of [{ resumeAnchorId: 'uuid-last-kept' }, { resumeFromScratch: true }]) {
        fake.resetFake();
        const sid = `app-anchor-${extra.resumeAnchorId ? 'a' : 's'}`;
        const nativeId = `native-${sid}`;
        const ws1 = makeWs('ws1');
        const { run: t1, inst: inst1 } = await startHeldRun(provider, sid, ws1, nativeId);
        const ws2 = makeWs('ws2');
        const t2 = provider.queryClaudeSDK('edited turn', baseOptions(sid, extra), ws2, ctx(nativeId));
        const inst2 = await respawnAfterExit(inst1, nativeId, 'edited turn', 1);
        inst2.emit({ type: 'result', session_id: nativeId });
        await ws2.waitKind('complete');
        inst2.end(); // P9r: held for reuse after its result; end it
        await t2;
        await t1;
        assert.equal(fake.state.spawns.length, 2, `an edited message never reuses the live process (${JSON.stringify(extra)})`);
    }
});

test('P9 + P10: a settings CONTENT change between turns retires the live process; a touch keeps reuse', async () => {
    fake.resetFake();
    const home = fs.mkdtempSync('/var/tmp/claude/p9-fp-home-');
    const proj = fs.mkdtempSync('/var/tmp/claude/p9-fp-proj-');
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
        const settings = path.join(proj, '.claude', 'settings.json');
        fs.mkdirSync(path.dirname(settings), { recursive: true });
        fs.writeFileSync(settings, '{}\n');
        const sid = 'app-fp';
        const ws1 = makeWs('ws1');
        const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-fp', { cwd: proj });
        const ws2 = makeWs('ws2');
        const t2 = provider.queryClaudeSDK('second', baseOptions(sid, { cwd: proj }), ws2, ctx('native-fp'));
        await waitFor(() => inst._stdin.length === 2, 5000, 'unchanged settings: turn pushed');
        assert.equal(fake.state.spawns.length, 1, 'unchanged settings: still one process');
        inst.emit({ type: 'result', session_id: 'native-fp' });
        await t2;
        // P10 req 7: settings are fingerprinted by CONTENT, so a same-content
        // rewrite (an mtime-only touch) keeps reuse.
        const future = new Date(Date.now() + 5000);
        await fsp.utimes(settings, future, future);
        const ws3 = makeWs('ws3');
        const t3 = provider.queryClaudeSDK('third', baseOptions(sid, { cwd: proj }), ws3, ctx('native-fp'));
        await waitFor(() => inst._stdin.length === 3, 5000, 'touched settings: turn pushed');
        assert.equal(fake.state.spawns.length, 1, 'touched settings: still one process');
        inst.emit({ type: 'result', session_id: 'native-fp' });
        await t3;
        // A CONTENT change in a settings file the spawn read: reuse is refused now.
        fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(ls:*)"]}}\n');
        const ws4 = makeWs('ws4');
        const t4 = provider.queryClaudeSDK('fourth', baseOptions(sid, { cwd: proj }), ws4, ctx('native-fp'));
        const inst2 = await respawnAfterExit(inst, 'native-fp', 'fourth', 3);
        inst2.emit({ type: 'result', session_id: 'native-fp' });
        await ws4.waitKind('complete');
        inst2.end(); // P9r: held for reuse after its result; end it
        await t4;
        await t1;
        assert.equal(fake.state.spawns.length, 2, 'a changed settings content never reuses the live process');
    }
    finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        }
        else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(proj, { recursive: true, force: true });
    }
});

test('P9: abort still interrupts the live instance and releases a pushed turn', async () => {
    fake.resetFake();
    const sid = 'app-abort';
    const ws1 = makeWs('ws1');
    const ws2 = makeWs('ws2');
    const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-abort');
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-abort'));
    await waitFor(() => inst._stdin.length === 2, 5000, 'turn 2 pushed before abort');
    const aborted = await provider.abortClaudeSDKSession(sid);
    assert.equal(aborted, true, 'abort found the live instance');
    await t2;
    await t1;
    assert.equal(fake.state.spawns.length, 1, 'still exactly one process');
    assert.ok(!provider.getActiveClaudeSDKSessions().includes(sid), 'entry removed by abort');
});

test('P9: a mid-run stream error drains pushed turns and surfaces the error', async () => {
    fake.resetFake();
    const sid = 'app-err';
    const ws1 = makeWs('ws1');
    const ws2 = makeWs('ws2');
    const { run: t1, inst } = await startHeldRun(provider, sid, ws1, 'native-err');
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-err'));
    await waitFor(() => inst._stdin.length === 2, 5000, 'turn 2 pushed before the error');
    await inst.interrupt(); // stream throws with NO abort flag: crash path
    await t1;
    await t2; // both settle: the finally drained the pushed waiter
    assert.equal(fake.state.spawns.length, 1);
    assert.ok(ws2.sent.some((m) => m.kind === 'error'), 'the error reached the CURRENT writer');
    assert.ok(!provider.getActiveClaudeSDKSessions().includes(sid), 'entry cleaned up');
});

test('P9 + P10: the BG ceiling still reaps an abandoned hold; the next turn spawns fresh and its idle hold is not on the BG ceiling', async () => {
    fake.resetFake();
    process.env.CLOUDCLI_BG_WAIT_CEILING_MS = '100';
    try {
        // A separate module URL so this provider instance reads the small ceiling.
        const providerCeiling = await import(buildSandbox('sb-ceiling'));
        const sid = 'app-ceiling';
        const ws1 = makeWs('ws1');
        const { run: t1, inst } = await startHeldRun(providerCeiling, sid, ws1, 'native-ceiling');
        await waitFor(() => inst._stdinClosed === true, 5000, 'ceiling released the abandoned hold');
        await t1;
        const ws2 = makeWs('ws2');
        const t2 = providerCeiling.queryClaudeSDK('after ceiling', baseOptions(sid), ws2, ctx('native-ceiling'));
        await waitFor(() => fake.state.spawns.length === 2, 5000, 'fresh spawn after the ceiling reaped the old hold');
        const inst2 = fake.state.spawns[1];
        assert.equal(inst2.aliveAtSpawn, 0, 'the reaped process had exited before the fresh spawn');
        await waitFor(() => inst2._stdin.length === 1, 5000, 'turn prompt consumed by the new process');
        inst2.emit({ type: 'result', session_id: 'native-ceiling' });
        await ws2.waitKind('complete');
        // P10 R3: an idle hold (nothing owed) is bounded by CLOUDCLI_IDLE_HOLD_MS
        // (default 30 min), never by the 100 ms background-work ceiling.
        await sleep(300);
        assert.equal(inst2._stdinClosed, false, 'P10 R3: the idle hold does not run on the BG ceiling');
        inst2.end(); // the idle bound reaps the hold in production; simulate the CLI exit
        await t2;
        assert.equal(fake.state.spawns.length, 2, 'a released hold is never reused');
    }
    finally {
        delete process.env.CLOUDCLI_BG_WAIT_CEILING_MS;
    }
});

test('P9 negative control: the UNPATCHED provider spawns a second process for turn 2', async () => {
    fake.resetFake();
    const sid = 'app-stock';
    const ws1 = makeWs('ws1');
    const nativeId = 'native-stock';
    const t1 = stockProvider.queryClaudeSDK('first turn', baseOptions(sid), ws1, ctx(nativeId));
    await waitFor(() => fake.state.spawns.length === 1 && fake.state.spawns[0]._stdin.length >= 1, 5000, 'stock seed consumed');
    const inst1 = fake.state.spawns[0];
    inst1.emit({ ...bgToolUse(), session_id: nativeId });
    inst1.emit({ type: 'result', session_id: nativeId });
    await ws1.waitKind('complete');
    const ws2 = makeWs('ws2');
    const t2 = stockProvider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx(nativeId));
    await waitFor(() => fake.state.spawns.length === 2, 5000, 'stock second spawn');
    assert.equal(fake.state.spawns.length, 2, 'unpatched behaviour: every turn spawns a new CLI process (the patched reuse assertion spawned===1 FAILS here)');
    const inst2 = fake.state.spawns[1];
    await waitFor(() => inst2._stdin.length >= 1, 5000, 'stock turn-2 seed consumed');
    inst2.emit({ type: 'result', session_id: nativeId });
    await t2;
    await t1;
});

test('P9: patched providers parse and v2 markers are present in dist + src', async () => {
    for (const rel of [REL, REL.replace('dist-server/', '')]) {
        const file = path.join(pkg, rel, 'claude-runtime.provider.js');
        const text = fs.readFileSync(file, 'utf8');
        assert.match(text, /createPushablePromptStream/, `queue import in ${rel}`);
        assert.match(text, /resultIsForPushedTurn/, `turn-origin tracking in ${rel}`);
        assert.match(text, /pumpPushGate/, `push gate in ${rel}`);
        assert.match(text, /settingsFp/, `settings fingerprint in ${rel}`);
        assert.match(text, /pushGateWaiters\.length \+ imminentPushes|P9r: the live process STAYS held/, `release policy (P9 guard or P9r idle hold) in ${rel}`);
        assert.match(text, /drainPushedTurns\(\);/, `drain hook in ${rel}`);
        assert.match(text, /currentWriter\(\)\.send\(/, `current-writer emits in ${rel}`);
        assert.equal((text.match(/from '\.\/claude-prompt-queue\.js';/g) || []).length, 1, `exactly one queue import in ${rel}`);
        const checkTarget = path.join(root, `p9-check-${path.basename(path.dirname(rel))}-${path.basename(rel)}.mjs`);
        fs.copyFileSync(file, checkTarget);
        const check = spawnSync('node', ['--check', checkTarget], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${file}: ${check.stderr}`);
    }
});

test('P9: a partial apply is completed by a re-run without duplicate insertions', () => {
    const fresh = `/var/tmp/claude/p9-partial-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    try {
        fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
        const first = runApply([fresh]);
        assert.equal(first.status, 0, first.stderr);
        const dist = path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli', REL, 'claude-runtime.provider.js');
        // Simulate a partial apply: the queue import insertion was lost (as if
        // the shell died between insertions) - P9's queue import as P10 rewrites
        // it, together with the P10 fs import right below it. The .bak-pre-p9
        // backup is the ORIGINAL, so the re-run must complete — not restore to stock.
        const text = fs.readFileSync(dist, 'utf8');
        const damaged = text.replace(QUEUE_IMPORT_BLOCK, '');
        assert.notEqual(damaged, text, 'the queue import insertion was found and removed');
        fs.writeFileSync(dist, damaged);
        const damagedCheck = runApply(['--check', fresh]);
        assert.equal(damagedCheck.status, 1, 'the partial state fails --check');
        const rerun = runApply([fresh]);
        assert.equal(rerun.status, 0, rerun.stderr);
        assert.ok(rerun.stdout.includes('P9 patched:'), rerun.stdout);
        const fixed = fs.readFileSync(dist, 'utf8');
        assert.equal((fixed.match(/from '\.\/claude-prompt-queue\.js';/g) || []).length, 1, 'exactly one queue import after the re-run');
        assert.equal((fixed.match(/^import p10fs from 'fs';$/gm) || []).length, 1, 'exactly one P10 fs import after the re-run');
        assert.equal(fixed, text, 'the re-run reproduced the complete patched file byte-for-byte');
        const check = runApply(['--check', fresh]);
        assert.equal(check.status, 0, check.stderr);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});

test('apply.sh is idempotent for P9 and --check passes afterwards', () => {
    const dist = path.join(pkg, REL, 'claude-runtime.provider.js');
    const before = fs.readFileSync(dist, 'utf8');
    const again = runApply([root]);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes('P9 already applied:'), again.stdout);
    assert.equal(fs.readFileSync(dist, 'utf8'), before);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes('check OK'), check.stdout);
    assert.ok(fs.existsSync(`${dist}.bak-pre-p9`), 'the pre-P9 rollback backup exists');
});
