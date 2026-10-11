// P14 (WO-N5a): live-stream delivery gaps - MASTER M-111 (B-F10/IE-14) and
// M-123 (IE-13 S18 / IF-25).
// A fresh tree is built from the stock fixture: apply.sh (P0-P9r + apply.d p10-p14,
// C-sorted). Negative control: P14_NEGATIVE_CONTROL=1 restores every .bak-pre-p14
// file after the apply; the behavioural cases must fail (the pre-P14 server froze
// a pre-subscribed second tab for a whole run, replayed a truncated buffer with
// no refresh signal, and logged disconnects without a close code).
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stockSrc } from './stock-src.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.resolve(HERE, '..');
const APPLY = path.join(PATCHES, 'apply.sh');
const P14 = path.join(PATCHES, 'apply.d', 'p14.sh');
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const DEPS = process.env.CLOUDCLI_DEPS_DIR ?? `${AI_SETUP_ROOT}/cloudcli/node_modules`;
const MISSING_DEPS = fs.existsSync(DEPS) ? false : `CloudCLI dependency dir missing: ${DEPS} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT or CLOUDCLI_DEPS_DIR to a full install)`;
const test = (name, fn) => nodeTest(name, { skip: MISSING_DEPS }, fn);
const NEGATIVE = process.env.P14_NEGATIVE_CONTROL === '1';
const DS = 'dist-server/server';
const WS = `${DS}/modules/websocket/services`;
const REGISTRY_REL = `${WS}/chat-run-registry.service.js`;
const CHAT_REL = `${WS}/chat-websocket.service.js`;
let root;
let pkg;

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

before(() => {
    if (MISSING_DEPS) return;
    root = fs.mkdtempSync('/var/tmp/claude/p14-test-');
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(stockSrc(), pkg, { recursive: true });
    const applied = run('bash', [APPLY, root]);
    assert.equal(applied.status, 0, `apply.sh failed: ${applied.stderr}\n${applied.stdout}`);
    for (const name of fs.readdirSync(DEPS)) {
        if (!name.startsWith('.') && name !== '@cloudcli-ai') {
            fs.symlinkSync(path.join(DEPS, name), path.join(root, 'node_modules', name));
        }
    }
    process.env.HOME = path.join(root, 'home');
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    process.env.DATABASE_PATH = path.join(root, 'auth.db');
    if (NEGATIVE) {
        for (const rel of [REGISTRY_REL, CHAT_REL]) {
            fs.copyFileSync(path.join(pkg, `${rel}.bak-pre-p14`), path.join(pkg, rel));
            assert.doesNotMatch(fs.readFileSync(path.join(pkg, rel), 'utf8'), /p14[A-Z]|P14/, `${rel} still carries P14`);
        }
    }
}, { timeout: 240_000 });

after(() => {
    if (root) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function fakeWs() {
    return { readyState: 1, sent: [], send(payload) { this.sent.push(JSON.parse(payload)); } };
}

// ------------------------------------------------------------------ apply
test('p14 applies via apply.sh; --check stays green on a fresh copy; re-run is a no-op', () => {
    assert.match(fs.readFileSync(path.join(pkg, REGISTRY_REL), 'utf8'), /p14AttachWatchers/, 'registry carries P14');
    assert.match(fs.readFileSync(path.join(pkg, CHAT_REL), 'utf8'), /registerWatcher\(sessionId, ws\)/, 'chat socket carries P14');
    const copyRoot = fs.mkdtempSync(path.join(root, 'idem-'));
    fs.cpSync(path.join(root, 'node_modules'), path.join(copyRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const check = run('bash', [P14, '--check', copyRoot]);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    const again = run('bash', [P14, copyRoot]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /P14 patched/, 'second apply changes nothing');
    const whole = run('bash', [APPLY, '--check', copyRoot]);
    assert.equal(whole.status, 0, `apply.sh --check after p14: ${whole.stdout}\n${whole.stderr}`);
});

// ------------------------------------------- M-123: the idle second tab
test('M-123: a socket that subscribed while idle receives the next run from its first event', async () => {
    if (NEGATIVE) {
        const reg = await import(pathToFileURL(path.join(pkg, REGISTRY_REL)).href);
        assert.equal(typeof reg.chatRunRegistry.registerWatcher, 'function', 'registerWatcher must exist');
    }
    const reg = await import(pathToFileURL(path.join(pkg, REGISTRY_REL)).href);
    const registry = reg.chatRunRegistry;
    const sid = `p14-m123-${process.pid}`;
    const tabA = fakeWs();
    const tabB = fakeWs();
    const tabC = fakeWs();
    registry.registerWatcher(sid, tabB);
    const run = registry.startRun({ appSessionId: sid, provider: 'claude', providerSessionId: null, connection: tabA, userId: 'u1' });
    assert.ok(run, 'run started');
    run.writer.send({ kind: 'stream_delta', content: 'hello' });
    run.writer.send({ kind: 'stream_end' });
    assert.equal(tabA.sent.length, 2, 'initiator streams');
    assert.equal(tabB.sent.length, 2, `pre-subscribed second tab streams (M-123 freeze): got ${JSON.stringify(tabB.sent)}`);
    assert.equal(tabB.sent[0].content, 'hello');
    assert.equal(tabB.sent[0].seq, 1);
    assert.equal(tabC.sent.length, 0, 'an unrelated socket gets nothing');
    registry.completeRun(sid, { exitCode: 0 });
    assert.equal(tabB.sent[tabB.sent.length - 1].kind, 'complete');
});

// --------------------------------- subscribe handler (extracted, stubbed)
function loadSubscribe(builder) {
    const src = fs.readFileSync(path.join(pkg, CHAT_REL), 'utf8');
    const helperAt = src.indexOf('async function p13RefreshAfterResubscribe(');
    const start = helperAt >= 0 ? helperAt : src.indexOf('function handleChatSubscribe(');
    const fnAt = src.indexOf('function handleChatSubscribe(');
    const end = src.indexOf('\n}\n', fnAt) + 3;
    assert.ok(start >= 0 && fnAt >= start && end > fnAt, 'handleChatSubscribe not found');
    const body = src.slice(start, end).replace("await import('./session-upsert-broadcast.service.js')", '({ buildSessionUpsertedEvent: __builder })');
    return (registry, sent) => new Function('chatRunRegistry', 'sendJson', 'WS_OPEN_STATE', '__builder', `${body}\nreturn handleChatSubscribe;`)(
        registry, (_ws, payload) => sent.push(payload), 1, builder);
}

async function subscribe({ processing = false, run, lastSeq }) {
    const sent = [];
    const watchers = [];
    const events = run?.events ?? [];
    const handler = loadSubscribe(async (sid) => ({ kind: 'session_upserted', sessionId: sid, session: { id: sid } }))({
        getRun: () => run,
        isProcessing: () => processing,
        attachConnection: () => {},
        replayEvents: (_id, after) => events.filter((event) => typeof event.seq === 'number' && event.seq > after),
        registerWatcher: (sessionId, ws) => watchers.push([sessionId, ws]),
    }, sent);
    const ws = { readyState: 1 };
    handler(ws, { sessions: [{ sessionId: 'sess-1', lastSeq }] }, { runtime: { getPendingApprovalsForSession: () => [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { kinds: sent.map((frame) => frame.kind), sent, watchers };
}

test('M-111: reconnect mid-stream with a covered gap -> replay bridges it, no refresh', async () => {
    const result = await subscribe({
        processing: true,
        lastSeq: 7,
        run: { lastSeq: 9, events: [{ kind: 'stream_delta', seq: 8, content: 'a' }, { kind: 'stream_delta', seq: 9, content: 'b' }] },
    });
    assert.deepEqual(result.kinds, ['chat_subscribed', 'stream_delta', 'stream_delta'], 'missed events are replayed after the ack');
    assert.equal(result.watchers.length, 0, 'a processing session attaches, not watches');
});

test('M-111: mid-run re-subscribe past the buffer edge -> refresh frame so the client refetches', async () => {
    const truncated = await subscribe({
        processing: true,
        lastSeq: 10,
        run: { lastSeq: 5000, events: [{ kind: 'stream_delta', seq: 4001, content: 'x' }, { kind: 'stream_delta', seq: 4002, content: 'y' }] },
    });
    // The refresh is async while the replay loop is synchronous, so the refresh
    // frame lands after the replayed deltas on the wire; only membership counts.
    assert.equal(truncated.kinds[0], 'chat_subscribed');
    assert.ok(truncated.kinds.includes('session_upserted'), `refresh frame missing: ${JSON.stringify(truncated.kinds)}`);
    assert.deepEqual(truncated.kinds.filter((kind) => kind === 'stream_delta').length, 2, 'partial replay still delivered');
    const drained = await subscribe({ processing: true, lastSeq: 5, run: { lastSeq: 50, events: [] } });
    assert.deepEqual(drained.kinds, ['chat_subscribed', 'session_upserted'], 'an empty buffer with a gap is truncated too');
});

test('idle subscribe registers the socket for the next run (M-123 wiring)', async () => {
    const idle = await subscribe({ processing: false, run: undefined, lastSeq: 0 });
    assert.deepEqual(idle.kinds, ['chat_subscribed']);
    assert.equal(idle.watchers.length, 1, 'idle subscriber is remembered');
    assert.deepEqual(idle.watchers[0][0], 'sess-1');
    assert.equal(idle.watchers[0][1].readyState, 1);
});

// ------------------------------------------------- B-F10 close-code log
test('B-F10: the chat close handler logs the close code (and a short reason)', () => {
    const src = fs.readFileSync(path.join(pkg, CHAT_REL), 'utf8');
    assert.match(src, /ws\.on\('close', \(code, reason\) => \{/, 'close handler takes code and reason');
    assert.match(src, /\[INFO\] Chat client disconnected code=/, 'close log carries the code');
});

// ------------------------------------------- gate-wave2 fix pass (2026-10-11)
const CLIENT_BUNDLE_DIR = process.env.CLOUDCLI_CLIENT_ASSETS ?? `${AI_SETUP_ROOT}/cloudcli/node_modules/@cloudcli-ai/cloudcli/dist/assets`;

test('M-111: the stock client appends stream_delta mid-run but ignores session_upserted while processing (contract the fix relies on)', (t) => {
    const bundle = fs.existsSync(CLIENT_BUNDLE_DIR) && fs.readdirSync(CLIENT_BUNDLE_DIR).find((name) => /^index-.*\.js$/.test(name));
    if (!bundle) {
        t.skip(`client bundle not found in ${CLIENT_BUNDLE_DIR}`);
        return;
    }
    const src = fs.readFileSync(path.join(CLIENT_BUNDLE_DIR, bundle), 'utf8');
    assert.match(src, /kind==="stream_delta"\)\{const (\w+)=\w+\.content\|\|"";if\(!\1\)return;\w+\.current\+=\1/, 'stream_delta text is appended to the streaming buffer unconditionally');
    assert.match(src, /oe\.sessionId===ve\.id&&!a\(oe\.sessionId\)\?T\(te=>te\+1\)/, 'session_upserted refetches only when the session is NOT processing');
});

function clientReceives(frames, seen) {
    // Faithful to the client reducer above: every stream_delta's content is appended.
    let text = seen;
    for (const frame of frames) {
        if (frame.kind === 'stream_delta' && frame.content) {
            text += frame.content;
        }
    }
    return text;
}

test('M-111: a processing tab that missed more than the 5000-event buffer gets exactly the missed text on re-subscribe', async () => {
    const reg = await import(pathToFileURL(path.join(pkg, REGISTRY_REL)).href);
    const registry = reg.chatRunRegistry;
    const sid = `p14-m111-${process.pid}`;
    const initiator = fakeWs();
    const live = registry.startRun({ appSessionId: sid, provider: 'claude', providerSessionId: null, connection: initiator, userId: 'u1' });
    const deltas = [];
    for (let i = 0; i < 3000; i += 1) {
        deltas.push(`a${i};`);
        live.writer.send({ kind: 'stream_delta', content: deltas[deltas.length - 1] });
    }
    live.writer.send({ kind: 'stream_end' });
    const second = [];
    for (let i = 0; i < 3500; i += 1) {
        second.push(`b${i};`);
        live.writer.send({ kind: 'stream_delta', content: second[second.length - 1] });
    }
    const state = registry.getRun(sid);
    assert.ok(state.lastSeq > 6000, 'more events than the 5000 buffer');
    assert.ok(state.events.length <= 5000, 'buffer stays bounded');
    // The tab saw the first 10 deltas, then went to background.
    const seen = deltas.slice(0, 10).join('');
    const sent = [];
    const handler = loadSubscribe(async (id) => ({ kind: 'session_upserted', sessionId: id, session: { id } }))(registry, sent);
    const ws = { readyState: 1, send() {} };
    handler(ws, { sessions: [{ sessionId: sid, lastSeq: 10 }] }, { runtime: { getPendingApprovalsForSession: () => [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kinds = sent.map((frame) => frame.kind);
    assert.equal(kinds[0], 'chat_subscribed');
    assert.ok(!kinds.includes('session_upserted'), `the merged buffer bridges the gap, no refresh needed: ${kinds.slice(0, 6)}`);
    assert.ok(sent.every((frame) => !('p14Segments' in frame)), 'internal merge bookkeeping never reaches the client');
    const replayed = sent.slice(1);
    const endAt = replayed.findIndex((frame) => frame.kind === 'stream_end');
    assert.ok(endAt > 0, 'the first message still ends with its stream_end');
    assert.equal(clientReceives(replayed.slice(0, endAt), seen), deltas.join(''), 'first message complete, no gap, no duplicate');
    assert.equal(clientReceives(replayed.slice(endAt + 1), ''), second.join(''), 'second message complete; no merge across stream_end');
    assert.deepEqual(registry.replayEvents(sid, state.lastSeq), [], 'nothing to replay for an up-to-date client');
    registry.completeRun(sid, { exitCode: 0 });
});

test('M-111: the truncation check counts a merged event from its FIRST seq', async () => {
    const merged = { kind: 'stream_delta', seq: 4, content: 'cd', p14Segments: [[3, 0], [4, 1]] };
    const bridged = await subscribe({ processing: true, lastSeq: 2, run: { lastSeq: 4, events: [merged] } });
    assert.ok(!bridged.kinds.includes('session_upserted'), `seq 3..4 covers lastSeq 2: ${bridged.kinds}`);
    const gap = await subscribe({ processing: true, lastSeq: 1, run: { lastSeq: 4, events: [merged] } });
    assert.ok(gap.kinds.includes('session_upserted'), `seq 2 is missing -> refresh: ${gap.kinds}`);
});

test('M-123 watchers: closed sockets are pruned before the cap; a socket is forgotten on close', async () => {
    const reg = await import(pathToFileURL(path.join(pkg, REGISTRY_REL)).href);
    const registry = reg.chatRunRegistry;
    const sid = `p14-prune-${process.pid}`;
    const stale = [];
    for (let i = 0; i < 256; i += 1) {
        const ws = fakeWs();
        registry.registerWatcher(sid, ws);
        stale.push(ws);
    }
    for (const ws of stale) {
        ws.readyState = 3;
    }
    const fresh = fakeWs();
    registry.registerWatcher(sid, fresh);
    const closing = { ...fakeWs(), sent: [], handlers: {}, once(event, fn) { this.handlers[event] = fn; } };
    registry.registerWatcher(sid, closing);
    assert.equal(typeof closing.handlers.close, 'function', 'a close hook is registered');
    closing.handlers.close();
    const live = registry.startRun({ appSessionId: sid, provider: 'claude', providerSessionId: null, connection: fakeWs(), userId: 'u1' });
    live.writer.send({ kind: 'stream_delta', content: 'x' });
    assert.equal(fresh.sent.length, 1, 'an open socket is admitted once the 256 closed ones are pruned');
    assert.equal(closing.sent.length, 0, 'a closed socket is no longer a watcher');
    assert.ok(stale.every((ws) => ws.sent.length === 0));
    registry.completeRun(sid, { exitCode: 0 });
});

test('B-F10: the logged close reason is cut to 120 chars with control characters removed', () => {
    const src = fs.readFileSync(path.join(pkg, CHAT_REL), 'utf8');
    const head = "ws.on('close', ";
    const at = src.indexOf(`${head}(code, reason) => {`);
    assert.ok(at >= 0, 'close handler with code and reason');
    const end = src.indexOf('\n    });', at);
    const handlerSrc = src.slice(at + head.length, end + '\n    }'.length);
    const lines = [];
    const clients = new Set(['w']);
    const handler = new Function('connectedClients', 'ws', 'console', `return ${handlerSrc};`)(clients, 'w', { log: (line) => lines.push(line) });
    handler(1006, Buffer.from(`bye\r\n[ERROR] forged line\u0000\u2028${'y'.repeat(300)}`));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /code=1006 reason=bye /);
    assert.doesNotMatch(lines[0], /[\x00-\x1f\x7f\u2028\u2029]/, 'no CR/LF or other control characters');
    assert.ok(lines[0].length <= '[INFO] Chat client disconnected code=1006 reason='.length + 120, 'reason is truncated');
    assert.equal(clients.size, 0, 'the socket is still removed');
});

function preP14Copy(name) {
    const copyRoot = fs.mkdtempSync(path.join(root, name));
    fs.cpSync(path.join(root, 'node_modules'), path.join(copyRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const copyPkg = path.join(copyRoot, 'node_modules', '@cloudcli-ai', 'cloudcli');
    for (const rel of [REGISTRY_REL, CHAT_REL]) {
        fs.copyFileSync(path.join(copyPkg, `${rel}.bak-pre-p14`), path.join(copyPkg, rel));
        fs.rmSync(path.join(copyPkg, `${rel}.bak-pre-p14`));
    }
    const read = () => [REGISTRY_REL, CHAT_REL].map((rel) => fs.readFileSync(path.join(copyPkg, rel), 'utf8'));
    const leftovers = () => [REGISTRY_REL, CHAT_REL].flatMap((rel) => ['.bak-pre-p14', '.p14-tmp'].filter((ext) => fs.existsSync(path.join(copyPkg, rel + ext))));
    return { copyRoot, copyPkg, read, leftovers };
}

test('p14 apply: an anchor that matches more than its expected count writes nothing and takes no backup', () => {
    const { copyRoot, copyPkg, read, leftovers } = preP14Copy('dup-');
    const reg = path.join(copyPkg, REGISTRY_REL);
    fs.writeFileSync(reg, `${fs.readFileSync(reg, 'utf8')}\n// const runs = new Map();\n`);
    const before0 = read();
    const r = run('bash', [P14, copyRoot]);
    assert.notEqual(r.status, 0, 'apply refuses');
    assert.match(r.stderr, /matched 2x \(want 1\)/);
    assert.deepEqual(read(), before0, 'neither file changed');
    assert.deepEqual(leftovers(), [], 'no backup or temp file');
});

test('p14 apply: a write failure on the second file restores the first (all-or-nothing)', () => {
    const { copyRoot, read, leftovers } = preP14Copy('fault-');
    const before0 = read();
    const r = spawnSync('bash', [P14, copyRoot], { encoding: 'utf8', env: { ...process.env, P14_TEST_FAIL_BEFORE: 'chat-websocket.service.js' } });
    assert.notEqual(r.status, 0, 'apply fails at the second file');
    assert.match(r.stderr, /restor/i);
    assert.deepEqual(read(), before0, 'both files byte-identical to pre-P14');
    assert.ok(!leftovers().includes('.p14-tmp'), 'no temp file left');
});

test('p14.sh is executable (0755)', () => {
    assert.equal(fs.statSync(P14).mode & 0o777, 0o755);
});
