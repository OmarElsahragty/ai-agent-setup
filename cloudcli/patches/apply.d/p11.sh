#!/usr/bin/env bash
# P11 (WO-2, 2026-10-09): sessions / dispatcher / watcher / Shell tab.
# Usage:
#   apply.d/p11.sh [TARGET_ROOT]          apply (idempotent; completes a partial apply)
#   apply.d/p11.sh --check [TARGET_ROOT]  verify every P11 edit is present; exit 1 if any is missing
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (default: install root above patches/).
# Requires apply.sh (P0-P9r, P8 in particular) to have run first; tolerant of apply.d/p10.sh
# (it touches none of these files).
#   (1) History reader (claude-sessions.provider): one row per uuid, first copy wins, BEFORE
#       sibling/edit detection; only a real owner edit-send sibling is pruned (task
#       notifications, system/transcript-only/meta/tool-result/tag-wrapped rows never are).
#   (2) sessions.db createSession: an indexer upsert (watcher/synchronizer write) never
#       changes isArchived, on the UPDATE path and on the legacy ON CONFLICT path.
#   (3) sessions.db readers: sessions with no app-created row (terminal/external) are
#       flagged isExternal non-destructively, derived on read (nothing renamed, hidden,
#       re-keyed or written back): app rows are keyed by an app-allocated session_id
#       with the provider id mapped separately, so session_id === provider_session_id
#       means the row was indexed from disk only (synchronizer keys both columns with
#       the provider-native id).
#   (4) Queued-draft dispatcher: busy also when the runtime state file
#       ($CLOUDCLI_RUNTIME_STATE, default /run/cloudcli/runtime-state.json) has a live entry
#       for the session in state in-turn/bg-work/retiring; drops a draft queued > 30 min
#       ago, a draft whose id (sha256 of user, session, stored queued JSON) was already
#       dispatched, and a draft whose trimmed text equals ANY user row among the last 10
#       history messages (no 120 s window). Every guard fails open.
#   (5) Shell tab: `claude --resume <id>` has no `|| claude` fallback, and resuming a
#       session that has a live runtime-state entry (any state) is refused.
# Each patched file keeps a .bak-pre-p11 copy (the state before P11), is written
# atomically only after its edits verify, and dist files pass `node --check`.
set -euo pipefail
MODE=apply
if [ "${1:-}" = "--check" ]; then MODE=check; shift; fi
PATCHES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then ROOT="$(cd "$1" && pwd)"; else ROOT="$(cd "$PATCHES_DIR/.." && pwd)"; fi
PKG="$ROOT/node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/p11-patcher.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [mode, pkg, work] = process.argv.slice(2);
const L = (...lines) => lines.join('\n');
const note = (msg) => console.log(`[${mode}] ${msg}`);
let problems = 0;
const fail = (msg) => { console.error(`P11 ${mode === 'check' ? 'MISSING' : 'PATCH FAILED'}: ${msg}`); problems += 1; };

// ---------------------------------------------------------------- (1) reader
const ownerPromptDoc = L(
    '/**',
    ' * P11: true only for a prompt the owner typed and sent. Task notifications,',
    ' * system-sourced prompts, transcript-only rows, tool results and tag-wrapped',
    ' * internal notes are never edit candidates: they neither supersede an owner',
    ' * prompt nor get superseded, so they can never hide a branch.',
    ' */',
);
const ownerPromptBody = (i, ts) => L(
    `function p11IsOwnerPromptRow(row${ts ? ': AnyRecord' : ''})${ts ? ': boolean' : ''} {`,
    `${i}if (!isUserPromptRow(row) || row.isVisibleInTranscriptOnly === true || row.toolUseResult !== undefined || row.sourceToolAssistantUUID !== undefined) {`,
    `${i}${i}return false;`,
    `${i}}`,
    `${i}if (row.promptSource === 'system' || row.turnOrigin === 'task_notification') {`,
    `${i}${i}return false;`,
    `${i}}`,
    `${i}const originKind = row.origin && typeof row.origin === 'object' ? row.origin.kind : undefined;`,
    `${i}if (row.origin != null && !(typeof originKind === 'string' && /^(human|user|owner)$/i.test(originKind))) {`,
    `${i}${i}return false;`,
    `${i}}`,
    `${i}const content = row.message?.content;`,
    `${i}const text = typeof content === 'string'`,
    `${i}${i}? content`,
    `${i}${i}: Array.isArray(content)`,
    `${i}${i}${i}? content.filter((part${ts ? ': AnyRecord' : ''}) => part?.type === 'text' && typeof part.text === 'string').map((part${ts ? ': AnyRecord' : ''}) => part.text).join('\\n')`,
    `${i}${i}${i}: '';`,
    `${i}const head = text.trimStart();`,
    `${i}return !/^<(task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|user-memory-input)>/.test(head)`,
    `${i}${i}&& !head.startsWith('Caveat:') && !head.startsWith('[Request interrupted') && !head.startsWith('Base directory for this skill:');`,
    '}',
);
const dedupeDoc = (i) => L(
    `${i}// P11: one row per uuid. Two CLI writers on one transcript (or a resumed CLI`,
    `${i}// re-appending history) leave identical uuids behind; the first copy keeps`,
    `${i}// its place and later copies are skipped, so a duplicated prompt is never`,
    `${i}// mistaken for an edit that superseded itself.`,
);
const readerEdits = (ts) => {
    const i = ts ? '  ' : '    ';
    const fnHead = ts
        ? 'async function readTranscriptRows(jsonlPath: string, providerSessionId: string): Promise<AnyRecord[]> {\n  const rows: AnyRecord[] = [];\n'
        : 'async function readTranscriptRows(jsonlPath, providerSessionId) {\n    const rows = [];\n';
    const push = ts
        ? L('      if (entry.sessionId === providerSessionId) {', '        rows.push(entry);', '      }')
        : L('            if (entry.sessionId === providerSessionId) {', '                rows.push(entry);', '            }');
    const pushNew = ts
        ? L('      if (entry.sessionId === providerSessionId) {',
            "        if (typeof entry.uuid === 'string' && entry.uuid) {",
            '          if (p11SeenUuids.has(entry.uuid)) {',
            '            continue;',
            '          }',
            '          p11SeenUuids.add(entry.uuid);',
            '        }',
            '        rows.push(entry);',
            '      }')
        : L('            if (entry.sessionId === providerSessionId) {',
            "                if (typeof entry.uuid === 'string' && entry.uuid) {",
            '                    if (p11SeenUuids.has(entry.uuid)) {',
            '                        continue;',
            '                    }',
            '                    p11SeenUuids.add(entry.uuid);',
            '                }',
            '                rows.push(entry);',
            '            }');
    const dropHead = ts
        ? 'function dropSupersededPromptBranches(rows: AnyRecord[]): AnyRecord[] {\n'
        : 'function dropSupersededPromptBranches(rows) {\n';
    return [
        {
            id: 'reader-dedupe',
            marker: 'p11SeenUuids.add(entry.uuid);',
            pairs: [
                [fnHead, `${fnHead}${dedupeDoc(i)}\n${i}const p11SeenUuids = new Set${ts ? '<string>' : ''}();\n`],
                [push, pushNew],
            ],
        },
        {
            id: 'reader-owner-siblings',
            marker: '!p11IsOwnerPromptRow(row)',
            pairs: [
                [dropHead, `${ownerPromptDoc}\n${ownerPromptBody(i, ts)}\n${dropHead}`],
                ["if (typeof row.parentUuid !== 'string' || !isUserPromptRow(row)) {", "if (typeof row.parentUuid !== 'string' || !p11IsOwnerPromptRow(row)) {"],
            ],
        },
    ];
};

// ------------------------------------------------------------ (2) sessions.db
const archiveUpdateNote = (i) => L(
    `${i}// P11: indexing a transcript write never changes isArchived. Archive and`,
    `${i}// restore are owner actions; a CLI appending to an archived session's file`,
    `${i}// must not bring the session back to the sidebar.`,
);
const archiveConflictNote = (i) => `${i}// P11: the legacy ON CONFLICT path keeps isArchived as well.`;
const sessionsDbEdits = (ts) => {
    const updCase = '           isArchived = CASE WHEN ? IS NULL OR julianday(?) > julianday(updated_at) THEN 0 ELSE isArchived END,\n';
    const conflictCase = '         isArchived = CASE WHEN ? IS NULL OR julianday(excluded.updated_at) > julianday(sessions.updated_at) THEN 0 ELSE sessions.isArchived END,\n';
    const externalNote = (i) => L(
        `${i}// P11: sessions with no app-created row (started outside the app, e.g. from`,
        `${i}// a terminal) are flagged non-destructively: nothing is renamed, hidden or`,
        `${i}// re-keyed, and the flag is never written back. App-created rows are keyed`,
        `${i}// by an app-allocated session_id with the provider id mapped separately, so`,
        `${i}// a row whose session_id equals its provider_session_id was indexed from`,
        `${i}// disk only (the synchronizer keys both id columns with the provider id).`,
    );
    if (!ts) {
        return [
            {
                id: 'sessions-db-external-flag',
                marker: 'P11: sessions with no app-created row',
                pairs: [
                    ['    return {\n        ...row,\n        created_at: normalizeTimestamp(row.created_at) ?? row.created_at,\n        updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,\n    };\n}',
                        L(
                            '    const normalizedRow = {',
                            '        ...row,',
                            '        created_at: normalizeTimestamp(row.created_at) ?? row.created_at,',
                            '        updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,',
                            '    };',
                            ...externalNote('    ').split('\n'),
                            "    normalizedRow.isExternal = typeof row.provider_session_id === 'string' && row.provider_session_id !== '' && row.session_id === row.provider_session_id;",
                            '    return normalizedRow;',
                            '}',
                        )],
                ],
            },
            {
                id: 'sessions-db-update-keeps-archive',
                marker: 'P11: indexing a transcript write never changes isArchived',
                pairs: [
                    ['        if (existing) {\n            db.prepare(`UPDATE sessions SET\n', `        if (existing) {\n${archiveUpdateNote('            ')}\n            db.prepare(\`UPDATE sessions SET\n`],
                    [updCase, ''],
                    ['.run(provider, updatedAtValue, normalizedProjectPath, jsonlPath ?? null, updatedAtValue, updatedAtValue, customName ?? null, existing.session_id);',
                        '.run(provider, updatedAtValue, normalizedProjectPath, jsonlPath ?? null, customName ?? null, existing.session_id);'],
                ],
            },
            {
                id: 'sessions-db-conflict-keeps-archive',
                marker: 'P11: the legacy ON CONFLICT path keeps isArchived',
                pairs: [
                    ['        // covers legacy rows that predate the provider_session_id mapping.\n', `        // covers legacy rows that predate the provider_session_id mapping.\n${archiveConflictNote('        ')}\n`],
                    [conflictCase, ''],
                    ['createdAtValue, updatedAtValue, updatedAtValue);', 'createdAtValue, updatedAtValue);'],
                ],
            },
        ];
    }
    return [
        {
            id: 'sessions-db-external-flag',
            marker: 'P11: sessions with no app-created row',
            pairs: [
                ['  updated_at: string;\n};\n\ntype RecentSessionsPage = {',
                    L(
                        '  updated_at: string;',
                        '  /**',
                        '   * P11: sessions with no app-created row (started outside the app, e.g. from',
                        '   * a terminal) are flagged non-destructively: nothing is renamed, hidden or',
                        '   * re-keyed, and the flag is never written back. App-created rows are keyed',
                        '   * by an app-allocated session_id with the provider id mapped separately, so',
                        '   * a row whose session_id equals its provider_session_id was indexed from',
                        '   * disk only (the synchronizer keys both id columns with the provider id).',
                        '   */',
                        '  isExternal?: boolean;',
                        '};',
                        '',
                        'type RecentSessionsPage = {',
                    )],
                ['  return {\n    ...row,\n    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,\n    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,\n  };\n}',
                    L(
                        '  const normalizedRow = {',
                        '    ...row,',
                        '    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,',
                        '    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,',
                        '  } as SessionRow;',
                        ...externalNote('  ').split('\n'),
                        '  normalizedRow.isExternal =',
                        "    typeof row.provider_session_id === 'string' &&",
                        "    row.provider_session_id !== '' &&",
                        '    row.session_id === row.provider_session_id;',
                        '  return normalizedRow as T;',
                        '}',
                    )],
            ],
        },
        {
            id: 'sessions-db-update-keeps-archive',
            marker: 'P11: indexing a transcript write never changes isArchived',
            pairs: [
                ['    if (existing) {\n      db.prepare(\n        `UPDATE sessions SET\n', `    if (existing) {\n${archiveUpdateNote('      ')}\n      db.prepare(\n        \`UPDATE sessions SET\n`],
                [updCase, ''],
                [L('        jsonlPath ?? null,', '        updatedAtValue,', '        updatedAtValue,', '        customName ?? null,', '        existing.session_id'),
                    L('        jsonlPath ?? null,', '        customName ?? null,', '        existing.session_id')],
            ],
        },
        {
            id: 'sessions-db-conflict-keeps-archive',
            marker: 'P11: the legacy ON CONFLICT path keeps isArchived',
            pairs: [
                ['    // covers legacy rows that predate the provider_session_id mapping.\n', `    // covers legacy rows that predate the provider_session_id mapping.\n${archiveConflictNote('    ')}\n`],
                [conflictCase, ''],
                [L('      createdAtValue,', '      updatedAtValue,', '      updatedAtValue', '    );'), L('      createdAtValue,', '      updatedAtValue', '    );')],
            ],
        },
    ];
};

// ------------------------------------------------------------- (4) dispatcher
const dispatcherHelpers = (i, ts) => L(
    '// P11: queued-draft guards (WO-2). Each one fails open: an unreadable or',
    '// malformed runtime state file, an unparseable time or a guard error never',
    '// blocks a send. The runtime state file is written by the provider runtime',
    '// ([{appSessionId, providerSessionId, pid, state, since}]); an entry counts',
    '// only while its pid is alive.',
    `function p11RuntimeStateFile()${ts ? ': string' : ''} {`,
    `${i}return process.env.CLOUDCLI_RUNTIME_STATE || '/run/cloudcli/runtime-state.json';`,
    '}',
    "const P11_BUSY_STATES = new Set(['in-turn', 'bg-work', 'retiring']);",
    'const P11_STALE_DRAFT_MS = 30 * 60 * 1000;',
    'const P11_DISPATCHED_DRAFTS_MAX = 1000;',
    `const p11DispatchedDrafts = new Set${ts ? '<string>' : ''}();`,
    `function p11PidAlive(pid${ts ? ': unknown' : ''})${ts ? ': boolean' : ''} {`,
    `${i}if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {`,
    `${i}${i}return false;`,
    `${i}}`,
    `${i}try {`,
    `${i}${i}return !p11Fs.existsSync('/proc/self') || p11Fs.existsSync(\`/proc/\${pid}\`);`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}return false;`,
    `${i}}`,
    '}',
    `function p11RuntimeBusy(sessionId${ts ? ': string' : ''})${ts ? ': boolean' : ''} {`,
    `${i}try {`,
    `${i}${i}const entries${ts ? ': unknown' : ''} = JSON.parse(p11Fs.readFileSync(p11RuntimeStateFile(), 'utf8'));`,
    `${i}${i}if (!Array.isArray(entries)) {`,
    `${i}${i}${i}return false;`,
    `${i}${i}}`,
    `${i}${i}return entries.some((entry${ts ? ': { appSessionId?: unknown; providerSessionId?: unknown; state?: unknown; pid?: unknown } | null' : ''}) => !!entry && typeof entry === 'object'`,
    `${i}${i}${i}&& (entry.appSessionId === sessionId || entry.providerSessionId === sessionId)`,
    `${i}${i}${i}&& P11_BUSY_STATES.has(String(entry.state))`,
    `${i}${i}${i}&& p11PidAlive(entry.pid));`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}return false;`,
    `${i}}`,
    '}',
    '// The stored draft has no id column, so its id is the hash of what was',
    '// queued: user, session and the exact stored queued-message JSON.',
    `function p11DraftId(candidate${ts ? ': QueuedSessionMessageRecord' : ''})${ts ? ': string' : ''} {`,
    `${i}const token = typeof candidate.claimToken === 'string' ? candidate.claimToken : JSON.stringify(candidate.queuedMessage ?? null);`,
    `${i}return p11CreateHash('sha256').update(JSON.stringify([candidate.userId, candidate.sessionId, token])).digest('hex');`,
    '}',
    `function p11RememberDraft(candidate${ts ? ': QueuedSessionMessageRecord' : ''})${ts ? ': void' : ''} {`,
    `${i}try {`,
    `${i}${i}p11DispatchedDrafts.add(p11DraftId(candidate));`,
    `${i}${i}while (p11DispatchedDrafts.size > P11_DISPATCHED_DRAFTS_MAX) {`,
    `${i}${i}${i}const oldest = p11DispatchedDrafts.values().next().value;`,
    `${i}${i}${i}if (oldest === undefined) {`,
    `${i}${i}${i}${i}break;`,
    `${i}${i}${i}}`,
    `${i}${i}${i}p11DispatchedDrafts.delete(oldest);`,
    `${i}${i}}`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}// Bookkeeping never blocks a send.`,
    `${i}}`,
    '}',
    `function p11QueuedDraftDropReason(candidate${ts ? ': QueuedSessionMessageRecord' : ''}, queuedAt${ts ? ': string | null' : ''})${ts ? ': string | null' : ''} {`,
    `${i}try {`,
    `${i}${i}if (p11DispatchedDrafts.has(p11DraftId(candidate))) {`,
    `${i}${i}${i}return 'the same draft was already dispatched';`,
    `${i}${i}}`,
    `${i}${i}const queuedAtMs = parseP8Timestamp(queuedAt);`,
    `${i}${i}if (queuedAtMs !== null && Date.now() - queuedAtMs > P11_STALE_DRAFT_MS) {`,
    `${i}${i}${i}return 'stale draft, queued more than 30 min ago';`,
    `${i}${i}}`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}// Fail open.`,
    `${i}}`,
    `${i}return null;`,
    '}',
);
const dispatcherEdits = (ts) => {
    const i = ts ? '  ' : '    ';
    const importAnchor = ts
        ? "import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';"
        : "import { scheduledMessagesDb, sessionDraftsDb } from '../../../modules/database/index.js';";
    // P8 loop body, as apply.sh writes it (dist 12/16/20, TS 10/14/18 spaces).
    const [a, b, c] = ts ? [' '.repeat(10), ' '.repeat(14), ' '.repeat(18)] : [' '.repeat(12), ' '.repeat(16), ' '.repeat(20)];
    const p8Body = L(
        `${a}if (message?.kind === 'text' && message?.role === 'user' && typeof message.content === 'string') {`,
        `${b}if (message.content.trim() !== content.trim()) {`,
        `${c}return false;`,
        `${b}}`,
        `${b}const sentAtMs = parseP8Timestamp(message.timestamp);`,
        `${b}const queuedAtMs = parseP8Timestamp(queuedAt);`,
        `${b}if (sentAtMs === null || queuedAtMs === null) {`,
        `${c}return false;`,
        `${b}}`,
        `${b}const ageMs = queuedAtMs - sentAtMs;`,
        `${b}return ageMs >= -5_000 && ageMs <= 120_000;`,
        `${a}}`,
    );
    const p11Body = L(
        `${a}// P11: ANY user row among the last 10 history messages with the same`,
        `${a}// trimmed text makes the queued turn a duplicate, however long ago it was`,
        `${a}// sent (the P8 120 s window let stale re-queued drafts through).`,
        `${a}if (message?.kind === 'text' && message?.role === 'user' && typeof message.content === 'string'`,
        `${b}&& message.content.trim() === content.trim()) {`,
        `${b}return true;`,
        `${a}}`,
    );
    const readMsg = 'const message = readQueuedMessage(candidate.queuedMessage);';
    const guard = L(
        readMsg,
        `${i}const p11DropReason = message ? p11QueuedDraftDropReason(candidate, queuedAt) : null;`,
        `${i}if (p11DropReason) {`,
        `${i}${i}console.warn(\`[ScheduledMessages] Dropped a queued message for session \${candidate.sessionId}: \${p11DropReason}.\`);`,
        `${i}${i}sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);`,
        `${i}${i}return;`,
        `${i}}`,
    );
    const restoreTail = L(
        `${i}if (!result.started && result.error === 'A run was already in progress for this session.') {`,
        `${i}${i}sessionDraftsDb.restoreQueuedMessage(candidate);`,
        `${i}${i}return;`,
        `${i}}`,
        `${i}sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);`,
    );
    const restoreTailNew = L(
        `${i}if (!result.started && result.error === 'A run was already in progress for this session.') {`,
        `${i}${i}sessionDraftsDb.restoreQueuedMessage(candidate);`,
        `${i}${i}return;`,
        `${i}}`,
        `${i}if (result?.started) {`,
        `${i}${i}p11RememberDraft(candidate);`,
        `${i}}`,
        `${i}sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);`,
    );
    return [
        {
            id: 'dispatcher-imports',
            marker: "import p11Fs from 'node:fs';",
            pairs: [[importAnchor, `import p11Fs from 'node:fs';\nimport { createHash as p11CreateHash } from 'node:crypto';\n${importAnchor}`]],
        },
        {
            id: 'dispatcher-helpers',
            marker: 'function p11QueuedDraftDropReason(',
            pairs: [['async function sendClaimedQueuedMessage(', `${dispatcherHelpers(i, ts)}\nasync function sendClaimedQueuedMessage(`]],
        },
        {
            id: 'dispatcher-history-any-of-last-10',
            marker: 'P11: ANY user row among the last 10 history messages',
            pairs: [
                [p8Body, p11Body],
                [': identical to the last user message.`);', ': identical to a user message among the last 10.`);'],
            ],
        },
        {
            id: 'dispatcher-draft-guards',
            marker: 'const p11DropReason = message ? p11QueuedDraftDropReason(candidate, queuedAt) : null;',
            pairs: [[readMsg, guard], [restoreTail, restoreTailNew]],
        },
        {
            id: 'dispatcher-runtime-busy',
            marker: '|| p11RuntimeBusy(candidate.sessionId)',
            pairs: [['if (chatRunRegistry.isProcessing(candidate.sessionId)) {', 'if (chatRunRegistry.isProcessing(candidate.sessionId) || p11RuntimeBusy(candidate.sessionId)) {']],
        },
    ];
};

// ------------------------------------------------------------------ (5) Shell
const shellHelpers = (i, ts) => L(
    '// P11: one live CLI per session (R7). The provider runtime lists every live',
    '// CLI in the runtime state file; resuming a session that still has a live',
    '// entry (any state, idle-held included) from the Shell tab would put a',
    '// second writer on its transcript. A missing or unreadable file means no',
    '// live entry.',
    `function p11ShellPidAlive(pid${ts ? ': unknown' : ''})${ts ? ': boolean' : ''} {`,
    `${i}if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {`,
    `${i}${i}return false;`,
    `${i}}`,
    `${i}try {`,
    `${i}${i}return !fs.existsSync('/proc/self') || fs.existsSync(\`/proc/\${pid}\`);`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}return false;`,
    `${i}}`,
    '}',
    ts
        ? 'function p11LiveRuntimeEntry(appSessionId: string | null, providerSessionId: string): { pid?: unknown; state?: unknown } | null {'
        : 'function p11LiveRuntimeEntry(appSessionId, providerSessionId) {',
    `${i}try {`,
    `${i}${i}const file = process.env.CLOUDCLI_RUNTIME_STATE || '/run/cloudcli/runtime-state.json';`,
    `${i}${i}const entries${ts ? ': unknown' : ''} = JSON.parse(fs.readFileSync(file, 'utf8'));`,
    `${i}${i}if (!Array.isArray(entries)) {`,
    `${i}${i}${i}return null;`,
    `${i}${i}}`,
    `${i}${i}return entries.find((entry${ts ? ': { appSessionId?: unknown; providerSessionId?: unknown; pid?: unknown; state?: unknown } | null' : ''}) => !!entry && typeof entry === 'object'`,
    `${i}${i}${i}&& ((!!appSessionId && entry.appSessionId === appSessionId) || (!!providerSessionId && (entry.providerSessionId === providerSessionId || entry.appSessionId === providerSessionId)))`,
    `${i}${i}${i}&& p11ShellPidAlive(entry.pid)) ?? null;`,
    `${i}}`,
    `${i}catch {`,
    `${i}${i}return null;`,
    `${i}}`,
    '}',
);
const shellEdits = (ts) => {
    const i = ts ? '  ' : '    ';
    const mapLine = ts ? 'const ptySessionsMap = new Map<string, PtySessionEntry>();' : 'const ptySessionsMap = new Map();';
    const resumeOld = L(
        `${i}if (resumeSessionId) {`,
        `${i}${i}if (os.platform() === 'win32') {`,
        `${i}${i}${i}return \`claude --resume "\${resumeSessionId}"\${bypassFlag}; if ($LASTEXITCODE -ne 0) { claude\${bypassFlag} }\`;`,
        `${i}${i}}`,
        `${i}${i}return \`claude --resume "\${resumeSessionId}"\${bypassFlag} || claude\${bypassFlag}\`;`,
        `${i}}`,
    );
    const resumeNew = L(
        `${i}if (resumeSessionId) {`,
        `${i}${i}// P11: no fresh-session fallback. A failed resume stays visible in the`,
        `${i}${i}// terminal instead of silently starting a NEW conversation.`,
        `${i}${i}return \`claude --resume "\${resumeSessionId}"\${bypassFlag}\`;`,
        `${i}}`,
    );
    const ind = ts ? ' '.repeat(8) : ' '.repeat(16);
    const initAnchor = L(
        `${ind}const shellCommand = buildShellCommand(data, dependencies);`,
        `${ind}const resumeSessionId = resolveResumeSessionId(data, dependencies);`,
    );
    const initNew = L(
        initAnchor,
        `${ind}// P11: refuse to resume a session whose CLI is still live in CloudCLI.`,
        `${ind}const p11Live = resumeSessionId && shellCommand.startsWith('claude --resume ')`,
        `${ind}${i}? p11LiveRuntimeEntry(sessionId, resumeSessionId)`,
        `${ind}${i}: null;`,
        `${ind}if (p11Live) {`,
        `${ind}${i}const p11Message = \`Session \${resumeSessionId} is held by a live CloudCLI process (pid \${String(p11Live.pid)}, state \${String(p11Live.state ?? 'unknown')}). Continue it in the chat; the Shell tab will not start a second process on it.\`;`,
        `${ind}${i}ws.send(JSON.stringify({ type: 'output', data: \`\\x1b[33m\${p11Message}\\x1b[0m\\r\\n\` }));`,
        `${ind}${i}ws.send(JSON.stringify({ type: 'error', message: p11Message }));`,
        `${ind}${i}return;`,
        `${ind}}`,
    );
    return [
        {
            id: 'shell-helpers',
            marker: 'function p11LiveRuntimeEntry(',
            pairs: [[mapLine, `${mapLine}\n${shellHelpers(i, ts)}`]],
        },
        {
            id: 'shell-no-fallback',
            marker: 'P11: no fresh-session fallback.',
            pairs: [[resumeOld, resumeNew]],
        },
        {
            id: 'shell-refuse-live',
            marker: 'P11: refuse to resume a session whose CLI is still live in CloudCLI.',
            pairs: [[initAnchor, initNew]],
        },
    ];
};

const D = 'dist-server/server/modules';
const S = 'server/modules';
const TARGETS = [
    { rel: `${D}/providers/list/claude/claude-sessions.provider.js`, ts: false, edits: readerEdits(false) },
    { rel: `${S}/providers/list/claude/claude-sessions.provider.ts`, ts: true, edits: readerEdits(true) },
    { rel: `${D}/database/repositories/sessions.db.js`, ts: false, edits: sessionsDbEdits(false) },
    { rel: `${S}/database/repositories/sessions.db.ts`, ts: true, edits: sessionsDbEdits(true) },
    { rel: `${D}/scheduled-messages/services/scheduled-message-dispatcher.service.js`, ts: false, edits: dispatcherEdits(false), requires: 'parseP8Timestamp' },
    { rel: `${S}/scheduled-messages/services/scheduled-message-dispatcher.service.ts`, ts: true, edits: dispatcherEdits(true), requires: 'parseP8Timestamp' },
    { rel: `${D}/websocket/services/shell-websocket.service.js`, ts: false, edits: shellEdits(false) },
    { rel: `${S}/websocket/services/shell-websocket.service.ts`, ts: true, edits: shellEdits(true) },
];

let ts = null;
function tsDiagnostics(text) {
    if (ts === null) {
        try {
            ts = createRequire(path.join(pkg, 'package.json'))('typescript');
        }
        catch {
            ts = false;
        }
    }
    if (!ts) {
        return null;
    }
    const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return (out.diagnostics ?? []).length;
}

const count = (hay, needle) => hay.split(needle).length - 1;
let n = 0;
for (const target of TARGETS) {
    const abs = path.join(pkg, target.rel);
    if (!fs.existsSync(abs)) {
        fail(`target not found: ${target.rel}`);
        continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const pending = target.edits.filter((edit) => !src.includes(edit.marker));
    if (pending.length === 0) {
        note(`P11 already applied: ${target.rel}`);
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
    if (target.ts) {
        const before = tsDiagnostics(src);
        const after = tsDiagnostics(out);
        if (before === null || after === null) {
            note(`TS parse check skipped (typescript not resolvable): ${target.rel}`);
        }
        else if (after > before) {
            fail(`TypeScript parse diagnostics rose ${before} -> ${after} in ${target.rel}`);
            continue;
        }
        else {
            note(`TS parse check OK (diagnostics ${before} -> ${after}): ${target.rel}`);
        }
    }
    else {
        n += 1;
        const probe = path.join(work, `check-${n}.mjs`);
        fs.writeFileSync(probe, out);
        const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
        if (r.status !== 0) {
            fail(`node --check failed for ${target.rel}: ${(r.stderr || '').split('\n').slice(0, 4).join(' | ')}`);
            continue;
        }
    }
    const bak = `${abs}.bak-pre-p11`;
    if (!fs.existsSync(bak)) {
        fs.copyFileSync(abs, bak);
    }
    const mode0 = fs.statSync(abs).mode & 0o7777;
    const tmp = `${abs}.p11-tmp`;
    fs.writeFileSync(tmp, out);
    fs.chmodSync(tmp, mode0);
    fs.renameSync(tmp, abs);
    note(`P11 patched (${pending.map((edit) => edit.id).join(', ')}): ${target.rel}`);
}
if (problems > 0) {
    console.error(mode === 'check' ? `check FAILED: ${problems} P11 edit(s) missing` : `P11 apply FAILED: ${problems} problem(s)`);
    process.exit(1);
}
note(mode === 'check' ? 'check OK: all P11 edits present' : 'P11 apply OK');
NODE
node "$WORK/p11-patcher.mjs" "$MODE" "$PKG" "$WORK"
