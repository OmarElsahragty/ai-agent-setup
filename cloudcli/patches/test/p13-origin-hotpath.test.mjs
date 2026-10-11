// P13 gate-C hot-path fixes: the pass-2 (same-directory `continued-in`) fork
// lookup runs only on a first classification (INSERT / one-shot classifier),
// never on the sidebar read paths; each candidate scan is cached per path +
// size + mtimeMs (misses included); reads are bounded (<= 1 MiB per call) and
// only lines carrying the literal "continued-in" marker are JSON-parsed.
// Pure module tests. Negative control: P13_ORIGIN_MODULE=<pre-fix module>
// must fail the hot-path cases (parity/INSERT cases pass on both).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = process.env.P13_ORIGIN_MODULE ?? path.join(HERE, '..', 'files', 'p13-session-origin.js');
const CHUNK = 1024 * 1024;
let m;
let root;
let seq = 0;

before(async () => {
    m = await import(pathToFileURL(MODULE).href);
    fs.mkdirSync('/var/tmp/claude', { recursive: true });
    root = fs.mkdtempSync('/var/tmp/claude/p13-hotpath-');
});
after(() => {
    if (root) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
beforeEach(() => m.p13ResetCache());

// ------------------------------------------------------------- fixtures
const sid = () => {
    seq += 1;
    return `5e5e${String(seq).padStart(4, '0')}-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};
const newDir = (name) => fs.mkdirSync(path.join(root, name), { recursive: true }) ?? path.join(root, name);
const fileOf = (dir, id) => path.join(dir, `${id}.jsonl`);
const handoff = (from, to, extra = {}) => ({ type: 'continued-in', continuedInSessionId: to, sessionId: from, timestamp: '2026-10-10T00:00:00.000Z', ...extra });
function headRows(id, extra) {
    return Array.from({ length: 5 }, (_, i) => ({
        type: i % 2 ? 'assistant' : 'user', uuid: `${id.slice(0, 8)}-lead-${i}`, sessionId: id,
        message: { role: i % 2 ? 'assistant' : 'user', content: `row ${i}` }, ...extra,
    }));
}
const toText = (lines, trailingNewline = true) => `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
const json = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
function bgChild(dir, id) {
    fs.writeFileSync(fileOf(dir, id), toText(json(headRows(id, { entrypoint: 'cli', sessionKind: 'bg' }))));
    return fileOf(dir, id);
}
function terminal(dir, id, tail = []) {
    fs.writeFileSync(fileOf(dir, id), toText(json([...headRows(id, { entrypoint: 'cli' }), ...tail])));
    return fileOf(dir, id);
}
function fillerLine(id, n, length) {
    const row = (content) => JSON.stringify({ type: 'assistant', uuid: `fill-${n}`, sessionId: id, message: { role: 'assistant', content } });
    const need = length - row('').length;
    assert.ok(need >= 0, `filler too short: ${length}`);
    return row('x'.repeat(need));
}
/** Lines (head rows + fillers) whose joined size with newlines is exactly `offset`. */
function linesUpTo(id, offset, lines = json(headRows(id, { entrypoint: 'cli' }))) {
    let size = lines.reduce((sum, line) => sum + line.length + 1, 0);
    let n = 0;
    while (offset - size > 8200) {
        const line = fillerLine(id, n++, 4000);
        lines.push(line);
        size += line.length + 1;
    }
    if (offset > size) {
        lines.push(fillerLine(id, n++, offset - size - 1));
        size = offset;
    }
    assert.equal(size, offset);
    return lines;
}
/** A transcript larger than `bytes` whose content mentions "continued-in" only inside escaped strings. */
function noMarkerFile(dir, id, bytes) {
    const lines = json(headRows(id, { entrypoint: 'cli' }));
    let size = 0;
    for (let n = 0; size < bytes; n += 1) {
        const line = JSON.stringify({ type: 'assistant', uuid: `nm-${n}`, sessionId: id, message: { role: 'assistant', content: `the "continued-in" row names continuedInSessionId ${'z'.repeat(300)}` } });
        lines.push(line);
        size += line.length + 1;
    }
    fs.writeFileSync(fileOf(dir, id), toText(lines));
    return fileOf(dir, id);
}
const dbRow = (id, file, minute) => ({
    session_id: id, provider_session_id: id, provider: 'claude', project_path: '/work', jsonl_path: file,
    created_at: `2026-10-10T10:${String(minute).padStart(2, '0')}:00.000Z`, forked_from_session_id: null, isArchived: 0,
});
function stubDb(rows) {
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    return {
        rows,
        archived: [],
        getSessionsWithTranscriptPath: () => rows.map((r) => ({ session_id: r.session_id, jsonl_path: r.jsonl_path })),
        getSessionById: (id) => byId.get(id),
        getSessionByProviderSessionId: (id) => rows.find((r) => r.provider_session_id === id),
        updateSessionIsArchived(id, value) {
            this.archived.push([id, value]);
        },
    };
}
/** Builds a stub DB (child bg row + candidates), warms every head, returns the child's row/head. */
function world(childId, childFile, candidates) {
    const db = stubDb([...candidates.map(([id, file], i) => dbRow(id, file, i)), dbRow(childId, childFile, 50)]);
    for (const r of db.rows) {
        m.p13CachedHead(r.jsonl_path);
    }
    const row = db.getSessionById(childId);
    return { db, row, head: m.p13CachedHead(childFile) };
}
/** Runs `fn` with fs.openSync/readSync/readFileSync and JSON.parse counted. */
function spy(fn) {
    const counts = { open: 0, read: 0, readFile: 0, maxRead: 0, parse: 0, opened: [] };
    const orig = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync, parse: JSON.parse };
    fs.openSync = function (...args) {
        counts.open += 1;
        counts.opened.push(String(args[0]));
        return orig.openSync.apply(this, args);
    };
    fs.readSync = function (...args) {
        counts.read += 1;
        counts.maxRead = Math.max(counts.maxRead, typeof args[3] === 'number' ? args[3] : args[1].byteLength);
        return orig.readSync.apply(this, args);
    };
    fs.readFileSync = function (...args) {
        counts.readFile += 1;
        return orig.readFileSync.apply(this, args);
    };
    JSON.parse = function (...args) {
        counts.parse += 1;
        return orig.parse.apply(this, args);
    };
    try {
        return { result: fn(), counts };
    }
    finally {
        Object.assign(fs, { openSync: orig.openSync, readSync: orig.readSync, readFileSync: orig.readFileSync });
        JSON.parse = orig.parse;
    }
}
/** The pre-fix algorithm: parse every line, keep top-level continued-in rows. */
function referenceTargets(file) {
    const targets = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
            const e = JSON.parse(line);
            if (e && typeof e === 'object' && !Array.isArray(e) && e.type === 'continued-in' && typeof e.continuedInSessionId === 'string') {
                targets.add(e.continuedInSessionId);
            }
        }
        catch {
            // ignored, as in the classifier
        }
    }
    return targets;
}

// ------------------------------------------------------------------ (c)
test('read paths never run the pass-2 scan; a first classification does and its parent is then served from cache', () => {
    const dir = newDir('read-path');
    const parentId = sid();
    const childId = sid();
    const childFile = bgChild(dir, childId);
    const parentFile = terminal(dir, parentId, [handoff(parentId, childId)]);
    const { db, row } = world(childId, childFile, [[parentId, parentFile]]);
    const read = spy(() => m.p13DescribeSession(row, db));
    assert.equal(read.result.origin, 'bg', 'sidebar read path: pass 2 not run');
    assert.equal(read.result.forkedFromSessionId, null);
    assert.equal(read.counts.opened.filter((f) => f === parentFile).length, 0, 'read path never opens a same-dir candidate');
    const broadcast = spy(() => m.p13SummaryFields(row, 'x', db));
    assert.equal(broadcast.result.originLabel, 'background');
    assert.equal(broadcast.counts.open + broadcast.counts.read, 0, 'fetch/upsert DTO path reads no transcript');
    const first = m.p13DescribeSession(row, db, { firstClassification: true });
    assert.equal(first.origin, 'fork');
    assert.equal(first.forkedFromSessionId, parentId);
    assert.equal(m.p13DescribeSession(row, db).forkedFromSessionId, parentId, 'found parent cached for the read path');
});

test('INSERT (p13OnIndexed) runs pass 2: a bg copy named by a same-dir handoff is archived as a fork', () => {
    const dir = newDir('insert');
    const parentId = sid();
    const childId = sid();
    const childFile = bgChild(dir, childId);
    const parentFile = terminal(dir, parentId, [handoff(parentId, childId)]);
    const { db } = world(childId, childFile, [[parentId, parentFile]]);
    const decision = m.p13OnIndexed({ sessionsDb: db, providerSessionId: childId, filePath: childFile, existed: false });
    assert.equal(decision.origin, 'fork');
    assert.equal(decision.forkedFromSessionId, parentId);
    assert.equal(decision.archived, true);
    assert.deepEqual(db.archived, [[childId, true]]);
    assert.equal(m.p13OnIndexed({ sessionsDb: db, providerSessionId: childId, filePath: childFile, existed: true }), null, 'existing rows are never re-classified');
});

// ------------------------------------------------------------------ (a)
test('negative cache: a second lookup of an unchanged miss opens and reads no file; only a changed file is rescanned', () => {
    const dir = newDir('negative-cache');
    const [childId, otherId, termId, bigId] = [sid(), sid(), sid(), sid()];
    const childFile = bgChild(dir, childId);
    const termFile = terminal(dir, termId, [handoff(termId, otherId)]);
    const bigFile = noMarkerFile(dir, bigId, 2 * CHUNK);
    const { db, row, head } = world(childId, childFile, [[termId, termFile], [bigId, bigFile]]);
    assert.equal(m.p13FindForkParent(db, row, head, true), null, 'first lookup misses');
    const second = spy(() => m.p13FindForkParent(db, row, head, true));
    assert.equal(second.result, null);
    assert.equal(second.counts.open + second.counts.read + second.counts.readFile, 0, `unchanged miss re-read: ${JSON.stringify(second.counts)}`);
    fs.appendFileSync(termFile, `${JSON.stringify(handoff(termId, childId))}\n`);
    const third = spy(() => m.p13FindForkParent(db, row, head, true));
    assert.equal(third.result, termId, 'the changed transcript is rescanned');
    assert.deepEqual([...new Set(third.counts.opened)], [termFile], 'the unchanged transcript stays cached');
});

test('negative cache key includes mtimeMs: a same-size rewrite that adds the handoff is not served stale', () => {
    const dir = newDir('same-size');
    const [childId, otherId, termId] = [sid(), sid(), sid()];
    const childFile = bgChild(dir, childId);
    const termFile = terminal(dir, termId, [handoff(termId, otherId)]);
    const { db, row, head } = world(childId, childFile, [[termId, termFile]]);
    assert.equal(m.p13FindForkParent(db, row, head, true), null);
    const stat = fs.statSync(termFile);
    fs.writeFileSync(termFile, fs.readFileSync(termFile, 'utf8').replace(otherId, childId));
    fs.utimesSync(termFile, stat.atime, new Date(stat.mtimeMs + 5000));
    assert.equal(fs.statSync(termFile).size, stat.size, 'same size');
    assert.equal(m.p13FindForkParent(db, row, head, true), termId);
});

// ------------------------------------------------------------------ (b)
test('precheck: a transcript without the "continued-in" marker is never JSON-parsed; a marked one parses only its marked lines', () => {
    const plain = newDir('precheck-plain');
    const [childA, bigId] = [sid(), sid()];
    const a = world(childA, bgChild(plain, childA), [[bigId, noMarkerFile(plain, bigId, CHUNK + 4096)]]);
    const none = spy(() => m.p13FindForkParent(a.db, a.row, a.head, true));
    assert.equal(none.result, null);
    assert.equal(none.counts.parse, 0, `non-matching transcript parsed ${none.counts.parse} time(s)`);
    const marked = newDir('precheck-marked');
    const [childB, otherId, termId] = [sid(), sid(), sid()];
    const filler = Array.from({ length: 300 }, (_, n) => ({ type: 'user', uuid: `f${n}`, sessionId: termId, message: { role: 'user', content: 'plain' } }));
    const termFile = terminal(marked, termId, [...filler, handoff(termId, otherId), { type: 'assistant', uuid: 'tool', sessionId: termId, input: { pattern: 'continued-in' } }]);
    const b = world(childB, bgChild(marked, childB), [[termId, termFile]]);
    const some = spy(() => m.p13FindForkParent(b.db, b.row, b.head, true));
    assert.equal(some.result, null);
    assert.equal(some.counts.parse, 2, 'only the 2 lines carrying the literal marker are parsed');
});

test('bounded reads: no read call exceeds 1 MiB and handoff rows across read boundaries are found', () => {
    const MARKER_AT = JSON.stringify(handoff('a', 'b')).indexOf('"continued-in"');
    const cases = [
        ['marker ends at the boundary', -14],
        ['marker split 13/1', -13],
        ['marker split 7/7', -7],
        ['marker split 1/13', -1],
        ['marker starts at the boundary', 0],
        ['line starts before, marker after the boundary', 5],
    ];
    for (const [label, delta] of cases) {
        const dir = newDir(`bounded-${delta}`);
        const [childId, candId] = [sid(), sid()];
        const line = JSON.stringify(handoff(candId, childId));
        const lines = linesUpTo(candId, CHUNK + delta - MARKER_AT);
        lines.push(line, ...linesUpTo(candId, 64 * 1024, []));
        fs.writeFileSync(fileOf(dir, candId), toText(lines));
        const w = world(childId, bgChild(dir, childId), [[candId, fileOf(dir, candId)]]);
        const run = spy(() => m.p13FindForkParent(w.db, w.row, w.head, true));
        assert.equal(run.result, candId, label);
        assert.ok(run.counts.maxRead <= CHUNK, `${label}: read of ${run.counts.maxRead} bytes`);
    }
    const dir = newDir('bounded-long-line');
    const [childId, candId, tailChild] = [sid(), sid(), sid()];
    const longLine = JSON.stringify(handoff(candId, childId, { pad: 'y'.repeat(Math.floor(2.5 * CHUNK)) }));
    const lines = [...linesUpTo(candId, CHUNK / 2), longLine, ...linesUpTo(candId, 8192, []), JSON.stringify(handoff(candId, tailChild))];
    fs.writeFileSync(fileOf(dir, candId), toText(lines, false));
    const w = world(childId, bgChild(dir, childId), [[candId, fileOf(dir, candId)]]);
    const run = spy(() => m.p13FindForkParent(w.db, w.row, w.head, true));
    assert.equal(run.result, candId, 'a handoff line longer than two reads is found');
    assert.ok(run.counts.maxRead <= CHUNK, `long line: read of ${run.counts.maxRead} bytes`);
    const t = world(tailChild, bgChild(dir, tailChild), [[candId, fileOf(dir, candId)]]);
    assert.equal(m.p13FindForkParent(t.db, t.row, t.head, true), candId, 'a last line without a trailing newline is found');
});

// ------------------------------------------------------- classification parity
test('parity: randomized transcripts yield exactly the targets of a line-by-line parse (pre-fix algorithm)', () => {
    let state = 0x13579bdf;
    const rand = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
    const tally = { linked: 0, unlinked: 0 };
    for (let trial = 0; trial < 5; trial += 1) {
        const dir = newDir(`parity-${trial}`);
        const candId = sid();
        const pool = Array.from({ length: 6 }, () => sid());
        const lines = json(headRows(candId, { entrypoint: 'cli' }));
        let size = 0;
        while (size < 2.2 * CHUNK) {
            const k = Math.floor(rand() * 6);
            const kind = rand();
            let line;
            if (kind < 0.02) {
                line = JSON.stringify(handoff(candId, pool[k % 3]));
            }
            else if (kind < 0.04) {
                line = JSON.stringify({ type: 'user', sessionId: candId, tool: handoff(candId, pool[3]) });
            }
            else if (kind < 0.06) {
                line = `{"type":"continued-in","continuedInSessionId":"${pool[4]}"`;
            }
            else if (kind < 0.08) {
                line = JSON.stringify({ type: 'continued-in', continuedInSessionId: 42, note: pool[5] });
            }
            else if (kind < 0.1) {
                line = `${JSON.stringify(handoff(candId, pool[k % 3]))}\r`;
            }
            else if (kind < 0.15) {
                line = JSON.stringify({ type: 'assistant', sessionId: candId, message: { content: `"continued-in" ${pool[5]}` } });
            }
            else {
                line = fillerLine(candId, size, 200 + Math.floor(rand() * 20000));
            }
            lines.push(line);
            size += line.length + 1;
        }
        fs.writeFileSync(fileOf(dir, candId), toText(lines, rand() < 0.5));
        const expected = referenceTargets(fileOf(dir, candId));
        for (const childId of pool) {
            const w = world(childId, bgChild(dir, childId), [[candId, fileOf(dir, candId)]]);
            const got = m.p13FindForkParent(w.db, w.row, w.head, true);
            assert.equal(got, expected.has(childId) ? candId : null, `trial ${trial}: child ${childId} expected ${expected.has(childId)}`);
            tally[expected.has(childId) ? 'linked' : 'unlinked'] += 1;
        }
    }
    assert.ok(tally.linked >= 8 && tally.unlinked >= 12, `parity must exercise both outcomes: ${JSON.stringify(tally)}`);
});

test('a transcript over the 32 MB cap is judged by its 256 KB tail only (unchanged fallback)', () => {
    const dir = newDir('over-cap');
    const [early, late, candId] = [sid(), sid(), sid()];
    const lines = [...json(headRows(candId, { entrypoint: 'cli' })), JSON.stringify(handoff(candId, early)), fillerLine(candId, 0, 33 * CHUNK), JSON.stringify(handoff(candId, late))];
    fs.writeFileSync(fileOf(dir, candId), toText(lines));
    for (const [childId, want] of [[early, null], [late, candId]]) {
        const w = world(childId, bgChild(dir, childId), [[candId, fileOf(dir, candId)]]);
        const run = spy(() => m.p13FindForkParent(w.db, w.row, w.head, true));
        assert.equal(run.result, want);
        assert.ok(run.counts.maxRead <= 256 * 1024, `over-cap read of ${run.counts.maxRead} bytes`);
    }
});
