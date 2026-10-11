#!/usr/bin/env bash
# P14 (WO-N5a, 2026-10-10): live-stream delivery gaps - MASTER M-111 (B-F10/IE-14)
# and M-123 (IE-13 S18 / IF-25).
# Usage:
#   apply.d/p14.sh [TARGET_ROOT]             apply (idempotent; completes a partial apply)
#   apply.d/p14.sh --check [TARGET_ROOT]     verify every P14 edit; exit 1 if any is missing
#   apply.d/p14.sh --rollback [TARGET_ROOT]  reverse every P14 edit in place (byte-identical to pre-P14)
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (default: install root above patches/).
# Apply order: apply.sh (P0-P9r), then apply.d/p10.sh .. p14.sh. P14 needs P13 (its re-subscribe
# refresh helper) and P10 (the self-driven run hook) and refuses to run without them. It edits only
# the two websocket service files P13 already touches. Rollback order is the reverse: p14.sh
# --rollback BEFORE p13.sh --rollback (p13.sh refuses while P14 is present).
#   (1) M-123 root cause: a run's live audience was seeded with ONLY the socket that
#       started it; attachConnection() fires on subscribe-while-processing, so a socket
#       that subscribed while the session was idle (a second tab, a second device) never
#       joined the next run and froze for the whole turn. chat.subscribe now registers
#       idle subscribers as watchers (closed sockets are pruned and removed on close),
#       and every run start (interactive + P10 self-driven) attaches the waiting watchers
#       before its first event.
#   (2) M-111 residual: a re-subscribe while the run is still processing replayed the
#       bounded event buffer (5000) without its oldest events once a long streaming run
#       overflowed it, so the client rendered a stream starting mid-message - and the
#       stock client ignores a session_upserted refresh while the session is processing
#       (it only re-reads history on `complete`). The buffer now MERGES adjacent
#       stream_delta events (never across stream_end; each merged event keeps its
#       per-seq text offsets) before it drops anything, and replay sends exactly the text
#       after the client's lastSeq, as ordinary stream_delta frames the stock client
#       appends mid-run. Only a gap the merged buffer still cannot bridge (over 5000
#       non-delta events, or a merged text over 4 MiB) gets the P13 refresh frame, which
#       the client applies at `complete`.
#   (3) B-F10 evidence gap: the chat socket close handler logged no close code, so the
#       55-disconnect spike could not be classified from journalctl alone. The handler
#       now logs the code and a truncated reason with control characters stripped.
# All-or-nothing: every anchor is counted (each edit must match its expected count) and both
# files pass `node --check` BEFORE the first write or backup; the two files are then written
# via temp file + rename, and a failure mid-way restores the first file. Each patched file
# keeps a .bak-pre-p14 copy. P14_TEST_FAIL_BEFORE=<path suffix> is a test-only fault hook.
# Tests: test/p14-stream.test.mjs (negative control: P14_NEGATIVE_CONTROL=1) and the P13/P14
# rollback chain in test/d4-p13-atomic.test.mjs.
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
cat > "$WORK/p14-patcher.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [mode, pkg, work] = process.argv.slice(2);
const note = (msg) => console.log(`[${mode}] ${msg}`);
let problems = 0;
const fail = (msg) => { console.error(`P14 ${{ check: 'MISSING', rollback: 'ROLLBACK FAILED' }[mode] || 'PATCH FAILED'}: ${msg}`); problems += 1; };
const WS = path.join(pkg, 'dist-server', 'server', 'modules', 'websocket', 'services');
const REGISTRY = path.join(WS, 'chat-run-registry.service.js');
const CHAT = path.join(WS, 'chat-websocket.service.js');
const count = (src, needle) => src.split(needle).length - 1;

function nodeCheck(text, label) {
    const probe = path.join(work, `check-${label}.mjs`);
    fs.writeFileSync(probe, text);
    const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
    return r.status === 0 ? null : (r.stderr || '').split('\n').slice(0, 4).join(' | ');
}

// ---------------------------------------------------------- (1)+(2) registry
const REGISTRY_EDITS = [
    {
        why: 'WS_OPEN_STATE import',
        find: "import { broadcastSessionUpserted } from '../../../modules/websocket/services/session-upsert-broadcast.service.js';",
        replace: "import { broadcastSessionUpserted } from '../../../modules/websocket/services/session-upsert-broadcast.service.js';\nimport { WS_OPEN_STATE } from '../../../modules/websocket/services/websocket-state.service.js';",
    },
    {
        why: 'watcher store + attach helper + stream-delta merge helpers',
        find: 'const runs = new Map();',
        replace: `const runs = new Map();
// P14 (M-123): sockets that subscribed while the session was idle. A run's live
// audience used to be seeded with only the socket that STARTED the run, so a
// second tab (or device) that already had the session open never joined the next
// run and froze until it completed. Idle subscribers wait here and are attached
// to the writer when the run starts.
const p14Watchers = new Map();
const P14_MAX_WATCHERS_PER_SESSION = 256;
const p14CloseHooked = new WeakSet();
function p14AttachWatchers(run) {
    const waiting = p14Watchers.get(run.appSessionId);
    if (!waiting) {
        return;
    }
    p14Watchers.delete(run.appSessionId);
    for (const connection of waiting) {
        if (connection.readyState === WS_OPEN_STATE) {
            run.writer.updateWebSocket(connection);
        }
    }
}
function p14ForgetWatcher(connection) {
    for (const [appSessionId, waiting] of p14Watchers) {
        waiting.delete(connection);
        if (waiting.size === 0) {
            p14Watchers.delete(appSessionId);
        }
    }
}
// P14 (M-111): when the replay buffer overflows, adjacent stream_delta events are
// merged (never across stream_end) before anything is dropped. A merged event
// keeps [seq, textOffset] per original delta, so a replay sends exactly the text
// after the client's lastSeq; the stock client appends stream_delta frames even
// while the session is processing (it ignores a session_upserted refresh then).
const P14_MAX_MERGED_CHARS = 4 * 1024 * 1024;
function p14Mergeable(event) {
    return Boolean(event) && event.kind === 'stream_delta' && typeof event.content === 'string' && typeof event.seq === 'number';
}
function p14CompactEvents(run) {
    const merged = [];
    for (const event of run.events) {
        let prev = merged[merged.length - 1];
        if (p14Mergeable(event) && p14Mergeable(prev) && prev.content.length + event.content.length <= P14_MAX_MERGED_CHARS) {
            if (!Array.isArray(prev.p14Segments)) {
                prev = { ...prev, p14Segments: [[prev.seq, 0]] };
                merged[merged.length - 1] = prev;
            }
            prev.p14Segments.push([event.seq, prev.content.length]);
            prev.content += event.content;
            prev.seq = event.seq;
            continue;
        }
        merged.push(event);
    }
    if (merged.length > MAX_BUFFERED_EVENTS_PER_RUN) {
        merged.splice(0, merged.length - MAX_BUFFERED_EVENTS_PER_RUN);
    }
    run.events.length = 0;
    for (const event of merged) {
        run.events.push(event);
    }
}
function p14ReplayView(event, afterSeq) {
    if (!Array.isArray(event.p14Segments)) {
        return event;
    }
    const { p14Segments, ...frame } = event;
    const from = p14Segments.find(([seq]) => seq > afterSeq);
    if (from && from[1] > 0) {
        frame.content = event.content.slice(from[1]);
    }
    return frame;
}`,
    },
    {
        why: 'registerWatcher method',
        find: `    isProcessing(appSessionId) {
        return runs.get(appSessionId)?.status === 'running';
    },
`,
        replace: `    isProcessing(appSessionId) {
        return runs.get(appSessionId)?.status === 'running';
    },
    /**
     * P14 (M-123): remembers a socket that asked to watch a session that has no
     * run yet. startRun/openSelfDrivenRun attach the waiting sockets to the new
     * run's writer, so every open viewer streams from the first event. Sockets
     * that are no longer open are pruned before the cap check, and a socket is
     * forgotten as soon as it closes.
     */
    registerWatcher(appSessionId, connection) {
        if (!connection || connection.readyState !== WS_OPEN_STATE) {
            return;
        }
        let waiting = p14Watchers.get(appSessionId);
        if (!waiting) {
            waiting = new Set();
            p14Watchers.set(appSessionId, waiting);
        }
        for (const other of waiting) {
            if (other.readyState !== WS_OPEN_STATE) {
                waiting.delete(other);
            }
        }
        if (!waiting.has(connection) && waiting.size >= P14_MAX_WATCHERS_PER_SESSION) {
            return;
        }
        if (!p14CloseHooked.has(connection) && typeof connection.once === 'function') {
            p14CloseHooked.add(connection);
            connection.once('close', () => p14ForgetWatcher(connection));
        }
        waiting.add(connection);
    },
`,
    },
    {
        why: 'run-start watcher attach (startRun + openSelfDrivenRun)',
        count: 2,
        find: '        p10AttachSelfDrivenHook(run);\n        runs.set(input.appSessionId, run);',
        replace: '        p14AttachWatchers(run);\n        p10AttachSelfDrivenHook(run);\n        runs.set(input.appSessionId, run);',
    },
    {
        why: 'merge stream deltas before dropping buffered events',
        find: `    run.events.push(outbound);
    if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
        run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
    }
`,
        replace: `    run.events.push(outbound);
    if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
        // P14 (M-111): merge adjacent stream deltas first; drop only what is left over.
        p14CompactEvents(run);
    }
`,
    },
    {
        why: 'replay slices merged deltas at the client lastSeq',
        find: "        return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);\n",
        replace: "        return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq).map((event) => p14ReplayView(event, afterSeq));\n",
    },
];

// ---------------------------------------------------------- (2)+(3) chat socket
const CHAT_EDITS = [
    {
        why: 'idle-subscriber watcher registration',
        find: `        if (isProcessing) {
            chatRunRegistry.attachConnection(sessionId, ws);
        }
`,
        replace: `        if (isProcessing) {
            chatRunRegistry.attachConnection(sessionId, ws);
        }
        else {
            // P14 (M-123): while nothing is running, remember the socket so the
            // NEXT run of this session streams to it from the first event. Only
            // a run already in flight attached sockets, so a second tab (or
            // device) that already had the session open froze for the whole turn.
            if (typeof chatRunRegistry.registerWatcher === 'function') {
                chatRunRegistry.registerWatcher(sessionId, ws);
            }
        }
`,
    },
    {
        why: 'truncated-gap refresh',
        find: `        // P13: the run ended while this socket was detached and the client did not
        // see its last event -> ask the client to refetch the history.
`,
        replace: `        // P14 (M-111/B-F10 residual): the run is still processing but even the
        // merged replay buffer cannot bridge this client's gap (its oldest event,
        // merged deltas counted from their FIRST seq, is newer than lastSeq + 1), so
        // the replay below starts mid-run. Send the refresh frame the completed-run
        // path uses; the stock client applies it once the run completes. A run object
        // without an events array (older registries) fails open: no refresh.
        const p14Oldest = run && Array.isArray(run.events) && run.events[0]
            ? (Array.isArray(run.events[0].p14Segments) ? run.events[0].p14Segments[0][0] : run.events[0].seq)
            : undefined;
        if (isProcessing && lastSeq > 0 && run && Array.isArray(run.events)
            && (typeof run.lastSeq === 'number' ? run.lastSeq : 0) > lastSeq
            && (run.events.length === 0 || (typeof p14Oldest === 'number' && p14Oldest > lastSeq + 1))) {
            void p13RefreshAfterResubscribe(ws, sessionId);
        }
        // P13: the run ended while this socket was detached and the client did not
        // see its last event -> ask the client to refetch the history.
`,
    },
    {
        why: 'close-code logging',
        find: `    ws.on('close', () => {
        console.log('[INFO] Chat client disconnected');
        connectedClients.delete(ws);
    });`,
        replace: `    ws.on('close', (code, reason) => {
        // P14 (B-F10): close codes were previously invisible, so a disconnect
        // spike could only be counted, never classified. The client-chosen reason
        // is cut to 120 chars with control characters (CR/LF included) replaced,
        // so it cannot forge or split journal lines.
        const p14Raw = typeof reason === 'string' ? reason : reason?.toString?.() ?? '';
        const p14Reason = p14Raw.replace(/[\\x00-\\x1f\\x7f\\u2028\\u2029]+/g, ' ').slice(0, 120);
        console.log(\`[INFO] Chat client disconnected code=\${Number.isFinite(code) ? code : '-'} reason=\${p14Reason || '-'}\`);
        connectedClients.delete(ws);
    });`,
    },
];

const FILES = [
    { file: REGISTRY, label: 'registry', marker: 'P14 (M-123): sockets that subscribed while the session was idle', edits: REGISTRY_EDITS },
    { file: CHAT, label: 'chat-websocket', marker: 'P14 (M-123): while nothing is running, remember the socket', edits: CHAT_EDITS },
];

// Plan every file before touching any: nothing is backed up or written unless
// every anchor matches its expected count and every result passes node --check.
const writes = [];
if (mode !== 'rollback') {
    const chatSrc = fs.existsSync(CHAT) ? fs.readFileSync(CHAT, 'utf8') : '';
    if (!chatSrc.includes('async function p13RefreshAfterResubscribe(')) {
        fail('P13 is not applied (no p13RefreshAfterResubscribe in chat-websocket.service.js); run apply.d/p13.sh first');
    }
}
for (const target of FILES) {
    if (!fs.existsSync(target.file)) {
        fail(`${target.label}: file not found`);
        continue;
    }
    const src = fs.readFileSync(target.file, 'utf8');
    const applied = src.includes(target.marker);
    if (mode === 'rollback') {
        if (!applied) {
            note(`P14 not present: ${target.label}`);
            continue;
        }
        let out = src;
        let ok = true;
        for (const edit of [...target.edits].reverse()) {
            const hits = count(out, edit.replace);
            if (hits !== (edit.count ?? 1)) {
                fail(`${target.label}: patched text for ${edit.why} matched ${hits}x (want ${edit.count ?? 1}); restore ${target.file}.bak-pre-p14 by hand`);
                ok = false;
                break;
            }
            out = out.split(edit.replace).join(edit.find);
        }
        if (!ok) {
            continue;
        }
        if (/P14 \(|p14[A-Z]/.test(out)) {
            fail(`${target.label}: P14 text still present after the reversal`);
            continue;
        }
        const err = nodeCheck(out, target.label);
        if (err) {
            fail(`${target.label}: rolled-back source fails node --check: ${err}`);
            continue;
        }
        writes.push({ file: target.file, content: out, done: `P14 rolled back: ${target.file}` });
        continue;
    }
    if (applied) {
        for (const edit of target.edits) {
            if (count(src, edit.replace) !== (edit.count ?? 1)) {
                fail(`${target.label}: ${edit.why}`);
            }
        }
        continue;
    }
    if (mode === 'check') {
        fail(`${target.label}: marker absent`);
        continue;
    }
    let out = src;
    let ok = true;
    for (const edit of target.edits) {
        const hits = count(src, edit.find);
        if (hits !== (edit.count ?? 1)) {
            fail(`${target.label}: anchor for ${edit.why} matched ${hits}x (want ${edit.count ?? 1})`);
            ok = false;
        }
    }
    if (!ok) {
        continue;
    }
    for (const edit of target.edits) {
        out = out.split(edit.find).join(edit.replace);
    }
    const err = nodeCheck(out, target.label);
    if (err) {
        fail(`${target.label}: patched source fails node --check: ${err}`);
        continue;
    }
    writes.push({ file: target.file, content: out, bak: `${target.file}.bak-pre-p14`, done: `P14 patched: ${target.file}` });
}

if (problems > 0) {
    console.error({ check: `P14 check: ${problems} problem(s)`, rollback: `P14 rollback FAILED: ${problems} problem(s); nothing was changed` }[mode] || `P14 apply FAILED: ${problems} problem(s); nothing was written`);
    process.exit(1);
}

// Commit: temp file + rename per file; a failure restores every file already written.
const FAULT = process.env.P14_TEST_FAIL_BEFORE || '';
const journal = [];
try {
    for (const w of writes) {
        if (FAULT && w.file.endsWith(FAULT)) {
            throw new Error(`test fault before writing ${path.basename(w.file)}`);
        }
        const prev = fs.readFileSync(w.file);
        const prevMode = fs.statSync(w.file).mode & 0o7777;
        if (w.bak && !fs.existsSync(w.bak)) {
            fs.copyFileSync(w.file, w.bak);
        }
        journal.push({ file: w.file, prev, prevMode });
        const tmp = `${w.file}.p14-tmp`;
        fs.writeFileSync(tmp, w.content);
        fs.chmodSync(tmp, prevMode);
        fs.renameSync(tmp, w.file);
        note(w.done);
    }
}
catch (error) {
    console.error(`P14 ${mode} FAILED while writing: ${error.message}; restoring ${journal.length} file(s)`);
    let unrestored = 0;
    for (const entry of journal.reverse()) {
        try {
            const tmp = `${entry.file}.p14-restore`;
            fs.writeFileSync(tmp, entry.prev);
            fs.chmodSync(tmp, entry.prevMode);
            fs.renameSync(tmp, entry.file);
        }
        catch (restoreError) {
            unrestored += 1;
            console.error(`P14 RESTORE FAILED for ${entry.file}: ${restoreError.message}`);
        }
    }
    for (const w of writes) {
        fs.rmSync(`${w.file}.p14-tmp`, { force: true });
    }
    console.error(unrestored === 0 ? `P14 ${mode}: all ${journal.length} written file(s) restored; nothing changed` : `P14 ${mode}: ${unrestored} file(s) NOT restored`);
    process.exit(1);
}
if (writes.length === 0) {
    note({ check: 'check OK: all P14 edits present', rollback: 'P14 rollback: nothing to do' }[mode] || 'P14 already applied');
}
NODE
node "$WORK/p14-patcher.mjs" "$MODE" "$PKG" "$WORK"
