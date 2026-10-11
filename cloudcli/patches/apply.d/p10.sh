#!/usr/bin/env bash
# P10 provider lifecycle for @cloudcli-ai/cloudcli 1.37.3 (WO-1; C1/C2/C3, B-F2/B-F5, R3/R4/R7, GAP-1/2/3/10).
# Usage:
#   apply.d/p10.sh [TARGET_ROOT]          apply (idempotent; completes a partial apply)
#   apply.d/p10.sh --check [TARGET_ROOT]  verify every P10 edit, change nothing; exit 1 if any is missing
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (default: install root above patches/).
# Runs after apply.sh (anchors on P9/P9r lines); disjoint from apply.d/p11.sh (sessions/dispatcher)
# and apply.d/p12.sh (auth/origin/permission-response), so the order among them does not matter.
# APPLY_P10=0 skips the apply (check mode still verifies).
# Edits:
#   - patches/files/claude-prompt-queue.js copied into both provider dirs.
#   - claude-runtime.provider.js (dist-server + server): R3 timers, R4 in-place
#     model/mode/effort, req 2 wait-for-old-exit, req 3/GAP-2 failed push never spawns
#     beside a live entry, req 4 abort = current turn only (entry kept), req 1/GAP-3
#     self-driven turns open a registry run, req 7 content fingerprint, req 8
#     ede_diagnostic after our own interrupt = cancel, req 9/GAP-1 spawn guard, req 10
#     runtime-state file, GAP-10 first-turn abort keeps the process. F6b: the failed-push
#     retry backs off 50 ms -> 1 s and retries only transient busy/lock errors (a permanent
#     error fails the turn at once with its real cause); the spawn wait outlives the retire
#     backstop by a 1 s grace.
#   - chat-run-registry.service.js(.ts): openSelfDrivenRun() + per-writer hook.
#   - chat-websocket.service.js is NOT touched (Stop reaches self-driven runs through the
#     registry; p12.sh owns that file's anchors).
# Every modified file keeps a one-time <file>.bak-pre-p10 copy; writes are atomic and patched
# dist JS must pass node --check before it replaces the original.
set -euo pipefail
MODE=apply
if [ "${1:-}" = "--check" ]; then MODE=check; shift; fi
if [ "$MODE" = "apply" ] && [ "${APPLY_P10:-1}" = "0" ]; then echo "P10 skipped (APPLY_P10=0)"; exit 0; fi
PATCHES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then cd "$1"; else cd "$PATCHES_DIR/.."; fi
PKG="node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found under $(pwd)" >&2; exit 1; }
CANONICAL="$PATCHES_DIR/files/claude-prompt-queue.js"
[ -f "$CANONICAL" ] || { echo "FATAL: $CANONICAL not found" >&2; exit 1; }
WORK_DIR="$(mktemp -d "${TMPDIR:-/var/tmp}/p10.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

node - "$MODE" "$PKG" "$CANONICAL" "$WORK_DIR" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [mode, pkg, canonicalPath, workDir] = process.argv.slice(2);
const checkOnly = mode === 'check';
let failures = 0;
let checkSeq = 0;

function note(message) {
    console.log(`[${mode}] ${message}`);
}
function missing(message) {
    console.error(`[${mode}] MISSING: ${message}`);
    failures += 1;
}
function fatal(message) {
    console.error(`P10 PATCH FAILED: ${message}`);
    process.exit(1);
}
function nodeCheck(content, label) {
    checkSeq += 1;
    const target = path.join(workDir, `${checkSeq}-${path.basename(label)}.check.mjs`);
    fs.writeFileSync(target, content);
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (result.status !== 0) {
        return `node --check failed for ${label}: ${(result.stderr || '').trim().split('\n').slice(0, 4).join(' | ')}`;
    }
    return null;
}
function atomicWrite(file, content) {
    const fileMode = fs.statSync(file).mode & 0o7777;
    const backup = `${file}.bak-pre-p10`;
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(file, backup);
    }
    const temp = `${file}.p10tmp-${process.pid}`;
    fs.writeFileSync(temp, content);
    fs.chmodSync(temp, fileMode);
    fs.renameSync(temp, file);
}

// Trimmed-line block engine: dist (4-space) and server (2-space) share anchors
// once whitespace is trimmed; inserted blocks take the anchor line's indent.
function findBlock(lines, seq) {
    const hits = [];
    for (let i = 0; i <= lines.length - seq.length; i += 1) {
        let ok = true;
        for (let j = 0; j < seq.length; j += 1) {
            if (lines[i + j].trim() !== seq[j].trim()) {
                ok = false;
                break;
            }
        }
        if (ok) {
            hits.push(i);
        }
    }
    return hits;
}
function indentOf(line) {
    return (/^[ \t]*/.exec(line) || [''])[0];
}
function reindent(block, indent) {
    return block.map((line) => (line.trim() === '' ? '' : indent + line));
}
function uniqueHit(lines, seq, label) {
    const hits = findBlock(lines, seq);
    if (hits.length !== 1) {
        throw new Error(`${label}: anchor found ${hits.length} times (expected 1): ${JSON.stringify(seq[0].slice(0, 70))}`);
    }
    return hits[0];
}
function replaceBlock(source, oldSeq, newBlock, label) {
    const lines = source.split('\n');
    const at = uniqueHit(lines, oldSeq, label);
    const out = reindent(newBlock, indentOf(lines[at]));
    return [...lines.slice(0, at), ...out, ...lines.slice(at + oldSeq.length)].join('\n');
}
function insertBefore(source, anchorSeq, newBlock, label) {
    const lines = source.split('\n');
    const at = uniqueHit(lines, anchorSeq, label);
    const out = reindent(newBlock, indentOf(lines[at]));
    return [...lines.slice(0, at), ...out, ...lines.slice(at)].join('\n');
}
function insertAfter(source, anchorSeq, newBlock, label) {
    const lines = source.split('\n');
    const at = uniqueHit(lines, anchorSeq, label);
    const out = reindent(newBlock, indentOf(lines[at]));
    return [...lines.slice(0, at + anchorSeq.length), ...out, ...lines.slice(at + anchorSeq.length)].join('\n');
}
// Replaces [start anchor .. line before end anchor] (whole top-level function).
function replaceRange(source, startSeq, endSeq, newBlock, label) {
    const lines = source.split('\n');
    const from = uniqueHit(lines, startSeq, `${label} start`);
    const to = uniqueHit(lines, endSeq, `${label} end`);
    if (to <= from) {
        throw new Error(`${label}: end anchor precedes start anchor`);
    }
    return [...lines.slice(0, from), ...newBlock, ...lines.slice(to)].join('\n');
}

const DIST = path.join(pkg, 'dist-server', 'server');
const SRC = path.join(pkg, 'server');
const CLAUDE_REL = ['modules', 'providers', 'list', 'claude'];

// --- A. claude-prompt-queue.js --------------------------------------------------
const canonical = fs.readFileSync(canonicalPath);
const canonicalError = nodeCheck(canonical, 'files/claude-prompt-queue.js');
if (canonicalError) {
    fatal(canonicalError);
}
for (const [root, required] of [[DIST, true], [SRC, false]]) {
    const dir = path.join(root, ...CLAUDE_REL);
    if (!fs.existsSync(dir)) {
        if (required) {
            checkOnly ? missing(`P10 ${dir} (claude provider dir)`) : fatal(`${dir} not found`);
        }
        continue;
    }
    const target = path.join(dir, 'claude-prompt-queue.js');
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current && Buffer.compare(current, canonical) === 0) {
        note(`P10 ${checkOnly ? 'ok' : 'already current'}: ${target}`);
        continue;
    }
    if (checkOnly) {
        missing(`P10 ${target} differs from patches/files/claude-prompt-queue.js`);
        continue;
    }
    if (current) {
        atomicWrite(target, canonical);
    }
    else {
        fs.writeFileSync(target, canonical);
    }
    note(`P10 copied: ${target}`);
}

// --- B. claude-runtime.provider.js ----------------------------------------------
const IMPORT_ANCHOR = ["import { createPushablePromptStream, computeSpawnFingerprint } from './claude-prompt-queue.js';"];
const IMPORT_NEW = [
    "import { createPushablePromptStream, computeSpawnFingerprint, computeContentFingerprint as p10ComputeContentFingerprint } from './claude-prompt-queue.js';",
    '// P10: synchronous fs for the runtime-state file and ~/.claude/sessions markers',
    '// (the provider\'s own `fs` binding is fs.promises).',
    "import p10fs from 'fs';",
];

const BG_DECL = ['const BG_WAIT_CEILING_MS = parseInt(process.env.CLOUDCLI_BG_WAIT_CEILING_MS, 10) || 30 * 60 * 1000;'];
const BG_DECL_NEW = [
    'const BG_WAIT_CEILING_MS = parseInt(process.env.CLOUDCLI_BG_WAIT_CEILING_MS, 10) || 30 * 60 * 1000;',
    '// P10 (R3): three separate bounds. IDLE_HOLD_MS reaps an idle-held process with',
    '// nothing outstanding (default 30 min). RETIRE_BACKSTOP_MS (default 5 min)',
    '// bounds a retiring turn that never ends and how long a spawn waits for a',
    '// live process on the same session before it is refused with',
    '// session_busy_external. BG_WAIT_CEILING_MS is ONLY the silence ceiling for',
    '// background-work holds and the CLI env (24 h live); the idle hold never',
    '// runs on it.',
    'const IDLE_HOLD_MS = Math.max(0, parseInt(process.env.CLOUDCLI_IDLE_HOLD_MS, 10) || 30 * 60 * 1000);',
    'const RETIRE_BACKSTOP_MS = Math.max(0, parseInt(process.env.CLOUDCLI_RETIRE_BACKSTOP_MS, 10) || 5 * 60 * 1000);',
];

const WAIT_DECLS_V1 = [
    '// Spawns currently waiting for a live process on their session to exit, and',
    '// the sessions whose waiting spawn was cancelled by Stop.',
    'const p10WaitingSpawns = new Map();',
    'const p10AbortedSpawns = new Set();',
];
// D4: every wait of a turn on its session (a spawn waiting for a live process,
// a failed push retrying) registers here; Stop cancels ALL of that session's
// waiters at once and wakes them, and a process exit wakes them to re-check.
const WAIT_DECLS_V2 = [
    '// P10 + D4: turns waiting on their session (spawn waits, push retries), per',
    '// app session id. Stop marks every one of them aborted and wakes it; the',
    '// own process exit wakes them to re-check. Waits back off 50 ms -> 1 s.',
    'const p10Waiters = new Map();',
    'const P10_WAIT_MIN_MS = 50;',
    'const P10_WAIT_MAX_MS = 1000;',
    'function p10EnterWait(key) {',
    '    const waiter = { aborted: false, wake: null };',
    '    if (key) {',
    '        if (!p10Waiters.has(key)) {',
    '            p10Waiters.set(key, new Set());',
    '        }',
    '        p10Waiters.get(key).add(waiter);',
    '    }',
    '    return waiter;',
    '}',
    'function p10LeaveWait(key, waiter) {',
    '    const set = key ? p10Waiters.get(key) : null;',
    '    if (set) {',
    '        set.delete(waiter);',
    '        if (set.size === 0) {',
    '            p10Waiters.delete(key);',
    '        }',
    '    }',
    '}',
    'function p10WakeWaiters(key) {',
    '    for (const waiter of Array.from(p10Waiters.get(key) || [])) {',
    '        waiter.wake?.();',
    '    }',
    '}',
    '// Stop: cancel every waiter of the session; true when one was waiting.',
    'function p10CancelWaiters(key) {',
    '    const set = key ? p10Waiters.get(key) : null;',
    '    if (!set || set.size === 0) {',
    '        return false;',
    '    }',
    '    for (const waiter of set) {',
    '        waiter.aborted = true;',
    '    }',
    '    p10WakeWaiters(key);',
    '    return true;',
    '}',
    '// A pause that Stop or the own process exit cuts short.',
    'function p10WaitPause(waiter, ms) {',
    '    return new Promise((resolve) => {',
    '        const timer = setTimeout(done, Math.max(1, ms));',
    '        function done() {',
    '            clearTimeout(timer);',
    '            waiter.wake = null;',
    '            resolve();',
    '        }',
    '        waiter.wake = done;',
    '    });',
    '}',
    'function p10AbortedError(message) {',
    '    const aborted = new Error(message);',
    "    aborted.code = 'aborted';",
    '    return aborted;',
    '}',
];
// F6b: what a failed push may retry. Inserted right after p10AbortedError, so
// fresh trees (HELPERS) and upgraded P10 v1 / D4 trees get the same layout.
const P10_ABORTED_FN = WAIT_DECLS_V2.slice(-5);
const PUSH_RETRY_DECLS = [
    '// F6b: a failed push is retried only while its cause is TRANSIENT: the live',
    '// run raced a turn boundary (P9 "no longer pushable") or a busy / lock errno.',
    '// Anything else (a prompt that cannot be built, a bug) is permanent: the turn',
    '// fails at once with that error - never retried until the backstop, never',
    '// reported as session_busy_external.',
    "const P10_TRANSIENT_PUSH_CODES = new Set(['EBUSY', 'EAGAIN', 'EWOULDBLOCK', 'ETXTBSY', 'ENOLCK', 'EDEADLK', 'ELOCKED']);",
    'function p10IsTransientPushError(error) {',
    "    if (typeof error?.code === 'string' && P10_TRANSIENT_PUSH_CODES.has(error.code)) {",
    '        return true;',
    '    }',
    "    return typeof error?.message === 'string' && error.message.startsWith('P9: live run is no longer pushable');",
    '}',
];
const WAIT_FN_V1 = [
    '// P10 req 2 + req 9 (GAP-1): before ANY spawn, wait until no live process',
    '// holds the session: our own map entry (a retiring run) and any EXTERNAL',
    '// live CLI marker on the provider session id. Dead pids and malformed',
    '// markers never block. Bounded by RETIRE_BACKSTOP_MS, then refused with',
    '// session_busy_external - never a second live process. Stop cancels the wait.',
    'async function p10WaitForSessionFree(key, providerSessionId, ownInstance) {',
    '    const deadline = Date.now() + RETIRE_BACKSTOP_MS;',
    '    if (key) {',
    '        p10WaitingSpawns.set(key, (p10WaitingSpawns.get(key) || 0) + 1);',
    '    }',
    '    try {',
    '        for (;;) {',
    '            const own = key ? getSession(key) : null;',
    '            const ownLive = Boolean(own && own.instance && (!ownInstance || own.instance === ownInstance));',
    '            const externalPid = p10ResolveCliPid(providerSessionId);',
    '            if (!ownLive && !externalPid) {',
    '                return;',
    '            }',
    '            if (key && p10AbortedSpawns.delete(key)) {',
    "                const aborted = new Error('aborted while waiting for the live process to exit');",
    "                aborted.code = 'aborted';",
    '                throw aborted;',
    '            }',
    '            if (Date.now() >= deadline) {',
    '                const busy = new Error(`session_busy_external: a live Claude process (${ownLive ? \'this server\' : `pid ${externalPid}`}) still holds session ${providerSessionId || key}; not spawning a second one`);',
    "                busy.code = 'session_busy_external';",
    '                throw busy;',
    '            }',
    '            await new Promise((resolve) => setTimeout(resolve, 50));',
    '        }',
    '    }',
    '    finally {',
    '        if (key) {',
    '            const left = (p10WaitingSpawns.get(key) || 1) - 1;',
    '            if (left > 0) {',
    '                p10WaitingSpawns.set(key, left);',
    '            }',
    '            else {',
    '                p10WaitingSpawns.delete(key);',
    '                p10AbortedSpawns.delete(key);',
    '            }',
    '        }',
    '    }',
    '}',
];
const WAIT_FN_V2 = [
    '// P10 req 2 + req 9 (GAP-1): before ANY spawn, wait until no live process',
    '// holds the session: our own map entry (a retiring run) and any EXTERNAL',
    '// live CLI marker on the provider session id. Dead pids and malformed',
    '// markers never block. Bounded by RETIRE_BACKSTOP_MS, then refused with',
    '// session_busy_external - never a second live process. Stop cancels the wait.',
    '// D4: Stop is checked FIRST on every pass (a Stop that lands while the',
    '// session frees up still cancels), and the marker scan backs off 50 ms ->',
    '// 1 s; Stop and the own process exit wake the pause at once.',
    'async function p10WaitForSessionFree(key, providerSessionId, ownInstance) {',
    '    const deadline = Date.now() + RETIRE_BACKSTOP_MS;',
    '    const waiter = p10EnterWait(key);',
    '    let pauseMs = P10_WAIT_MIN_MS;',
    '    try {',
    '        for (;;) {',
    '            if (waiter.aborted) {',
    "                throw p10AbortedError('aborted while waiting for the live process to exit');",
    '            }',
    '            const own = key ? getSession(key) : null;',
    '            const ownLive = Boolean(own && own.instance && (!ownInstance || own.instance === ownInstance));',
    '            const externalPid = p10ResolveCliPid(providerSessionId);',
    '            if (!ownLive && !externalPid) {',
    '                return;',
    '            }',
    '            if (Date.now() >= deadline) {',
    '                const busy = new Error(`session_busy_external: a live Claude process (${ownLive ? \'this server\' : `pid ${externalPid}`}) still holds session ${providerSessionId || key}; not spawning a second one`);',
    "                busy.code = 'session_busy_external';",
    '                throw busy;',
    '            }',
    '            await p10WaitPause(waiter, Math.min(pauseMs, deadline - Date.now()));',
    '            pauseMs = Math.min(pauseMs * 2, P10_WAIT_MAX_MS);',
    '        }',
    '    }',
    '    finally {',
    '        p10LeaveWait(key, waiter);',
    '    }',
    '}',
];
// F6b: WAIT_FN_V2 refused at exactly RETIRE_BACKSTOP_MS, the same moment the
// retire backstop interrupts a stuck turn, so the waiting turn raced the exit.
// The wait now outlives the backstop by a grace margin; still never two live
// processes (it only spawns once the own entry and every live marker are gone).
const WAIT_FN_NEW = [
    '// P10 req 2 + req 9 (GAP-1): before ANY spawn, wait until no live process',
    '// holds the session: our own map entry (a retiring run) and any EXTERNAL',
    '// live CLI marker on the provider session id. Dead pids and malformed',
    '// markers never block. Bounded by RETIRE_BACKSTOP_MS, then refused with',
    '// session_busy_external - never a second live process. Stop cancels the wait.',
    '// D4: Stop is checked FIRST on every pass (a Stop that lands while the',
    '// session frees up still cancels), and the marker scan backs off 50 ms ->',
    '// 1 s; Stop and the own process exit wake the pause at once.',
    '// F6b: the bound is RETIRE_BACKSTOP_MS plus a 1 s grace. The retire backstop',
    '// interrupts a stuck turn at RETIRE_BACKSTOP_MS as well; the grace lets that',
    '// process exit, so the waiting turn spawns once instead of racing a refusal.',
    'const P10_SPAWN_WAIT_GRACE_MS = 1000;',
    'async function p10WaitForSessionFree(key, providerSessionId, ownInstance) {',
    '    const deadline = Date.now() + RETIRE_BACKSTOP_MS + P10_SPAWN_WAIT_GRACE_MS;',
    '    const waiter = p10EnterWait(key);',
    '    let pauseMs = P10_WAIT_MIN_MS;',
    '    try {',
    '        for (;;) {',
    '            if (waiter.aborted) {',
    "                throw p10AbortedError('aborted while waiting for the live process to exit');",
    '            }',
    '            const own = key ? getSession(key) : null;',
    '            const ownLive = Boolean(own && own.instance && (!ownInstance || own.instance === ownInstance));',
    '            const externalPid = p10ResolveCliPid(providerSessionId);',
    '            if (!ownLive && !externalPid) {',
    '                return;',
    '            }',
    '            if (Date.now() >= deadline) {',
    '                const busy = new Error(`session_busy_external: a live Claude process (${ownLive ? \'this server\' : `pid ${externalPid}`}) still holds session ${providerSessionId || key}; not spawning a second one`);',
    "                busy.code = 'session_busy_external';",
    '                throw busy;',
    '            }',
    '            await p10WaitPause(waiter, Math.min(pauseMs, deadline - Date.now()));',
    '            pauseMs = Math.min(pauseMs * 2, P10_WAIT_MAX_MS);',
    '        }',
    '    }',
    '    finally {',
    '        p10LeaveWait(key, waiter);',
    '    }',
    '}',
];
const ADDSESSION_DOC = ['/**', ' * Adds a session to the active sessions map'];
const HELPERS = [
    '// ---- P10 (WO-1) helpers -------------------------------------------------',
    '// Runtime state file (WO-1 interface contract, read by WO-2 dispatcher/Shell',
    '// and WO-5 safe-restart): [{appSessionId, providerSessionId, pid, state,',
    '// since}], state in-turn | bg-work | idle-held | retiring, mode 0600, atomic',
    '// rename. pid is the CLI resolved from the newest LIVE ~/.claude/sessions',
    '// marker for the provider session id, else this server (the CLI\'s parent):',
    '// always an int > 0 that is alive while the entry can be true, so readers',
    '// (p11 busy check, safe-restart) never fail open on a busy session, and a',
    '// stale file left by a dead server reads as not busy.',
    'const p10Sessions = new Map();',
    ...WAIT_DECLS_V2,
    ...PUSH_RETRY_DECLS,
    '// Query instances WE interrupted (Stop, retire backstop): a later',
    '// "[ede_diagnostic]" exit error from them is a cancellation (req 8).',
    'const p10InterruptedInstances = new WeakSet();',
    '// SDK events that START a self-driven main-thread turn while none is in',
    '// flight (task notification follow-up, Monitor / ScheduleWakeup wake-up).',
    '// System chatter such as task_progress never starts a turn.',
    "const SELFDRIVEN_TURN_TYPES = new Set(['assistant', 'user', 'stream_event']);",
    'function p10RuntimeStateFile() {',
    "    return process.env.CLOUDCLI_RUNTIME_STATE || '/run/cloudcli/runtime-state.json';",
    '}',
    'function p10WriteRuntimeState() {',
    '    try {',
    '        const file = p10RuntimeStateFile();',
    '        p10fs.mkdirSync(path.dirname(file), { recursive: true });',
    '        const tmp = `${file}.tmp-${process.pid}`;',
    '        p10fs.writeFileSync(tmp, JSON.stringify(Array.from(p10Sessions.values())), { mode: 0o600 });',
    '        p10fs.chmodSync(tmp, 0o600);',
    '        p10fs.renameSync(tmp, file);',
    '    }',
    '    catch {',
    '        // advisory interface (consumers fail open); never take a run down',
    '    }',
    '}',
    'function p10ProcStart(pid) {',
    '    try {',
    "        const stat = p10fs.readFileSync(`/proc/${pid}/stat`, 'utf8');",
    "        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;",
    '    }',
    '    catch {',
    '        return null;',
    '    }',
    '}',
    '// A marker is live when its pid exists in /proc and, if the marker records',
    '// procStart, that start time still matches (a reused pid is not the CLI).',
    'function p10MarkerLive(marker) {',
    '    const pid = marker?.pid;',
    "    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {",
    '        return false;',
    '    }',
    '    if (!p10fs.existsSync(`/proc/${pid}`)) {',
    '        return false;',
    '    }',
    '    if (marker.procStart !== undefined && marker.procStart !== null) {',
    '        const actual = p10ProcStart(pid);',
    '        if (actual !== null && String(marker.procStart) !== actual) {',
    '            return false;',
    '        }',
    '    }',
    '    return true;',
    '}',
    'function p10ResolveCliPid(providerSessionId) {',
    '    if (!providerSessionId) {',
    '        return null;',
    '    }',
    '    try {',
    "        const dir = path.join(os.homedir(), '.claude', 'sessions');",
    '        let best = null;',
    '        for (const name of p10fs.readdirSync(dir)) {',
    "            if (!name.endsWith('.json')) {",
    '                continue;',
    '            }',
    '            let marker = null;',
    '            let mtime = 0;',
    '            try {',
    '                const file = path.join(dir, name);',
    "                marker = JSON.parse(p10fs.readFileSync(file, 'utf8'));",
    '                mtime = p10fs.statSync(file).mtimeMs;',
    '            }',
    '            catch {',
    '                continue;',
    '            }',
    '            if (!marker || marker.sessionId !== providerSessionId || !p10MarkerLive(marker)) {',
    '                continue;',
    '            }',
    '            if (!best || mtime > best.mtime) {',
    '                best = { pid: marker.pid, mtime };',
    '            }',
    '        }',
    '        return best ? best.pid : null;',
    '    }',
    '    catch {',
    '        return null;',
    '    }',
    '}',
    'function p10SyncRuntimeState(appSessionId, providerSessionId, state) {',
    '    if (!appSessionId) {',
    '        return;',
    '    }',
    '    if (state === null) {',
    '        if (p10Sessions.delete(appSessionId)) {',
    '            p10WriteRuntimeState();',
    '        }',
    '        return;',
    '    }',
    '    p10Sessions.set(appSessionId, {',
    '        appSessionId,',
    '        providerSessionId: providerSessionId || null,',
    '        pid: p10ResolveCliPid(providerSessionId) || process.pid,',
    '        state,',
    '        since: Date.now(),',
    '    });',
    '    p10WriteRuntimeState();',
    '}',
    ...WAIT_FN_NEW,
    'function p10SortedTools(list) {',
    '    return JSON.stringify(Array.from(new Set(list || [])).sort());',
    '}',
    '// P10 req 6: tool lists compare as sorted unique sets of the owner\'s BASE',
    '// tool settings (plan-mode auto tools excluded - mode is applied in place).',
    '// Grants remembered inside this process ("Always allow") are tolerated in',
    '// either direction: the next turn may or may not carry them.',
    'function p10ToolsCompatible(compat, options) {',
    '    const grants = new Set(compat.grants || []);',
    '    const nextAllowed = new Set(options?.toolsSettings?.allowedTools || []);',
    "    const liveAllowed = new Set(JSON.parse(compat.allowedToolsBase || '[]'));",
    '    for (const tool of liveAllowed) {',
    '        if (!nextAllowed.has(tool)) {',
    '            return false;',
    '        }',
    '    }',
    '    for (const tool of nextAllowed) {',
    '        if (!liveAllowed.has(tool) && !grants.has(tool)) {',
    '            return false;',
    '        }',
    '    }',
    '    const nextDisallowed = new Set(options?.toolsSettings?.disallowedTools || []);',
    "    const liveDisallowed = new Set(JSON.parse(compat.disallowedToolsBase || '[]'));",
    '    for (const tool of nextDisallowed) {',
    '        if (!liveDisallowed.has(tool)) {',
    '            return false;',
    '        }',
    '    }',
    '    for (const tool of liveDisallowed) {',
    '        if (!nextDisallowed.has(tool) && !grants.has(tool)) {',
    '            return false;',
    '        }',
    '    }',
    '    return true;',
    '}',
    '// P10 req 6 (R4): model / permission mode / effort applied IN PLACE to the',
    '// live process (setModel / setPermissionMode / applyFlagSettings, all in',
    '// @anthropic-ai/claude-agent-sdk 0.3.291), mirrored onto the live sdkOptions',
    '// that canUseTool reads. Rejects when the live process cannot take them.',
    'async function p10ApplyInPlace(entry, sdkOptions) {',
    '    const compat = entry.compat;',
    '    const live = compat.sdkOptions;',
    '    if (!live) {',
    "        throw new Error('no live sdkOptions handle');",
    '    }',
    '    if (compat.model !== sdkOptions.model) {',
    '        await entry.instance.setModel(sdkOptions.model);',
    '        live.model = sdkOptions.model;',
    '    }',
    '    if ((compat.permissionMode ?? null) !== (sdkOptions.permissionMode ?? null)) {',
    "        await entry.instance.setPermissionMode(sdkOptions.permissionMode || 'default');",
    '        live.permissionMode = sdkOptions.permissionMode;',
    '    }',
    '    const nextUltra = Boolean(sdkOptions.settings?.ultracode);',
    '    if ((compat.effort ?? null) !== (sdkOptions.effort ?? null) || Boolean(compat.ultracode) !== nextUltra) {',
    '        const flags = { effortLevel: sdkOptions.effort || null };',
    '        if (nextUltra || compat.ultracode) {',
    '            flags.ultracode = nextUltra;',
    '            flags.enableWorkflows = nextUltra;',
    '        }',
    '        await entry.instance.applyFlagSettings(flags);',
    '        live.effort = sdkOptions.effort;',
    '    }',
    '    const grants = compat.grants || [];',
    '    live.allowedTools = Array.from(new Set([...(sdkOptions.allowedTools || []), ...grants]));',
    '    live.disallowedTools = (sdkOptions.disallowedTools || []).filter((tool) => !grants.includes(tool));',
    '    entry.compat = {',
    '        ...compat,',
    '        model: sdkOptions.model,',
    '        permissionMode: sdkOptions.permissionMode ?? null,',
    '        effort: sdkOptions.effort ?? null,',
    '        ultracode: nextUltra,',
    '    };',
    '}',
    '// ---- end P10 helpers -----------------------------------------------------',
];

const ADDSESSION_P10 = ['retire: extras?.retire || carried?.retire || null', '});'];
const ADDSESSION_P10_NEW = [
    'retire: extras?.retire || carried?.retire || null,',
    '    // P10: per-run lifecycle probes (turn in flight) for abort.',
    '    p10: extras?.p10 || carried?.p10 || null',
    '});',
];

const REMOVE_FN = ['function removeSession(sessionId) {', 'activeSessions.delete(sessionId);', '}'];
const REMOVE_FN_V1 = [
    'function removeSession(sessionId) {',
    '    activeSessions.delete(sessionId);',
    '    // P10 req 10: the runtime-state entry dies with the process-map entry.',
    '    p10SyncRuntimeState(sessionId, null, null);',
    '}',
];
const REMOVE_FN_NEW = [
    'function removeSession(sessionId) {',
    '    activeSessions.delete(sessionId);',
    '    // P10 req 10: the runtime-state entry dies with the process-map entry.',
    '    p10SyncRuntimeState(sessionId, null, null);',
    '    // D4: a turn waiting for this process to exit re-checks at once.',
    '    p10WakeWaiters(sessionId);',
    '}',
];

const FP_ANCHOR = ['const settingsFp = await computeSpawnFingerprint(options.cwd, await loadMcpConfig(options.cwd));'];
const FP_NEW = [
    '// P10 req 7: settings fingerprinted by CONTENT (canonical-JSON sha256), so a',
    '// same-content rewrite (touch, sync-claude-config re-save) keeps reuse.',
    'const settingsFp = await p10ComputeContentFingerprint(options.cwd, await loadMcpConfig(options.cwd));',
];

const REUSE_REGION = [
    '&& reuseEntry.compat.model === sdkOptions.model',
    '&& reuseEntry.compat.effort === (sdkOptions.effort ?? null)',
    '&& reuseEntry.compat.permissionMode === (sdkOptions.permissionMode ?? null)',
    '&& reuseEntry.compat.cwd === (sdkOptions.cwd ?? null)',
    '&& reuseEntry.compat.allowedTools === JSON.stringify(sdkOptions.allowedTools || [])',
    '&& reuseEntry.compat.disallowedTools === JSON.stringify(sdkOptions.disallowedTools || [])',
    '&& reuseEntry.compat.settingsFp === settingsFp);',
];
const REUSE_REGION_NEW = [
    '// P10 req 6 (R4): model / permission mode / effort are applied in place',
    '// at the push, so they no longer block reuse; tool lists compare as sets',
    '// (grants tolerated). Still respawn-after-exit: cwd, settings CONTENT /',
    '// MCP set, a tool-set change, edit-resend anchors, a retiring process.',
    '&& reuseEntry.compat.cwd === (sdkOptions.cwd ?? null)',
    '&& reuseEntry.compat.allowedToolsBase !== undefined',
    '&& p10ToolsCompatible(reuseEntry.compat, options)',
    '&& reuseEntry.compat.settingsFp === settingsFp',
    '&& !retiredInstances.has(reuseEntry.instance));',
];

const PUSH_BLOCK = [
    'const reuseMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);',
    'await reuseEntry.beginTurn(reuseMessages, ws);',
    'return;',
];
const PUSH_BLOCK_NEW = [
    '// P10 req 6 (R4): in-place model / mode / effort before the push. If the',
    '// live process cannot take them, fall through to the respawn-after-exit path',
    '// (retire, wait for the full exit, then one spawn) - never two processes.',
    'let p10InPlaceOk = true;',
    'try {',
    '    await p10ApplyInPlace(reuseEntry, sdkOptions);',
    '}',
    'catch (p10InPlaceError) {',
    '    p10InPlaceOk = false;',
    "    console.warn('[Claude SDK] P10 in-place change failed; respawning after the live process exits:', p10InPlaceError?.message || p10InPlaceError);",
    '}',
    'if (p10InPlaceOk) {',
    '    const reuseMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);',
    '    await reuseEntry.beginTurn(reuseMessages, ws);',
    '    return;',
    '}',
];

const PUSHFAIL = [
    'catch (pushError) {',
    '// The live run died between the check and the push; fall through',
    '// to a fresh process, exactly like the old path.',
    "console.warn('[Claude SDK] P9 push failed, spawning instead:', pushError?.message || pushError);",
    '}',
];
const PUSHFAIL_V1 = [
    'catch (pushError) {',
    '    // P10 (GAP-2, the 2026-10-09 22:34 incident): the P9 "push failed,',
    '    // spawning instead" fallback is gone. While ANY entry exists for the',
    '    // session (active, aborted or retiring) a failed push never spawns: the',
    '    // turn waits behind the live process (bounded) and is pushed once it is',
    '    // pushable again; only a really dead process falls through to a spawn.',
    "    if (pushError?.code === 'aborted') {",
    '        // P10 req 4: Stop rejected this waiting turn; never re-push it.',
    '        throw pushError;',
    '    }',
    '    let p10Pushed = false;',
    '    const p10PushDeadline = Date.now() + RETIRE_BACKSTOP_MS;',
    '    while (!p10Pushed && getSession(sessionKey())) {',
    '        const p10Live = getSession(sessionKey());',
    '        if (p10Live.promptQueue && !p10Live.promptQueue.isReleased() && !retiredInstances.has(p10Live.instance) && typeof p10Live.beginTurn === \'function\') {',
    '            try {',
    '                await p10Live.beginTurn(await buildPromptMessages(command, options.images, options.files, options.cwd), ws);',
    '                p10Pushed = true;',
    '                break;',
    '            }',
    '            catch (p10RetryError) {',
    "                if (p10RetryError?.code === 'aborted') {",
    '                    throw p10RetryError;',
    '                }',
    '                // raced another boundary; re-check below',
    '            }',
    '        }',
    '        if (Date.now() >= p10PushDeadline) {',
    "            const p10Busy = new Error('session_busy_external: the live process for this session is not accepting turns; not spawning a second one');",
    "            p10Busy.code = 'session_busy_external';",
    '            throw p10Busy;',
    '        }',
    '        await new Promise((resolve) => setTimeout(resolve, 50));',
    '    }',
    '    if (p10Pushed) {',
    '        return;',
    '    }',
    "    console.warn('[Claude SDK] P9 push failed and the live process is gone; spawning:', pushError?.message || pushError);",
    '}',
];

// D4 push retry (fixed 50 ms pause, every non-Stop error swallowed): the F6b
// upgrade anchor for trees patched before F6b.
const PUSHFAIL_V2 = [
    'catch (pushError) {',
    '    // P10 (GAP-2, the 2026-10-09 22:34 incident): the P9 "push failed,',
    '    // spawning instead" fallback is gone. While ANY entry exists for the',
    '    // session (active, aborted or retiring) a failed push never spawns: the',
    '    // turn waits behind the live process (bounded) and is pushed once it is',
    '    // pushable again; only a really dead process falls through to a spawn.',
    "    if (pushError?.code === 'aborted') {",
    '        // P10 req 4: Stop rejected this waiting turn; never re-push it.',
    '        throw pushError;',
    '    }',
    '    let p10Pushed = false;',
    '    const p10PushDeadline = Date.now() + RETIRE_BACKSTOP_MS;',
    '    // D4: this retry is a waiter too - a Stop while it waits cancels it on the',
    '    // next pass (checked before every push attempt), it is never pushed later.',
    '    const p10PushKey = sessionKey();',
    '    const p10PushWaiter = p10EnterWait(p10PushKey);',
    '    try {',
    '        while (!p10Pushed) {',
    '            if (p10PushWaiter.aborted) {',
    "                throw p10AbortedError('aborted: Stop cancelled this queued turn');",
    '            }',
    '            const p10Live = getSession(sessionKey());',
    '            if (!p10Live) {',
    '                break;',
    '            }',
    "            if (p10Live.promptQueue && !p10Live.promptQueue.isReleased() && !retiredInstances.has(p10Live.instance) && typeof p10Live.beginTurn === 'function') {",
    '                try {',
    '                    const p10Messages = await buildPromptMessages(command, options.images, options.files, options.cwd);',
    '                    if (p10PushWaiter.aborted) {',
    "                        throw p10AbortedError('aborted: Stop cancelled this queued turn');",
    '                    }',
    '                    await p10Live.beginTurn(p10Messages, ws);',
    '                    p10Pushed = true;',
    '                    break;',
    '                }',
    '                catch (p10RetryError) {',
    "                    if (p10RetryError?.code === 'aborted') {",
    '                        throw p10RetryError;',
    '                    }',
    '                    // raced another boundary; re-check below',
    '                }',
    '            }',
    '            if (Date.now() >= p10PushDeadline) {',
    "                const p10Busy = new Error('session_busy_external: the live process for this session is not accepting turns; not spawning a second one');",
    "                p10Busy.code = 'session_busy_external';",
    '                throw p10Busy;',
    '            }',
    '            await p10WaitPause(p10PushWaiter, P10_WAIT_MIN_MS);',
    '        }',
    '    }',
    '    finally {',
    '        p10LeaveWait(p10PushKey, p10PushWaiter);',
    '    }',
    '    if (p10Pushed) {',
    '        return;',
    '    }',
    "    console.warn('[Claude SDK] P9 push failed and the live process is gone; spawning:', pushError?.message || pushError);",
    '}',
];

// F6b: the retry backs off 50 ms -> 1 s (P10_WAIT_MIN_MS -> P10_WAIT_MAX_MS,
// capped by the deadline) instead of a fixed 50 ms loop, retries only a
// transient busy / lock cause, and rethrows a permanent error at once with its
// real cause. Stop is still checked first on every pass.
const PUSHFAIL_NEW = [
    'catch (pushError) {',
    '    // P10 (GAP-2, the 2026-10-09 22:34 incident): the P9 "push failed,',
    '    // spawning instead" fallback is gone. While ANY entry exists for the',
    '    // session (active, aborted or retiring) a failed push never spawns: the',
    '    // turn waits behind the live process (bounded) and is pushed once it is',
    '    // pushable again; only a really dead process falls through to a spawn.',
    "    if (pushError?.code === 'aborted') {",
    '        // P10 req 4: Stop rejected this waiting turn; never re-push it.',
    '        throw pushError;',
    '    }',
    '    // F6b: only a transient busy / lock failure is retried; a permanent one',
    '    // fails the turn now with its real cause.',
    '    if (!p10IsTransientPushError(pushError)) {',
    '        throw pushError;',
    '    }',
    '    let p10Pushed = false;',
    '    const p10PushDeadline = Date.now() + RETIRE_BACKSTOP_MS;',
    '    // D4: this retry is a waiter too - a Stop while it waits cancels it on the',
    '    // next pass (checked before every push attempt), it is never pushed later.',
    '    // F6b: the pause between passes backs off 50 ms -> 1 s.',
    '    const p10PushKey = sessionKey();',
    '    const p10PushWaiter = p10EnterWait(p10PushKey);',
    '    let p10PushPauseMs = P10_WAIT_MIN_MS;',
    '    try {',
    '        while (!p10Pushed) {',
    '            if (p10PushWaiter.aborted) {',
    "                throw p10AbortedError('aborted: Stop cancelled this queued turn');",
    '            }',
    '            const p10Live = getSession(sessionKey());',
    '            if (!p10Live) {',
    '                break;',
    '            }',
    "            if (p10Live.promptQueue && !p10Live.promptQueue.isReleased() && !retiredInstances.has(p10Live.instance) && typeof p10Live.beginTurn === 'function') {",
    '                try {',
    '                    const p10Messages = await buildPromptMessages(command, options.images, options.files, options.cwd);',
    '                    if (p10PushWaiter.aborted) {',
    "                        throw p10AbortedError('aborted: Stop cancelled this queued turn');",
    '                    }',
    '                    await p10Live.beginTurn(p10Messages, ws);',
    '                    p10Pushed = true;',
    '                    break;',
    '                }',
    '                catch (p10RetryError) {',
    "                    if (p10RetryError?.code === 'aborted') {",
    '                        throw p10RetryError;',
    '                    }',
    '                    if (p10PushWaiter.aborted) {',
    "                        throw p10AbortedError('aborted: Stop cancelled this queued turn');",
    '                    }',
    '                    if (!p10IsTransientPushError(p10RetryError)) {',
    '                        throw p10RetryError;',
    '                    }',
    '                    // transient: raced another boundary or a busy / lock; re-check below',
    '                }',
    '            }',
    '            if (Date.now() >= p10PushDeadline) {',
    "                const p10Busy = new Error('session_busy_external: the live process for this session is not accepting turns; not spawning a second one');",
    "                p10Busy.code = 'session_busy_external';",
    '                throw p10Busy;',
    '            }',
    '            await p10WaitPause(p10PushWaiter, Math.min(p10PushPauseMs, p10PushDeadline - Date.now()));',
    '            p10PushPauseMs = Math.min(p10PushPauseMs * 2, P10_WAIT_MAX_MS);',
    '        }',
    '    }',
    '    finally {',
    '        p10LeaveWait(p10PushKey, p10PushWaiter);',
    '    }',
    '    if (p10Pushed) {',
    '        return;',
    '    }',
    "    console.warn('[Claude SDK] P9 push failed and the live process is gone; spawning:', pushError?.message || pushError);",
    '}',
];

const MCPS_ANCHOR = ['const mcpServers = await loadMcpConfig(options.cwd);'];
const RETIRE_WAIT = [
    '// P10 req 2 (R7): a turn that cannot be pushed NEVER spawns beside a live',
    '// process. Retire the old run if nothing retired it yet (in-place failure',
    '// path), then wait for its FULL exit - background work included - and for',
    '// any external CLI on the same session id (GAP-1).',
    "if (reuseEntry && reuseEntry.status === 'active' && reuseEntry.instance && getSession(sessionKey())?.instance === reuseEntry.instance && !retiredInstances.has(reuseEntry.instance)) {",
    "    if (typeof reuseEntry.retire === 'function') {",
    '        retiredInstances.add(reuseEntry.instance);',
    '        try {',
    '            reuseEntry.retire();',
    '        }',
    '        catch (p10RetireError) {',
    "            console.warn('[Claude SDK] P10 retire failed:', p10RetireError?.message || p10RetireError);",
    '        }',
    '    }',
    '}',
    'await p10WaitForSessionFree(sessionKey(), providerSessionId, null);',
];

const COMPAT_TAIL = ['settingsFp', '},', 'beginTurn,', 'retire'];
const COMPAT_TAIL_NEW = [
    'settingsFp,',
    '    // P10 req 6: base tool sets (owner settings, sorted unique), grants made',
    '    // in this process, ultracode, and the LIVE sdkOptions object (canUseTool',
    '    // reads it; in-place changes update it).',
    '    allowedToolsBase: p10SortedTools(options.toolsSettings?.allowedTools),',
    '    disallowedToolsBase: p10SortedTools(options.toolsSettings?.disallowedTools),',
    '    grants: [],',
    '    ultracode: Boolean(sdkOptions.settings?.ultracode),',
    '    sdkOptions',
    '},',
    'beginTurn,',
    'retire,',
    '// P10: abort interrupts only when a turn is actually in flight, and',
    '// rejects pushes still parked at the turn boundary (req 4).',
    'p10: {',
    '    turnInFlight: () => turnInFlight,',
    '    rejectWaiting: () => {',
    '        for (const open of pushGateWaiters.splice(0)) {',
    "            open('p10-aborted');",
    '        }',
    '    }',
    '}',
];

const PUMP_WAIT = ['return ready.then((wasPumped) => {', 'if (wasPumped) {', 'imminentPushes -= 1;', '}'];
const PUMP_WAIT_NEW = [
    'return ready.then((wasPumped) => {',
    "    // P10 req 4: a push still parked when Stop arrived is rejected with an",
    '    // abort reason; it is never delivered after the interrupted turn ends.',
    "    if (wasPumped === 'p10-aborted') {",
    "        const p10WaitAborted = new Error('aborted: Stop rejected this waiting turn');",
    "        p10WaitAborted.code = 'aborted';",
    '        throw p10WaitAborted;',
    '    }',
    '    if (wasPumped) {',
    '        imminentPushes -= 1;',
    '    }',
];

const GRANT_TAIL = [
    'if (Array.isArray(sdkOptions.disallowedTools)) {',
    'sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);',
    '}',
];
const GRANT_TAIL_NEW = [
    'if (Array.isArray(sdkOptions.disallowedTools)) {',
    '    sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);',
    '}',
    '// P10 req 6: the grant is now process state - record it so the next',
    '// same-profile turn (which may carry it in its tool settings) is pushed.',
    'const p10GrantEntry = sessionKey() ? getSession(sessionKey()) : null;',
    'if (p10GrantEntry && p10GrantEntry.instance === queryInstance && p10GrantEntry.compat && Array.isArray(p10GrantEntry.compat.grants) && !p10GrantEntry.compat.grants.includes(decision.rememberEntry)) {',
    '    p10GrantEntry.compat.grants.push(decision.rememberEntry);',
    '}',
];

const SEED_TURN = ['// P9: the seed prompt is the first in-flight turn (self-origin).', 'turnInFlight = true;'];
const SEED_TURN_NEW = [
    '// P9: the seed prompt is the first in-flight turn (self-origin).',
    '// P10: set while a self-driven turn owns a registry run it must complete.',
    'let p10SelfDrivenOpen = false;',
    "p10SyncRuntimeState(sessionKey(), capturedSessionId, 'in-turn');",
    'turnInFlight = true;',
];

const SELFDRIVEN = [
    "if (message.type !== 'result' && !turnInFlight) {",
    'turnInFlight = true;',
    'inFlightIsPushed = false;',
    '}',
];
const SELFDRIVEN_NEW = [
    "if (message.type !== 'result' && !turnInFlight && SELFDRIVEN_TURN_TYPES.has(message.type) && !message.parent_tool_use_id) {",
    '    turnInFlight = true;',
    '    inFlightIsPushed = false;',
    '    // P10 req 1 (C1, GAP-3): a self-driven turn (background follow-up,',
    '    // Monitor / ScheduleWakeup wake-up) opens a registry run through the',
    '    // writer hook, so the UI shows processing and Stop reaches it; its result',
    '    // sends exactly one complete. A running owner run keeps the stream (the',
    '    // hook returns null).',
    '    try {',
    "        const p10SelfWriter = typeof lastBoundWriter?.p10OpenSelfDrivenRun === 'function' ? lastBoundWriter.p10OpenSelfDrivenRun() : null;",
    '        if (p10SelfWriter) {',
    '            lastBoundWriter = p10SelfWriter;',
    '            p10SelfDrivenOpen = true;',
    '            const p10Entry = sessionKey() ? getSession(sessionKey()) : null;',
    '            if (p10Entry && p10Entry.instance === queryInstance) {',
    '                p10Entry.writer = p10SelfWriter;',
    '            }',
    '        }',
    '    }',
    '    catch (p10OpenError) {',
    "        console.warn('[Claude SDK] P10 self-driven run open failed:', p10OpenError?.message || p10OpenError);",
    '    }',
    "    p10SyncRuntimeState(sessionKey(), capturedSessionId, 'in-turn');",
    '}',
];

const SCHED_TIMER = ['idleReleaseTimer = setTimeout(() => {', 'idleReleaseTimer = null;', 'releasePromptStream();', '}, BG_WAIT_CEILING_MS);'];
const SCHED_TIMER_NEW = [
    'idleReleaseTimer = setTimeout(() => {',
    '    idleReleaseTimer = null;',
    '    releasePromptStream();',
    '    // P10 (R3): idle hold 30 min; only a hold FOR background work may run to',
    '    // the 24 h silence ceiling (releasing earlier would kill that work).',
    '}, heldForBackgroundWork ? BG_WAIT_CEILING_MS : IDLE_HOLD_MS);',
];

const RETIRE_BOUNDARY = [
    'const atBoundary = !turnInFlight && turnWaiters.length === 0',
    '&& pushGateWaiters.length === 0 && imminentPushes === 0;',
    'if (atBoundary) {',
    'releasePromptStream();',
    '}',
];
const RETIRE_BOUNDARY_NEW = [
    'const atBoundary = !turnInFlight && turnWaiters.length === 0',
    '    && pushGateWaiters.length === 0 && imminentPushes === 0;',
    '// P10 req 2: never release stdin over pending background work (it would',
    '// be killed); the result branch releases once the work has reported back.',
    'if (atBoundary && !backgroundWorkPending && !heldForBackgroundWork) {',
    '    releasePromptStream();',
    '}',
    "p10SyncRuntimeState(sessionKey(), capturedSessionId, 'retiring');",
];

const RETIRE_TIMER = [
    'retireTimer = setTimeout(() => {',
    'retireTimer = null;',
    'releasePromptStream();',
    'Promise.resolve().then(() => queryInstance?.interrupt?.()).catch(() => { });',
    '}, BG_WAIT_CEILING_MS);',
];
const RETIRE_TIMER_NEW = [
    'retireTimer = setTimeout(() => {',
    '    retireTimer = null;',
    '    // P10 (R3): the 5 min retire backstop interrupts a turn that never ends;',
    '    // it never releases stdin itself (background work decides the exit).',
    '    if (turnInFlight && queryInstance) {',
    '        p10InterruptedInstances.add(queryInstance);',
    '        Promise.resolve().then(() => queryInstance?.interrupt?.()).catch(() => { });',
    '    }',
    '}, RETIRE_BACKSTOP_MS);',
];

const BEGIN_TURN_STATE = ['turnInFlight = true;', 'inFlightIsPushed = true;', 'scheduleRelease();'];
const BEGIN_TURN_STATE_NEW = [
    'turnInFlight = true;',
    'inFlightIsPushed = true;',
    "p10SyncRuntimeState(sessionKey(), capturedSessionId, 'in-turn');",
    'scheduleRelease();',
];

const ABORT_PENDING = ['const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;'];
const ABORT_PENDING_NEW = [
    '// P10 req 4: the process outlives an abort, so the flag is consumed by the',
    "// interrupted turn's own result; the next turn (a send queued behind Stop,",
    '// GAP-2) completes normally.',
    'if (abortPending) {',
    '    abortedSessionIds.delete(sessionKey());',
    '}',
    '// P10 req 1: the self-driven run gets exactly one complete (none after',
    '// Stop - the abort path already completed it).',
    'if (p10SelfDrivenOpen) {',
    '    p10SelfDrivenOpen = false;',
    '    if (!abortPending) {',
    "        currentWriter().send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));",
    '    }',
    '    turnCompleteSent = true;',
    '}',
];

const RESULT_RETIRE = ['if (retired) {', 'releasePromptStream();', '}', 'else if (backgroundWorkPending) {'];
const RESULT_RETIRE_NEW = [
    'if (retired) {',
    '    // P10 req 2: a retiring process exits only once nothing is outstanding.',
    '    if (backgroundWorkPending) {',
    '        backgroundWorkPending = false;',
    '        heldForBackgroundWork = true;',
    "        p10SyncRuntimeState(sessionKey(), capturedSessionId, 'retiring');",
    '    }',
    '    else {',
    '        heldForBackgroundWork = false;',
    '        releasePromptStream();',
    '    }',
    '}',
    'else if (backgroundWorkPending) {',
];

const BG_PENDING = ['backgroundWorkPending = false;', 'heldForBackgroundWork = true;', 'scheduleRelease();'];
const BG_PENDING_NEW = [
    'backgroundWorkPending = false;',
    'heldForBackgroundWork = true;',
    "p10SyncRuntimeState(sessionKey(), capturedSessionId, 'bg-work');",
    'scheduleRelease();',
];

const IDLE_HELD = ['heldForBackgroundWork = false;', '}', 'scheduleRelease();'];
const IDLE_HELD_NEW = [
    'heldForBackgroundWork = false;',
    '}',
    "p10SyncRuntimeState(sessionKey(), capturedSessionId, heldForBackgroundWork ? 'bg-work' : 'idle-held');",
    'scheduleRelease();',
];

const CATCH_ABORTED = [
    'const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;',
    'if (wasAborted) {',
];
const CATCH_ABORTED_NEW = [
    '// P10 req 8 (B-F5): an "[ede_diagnostic]" exit after OUR OWN interrupt (Stop,',
    '// retire backstop) is a cancellation, and a spawn wait cancelled by Stop is',
    '// not an error either: info log, no error frame.',
    "const p10Ede = typeof error?.message === 'string' && error.message.includes('[ede_diagnostic]') && Boolean(queryInstance) && p10InterruptedInstances.has(queryInstance);",
    '// A waiting push or spawn rejected by Stop (code "aborted") must not consume',
    "// the abort flag that belongs to the interrupted in-flight turn's result.",
    "const wasAborted = error?.code === 'aborted' || (sessionKey() ? abortedSessionIds.delete(sessionKey()) : false) || p10Ede;",
    'if (wasAborted) {',
    '    if (p10Ede) {',
    "        console.info('[Claude SDK] turn cancelled (interrupt):', sessionKey() || 'unknown');",
    '    }',
];

const ABORT_START = ['async function abortClaudeSDKSession(sessionId) {'];
const ABORT_END = ['/**', ' * Checks if an SDK session is currently active'];
const ABORT_FN = [
    'async function abortClaudeSDKSession(sessionId) {',
    '    // P10 req 4 (C2, R7, GAP-2, GAP-10): Stop interrupts the CURRENT TURN only.',
    '    // The process, its subagents and background work keep running, the map',
    '    // entry stays until the process really exits (so a send queued behind Stop',
    '    // is pushed into the same process and a first-turn abort keeps the same',
    '    // provider session), and nothing here can lead to a spawn. A spawn that',
    '    // is waiting for a live process on this session is cancelled.',
    '    // D4: every turn of this session still waiting (spawn wait, push retry)',
    '    // is cancelled and woken now; it is never pushed or spawned later.',
    '    const waiting = p10CancelWaiters(sessionId);',
    '    const session = getSession(sessionId);',
    '    if (!session) {',
    '        console.log(`Session ${sessionId} not found`);',
    '        return waiting;',
    '    }',
    '    try {',
    '        console.log(`Aborting SDK session turn (P10, process kept): ${sessionId}`);',
    "        if (typeof session.p10?.rejectWaiting === 'function') {",
    '            session.p10.rejectWaiting();',
    '        }',
    "        const inFlight = typeof session.p10?.turnInFlight === 'function' ? session.p10.turnInFlight() : true;",
    '        if (inFlight) {',
    '            // Mark before interrupting so the interrupted turn emits no second',
    '            // complete (the abort handler sends the aborted one).',
    '            abortedSessionIds.add(sessionId);',
    '            p10InterruptedInstances.add(session.instance);',
    '            await session.instance.interrupt();',
    '        }',
    '        return true;',
    '    }',
    '    catch (error) {',
    '        console.error(`Error aborting session ${sessionId}:`, error);',
    '        abortedSessionIds.delete(sessionId);',
    '        return false;',
    '    }',
    '}',
];

function runtimeSteps() {
    const inTurnCount = (s) => (s.match(/p10SyncRuntimeState\(sessionKey\(\), capturedSessionId, 'in-turn'\);/g) || []).length;
    return [
        { name: 'queue-import', done: (s) => s.includes('p10ComputeContentFingerprint }') || s.includes('as p10ComputeContentFingerprint'), apply: (s) => replaceBlock(s, IMPORT_ANCHOR, IMPORT_NEW, 'P10 queue import') },
        { name: 'timers', done: (s) => s.includes('const IDLE_HOLD_MS'), apply: (s) => replaceBlock(s, BG_DECL, BG_DECL_NEW, 'P10 timers') },
        { name: 'helpers', done: (s) => s.includes('---- P10 (WO-1) helpers'), apply: (s) => insertBefore(s, ADDSESSION_DOC, HELPERS, 'P10 helpers') },
        { name: 'addSession-p10', done: (s) => s.includes('p10: extras?.p10 || carried?.p10 || null'), apply: (s) => replaceBlock(s, ADDSESSION_P10, ADDSESSION_P10_NEW, 'P10 addSession') },
        { name: 'removeSession-state', done: (s) => s.includes('the runtime-state entry dies with the process-map entry'), apply: (s) => replaceBlock(s, REMOVE_FN, REMOVE_FN_NEW, 'P10 removeSession') },
        // D4 upgrade steps: a tree patched by P10 v1 gets the v2 blocks in place
        // (fresh trees already got them above, so these are then no-ops).
        { name: 'd4-waiter-registry', done: (s) => s.includes('function p10EnterWait(') && !s.includes('const p10AbortedSpawns'), apply: (s) => replaceBlock(replaceBlock(s, WAIT_DECLS_V1, WAIT_DECLS_V2, 'D4 waiter registry'), WAIT_FN_V1, WAIT_FN_NEW, 'D4 spawn wait') },
        // F6b upgrade steps: a D4 tree gets the transient-error classifier and the
        // spawn-wait grace in place (fresh and P10 v1 trees already got them above).
        { name: 'f6b-push-retry-decls', done: (s) => s.includes('function p10IsTransientPushError('), apply: (s) => insertAfter(s, P10_ABORTED_FN, PUSH_RETRY_DECLS, 'F6b push retry decls') },
        { name: 'f6b-spawn-wait-grace', done: (s) => s.includes('RETIRE_BACKSTOP_MS + P10_SPAWN_WAIT_GRACE_MS;'), apply: (s) => replaceBlock(s, WAIT_FN_V2, WAIT_FN_NEW, 'F6b spawn wait grace') },
        { name: 'd4-remove-wakes', done: (s) => s.includes('p10WakeWaiters(sessionId);'), apply: (s) => replaceBlock(s, REMOVE_FN_V1, REMOVE_FN_NEW, 'D4 removeSession wake') },
        { name: 'content-fingerprint', done: (s) => s.includes('await p10ComputeContentFingerprint(options.cwd'), apply: (s) => replaceBlock(s, FP_ANCHOR, FP_NEW, 'P10 fingerprint') },
        { name: 'reuse-compat', done: (s) => s.includes('&& p10ToolsCompatible(reuseEntry.compat, options)'), apply: (s) => replaceBlock(s, REUSE_REGION, REUSE_REGION_NEW, 'P10 reuse compat') },
        { name: 'in-place-push', done: (s) => s.includes('await p10ApplyInPlace(reuseEntry, sdkOptions);'), apply: (s) => replaceBlock(s, PUSH_BLOCK, PUSH_BLOCK_NEW, 'P10 in-place push') },
        { name: 'push-failed-never-spawns', done: (s) => s.includes('P10 (GAP-2, the 2026-10-09 22:34 incident)'), apply: (s) => replaceBlock(s, PUSHFAIL, PUSHFAIL_NEW, 'P10 push failed') },
        { name: 'd4-push-retry-honours-stop', done: (s) => s.includes('const p10PushWaiter = p10EnterWait(p10PushKey);'), apply: (s) => replaceBlock(s, PUSHFAIL_V1, PUSHFAIL_NEW, 'D4 push retry') },
        { name: 'f6b-push-retry-backoff', done: (s) => s.includes('p10PushPauseMs = Math.min(p10PushPauseMs * 2, P10_WAIT_MAX_MS);'), apply: (s) => replaceBlock(s, PUSHFAIL_V2, PUSHFAIL_NEW, 'F6b push retry') },
        { name: 'wait-before-spawn', done: (s) => s.includes('await p10WaitForSessionFree(sessionKey(), providerSessionId, null);'), apply: (s) => insertBefore(s, MCPS_ANCHOR, RETIRE_WAIT, 'P10 wait before spawn') },
        { name: 'grant-record', done: (s) => s.includes('p10GrantEntry.compat.grants.push(decision.rememberEntry);'), apply: (s) => replaceBlock(s, GRANT_TAIL, GRANT_TAIL_NEW, 'P10 grant') },
        { name: 'retire-boundary', done: (s) => s.includes("p10SyncRuntimeState(sessionKey(), capturedSessionId, 'retiring');\n") && s.includes('if (atBoundary && !backgroundWorkPending && !heldForBackgroundWork) {'), apply: (s) => replaceBlock(s, RETIRE_BOUNDARY, RETIRE_BOUNDARY_NEW, 'P10 retire boundary') },
        { name: 'retire-backstop', done: (s) => s.includes('}, RETIRE_BACKSTOP_MS);'), apply: (s) => replaceBlock(s, RETIRE_TIMER, RETIRE_TIMER_NEW, 'P10 retire backstop') },
        { name: 'compat-extras', done: (s) => s.includes("open('p10-aborted');"), apply: (s) => replaceBlock(s, COMPAT_TAIL, COMPAT_TAIL_NEW, 'P10 compat extras') },
        { name: 'reject-waiting-push', done: (s) => s.includes("if (wasPumped === 'p10-aborted') {"), apply: (s) => replaceBlock(s, PUMP_WAIT, PUMP_WAIT_NEW, 'P10 reject waiting push') },
        { name: 'seed-turn', done: (s) => s.includes('let p10SelfDrivenOpen = false;'), apply: (s) => replaceBlock(s, SEED_TURN, SEED_TURN_NEW, 'P10 seed turn') },
        { name: 'begin-turn-state', done: (s) => inTurnCount(s) >= 2 && s.includes("'in-turn');\n") && /inFlightIsPushed = true;\n\s*p10SyncRuntimeState/.test(s), apply: (s) => replaceBlock(s, BEGIN_TURN_STATE, BEGIN_TURN_STATE_NEW, 'P10 beginTurn state') },
        { name: 'self-driven', done: (s) => s.includes('SELFDRIVEN_TURN_TYPES.has(message.type)'), apply: (s) => replaceBlock(s, SELFDRIVEN, SELFDRIVEN_NEW, 'P10 self-driven') },
        { name: 'idle-timer', done: (s) => s.includes('}, heldForBackgroundWork ? BG_WAIT_CEILING_MS : IDLE_HOLD_MS);'), apply: (s) => replaceBlock(s, SCHED_TIMER, SCHED_TIMER_NEW, 'P10 idle timer') },
        { name: 'abort-flag-and-selfdriven-complete', done: (s) => s.includes('if (p10SelfDrivenOpen) {'), apply: (s) => insertAfter(s, ABORT_PENDING, ABORT_PENDING_NEW, 'P10 result abort flag') },
        { name: 'result-retire', done: (s) => s.includes('// P10 req 2: a retiring process exits only once nothing is outstanding.'), apply: (s) => replaceBlock(s, RESULT_RETIRE, RESULT_RETIRE_NEW, 'P10 result retire') },
        { name: 'bg-work-state', done: (s) => s.includes("p10SyncRuntimeState(sessionKey(), capturedSessionId, 'bg-work');"), apply: (s) => replaceBlock(s, BG_PENDING, BG_PENDING_NEW, 'P10 bg-work state') },
        { name: 'idle-held-state', done: (s) => s.includes("heldForBackgroundWork ? 'bg-work' : 'idle-held'"), apply: (s) => replaceBlock(s, IDLE_HELD, IDLE_HELD_NEW, 'P10 idle-held state') },
        { name: 'ede-cancel', done: (s) => s.includes('const p10Ede ='), apply: (s) => replaceBlock(s, CATCH_ABORTED, CATCH_ABORTED_NEW, 'P10 ede cancel') },
        { name: 'abort-turn-only', done: (s) => s.includes('Aborting SDK session turn (P10, process kept)'), apply: (s) => replaceRange(s, ABORT_START, ABORT_END, ABORT_FN, 'P10 abort') },
        { name: 'd4-abort-cancels-waiters', done: (s) => s.includes('const waiting = p10CancelWaiters(sessionId);'), apply: (s) => replaceRange(s, ABORT_START, ABORT_END, ABORT_FN, 'D4 abort') },
    ];
}
function verifyRuntime(s) {
    const markers = ['const IDLE_HOLD_MS', 'const RETIRE_BACKSTOP_MS', 'function p10WriteRuntimeState(', 'p10WaitForSessionFree(', 'p10OpenSelfDrivenRun()', 'session_busy_external', '[ede_diagnostic]', 'SELFDRIVEN_TURN_TYPES', "import p10fs from 'fs';",
        'function p10EnterWait(', 'const p10PushWaiter = p10EnterWait(p10PushKey);', 'const waiting = p10CancelWaiters(sessionId);', 'p10WakeWaiters(sessionId);', 'pauseMs = Math.min(pauseMs * 2, P10_WAIT_MAX_MS);',
        'function p10IsTransientPushError(', 'RETIRE_BACKSTOP_MS + P10_SPAWN_WAIT_GRACE_MS;', 'p10PushPauseMs = Math.min(p10PushPauseMs * 2, P10_WAIT_MAX_MS);'];
    for (const marker of markers) {
        if (!s.includes(marker)) {
            return `missing marker ${JSON.stringify(marker.slice(0, 40))}`;
        }
    }
    if (s.includes('p10AbortedSpawns') || s.includes('p10WaitingSpawns')) {
        return 'P10 v1 waiter flags still present (D4 upgrade missing)';
    }
    if (s.includes('await p10WaitPause(p10PushWaiter, P10_WAIT_MIN_MS);')) {
        return 'D4 fixed 50 ms push retry still present (F6b upgrade missing)';
    }
    if (s.includes('P9 push failed, spawning instead')) {
        return 'P9 push-failed spawn fallback still present';
    }
    if (/session\.releaseInput\?\.\(\);\s*\n[^\n]*\n?[^\n]*session\.status = 'aborted'/.test(s)) {
        return 'legacy abort release still present';
    }
    return null;
}

// --- C. chat-run-registry.service ------------------------------------------------
const REGISTRY_EXPORT = ['export const chatRunRegistry = {'];
function registryHelper(ts) {
    if (ts) {
        return [
            '/**',
            ' * P10 (WO-1 req 1): every run writer carries a hook the Claude runtime calls',
            ' * when a SELF-DRIVEN turn (task notification, Monitor, ScheduleWakeup) starts',
            ' * inside the held CLI process; see `openSelfDrivenRun`.',
            ' */',
            'function p10AttachSelfDrivenHook(run: ChatRun): void {',
            '  (run.writer as unknown as { p10OpenSelfDrivenRun?: () => ChatSessionWriter | null }).p10OpenSelfDrivenRun = () =>',
            '    chatRunRegistry.openSelfDrivenRun({ appSessionId: run.appSessionId, fromRun: run });',
            '}',
        ];
    }
    return [
        '/**',
        ' * P10 (WO-1 req 1): every run writer carries a hook the Claude runtime calls',
        ' * when a SELF-DRIVEN turn (task notification, Monitor, ScheduleWakeup) starts',
        ' * inside the held CLI process; see `openSelfDrivenRun`.',
        ' */',
        'function p10AttachSelfDrivenHook(run) {',
        '    run.writer.p10OpenSelfDrivenRun = () => chatRunRegistry.openSelfDrivenRun({ appSessionId: run.appSessionId, fromRun: run });',
        '}',
    ];
}
const REGISTRY_SET_RETURN = ['runs.set(input.appSessionId, run);', 'return run;'];
const REGISTRY_SET_RETURN_NEW = ['p10AttachSelfDrivenHook(run);', 'runs.set(input.appSessionId, run);', 'return run;'];
const REGISTRY_CLEARALL_DOC = ['/**', ' * Test-only escape hatch: clears every tracked run.'];
function openSelfDriven(ts) {
    const a = ts ? '  ' : '    ';
    const b = a + a;
    const c = b + a;
    const head = [
        '/**',
        ' * P10 (WO-1 req 1, C1): opens a run for a SELF-DRIVEN turn of a held CLI',
        ' * process, so the session shows processing, Stop reaches the turn, and its',
        ' * single `complete` closes it. Refused (null) while a run is already',
        ' * running - that run owns the stream. The audience is taken from the run the',
        " * hook belongs to (it survives the 5 min eviction of completed runs) and",
        ' * `seq` continues from it, because clients drop events at or below the',
        ' * highest seq they have seen for the session.',
        ' */',
    ];
    const sig = ts
        ? 'openSelfDrivenRun(input: { appSessionId: string; fromRun?: ChatRun | null }): ChatSessionWriter | null {'
        : 'openSelfDrivenRun(input) {';
    const conns = ts
        ? `${a}const audience = ((source?.writer as unknown as { connections?: Set<unknown> } | undefined)?.connections) || new Set<unknown>();`
        : `${a}const audience = source?.writer?.connections || new Set();`;
    const userIdLine = ts
        ? `${b}userId: ((source?.writer as unknown as { userId?: string | null } | undefined)?.userId) ?? null,`
        : `${b}userId: source?.writer?.userId ?? null,`;
    return [
        ...head,
        sig,
        `${a}const existing = runs.get(input.appSessionId);`,
        `${a}if (existing && existing.status === 'running') {`,
        `${b}return null;`,
        `${a}}`,
        `${a}const source = input.fromRun || existing || null;`,
        `${a}const run${ts ? ': ChatRun' : ''} = {`,
        `${b}appSessionId: input.appSessionId,`,
        `${b}provider: source?.provider || 'claude',`,
        `${b}providerSessionId: source?.providerSessionId ?? null,`,
        `${b}status: 'running',`,
        `${b}lastSeq: Math.max(source?.lastSeq ?? 0, existing?.lastSeq ?? 0),`,
        `${b}events: [],`,
        `${b}writer: null${ts ? ' as unknown as ChatSessionWriter' : ''},`,
        `${b}startedAt: Date.now(),`,
        `${b}completedAt: null,`,
        `${a}};`,
        `${a}run.writer = new ChatSessionWriter({`,
        `${b}connection: null,`,
        userIdLine,
        `${b}provider: run.provider,`,
        `${b}providerSessionId: run.providerSessionId,`,
        `${b}onProviderSessionId: (providerSessionId${ts ? ': string' : ''}) => {`,
        `${c}recordProviderSessionId(run, providerSessionId);`,
        `${b}},`,
        `${b}decorateOutboundEvent: (message${ts ? ': Parameters<typeof decorateAndRecordEvent>[1]' : ''}) => decorateAndRecordEvent(run, message),`,
        `${a}});`,
        conns,
        `${a}for (const connection of audience) {`,
        `${b}run.writer.updateWebSocket(connection${ts ? ' as never' : ''});`,
        `${a}}`,
        `${a}p10AttachSelfDrivenHook(run);`,
        `${a}runs.set(input.appSessionId, run);`,
        `${a}return run.writer;`,
        '},',
    ];
}
function registrySteps(ts) {
    return [
        { name: 'hook-helper', done: (s) => s.includes('function p10AttachSelfDrivenHook('), apply: (s) => insertBefore(s, REGISTRY_EXPORT, registryHelper(ts), 'P10 registry hook helper') },
        { name: 'startRun-hook', done: (s) => s.includes('p10AttachSelfDrivenHook(run);\n') && findBlock(s.split('\n'), REGISTRY_SET_RETURN_NEW).length === 1, apply: (s) => replaceBlock(s, REGISTRY_SET_RETURN, REGISTRY_SET_RETURN_NEW, 'P10 startRun hook') },
        { name: 'openSelfDrivenRun', done: (s) => s.includes('openSelfDrivenRun(input'), apply: (s) => insertBefore(s, REGISTRY_CLEARALL_DOC, openSelfDriven(ts), 'P10 openSelfDrivenRun') },
    ];
}
function verifyRegistry(s) {
    if (!s.includes('openSelfDrivenRun(input') || !s.includes('function p10AttachSelfDrivenHook(')) {
        return 'openSelfDrivenRun / hook missing';
    }
    return null;
}

// --- engine -----------------------------------------------------------------------
function patchFile(file, steps, verify, { js, required }) {
    if (!fs.existsSync(file)) {
        if (required) {
            checkOnly ? missing(`P10 ${file} (file not found)`) : fatal(`${file} not found`);
        }
        else {
            note(`P10 skipped (not present): ${file}`);
        }
        return;
    }
    const original = fs.readFileSync(file, 'utf8');
    let next = original;
    const absent = [];
    for (const step of steps) {
        if (step.done(next)) {
            continue;
        }
        if (checkOnly) {
            absent.push(step.name);
            continue;
        }
        try {
            next = step.apply(next);
        }
        catch (error) {
            fatal(`${file}: ${error.message}`);
        }
        if (!step.done(next)) {
            fatal(`${file}: step "${step.name}" did not take effect`);
        }
    }
    if (checkOnly && absent.length > 0) {
        missing(`P10 ${file} (${absent.join(', ')})`);
        return;
    }
    const invalid = verify(next) || (js ? nodeCheck(next, file) : null);
    if (invalid) {
        checkOnly ? missing(`P10 ${file}: ${invalid}`) : fatal(`${file}: ${invalid}`);
        return;
    }
    if (checkOnly) {
        note(`P10 ok: ${file}`);
        return;
    }
    if (next === original) {
        note(`P10 already applied: ${file}`);
        return;
    }
    atomicWrite(file, next);
    note(`P10 patched: ${file}`);
}

patchFile(path.join(DIST, ...CLAUDE_REL, 'claude-runtime.provider.js'), runtimeSteps(), verifyRuntime, { js: true, required: true });
patchFile(path.join(SRC, ...CLAUDE_REL, 'claude-runtime.provider.js'), runtimeSteps(), verifyRuntime, { js: true, required: false });
patchFile(path.join(DIST, 'modules', 'websocket', 'services', 'chat-run-registry.service.js'), registrySteps(false), verifyRegistry, { js: true, required: true });
patchFile(path.join(SRC, 'modules', 'websocket', 'services', 'chat-run-registry.service.ts'), registrySteps(true), verifyRegistry, { js: false, required: false });

if (failures > 0) {
    console.error(`P10 ${mode} FAILED: ${failures} item(s) missing`);
    process.exit(1);
}
console.log(checkOnly ? 'P10 check OK: all P10 edits present' : 'P10 apply OK');
NODE
