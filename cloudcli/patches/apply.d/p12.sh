#!/usr/bin/env bash
# P12 origin hardening for @cloudcli-ai/cloudcli 1.37.3 (WO-4; findings F5, F12, F13).
# Usage:
#   apply.d/p12.sh [TARGET_ROOT]          apply (idempotent; completes a partial apply)
#   apply.d/p12.sh --check [TARGET_ROOT]  verify every P12 edit, change nothing; exit 1 if any is missing
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (default: install root above patches/).
# Runs after apply.sh (anchors on the P5 lines) and tolerates apply.d/p10.sh and p11.sh applied first.
# Edits (dist-server + server):
#   - modules/auth/access-jwt.js = patches/files/access-jwt.js (CF_ACCESS_EMAIL pin, reject lines with
#     reason/path/peer, Origin allowlist exports); copied first so no importer ever names a missing export.
#   - index: app.use(originRestMiddleware) right after app.use(accessRestMiddleware).
#   - websocket-server.service: new WebSocketServer(withWebSocketOriginGuard({...})); the P5 verifyClient
#     line stays byte-identical.
#   - chat-websocket.service: chat.permission-response is accepted only when its requestId is pending for a
#     session this connection sent to or subscribed to; anything else is warned and ignored.
#   - sessions-watcher.service: "Session synchronization triggered" logs only with CLOUDCLI_DEBUG_SYNC=1.
# Every modified file keeps a one-time <file>.bak-pre-p12 copy; each write is atomic and patched dist JS
# must pass node --check before it replaces the original.
set -euo pipefail
MODE=apply
if [ "${1:-}" = "--check" ]; then MODE=check; shift; fi
PATCHES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then cd "$1"; else cd "$PATCHES_DIR/.."; fi
PKG="node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found under $(pwd)" >&2; exit 1; }
CANONICAL="$PATCHES_DIR/files/access-jwt.js"
[ -f "$CANONICAL" ] || { echo "FATAL: $CANONICAL not found" >&2; exit 1; }
WORK_DIR="$(mktemp -d "${TMPDIR:-/var/tmp}/p12.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

node - "$MODE" "$PKG" "$CANONICAL" "$WORK_DIR" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

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
    console.error(`P12 PATCH FAILED: ${message}`);
    process.exit(1);
}
function countOf(source, needle) {
    let count = 0;
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
        count += 1;
    }
    return count;
}
function replaceOnce(source, anchor, replacement, label) {
    const count = countOf(source, anchor);
    if (count !== 1) {
        throw new Error(`${label}: anchor found ${count} times (expected 1): ${JSON.stringify(anchor.slice(0, 80))}`);
    }
    return source.replace(anchor, () => replacement);
}
function insertAfterLine(source, anchor, makeLine, label) {
    const count = countOf(source, anchor);
    if (count !== 1) {
        throw new Error(`${label}: anchor found ${count} times (expected 1): ${JSON.stringify(anchor.slice(0, 80))}`);
    }
    const at = source.indexOf(anchor);
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    if (lineEnd === -1) {
        throw new Error(`${label}: anchor line has no line end`);
    }
    const indent = /^[ \t]*/.exec(source.slice(lineStart, at))[0];
    return `${source.slice(0, lineEnd + 1)}${indent}${makeLine()}\n${source.slice(lineEnd + 1)}`;
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
    const mode = fs.statSync(file).mode & 0o7777;
    const backup = `${file}.bak-pre-p12`;
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(file, backup);
    }
    const temp = `${file}.p12tmp-${process.pid}`;
    fs.writeFileSync(temp, content);
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
}

const DIST = path.join(pkg, 'dist-server', 'server');
const SRC = path.join(pkg, 'server');

// --- access-jwt.js ------------------------------------------------------------
const canonical = fs.readFileSync(canonicalPath);
const canonicalError = nodeCheck(canonical, 'files/access-jwt.js');
if (canonicalError) {
    fatal(canonicalError);
}
for (const [root, required] of [[DIST, true], [SRC, false]]) {
    const dir = path.join(root, 'modules', 'auth');
    const target = path.join(dir, 'access-jwt.js');
    if (!fs.existsSync(dir)) {
        if (required) {
            checkOnly ? missing(`P12 ${dir} (auth module dir)`) : fatal(`${dir} not found`);
        }
        continue;
    }
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current && Buffer.compare(current, canonical) === 0) {
        note(`P12 ${checkOnly ? 'ok' : 'already current'}: ${target}`);
        continue;
    }
    if (checkOnly) {
        missing(`P12 ${target} differs from patches/files/access-jwt.js`);
        continue;
    }
    if (current) {
        atomicWrite(target, canonical);
    }
    else {
        fs.writeFileSync(target, canonical);
    }
    note(`P12 copied: ${target}`);
}
const distAccess = path.resolve(DIST, 'modules', 'auth', 'access-jwt.js');
if (fs.existsSync(distAccess)) {
    const probe = [
        'const m = await import(process.env.P12_IMPORT_URL);',
        "const need = ['accessRestMiddleware', 'guardAccessWebSocketUpgrade', 'originRestMiddleware', 'guardOriginWebSocketUpgrade', 'withWebSocketOriginGuard'];",
        "const gone = need.filter((name) => typeof m[name] !== 'function');",
        "if (gone.length > 0) { console.error('missing exports: ' + gone.join(', ')); process.exit(1); }",
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        env: { ...process.env, P12_IMPORT_URL: pathToFileURL(distAccess).href },
    });
    if (result.status !== 0) {
        const detail = (result.stderr || '').trim().split('\n').slice(0, 2).join(' | ');
        checkOnly ? missing(`P12 ${distAccess} exports (${detail})`) : fatal(`${distAccess} exports: ${detail}`);
    }
    else {
        note(`P12 exports ok: ${distAccess}`);
    }
}

// --- edit definitions ----------------------------------------------------------
const P5_ACCESS_IMPORT = "import { accessRestMiddleware } from './modules/auth/access-jwt.js';";
const ORIGIN_IMPORT = "import { originRestMiddleware } from './modules/auth/access-jwt.js';";
const P5_ACCESS_MOUNT = 'app.use(accessRestMiddleware);';
const ORIGIN_MOUNT = 'app.use(originRestMiddleware);';
const indexSteps = [
    {
        name: 'origin import',
        done: (s) => s.includes(ORIGIN_IMPORT),
        apply: (s) => replaceOnce(s, `${P5_ACCESS_IMPORT}\n`, `${P5_ACCESS_IMPORT}\n${ORIGIN_IMPORT}\n`, 'index import'),
    },
    {
        name: 'origin mount',
        done: (s) => s.includes(ORIGIN_MOUNT),
        apply: (s) => replaceOnce(s, `${P5_ACCESS_MOUNT}\n`, `${P5_ACCESS_MOUNT}\n${ORIGIN_MOUNT}\n`, 'index mount'),
    },
];
function verifyIndex(s) {
    const pair = s.indexOf(`${P5_ACCESS_MOUNT}\n${ORIGIN_MOUNT}\n`);
    const health = s.indexOf("app.get('/health'");
    if (pair === -1 || health === -1 || pair > health || countOf(s, ORIGIN_MOUNT) !== 1) {
        return 'originRestMiddleware must be mounted once, right after accessRestMiddleware and before /health';
    }
    return null;
}

const P5_WS_IMPORT = "import { guardAccessWebSocketUpgrade } from '../../auth/access-jwt.js';";
const ORIGIN_WS_IMPORT = "import { withWebSocketOriginGuard } from '../../auth/access-jwt.js';";
const WSS_OPEN = 'new WebSocketServer({';
const WSS_WRAPPED_OPEN = 'new WebSocketServer(withWebSocketOriginGuard({';
const P5_VERIFY_TAIL = 'guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),';
const WRAPPED_RE = /new WebSocketServer\(withWebSocketOriginGuard\(\{[\s\S]*?guardAccessWebSocketUpgrade\(info, cb, \(\) => verifyWebSocketClient\(info, dependencies\.verifyClient\)\)\),\s*\}\)\);/;
function wrapWebSocketServer(s) {
    if (countOf(s, WSS_OPEN) !== 1) {
        throw new Error(`websocket server: "${WSS_OPEN}" found ${countOf(s, WSS_OPEN)} times (expected 1)`);
    }
    const open = s.indexOf(WSS_OPEN);
    const tail = s.indexOf(P5_VERIFY_TAIL, open);
    if (tail === -1) {
        throw new Error('websocket server: P5 verifyClient wrapper not found after new WebSocketServer({ (run apply.sh first)');
    }
    const afterTail = tail + P5_VERIFY_TAIL.length;
    const close = /^\s*\}\);/.exec(s.slice(afterTail));
    if (!close) {
        throw new Error('websocket server: expected the options object to close right after the P5 verifyClient');
    }
    const closeAt = afterTail + close[0].length - 3;
    return `${s.slice(0, open)}${WSS_WRAPPED_OPEN}${s.slice(open + WSS_OPEN.length, closeAt)}}));${s.slice(closeAt + 3)}`;
}
const wsSteps = [
    {
        name: 'origin guard import',
        done: (s) => s.includes(ORIGIN_WS_IMPORT),
        apply: (s) => replaceOnce(s, `${P5_WS_IMPORT}\n`, `${P5_WS_IMPORT}\n${ORIGIN_WS_IMPORT}\n`, 'websocket import'),
    },
    {
        name: 'origin guard wrap',
        done: (s) => s.includes(WSS_WRAPPED_OPEN),
        apply: wrapWebSocketServer,
    },
];
function verifyWs(s) {
    if (!WRAPPED_RE.test(s)) {
        return 'withWebSocketOriginGuard must wrap the WebSocketServer options that hold the P5 verifyClient';
    }
    return null;
}

const DIST_HELPERS = `const p12ConnectionSessions = new WeakMap();
function p12NoteConnectionSessions(ws, messageType, data) {
    if (!ws || (messageType !== 'chat.send' && messageType !== 'chat.edit-send' && messageType !== 'chat.subscribe')) {
        return;
    }
    const ids = messageType === 'chat.subscribe'
        ? (Array.isArray(data.sessions) ? data.sessions.map((target) => (target && typeof target === 'object' ? target.sessionId : null)) : [])
        : [data.sessionId];
    for (const id of ids) {
        const sessionId = typeof id === 'string' ? id.trim() : '';
        if (!sessionId) {
            continue;
        }
        let bound = p12ConnectionSessions.get(ws);
        if (!bound) {
            bound = new Set();
            p12ConnectionSessions.set(ws, bound);
        }
        bound.add(sessionId);
    }
}
function p12PermissionResponseAllowed(ws, data, dependencies) {
    const requestId = data.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
        return false;
    }
    const bound = ws ? p12ConnectionSessions.get(ws) : undefined;
    const claimed = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
    const candidates = bound ? (claimed ? (bound.has(claimed) ? [claimed] : []) : [...bound]) : [];
    for (const sessionId of candidates) {
        let pending = [];
        try {
            pending = dependencies.runtime.getPendingApprovalsForSession(sessionId);
        }
        catch {
            pending = [];
        }
        if (Array.isArray(pending) && pending.some((request) => request?.requestId === requestId)) {
            return true;
        }
    }
    console.warn(\`[Chat] Ignoring chat.permission-response: request \${JSON.stringify(requestId.slice(0, 16))} is not pending for a session of this connection (bound sessions: \${bound ? bound.size : 0})\`);
    return false;
}
`;
const TS_HELPERS = `const p12ConnectionSessions = new WeakMap<WebSocket, Set<string>>();

function p12NoteConnectionSessions(ws: WebSocket, messageType: string, data: AnyRecord): void {
  if (!ws || (messageType !== 'chat.send' && messageType !== 'chat.edit-send' && messageType !== 'chat.subscribe')) {
    return;
  }
  const ids: unknown[] = messageType === 'chat.subscribe'
    ? (Array.isArray(data.sessions) ? data.sessions.map((target: unknown) => (target && typeof target === 'object' ? (target as AnyRecord).sessionId : null)) : [])
    : [data.sessionId];
  for (const id of ids) {
    const sessionId = typeof id === 'string' ? id.trim() : '';
    if (!sessionId) {
      continue;
    }
    let bound = p12ConnectionSessions.get(ws);
    if (!bound) {
      bound = new Set<string>();
      p12ConnectionSessions.set(ws, bound);
    }
    bound.add(sessionId);
  }
}

function p12PermissionResponseAllowed(
  ws: WebSocket | undefined,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): boolean {
  const requestId = data.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return false;
  }
  const bound = ws ? p12ConnectionSessions.get(ws) : undefined;
  const claimed = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  const candidates = bound ? (claimed ? (bound.has(claimed) ? [claimed] : []) : [...bound]) : [];
  for (const sessionId of candidates) {
    let pending: unknown[] = [];
    try {
      pending = dependencies.runtime.getPendingApprovalsForSession(sessionId);
    } catch {
      pending = [];
    }
    if (Array.isArray(pending) && pending.some((request) => (request as { requestId?: unknown } | null)?.requestId === requestId)) {
      return true;
    }
  }
  console.warn(\`[Chat] Ignoring chat.permission-response: request \${JSON.stringify(requestId.slice(0, 16))} is not pending for a session of this connection (bound sessions: \${bound ? bound.size : 0})\`);
  return false;
}

`;
const HELPERS_MARKER = 'function p12PermissionResponseAllowed(';
const PERMISSION_DOC = '/**\n * Handles `chat.permission-response`: forwards';
const GUARD_MARKER = 'if (!p12PermissionResponseAllowed(ws, data, dependencies)) {';
const CALL_OLD = 'handlePermissionResponse(data, dependencies);';
const CALL_NEW = 'handlePermissionResponse(data, dependencies, ws);';
const MESSAGE_TYPE_LINE = "const messageType = typeof data.type === 'string' ? data.type : '';";
const BIND_CALL = 'p12NoteConnectionSessions(ws, messageType, data);';
function chatSteps(ts) {
    const header = ts
        ? 'function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {\n'
        : 'function handlePermissionResponse(data, dependencies) {\n';
    const guarded = ts
        ? `function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies, ws?: WebSocket): void {\n  ${GUARD_MARKER}\n    return;\n  }\n\n`
        : `function handlePermissionResponse(data, dependencies, ws) {\n    ${GUARD_MARKER}\n        return;\n    }\n`;
    const helpers = ts ? TS_HELPERS : DIST_HELPERS;
    return [
        {
            name: 'permission helpers',
            done: (s) => s.includes(HELPERS_MARKER),
            apply: (s) => (countOf(s, PERMISSION_DOC) === 1
                ? replaceOnce(s, PERMISSION_DOC, `${helpers}${PERMISSION_DOC}`, 'chat helpers')
                : replaceOnce(s, header, `${helpers}${header}`, 'chat helpers')),
        },
        {
            name: 'permission guard',
            done: (s) => s.includes(GUARD_MARKER),
            apply: (s) => replaceOnce(s, header, guarded, 'chat guard'),
        },
        {
            name: 'permission call passes ws',
            done: (s) => s.includes(CALL_NEW),
            apply: (s) => replaceOnce(s, CALL_OLD, CALL_NEW, 'chat call'),
        },
        {
            name: 'connection session binding',
            done: (s) => s.includes(BIND_CALL),
            apply: (s) => insertAfterLine(s, MESSAGE_TYPE_LINE, () => BIND_CALL, 'chat binding'),
        },
    ];
}
function verifyChat(s) {
    if (countOf(s, CALL_OLD) !== 0 || countOf(s, CALL_NEW) !== 1 || countOf(s, BIND_CALL) !== 1 || countOf(s, GUARD_MARKER) !== 1 || countOf(s, HELPERS_MARKER) !== 1) {
        return 'chat-websocket permission guard, call site and session binding must each appear exactly once';
    }
    return null;
}

const SYNC_OLD = 'console.log(`Session synchronization triggered';
const SYNC_NEW = "if (process.env.CLOUDCLI_DEBUG_SYNC === '1') console.debug(`Session synchronization triggered";
const watcherSteps = [
    {
        name: 'sync log demoted to debug',
        done: (s) => s.includes(SYNC_NEW),
        apply: (s) => replaceOnce(s, SYNC_OLD, SYNC_NEW, 'watcher log'),
    },
];
function verifyWatcher(s) {
    if (countOf(s, SYNC_OLD) !== 0 || countOf(s, SYNC_NEW) !== 1) {
        return 'the per-event sync log must be gated by CLOUDCLI_DEBUG_SYNC exactly once';
    }
    return null;
}

// --- engine ---------------------------------------------------------------------
function patchFile(file, steps, verify, { js, required }) {
    if (!fs.existsSync(file)) {
        if (required) {
            checkOnly ? missing(`P12 ${file} (file not found)`) : fatal(`${file} not found`);
        }
        else {
            note(`P12 skipped (not present): ${file}`);
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
        missing(`P12 ${file} (${absent.join(', ')})`);
        return;
    }
    const invalid = verify(next) || (js ? nodeCheck(next, file) : null);
    if (invalid) {
        checkOnly ? missing(`P12 ${file}: ${invalid}`) : fatal(`${file}: ${invalid}`);
        return;
    }
    if (checkOnly) {
        note(`P12 ok: ${file}`);
        return;
    }
    if (next === original) {
        note(`P12 already applied: ${file}`);
        return;
    }
    atomicWrite(file, next);
    note(`P12 patched: ${file}`);
}

patchFile(path.join(DIST, 'index.js'), indexSteps, verifyIndex, { js: true, required: true });
patchFile(path.join(SRC, 'index.ts'), indexSteps, verifyIndex, { js: false, required: false });
patchFile(path.join(DIST, 'modules/websocket/services/websocket-server.service.js'), wsSteps, verifyWs, { js: true, required: true });
patchFile(path.join(SRC, 'modules/websocket/services/websocket-server.service.ts'), wsSteps, verifyWs, { js: false, required: false });
patchFile(path.join(DIST, 'modules/websocket/services/chat-websocket.service.js'), chatSteps(false), verifyChat, { js: true, required: true });
patchFile(path.join(SRC, 'modules/websocket/services/chat-websocket.service.ts'), chatSteps(true), verifyChat, { js: false, required: false });
patchFile(path.join(DIST, 'modules/providers/services/sessions-watcher.service.js'), watcherSteps, verifyWatcher, { js: true, required: true });
patchFile(path.join(SRC, 'modules/providers/services/sessions-watcher.service.ts'), watcherSteps, verifyWatcher, { js: false, required: false });

if (failures > 0) {
    console.error(`P12 ${mode} FAILED: ${failures} item(s) missing`);
    process.exit(1);
}
console.log(checkOnly ? 'P12 check OK: all P12 edits present' : 'P12 apply OK');
NODE
