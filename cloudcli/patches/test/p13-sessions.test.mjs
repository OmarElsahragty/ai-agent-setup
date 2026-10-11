// P13 (WO-13): origin labels + auto-archive (GAP-4), fork links (GAP-9),
// re-subscribe refresh (B-F10), terminal runs in the activity bar (M-122).
// A fresh tree is built from the stock fixture: apply.sh (P0-P9r), then
// apply.d/p10.sh, p11.sh, p12.sh and p13.sh in that order. p11/p12/p13 must
// apply; a p10 failure is tolerated and printed (WO-1 still in progress, its
// files are disjoint from p13's) unless P13_REQUIRE_ALL_PREREQS=1.
// Negative control: P13_NEGATIVE_CONTROL=1 restores every .bak-pre-p13 file and
// removes the p13 modules; the behavioural cases must fail.
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
const PREREQS = ['p10', 'p11', 'p12'];
const P13 = path.join(PATCHES, 'apply.d', 'p13.sh');
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const DEPS = process.env.CLOUDCLI_DEPS_DIR ?? `${AI_SETUP_ROOT}/cloudcli/node_modules`;
const MISSING_DEPS = fs.existsSync(DEPS) ? false : `CloudCLI dependency dir missing: ${DEPS} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT or CLOUDCLI_DEPS_DIR to a full install)`;
const test = (name, fn) => nodeTest(name, { skip: MISSING_DEPS }, fn);
const NEGATIVE = process.env.P13_NEGATIVE_CONTROL === '1';
const REQUIRE_ALL = process.env.P13_REQUIRE_ALL_PREREQS === '1';
const DS = 'dist-server/server';
const SYNC_REL = `${DS}/modules/providers/list/claude/claude-session-synchronizer.provider.js`;
const FETCH_REL = `${DS}/modules/projects/services/projects-with-sessions-fetch.service.js`;
const UPSERT_REL = `${DS}/modules/websocket/services/session-upsert-broadcast.service.js`;
const CHAT_REL = `${DS}/modules/websocket/services/chat-websocket.service.js`;
const INDEX_REL = `${DS}/index.js`;
const ORIGIN_REL = `${DS}/modules/providers/list/claude/p13-session-origin.js`;
const LIVE_REL = `${DS}/modules/bg-tasks/p13-terminal-live.js`;
const DEAD_PID = 2147483646;
let root;
let pkg;
let home;
let proj;
const prereqStatus = {};

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

before(() => {
    if (MISSING_DEPS) return;
    root = fs.mkdtempSync('/var/tmp/claude/p13-test-');
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(stockSrc(), pkg, { recursive: true });
    const applied = run('bash', [APPLY, root]);
    assert.equal(applied.status, 0, `apply.sh failed: ${applied.stderr}`);
    for (const name of fs.readdirSync(DEPS)) {
        if (!name.startsWith('.') && name !== '@cloudcli-ai') {
            fs.symlinkSync(path.join(DEPS, name), path.join(root, 'node_modules', name));
        }
    }
    for (const p of PREREQS) {
        const script = path.join(PATCHES, 'apply.d', `${p}.sh`);
        const r = fs.existsSync(script) ? run('bash', [script, root]) : { status: 'absent', stderr: '' };
        prereqStatus[p] = r.status;
        if (r.status !== 0) {
            const why = `${p}.sh -> ${r.status}: ${(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ')}`;
            if (p !== 'p10' || REQUIRE_ALL) {
                assert.fail(`prerequisite failed: ${why}`);
            }
            console.log(`[p13] prerequisite tolerated: ${why}`);
        }
    }
    const patched = run('bash', [P13, root]);
    assert.equal(patched.status, 0, `p13.sh failed: ${patched.stdout}\n${patched.stderr}`);
    if (NEGATIVE) {
        for (const rel of [SYNC_REL, FETCH_REL, UPSERT_REL, CHAT_REL, INDEX_REL]) {
            fs.copyFileSync(path.join(pkg, `${rel}.bak-pre-p13`), path.join(pkg, rel));
            assert.doesNotMatch(fs.readFileSync(path.join(pkg, rel), 'utf8'), /p13[A-Z]|P13/, `${rel} still carries P13`);
        }
        fs.rmSync(path.join(pkg, ORIGIN_REL));
        fs.rmSync(path.join(pkg, LIVE_REL));
    }
    home = path.join(root, 'home');
    proj = path.join(root, 'work', 'proj');
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-work-proj'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    process.env.HOME = home;
    process.env.DATABASE_PATH = path.join(root, 'auth.db');
}, { timeout: 240_000 });

after(() => {
    if (root) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------- fixtures
const ids = {
    A: '0a000000-0000-4000-8000-00000000000a', // owner terminal session (parent)
    B: '0b000000-0000-4000-8000-00000000000b', // Claude Code bg copy of A
    P: '0c000000-0000-4000-8000-00000000000c', // claude -p probe
    D: '0d000000-0000-4000-8000-00000000000d', // daemon bg job, no parent
    C: '0e000000-0000-4000-8000-00000000000e', // unrelated terminal session
    W: '0f000000-0000-4000-8000-00000000000f', // web (app-created) session
    E: '10000000-0000-4000-8000-000000000010', // terminal --fork-session copy of C, no marker
};
const transcriptPath = (sid) => path.join(home, '.claude', 'projects', '-work-proj', `${sid}.jsonl`);
function row(sid, uuid, type, extra = {}) {
    return { type, uuid, parentUuid: null, sessionId: sid, cwd: proj, timestamp: new Date().toISOString(), message: { role: type, content: `${type} ${uuid}` }, ...extra };
}
function writeTranscript(sid, uuids, extra = {}, tail = []) {
    const rows = [{ type: 'mode', sessionId: sid }, ...uuids.map((u, i) => row(sid, u, i % 2 === 0 ? 'user' : 'assistant', extra)), ...tail];
    fs.writeFileSync(transcriptPath(sid), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return transcriptPath(sid);
}
const shared = ['s1', 's2', 's3', 's4', 's5'];

let mods = null;
async function load() {
    if (!mods) {
        const db = await import(pathToFileURL(path.join(pkg, `${DS}/modules/database/index.js`)).href);
        db.closeConnection();
        await db.initializeDatabase();
        const sync = await import(pathToFileURL(path.join(pkg, SYNC_REL)).href);
        mods = { db, synchronizer: new sync.ClaudeSessionSynchronizer() };
    }
    return mods;
}
after(() => mods?.db.closeConnection());
const archived = (sessionsDb, sid) => Number(sessionsDb.getSessionById(sid)?.isArchived);

async function originModule() {
    return import(pathToFileURL(path.join(pkg, ORIGIN_REL)).href);
}
async function dto(sessionsDb, sid) {
    // mapSessionRowToSummary evaluated from the patched dist file with its real p13 import.
    const src = fs.readFileSync(path.join(pkg, FETCH_REL), 'utf8');
    const start = src.indexOf('function mapSessionRowToSummary(row) {');
    const end = src.indexOf('function readProjectSessionsIncludingArchived(');
    assert.ok(start >= 0 && end > start, 'mapSessionRowToSummary not found');
    let p13SummaryFields = () => ({});
    if (fs.existsSync(path.join(pkg, ORIGIN_REL))) {
        ({ p13SummaryFields } = await originModule());
    }
    const map = new Function('sessionsDb', 'p13SummaryFields', `${src.slice(start, end)}\nreturn mapSessionRowToSummary;`)(sessionsDb, p13SummaryFields);
    return map(sessionsDb.getSessionById(sid));
}

// ------------------------------------------------------------------ apply
test('p13 applies after p0-p9r + p11 + p12 (+ p10 when it applies); idempotent; every --check stays green', () => {
    console.log(`[p13] prerequisite exit codes: ${JSON.stringify(prereqStatus)}`);
    const copyRoot = fs.mkdtempSync(path.join(root, 'idem-'));
    fs.cpSync(path.join(root, 'node_modules'), path.join(copyRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const check = run('bash', [P13, '--check', copyRoot]);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    const again = run('bash', [P13, copyRoot]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /P13 patched|module copied/);
    for (const [label, args] of [['apply.sh', [APPLY, '--check', copyRoot]], ['p11', [path.join(PATCHES, 'apply.d', 'p11.sh'), '--check', copyRoot]], ['p12', [path.join(PATCHES, 'apply.d', 'p12.sh'), '--check', copyRoot]]]) {
        const r = run('bash', args);
        assert.equal(r.status, 0, `${label} --check after p13: ${r.stdout}\n${r.stderr}`);
    }
    const index = fs.readFileSync(path.join(pkg, INDEX_REL), 'utf8');
    const p13Mount = index.indexOf("app.use('/api/bg-tasks', authenticateToken, p13TerminalActiveRoutes);");
    assert.ok(p13Mount >= 0 && p13Mount < index.indexOf("app.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);"), 'p13 /active router is mounted before the stock bg-tasks router');
});

// ------------------------------------------------- GAP-4 / GAP-9 indexing
test('indexing: probe, background and fork rows are archived; terminal rows stay visible; the fork links to its parent', async () => {
    const { db, synchronizer } = await load();
    const { sessionsDb } = db;
    writeTranscript(ids.A, shared, { entrypoint: 'cli' }, [{ type: 'continued-in', continuedInSessionId: ids.B, sessionId: ids.A }]);
    writeTranscript(ids.C, ['c1', 'c2', 'c3', 'c4', 'c5'], { entrypoint: 'cli' });
    await synchronizer.synchronizeFile(transcriptPath(ids.A));
    await synchronizer.synchronizeFile(transcriptPath(ids.C));
    writeTranscript(ids.B, [...shared, 'b6'], { entrypoint: 'cli', sessionKind: 'bg' });
    writeTranscript(ids.P, ['p1', 'p2'], { entrypoint: 'sdk-cli' });
    writeTranscript(ids.D, ['d1', 'd2', 'd3', 'd4', 'd5'], { entrypoint: 'cli', sessionKind: 'bg' });
    for (const sid of [ids.B, ids.P, ids.D]) {
        await synchronizer.synchronizeFile(transcriptPath(sid));
    }
    assert.equal(archived(sessionsDb, ids.A), 0, 'owner terminal session stays visible');
    assert.equal(archived(sessionsDb, ids.C), 0, 'unrelated terminal session stays visible');
    assert.equal(archived(sessionsDb, ids.P), 1, 'claude -p probe is archived');
    assert.equal(archived(sessionsDb, ids.D), 1, 'daemon background job is archived');
    assert.equal(archived(sessionsDb, ids.B), 1, 'background/fork copy is archived');
    for (const sid of Object.values(ids).slice(0, 5)) {
        assert.ok(sessionsDb.getSessionById(sid), `row ${sid} still exists (archive only, never deleted)`);
    }
    const b = await dto(sessionsDb, ids.B);
    assert.equal(b.originLabel, 'fork');
    assert.equal(b.forkedFromSessionId, ids.A, 'the copy shows as a child of its parent');
    const a = await dto(sessionsDb, ids.A);
    assert.equal(a.originLabel, 'terminal', 'the parent is never labelled a fork of its own copy');
    assert.equal(a.forkedFromSessionId, null);
    assert.equal((await dto(sessionsDb, ids.D)).forkedFromSessionId, null, 'a bg job without shared history has no parent');
});

test('a terminal fork without a continued-in marker links to the older transcript only (direction by file birth time)', async () => {
    const { db, synchronizer } = await load();
    const { sessionsDb } = db;
    await new Promise((resolve) => setTimeout(resolve, 25));
    writeTranscript(ids.E, ['c1', 'c2', 'c3', 'c4', 'c5', 'e6'], { entrypoint: 'cli' });
    await synchronizer.synchronizeFile(transcriptPath(ids.E));
    assert.equal(archived(sessionsDb, ids.E), 1, 'a terminal --fork-session copy is archived as a fork');
    const e = await dto(sessionsDb, ids.E);
    assert.equal(e.originLabel, 'fork');
    assert.equal(e.forkedFromSessionId, ids.C);
    const c = await dto(sessionsDb, ids.C);
    assert.equal(c.originLabel, 'terminal', 'the older original stays a terminal session');
    assert.equal(c.forkedFromSessionId, null, 'an original never links to its newer copy');
    assert.equal(archived(sessionsDb, ids.C), 0);
});

test('sidebar DTO: labels reach the summary and the extra fields; app-created rows are unlabelled', async () => {
    const { db, synchronizer } = await load();
    const { sessionsDb } = db;
    const a = await dto(sessionsDb, ids.A);
    assert.equal(a.isExternal, true);
    assert.equal(a.originLabel, 'terminal');
    assert.match(a.summary, /^\[terminal\] /);
    assert.doesNotMatch(a.summary, /^\[terminal\] \[terminal\]/, 'the prefix is never doubled');
    assert.equal(sessionsDb.getSessionById(ids.A).custom_name.startsWith('['), false, 'custom_name is never rewritten');
    const p = await dto(sessionsDb, ids.P);
    assert.equal(p.originLabel, 'probe');
    assert.equal((await dto(sessionsDb, ids.D)).originLabel, 'background');
    sessionsDb.createAppSession('app-w', 'claude', proj, 'From the web');
    sessionsDb.assignProviderSessionId('app-w', ids.W);
    writeTranscript(ids.W, ['w1', 'w2'], { entrypoint: 'sdk-ts' });
    await synchronizer.synchronizeFile(transcriptPath(ids.W));
    assert.equal(archived(sessionsDb, 'app-w'), 0, 'an app-created web session is never archived');
    const w = await dto(sessionsDb, 'app-w');
    assert.equal(w.isExternal, false);
    assert.equal(w.origin, 'app');
    assert.equal(w.summary, 'From the web');
});

test('an owner un-archive sticks: later transcript writes and re-indexing never re-archive', async () => {
    const { db, synchronizer } = await load();
    const { sessionsDb } = db;
    sessionsDb.updateSessionIsArchived(ids.P, false);
    fs.appendFileSync(transcriptPath(ids.P), `${JSON.stringify(row(ids.P, 'p3', 'user', { entrypoint: 'sdk-cli' }))}\n`);
    await synchronizer.synchronizeFile(transcriptPath(ids.P));
    await synchronizer.synchronize(null);
    assert.equal(archived(sessionsDb, ids.P), 0, 'restored probe stays restored');
    assert.equal(archived(sessionsDb, ids.A), 0, 'full re-scan keeps the terminal row visible');
    assert.equal(archived(sessionsDb, ids.B), 1, 'full re-scan is idempotent for archived rows');
});

// ---------------------------------------------------------- M-122 activity
test('activity bar: busy terminal CLIs with a live pid are added once; idle, dead, malformed and archived are not', async () => {
    const { db } = await load();
    const live = await import(pathToFileURL(path.join(pkg, LIVE_REL)).href);
    const dir = fs.mkdtempSync(path.join(root, 'sessions-'));
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
    const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const myStart = selfStat.slice(selfStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    write(`${process.pid}.json`, { pid: process.pid, sessionId: ids.A, kind: 'interactive', entrypoint: 'cli', status: 'busy', statusUpdatedAt: Date.now(), procStart: myStart });
    write('2.json', { pid: DEAD_PID, sessionId: ids.C, status: 'busy' });
    write('3.json', '{not json');
    write('4.json', { pid: process.pid, sessionId: ids.C, status: 'idle' });
    write('5.json', { pid: process.pid, sessionId: ids.D, status: 'busy' });
    write('6.json', { pid: process.pid, sessionId: ids.E, status: 'busy', procStart: '1' });
    const entries = live.p13ReadLiveCliSessions({ dir });
    assert.ok(entries.some((e) => e.providerSessionId === ids.A && e.status === 'busy'), 'a matching procStart stays alive');
    assert.ok(!entries.some((e) => e.pid === DEAD_PID), 'dead pid ignored');
    assert.ok(!entries.some((e) => e.providerSessionId === ids.E), 'a recycled pid (procStart mismatch) is dead');
    const base = { sessions: [{ sessionId: 'already', working: true, lastWriteAt: new Date().toISOString() }] };
    const frozen = JSON.stringify(base);
    const merged = live.p13MergeTerminalLive(base, entries, live.p13VisibleSessionResolver(db.sessionsDb));
    assert.equal(JSON.stringify(base), frozen, 'the cached stock body is not mutated');
    const added = merged.sessions.filter((s) => s.source === 'terminal').map((s) => s.sessionId);
    assert.deepEqual(added, [ids.A], 'only the busy, live, visible terminal session is added');
    const twice = live.p13MergeTerminalLive(merged, entries, live.p13VisibleSessionResolver(db.sessionsDb));
    assert.equal(twice.sessions.filter((s) => s.sessionId === ids.A).length, 1, 'no duplicate entry');
    assert.deepEqual(live.p13ReadLiveCliSessions({ dir: path.join(root, 'missing') }), [], 'missing dir fails open');
});

test('activity bar: a NUMERIC procStart is honoured like a string one (matching -> alive, recycled pid -> dead)', async () => {
    await load();
    const live = await import(pathToFileURL(path.join(pkg, LIVE_REL)).href);
    const dir = fs.mkdtempSync(path.join(root, 'sessions-num-'));
    const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const myStart = Number(selfStat.slice(selfStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
    assert.ok(Number.isSafeInteger(myStart), `own procStart parsed: ${myStart}`);
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sessionId: ids.A, status: 'busy', procStart: myStart }));
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: process.pid, sessionId: ids.E, status: 'busy', procStart: myStart + 1 }));
    const entries = live.p13ReadLiveCliSessions({ dir });
    assert.ok(entries.some((e) => e.providerSessionId === ids.A), 'a matching numeric procStart stays alive');
    assert.ok(!entries.some((e) => e.providerSessionId === ids.E), 'a numeric procStart that differs (recycled pid) is dead');
});

// ------------------------------------------------------- B-F10 refresh
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
    const handler = loadSubscribe(async (sid) => ({ kind: 'session_upserted', sessionId: sid, session: { id: sid } }))({
        getRun: () => run,
        isProcessing: () => processing,
        attachConnection: () => {},
        replayEvents: () => [],
    }, sent);
    handler({ readyState: 1 }, { sessions: [{ sessionId: 'sess-1', lastSeq }] }, { runtime: { getPendingApprovalsForSession: () => [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return sent.map((frame) => frame.kind);
}

test('re-subscribe after a detached turn completed -> chat_subscribed then one session_upserted (history refetch)', async () => {
    assert.deepEqual(await subscribe({ lastSeq: 7, run: undefined }), ['chat_subscribed', 'session_upserted']);
    assert.deepEqual(await subscribe({ lastSeq: 7, run: { lastSeq: 9 } }), ['chat_subscribed', 'session_upserted']);
});

test('no refresh on a first subscribe, while processing, or when the client already saw the last event', async () => {
    assert.deepEqual(await subscribe({ lastSeq: 0, run: undefined }), ['chat_subscribed']);
    assert.deepEqual(await subscribe({ processing: true, lastSeq: 7, run: { lastSeq: 9 } }), ['chat_subscribed']);
    assert.deepEqual(await subscribe({ lastSeq: 9, run: { lastSeq: 9 } }), ['chat_subscribed']);
});

// ------------------------------------------------------------- module unit
test('origin classifier: entrypoint/sessionKind mapping and fail-open on unreadable files', async () => {
    const m = await originModule();
    assert.equal(m.p13OriginOf({ entrypoint: 'cli', sessionKind: null }), 'cli');
    assert.equal(m.p13OriginOf({ entrypoint: 'cli', sessionKind: 'bg' }), 'bg');
    assert.equal(m.p13OriginOf({ entrypoint: 'sdk-cli', sessionKind: null }), 'sdk-cli');
    assert.equal(m.p13OriginOf({ entrypoint: 'sdk-py', sessionKind: null }), 'sdk');
    assert.equal(m.p13OriginOf(null), 'unknown');
    assert.equal(m.p13ReadTranscriptHead(path.join(root, 'nope.jsonl')), null);
    assert.equal(m.p13LabelSummary('[probe] [probe] x', { originLabel: 'probe' }), '[probe] x');
    assert.equal(m.p13OnIndexed({ sessionsDb: null, providerSessionId: 'x', filePath: 'y', existed: false }), null, 'errors fail open');
});
