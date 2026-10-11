// P11 (WO-2): history reader de-duplication, archive-preserving indexer,
// queued-draft dispatcher guards, Shell-tab resume guard.
// A fresh tree is built from the stock fixture: apply.sh (P0-P9r), then
// apply.d/p11.sh. The patched dist files are exercised for real:
//   - reader: readTranscriptRows/dropSupersededPromptBranches evaluated from the
//     patched provider source;
//   - sessions.db: the real database module on a temp DATABASE_PATH;
//   - dispatcher and Shell: the patched files run against stub modules laid out
//     at their relative import paths (no app database, websocket stack or PTY).
// Negative control: P11_NEGATIVE_CONTROL=1 restores every .bak-pre-p11 file
// (the tree as it was before P11) and the behavioural cases must fail.
// Offline replay: P11_REPLAY_JSONL=<COPY of a transcript> asserts 0 hidden rows
// and prints the pre-P11 reader's figure for the same copy.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stockSrc } from './stock-src.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.resolve(HERE, '..');
const APPLY = path.join(PATCHES, 'apply.sh');
const P11 = path.join(PATCHES, 'apply.d', 'p11.sh');
const DEPS = process.env.CLOUDCLI_DEPS_DIR ?? path.resolve(PATCHES, '..', 'node_modules');
const MISSING_DEPS = fs.existsSync(DEPS) ? false : `CloudCLI dependency dir missing: ${DEPS} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT or CLOUDCLI_DEPS_DIR to a full install)`;
const test = (name, options, fn) =>
    typeof options === 'function'
        ? nodeTest(name, { skip: MISSING_DEPS }, options)
        : nodeTest(name, { ...options, skip: MISSING_DEPS || options.skip }, fn);
const NEGATIVE = process.env.P11_NEGATIVE_CONTROL === '1';
const REPLAY = process.env.P11_REPLAY_JSONL ?? '';
const READER_REL = 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js';
const DB_INDEX_REL = 'dist-server/server/modules/database/index.js';
const DISPATCHER_REL = 'dist-server/server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
const SHELL_REL = 'dist-server/server/modules/websocket/services/shell-websocket.service.js';
const DEAD_PID = 2147483646; // above any pid_max, so /proc/<pid> never exists
let root;
let pkg;

function run(cmd, args) {
    return spawnSync(cmd, args, { encoding: 'utf8' });
}

before(() => {
    if (MISSING_DEPS) return;
    root = fs.mkdtempSync('/var/tmp/claude/p11-test-');
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(stockSrc(), pkg, { recursive: true });
    const applied = run('bash', [APPLY, root]);
    assert.equal(applied.status, 0, `apply.sh failed: ${applied.stderr}`);
    // Real dependencies (better-sqlite3, typescript, ...) resolve through
    // symlinks; created after apply.sh, and P11 writes only inside the package.
    for (const name of fs.readdirSync(DEPS)) {
        if (name.startsWith('.') || name === '@cloudcli-ai') {
            continue;
        }
        fs.symlinkSync(path.join(DEPS, name), path.join(root, 'node_modules', name));
    }
    const patched = run('bash', [P11, root]);
    assert.equal(patched.status, 0, `p11.sh failed: ${patched.stdout}\n${patched.stderr}`);
    if (NEGATIVE) {
        for (const rel of [READER_REL, DISPATCHER_REL, SHELL_REL, 'dist-server/server/modules/database/repositories/sessions.db.js']) {
            fs.copyFileSync(path.join(pkg, `${rel}.bak-pre-p11`), path.join(pkg, rel));
            // The control is only meaningful if P11 is really gone from the file under test.
            assert.doesNotMatch(fs.readFileSync(path.join(pkg, rel), 'utf8'), /p11[A-Z]|P11:/, `${rel} still carries P11 after restore`);
        }
    }
}, { timeout: 180_000 });

after(() => {
    if (root) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------- apply
test('p11.sh is idempotent, --check passes, apply.sh still sees P0-P9r', () => {
    // Runs on a COPY so a re-apply can never repair the tree the other cases test.
    const copyRoot = fs.mkdtempSync(path.join(root, 'idem-'));
    fs.cpSync(pkg, path.join(copyRoot, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
    const check = run('bash', [P11, '--check', copyRoot]);
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    const again = run('bash', [P11, copyRoot]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already applied/);
    assert.doesNotMatch(again.stdout, /P11 patched/);
    const applyCheck = run('bash', [APPLY, '--check', copyRoot]);
    assert.equal(applyCheck.status, 0, applyCheck.stderr);
    for (const rel of [READER_REL, DISPATCHER_REL, SHELL_REL]) {
        assert.ok(fs.existsSync(path.join(pkg, `${rel}.bak-pre-p11`)), `${rel}.bak-pre-p11 missing`);
    }
});

// ------------------------------------------------------------------ reader
const SID = 'p11-reader-session';
const owner = (uuid, parentUuid, text, extra = {}) => ({
    type: 'user', uuid, parentUuid, sessionId: SID, promptSource: 'sdk',
    message: { role: 'user', content: text }, ...extra,
});
const reply = (uuid, parentUuid, text) => ({
    type: 'assistant', uuid, parentUuid, sessionId: SID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const notification = (uuid, parentUuid, taskId) => ({
    type: 'user', uuid, parentUuid, sessionId: SID, promptSource: 'system',
    origin: { kind: 'task-notification' }, queueSkipAttachments: true,
    message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` },
});

function loadReader(providerFile) {
    const src = fs.readFileSync(providerFile, 'utf8');
    const start = src.indexOf('async function readTranscriptRows(');
    const end = src.indexOf('async function getSessionMessages(');
    assert.ok(start >= 0 && end > start, 'reader anchors not found');
    return new Function('fs', 'readline', `${src.slice(start, end)}\nreturn { readTranscriptRows, dropSupersededPromptBranches };`)(fs, readline);
}

async function visibleRows(rows, name) {
    const file = path.join(root, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const { readTranscriptRows, dropSupersededPromptBranches } = loadReader(path.join(pkg, READER_REL));
    return dropSupersededPromptBranches(await readTranscriptRows(file, SID));
}

test('a duplicated prompt (same uuid written twice) keeps its whole subtree', async () => {
    const u2 = owner('u2', 'a1', 'second prompt', { slug: 'first-writer' });
    const a2 = reply('a2', 'u2', 'second answer');
    const rows = [
        owner('u1', null, 'first prompt'), reply('a1', 'u1', 'first answer'), u2, a2,
        // A second CLI writer re-appends the same rows (same uuids).
        { ...u2, slug: 'second-writer' }, { ...a2 },
        owner('u3', 'a2', 'third prompt'), reply('a3', 'u3', 'third answer'),
    ];
    const visible = await visibleRows(rows, 'dup-prompt');
    assert.deepEqual(visible.map((row) => row.uuid), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    assert.equal(visible.find((row) => row.uuid === 'u2').slug, 'first-writer', 'the first copy keeps its place');
});

test('two task-notification siblings are both kept', async () => {
    const rows = [
        owner('u1', null, 'start two background jobs'), reply('a1', 'u1', 'started'),
        notification('t1', 'a1', 'job-1'), reply('a2', 't1', 'job 1 done'),
        notification('t2', 'a1', 'job-2'), reply('a3', 't2', 'job 2 done'),
    ];
    const visible = await visibleRows(rows, 'two-notifications');
    assert.deepEqual(visible.map((row) => row.uuid), ['u1', 'a1', 't1', 'a2', 't2', 'a3']);
});

test('a task notification never supersedes an owner prompt that shares its parent', async () => {
    const rows = [
        owner('u1', null, 'first'), reply('a1', 'u1', 'answer'),
        owner('u2', 'a1', 'owner follow-up'), reply('a2', 'u2', 'follow-up answer'),
        notification('t1', 'a1', 'job-1'), reply('a3', 't1', 'job done'),
    ];
    const visible = await visibleRows(rows, 'owner-vs-notification');
    assert.deepEqual(visible.map((row) => row.uuid), ['u1', 'a1', 'u2', 'a2', 't1', 'a3']);
});

test('a real owner edit-send still replaces the prompt it superseded (regression guard)', async () => {
    const rows = [
        owner('u1', null, 'first'), reply('a1', 'u1', 'answer'),
        owner('u2', 'a1', 'original'), reply('a2', 'u2', 'to be replaced'),
        owner('u2b', 'a1', 'edited'), reply('a2b', 'u2b', 'answer to the edit'),
    ];
    const visible = await visibleRows(rows, 'real-edit');
    assert.deepEqual(visible.map((row) => row.uuid), ['u1', 'a1', 'u2b', 'a2b']);
});

test('offline replay of a transcript COPY hides 0 rows', { skip: REPLAY ? false : 'set P11_REPLAY_JSONL=<copy of a transcript>' }, async () => {
    const raw = fs.readFileSync(REPLAY, 'utf8').split('\n').filter((line) => line.trim()).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
    const sid = raw.find((row) => typeof row.sessionId === 'string')?.sessionId;
    const mine = raw.filter((row) => row.sessionId === sid);
    const hasUuid = (row) => typeof row.uuid === 'string' && row.uuid !== '';
    const measure = async (providerFile) => {
        const { readTranscriptRows, dropSupersededPromptBranches } = loadReader(providerFile);
        const out = dropSupersededPromptBranches(await readTranscriptRows(REPLAY, sid));
        const outUuids = new Set(out.filter(hasUuid).map((row) => row.uuid));
        // Hidden = rows of the file whose uuid never reaches the reader output
        // (uuid-less rows are compared by count; the reader never drops them).
        const hidden = mine.filter((row) => hasUuid(row) && !outUuids.has(row.uuid)).length
            + (mine.filter((row) => !hasUuid(row)).length - out.filter((row) => !hasUuid(row)).length);
        return { rowsIn: mine.length, rowsOut: out.length, hidden };
    };
    const current = await measure(path.join(pkg, READER_REL));
    const bak = path.join(pkg, `${READER_REL}.bak-pre-p11`);
    const preP11 = fs.existsSync(bak) ? await measure(bak) : null;
    console.log(`[p11 replay] ${JSON.stringify({ file: path.basename(REPLAY), sessionRows: mine.length, current, preP11 })}`);
    assert.equal(current.hidden, 0);
});

// -------------------------------------------------------------- sessions.db
let db = null;
async function database() {
    if (!db) {
        db = await import(pathToFileURL(path.join(pkg, DB_INDEX_REL)).href);
        db.closeConnection();
        process.env.DATABASE_PATH = path.join(root, 'auth.db');
        await db.initializeDatabase();
    }
    return db;
}
const T0 = '2026-10-09T10:00:00.000Z';
const T1 = '2026-10-09T11:00:00.000Z';
// Later than a row stamped CURRENT_TIMESTAMP at creation, so the pre-P11 upsert
// ("newer write => isArchived = 0") would really un-archive it.
const later = () => new Date(Date.now() + 60_000).toISOString();
after(() => db?.closeConnection());

test('an archived external row stays archived after a transcript write', async () => {
    const { sessionsDb } = await database();
    const proj = fs.mkdtempSync(path.join(root, 'proj-ext-'));
    const jsonl = path.join(proj, 'ext-1.jsonl');
    sessionsDb.createSession('ext-1', 'claude', proj, 'External', T0, T0, jsonl);
    assert.equal(Number(sessionsDb.getSessionById('ext-1').isArchived), 0, 'a new indexed row starts unarchived');
    sessionsDb.updateSessionIsArchived('ext-1', true);
    sessionsDb.createSession('ext-1', 'claude', proj, 'External', T0, T1, jsonl);
    const row = sessionsDb.getSessionById('ext-1');
    assert.equal(Number(row.isArchived), 1);
    assert.equal(row.updated_at, T1, 'the write still advances updated_at');
});

test('an archived app-created row stays archived after its transcript is written', async () => {
    const { sessionsDb } = await database();
    const proj = fs.mkdtempSync(path.join(root, 'proj-app-'));
    sessionsDb.createAppSession('app-1', 'claude', proj, 'App');
    sessionsDb.assignProviderSessionId('app-1', 'prov-app-1');
    sessionsDb.updateSessionIsArchived('app-1', true);
    sessionsDb.createSession('prov-app-1', 'claude', proj, 'App', T0, later(), path.join(proj, 'prov-app-1.jsonl'));
    assert.equal(Number(sessionsDb.getSessionById('app-1').isArchived), 1);
});

test('the legacy ON CONFLICT path keeps an archived row archived', async () => {
    const { sessionsDb } = await database();
    const proj = fs.mkdtempSync(path.join(root, 'proj-legacy-'));
    sessionsDb.createAppSession('legacy-1', 'claude', proj, 'Legacy');
    sessionsDb.updateSessionIsArchived('legacy-1', true);
    sessionsDb.createSession('legacy-1', 'claude', proj, 'Legacy', T0, later(), path.join(proj, 'legacy-1.jsonl'));
    const row = sessionsDb.getSessionById('legacy-1');
    assert.equal(Number(row.isArchived), 1);
    assert.equal(row.jsonl_path, path.join(proj, 'legacy-1.jsonl'), 'the upsert itself still lands');
});

test('a session with no app-created row is flagged external non-destructively', async () => {
    const { sessionsDb } = await database();
    const proj = fs.mkdtempSync(path.join(root, 'proj-flag-'));
    // Disk-discovered (terminal/external) session: the synchronizer keys both
    // id columns with the provider-native id.
    sessionsDb.createSession('flag-ext', 'claude', proj, 'From terminal', T0, T0, path.join(proj, 'flag-ext.jsonl'));
    // App-created session: app-allocated id, provider id mapped separately.
    sessionsDb.createAppSession('flag-app', 'claude', proj, 'From app');
    sessionsDb.assignProviderSessionId('flag-app', 'flag-app-provider');
    const ext = sessionsDb.getSessionById('flag-ext');
    assert.equal(ext.isExternal, true, 'a disk-discovered row is flagged external');
    assert.equal(sessionsDb.getSessionById('flag-app').isExternal, false, 'an app-created row is not external');
    assert.equal(sessionsDb.getSessionByProviderSessionId('flag-app-provider').isExternal, false, 'the mapped app row is not external either');
    // Non-destructive: the flag is derived on read, nothing renamed or re-keyed.
    assert.equal(ext.custom_name, 'From terminal');
    assert.equal(ext.session_id, 'flag-ext');
    assert.equal(ext.provider_session_id, 'flag-ext');
    // Re-indexing the same transcript keeps the flag; it is never stored.
    sessionsDb.createSession('flag-ext', 'claude', proj, 'From terminal', T0, T1, path.join(proj, 'flag-ext.jsonl'));
    assert.equal(sessionsDb.getSessionById('flag-ext').isExternal, true);
});

// --------------------------------------------------------------- dispatcher
function sqliteTime(msAgo) {
    return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

function dispatcherSandbox(name, state) {
    const sb = fs.mkdtempSync(path.join(root, `disp-${name}-`));
    for (const dir of ['a/b/c', 'modules/database', 'modules/websocket', 'modules/providers/services']) {
        fs.mkdirSync(path.join(sb, dir), { recursive: true });
    }
    fs.copyFileSync(path.join(pkg, DISPATCHER_REL), path.join(sb, 'a/b/c/dispatcher.mjs'));
    const stateFile = path.join(sb, 'state.json');
    const logFile = path.join(sb, 'log.ndjson');
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const head = `import fs from 'node:fs';
const S = () => JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const rec = (value) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(value) + '\\n');
`;
    fs.writeFileSync(path.join(sb, 'modules/database/index.js'), `${head}
export const sessionDraftsDb = {
    getDrafts: () => [{ scope: 's1', text: '', queuedMessage: {}, updatedAt: S().queuedAt ?? null }],
    listQueuedMessages: () => [{ userId: 1, sessionId: 's1', queuedMessage: S().queued, claimToken: JSON.stringify(S().queued) }],
    claimQueuedMessage: () => { rec({ op: 'claim' }); return true; },
    deleteEmptyDraft: () => rec({ op: 'delete' }),
    restoreQueuedMessage: () => rec({ op: 'restore' }),
};
export const scheduledMessagesDb = {};
`);
    fs.writeFileSync(path.join(sb, 'modules/websocket/index.js'), `${head}
export const chatRunRegistry = { isProcessing: () => false };
export const runDetachedChatTurn = async (payload) => { rec({ op: 'send', content: payload.content }); return { started: true }; };
`);
    fs.writeFileSync(path.join(sb, 'modules/providers/services/sessions.service.js'), `${head}
export const sessionsService = {
    fetchHistory: async () => {
        const state = S();
        if (state.historyError) {
            throw new Error('history unavailable');
        }
        return { messages: state.history ?? [] };
    },
};
`);
    return { sb, url: pathToFileURL(path.join(sb, 'a/b/c/dispatcher.mjs')).href, logFile };
}

async function dispatch(name, state, { passes = 1, runtimeState } = {}) {
    const box = dispatcherSandbox(name, state);
    const previous = process.env.CLOUDCLI_RUNTIME_STATE;
    const stateFile = path.join(box.sb, 'runtime-state.json');
    if (runtimeState !== undefined) {
        fs.writeFileSync(stateFile, typeof runtimeState === 'string' ? runtimeState : JSON.stringify(runtimeState));
    }
    process.env.CLOUDCLI_RUNTIME_STATE = stateFile;
    try {
        const mod = await import(box.url);
        for (let pass = 0; pass < passes; pass += 1) {
            await mod.dispatchQueuedMessages({});
        }
    }
    finally {
        if (previous === undefined) {
            delete process.env.CLOUDCLI_RUNTIME_STATE;
        }
        else {
            process.env.CLOUDCLI_RUNTIME_STATE = previous;
        }
    }
    const log = fs.existsSync(box.logFile)
        ? fs.readFileSync(box.logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
    return { sends: log.filter((entry) => entry.op === 'send'), claims: log.filter((entry) => entry.op === 'claim'), log };
}

const queued = (content) => ({ content, options: {}, attachments: [] });
const userMsg = (content, msAgo) => ({ kind: 'text', role: 'user', content, timestamp: new Date(Date.now() - msAgo).toISOString() });
const botMsg = (content, msAgo) => ({ kind: 'text', role: 'assistant', content, timestamp: new Date(Date.now() - msAgo).toISOString() });

test('dispatcher control: a fresh, new draft is sent once', async () => {
    const { sends } = await dispatch('fresh', { queued: queued('run the tests'), queuedAt: sqliteTime(60_000), history: [] });
    assert.equal(sends.length, 1);
});

test('dispatcher drops a stale draft (queued more than 30 min ago)', async () => {
    const { sends, log } = await dispatch('stale', { queued: queued('run the tests'), queuedAt: sqliteTime(31 * 60_000), history: [] });
    assert.equal(sends.length, 0);
    assert.ok(log.some((entry) => entry.op === 'delete'), 'the stale draft is cleaned up');
});

test('dispatcher drops a draft already sent earlier (any user row of the last 10, no time window)', async () => {
    const history = [
        userMsg('  please continue ', 2 * 3_600_000), botMsg('continuing', 2 * 3_600_000 - 1_000),
        userMsg('something else', 3_600_000), botMsg('done', 3_599_000),
    ];
    const { sends } = await dispatch('already-sent', { queued: queued('please continue'), queuedAt: sqliteTime(60_000), history });
    assert.equal(sends.length, 0);
});

test('dispatcher dedupes by draft id: the same draft re-queued after dispatch is not sent again', async () => {
    const { sends } = await dispatch('same-draft', { queued: queued('ship it'), queuedAt: sqliteTime(60_000), history: [] }, { passes: 2 });
    assert.equal(sends.length, 1);
});

for (const state of ['in-turn', 'bg-work', 'retiring']) {
    test(`dispatcher treats a live runtime-state entry in ${state} as busy (no claim, no send)`, async () => {
        const runtimeState = [{ appSessionId: 's1', providerSessionId: 'prov-s1', pid: process.pid, state, since: new Date().toISOString() }];
        const { sends, claims } = await dispatch(`busy-${state}`, { queued: queued('next step'), queuedAt: sqliteTime(60_000), history: [] }, { runtimeState });
        assert.equal(claims.length, 0);
        assert.equal(sends.length, 0);
    });
}

test('dispatcher: idle-held, a dead pid, a malformed state file and a history error all send (fail open)', async () => {
    const base = { queued: queued('next step'), queuedAt: sqliteTime(60_000), history: [] };
    const idle = await dispatch('idle-held', base, { runtimeState: [{ appSessionId: 's1', pid: process.pid, state: 'idle-held' }] });
    assert.equal(idle.sends.length, 1, 'idle-held is not busy');
    const dead = await dispatch('dead-pid', base, { runtimeState: [{ appSessionId: 's1', pid: DEAD_PID, state: 'bg-work' }] });
    assert.equal(dead.sends.length, 1, 'an entry whose pid is gone is ignored');
    const malformed = await dispatch('malformed', base, { runtimeState: '{not json' });
    assert.equal(malformed.sends.length, 1, 'malformed state file fails open');
    const historyError = await dispatch('history-error', { ...base, historyError: true });
    assert.equal(historyError.sends.length, 1, 'history error fails open');
    const badTime = await dispatch('bad-time', { ...base, queuedAt: 'not a time' });
    assert.equal(badTime.sends.length, 1, 'unparseable queue time fails open');
});

// -------------------------------------------------------------------- Shell
function shellSandbox(name) {
    const sb = fs.mkdtempSync(path.join(root, `shell-${name}-`));
    for (const dir of ['a/b/c', 'shared', 'node_modules/node-pty', 'node_modules/ws']) {
        fs.mkdirSync(path.join(sb, dir), { recursive: true });
    }
    fs.copyFileSync(path.join(pkg, SHELL_REL), path.join(sb, 'a/b/c/shell.mjs'));
    fs.writeFileSync(path.join(sb, 'shared/utils.js'), `export function parseIncomingJsonObject(raw) {
    try {
        const value = JSON.parse(String(raw));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
`);
    for (const [dir, body] of [
        ['node-pty', "export default { spawn() { throw new Error('the real PTY must not be used'); } };\n"],
        ['ws', 'export const WebSocket = { OPEN: 1 };\nexport default { WebSocket };\n'],
    ]) {
        fs.writeFileSync(path.join(sb, 'node_modules', dir, 'package.json'), JSON.stringify({ name: dir, type: 'module', main: 'index.js' }));
        fs.writeFileSync(path.join(sb, 'node_modules', dir, 'index.js'), body);
    }
    return { sb, url: pathToFileURL(path.join(sb, 'a/b/c/shell.mjs')).href };
}

async function openShell(name, { runtimeState, message = {} } = {}) {
    const box = shellSandbox(name);
    const stateFile = path.join(box.sb, 'runtime-state.json');
    if (runtimeState !== undefined) {
        fs.writeFileSync(stateFile, JSON.stringify(runtimeState));
    }
    const previous = process.env.CLOUDCLI_RUNTIME_STATE;
    process.env.CLOUDCLI_RUNTIME_STATE = stateFile;
    const spawned = [];
    const sent = [];
    const handlers = {};
    const socket = {
        readyState: 1,
        on(event, handler) { handlers[event] = handler; return socket; },
        send(data) { sent.push(JSON.parse(data)); },
        close() {},
    };
    const fakePty = { pid: 4242, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
    try {
        const { handleShellConnection } = await import(box.url);
        handleShellConnection(socket, {
            resolveProviderSessionId: () => 'prov-1',
            spawnPty: (_shell, args) => { spawned.push(args[args.length - 1]); return fakePty; },
        });
        await handlers.message(JSON.stringify({
            type: 'init', projectPath: box.sb, sessionId: 'app-1', hasSession: true, provider: 'claude', cols: 80, rows: 24, ...message,
        }));
    }
    finally {
        if (previous === undefined) {
            delete process.env.CLOUDCLI_RUNTIME_STATE;
        }
        else {
            process.env.CLOUDCLI_RUNTIME_STATE = previous;
        }
    }
    return { spawned, sent };
}

test('Shell tab refuses to resume a session held by a live CLI (idle-held)', async () => {
    const { spawned, sent } = await openShell('held', {
        runtimeState: [{ appSessionId: 'app-1', providerSessionId: 'prov-1', pid: process.pid, state: 'idle-held', since: new Date().toISOString() }],
    });
    assert.deepEqual(spawned, []);
    assert.ok(sent.some((msg) => msg.type === 'error' && /held by a live CloudCLI process/.test(msg.message)), JSON.stringify(sent));
});

test('Shell tab refuses when only the provider session id matches a live entry', async () => {
    const { spawned } = await openShell('held-by-provider-id', {
        runtimeState: [{ appSessionId: 'another-app-id', providerSessionId: 'prov-1', pid: process.pid, state: 'in-turn' }],
    });
    assert.deepEqual(spawned, []);
});

test('Shell tab resumes without the `|| claude` fallback when no live entry exists', async () => {
    const none = await openShell('no-state');
    assert.deepEqual(none.spawned, ['claude --resume "prov-1"']);
    const dead = await openShell('dead-pid', { runtimeState: [{ appSessionId: 'app-1', providerSessionId: 'prov-1', pid: DEAD_PID, state: 'idle-held' }] });
    assert.deepEqual(dead.spawned, ['claude --resume "prov-1"']);
    const bypass = await openShell('bypass', { message: { bypassPermissions: true } });
    assert.deepEqual(bypass.spawned, ['claude --resume "prov-1" --dangerously-skip-permissions']);
});

test('Shell tab plain shell is not blocked by a live entry (no claude resume involved)', async () => {
    const { spawned } = await openShell('plain', {
        runtimeState: [{ appSessionId: 'app-1', providerSessionId: 'prov-1', pid: process.pid, state: 'idle-held' }],
        message: { isPlainShell: true, initialCommand: 'ls' },
    });
    assert.deepEqual(spawned, ['ls']);
});
