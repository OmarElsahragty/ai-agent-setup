// P9r regression tests: one root cause per test, all against the REAL patched
// provider running on the stub tree with the fake SDK (same harness shape as
// p9-one-process.test.mjs).
//
//   R1 (root cause A - the live defect): a turn that ends with NO background
//      work must still leave the process HELD so the NEXT compatible turn is
//      pushed into it. On 2026-10-08 the live install spawned a fresh CLI per
//      turn (494751be: 16:39, 18:06, 18:36, 20:07, 20:09 - the last two just
//      81 s apart with identical options) because the P9-era code released
//      stdin at every plain result, so reuse never engaged.
//   R2/R3 (root cause B): an INCOMPATIBLE turn (permission-mode/options
//      change) gracefully RETIRES the live process - release at a turn
//      boundary, never a mid-turn interrupt - instead of the legacy
//      interrupt+release supersede that left unbounded processes behind.
//      Since P10 (apply.d/p10.sh, chained by apply.sh) the replacement spawns
//      exactly once and only AFTER the retired process has exited - never two
//      live processes (single writer). The fake SDK has no in-place
//      setModel / setPermissionMode, so these option changes take P10's
//      respawn-after-exit path (the in-place switch is p10-lifecycle spec 6).
//   R4: the retire backstop (CLOUDCLI_RETIRE_BACKSTOP_MS since P10)
//      interrupts a turn that never ends - never an orphan; the waiting turn
//      then spawns exactly once (P10 F6b: the spawn wait outlives the backstop
//      by a grace margin, so it is never refused by a same-instant race).
//   R5 (root cause C): the spawn fingerprint ignores per-start volatile MCP
//      values (credential-like env values, header values, URL query churn)
//      while still detecting real config changes.
//   R6: the idle hold bound (CLOUDCLI_IDLE_HOLD_MS since P10, separate from
//      the background-work ceiling) still reaps a plain-turn hold, so the
//      reuse hold is bounded.
//   R7 (apply.sh): the queue's .bak-pre-p9r rollback copy is only ever made
//      from a still-unpatched queue (never on a fresh stock tree's 2nd apply).
//
// P10 writes a runtime-state file and reads ~/.claude markers: this suite
// points CLOUDCLI_RUNTIME_STATE and HOME at its temp root, never at the live
// /run/cloudcli/runtime-state.json or the owner's ~/.claude.
//
// Negative control: P9R_PREPATCHED_TREE=<pkg-dir> (a tree with P9 but WITHOUT
// P9r - build one with APPLY_P9R=0 bash apply.sh <root>) runs this suite
// against that tree; R1-R5 must FAIL there (exit 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockSrc } from './stock-src.mjs';

// The patch set this test file belongs to (live: ${AI_SETUP_ROOT}/cloudcli/patches).
const PATCHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = stockSrc();
const REL = 'dist-server/server/modules/providers/list/claude';
let root;
let pkg;
let provider;
let fake;
let queue;
let savedEnv; // HOME / CLOUDCLI_RUNTIME_STATE before this suite, restored in after()

function runApply(args, env = {}) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
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
                const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind} on ${name}`)), timeoutMs);
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
    resolveResumeModel: async (sid, model) => model,
    getProviderModels: async () => ({ OPTIONS: [] }),
    normalizeMessage: (m) => [m],
    isProviderInstalled: async () => true,
});

const baseOptions = (sid, extra = {}) => ({
    sessionId: sid,
    sessionSummary: 'p9r-test',
    model: 'test-model',
    effort: 'high',
    permissionMode: 'default',
    cwd: '/tmp',
    ...extra,
});

// Minimal stub tree (same shape as the P9 suite's) so the provider's relative
// imports resolve; the fake SDK consumes the prompt iterable like the real one
// writes to CLI stdin.
function buildSandbox(name) {
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
export const createNotificationEvent = (e) => e;
export const notifyUserIfEnabled = () => { };
export const notifyBackgroundWorkCompleted = () => { };
export const notifyRunFailed = () => { };
export const notifyRunStopped = () => { };
`);
    fs.writeFileSync(path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-models.provider.js'), `
export const CLAUDE_PREDEFINED_MODELS = { DEFAULT: 'test-model', OPTIONS: [] };
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';
`);
    const providerTarget = path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-runtime.provider.js');
    fs.copyFileSync(path.join(pkg, REL, 'claude-runtime.provider.js'), providerTarget);
    fs.copyFileSync(path.join(pkg, REL, 'claude-prompt-queue.js'), path.join(sb, 'server', 'modules', 'providers', 'list', 'claude', 'claude-prompt-queue.js'));
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
        interrupts: 0,
        emit(msg) {
            inst._events.push(msg);
            wake();
        },
        end() {
            inst._done = true;
            wake();
        },
        async interrupt() {
            inst.interrupts += 1;
            // Opt-in (R4): like a real CLI, take a moment to exit after the interrupt.
            if (inst.exitDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, inst.exitDelayMs));
            }
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

// Drives one PLAIN turn (no background work) to its held-for-reuse state.
async function startPlainHeldRun(providerMod, sid, ws, nativeId, extra = {}) {
    const run = providerMod.queryClaudeSDK('first turn', baseOptions(sid, extra), ws, ctx(nativeId));
    await waitFor(() => fake.state.spawns.length >= 1 && fake.state.spawns[fake.state.spawns.length - 1]._stdin.length >= 1, 5000, 'seed message consumed');
    const inst = fake.state.spawns[fake.state.spawns.length - 1];
    inst.emit({ type: 'result', session_id: nativeId });
    await ws.waitKind('complete');
    return { run, inst };
}

before(async () => {
    root = `/var/tmp/claude/p9r-apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    if (process.env.P9R_PREPATCHED_TREE) {
        fs.cpSync(process.env.P9R_PREPATCHED_TREE, pkg, { recursive: true });
    }
    else {
        fs.cpSync(SRC, pkg, { recursive: true });
        const applied = runApply([root]);
        assert.equal(applied.status, 0, `apply stdout:\n${applied.stdout}\nstderr:\n${applied.stderr}`);
        assert.ok(applied.stdout.includes('P9r patched:'), applied.stdout);
    }
    // P10 runtime state + ~/.claude markers stay inside the temp root.
    savedEnv = { HOME: process.env.HOME, CLOUDCLI_RUNTIME_STATE: process.env.CLOUDCLI_RUNTIME_STATE };
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    process.env.HOME = path.join(root, 'home');
    process.env.CLOUDCLI_RUNTIME_STATE = path.join(root, 'run', 'runtime-state.json');
    fs.writeFileSync(path.join(root, 'fake-sdk.mjs'), FAKE_SDK);
    fake = await import(path.join(root, 'fake-sdk.mjs'));
    provider = await import(buildSandbox('sb-p9r'));
    queue = await import(path.join(pkg, REL, 'claude-prompt-queue.js'));
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

test('P9r R1 (root cause A): a plain turn with no background work STAYS held; the next compatible turn is PUSHED (one process)', async () => {
    fake.resetFake();
    const sid = 'app-p9r-r1';
    const ws1 = makeWs('ws1');
    const { run: t1, inst } = await startPlainHeldRun(provider, sid, ws1, 'native-r1');
    await tick();
    assert.equal(inst._stdinClosed, false, 'the plain turn holds the process for reuse (no release at the result)');
    // The very next turn - same options, nothing special - must reuse it.
    const ws2 = makeWs('ws2');
    const t2 = provider.queryClaudeSDK('second turn', baseOptions(sid), ws2, ctx('native-r1'));
    await waitFor(() => inst._stdin.length === 2, 5000, 'turn 2 pushed into the SAME process');
    assert.equal(fake.state.spawns.length, 1, 'no second spawn for a compatible follow-up turn');
    inst.emit({ type: 'assistant', session_id: 'native-r1', message: { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] } });
    inst.emit({ type: 'result', session_id: 'native-r1' });
    await t2;
    await ws2.waitKind('complete');
    inst.end(); // idle ceiling reaps the hold in production
    await t1;
});

test('P9r R2 (root cause B, boundary): an incompatible turn retires the idle live process gracefully - release, NO interrupt', async () => {
    fake.resetFake();
    const sid = 'app-p9r-r2';
    const ws1 = makeWs('ws1');
    const { run: t1, inst: inst1 } = await startPlainHeldRun(provider, sid, ws1, 'native-r2');
    await tick();
    assert.equal(inst1._stdinClosed, false, 'held before the incompatible turn');
    const ws2 = makeWs('ws2');
    const t2 = provider.queryClaudeSDK('other permission mode', baseOptions(sid, { permissionMode: 'bypassPermissions' }), ws2, ctx('native-r2'));
    await waitFor(() => fake.state.spawns.length === 2, 5000, 'incompatible options still spawn a fresh process');
    const inst2 = fake.state.spawns[1];
    assert.notEqual(inst1, inst2);
    await waitFor(() => inst1._stdinClosed === true, 5000, 'the retired process released stdin at its boundary');
    assert.equal(inst1._error, null, 'the retired process was NOT interrupted while idle');
    await t1; // retired run winds down silently
    assert.equal(ws1.countKind('complete'), 1, 'no second complete from the retiring run');
    await waitFor(() => inst2._stdin.length >= 1, 5000, 'turn prompt consumed by the new process');
    inst2.emit({ type: 'result', session_id: 'native-r2' });
    await ws2.waitKind('complete');
    inst2.end(); // the new process is held for reuse after its result; end it
    await t2;
    assert.ok(ws2.sent.some((m) => m.kind === 'complete'), 'the new process reported completion');
});

test('P9r R3 + P10 (root cause B, mid-turn): an incompatible turn lets the in-flight turn FINISH, then releases - never a mid-turn kill, never two live processes', async () => {
    fake.resetFake();
    const sid = 'app-p9r-r3';
    const ws1 = makeWs('ws1');
    const t1 = provider.queryClaudeSDK('long turn', baseOptions(sid), ws1, ctx('native-r3'));
    await waitFor(() => fake.state.spawns.length === 1 && fake.state.spawns[0]._stdin.length >= 1, 5000, 'seed consumed');
    const inst1 = fake.state.spawns[0];
    inst1.emit({ type: 'assistant', session_id: 'native-r3', message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] } });
    await tick();
    // Incompatible turn arrives while turn 1 is IN FLIGHT.
    const ws2 = makeWs('ws2');
    const t2 = provider.queryClaudeSDK('edited-ish incompatible turn', baseOptions(sid, { model: 'other-model' }), ws2, ctx('native-r3'));
    // P10: no second process while the retired one is still running its turn.
    await sleep(300);
    assert.equal(fake.state.spawns.length, 1, 'no second process while the in-flight turn runs');
    assert.equal(inst1.interrupts, 0, 'the in-flight turn was NOT interrupted');
    assert.equal(inst1._stdinClosed, false, 'stdin stays open until the in-flight turn ends');
    assert.equal(inst1._stdin.length, 1, 'the incompatible turn was not pushed into the retired process');
    // The in-flight turn finishes on its own; only then does the retire land.
    inst1.emit({ type: 'result', session_id: 'native-r3' });
    await waitFor(() => inst1._stdinClosed === true, 5000, 'released right after the in-flight turn ended');
    assert.equal(inst1.interrupts, 0, 'still never interrupted');
    await t1;
    await waitFor(() => fake.state.spawns.length === 2, 5000, 'one spawn once the retired process exited');
    const inst2 = fake.state.spawns[1];
    assert.equal(inst2.aliveAtSpawn, 0, 'never two live processes: the retired one had exited before the spawn');
    await waitFor(() => inst2._stdin.length >= 1, 5000, 'turn prompt consumed by the new process');
    inst2.emit({ type: 'result', session_id: 'native-r3' });
    await ws2.waitKind('complete');
    inst2.end(); // the new process is held for reuse after its result; end it
    await t2;
});

test('P9r R4 + P10: the retire backstop interrupts a turn that never ends - never an orphan, never two live processes', async () => {
    fake.resetFake();
    process.env.CLOUDCLI_RETIRE_BACKSTOP_MS = '400';
    try {
        // A separate module URL so this provider instance reads the small backstop.
        const providerBackstop = await import(buildSandbox('sb-p9r-backstop'));
        const sid = 'app-p9r-r4';
        const ws1 = makeWs('ws1');
        const t1 = providerBackstop.queryClaudeSDK('stuck turn', baseOptions(sid), ws1, ctx('native-r4'));
        let t1Settled = false;
        const t1done = t1.then(() => { t1Settled = true; }, () => { t1Settled = true; });
        await waitFor(() => fake.state.spawns.length === 1 && fake.state.spawns[0]._stdin.length >= 1, 5000, 'seed consumed');
        const inst1 = fake.state.spawns[0];
        // The stuck process exits 150 ms after the backstop's interrupt; the spawn
        // wait's grace margin (P10 F6b) has to cover that exit.
        inst1.exitDelayMs = 150;
        inst1.emit({ type: 'assistant', session_id: 'native-r4', message: { role: 'assistant', content: [{ type: 'text', text: 'waiting forever' }] } });
        await tick();
        const ws2 = makeWs('ws2');
        let t2Settled = false;
        const t2 = providerBackstop.queryClaudeSDK('incompatible', baseOptions(sid, { permissionMode: 'acceptEdits' }), ws2, ctx('native-r4'));
        const t2done = t2.then(() => { t2Settled = true; }, () => { t2Settled = true; });
        await sleep(150);
        assert.equal(fake.state.spawns.length, 1, 'no second process while the stuck turn is in flight');
        assert.equal(inst1.interrupts, 0, 'the backstop has not fired yet');
        // The stuck turn NEVER emits its result: the backstop must fire.
        await waitFor(() => t1Settled === true, 5000, 'the retired run settled via the backstop');
        assert.equal(inst1.interrupts, 1, 'the backstop interrupted the stuck turn exactly once');
        assert.equal(inst1._done, true, 'the stuck process ended');
        assert.equal(inst1._stdinClosed, true, 'stdin released');
        await t1done;
        // The spawn wait outlives the backstop by a grace margin (P10 F6b), so the
        // waiting turn always spawns exactly once AFTER the stuck process exited -
        // it is never refused, and there are never two live processes.
        await waitFor(() => fake.state.spawns.length === 2 || t2Settled, 5000, 'the waiting turn spawned after the exit');
        assert.equal(fake.state.spawns.length, 2, `the waiting turn spawned after the exit instead of being refused: ${JSON.stringify(ws2.sent)}`);
        const inst2 = fake.state.spawns[1];
        assert.equal(inst2.aliveAtSpawn, 0, 'never two live processes: the stuck one had ended before the spawn');
        assert.ok(!ws2.sent.some((m) => m.kind === 'error'), `no session_busy_external refusal: ${JSON.stringify(ws2.sent)}`);
        await waitFor(() => inst2._stdin.length >= 1, 5000, 'turn prompt consumed by the new process');
        inst2.emit({ type: 'result', session_id: 'native-r4' });
        await ws2.waitKind('complete');
        inst2.end(); // the new process is held for reuse after its result; end it
        await t2done;
        assert.equal(fake.state.spawns.length, 2, 'exactly one replacement process ever');
    }
    finally {
        delete process.env.CLOUDCLI_RETIRE_BACKSTOP_MS;
    }
});

test('P9r R5 (root cause C): the fingerprint ignores per-start volatile MCP values but detects real changes', async () => {
    const home = fs.mkdtempSync('/var/tmp/claude/p9r-fph-');
    const proj = fs.mkdtempSync('/var/tmp/claude/p9r-fpp-');
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
        fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), '{}\n');
        const mcp = {
            browser: {
                type: 'http',
                url: 'http://127.0.0.1:8790/mcp?connect=abc123def',
                env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN: 'minted-aaa', MODE: 'strict' },
                headers: { Authorization: 'Bearer aaa' },
            },
            helper: { type: 'stdio', command: 'node', args: ['helper.js'] },
        };
        const fp1 = await queue.computeSpawnFingerprint(proj, mcp);
        // Per-start volatile churn: token value, URL query, header value.
        const rotated = JSON.parse(JSON.stringify(mcp));
        rotated.browser.url = 'http://127.0.0.1:8790/mcp?connect=zzz999';
        rotated.browser.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN = 'minted-bbb';
        rotated.browser.headers.Authorization = 'Bearer bbb';
        assert.equal(await queue.computeSpawnFingerprint(proj, rotated), fp1, 'rotating tokens/queries/header values do not change the fingerprint');
        // Real changes DO force a change.
        const added = JSON.parse(JSON.stringify(mcp));
        added.extra = { type: 'http', url: 'http://127.0.0.1:8790/x' };
        assert.notEqual(await queue.computeSpawnFingerprint(proj, added), fp1, 'a server added changes the fingerprint');
        const envChanged = JSON.parse(JSON.stringify(mcp));
        envChanged.browser.env.MODE = 'relaxed';
        assert.notEqual(await queue.computeSpawnFingerprint(proj, envChanged), fp1, 'a non-volatile env value change changes the fingerprint');
        const pathChanged = JSON.parse(JSON.stringify(mcp));
        pathChanged.browser.url = 'http://127.0.0.1:8790/mcp2?connect=abc123def';
        assert.notEqual(await queue.computeSpawnFingerprint(proj, pathChanged), fp1, 'a url PATH change changes the fingerprint');
        const cmdChanged = JSON.parse(JSON.stringify(mcp));
        cmdChanged.helper.args = ['helper2.js'];
        assert.notEqual(await queue.computeSpawnFingerprint(proj, cmdChanged), fp1, 'a command/args change changes the fingerprint');
        assert.ok(!JSON.stringify(mcp) || !fp1.includes('minted') && !fp1.includes('127.0.0.1'), 'no URL/token content in the fingerprint');
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

test('P9r R6 + P10: the idle hold bound (CLOUDCLI_IDLE_HOLD_MS) still reaps a plain-turn hold (bounded reuse)', async () => {
    fake.resetFake();
    process.env.CLOUDCLI_IDLE_HOLD_MS = '100';
    try {
        // A separate module URL so this provider instance reads the small idle bound.
        const providerIdle = await import(buildSandbox('sb-p9r-reap'));
        const sid = 'app-p9r-r6';
        const ws1 = makeWs('ws1');
        const { run: t1, inst } = await startPlainHeldRun(providerIdle, sid, ws1, 'native-r6');
        await waitFor(() => inst._stdinClosed === true, 5000, 'the idle bound reaped the idle hold');
        assert.equal(inst.interrupts, 0, 'reaped by releasing stdin, never by an interrupt');
        await t1;
        const ws2 = makeWs('ws2');
        const t2 = providerIdle.queryClaudeSDK('after idle reap', baseOptions(sid), ws2, ctx('native-r6'));
        await waitFor(() => fake.state.spawns.length === 2, 5000, 'fresh spawn after the idle bound reaped the hold');
        const inst2 = fake.state.spawns[1];
        assert.equal(inst2.aliveAtSpawn, 0, 'the reaped process had exited before the fresh spawn');
        await waitFor(() => inst2._stdin.length >= 1, 5000, 'turn prompt consumed by the new process');
        inst2.emit({ type: 'result', session_id: 'native-r6' });
        await t2; // the new process's own idle hold is reaped by the same bound
        assert.equal(inst2._stdinClosed, true, 'the new hold was reaped too');
        assert.equal(fake.state.spawns.length, 2, 'a released hold is never reused');
    }
    finally {
        delete process.env.CLOUDCLI_IDLE_HOLD_MS;
    }
});

test('P9r R7 (apply.sh): a fresh stock tree never gets a claude-prompt-queue.js.bak-pre-p9r, not even on the second apply; a pre-P9r queue is saved once and kept', () => {
    const roots = [];
    const dirs = [REL, 'server/modules/providers/list/claude'];
    const tree = () => {
        const r = fs.mkdtempSync('/var/tmp/claude/p9r-qbak-');
        roots.push(r);
        const pk = path.join(r, 'node_modules', '@cloudcli-ai', 'cloudcli');
        fs.mkdirSync(path.dirname(pk), { recursive: true });
        fs.cpSync(SRC, pk, { recursive: true });
        return { r, pk };
    };
    try {
        // Fresh stock tree: there is no queue yet, the first apply writes the
        // canonical (already P9r) queue, and the second apply must not save that
        // patched file as the "pre-p9r" rollback copy.
        const fresh = tree();
        for (const d of dirs) {
            assert.equal(fs.existsSync(path.join(fresh.pk, d, 'claude-prompt-queue.js')), false, `the stock tree has no queue in ${d}`);
        }
        for (const n of [1, 2]) {
            const applied = runApply([fresh.r]);
            assert.equal(applied.status, 0, `apply #${n}:\n${applied.stdout}\n${applied.stderr}`);
            for (const d of dirs) {
                assert.equal(fs.existsSync(path.join(fresh.pk, d, 'claude-prompt-queue.js.bak-pre-p9r')), false, `apply #${n}: no pre-p9r copy of the patched queue in ${d}`);
            }
        }
        // A queue that is still pre-P9r (P9 era: no canonicalMcpSet) IS the
        // rollback copy: saved by the first apply, kept by the next.
        const old = tree();
        const p9Era = "// P9-era queue stand-in (pre-P9r: no MCP normalisation)\nexport function createPushablePromptStream() { return null; }\nexport async function computeSpawnFingerprint() { return 'p9'; }\n";
        for (const d of dirs) {
            fs.writeFileSync(path.join(old.pk, d, 'claude-prompt-queue.js'), p9Era);
        }
        for (const n of [1, 2]) {
            const applied = runApply([old.r]);
            assert.equal(applied.status, 0, `apply #${n}:\n${applied.stdout}\n${applied.stderr}`);
            for (const d of dirs) {
                assert.equal(fs.readFileSync(path.join(old.pk, d, 'claude-prompt-queue.js.bak-pre-p9r'), 'utf8'), p9Era, `apply #${n}: the pre-P9r queue is the rollback copy in ${d}`);
                assert.ok(fs.readFileSync(path.join(old.pk, d, 'claude-prompt-queue.js'), 'utf8').includes('export function canonicalMcpSet('), `apply #${n}: the live queue is the patched one in ${d}`);
            }
        }
    }
    finally {
        for (const r of roots) {
            fs.rmSync(r, { recursive: true, force: true });
        }
    }
});
