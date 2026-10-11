// P13 (WO-13, 2026-10-10): origin label, auto-archive and fork link for
// sessions indexed from disk (no app-created row).
//
// Owner rulings: GAP-4 (sessions the owner did not start from the web UI are
// archived on first index and labelled; terminal sessions stay visible with a
// 'terminal' label) and GAP-9 (a Claude Code fork/background copy is linked to
// its parent instead of showing as an unrelated duplicate row).
//
// The archive decision is taken ONCE, when the indexer inserts the row. Later
// writes to the same transcript never touch isArchived again (P11 keeps the
// upsert away from the flag), so an owner un-archive sticks. The parent link
// is derived from the transcripts themselves (Claude Code repeats the
// parent's first non-meta uuids in the copy, and the parent records a
// `continued-in` row) and served read-only on the DTO; nothing is written to
// the database except the existing archive flag. The same-directory handoff
// scan (pass 2) runs only when a row is first classified, never on the sidebar
// fetch/upsert paths. Every helper fails open.
import fs from 'node:fs';

const HEAD_MAX_BYTES = 256 * 1024;
const HEAD_MAX_ROWS = 400;
const TAIL_MAX_BYTES = 256 * 1024;
const LEAD_UUIDS = 5;
const CACHE_MAX = 5000;

/** origin -> sidebar label. */
export const P13_LABELS = Object.freeze({
    cli: 'terminal',
    'sdk-cli': 'probe',
    sdk: 'probe',
    bg: 'background',
    fork: 'fork',
});

/** Origins archived on first index (archive only, never deleted). */
export const P13_ARCHIVED_ORIGINS = new Set(['sdk-cli', 'sdk', 'bg', 'fork']);

const headCache = new Map();
const parentCache = new Map();

function remember(cache, key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        cache.delete(oldest);
    }
}

function parseLines(text, complete) {
    const lines = text.split('\n');
    if (!complete) {
        lines.pop();
    }
    const rows = [];
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        try {
            const row = JSON.parse(line);
            if (row && typeof row === 'object' && !Array.isArray(row)) {
                rows.push(row);
            }
        }
        catch {
            // A partial or foreign line never decides anything.
        }
    }
    return rows;
}

function closeQuietly(fd) {
    if (fd === undefined) {
        return;
    }
    try {
        fs.closeSync(fd);
    }
    catch {
        // ignore
    }
}

/**
 * Bounded read of the first rows of a Claude transcript: the first
 * `entrypoint` (cli | sdk-cli | sdk-ts | ...), the first `sessionKind`
 * (bg = Claude Code background session) and the first five non-meta
 * user/assistant uuids (a fork or background copy repeats its parent's).
 */
export function p13ReadTranscriptHead(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(HEAD_MAX_BYTES);
        const bytes = fs.readSync(fd, buffer, 0, HEAD_MAX_BYTES, 0);
        const rows = parseLines(buffer.subarray(0, bytes).toString('utf8'), bytes < HEAD_MAX_BYTES);
        const head = { entrypoint: null, sessionKind: null, leadUuids: [], rows: 0 };
        for (const row of rows.slice(0, HEAD_MAX_ROWS)) {
            head.rows += 1;
            if (head.entrypoint === null && typeof row.entrypoint === 'string' && row.entrypoint) {
                head.entrypoint = row.entrypoint;
            }
            if (head.sessionKind === null && typeof row.sessionKind === 'string' && row.sessionKind) {
                head.sessionKind = row.sessionKind;
            }
            if (head.leadUuids.length < LEAD_UUIDS
                && (row.type === 'user' || row.type === 'assistant')
                && row.isMeta !== true
                && typeof row.uuid === 'string'
                && row.uuid) {
                head.leadUuids.push(row.uuid);
            }
        }
        return head;
    }
    catch {
        return null;
    }
    finally {
        closeQuietly(fd);
    }
}

function headIsFinal(head) {
    return !!head && head.entrypoint !== null && head.leadUuids.length >= LEAD_UUIDS;
}

/** Cached head; re-read only while the head is incomplete and the file size changed. */
export function p13CachedHead(filePath) {
    if (typeof filePath !== 'string' || !filePath.endsWith('.jsonl')) {
        return null;
    }
    const cached = headCache.get(filePath);
    if (cached && headIsFinal(cached.head)) {
        return cached.head;
    }
    let size;
    try {
        size = fs.statSync(filePath).size;
    }
    catch {
        return cached?.head ?? null;
    }
    if (cached && cached.size === size) {
        return cached.head;
    }
    const head = p13ReadTranscriptHead(filePath);
    remember(headCache, filePath, { size, head });
    return head;
}

/** Origin of a transcript from its head: bg | cli | sdk-cli | sdk | unknown. */
export function p13OriginOf(head) {
    if (!head) {
        return 'unknown';
    }
    if (head.sessionKind === 'bg') {
        return 'bg';
    }
    if (head.entrypoint === 'cli') {
        return 'cli';
    }
    if (head.entrypoint === 'sdk-cli') {
        return 'sdk-cli';
    }
    if (typeof head.entrypoint === 'string' && head.entrypoint.startsWith('sdk')) {
        return 'sdk';
    }
    return 'unknown';
}

/** Same derivation as P11's isExternal: the row was indexed from disk only. */
export function p13IsExternalRow(row) {
    return !!row
        && typeof row.provider_session_id === 'string'
        && row.provider_session_id !== ''
        && row.session_id === row.provider_session_id;
}

const tailCache = new Map();
const FULL_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const CONTINUED_IN_MARKER = Buffer.from('"continued-in"');
const NEWLINE = 0x0a;
const fullTargetsCache = new Map();

/** `continued-in` targets of the last 256 KB of an open transcript; parsed only when the marker is present. */
function tailTargets(fd, size) {
    const start = Math.max(0, size - TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const targets = new Set();
    if (text.includes('"continued-in"')) {
        const body = start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
        for (const entry of parseLines(body, true)) {
            if (entry.type === 'continued-in' && typeof entry.continuedInSessionId === 'string') {
                targets.add(entry.continuedInSessionId);
            }
        }
    }
    return targets;
}

/** Session ids a transcript names in `continued-in` rows within its last 256 KB (cached per size). */
function continuedInTargets(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        const cached = tailCache.get(filePath);
        if (cached && cached.size === size) {
            return cached.targets;
        }
        const targets = tailTargets(fd, size);
        remember(tailCache, filePath, { size, targets });
        return targets;
    }
    catch {
        return new Set();
    }
    finally {
        closeQuietly(fd);
    }
}

/** Bytes [from, to) of an open file, read SCAN_CHUNK_BYTES at a time. */
function readRange(fd, from, to) {
    const buffer = Buffer.alloc(to - from);
    let filled = 0;
    while (filled < buffer.length) {
        const bytes = fs.readSync(fd, buffer, filled, Math.min(SCAN_CHUNK_BYTES, buffer.length - filled), from + filled);
        if (bytes <= 0) {
            break;
        }
        filled += bytes;
    }
    return buffer.subarray(0, filled);
}

/** Adds the target of one marked line [from, to) when it is a top-level `continued-in` row. */
function addMarkedLine(fd, view, viewStart, from, to, targets) {
    const bytes = from >= viewStart ? view.subarray(from - viewStart, to - viewStart) : readRange(fd, from, to);
    try {
        const entry = JSON.parse(bytes.toString('utf8'));
        if (entry && typeof entry === 'object' && !Array.isArray(entry)
            && entry.type === 'continued-in' && typeof entry.continuedInSessionId === 'string') {
            targets.add(entry.continuedInSessionId);
        }
    }
    catch {
        // A partial or foreign line never decides anything.
    }
}

/**
 * `continued-in` targets of bytes [0, size) of an open transcript. Bounded
 * reads (SCAN_CHUNK_BYTES per call) with a byte-level precheck: only a line
 * that contains the literal `"continued-in"` marker is ever JSON-parsed, so a
 * transcript without a handoff row costs reads + a native substring search and
 * no parse at all. Same rows as parsing every line (a marker never spans a
 * newline; a marker split across two reads is caught by the carried bytes).
 */
function scanContinuedIn(fd, size) {
    const targets = new Set();
    if (size <= 0) {
        return targets;
    }
    const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size));
    const keep = CONTINUED_IN_MARKER.length - 1;
    let position = 0;
    let view = chunk.subarray(0, 0);
    let viewStart = 0;
    let lineStart = 0;
    let lineMarked = false;
    let carry = Buffer.alloc(0);
    while (position < size) {
        const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (bytes <= 0) {
            break;
        }
        view = chunk.subarray(0, bytes);
        viewStart = position;
        if (!lineMarked && carry.length > 0) {
            const joined = Buffer.concat([carry, view.subarray(0, Math.min(keep, bytes))]);
            const at = joined.indexOf(CONTINUED_IN_MARKER);
            if (at >= 0 && at < carry.length) {
                lineMarked = true;
            }
        }
        let i = 0;
        let marker = view.indexOf(CONTINUED_IN_MARKER);
        for (;;) {
            if (!lineMarked) {
                if (marker < 0) {
                    const last = view.lastIndexOf(NEWLINE);
                    if (last >= i) {
                        lineStart = viewStart + last + 1;
                    }
                    break;
                }
                const before = view.lastIndexOf(NEWLINE, marker);
                if (before >= i) {
                    lineStart = viewStart + before + 1;
                    i = before + 1;
                }
                lineMarked = true;
            }
            const nl = view.indexOf(NEWLINE, i);
            if (nl < 0) {
                break;
            }
            addMarkedLine(fd, view, viewStart, lineStart, viewStart + nl, targets);
            lineStart = viewStart + nl + 1;
            lineMarked = false;
            i = nl + 1;
            if (marker >= 0 && marker < i) {
                marker = view.indexOf(CONTINUED_IN_MARKER, i);
            }
        }
        carry = Buffer.from(view.subarray(Math.max(0, bytes - keep)));
        position += bytes;
    }
    if (lineMarked && lineStart < position) {
        addMarkedLine(fd, view, viewStart, lineStart, position, targets);
    }
    return targets;
}

/**
 * Same over the WHOLE transcript (capped at 32 MB; a larger file falls back to
 * its 256 KB tail); a handoff row can sit anywhere, not only near the tail.
 * Cached per path + size + mtimeMs, misses included: an unchanged transcript
 * costs one statSync and is never opened or re-read.
 */
function continuedInTargetsFull(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        return new Set();
    }
    const cached = fullTargetsCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.targets;
    }
    let fd;
    let targets;
    try {
        fd = fs.openSync(filePath, 'r');
        targets = stat.size > FULL_SCAN_MAX_BYTES ? tailTargets(fd, stat.size) : scanContinuedIn(fd, stat.size);
    }
    catch {
        return new Set();
    }
    finally {
        closeQuietly(fd);
    }
    remember(fullTargetsCache, filePath, { size: stat.size, mtimeMs: stat.mtimeMs, targets });
    return targets;
}

function dirOf(filePath) {
    const slash = filePath.lastIndexOf('/');
    return slash > 0 ? filePath.slice(0, slash) : '';
}

const INDEX_TTL_MS = 5000;
let leadIndex = null;

/** lead-uuid key -> indexed rows with a transcript; rebuilt when `fresh` or older than 5 s. */
function leadIndexFor(sessionsDb, fresh) {
    if (!fresh && leadIndex && leadIndex.sessionsDb === sessionsDb && Date.now() - leadIndex.builtAt < INDEX_TTL_MS) {
        return leadIndex.byKey;
    }
    const byKey = new Map();
    for (const candidate of sessionsDb.getSessionsWithTranscriptPath()) {
        const head = p13CachedHead(candidate?.jsonl_path);
        if (head && head.leadUuids.length >= LEAD_UUIDS) {
            const key = head.leadUuids.join('|');
            const list = byKey.get(key);
            if (list) {
                list.push(candidate);
            }
            else {
                byKey.set(key, [candidate]);
            }
        }
    }
    leadIndex = { sessionsDb, builtAt: Date.now(), byKey };
    return byKey;
}

/**
 * Parent of a fork/background copy, in two passes:
 * 1. another indexed session (archived or not) whose transcript starts with
 *    the same five non-meta uuids - a candidate whose transcript names this
 *    session in a `continued-in` row wins, otherwise the newest candidate
 *    whose row was created strictly before this one (created_at = file birth
 *    time);
 * 2. when pass 1 misses (a Claude Code background copy can start mid-history,
 *    so the copied uuids are NOT the parent's first five): the transcript in
 *    the SAME directory that names this session in a `continued-in` row -
 *    that handoff marker is the authoritative parent link. Bounded to the
 *    child's own project directory; each candidate scan is cached per path +
 *    size + mtimeMs (misses included). Pass 2 runs ONLY on a first
 *    classification (`firstClassification`: the indexer's INSERT, or a one-shot
 *    classification of existing rows); the read/broadcast paths never run it
 *    and see a pass-2 parent only through the found-parent cache.
 * Never links to a newer copy, so a parent is never labelled a fork of its
 * child. Returns the parent's app-facing session id, or null.
 */
export function p13FindForkParent(sessionsDb, row, head, firstClassification = false) {
    if (!row || !head || head.leadUuids.length < LEAD_UUIDS) {
        return null;
    }
    const cacheKey = `${row.session_id}\u0000${row.jsonl_path ?? ''}`;
    const cached = parentCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const childId = row.provider_session_id || row.session_id;
    const matches = (leadIndexFor(sessionsDb, firstClassification).get(head.leadUuids.join('|')) ?? [])
        .filter((candidate) => candidate.session_id !== row.session_id && candidate.jsonl_path !== row.jsonl_path)
        .map((candidate) => sessionsDb.getSessionById(candidate.session_id) ?? candidate);
    let parent = null;
    if (matches.length > 0) {
        const named = matches.find((candidate) => continuedInTargets(candidate.jsonl_path).has(childId));
        if (named) {
            parent = named.session_id;
        }
        else {
            const childCreated = String(row.created_at ?? '');
            const older = matches
                .filter((candidate) => childCreated && candidate.created_at && String(candidate.created_at) < childCreated)
                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            parent = older[0]?.session_id ?? null;
        }
    }
    if (!parent && firstClassification && row.jsonl_path && head.sessionKind === 'bg') {
        // Pass 2 (first classification only): same-directory transcript with a `continued-in` handoff to this session.
        const dir = dirOf(row.jsonl_path);
        if (dir) {
            for (const candidate of sessionsDb.getSessionsWithTranscriptPath()) {
                if (!candidate || candidate.session_id === row.session_id || candidate.jsonl_path === row.jsonl_path) {
                    continue;
                }
                if (dirOf(candidate.jsonl_path) !== dir) {
                    continue;
                }
                if (continuedInTargetsFull(candidate.jsonl_path).has(childId)) {
                    parent = candidate.session_id;
                    break;
                }
            }
        }
    }
    // A found parent is final; a miss is re-checked on the next call.
    if (parent) {
        remember(parentCache, cacheKey, parent);
    }
    return parent;
}

/** True when the indexer already has a row for this provider session id. */
export function p13RowExists(sessionsDb, providerSessionId) {
    try {
        return !!(sessionsDb.getSessionByProviderSessionId(providerSessionId) ?? sessionsDb.getSessionById(providerSessionId));
    }
    catch {
        return true;
    }
}

/**
 * Called by the Claude indexer right after createSession. Acts only when
 * that call inserted the row (`existed` false) and the row is external:
 * a probe, background or fork row is archived (archive only). Returns the
 * decision, or null when nothing applies or anything fails.
 */
export function p13OnIndexed({ sessionsDb, providerSessionId, filePath, existed }) {
    try {
        if (existed || process.env.CLOUDCLI_P13_AUTO_ARCHIVE === '0') {
            return null;
        }
        const row = sessionsDb.getSessionByProviderSessionId(providerSessionId) ?? sessionsDb.getSessionById(providerSessionId);
        if (!p13IsExternalRow(row) || row.provider !== 'claude') {
            return null;
        }
        const head = p13CachedHead(filePath || row.jsonl_path);
        const parent = p13FindForkParent(sessionsDb, row, head, true);
        const origin = parent ? 'fork' : p13OriginOf(head);
        const archived = P13_ARCHIVED_ORIGINS.has(origin);
        if (archived) {
            sessionsDb.updateSessionIsArchived(row.session_id, true);
        }
        return { sessionId: row.session_id, origin, label: P13_LABELS[origin] ?? null, archived, forkedFromSessionId: parent };
    }
    catch {
        return null;
    }
}

/**
 * Read-time DTO fields; nothing is written back. `forkedFromSessionId` is the
 * stored column when set (app forks), else the transcript-derived parent.
 * `firstClassification: true` is for one-shot classifiers of existing rows
 * (archive-external-sessions.py); the sidebar fetch/upsert paths never set it.
 */
export function p13DescribeSession(row, sessionsDb, options = {}) {
    try {
        if (!row) {
            return { isExternal: false, origin: 'app', originLabel: null, forkedFromSessionId: null };
        }
        const stored = row.forked_from_session_id || null;
        if (!p13IsExternalRow(row)) {
            return { isExternal: false, origin: 'app', originLabel: null, forkedFromSessionId: stored };
        }
        if (row.provider !== 'claude') {
            return { isExternal: true, origin: 'unknown', originLabel: null, forkedFromSessionId: stored };
        }
        const head = row.jsonl_path ? p13CachedHead(row.jsonl_path) : null;
        const parent = stored ?? (sessionsDb ? p13FindForkParent(sessionsDb, row, head, options?.firstClassification === true) : null);
        const origin = parent ? 'fork' : p13OriginOf(head);
        return { isExternal: true, origin, originLabel: P13_LABELS[origin] ?? null, forkedFromSessionId: parent };
    }
    catch {
        return { isExternal: false, origin: 'unknown', originLabel: null, forkedFromSessionId: null };
    }
}

const LABEL_PREFIX = /^(?:\[(?:terminal|probe|background|fork)\] )+/;

/** Sidebar text with the label in front, e.g. "[terminal] Fix the build". Idempotent. */
export function p13LabelSummary(summary, described) {
    const base = String(summary ?? '').replace(LABEL_PREFIX, '');
    if (process.env.CLOUDCLI_P13_LABEL_SUMMARY === '0' || !described?.originLabel) {
        return base;
    }
    return `[${described.originLabel}] ${base}`.trimEnd();
}

/** Extra sidebar DTO fields + labelled summary for one sessions row. */
export function p13SummaryFields(row, summary, sessionsDb) {
    const described = p13DescribeSession(row, sessionsDb);
    return {
        summary: p13LabelSummary(summary, described),
        isExternal: described.isExternal,
        origin: described.origin,
        originLabel: described.originLabel,
        forkedFromSessionId: described.forkedFromSessionId,
    };
}

/** @internal tests only */
export function p13ResetCache() {
    headCache.clear();
    parentCache.clear();
    tailCache.clear();
    fullTargetsCache.clear();
    leadIndex = null;
}
