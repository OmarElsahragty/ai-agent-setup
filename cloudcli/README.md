# CloudCLI deployment (${AI_SETUP_DOMAIN})

Pinned `@cloudcli-ai/cloudcli@1.37.3` (npm latest, 2026-09-08) behind Cloudflare Access.
Scope: install + systemd service + Cloudflare. Voice features are a separate worker (voice-gateway, 127.0.0.1:3012, ingress path `^/voice/`).

## Files
- `package.json` / `package-lock.json` — pinned dependency (`npm ci` reproducible)
- `.env.example` — secret-free template; `install.sh` copies it to `.env` (0600) on first install. No agent-written secrets: the single UI login is created by the owner on first visit (CloudCLI `needsSetup` flow); `JWT_SECRET` is auto-generated per install (stored in auth.db).
- `patches/apply.sh` — idempotent server patches P0-P9r (see "Server patches"; re-applied by `install.sh` after every `npm ci`); `patches/apply.d/p10.sh`..`p13.sh` — staged, pending owner GO
- `install.sh` — npm ci + patch + env bootstrap + native module load check
- `/etc/systemd/system/cloudcli.service` — root, WorkingDirectory=${AI_SETUP_ROOT}, PATH=/usr/local/bin first, EnvironmentFile=.env, Restart=always, loopback 3011. Memory: effective **MemoryHigh=7G / MemoryMax=9G** — the runtime drop-ins `/etc/systemd/system.control/cloudcli.service.d/50-MemoryHigh.conf` + `50-MemoryMax.conf` (from `systemctl set-property`) override the unit file's 5G/7G; check with `systemctl show cloudcli -p MemoryHigh -p MemoryMax`
- `backups/` — tunnel config snapshots + staged ingress JSON + Access app id
- `add-dns.sh`, `apply-ingress.sh`, `rollback-tunnel.sh` — Cloudflare lifecycle (ordering-enforced)

## Source verification (1.37.3, file:line in node_modules/@cloudcli-ai/cloudcli)
- **WS keepalive 30 s (issue #769)**: `attachWebSocketHeartbeat(ws, intervalMs = 30_000, …)` with `ws.ping()` + half-open terminate — dist-server/server/modules/websocket/services/websocket-server.service.js:11-53; applied to EVERY gateway connection before path dispatch (:64-65), covering `/ws` (:73), `/shell` (:69), `/desktop-notifications` (:77), `/plugin-ws/*` (:81). Well under Cloudflare's ~100 s idle WS drop.
- **Detached-run reaper (PR #1005)**: `BG_WAIT_CEILING_MS = 30*60*1000` — dist-server/server/modules/providers/list/claude/claude-runtime.provider.js:52; used as CLI env `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (:182, kills still-running background agents) and the stdin-hold backstop (:644). No upstream env override, so `patches/apply.sh` makes it `parseInt(process.env.CLOUDCLI_BG_WAIT_CEILING_MS, 10) || 30*60*1000` (mirrors the codebase's own idiom at :36); `.env` sets 86400000 (24 h). NOTE: it is a SILENCE ceiling (resets on every message), not total-runtime.
- **claude binary resolution**: `resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)` returns CLAUDE_CLI_PATH verbatim on Linux, else bare `claude` — dist-server/server/shared/claude-cli-path.js:106-115; handed to the SDK as `pathToClaudeCodeExecutable` (claude-runtime.provider.js:186-190). `.env` pins `CLAUDE_CLI_PATH=/usr/local/bin/claude` (router wrapper, ANTHROPIC_BASE_URL→127.0.0.1:3920); host env is fully forwarded to the subprocess (:182). Never a bundled CLI.
- **Projects/workspace root**: `WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir()` — dist-server/server/shared/utils.js:70; file-tree root (file-tree.module.js:61) AND path containment guard (utils.js:211-216 reject paths outside the root). `.env` sets `${AI_SETUP_ROOT}`.
- **Auth mode**: no `DISABLE_AUTH` in 1.37.3. Shipped equivalent: `IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true'` (utils.js:16) → REST+WS auth bypass returning the single DB user (auth.middleware.js:22-29, 99-110); `/api/auth/register` is first-user-only (auth.service AUTH_USER_ALREADY_CONFIGURED 403). Cloudflare Access is the ONLY external gate, and since FP-2 patch P5 the origin ALSO validates the Access JWT itself (`CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN` env; see Server patches below) — defence in depth for a mis-scoped Access app or direct origin reach.
- **Plugin API location (for the voice worker)**: WS proxy at `/plugin-ws/<name>` — dist-server/server/modules/websocket/services/plugin-websocket-proxy.service.js:6 (proxied via `dependencies.getPluginPort`, websocket-server.service.js:81-83); plugin processes are managed by dist-server/server/modules/plugins/plugin-process.service.js; voice env hooks exist (`VOICE_API_BASE_URL`, `VOICE_STT_MODEL`, `VOICE_TTS_MODEL`, `VOICE_TTS_VOICE`, `VOICE_TIMEOUT_MS`) — stock built-in voice hooks, UNUSED here: the built-in voice setting stays OFF; voice is the `cloudcli-voice` add-on (one 📞 call, Gemini Live; persona "Jimmy") with tokens minted by voice-gateway.
- **Port/bind**: `SERVER_PORT` (default 3001) + `HOST` (default 0.0.0.0) — dist-server/server/index.js:222-223,286. `.env`: 3011 / 127.0.0.1.

## Service
- Start/stop: `systemctl start|stop|restart cloudcli`; logs: `journalctl -u cloudcli -f`
- Health: `systemctl is-active cloudcli && ss -ltn | grep '127.0.0.1:3011' && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3011/`
- First visit (after ingress): the UI shows CloudCLI's one-time setup — the owner creates the single login; after that register is closed forever.

## Cloudflare state
- Access app `${CF_ACCESS_AUD}` "CloudCLI Agent": whole-hostname `${AI_SETUP_DOMAIN}` (no path restriction — covers `/api`, `/ws`, `/shell`, `/plugin-ws/*`, `/voice/*`), self_hosted, session 24 h, policy: allow the owner account only. Verified via API GET.
- Tunnel `${CF_TUNNEL_ID}` is REMOTE-managed (token-run, no local config.yml); ingress JSON staged in `backups/ingress-staged-agent.json`: `^/voice/ → http://127.0.0.1:3012`, else `${AI_SETUP_DOMAIN} → http://127.0.0.1:3011` (WebSockets are always-on for http services on remote-managed tunnels). Current config backed up at `backups/tunnel-config-20261006-212046.json`.
- **Blocked on owner**: DNS. Both existing tokens (`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`) lack Zone→DNS→Edit (tested: `zones/{id}/dns_records` → 10000 auth error). Owner action: EITHER add Zone:DNS:Edit scope for ${AI_SETUP_DOMAIN} and put the token under key `CF_DNS_API_TOKEN` in ${AI_SETUP_ROOT}/.env, then run `bash add-dns.sh`; OR create in the dashboard CNAME `agent` → `${CF_TUNNEL_ID}.cfargotunnel.com` (proxied).
- Then: `bash apply-ingress.sh` — it REFUSES to add ingress unless DNS resolves AND https://${AI_SETUP_DOMAIN} redirects to cloudflareaccess.com (Access verified before ingress, always).

## Verification log (2026-10-06)
- install.sh end-to-end: `npm ci` (948 pkgs), patch applied to both files, native modules load, .env 0600 — exit 0.
- Service: active, listening 127.0.0.1:3011 ONLY, HTTP 200 on /, `/api/auth/status` → `{"needsSetup":true}`.
- WS keepalive runtime proof: with a temporary seeded user, `/ws` stayed open and received server pings at exactly 30.0 s and 60.0 s; then `data/auth.db` was deleted and the service restarted, restoring pristine `needsSetup:true` (the temp credential was random, never printed, and is now destroyed with the DB).
- Rollback rehearsal: `systemctl stop` → inactive + port freed; `systemctl start` → active + 200.
- TEST battery: `systemctl is-active` → active; `ss -ltn | grep 127.0.0.1:3011` → LISTEN; `curl http://127.0.0.1:3011/` → 200; `curl -sI https://${AI_SETUP_DOMAIN}` → fails (DNS NXDOMAIN) until the owner creates the CNAME, then run `apply-ingress.sh`.

## Rollback plan (Tier B)
Local (rehearsed 2026-10-06):
1. `systemctl disable --now cloudcli` — service down, port 3011 free; nothing else changes (CloudCLI state lives in `data/auth.db` + `~/.claude`).
2. Restore: `systemctl enable --now cloudcli` (or `bash install.sh` first after `rm -rf node_modules`).
Cloudflare:
3. Before ingress is ever applied: remove DNS record + delete Access app — nothing else needed (no ingress exists).
4. After ingress: `bash rollback-tunnel.sh <timestamp>` (restores backed-up config), then optionally delete DNS record and Access app (dashboard or API, app id above).
No other tunnel hostnames are touched by any step (ingress edits only insert rules for ${AI_SETUP_DOMAIN} before the existing catch-all; other rules are copied verbatim from the backup).

## Server patches (patches/apply.sh, WO-E1 2026-10-06)
`bash patches/apply.sh [TARGET_ROOT]` (idempotent; TARGET_ROOT defaults to this install — pass a
temp copy under /var/tmp/claude to test without touching the live service). `bash patches/apply.sh
--check [TARGET_ROOT]` verifies and exits 1 if anything is missing. Patches:
- **P0** `BG_WAIT_CEILING_MS` env override (pre-existing).
- **P1** async-subagent status: with no `<task-notification>`, a subagent stays `running` when its
  transcript was touched within `CLOUDCLI_SUBAGENT_LIVE_MS` (default 600000 ms) — a worker waiting on
  its own background Bash job no longer renders `completed` while alive. Helper:
  `modules/providers/list/claude/subagent-live.js` (unit-tested from `patches/test/`).
- **P2** read-only background-jobs API, mounted at `app.use('/api/bg-tasks', authenticateToken, …)`
  in both `dist-server/server/index.js` and `server/index.ts`; module in `modules/bg-tasks/`.
  - `GET /api/bg-tasks?sessionId=<uuid>` → `{sessionWorking:bool, lastWriteAt:iso|null, tasks:[…], agents:[…]}` (P4
    extended; task items unchanged: `{id, description, status: "running"|"completed"|"failed"|"killed", startedAt,
    endedAt|null, outputBytes}`, newest first, capped at 50. status from the last `<task-notification>` per task-id —
    collected from user turns AND `type:"attachment"` rows (`attachment.type:"queued_command"`, payload in
    `attachment.prompt`, alternate carrier `attachment.content` as string or text-part array); none ⇒ `running`, unless
    the output-file tail ends with `[exited with code N]` ⇒ `completed` (0) / `failed` (else), `endedAt` = output-file
    mtime (last 4 KB checked, ANSI-stripped, partial first line dropped). Only Bash launches (rows with
    `toolUseResult.backgroundTaskId` matched to a `Bash` tool_use)).
    `sessionWorking` = JSONL mtime within `CLOUDCLI_SESSION_LIVE_MS` (default 30000) OR any running agent/task.
    `agents` (newest first, cap 50) = `{id, agentType, description, status:"running"|"completed"|"failed", startedAt,
    lastActivityAt, steps:int, currentStep}` — async Agent launches (`toolUseResult.agentId` + `isAsync`), sync
    launches (row ⇒ completed), and sync calls still in flight (bound via the subagent meta sidecar `toolUseId`).
    Status rule = the P1 rule: notification > (async, no transcript ⇒ running) > endedMidToolCall > transcript mtime
    within `CLOUDCLI_SUBAGENT_LIVE_MS`. `currentStep` = last activity, `"<Tool>: <short arg>"` or first 80 chars of
    text, ANSI/control-char sanitized, whitelisted arg keys only.
  - `GET /api/bg-tasks/:taskId/tail?sessionId=<uuid>&lines=40` (1..200, default 40) → `{id, text, truncated}` —
    last 64 KB of the output file, ANSI-stripped, partial first line dropped when byte-windowed.
  - Errors (non-200) all use `{error: "<message>"}`. 400: sessionId not a strict UUID, taskId not
    `/^[a-z0-9]{6,16}$/`, `lines` not an integer 1..200. 404: unknown session / unknown task /
    unreadable output. 500: transcript read failure.
  - Security: output path must realpath-exactly equal `<path>/tasks/<taskId>.output` under
    `/var/tmp/claude/` (any symlink — i.e. any escape — is rejected); at most 64 KB read; no writes,
    no process control.
  - Efficiency (FP-1): the transcript scan is cached per (jsonl path, size, mtime) — an unchanged
    transcript is not rescanned (bounded 64-entry LRU, shared by every endpoint); `GET /` builds
    `tasks[]` through the same `listBackgroundTasks()` path as every other consumer.
- **P3** (WO-G1) subagent timeline keeps the LAST `MAX_TRANSMITTED_SUBAGENT_ACTIVITIES` (200) steps
  instead of the first (long agents no longer look frozen), and every message referencing an agent
  carries `subagentHiddenEarlier:<n>` (0 if none) end to end: raw message → `toolResultMap` →
  normalized message → `NormalizedMessage`/`ClaudeToolResult` TS types.
- **P4** (WO-G1) `/api/bg-tasks` extensions (backward compatible; existing fields unchanged):
  - `GET /api/bg-tasks/agents/:agentId/tail?sessionId=<uuid>&steps=20` (1..100) →
    `{id, steps:[{kind:"tool"|"text", label, at}], truncated}`; `agentId` must match
    `/^a[0-9a-f]{8,24}$/` and be referenced by the session (launch row or pending-call meta binding);
    transcript resolved ONLY via the P1 locator under the session's project dir, realpath-contained
    in the project dir (symlink escapes 404); at most the last 4 MB of the agent transcript is read.
  - `GET /api/bg-tasks/active` → `{sessions:[{sessionId, working:true, lastWriteAt}]}` — claude
    sessions (sessions DB) whose JSONL mtime is within `CLOUDCLI_SESSION_LIVE_MS`, OR (FP-1) any
    `<project>/<session>/subagents/*.jsonl` mtime within `CLOUDCLI_SUBAGENT_LIVE_MS` (a terminal
    session waiting on subagents stays "working"; stat-only, cap 200 files per session, older
    sibling-layout transcripts not scanned); `lastWriteAt` = freshest of the JSONL and subagent
    mtimes; cap 200 rows, 2 s cache.
  - New errors: 400 `Invalid agentId` / `steps must be an integer between 1 and 100`; 404
    `Agent not found`; 500 `Failed to read agent transcript` / `Failed to list sessions`.
  - Disclosed limitation: a synchronous Agent call whose meta sidecar is not (yet) written cannot be
    bound to an agentId and is skipped from `agents[]` until its result row lands.
- **P5** (FP-2, owner ruling S1) Cloudflare Access JWT validation at the origin — `modules/auth/access-jwt.js`
  (node:crypto only: JWK → `createPublicKey`, RS256 via `createVerify`). Validates the `Cf-Access-Jwt-Assertion`
  header (fallback cookie `CF_Authorization`) against `https://<team>/cdn-cgi/access/certs` (JWKS and legacy
  `public_certs` PEM shapes; cached 1 h, single-flight, one forced refetch on unknown kid, fetch failure = fail
  closed). Enforces alg RS256 (HS256/`none` rejected), `iss == https://<team>`, `aud` contains `CF_ACCESS_AUD`,
  `exp`/`nbf` with 60 s skew. Mounted app-wide in `dist-server/server/index.js` + `server/index.ts` BEFORE every
  route (incl. `/health`; invalid/missing → REST 401 JSON) and wrapped around the shared WS gateway `verifyClient`
  in `websocket-server.service.{js,ts}` (arity-2 → ws callback mode), so `/ws`, `/shell`, `/desktop-notifications`
  and `/plugin-ws/*` upgrades are rejected 401 and the socket destroyed BEFORE any shell/pty/plugin spawn; the
  original `verifyWebSocketClient` decision is still consulted after a valid assertion (sets `request.user`).
  Enabled ONLY when env `CF_ACCESS_AUD` AND `CF_ACCESS_TEAM_DOMAIN` are both set — unset keeps the previous
  behaviour exactly (local QA on a temp copy unaffected). No loopback bypass; tokens are never logged
  (log lines carry reason codes only). Tests: `patches/test/fp2-*.test.mjs`.
  Enable at apply time (cloudcli.service EnvironmentFile already loads `.env`; AUD value in
  `backups/access-aud.txt`):
  ```
  CF_ACCESS_AUD=<value from backups/access-aud.txt>
  CF_ACCESS_TEAM_DOMAIN=${CF_ACCESS_TEAM_DOMAIN}
  ```
- **P9** one process per conversation (claude-runtime.provider.{js,js} + `claude-prompt-queue.js` in the same
  dirs): a new turn for a session whose CLI is still alive (stdin held open while background agents run) is
  PUSHED into that live process instead of superseding it with a fresh spawn; follow-up turns and background
  completions all stream to the session's CURRENT WebSocket writer (re-bound per turn). Reuse requires an
  active, unreleased, pushable entry with no `resumeAnchorId`/`resumeFromScratch` and identical
  model/effort/permissionMode/cwd/allowedTools/disallowedTools PLUS an unchanged settings fingerprint
  (path:size:mtime of `~/.claude/settings.json`, `<cwd>/.claude/settings{,.local}.json` plus a sha256 of the
  resolved MCP set from `loadMcpConfig`; `~/.claude.json` itself is not stat'ed because every Claude Code
  process on the host rewrites it, which would defeat reuse; no content enters the fingerprint) — anything else keeps the old supersede-then-spawn path. Turns of ANY origin
  (seed, pushed, or self-driven background follow-up) are tracked as in-flight: a push proceeds only at a
  turn boundary with no other push outstanding, settles only on its OWN `result`, a self-driven follow-up's
  result goes through the bg-completion branch and never settles a waiter, and stdin is never released while
  a pushed turn is un-resulted or earlier background work is still owed (`heldForBackgroundWork` survives a
  push). There is deliberately NO gate timeout that falls back to spawning — a queued turn simply waits for
  the in-flight turn; if the process dies first, the ownership check throws and the caller falls back to a
  single fresh spawn (never a parallel process; the same applies to a turn queued behind a clean-ending turn:
  the old CLI exits, so the next turn spawns fresh). Abort still interrupts the live instance and drains
  everything; the BG ceiling still reaps abandoned holds; a mid-run stream error reaches the current writer
  and drains pushed turns. apply.sh keeps a `.bak-pre-p9` rollback copy of each provider file, restores it
  on any failed apply, completes partial applies on re-run (per-marker guarded insertions), and `--check`
  runs `node --check` on the patched providers and fails on a duplicate queue import. Tests:
  `patches/test/p9-one-process.test.mjs` (queue unit + live-reuse with a fake SDK + the mid-flight-push
  regression + resume-anchor/settings exclusions + stream-error drain + partial-apply re-run + negative
  controls on the unpatched stock and the pre-fix v1 provider via `P9_PREPATCHED_TREE`).
  Caveats: a reused process keeps its spawn-time MCP server set and CLI settings until one of the fingerprinted
  files changes (then the next turn forces a fresh spawn); the push path runs on the spawning turn's
  canUseTool/permission closure, so remembered permission entries persist across pushed turns. Pre-existing,
  NOT introduced by P9 and required before any second Cloudflare Access identity is ever added: the server
  performs no per-user session-ownership check — any authenticated user can interact with any session
  (single-user assumption; Access currently admits exactly one identity).
- **P6** OpenCode synchronizer indexes only top-level sessions (`AND s.parent_id IS NULL` on the one
  listing query in `synchronizeRows`), so subagent child rows no longer flood the sidebar.
- **P7** Claude title extractor prefers custom-title > ai-title > last-prompt (most recent per kind in
  the scanned tail; last-prompt only as the fallback).
- **P8** queued-draft dispatcher duplicate guard: a queued turn whose trimmed text equals the last user
  message (sent within 120 s before it was queued) is dropped; missing timestamps / history errors send.
- **P9r** (2026-10-08) root-cause fix pass for P9: a finished turn HOLDS the process for reuse until the
  idle ceiling (R1); an incompatible turn retires the live process at a turn boundary, never mid-turn
  (R2); the spawn fingerprint normalises per-start volatile MCP values so rotating credentials do not
  defeat reuse. `.bak-pre-p9r` rollback copy; `APPLY_P9R=0` applies P9 only. Tests:
  `patches/test/p9r-one-process.test.mjs`. Detail: the P9r section of `patches/apply.sh`.

### Staged, pending owner GO (not on the live install)
Order: `apply.sh` (P0-P9r) → `apply.d/p10.sh` → `p11.sh` → `p12.sh` → `p13.sh`. Each script has
`--check`, keeps one-time `.bak-pre-pNN` copies, writes atomically and `node --check`s patched dist JS.
- **P10** (WO-1) provider lifecycle: shared prompt queue, in-place model/mode/effort, wait for the old
  CLI to exit, a failed push never spawns beside a live entry, abort = current turn only, self-driven
  turns open a registry run, spawn guard, runtime-state file (`/run/cloudcli/runtime-state.json`).
- **P11** (WO-2) history reader de-dup (one row per uuid), indexer upserts never change `isArchived`,
  terminal/external sessions flagged `isExternal` on read, queued-draft dispatcher busy check via the
  runtime-state file + stricter duplicate drops, Shell tab `claude --resume <id>` without the
  `|| claude` fallback and refused for a session with a live runtime entry.
- **P12** (WO-4: F5/F12/F13) origin hardening: `CF_ACCESS_EMAIL` pin + Origin allowlist (REST and WS),
  `chat.permission-response` accepted only for a requestId pending on a session this connection uses,
  sync log noise only with `CLOUDCLI_DEBUG_SYNC=1`.
- **P14** (WO-N5a) live-stream delivery fix: multi-socket subscriber attachment for idle-to-run transitions and real-time streaming deltas.
- **P15** (2026-10-11) Antigravity CLI (`agy`) provider integration:
  - First-class provider registration in backend `providerRegistry`, frontend bundle UI ("Agy"), and watcher paths.
  - Native NDJSON streaming execution via `agy -p "<prompt>" --output-format stream-json`, streaming text deltas, tool call / results mapping, and token budget accounting.
  - Default model `gemini-3.8-flash-high` with catalog mapping to all available agy models (`gemini-3.8-flash-*`, `gemini-3.7-flash-*`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`).
  - Native permissions mapping (`default`, `acceptEdits`, `bypassPermissions`, `plan`) to agy CLI flags.
  - Full session history extraction and session synchronization from `~/.gemini/antigravity-cli/brain/`.
  - Skills and MCP integration bridging `~/.gemini/config/skills` and `~/.gemini/config/mcp_config.json`.
  - Self-contained idempotent patch in `patches/apply.d/p15.sh` and test suite `patches/test/p15-agy-provider.test.mjs` (8/8 passing).

## Multi-user gate (single user only)
The server performs NO per-user session-ownership check: any authenticated identity can read, drive
and approve every session (see the P9 caveat above). Cloudflare Access admits exactly one identity
(policy "Allow Omar") and P12 (staged) also pins `CF_ACCESS_EMAIL` at the origin. Do NOT add a second
Access identity or a second CloudCLI login until a per-user ownership check exists and has passed a
security review.

Notes: apply to the live install + `systemctl restart cloudcli` is a separate owner-approved step
(Tier B); apply.sh itself never restarts anything.
