#!/usr/bin/env bash
# Idempotent patches for @cloudcli-ai/cloudcli 1.37.3 (WO-E1 + WO-G1).
# Usage:
#   ./apply.sh [TARGET_ROOT]         apply all patches (default: install root above patches/)
#   ./apply.sh --check [TARGET_ROOT]  verify every patch is present, change nothing; exit 1 if any is missing
# TARGET_ROOT must contain node_modules/@cloudcli-ai/cloudcli (used to test on a copy
# under /var/tmp/claude/ without touching the live install or restarting the service).
# Patches:
#   P0 BG_WAIT_CEILING_MS env override (pre-existing; dist + TS source)
#   P1 async-subagent "running" status: without a <task-notification>, a subagent whose
#      transcript was touched within CLOUDCLI_SUBAGENT_LIVE_MS (default 600000) stays
#      "running" even when its timeline does not end mid tool call (worker waiting on its
#      own background Bash job).
#   P2 read-only /api/bg-tasks API (list a session's background Bash jobs + output tail).
#   P3 subagent timeline keeps the LAST MAX_TRANSMITTED_SUBAGENT_ACTIVITIES (200)
#      steps instead of the first (long agents no longer look frozen) and the
#      message carries subagentHiddenEarlier:<n> (0 if none) end to end
#      (raw message -> toolResultMap -> normalized message -> shared types).
#   P4 /api/bg-tasks extended (backward compatible): agents[] + sessionWorking +
#      lastWriteAt on GET /, agent tail GET /agents/:agentId/tail, and
#      GET /active working-session list (same module files as P2).
#   P5 Cloudflare Access JWT validation at the origin (FP-2, finding S1):
#      files/access-jwt.js (node:crypto RS256) + app-wide REST guard mounted
#      before every route + WS upgrade guard in the shared gateway (covers
#      /ws, /shell, /desktop-notifications, /plugin-ws/*). Enabled ONLY when
#      CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN are both set.
#   P6 OpenCode synchronizer indexes only top-level sessions: OpenCode stores
#      subagent runs as child rows (session.parent_id set); the sync listing
#      indexed them too, flooding the sidebar with duplicate-looking entries
#      (~820 of 1027 rows today). Adds "AND s.parent_id IS NULL" to the ONE
#      listing query in synchronizeRows (both the full sync and the watcher
#      limit path); lookups by id elsewhere are untouched.
#   P7 Claude title extractor prefers custom-title > ai-title > last-prompt:
#      extractSessionAiTitleFromEnd scanned backwards and returned the FIRST
#      matching event, so a last-prompt written after an ai-title/custom-title
#      event hid the real title. Each kind is now remembered (most recent
#      occurrence wins per kind) anywhere in the scanned tail, with custom-title
#      returned immediately and last-prompt only as the fallback.
#   P8 Duplicate guard in the queued-draft dispatcher: a draft queued while a
#      run is active ("Queue next message") is dispatched as a NEW turn once
#      the session is idle (30 s poll) — including a re-submit identical to the
#      session's last user message (e.g. after an abort), so owner messages
#      arrived 2-3x. sendClaimedQueuedMessage now drops a queued turn whose
#      trimmed text equals the trimmed text of the last user text message in
#      sessionsService.fetchHistory(sessionId, {limit: 10, offset: 0}) AND that
#      message's timestamp is within 120 s before the turn was queued (the
#      draft's updated_at, read before the claim overwrites it) — so an
#      intentional repeat of the same words still sends. Missing/unparseable
#      timestamps send (fail-open). The draft gets the same cleanup as a sent
#      one and one console.warn line (without the content). Any history error
#      falls through and sends.
#   P9 one process per conversation (claude-runtime.provider.js + files/
#      claude-prompt-queue.js, dist and server src): a new turn for a session
#      whose CLI is still alive (stdin held open while background agents run)
#      is PUSHED into that live process instead of superseding it with a fresh
#      spawn, and every event (follow-up turns + background completions)
#      streams to the session's CURRENT WebSocket writer. Reuse requires:
#      entry active, stream unreleased, beginTurn present, no resumeAnchorId/
#      resumeFromScratch (an edited message must replay a truncated transcript,
#      which only a fresh process can do), identical model/effort/
#      permissionMode/cwd/allowedTools/disallowedTools, AND an unchanged
#      settings fingerprint (~/.claude.json + user/project/local settings,
#      stat-only). Turns of ANY origin (seed, pushed, self-driven background
#      follow-up) are tracked as in-flight: a push proceeds only at a turn
#      boundary, settles only on its OWN result, and can never release stdin
#      under a queued push or work still owed. Anything else keeps today's
#      supersede-then-spawn path unchanged. Abort still interrupts the live
#      instance; the BG ceiling still reaps abandoned ones. apply.sh keeps a
#      .bak-pre-p9 rollback copy, restores it on any failure, and completes
#      partial applies on re-run (per-marker guarded insertions).
#   P9r root-cause fix pass for P9 (2026-10-08, live evidence: reuse never
#      engaged - five fresh CLI spawns for one session, two of them 81 s
#      apart with identical options; see the P9r section below for detail):
#      (R1) a completed turn with nothing outstanding now HOLDS the process
#      for reuse until the idle ceiling instead of releasing stdin at the
#      result, so the next compatible turn is pushed into the SAME process;
#      (R2) an incompatible turn gracefully RETIRES the live process
#      (release at a turn boundary - never a mid-turn interrupt; a bounded
#      backstop ends a turn that never ends - never an orphan); (R3) the
#      spawn fingerprint normalises per-start volatile MCP values (token-like
#      env values, header values, URL query strings) so rotating credentials
#      cannot defeat reuse while real config changes still respawn. Keeps a
#      .bak-pre-p9r rollback copy (the P9 state). APPLY_P9R=0 applies P9
#      only (negative-control mode). Regression tests: test/p9r-one-process.test.mjs.
set -euo pipefail
MODE=apply
if [ "${1:-}" = "--check" ]; then MODE=check; shift; fi
PATCHES_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ $# -ge 1 ]; then cd "$1"; else cd "$PATCHES_DIR/.."; fi
PKG="node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found under $(pwd)" >&2; exit 1; }
PROVIDER_DIST="$PKG/dist-server/server/modules/providers/list/claude"
PROVIDER_SRC="$PKG/server/modules/providers/list/claude"
INDEX_DIST="$PKG/dist-server/server/index.js"
INDEX_SRC="$PKG/server/index.ts"
BG_DIR_DIST="$PKG/dist-server/server/modules/bg-tasks"
BG_DIR_SRC="$PKG/server/modules/bg-tasks"
FAILURES=0

note()    { echo "[$MODE] $*"; }
missing() { echo "[$MODE] MISSING: $*" >&2; FAILURES=$((FAILURES + 1)); }

# --- P0: BG_WAIT_CEILING_MS env override -------------------------------------
patch_p0() {
  local f
  for f in "$PROVIDER_DIST/claude-runtime.provider.js" "$PROVIDER_SRC/claude-runtime.provider.js"; do
    [ -f "$f" ] || continue
    if grep -q 'CLOUDCLI_BG_WAIT_CEILING_MS' "$f"; then
      note "P0 already applied: $f"
      continue
    fi
    if [ "$MODE" = check ]; then missing "P0 $f"; continue; fi
    sed -i "s#const BG_WAIT_CEILING_MS = 30 \* 60 \* 1000;#const BG_WAIT_CEILING_MS = parseInt(process.env.CLOUDCLI_BG_WAIT_CEILING_MS, 10) || 30 * 60 * 1000;#" "$f"
    grep -q 'CLOUDCLI_BG_WAIT_CEILING_MS' "$f" && note "P0 patched: $f" || { echo "P0 PATCH FAILED: $f" >&2; exit 1; }
  done
}

# --- P1: subagent-live helper file -------------------------------------------
patch_p1_copy() {
  local d="$1"
  [ -d "$d" ] || return 0
  if [ "$MODE" = check ]; then
    if cmp -s "$PATCHES_DIR/files/subagent-live.js" "$d/subagent-live.js"; then
      note "P1 ok: $d/subagent-live.js"
    else
      missing "P1 $d/subagent-live.js"
    fi
    return 0
  fi
  cp "$PATCHES_DIR/files/subagent-live.js" "$d/subagent-live.js"
  note "P1 copied: $d/subagent-live.js"
}

# --- P1: provider edit ($1=file, $2=statement indent, $3=object-property indent)
patch_p1_file() {
  local f="$1" SI="$2" PI="$3"
  [ -f "$f" ] || return 0
  if grep -q 'isSubagentStillLive' "$f"; then
    note "P1 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P1 $f"; return 0; fi
  sed -i \
    -e "/^import { sessionsDb } from/a import { isSubagentStillLive } from './subagent-live.js';" \
    -e "/const \[transcript, meta\] = await Promise.all(\[/i\\${SI}const transcriptMtime = await fsp.stat(located.transcriptPath).then((s) => s.mtimeMs, () => 0);" \
    -e "/endedMidToolCall: transcript.endedMidToolCall,/a\\${PI}transcriptMtime," \
    -e 's#&& (!subagent || subagent.endedMidToolCall);#\&\& (!subagent || subagent.endedMidToolCall || isSubagentStillLive(subagent));#' \
    -e "/^${SI}endedMidToolCall: boolean;/a\\${SI}transcriptMtime: number;" \
    "$f"
  grep -q 'isSubagentStillLive(subagent)' "$f" && note "P1 patched: $f" || { echo "P1 PATCH FAILED: $f" >&2; exit 1; }
}

# --- P2: bg-tasks module files -----------------------------------------------
patch_p2_copy() {
  local d base
  for d in "$BG_DIR_DIST" "$BG_DIR_SRC"; do
    base="$(dirname "$d")"
    [ -d "$base" ] || continue
    if [ "$MODE" = check ]; then
      if cmp -s "$PATCHES_DIR/files/bg-tasks.service.js" "$d/bg-tasks.service.js" \
         && cmp -s "$PATCHES_DIR/files/bg-tasks.routes.js" "$d/bg-tasks.routes.js"; then
        note "P2 ok: $d"
      else
        missing "P2 $d"
      fi
      continue
    fi
    mkdir -p "$d"
    cp "$PATCHES_DIR/files/bg-tasks.service.js" "$PATCHES_DIR/files/bg-tasks.routes.js" "$d/"
    note "P2 copied: $d"
  done
}

# --- P2: route mounting in the server entrypoint ------------------------------
patch_p2_mount() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -q 'bgTasksRoutes' "$f"; then
    note "P2 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P2 $f"; return 0; fi
  sed -i \
    -e "/^import { fileTreeRoutes } from/a import { bgTasksRoutes } from './modules/bg-tasks/bg-tasks.routes.js';" \
    -e "/^app.use('\/api\/providers', authenticateToken, providerRoutes);/a app.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);" \
    "$f"
  grep -q "app.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);" "$f" \
    && note "P2 patched: $f" || { echo "P2 PATCH FAILED: $f" >&2; exit 1; }
}

patch_p0
patch_p1_copy "$PROVIDER_DIST"
patch_p1_copy "$PROVIDER_SRC"
patch_p1_file "$PROVIDER_DIST/claude-sessions.provider.js" "            " "                "
patch_p1_file "$PROVIDER_SRC/claude-sessions.provider.ts" "      " "        "
patch_p2_copy
patch_p2_mount "$INDEX_DIST"
patch_p2_mount "$INDEX_SRC"
# --- P3: subagent timeline keeps the LAST 200 activities -----------------------
# ($1=file, $2=loop indent, $3=record indent, $4=toolResultMap indent, $5=msg indent)
patch_p3_file() {
  local f="$1" SI="$2" PI="$3" MAP="$4" MSG="$5"
  [ -f "$f" ] || return 0
  if grep -q 'subagentHiddenEarlier' "$f"; then
    note "P3 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P3 $f"; return 0; fi
  sed -i \
    -e 's#\.slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)#.slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)#' \
    -e "/activity: transcript\.activity/i\\${PI}hiddenEarlier: Math.max(0, transcript.activity.length - MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)," \
    -e "/const toolUseId = readAgentToolUseId(message);/i\\${SI}message.subagentHiddenEarlier = subagent?.hiddenEarlier ?? 0;" \
    -e "/subagent: raw.subagent,/a\\${MAP}subagentHiddenEarlier: raw.subagentHiddenEarlier," \
    -e "/msg.subagent = toolResult.subagent;/a\\${MSG}msg.subagentHiddenEarlier = toolResult.subagentHiddenEarlier ?? 0;" \
    "$f"
  grep -q 'subagentHiddenEarlier' "$f" && note "P3 patched: $f" || { echo "P3 PATCH FAILED: $f" >&2; exit 1; }
}

# --- P3: TS-only type declarations ---------------------------------------------
# provider.ts ClaudeToolResult + shared/types.ts NormalizedMessage gain the field.
# Distinct marker: patch_p3_file already writes other subagentHiddenEarlier uses.
patch_p3_types() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -q 'subagentHiddenEarlier?: number;' "$f"; then
    note "P3 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P3 $f"; return 0; fi
  sed -i -e "/subagent?: SubagentInfo;/a\\  subagentHiddenEarlier?: number;" "$f"
  grep -q 'subagentHiddenEarlier?: number;' "$f" && note "P3 patched: $f" || { echo "P3 PATCH FAILED: $f" >&2; exit 1; }
}

# --- P3: TS-only Map value type (must run AFTER P1 inserted transcriptMtime) ---
patch_p3_maptype() {
  local f="$1" SI="$2"
  [ -f "$f" ] || return 0
  if grep -q 'hiddenEarlier: number;' "$f"; then
    note "P3 maptype already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P3 maptype $f"; return 0; fi
  sed -i -e "/^${SI}transcriptMtime: number;/a\\${SI}hiddenEarlier: number;" "$f"
  grep -q 'hiddenEarlier: number;' "$f" && note "P3 maptype patched: $f" || { echo "P3 MAPTYPE PATCH FAILED: $f" >&2; exit 1; }
}

TYPES_SRC="$PKG/server/shared/types.ts"

patch_p3_file "$PROVIDER_DIST/claude-sessions.provider.js" "            " "                " "                            " "                "
patch_p3_file "$PROVIDER_SRC/claude-sessions.provider.ts" "      " "        " "              " "        "
patch_p3_maptype "$PROVIDER_SRC/claude-sessions.provider.ts" "      "
patch_p3_types "$PROVIDER_SRC/claude-sessions.provider.ts"
patch_p3_types "$TYPES_SRC"

# --- P5: Cloudflare Access JWT validation at the origin (FP-2) -----------------
AUTH_DIST="$PKG/dist-server/server/modules/auth"
AUTH_SRC="$PKG/server/modules/auth"
WS_SVC_DIST="$PKG/dist-server/server/modules/websocket/services/websocket-server.service.js"
WS_SVC_SRC="$PKG/server/modules/websocket/services/websocket-server.service.ts"

patch_p5_copy() {
  local d="$1"
  [ -d "$d" ] || return 0
  if [ "$MODE" = check ]; then
    if cmp -s "$PATCHES_DIR/files/access-jwt.js" "$d/access-jwt.js"; then
      note "P5 ok: $d/access-jwt.js"
    else
      missing "P5 $d/access-jwt.js"
    fi
    return 0
  fi
  cp "$PATCHES_DIR/files/access-jwt.js" "$d/access-jwt.js"
  note "P5 copied: $d/access-jwt.js"
}

patch_p5_index() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -q 'accessRestMiddleware' "$f"; then
    note "P5 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P5 $f"; return 0; fi
  sed -i \
    -e "/from '\.\/modules\/auth\/index\.js';/a import { accessRestMiddleware } from './modules/auth/access-jwt.js';" \
    -e "/^app\.get('\/health'/i app.use(accessRestMiddleware);" \
    "$f"
  grep -q 'accessRestMiddleware' "$f" && note "P5 patched: $f" || { echo "P5 PATCH FAILED: $f" >&2; exit 1; }
}

patch_p5_ws() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -q 'guardAccessWebSocketUpgrade(info, cb' "$f"; then
    note "P5 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P5 $f"; return 0; fi
  # dist form is a one-liner; the TS form is multi-line (param line + body line).
  sed -i \
    -e "/websocket-auth\.service\.js';/a import { guardAccessWebSocketUpgrade } from '../../auth/access-jwt.js';" \
    -e "s#verifyClient: ((info) => verifyWebSocketClient(info, dependencies.verifyClient)),#verifyClient: ((info, cb) => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),"# \
    -e "s#^      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>\[0\]\$#      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0], cb#" \
    -e "s#^    ) => verifyWebSocketClient(info, dependencies.verifyClient)),\$#    ) => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),"# \
    "$f"
  grep -q 'guardAccessWebSocketUpgrade(info, cb' "$f" && note "P5 patched: $f" || { echo "P5 PATCH FAILED: $f" >&2; exit 1; }
}

patch_p5_copy "$AUTH_DIST"
patch_p5_copy "$AUTH_SRC"
patch_p5_index "$INDEX_DIST"
patch_p5_index "$INDEX_SRC"
patch_p5_ws "$WS_SVC_DIST"
patch_p5_ws "$WS_SVC_SRC"

# --- P6: OpenCode synchronizer indexes only top-level sessions -----------------
OC_SYNC_DIST="$PKG/dist-server/server/modules/providers/list/opencode/opencode-session-synchronizer.provider.js"
OC_SYNC_SRC="$PKG/server/modules/providers/list/opencode/opencode-session-synchronizer.provider.ts"

patch_p6_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -q 's\.parent_id IS NULL' "$f"; then
    note "P6 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P6 $f"; return 0; fi
  sed -i "s#WHERE s\.time_archived IS NULL#WHERE s.time_archived IS NULL\n          AND s.parent_id IS NULL#" "$f"
  grep -q 's\.parent_id IS NULL' "$f" && note "P6 patched: $f" || { echo "P6 PATCH FAILED: $f" >&2; exit 1; }
}

# --- P7: Claude title extractor custom > ai > last-prompt ----------------------
# ($1=file, $2=header-anchor line, $3=decl indent, $4=return-line indent,
#  $5=nested indent, $6=final-return-line indent)
patch_p7_file() {
  local f="$1" HA="$2" DI="$3" RI="$4" NI="$5" FI="$6"
  [ -f "$f" ] || return 0
  if grep -q 'bestAiTitle' "$f"; then
    note "P7 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P7 $f"; return 0; fi
  # Declarations go at FUNCTION scope (after the header, before try) so the
  # post-loop return can read them; the early "return aiTitle || ..." is
  # replaced with per-kind collection; \& escapes sed's whole-match "&".
  # The final "return undefined;" is rewritten ONLY when a line consists of
  # exactly that (anchored ^<indent>...$), and the post-check fails loudly
  # unless the replacement happened exactly once (a decoy or duplicated
  # match must never pass silently).
  local repl="${RI}if (eventType === 'custom-title') {\n${NI}return claudeRenamedTitle;\n${RI}}\n${RI}if (eventType === 'ai-title' \&\& !bestAiTitle) {\n${NI}bestAiTitle = aiTitle;\n${RI}}\n${RI}if (eventType === 'last-prompt' \&\& !bestLastPrompt) {\n${NI}bestLastPrompt = lastPrompt;\n${RI}}\n${RI}continue;"
  sed -i \
    -e "/${HA}/a\\${DI}let bestAiTitle;" \
    -e "/${HA}/a\\${DI}let bestLastPrompt;" \
    -e "s#^${RI}return aiTitle || lastPrompt || claudeRenamedTitle;\$#${repl}#" \
    -e "s#^${FI}return undefined;\$#${FI}return bestAiTitle || bestLastPrompt || undefined;#" \
    "$f"
  local final_count collect_count
  final_count="$(grep -c "^${FI}return bestAiTitle || bestLastPrompt || undefined;\$" "$f" || true)"
  collect_count="$(grep -c "^${NI}bestLastPrompt = lastPrompt;\$" "$f" || true)"
  if [ "$final_count" -eq 1 ] && [ "$collect_count" -eq 1 ]; then
    note "P7 patched: $f"
  else
    echo "P7 PATCH FAILED: $f (final-return replacements: ${final_count}, collect insertions: ${collect_count}; expected exactly 1 of each)" >&2
    exit 1
  fi
}

patch_p6_file "$OC_SYNC_DIST"
patch_p6_file "$OC_SYNC_SRC"
patch_p7_file "$PKG/dist-server/server/modules/providers/list/claude/claude-session-synchronizer.provider.js" "async extractSessionAiTitleFromEnd(filePath, sessionId) {" "        " "                    " "                        " "        "
patch_p7_file "$PKG/server/modules/providers/list/claude/claude-session-synchronizer.provider.ts" "): Promise<string | undefined> {" "    " "          " "            " "    "

# --- P8: duplicate guard in the queued-draft dispatcher -------------------------
# ($1=file, $2=import statement, $3=sendClaimed header anchor, $4=new header line,
#  $5=TS param-insert anchor ('' = none), $6=parse-fn header, $7=helper header,
#  $8=guard-if indent, $9=helper body indent, ${10}=claim anchor,
#  ${11}=capture indent, ${12}=call anchor)
SCHED_DIST="$PKG/dist-server/server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js"
SCHED_SRC="$PKG/server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts"

patch_p8_file() {
  local f="$1" IMP="$2" HA="$3" NEWHA="$4" TSPA="$5" PH="$6" HF="$7" DI="$8" MI="$9" CLAIM="${10}" CI="${11}" CALL="${12}"
  [ -f "$f" ] || return 0
  if grep -q 'isDuplicateOfLastUserMessage' "$f" && grep -q 'Dropped a queued message' "$f"; then
    note "P8 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P8 $f"; return 0; fi
  # Literal backticks and ${} are escaped for bash, && for sed's replacement.
  # queuedAt is the draft's updated_at read BEFORE the claim overwrites it
  # (session-drafts.db.js claimQueuedMessage sets updated_at = CURRENT_TIMESTAMP):
  # the queued JSON itself carries no timestamp (client queue payload is
  # {content, attachments, uploadedAttachments, options}).
  local parse="// P8: a queued turn identical to the session's last user message is a\n// duplicate re-submit (e.g. after an abort); drop it instead of sending it\n// again, but only when that message landed within 120 s before the turn was\n// queued (5 s slack: the queue time has second precision), so an intentional repeat of the same words still sends. Times that\n// are missing or unparseable send (fail-open).\n${PH}\n${MI}if (typeof value !== 'string' || value.trim() === '') {\n${MI}    return null;\n${MI}}\n${MI}const isoLike = value.trim().replace(' ', 'T');\n${MI}const hasZone = /[Zz]|[+-][0-9]/.test(isoLike.slice(-6));\n${MI}const parsedMs = Date.parse(hasZone ? isoLike : isoLike + 'Z');\n${MI}return Number.isFinite(parsedMs) ? parsedMs : null;\n}"
  local helper="${parse}\n${HF}\n${MI}try {\n${MI}    const history = await sessionsService.fetchHistory(sessionId, { limit: 10, offset: 0 });\n${MI}    const messages = Array.isArray(history?.messages) ? history.messages : [];\n${MI}    for (let index = messages.length - 1; index >= 0; index -= 1) {\n${MI}        const message = messages[index];\n${MI}        if (message?.kind === 'text' \&\& message?.role === 'user' \&\& typeof message.content === 'string') {\n${MI}            if (message.content.trim() !== content.trim()) {\n${MI}                return false;\n${MI}            }\n${MI}            const sentAtMs = parseP8Timestamp(message.timestamp);\n${MI}            const queuedAtMs = parseP8Timestamp(queuedAt);\n${MI}            if (sentAtMs === null || queuedAtMs === null) {\n${MI}                return false;\n${MI}            }\n${MI}            const ageMs = queuedAtMs - sentAtMs;\n${MI}            return ageMs >= -5_000 \&\& ageMs <= 120_000;\n${MI}        }\n${MI}    }\n${MI}    return false;\n${MI}}\n${MI}catch {\n${MI}    return false;\n${MI}}\n}"
  local guard="${DI}if (message \&\& await isDuplicateOfLastUserMessage(candidate.sessionId, message.content, queuedAt)) {\n${MI}    console.warn(\\\`[ScheduledMessages] Dropped a queued message for session \\\${candidate.sessionId}: identical to the last user message.\\\`);\n${MI}    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);\n${MI}    return;\n${DI}}"
  local capture="${CI}// P8: the claim overwrites updated_at, so read the queue time first.\n${CI}const queuedDraft = sessionDraftsDb.getDrafts(candidate.userId).find((draft) => draft.scope === candidate.sessionId);\n${CI}const queuedAt = queuedDraft?.updatedAt ?? null;"
  local -a exprs=(
    "-e" "/^import { chatRunRegistry, runDetachedChatTurn } from/a\\${IMP}"
    "-e" "s#^${HA}\$#${helper}\n${NEWHA}#"
    "-e" "s#^${DI}const message = readQueuedMessage(candidate.queuedMessage);\$#&\n${guard}#"
    "-e" "s#^${CLAIM}\$#${capture}\n${CLAIM}#"
    "-e" "s#^${CALL}\$#${CI}await sendClaimedQueuedMessage(candidate, queuedAt, runtime);#"
  )
  if [ -n "$TSPA" ]; then
    exprs+=("-e" "/^${TSPA}\$/a\\  queuedAt: string | null,")
  fi
  sed -i "${exprs[@]}" "$f"
  if grep -q 'isDuplicateOfLastUserMessage' "$f" && grep -q 'Dropped a queued message' "$f" && grep -q 'getDrafts(candidate.userId)' "$f"; then
    note "P8 patched: $f"
  else
    echo "P8 PATCH FAILED: $f" >&2
    exit 1
  fi
}

patch_p8_file "$SCHED_DIST" \
  "import { sessionsService } from '../../../modules/providers/services/sessions.service.js';" \
  "async function sendClaimedQueuedMessage(candidate, runtime) {" \
  "async function sendClaimedQueuedMessage(candidate, queuedAt, runtime) {" \
  "" \
  "function parseP8Timestamp(value) {" \
  "async function isDuplicateOfLastUserMessage(sessionId, content, queuedAt) {" \
  "    " "    " \
  "        if (!sessionDraftsDb.claimQueuedMessage(candidate)) {" \
  "        " \
  "        await sendClaimedQueuedMessage(candidate, runtime);"
patch_p8_file "$SCHED_SRC" \
  "import { sessionsService } from '@/modules/providers/services/sessions.service.js';" \
  "async function sendClaimedQueuedMessage(" \
  "async function sendClaimedQueuedMessage(" \
  "  candidate: QueuedSessionMessageRecord," \
  "function parseP8Timestamp(value: unknown): number | null {" \
  "async function isDuplicateOfLastUserMessage(sessionId: string, content: string, queuedAt: string | null): Promise<boolean> {" \
  "  " "  " \
  "    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {" \
  "    " \
  "    await sendClaimedQueuedMessage(candidate, runtime);"

# --- P9: one process per conversation ----------------------------------------
# Helper: sed range-replace with a multi-line block via a temp script FILE
# (the -e form lexically joins backslash-newlines and breaks c\ text; -f keeps
# per-line c-text continuations). Every block line except the last ends with a
# backslash continuation.
p9_c_range() {
  local f="$1" start="$2" end="$3" block="$4" out="" line tmp
  local total n=0
  total="$(printf '%s\n' "$block" | wc -l)"
  while IFS= read -r line; do
    n=$((n + 1))
    out+="$line"
    if [ "$n" -lt "$total" ]; then out+="\\"; fi
    out+=$'\n'
  done <<< "$block"
  tmp="$(mktemp)"
  # \@regex@ custom address delimiters: the patterns contain '/' (comment
  # anchors), which would terminate /.../ addresses early.
  printf '\\@%s@,\\@%s@c\\\n%s' "$start" "$end" "${out%$'\n'}" > "$tmp"
  sed -i -f "$tmp" "$f"
  rm -f "$tmp"
}

patch_p9_copy() {
  local d="$1"
  [ -d "$d" ] || return 0
  if [ "$MODE" = check ]; then
    if cmp -s "$PATCHES_DIR/files/claude-prompt-queue.js" "$d/claude-prompt-queue.js"; then
      note "P9 ok: $d/claude-prompt-queue.js"
    else
      missing "P9 $d/claude-prompt-queue.js"
    fi
    return 0
  fi
  cp "$PATCHES_DIR/files/claude-prompt-queue.js" "$d/claude-prompt-queue.js"
  note "P9 copied: $d/claude-prompt-queue.js"
}

# Full verification of a P9-patched provider file: every marker present,
# exactly ONE queue import, and the file still parses. Used by apply mode
# (restore-on-failure) and --check mode. P9r note: the queued-push release
# guard ('pushGateWaiters.length + imminentPushes') only exists in P9-final
# files - P9r replaces it with the unconditional idle hold - so either marker
# satisfies this check; p9r_verify() gates the P9r state itself.
p9_verify() {
  local f="$1" imports tmpcheck
  grep -q 'return createPushablePromptStream(messages);' "$f" || return 1
  grep -q 'const beginTurn = (messages, writer) =>' "$f" || return 1
  grep -q 'imminentPushes' "$f" || return 1
  grep -q 'resultIsForPushedTurn' "$f" || return 1
  grep -q 'pumpPushGate' "$f" || return 1
  grep -q 'drainPushedTurns();' "$f" || return 1
  grep -q 'currentWriter().send(' "$f" || return 1
  grep -q 'settingsFp' "$f" || return 1
  { grep -q 'pushGateWaiters.length + imminentPushes' "$f" || grep -q 'P9r: the live process STAYS held' "$f"; } || return 1
  imports="$(grep -c "from './claude-prompt-queue.js';" "$f" || true)"
  [ "$imports" -eq 1 ] || return 1
  tmpcheck="$(mktemp --suffix=.mjs)"
  cp "$f" "$tmpcheck"
  node --check "$tmpcheck" 2>/dev/null || { rm -f "$tmpcheck"; return 1; }
  rm -f "$tmpcheck"
  return 0
}

# The edits themselves. Every insertion is guarded by its own marker, so a
# partial apply (crash, killed shell) is COMPLETED by a re-run instead of
# growing duplicate insertions. The two global rewrites and the stock-line
# neutralizer are naturally idempotent (their patterns stop matching).
p9_apply_edits() {
  local f="$1" A="$2"
  local B="$A$A" C="$A$A$A" E="$A$A$A$A$A"
  # Import of the queue module, right after the utils import.
  if ! grep -q "from './claude-prompt-queue.js';" "$f"; then
    sed -i -e "/^import { createCompleteMessage, createNormalizedMessage } from/a import { createPushablePromptStream, computeSpawnFingerprint } from '.\/claude-prompt-queue.js';" "$f"
  fi
  # createHeldPromptStream body -> delegation to the pushable queue.
  if ! grep -q 'return createPushablePromptStream(messages);' "$f"; then
    p9_c_range "$f" 'function createHeldPromptStream(messages) {' '^}' "function createHeldPromptStream(messages) {
${A}    // P9: pushable queue (./claude-prompt-queue.js) - identical semantics
${A}    // when nothing is pushed (seed messages, then park until release);
${A}    // push() lets a follow-up turn join THIS process's stdin.
${A}    return createPushablePromptStream(messages);
}"
  fi
  # Early supersede release -> moved below the P9 compatibility check.
  if ! grep -q 'P9: the supersede release of a previous hold' "$f"; then
    p9_c_range "$f" "^${A}// A new turn supersedes any earlier one still holding" "^${A}}\$" "${A}// P9: the supersede release of a previous hold moved below, after the
${A}// live-instance compatibility check - a compatible follow-up turn is
${A}// pushed into the live process instead of releasing it."
  fi
  # currentWriter + in-flight/pushed-turn bookkeeping at function scope (the
  # finally block must be able to drain waiters).
  if ! grep -q 'const turnWaiters = \[\];' "$f"; then
    sed -i -e "s#^${A}let queryInstance = null;\$#&\n${A}// P9: every event of this run must reach the session's CURRENT writer -\n${A}// a pushed follow-up turn re-binds the activeSessions entry to a newer\n${A}// WebSocket - falling back to the last writer this run was bound to (the\n${A}// entry is gone by the time the catch block reports a crash).\n${A}let lastBoundWriter = ws;\n${A}const currentWriter = () => {\n${A}    const entry = sessionKey() ? getSession(sessionKey()) : null;\n${A}    return entry \&\& entry.instance === queryInstance \&\& entry.writer ? entry.writer : lastBoundWriter;\n${A}};\n${A}// P9: pushed-turn bookkeeping (function scope so the finally can drain).\n${A}// turnInFlight marks the turn that owns the next 'result', of ANY origin:\n${A}// the seed prompt, a pushed follow-up, or a self-driven turn (background\n${A}// follow-up, Monitor wake-up) revealed by its first event. inFlightIsPushed\n${A}// tells whether that result may settle a pushed waiter. Pushes proceed\n${A}// only at a turn boundary with no other push outstanding; imminentPushes\n${A}// counts a boundary that just opened one, so the release decision cannot\n${A}// close stdin out from under a push that is landing right now.\n${A}const turnWaiters = [];\n${A}const pushGateWaiters = [];\n${A}let turnInFlight = false;\n${A}let inFlightIsPushed = false;\n${A}let imminentPushes = 0;\n${A}const pumpPushGate = () => {\n${A}    if (turnInFlight || turnWaiters.length > 0 || pushGateWaiters.length === 0) {\n${A}        return;\n${A}    }\n${A}    imminentPushes += 1;\n${A}    pushGateWaiters.shift()(true);\n${A}};\n${A}const settlePushedTurn = () => {\n${A}    const waiter = turnWaiters.shift();\n${A}    if (waiter) {\n${A}        waiter();\n${A}    }\n${A}    pumpPushGate();\n${A}};\n${A}const drainPushedTurns = () => {\n${A}    while (turnWaiters.length > 0) {\n${A}        turnWaiters.shift()();\n${A}    }\n${A}    const parked = pushGateWaiters.splice(0);\n${A}    for (const open of parked) {\n${A}        open(true);\n${A}    }\n${A}};#" "$f"
  fi
  # Reuse decision (options + settings fingerprint) before the MCP load - a
  # reused process keeps its own spawn-time MCP set and settings.
  if ! grep -q 'reuseEntry.compat.settingsFp' "$f"; then
    sed -i -e "s#^${B}const mcpServers = await loadMcpConfig(options.cwd);\$#${B}// P9: one process per conversation. If this session still has a live, held\n${B}// instance spawned with the same resolved options AND an unchanged config\n${B}// fingerprint (settings files + resolved MCP set: a reused process keeps\n${B}// its spawn-time MCP set and settings), push this turn into it instead of\n${B}// superseding it with a new process; the follow-up turn and any later\n${B}// background completions then all come from the one process, on the CURRENT\n${B}// writer. An edited message (resume anchor / scratch) must replay a\n${B}// truncated transcript, which only a fresh process can do.\n${B}const settingsFp = await computeSpawnFingerprint(options.cwd, await loadMcpConfig(options.cwd));\n${B}const reuseEntry = sessionKey() ? getSession(sessionKey()) : null;\n${B}const reuseCompat = Boolean(reuseEntry\n${B}    \&\& reuseEntry.status === 'active'\n${B}    \&\& reuseEntry.instance\n${B}    \&\& reuseEntry.promptQueue\n${B}    \&\& !reuseEntry.promptQueue.isReleased()\n${B}    \&\& typeof reuseEntry.beginTurn === 'function'\n${B}    \&\& reuseEntry.compat\n${B}    \&\& !options.resumeAnchorId\n${B}    \&\& !options.resumeFromScratch\n${B}    \&\& reuseEntry.compat.model === sdkOptions.model\n${B}    \&\& reuseEntry.compat.effort === (sdkOptions.effort ?? null)\n${B}    \&\& reuseEntry.compat.permissionMode === (sdkOptions.permissionMode ?? null)\n${B}    \&\& reuseEntry.compat.cwd === (sdkOptions.cwd ?? null)\n${B}    \&\& reuseEntry.compat.allowedTools === JSON.stringify(sdkOptions.allowedTools || [])\n${B}    \&\& reuseEntry.compat.disallowedTools === JSON.stringify(sdkOptions.disallowedTools || [])\n${B}    \&\& reuseEntry.compat.settingsFp === settingsFp);\n${B}if (reuseCompat) {\n${B}    try {\n${B}        const reuseMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);\n${B}        await reuseEntry.beginTurn(reuseMessages, ws);\n${B}        return;\n${B}    }\n${B}    catch (pushError) {\n${B}        // The live run died between the check and the push; fall through\n${B}        // to a fresh process, exactly like the old path.\n${B}        console.warn('[Claude SDK] P9 push failed, spawning instead:', pushError?.message || pushError);\n${B}    }\n${B}}\n${B}else {\n${B}    // A new turn supersedes any earlier one still holding this session's\n${B}    // process open, so held runs cannot stack up across a conversation\n${B}    // (original behaviour, now after the compatibility check).\n${B}    reuseEntry?.releaseInput?.();\n${B}}\n&#" "$f"
  fi
  # beginTurn + sessionExtras, right before the instance is tracked.
  if ! grep -q 'const beginTurn = (messages, writer) =>' "$f"; then
    sed -i -e "s#^${B}// Track the query instance for abort capability\$#${B}// P9: beginTurn delivers a follow-up turn into THIS process. It waits for\n${B}// a turn boundary (no turn in flight of ANY origin, no other push\n${B}// outstanding), re-binds the session's writer to the caller's socket,\n${B}// resets the per-turn flags (heldForBackgroundWork deliberately KEPT:\n${B}// background work owed by earlier turns must survive the push), re-arms\n${B}// the idle timer, pushes onto the held stdin queue, and resolves when\n${B}// that turn's OWN result is processed. There is NO timeout fallback to\n${B}// spawning a second process: a queued turn waits for the in-flight turn;\n${B}// if the process dies first, the ownership check throws and the caller\n${B}// falls back to a single fresh spawn. Abort still interrupts the live\n${B}// instance and drains everything.\n${B}const beginTurn = (messages, writer) => {\n${B}    const ready = !turnInFlight \&\& turnWaiters.length === 0\n${B}        \&\& pushGateWaiters.length === 0 \&\& imminentPushes === 0\n${B}        ? Promise.resolve(false)\n${B}        : new Promise((resolve) => {\n${B}            pushGateWaiters.push(resolve);\n${B}        });\n${B}    return ready.then((wasPumped) => {\n${B}        if (wasPumped) {\n${B}            imminentPushes -= 1;\n${B}        }\n${B}        const entry = sessionKey() ? getSession(sessionKey()) : null;\n${B}        if (!entry || entry.instance !== queryInstance\n${B}            || !entry.promptQueue || entry.promptQueue.isReleased()) {\n${B}            throw new Error('P9: live run is no longer pushable');\n${B}        }\n${B}        entry.writer = writer;\n${B}        lastBoundWriter = writer;\n${B}        turnCompleteSent = false;\n${B}        backgroundWorkPending = false;\n${B}        assistantBudgetSent = false;\n${B}        turnInFlight = true;\n${B}        inFlightIsPushed = true;\n${B}        scheduleRelease();\n${B}        return new Promise((resolveWaiter) => {\n${B}            turnWaiters.push(resolveWaiter);\n${B}            heldPrompt.push(messages);\n${B}        });\n${B}    });\n${B}};\n${B}const sessionExtras = {\n${B}    promptQueue: heldPrompt,\n${B}    compat: {\n${B}        model: sdkOptions.model,\n${B}        effort: sdkOptions.effort ?? null,\n${B}        permissionMode: sdkOptions.permissionMode ?? null,\n${B}        cwd: sdkOptions.cwd ?? null,\n${B}        allowedTools: JSON.stringify(sdkOptions.allowedTools || []),\n${B}        disallowedTools: JSON.stringify(sdkOptions.disallowedTools || []),\n${B}        settingsFp\n${B}    },\n${B}    beginTurn\n${B}};\n\n&#" "$f"
  fi
  # addSession: signature + entry fields + extras at both call sites.
  if ! grep -q ', extras = null) {' "$f"; then
    sed -i -e "s#^function addSession(sessionId, queryInstance, writer = null, releaseInput = null) {\$#function addSession(sessionId, queryInstance, writer = null, releaseInput = null, extras = null) {#" "$f"
  fi
  if ! grep -q 'promptQueue: extras?.promptQueue' "$f"; then
    sed -i -e "s#^${B}releaseInput: releaseInput || carried?.releaseInput || null\$#${B}releaseInput: releaseInput || carried?.releaseInput || null,\n${B}// P9: pushable stdin queue + turn handle + the spawn-options\n${B}// signature, so a compatible follow-up turn can adopt this live\n${B}// process instead of a new one being spawned.\n${B}promptQueue: extras?.promptQueue || carried?.promptQueue || null,\n${B}beginTurn: extras?.beginTurn || carried?.beginTurn || null,\n${B}compat: extras?.compat || carried?.compat || null#" "$f"
  fi
  if ! grep -q ', sessionExtras);' "$f"; then
    sed -i -e "s#addSession(sessionKey(), queryInstance, ws, releasePromptStream);#addSession(sessionKey(), queryInstance, ws, releasePromptStream, sessionExtras);#" "$f"
  fi
  # All run/canUseTool emits go to the CURRENT writer, not the closure ws.
  # Naturally idempotent: no ws.send( / 'writer: ws,' survives the first run.
  sed -i \
    -e "s#ws\.send(#currentWriter().send(#g" \
    -e "s#writer: ws,#writer: currentWriter(),#" \
    "$f"
  # An event while no turn is marked in flight reveals a self-driven turn.
  if ! grep -q 'P9: an event while no turn is marked in flight' "$f"; then
    sed -i -e "s#^${C}// Transform and normalize message via adapter\$#${C}// P9: an event while no turn is marked in flight reveals a self-driven\n${C}// turn (background follow-up, Monitor wake-up): it owns the next\n${C}// 'result', and no pushed waiter may settle on that result.\n${C}if (message.type !== 'result' \&\& !turnInFlight) {\n${C}    turnInFlight = true;\n${C}    inFlightIsPushed = false;\n${C}}\n${C}// Transform and normalize message via adapter#" "$f"
  fi
  # The seed prompt is the first in-flight turn (self-origin).
  if ! grep -q 'P9: the seed prompt is the first in-flight turn' "$f"; then
    sed -i -e "s#^${B}console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');\$#${B}// P9: the seed prompt is the first in-flight turn (self-origin).\n${B}turnInFlight = true;\n${B}inFlightIsPushed = false;\n${B}console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');#" "$f"
  fi
  # Result processing: snapshot the turn origin, settle only the turn that
  # owns this result, and only ever let ONE queued push proceed per boundary.
  if ! grep -q 'resultIsForPushedTurn = inFlightIsPushed' "$f"; then
    sed -i -e "s#^${C}if (message.type === 'result') {\$#${C}if (message.type === 'result') {\n${C}// P9: which turn does this result close? Snapshot and clear the\n${C}// in-flight markers FIRST, and settle the pushed waiter only if this\n${C}// result belongs to a pushed turn - a self-driven (background\n${C}// follow-up) result NEVER settles a waiter. Resolvers run as\n${C}// microtasks, so the rest of this branch still completes before any\n${C}// queued push proceeds.\n${C}const resultIsForPushedTurn = inFlightIsPushed;\n${C}turnInFlight = false;\n${C}inFlightIsPushed = false;\n${C}if (resultIsForPushedTurn) {\n${C}    settlePushedTurn();\n${C}}\n${C}else {\n${C}    pumpPushGate();\n${C}}#" "$f"
  fi
  # Guarded release: never close stdin while a pushed turn is un-resulted,
  # and keep the hold when earlier background work has not reported yet.
  # P9r note: on a P9r-final file this guard's marker is gone (P9r replaced
  # the guarded release with the unconditional idle hold) - the whole block,
  # including the dead-line cleanup below, must be a NO-OP there, or the
  # cleanup would blank P9r's own releasePromptStream() calls.
  if ! grep -q 'pushGateWaiters.length + imminentPushes' "$f" && ! grep -q 'P9r: the live process STAYS held' "$f"; then
    sed -i -e "s#^${E}heldForBackgroundWork = false;\$#${E}if (!(resultIsForPushedTurn \&\& heldForBackgroundWork)) {\n${E}    // Either nothing was backgrounded, or the background work just\n${E}    // reported in - let the CLI exit now, as it always has - unless a\n${E}    // pushed turn is still queued behind this one.\n${E}    heldForBackgroundWork = false;\n${E}    if (turnWaiters.length + pushGateWaiters.length + imminentPushes === 0) {\n${E}        releasePromptStream();\n${E}    }\n${E}}\n${E}else {\n${E}    // A pushed turn ended while background work from an earlier turn is\n${E}    // still outstanding: keep the process held open for that follow-up.\n${E}    scheduleRelease();\n${E}}#" "$f"
    # The stock unguarded release line right below is now dead: remove it
    # (naturally idempotent - the pattern stops matching once removed).
    sed -i -e "s#^${E}releasePromptStream();\$##" "$f"
  fi
  # A run that ends with pushes outstanding releases their waiters.
  if ! grep -q 'drainPushedTurns();' "$f"; then
    sed -i -e "s#^${B}releasePromptStream();\$#${B}// P9: abort/crash/supersede/bg-ceiling must not hang pushed turns.\n${B}drainPushedTurns();\n&#" "$f"
  fi
}

# ($1=file, $2=base indent: dist 4 spaces, server src 2 spaces)
patch_p9_file() {
  local f="$1" A="$2"
  [ -f "$f" ] || return 0
  if p9_verify "$f"; then
    note "P9 already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P9 $f"; return 0; fi
  # Rollback artifact: the ORIGINAL pre-P9 file, created once and kept.
  if [ ! -f "$f.bak-pre-p9" ]; then
    cp -a "$f" "$f.bak-pre-p9"
  fi
  p9_apply_edits "$f" "$A"
  if p9_verify "$f"; then
    note "P9 patched: $f (backup: $f.bak-pre-p9)"
  else
    cp -a "$f.bak-pre-p9" "$f"
    echo "P9 PATCH FAILED: $f (restored from $f.bak-pre-p9)" >&2
    exit 1
  fi
}

# --- P9r: root-cause fix pass for P9 (2026-10-08 evening evidence) ------------
# Live finding: reuse NEVER engaged for ordinary turns. A turn that ends with
# no background work still called releasePromptStream() immediately (the stock
# per-turn lifecycle P9 had kept), so by the time the next turn arrived the
# process was gone and every turn spawned a fresh CLI (journal 2026-10-08:
# five "Starting async generator loop" spawns for session 494751be at 16:39,
# 18:06, 18:36, 20:07, 20:09 - the last pair just 81 s apart with identical
# options). Incompatible turns (the session switched permissionMode mid-day)
# additionally superseded via the legacy interrupt+release, and a superseded
# run whose turn never ends (hours-long waits) kept its process alive with no
# server-side bound. P9r changes, all inside the P9 framework:
#   R1 IDLE HOLD FOR REUSE: after a completed turn with nothing outstanding the
#      process is now HELD (scheduleRelease, BG_WAIT_CEILING_MS-bounded,
#      re-armed on activity) instead of released, so a compatible follow-up
#      turn within the idle window is pushed into the SAME process. The
#      terminal `complete` still goes out at the turn result, which is what
#      frees the chat run registry - holding does not block the next turn.
#   R2 GRACEFUL SUPERSEDE: an incompatible turn (model/effort/permission/cwd/
#      MCP/settings change, edited message) RETIRES the live process instead
#      of interrupting it: stdin closes at a turn boundary (immediately if
#      idle, else when the in-flight turn's own result lands - the turn is
#      never killed mid-flight), and a backstop timer always interrupts after
#      BG_WAIT_CEILING_MS. A retired run's remaining events still stream via
#      the currentWriter fallback. Never an orphan, never a hard mid-turn kill.
#   R3 FINGERPRINT VOLATILITY: files/claude-prompt-queue.js now normalises
#      per-start volatile MCP values (credential-like env KEYS keep their name
#      but contribute '*', header maps contribute names only, url/serverUrl
#      query strings are stripped) before hashing, so rotating minted tokens
#      can never defeat reuse while real config changes still respawn.
# APPLY_P9R=0 in the environment applies/verifies P9 only (negative-control
# mode for the P9r regression tests).
p9r_verify() {
  local f="$1" imports tmpcheck
  grep -q 'const retire = () => {' "$f" || return 1
  grep -q 'retiredInstances' "$f" || return 1
  grep -q 'retired || turnInFlight' "$f" || return 1
  grep -q 'retired || !entry' "$f" || return 1
  grep -q 'P9r: an incompatible turn retires' "$f" || return 1
  grep -q 'P9r: the live process STAYS held' "$f" || return 1
  grep -q 'P9r: a retired (superseded) run' "$f" || return 1
  grep -q 'clearTimeout(retireTimer)' "$f" || return 1
  grep -q 'retire: extras?.retire' "$f" || return 1
  imports="$(grep -c "from './claude-prompt-queue.js';" "$f" || true)"
  [ "$imports" -eq 1 ] || return 1
  tmpcheck="$(mktemp --suffix=.mjs)"
  cp "$f" "$tmpcheck"
  node --check "$tmpcheck" 2>/dev/null || { rm -f "$tmpcheck"; return 1; }
  rm -f "$tmpcheck"
  return 0
}

p9r_apply_edits() {
  local f="$1" A="$2"
  local B="$A$A" D="$A$A$A$A" E="$A$A$A$A$A"
  # Module level: the gracefully-retired instance registry, next to the
  # existing supersededInstances WeakSet.
  if ! grep -q 'retiredInstances' "$f"; then
    sed -i -e "s#^const supersededInstances = new WeakSet();\$#&\n// P9r: instances gracefully retired by a newer, incompatible run (see\n// retire()); addSession must not interrupt them a second time.\nconst retiredInstances = new WeakSet();#" "$f"
  fi
  # addSession: graceful retire for P9 entries, legacy interrupt for the rest.
  # The stock block is dist-formatted (4-space steps) in dist-server but
  # prettier-formatted in server src, so the range anchors are
  # whitespace-tolerant; only this block matches between them.
  if ! grep -q 'P9r: prefer a GRACEFUL retire' "$f"; then
    p9_c_range "$f" "if (superseding)" "existing.releaseInput?.();" "${A}if (superseding) {
${A}    // P9r: prefer a GRACEFUL retire of a P9 live entry over the legacy
${A}    // interrupt: the retiring run closes stdin at its turn boundary (now,
${A}    // if idle) and a bounded backstop interrupts a turn that never ends,
${A}    // so a superseded process is never left behind as an orphan.
${A}    if (retiredInstances.has(existing.instance)) {
${A}        // Already retired by the incoming turn's compatibility check; its
${A}        // own backstop owns the wind-down - do not interrupt again.
${A}    }
${A}    else if (typeof existing.retire === 'function') {
${A}        retiredInstances.add(existing.instance);
${A}        try {
${A}            existing.retire();
${A}        }
${A}        catch (error) {
${A}            console.error(\`Error retiring superseded run for session \${sessionId}:\`, error?.message || error);
${A}        }
${A}    }
${A}    else {
${A}        supersededInstances.add(existing.instance);
${A}        Promise.resolve()
${A}            .then(() => existing.instance.interrupt())
${A}            .catch((error) => {
${A}            console.error(\`Error interrupting superseded run for session \${sessionId}:\`, error?.message || error);
${A}        });
${A}        existing.releaseInput?.();
${A}    }"
  fi
  # addSession entry: carry the retire handle alongside the other P9 extras.
  if ! grep -q 'retire: extras?.retire' "$f"; then
    sed -i -e "s#^${B}compat: extras?.compat || carried?.compat || null\$#${B}compat: extras?.compat || carried?.compat || null,\n${B}// P9r: graceful-supersede handle for incompatible follow-up turns.\n${B}retire: extras?.retire || carried?.retire || null#" "$f"
  fi
  # Run-scope retire state, right after the pushed-turn bookkeeping.
  if ! grep -q 'let retired = false;' "$f"; then
    sed -i -e "s#^${A}let imminentPushes = 0;\$#&\n${A}// P9r: graceful-supersede state. retired marks a run whose session was\n${A}// taken over by an incompatible spawn; it admits no new pushes and winds\n${A}// down at its turn boundary. retireTimer is the hard backstop.\n${A}let retired = false;\n${A}let retireTimer = null;#" "$f"
  fi
  # A retiring run admits no new pushes.
  if ! grep -q 'retired || turnInFlight' "$f"; then
    sed -i -e "s#^${A}    if (turnInFlight || turnWaiters.length > 0 || pushGateWaiters.length === 0) {#${A}    // P9r: a retiring run admits no new pushes.\n${A}    if (retired || turnInFlight || turnWaiters.length > 0 || pushGateWaiters.length === 0) {#" "$f"
  fi
  # beginTurn: never push into a retiring run.
  if ! grep -q 'retired || !entry' "$f"; then
    sed -i -e "s#^${B}        if (!entry || entry.instance !== queryInstance#${B}        // P9r: never push into a retiring run.\n${B}        if (retired || !entry || entry.instance !== queryInstance#" "$f"
  fi
  # retire() + wiring into sessionExtras, right before the instance is tracked.
  if ! grep -q 'const retire = () => {' "$f"; then
    sed -i -e "s#^${B}const sessionExtras = {#${B}// P9r: retire() starts this run's graceful wind-down, invoked by a newer,\n${B}// incompatible run that took over the session. At a turn boundary stdin\n${B}// closes immediately (the CLI then winds down within its bg-wait ceiling);\n${B}// mid-turn the release lands when the in-flight turn's own result arrives,\n${B}// so a live turn is never killed under the owner's feet. A backstop timer\n${B}// always interrupts after BG_WAIT_CEILING_MS, so a turn that never ends\n${B}// cannot orphan the process. Remaining events still stream out through\n${B}// the currentWriter fallback.\n${B}const retire = () => {\n${B}    retired = true;\n${B}    supersededInstances.add(queryInstance);\n${B}    const atBoundary = !turnInFlight \&\& turnWaiters.length === 0\n${B}        \&\& pushGateWaiters.length === 0 \&\& imminentPushes === 0;\n${B}    if (atBoundary) {\n${B}        releasePromptStream();\n${B}    }\n${B}    if (!retireTimer) {\n${B}        retireTimer = setTimeout(() => {\n${B}            retireTimer = null;\n${B}            releasePromptStream();\n${B}            Promise.resolve().then(() => queryInstance?.interrupt?.()).catch(() => { });\n${B}        }, BG_WAIT_CEILING_MS);\n${B}        retireTimer.unref?.();\n${B}    }\n${B}};\n${B}const sessionExtras = {#" "$f"
  fi
  if ! grep -q "^${B}    beginTurn,\$" "$f"; then
    sed -i -e "s#^${B}    beginTurn\$#${B}    beginTurn,\n${B}    retire#" "$f"
  fi
  # The compatibility-check else branch: graceful retire instead of a bare
  # release (the release stays as the fallback for non-P9 entries).
  if ! grep -q 'P9r: an incompatible turn retires' "$f"; then
    sed -i -e "s#^${B}    reuseEntry?.releaseInput?.();\$#${B}    // P9r: an incompatible turn retires the live process gracefully: stdin\n${B}    // closes at its turn boundary and a backstop bounds a stuck in-flight\n${B}    // turn - never an orphan, never a hard mid-turn kill.\n${B}    if (reuseEntry \&\& retiredInstances.has(reuseEntry.instance)) {\n${B}        // Already draining for a newer run; nothing further to do here.\n${B}    }\n${B}    else if (reuseEntry \&\& typeof reuseEntry.retire === 'function') {\n${B}        retiredInstances.add(reuseEntry.instance);\n${B}        try {\n${B}            reuseEntry.retire();\n${B}        }\n${B}        catch (error) {\n${B}            console.warn('[Claude SDK] P9r retire failed:', error?.message || error);\n${B}        }\n${B}    }\n${B}    else {\n${B}        reuseEntry?.releaseInput?.();\n${B}    }#" "$f"
  fi
  # Result branch, part 1: a retired run releases at its own turn boundary,
  # ahead of the background-work hold. (The stock if sits at 4*A indent.)
  if ! grep -q 'P9r: a retired (superseded) run' "$f"; then
    sed -i -e "s#^${D}if (backgroundWorkPending) {#${D}// P9r: a retired (superseded) run winds down at its turn boundary -\n${D}// after its in-flight turn, never mid-turn; the retire() backstop\n${D}// interrupts a turn that never ends. Never an orphan.\n${D}if (retired) {\n${D}    releasePromptStream();\n${D}}\n${D}else if (backgroundWorkPending) {#" "$f"
  fi
  # Result branch, part 2: replace the whole stock else body - after a
  # completed turn the process STAYS held for reuse (idle-ceiling bounded)
  # instead of being released. Start: the stock comment above the P9 block
  # (present verbatim in both a fresh P9 apply and the live install); end:
  # the stock else closer at 4*A indent.
  if ! grep -q 'P9r: the live process STAYS held' "$f"; then
    p9_c_range "$f" "^${E}// Either nothing was backgrounded, or the background work just\$" "^${D}}\$" "${E}// P9r: the live process STAYS held for reuse after every completed turn
${E}// (idle-ceiling bounded): the next compatible turn pushes into it instead
${E}// of respawning, which is what one-process-per-conversation requires.
${E}if (resultIsForPushedTurn \&\& heldForBackgroundWork) {
${E}    // A pushed turn ended while background work from an earlier turn is
${E}    // still outstanding: keep heldForBackgroundWork set so that work's
${E}    // follow-up reports through the bg-completion branch.
${E}}
${E}else {
${E}    heldForBackgroundWork = false;
${E}}
${E}scheduleRelease();
${D}}"
  fi
  # finally: the retire backstop dies with the run. (Anchored on the P9
  # drainPushedTurns comment, which is P9-injected and indent-consistent in
  # both trees - the stock finally block is not.)
  if ! grep -q 'clearTimeout(retireTimer)' "$f"; then
    sed -i -e "s#^${B}// P9: abort/crash/supersede/bg-ceiling must not hang pushed turns.\$#${B}// P9r: the retire backstop dies with the run.\n${B}if (retireTimer) {\n${B}    clearTimeout(retireTimer);\n${B}    retireTimer = null;\n${B}}\n${B}// P9: abort/crash/supersede/bg-ceiling must not hang pushed turns.#" "$f"
  fi
}

# ($1=file, $2=base indent: dist 4 spaces, server src 2 spaces)
patch_p9r_file() {
  local f="$1" A="$2"
  [ -f "$f" ] || return 0
  if p9r_verify "$f"; then
    note "P9r already applied: $f"
    return 0
  fi
  if [ "$MODE" = check ]; then missing "P9r $f"; return 0; fi
  # Rollback artifact: the P9 (pre-P9r) state, created once and kept.
  if [ ! -f "$f.bak-pre-p9r" ]; then
    cp -a "$f" "$f.bak-pre-p9r"
  fi
  p9r_apply_edits "$f" "$A"
  if p9r_verify "$f"; then
    note "P9r patched: $f (backup: $f.bak-pre-p9r)"
  else
    cp -a "$f.bak-pre-p9r" "$f"
    echo "P9R PATCH FAILED: $f (restored from $f.bak-pre-p9r)" >&2
    exit 1
  fi
}

# P9r rollback artifact: the queue file is (re)copied by the P9 stage below,
# so its pre-P9r content must be preserved BEFORE that copy runs. Created
# once and kept, exactly like the provider .bak-pre-p9r files, and only from
# a queue that is still unpatched: a queue that already IS the canonical copy
# or already carries the P9r MCP normalisation (canonicalMcpSet) is never
# saved as "pre-p9r" - e.g. on a fresh stock tree (no queue at all) the first
# apply writes the canonical queue, and a second apply must not back it up.
if [ "$MODE" != check ] && [ "${APPLY_P9R:-1}" = "1" ]; then
  for _d in "$PROVIDER_DIST" "$PROVIDER_SRC"; do
    _q="$_d/claude-prompt-queue.js"
    if [ -f "$_q" ] && [ ! -f "$_q.bak-pre-p9r" ] \
      && ! cmp -s "$PATCHES_DIR/files/claude-prompt-queue.js" "$_q" \
      && ! grep -q 'export function canonicalMcpSet(' "$_q"; then
      cp -a "$_q" "$_q.bak-pre-p9r"
    fi
  done
fi
patch_p9_copy "$PROVIDER_DIST"
patch_p9_copy "$PROVIDER_SRC"
patch_p9_file "$PROVIDER_DIST/claude-runtime.provider.js" "    "
patch_p9_file "$PROVIDER_SRC/claude-runtime.provider.js" "  "
if [ "${APPLY_P9R:-1}" = "1" ]; then
  patch_p9r_file "$PROVIDER_DIST/claude-runtime.provider.js" "    "
  patch_p9r_file "$PROVIDER_SRC/claude-runtime.provider.js" "  "
fi

# --- P10+: apply.d drop-ins (p10 lifecycle, p11 sessions, p12 origin, p13 session origin/archive, p14 live-stream delivery; C-sorted) ---
# Each drop-in owns its anchors, is idempotent and has its own --check (wired 2026-10-10).
while IFS= read -r _p; do
  if [ "$MODE" = check ]; then
    bash "$_p" --check "$(pwd)" || missing "apply.d $(basename "$_p")"
  else
    bash "$_p" "$(pwd)"
  fi
done < <(find "$PATCHES_DIR/apply.d" -maxdepth 1 -type f -name 'p[0-9]*.sh' 2>/dev/null | LC_ALL=C sort)

if [ "$MODE" = check ]; then
  if [ "$FAILURES" -gt 0 ]; then
    echo "check FAILED: $FAILURES patch location(s) missing" >&2
    exit 1
  fi
  echo "check OK: all patches present"
fi
