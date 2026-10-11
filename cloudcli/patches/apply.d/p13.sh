#!/usr/bin/env bash
# P13 (WO-13, 2026-10-10): session origin labels, auto-archive of non-owner
# sessions, fork links, re-subscribe refresh, terminal runs in the activity bar.
# Usage:
#   apply.d/p13.sh [TARGET_ROOT]          apply (idempotent; completes a partial apply)
#   apply.d/p13.sh --check [TARGET_ROOT]  verify every P13 edit and module copy; exit 1 if any is missing
#   apply.d/p13.sh --rollback [TARGET_ROOT]  reverse every P13 edit in place and remove the module copies
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (default: install root above patches/).
# Apply order: apply.sh (P0-P9r), then apply.d/p10.sh, p11.sh, p12.sh, p13.sh. P13 needs P11's
# archive-preserving upsert (an indexer write never changes isArchived) for the
# "owner un-archive sticks" guarantee; its files are disjoint from p10's.
#   (1) GAP-4: the Claude indexer classifies a row it has just INSERTED for a transcript
#       with no app-created row (P11 isExternal): entrypoint sdk-cli/sdk-* = probe,
#       sessionKind bg = background, a copy of another session = fork -> archived
#       (archive flag only, never deleted); entrypoint cli = terminal, stays visible.
#       Rows that already existed are never touched, so an owner restore sticks.
#   (2) Sidebar DTOs (project list + session_upserted) carry isExternal, origin,
#       originLabel, forkedFromSessionId, and the summary gets a "[label] " prefix
#       (read-time only; custom_name is never changed; CLOUDCLI_P13_LABEL_SUMMARY=0 disables
#       the prefix, CLOUDCLI_P13_AUTO_ARCHIVE=0 disables archiving).
#   (3) GAP-9: a Claude Code fork/background copy (same first five non-meta uuids as an
#       indexed session; the parent's `continued-in` row breaks ties) is linked to its
#       parent through forkedFromSessionId on the DTO (derived from the transcripts).
#   (4) B-F10 (M-111): a chat.subscribe with lastSeq > 0 for a session whose run is no
#       longer processing (and whose last seq the client did not see) is followed by a
#       session_upserted frame to that socket, so the open chat refetches the turn that
#       completed while the socket was detached.
#   (5) M-122: GET /api/bg-tasks/active also lists sidebar-visible sessions whose
#       terminal-started CLI is busy (~/.claude/sessions/<pid>.json, live pid). Mounted
#       in index.js in front of the stock router; bg-tasks.{service,routes}.js are untouched.
# Dist files only (the runtime). Each patched file keeps a .bak-pre-p13 copy, is
# written atomically after its edits verify, and passes `node --check`.
# D4: all-or-nothing. Every module copy and every target edit is planned and
# verified (sources, target dirs, anchors, markers, node --check) BEFORE the
# first write; any problem writes nothing. Writes go modules first, index.js
# last, and a failure mid-way restores every file written so far to its
# pre-run bytes (the first write of a target also leaves its .bak-pre-p13).
# --rollback reverses each present P13 edit textually, all-or-nothing as well,
# then removes the module copies; an edit that cannot be reversed exactly aborts
# with nothing written (restore that file from its .bak-pre-p13 by hand). It
# refuses while P14 is applied (P14 builds on P13's re-subscribe refresh in the
# same file): run apply.d/p14.sh --rollback first. Other later edits to these
# files survive only if they leave every P13 replacement text intact. P13_TEST_FAIL_BEFORE=<path suffix>
# is a test-only fault hook: the write of that file throws.
set -euo pipefail
MODE=apply
case "${1:-}" in
    --check) MODE=check; shift ;;
    --rollback) MODE=rollback; shift ;;
esac
PATCHES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then ROOT="$(cd "$1" && pwd)"; else ROOT="$(cd "$PATCHES_DIR/.." && pwd)"; fi
PKG="$ROOT/node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/p13-patcher.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [mode, pkg, work, patchesDir] = process.argv.slice(2);
const L = (...lines) => lines.join('\n');
const note = (msg) => console.log(`[${mode}] ${msg}`);
let problems = 0;
const fail = (msg) => { console.error(`P13 ${{ check: 'MISSING', rollback: 'ROLLBACK FAILED' }[mode] || 'PATCH FAILED'}: ${msg}`); problems += 1; };
const D = path.join(pkg, 'dist-server', 'server');

function nodeCheck(text, label) {
    const probe = path.join(work, `check-${label.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
    fs.writeFileSync(probe, text);
    const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
    return r.status === 0 ? null : (r.stderr || '').split('\n').slice(0, 4).join(' | ');
}

// ------------------------------------------------------------ module copies
const MODULES = [
    { src: 'p13-session-origin.js', dest: path.join(D, 'modules/providers/list/claude/p13-session-origin.js') },
    { src: 'p13-terminal-live.js', dest: path.join(D, 'modules/bg-tasks/p13-terminal-live.js') },
];
const moduleWrites = [];
for (const mod of mode === 'rollback' ? [] : MODULES) {
    const src = path.join(patchesDir, 'files', mod.src);
    if (!fs.existsSync(src)) {
        fail(`module source missing: files/${mod.src}`);
        continue;
    }
    const want = fs.readFileSync(src);
    const same = fs.existsSync(mod.dest) && Buffer.compare(fs.readFileSync(mod.dest), want) === 0;
    if (same) {
        note(`P13 module present: ${path.relative(pkg, mod.dest)}`);
        continue;
    }
    if (mode === 'check') {
        fail(`module ${path.relative(pkg, mod.dest)} absent or different from files/${mod.src}`);
        continue;
    }
    if (!fs.existsSync(path.dirname(mod.dest))) {
        fail(`target dir missing for ${mod.src} (run apply.sh first)`);
        continue;
    }
    const err = nodeCheck(want.toString('utf8'), mod.src);
    if (err) {
        fail(`node --check failed for files/${mod.src}: ${err}`);
        continue;
    }
    moduleWrites.push({ file: mod.dest, content: want, fileMode: 0o644, done: `P13 module copied: ${path.relative(pkg, mod.dest)}` });
}

// ---------------------------------------------------------- (1) indexer
const syncEdits = [
    {
        id: 'sync-import',
        marker: "import { p13OnIndexed, p13RowExists } from './p13-session-origin.js';",
        pairs: [["import { sessionsDb } from '../../../../modules/database/index.js';\n",
            "import { sessionsDb } from '../../../../modules/database/index.js';\nimport { p13OnIndexed, p13RowExists } from './p13-session-origin.js';\n"]],
    },
    {
        id: 'sync-full-scan',
        marker: 'P13: full scan classifies rows it inserts',
        pairs: [[
            L('            const timestamps = await readFileTimestamps(filePath);',
                '            sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath);',
                '            processed += 1;'),
            L('            const timestamps = await readFileTimestamps(filePath);',
                '            // P13: full scan classifies rows it inserts (probe/background/fork archived).',
                '            const p13Existed = p13RowExists(sessionsDb, parsed.sessionId);',
                '            sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath);',
                '            p13OnIndexed({ sessionsDb, providerSessionId: parsed.sessionId, filePath, existed: p13Existed });',
                '            processed += 1;'),
        ]],
    },
    {
        id: 'sync-file',
        marker: 'P13: a watcher add classifies the row it inserts',
        pairs: [[
            L('        const timestamps = await readFileTimestamps(filePath);',
                '        return sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath);'),
            L('        const timestamps = await readFileTimestamps(filePath);',
                '        // P13: a watcher add classifies the row it inserts; an existing row is never',
                '        // re-classified, so an owner un-archive sticks.',
                '        const p13Existed = p13RowExists(sessionsDb, parsed.sessionId);',
                '        const p13SessionId = sessionsDb.createSession(parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName, timestamps.createdAt, timestamps.updatedAt, filePath);',
                '        p13OnIndexed({ sessionsDb, providerSessionId: parsed.sessionId, filePath, existed: p13Existed });',
                '        return p13SessionId;'),
        ]],
    },
];

// ------------------------------------------------------------ (2) DTOs
const fetchEdits = [
    {
        id: 'fetch-import',
        marker: "import { p13SummaryFields } from '../../../modules/providers/list/claude/p13-session-origin.js';",
        pairs: [["import { AppError } from '../../../shared/utils.js';\n",
            "import { AppError } from '../../../shared/utils.js';\nimport { p13SummaryFields } from '../../../modules/providers/list/claude/p13-session-origin.js';\n"]],
    },
    {
        id: 'fetch-dto',
        marker: 'P13: origin label + isExternal/forkedFromSessionId (read-time, never stored).',
        pairs: [[
            L('function mapSessionRowToSummary(row) {', '    return {', '        id: row.session_id,', '        provider: row.provider,', "        summary: row.custom_name || '',"),
            L('function mapSessionRowToSummary(row) {', '    return {', '        id: row.session_id,', '        provider: row.provider,',
                '        // P13: origin label + isExternal/forkedFromSessionId (read-time, never stored).',
                "        ...p13SummaryFields(row, row.custom_name || '', sessionsDb),"),
        ]],
    },
];
const upsertEdits = [
    {
        id: 'upsert-import',
        marker: "import { p13SummaryFields } from '../../../modules/providers/list/claude/p13-session-origin.js';",
        pairs: [["import { connectedClients, WS_OPEN_STATE } from '../../../modules/websocket/services/websocket-state.service.js';\n",
            "import { connectedClients, WS_OPEN_STATE } from '../../../modules/websocket/services/websocket-state.service.js';\nimport { p13SummaryFields } from '../../../modules/providers/list/claude/p13-session-origin.js';\n"]],
    },
    {
        id: 'upsert-dto',
        marker: 'P13: same origin fields as the project list DTO.',
        pairs: [[
            L('        session: {', '            id: row.session_id,', "            summary: row.custom_name || '',"),
            L('        session: {', '            id: row.session_id,', '            // P13: same origin fields as the project list DTO.',
                "            ...p13SummaryFields(row, row.custom_name || '', sessionsDb),"),
        ]],
    },
];

// ------------------------------------------------- (4) re-subscribe refresh
const refreshHelper = L(
    '// P13 (B-F10): a socket that re-subscribes after it was detached (lastSeq > 0)',
    '// to a session whose run is no longer processing may have missed the end of',
    '// that turn. One session_upserted frame to that socket makes the open chat',
    '// refetch its history (the client refetches on session_upserted for the',
    '// selected, idle session). Fails open.',
    'async function p13RefreshAfterResubscribe(ws, sessionId) {',
    '    try {',
    "        const { buildSessionUpsertedEvent } = await import('./session-upsert-broadcast.service.js');",
    '        const event = await buildSessionUpsertedEvent(sessionId);',
    '        if (event && ws.readyState === WS_OPEN_STATE) {',
    "            sendJson(ws, { ...event, reason: 'resubscribe-refresh' });",
    '        }',
    '    }',
    '    catch {',
    '        // Never break a subscribe.',
    '    }',
    '}',
);
const chatEdits = [
    {
        id: 'chat-refresh-helper',
        marker: 'async function p13RefreshAfterResubscribe(ws, sessionId) {',
        pairs: [['/**\n * Handles `chat.subscribe`: for each requested session', `${refreshHelper}\n/**\n * Handles \`chat.subscribe\`: for each requested session`]],
    },
    {
        id: 'chat-refresh-call',
        marker: 'P13: the run ended while this socket was detached',
        pairs: [[
            L('            pendingPermissions,', '            timestamp: new Date().toISOString(),', '        });', '        // Replay only for RUNNING runs, strictly after the ack.'),
            L('            pendingPermissions,', '            timestamp: new Date().toISOString(),', '        });',
                '        // P13: the run ended while this socket was detached and the client did not',
                '        // see its last event -> ask the client to refetch the history.',
                "        if (!isProcessing && lastSeq > 0 && (!run || (typeof run.lastSeq === 'number' ? run.lastSeq : 0) > lastSeq)) {",
                '            void p13RefreshAfterResubscribe(ws, sessionId);',
                '        }',
                '        // Replay only for RUNNING runs, strictly after the ack.'),
        ]],
    },
];

// ------------------------------------------------- (5) activity bar mount
const indexEdits = [
    {
        id: 'index-import',
        marker: "import { p13TerminalActiveRoutes } from './modules/bg-tasks/p13-terminal-live.js';",
        pairs: [["import { bgTasksRoutes } from './modules/bg-tasks/bg-tasks.routes.js';\n",
            "import { bgTasksRoutes } from './modules/bg-tasks/bg-tasks.routes.js';\nimport { p13TerminalActiveRoutes } from './modules/bg-tasks/p13-terminal-live.js';\n"]],
    },
    {
        id: 'index-mount',
        marker: "app.use('/api/bg-tasks', authenticateToken, p13TerminalActiveRoutes);",
        pairs: [["app.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);\n",
            "// P13 (M-122): /active also lists busy terminal-started CLIs; every other path falls through.\napp.use('/api/bg-tasks', authenticateToken, p13TerminalActiveRoutes);\napp.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);\n"]],
    },
];

const TARGETS = [
    { rel: 'modules/providers/list/claude/claude-session-synchronizer.provider.js', edits: syncEdits },
    { rel: 'modules/projects/services/projects-with-sessions-fetch.service.js', edits: fetchEdits },
    { rel: 'modules/websocket/services/session-upsert-broadcast.service.js', edits: upsertEdits },
    { rel: 'modules/websocket/services/chat-websocket.service.js', edits: chatEdits, requires: 'function handleChatSubscribe(' },
    { rel: 'index.js', edits: indexEdits, requires: 'bgTasksRoutes' },
];

const count = (hay, needle) => hay.split(needle).length - 1;
const targetWrites = [];
for (const target of mode === 'rollback' ? [] : TARGETS) {
    const abs = path.join(D, target.rel);
    if (!fs.existsSync(abs)) {
        fail(`target not found: dist-server/server/${target.rel}`);
        continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const pending = target.edits.filter((edit) => !src.includes(edit.marker));
    if (pending.length === 0) {
        note(`P13 already applied: ${target.rel}`);
        continue;
    }
    if (mode === 'check') {
        for (const edit of pending) {
            fail(`${edit.id} in ${target.rel}`);
        }
        continue;
    }
    if (target.requires && !src.includes(target.requires)) {
        fail(`${target.rel} lacks ${target.requires} (run apply.sh first)`);
        continue;
    }
    let out = src;
    let ok = true;
    for (const edit of pending) {
        for (const [anchor, replacement] of edit.pairs) {
            const hits = count(out, anchor);
            if (hits !== 1) {
                fail(`${edit.id}: anchor matched ${hits}x in ${target.rel}: ${JSON.stringify(anchor.slice(0, 90))}`);
                ok = false;
                break;
            }
            out = out.replace(anchor, () => replacement);
        }
        if (!ok) {
            break;
        }
        if (!out.includes(edit.marker)) {
            fail(`${edit.id}: marker absent after edit in ${target.rel}`);
            ok = false;
            break;
        }
    }
    if (!ok) {
        continue;
    }
    const err = nodeCheck(out, target.rel);
    if (err) {
        fail(`node --check failed for ${target.rel}: ${err}`);
        continue;
    }
    targetWrites.push({ file: abs, content: out, bak: `${abs}.bak-pre-p13`, done: `P13 patched (${pending.map((edit) => edit.id).join(', ')}): ${target.rel}` });
}

// --rollback plan: reverse each present edit (replacement -> anchor, last edit
// first); every reversal must match exactly once and leave no P13 marker.
const rollbackWrites = [];
const rollbackRemovals = [];
if (mode === 'rollback') {
    // P14 builds on P13's re-subscribe refresh: reversing P13 underneath it would
    // leave P14 calling a removed helper. Refuse (nothing changed) until P14 is gone.
    for (const rel of ['modules/websocket/services/chat-websocket.service.js', 'modules/websocket/services/chat-run-registry.service.js']) {
        const abs = path.join(D, rel);
        if (fs.existsSync(abs) && /P14 \((M-1(11|23)|B-F10)/.test(fs.readFileSync(abs, 'utf8'))) {
            fail(`P14 is applied on top of P13 (${rel}); roll back P14 first: apply.d/p14.sh --rollback`);
        }
    }
    for (const target of TARGETS) {
        const abs = path.join(D, target.rel);
        if (!fs.existsSync(abs)) {
            note(`P13 rollback: not found, skipped: ${target.rel}`);
            continue;
        }
        const src = fs.readFileSync(abs, 'utf8');
        const present = target.edits.filter((edit) => src.includes(edit.marker));
        if (present.length === 0) {
            note(`P13 not present: ${target.rel}`);
            continue;
        }
        let out = src;
        let ok = true;
        for (const edit of [...present].reverse()) {
            for (const [anchor, replacement] of [...edit.pairs].reverse()) {
                const hits = count(out, replacement);
                if (hits !== 1) {
                    fail(`${edit.id}: patched text matched ${hits}x in ${target.rel}; restore ${target.rel}.bak-pre-p13 by hand`);
                    ok = false;
                    break;
                }
                out = out.replace(replacement, () => anchor);
            }
            if (!ok) {
                break;
            }
        }
        if (!ok) {
            continue;
        }
        const left = target.edits.filter((edit) => out.includes(edit.marker));
        if (left.length > 0) {
            fail(`${left.map((edit) => edit.id).join(', ')} still present in ${target.rel} after the reversal`);
            continue;
        }
        const err = nodeCheck(out, target.rel);
        if (err) {
            fail(`node --check failed for rolled-back ${target.rel}: ${err}`);
            continue;
        }
        rollbackWrites.push({ file: abs, content: out, done: `P13 rolled back (${present.map((edit) => edit.id).join(', ')}): ${target.rel}` });
    }
    for (const mod of MODULES) {
        if (fs.existsSync(mod.dest)) {
            rollbackRemovals.push({ file: mod.dest, done: `P13 module removed: ${path.relative(pkg, mod.dest)}` });
        }
    }
}

if (problems > 0) {
    console.error({ check: `check FAILED: ${problems} P13 item(s) missing`, rollback: `P13 rollback FAILED: ${problems} problem(s); nothing was changed` }[mode] || `P13 apply FAILED: ${problems} problem(s); nothing was written`);
    process.exit(1);
}

// Commit: atomic per file, journaled; any failure restores every file written
// so far to its pre-run bytes (or removes it if it did not exist).
const FAULT = process.env.P13_TEST_FAIL_BEFORE || '';
function commit(writes, removals) {
    const journal = [];
    const snapshot = (file) => (fs.existsSync(file) ? { prev: fs.readFileSync(file), prevMode: fs.statSync(file).mode & 0o7777 } : { prev: null, prevMode: null });
    try {
        for (const w of writes) {
            if (FAULT && w.file.endsWith(FAULT)) {
                throw new Error(`test fault before writing ${path.relative(pkg, w.file)}`);
            }
            const { prev, prevMode } = snapshot(w.file);
            if (w.bak && prev !== null && !fs.existsSync(w.bak)) {
                fs.copyFileSync(w.file, w.bak);
            }
            journal.push({ file: w.file, prev, prevMode });
            const tmp = `${w.file}.p13-tmp`;
            fs.writeFileSync(tmp, w.content);
            fs.chmodSync(tmp, w.fileMode ?? prevMode ?? 0o644);
            fs.renameSync(tmp, w.file);
            note(w.done);
        }
        for (const r of removals) {
            if (FAULT && r.file.endsWith(FAULT)) {
                throw new Error(`test fault before removing ${path.relative(pkg, r.file)}`);
            }
            const { prev, prevMode } = snapshot(r.file);
            journal.push({ file: r.file, prev, prevMode });
            fs.rmSync(r.file, { force: true });
            note(r.done);
        }
    }
    catch (error) {
        console.error(`P13 ${mode} FAILED while writing: ${error.message}; restoring ${journal.length} file(s) to their pre-run state`);
        let unrestored = 0;
        for (const entry of journal.reverse()) {
            try {
                fs.rmSync(`${entry.file}.p13-tmp`, { force: true });
                if (entry.prev === null) {
                    fs.rmSync(entry.file, { force: true });
                }
                else {
                    const tmp = `${entry.file}.p13-restore`;
                    fs.writeFileSync(tmp, entry.prev);
                    fs.chmodSync(tmp, entry.prevMode);
                    fs.renameSync(tmp, entry.file);
                }
            }
            catch (restoreError) {
                unrestored += 1;
                console.error(`P13 RESTORE FAILED for ${entry.file}: ${restoreError.message} (restore it from ${entry.file}.bak-pre-p13)`);
            }
        }
        for (const w of writes) {
            fs.rmSync(`${w.file}.p13-tmp`, { force: true });
        }
        console.error(unrestored === 0 ? `P13 ${mode}: all ${journal.length} written file(s) restored; nothing changed` : `P13 ${mode}: ${unrestored} file(s) NOT restored`);
        process.exit(1);
    }
}

if (mode === 'apply') {
    // Modules first, then the targets (index.js last): no patched file ever
    // imports a module that is not in place.
    commit([...moduleWrites, ...targetWrites], []);
}
else if (mode === 'rollback') {
    // Un-patch the importers first, then remove the modules.
    commit(rollbackWrites, rollbackRemovals);
}
note({ check: 'check OK: all P13 edits present', rollback: 'P13 rollback OK' }[mode] || 'P13 apply OK');
NODE
node "$WORK/p13-patcher.mjs" "$MODE" "$PKG" "$WORK" "$PATCHES_DIR"
