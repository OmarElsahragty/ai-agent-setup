// P8: queued-draft dispatcher duplicate guard. The patched dispatcher is run
// for real against stub modules laid out at the relative import paths
// (../../../modules/...), so no app database or websocket stack is touched.
// P8 dropped a duplicate only when the last user message landed within 120 s
// before the turn was queued. P11 (apply.d/p11.sh, chained by apply.sh)
// superseded that window: a draft whose trimmed text equals ANY user row among
// the last 10 history messages is dropped however long ago that row was sent,
// with no timestamp needed on either side; a draft queued more than 30 min ago
// is dropped as stale before the history is read (that guard and the draft-id
// dedupe are covered in p11-sessions.test.mjs). The queue time below is one
// minute in the past, so every case here reaches the duplicate rule; a drop
// is asserted together with the history read that proves which rule dropped
// it. A different text, or a history read error, still SENDS (fail-open).
// Negative control: the same probe against the UNPATCHED dist file must show
// the OLD behaviour (identical message still sent).
import { test, before, after } from 'node:test';
import { stockSrc } from './stock-src.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The patch set this test file belongs to (live: ${AI_SETUP_ROOT}/cloudcli/patches).
const PATCHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = stockSrc();
const SCHED_REL = 'dist-server/server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
const SCHED_TS_REL = 'server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts';
const SAME = '  please continue  ';
// SQLite CURRENT_TIMESTAMP shape (UTC, second precision, no zone) on purpose:
// proves the UTC normalization in the patched helper. One minute ago, so the
// P11 stale-draft guard (> 30 min) never fires in this file.
const QUEUED_AT_MS = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const QUEUED_AT = new Date(QUEUED_AT_MS).toISOString().slice(0, 19).replace('T', ' ');
const userTs = (offsetMs) => new Date(QUEUED_AT_MS + offsetMs).toISOString();
const USER_TS = userTs(-30_000); // 30 s before QUEUED_AT
const USER_TS_10_MIN = userTs(-10 * 60_000); // 10 min before QUEUED_AT
const USER_TS_SAME_SECOND = userTs(800); // after the second-precision queue time
const USER_TS_120_S = userTs(-120_000); // exactly 120 s before
let root;
let pkg;
let previousRuntimeState;

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

// Copies the dispatcher file into <sandbox>/a/b/c/ so its relative imports
// (../../../modules/...) resolve to the stub modules at <sandbox>/modules/.
async function loadDispatcher(sandbox, dispatcherFile) {
    const nest = path.join(sandbox, 'a', 'b', 'c');
    fs.mkdirSync(nest, { recursive: true });
    fs.copyFileSync(dispatcherFile, path.join(nest, 'dispatcher.mjs'));
    return path.join(nest, 'dispatcher.mjs');
}

function writeStubs(sandbox, { history, historyError, queuedUpdatedAt }) {
    for (const dir of ['modules/database', 'modules/websocket', 'modules/providers/services']) {
        fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(sandbox, 'state.json'), JSON.stringify({ history, historyError, queuedUpdatedAt }));
    const rec = (file) => `
        import fs from 'node:fs';
        const file = ${JSON.stringify(path.join(sandbox, file))};
        export default (value) => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
    `;
    fs.writeFileSync(path.join(sandbox, 'rec-sent.mjs'), rec('sent.ndjson'));
    fs.writeFileSync(path.join(sandbox, 'rec-drafts.mjs'), rec('drafts.ndjson'));
    fs.writeFileSync(path.join(sandbox, 'rec-history.mjs'), rec('history.ndjson'));
    fs.writeFileSync(path.join(sandbox, 'modules', 'database', 'index.js'), `
        import fs from 'node:fs';
        import rec from '../../rec-drafts.mjs';
        const state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(sandbox, 'state.json'))}, 'utf8'));
        export const sessionDraftsDb = {
            getDrafts: () => [{ scope: 's1', text: '', queuedMessage: {}, updatedAt: state.queuedUpdatedAt ?? null }],
            listQueuedMessages: () => [{
                userId: 'u1',
                sessionId: 's1',
                queuedMessage: { content: ${JSON.stringify(SAME)}, options: {}, attachments: [] },
            }],
            claimQueuedMessage: () => true,
            deleteEmptyDraft: (userId, sessionId) => rec({ userId, sessionId }),
            restoreQueuedMessage: (candidate) => rec({ restored: candidate }),
        };
        export const scheduledMessagesDb = {};
    `);
    fs.writeFileSync(path.join(sandbox, 'modules', 'websocket', 'index.js'), `
        import rec from '../../rec-sent.mjs';
        export const chatRunRegistry = { isProcessing: () => false };
        export const runDetachedChatTurn = async (payload) => {
            rec(payload);
            return { started: true };
        };
    `);
    fs.writeFileSync(path.join(sandbox, 'modules', 'providers', 'services', 'sessions.service.js'), `
        import fs from 'node:fs';
        import rec from '../../../rec-history.mjs';
        const state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(sandbox, 'state.json'))}, 'utf8'));
        export const sessionsService = {
            fetchHistory: async (sessionId, options) => {
                rec({ sessionId, options });
                if (state.historyError) {
                    throw state.historyError;
                }
                return { messages: state.history, total: state.history.length, hasMore: false, ...options };
            },
        };
    `);
}

function readNdjson(file) {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function runDispatch(dispatcherFile, { history = [], historyError = null, queuedUpdatedAt = null } = {}) {
    const sandbox = fs.mkdtempSync('/var/tmp/claude/p8-run-');
    try {
        writeStubs(sandbox, { history, historyError, queuedUpdatedAt });
        const mod = await import(await loadDispatcher(sandbox, dispatcherFile));
        const claimed = await mod.dispatchQueuedMessages({});
        return {
            claimed,
            sent: readNdjson(path.join(sandbox, 'sent.ndjson')),
            deletedDrafts: readNdjson(path.join(sandbox, 'drafts.ndjson')).filter((e) => !e.restored),
            restored: readNdjson(path.join(sandbox, 'drafts.ndjson')).filter((e) => e.restored),
            historyReads: readNdjson(path.join(sandbox, 'history.ndjson')).length,
        };
    }
    finally {
        await fsp.rm(sandbox, { recursive: true, force: true });
    }
}

before(async () => {
    root = `/var/tmp/claude/p8-apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(SRC, pkg, { recursive: true });
    // The P11 dispatcher also reads the provider runtime-state file (busy
    // check); point it at an absent file under the temp root so the live
    // /run/cloudcli/runtime-state.json never influences this suite.
    previousRuntimeState = process.env.CLOUDCLI_RUNTIME_STATE;
    process.env.CLOUDCLI_RUNTIME_STATE = path.join(root, 'runtime-state.json');
});

after(async () => {
    if (previousRuntimeState === undefined) {
        delete process.env.CLOUDCLI_RUNTIME_STATE;
    }
    else {
        process.env.CLOUDCLI_RUNTIME_STATE = previousRuntimeState;
    }
    await fsp.rm(root, { recursive: true, force: true });
});

test('apply.sh applies P8 to a temp copy and exits 0', () => {
    const result = runApply([root]);
    assert.equal(result.status, 0, `apply stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('P8 patched:'), result.stdout);
});

test('P8: identical last user message within 120 s is dropped and the draft cleared', async () => {
    const { sent, deletedDrafts, restored, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [
            { kind: 'text', role: 'user', content: SAME, timestamp: USER_TS },
            { kind: 'text', role: 'assistant', content: 'working' },
        ],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, `must not send, sent: ${JSON.stringify(sent)}`);
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read), not by the stale-draft guard');
    assert.deepEqual(deletedDrafts, [{ userId: 'u1', sessionId: 's1' }], 'draft cleaned like a sent one');
    assert.equal(restored.length, 0, 'no re-queue');
});

test('P8: identical text exactly 120 s before queueing is still dropped (boundary)', async () => {
    const { sent, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [{ kind: 'text', role: 'user', content: SAME, timestamp: USER_TS_120_S }],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, 'ageMs <= 120_000 is inclusive');
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read)');
});

test('P8: identical text landing in the same second as the queue time is dropped (SQLite second precision, 5 s slack)', async () => {
    const { sent, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [{ kind: 'text', role: 'user', content: SAME, timestamp: USER_TS_SAME_SECOND }],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, 'same-second duplicate dropped');
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read)');
});

test('P8 + P11: identical text sent 10 minutes before queueing is still dropped (P11 removed the 120 s window)', async () => {
    const { sent, deletedDrafts, restored, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [
            { kind: 'text', role: 'user', content: SAME, timestamp: USER_TS_10_MIN },
            { kind: 'text', role: 'assistant', content: 'working' },
        ],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, `any user row among the last 10 with the same text is a duplicate, however old; sent: ${JSON.stringify(sent)}`);
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read), not by the stale-draft guard');
    assert.deepEqual(deletedDrafts, [{ userId: 'u1', sessionId: 's1' }], 'draft cleaned like a sent one');
    assert.equal(restored.length, 0, 'no re-queue');
});

test('P8 + P11: identical text with no message timestamp is dropped (the duplicate rule needs no time)', async () => {
    const { sent, deletedDrafts, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [{ kind: 'text', role: 'user', content: SAME }],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, `a missing message time no longer lets the duplicate through; sent: ${JSON.stringify(sent)}`);
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read)');
    assert.deepEqual(deletedDrafts, [{ userId: 'u1', sessionId: 's1' }], 'draft cleaned like a sent one');
});

test('P8 + P11: identical text with no draft updated_at is dropped (the stale guard fails open; the duplicate rule needs no time)', async () => {
    const { sent, deletedDrafts, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [{ kind: 'text', role: 'user', content: SAME, timestamp: USER_TS }],
    });
    assert.equal(sent.length, 0, `a missing queue time no longer lets the duplicate through; sent: ${JSON.stringify(sent)}`);
    assert.equal(historyReads, 1, 'no queue time is never "stale": the history is still read and the duplicate rule drops it');
    assert.deepEqual(deletedDrafts, [{ userId: 'u1', sessionId: 's1' }], 'draft cleaned like a sent one');
});

test('P8: different text still sends', async () => {
    const { sent, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [{ kind: 'text', role: 'user', content: 'an entirely different ask', timestamp: USER_TS }],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 1, 'sent once');
    assert.equal(sent[0].content, SAME);
    assert.equal(historyReads, 1, 'the duplicate rule looked at the history and let it through');
});

test('P8: history error falls through and sends', async () => {
    const { sent, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        historyError: new Error('boom'),
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 1, 'sent despite history failure');
    assert.equal(historyReads, 1, 'the failing history read was attempted, then failed open');
});

test('P8: non-user or non-text tail entries are skipped for the comparison', async () => {
    const { sent, historyReads } = await runDispatch(path.join(pkg, SCHED_REL), {
        history: [
            { kind: 'text', role: 'user', content: SAME, timestamp: USER_TS },
            { kind: 'tool_use', role: 'assistant', content: SAME },
        ],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 0, 'last USER text still matches through a tool tail');
    assert.equal(historyReads, 1, 'dropped by the duplicate rule (history read)');
});

test('P8 negative control: unpatched dispatcher still sends the duplicate', async () => {
    const { sent, deletedDrafts, restored } = await runDispatch(path.join(SRC, SCHED_REL), {
        history: [
            { kind: 'text', role: 'user', content: SAME, timestamp: USER_TS },
            { kind: 'text', role: 'assistant', content: 'working' },
        ],
        queuedUpdatedAt: QUEUED_AT,
    });
    assert.equal(sent.length, 1, 'unpatched behaviour: duplicate IS sent');
});

test('P8: markers present in the TS source', async () => {
    const ts = await fsp.readFile(path.join(pkg, SCHED_TS_REL), 'utf8');
    assert.match(ts, /isDuplicateOfLastUserMessage\(sessionId: string, content: string, queuedAt: string \| null\): Promise<boolean>/, 'helper with types');
    assert.match(ts, /import \{ sessionsService \} from '@\/modules\/providers\/services\/sessions\.service\.js';/, 'ts import');
    assert.match(ts, /getDrafts\(candidate\.userId\)/, 'queue time read before the claim');
});

test('P8: patched dist file still parses as ESM', () => {
    const target = path.join(root, 'p8-dispatcher.check.mjs');
    fs.copyFileSync(path.join(pkg, SCHED_REL), target);
    const check = spawnSync('node', ['--check', target], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
});

test('apply.sh is idempotent for P8 and --check passes afterwards', async () => {
    const dist = path.join(pkg, SCHED_REL);
    const before = fs.readFileSync(dist, 'utf8');
    const again = runApply([root]);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes('P8 already applied:'), again.stdout);
    assert.equal(fs.readFileSync(dist, 'utf8'), before);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes('check OK'), check.stdout);
});

test('apply.sh --check exits 1 on a fresh copy (P8 missing)', () => {
    const fresh = `/var/tmp/claude/p8-apply-fresh-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    try {
        fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
        const result = runApply(['--check', fresh]);
        assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.ok(result.stderr.includes('MISSING') && result.stderr.includes('P8'), result.stderr);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
