# cloudcli-voice — one-button Gemini Live voice call for CloudCLI

Rebuilt 2026-10-07 (owner ruling). The chat bar has exactly one 📞 button
(shown only when `/voice/health` reports `live:true`). It opens a slim floating
call bar at the top — animated orb, mute, hang up — while the chat stays visible
and live underneath, like Gemini Live on Android. You talk in
Egyptian Arabic to a Gemini Live "co-worker" (`gemini-3.8-live`, one male voice);
it answers status questions itself and relays your instructions to the open
Claude Code session through three tools:

- `get_claude_status` — state (idle / working / waiting for permission), todos,
  recent steps and the last reply (≤300 chars) from the session's WS frames.
- `send_to_claude(instruction, when)` — idle → sends now; busy without `when` →
  `ask_owner` (the voice asks "أقاطعه دلوقتي ولا بعد ما يخلص؟", i.e. "interrupt now, or after it finishes?"); `now` → abort + send;
  `after` → one-slot queue sent on the next `complete`.
- `stop_claude` — `chat.abort`.

Prompt-injection guard: `send_to_claude`/`stop_claude` return `no_user_turn`
unless the owner spoke (input transcription) since the last proactive update or
the previous action. Claude's progress reaches the call as `[CLAUDE UPDATE] …`
text pushed only while the model is idle; the system instruction treats it as data.

Plans and long messages (2026-10-07, call 211015): `read_claude_message({plan:true})`
reads the plan waiting for on-screen approval in full (cap 60,000 chars, line breaks
kept), part by part in one flow; the app pushes the next part after each spoken
turn and the last part ends with "approve or reject on screen" — approvals are
never given by voice. While a plan or question waits, `send_to_claude` returns
`ask_owner` with `planPending`/`questionPending` (now = closes the plan/question,
after = once it is answered and the run ends). History refreshes never move the
session off `waiting_permission`; `tool_use` frames are de-duplicated by id and
the `seq` watermark resets per run. Status also carries the open session's
running background jobs (`backgroundTasks`, this session only).

Outdated tab: at call start the add-on compares its own `/voice-addon/v/<hash>/`
with the served page (`lib/addon-version.mjs`, cached every health poll, fail
open); a mismatch reloads once (60 s loop guard) and the call starts by itself.

Jimmy is the name of this voice co-worker (the Gemini Live persona the owner
talks to on the call); Claude Code is the CEO session it relays to.

Mute: muted mic level reads 0, the add-on streams 2.5 s of digital silence (so the
server VAD closes the owner's turn) and then one `audioStreamEnd`; if the owner
was mid-turn the reply rescue still makes Jimmy answer. Barge-in (retune 2,
2026-10-08): a chunk is loud at RMS ≥ max(0.06, 3 × the learned echo level);
3 loud chunks within the last 5 (~400 ms) barge in; never in the first 800 ms of
a reply (echo learning) or before 4 warm-up chunks; a barge with no owner words
within 3 s pushes "noise cut you off, continue".

Push-to-talk (owner ruling Q9a, 2026-10-10; optional, DEFAULT OFF): the **PTT**
button on the call bar switches it on/off and remembers the choice for the next
calls (`localStorage` flag `cloudcli-voice:flag:pushToTalk`; only an explicit
`true` enables it). ON: the call starts muted and the mic reaches Gemini only
while 🗣️ (it replaces the mute button) or the Space key (outside text fields)
is held; release = the mute path above (silence tail → `audioStreamEnd` → reply
rescue), so room/TV speech never counts as the owner. Releasing the key inside
a text field, a window blur or a hidden tab also releases. OFF: the call is
byte-identical to a call without the feature (tested frame for frame). Turning
it OFF mid-call restores the mute state from before it was turned ON.

## Gemini quota check (M-137, silent connected calls)
Silent-but-connected calls were recorded as Google-side; the alternative cause
is a free-tier key whose quota is exhausted. `tools/gemini-quota-check.mjs`
checks it (server-side tool, never shipped to the browser). In a root shell:
```sh
node tools/gemini-quota-check.mjs                        # dry run: plan + "key set: yes/no", no network
# the key lives only inside the subshell and is gone when it exits
( read -r GEMINI_API_KEY < /etc/voice-gateway/gemini_key && export GEMINI_API_KEY
  node tools/gemini-quota-check.mjs --execute )             # GET models/<model>: key valid? Live supported? (no quota spend)
( read -r GEMINI_API_KEY < /etc/voice-gateway/gemini_key && export GEMINI_API_KEY
  node tools/gemini-quota-check.mjs --execute --live-probe ) # + one Live setup (no audio; costs one session start)
```
The key is read only from the environment variable named by `--key-env`
(default `GEMINI_API_KEY`, the gateway's own fallback name; only `GEMINI_*` /
`GOOGLE_*` names are accepted), sent only as the `x-goog-api-key` header
(redirects refused), never printed (every output line is redacted, argument
values are never echoed) and never accepted on the command line. Exit 0 ok,
2 usage/no key, 3 key invalid/denied, 4 quota exhausted (prints the
QuotaFailure metric/id and retry delay, and flags `free_tier` metrics),
5 other (incl. timeout), 6 model found but it does not list
bidiGenerateContent (Live unsupported; the live probe is skipped). Run it right after a silent call; exit 4 with a
free-tier metric confirms the alternative cause.

Audio: mic → AudioWorklet → PCM16 16 kHz → Gemini (echo cancellation, noise
suppression, AGC); replies PCM 24 kHz played gap-free; Gemini's server VAD does
barge-in (`interrupted` flushes playback). `goAway`/drops reconnect with the
session-resumption handle and a fresh token (backoff 0.5/1/2/4 s, 5 tries).
Tokens come from `voice-gateway` `POST /voice/live-token` (key stays server-side).

## Decision: patch, not plugin (spike evidence)

The CloudCLI 1.37.3 plugin API cannot host this feature. Evidence from the
pinned source (`npm pack @cloudcli-ai/cloudcli@1.37.3`):

- `server/modules/plugins/plugin-registry.service.ts:26` —
  `const ALLOWED_SLOTS = ['tab'];` and `:74-76` rejects any other slot, so a
  plugin cannot add a control next to the chat input.
- Client plugin surface is list/install/toggle/asset/rpc only —
  `/api/plugins/{name}/assets/{entry}` and `/api/plugins/{name}/rpc/*`
  (`dist/assets/index-sFfz8iBR.js`, `be.plugins` + `A4`). There is no API to
  read/insert chat input text or to subscribe to chat stream events.

So this is a minimal, idempotent patch: one marked script tag injected into
`dist/index.html` loads `dist/voice-addon/v/<content-hash>/voice-addon.js (hashed so the 1-year immutable cache never pins stale code)` (new files only; no
app code is modified). `--remove` restores `index.html` byte-identical
(verified against the tarball md5).

How the add-on observes the app without touching app code:

- Chat transport is a kind-based WebSocket protocol —
  `server/shared/types.ts:176-233` (`MessageKind`: `text`, `tool_use`,
  `tool_result`, `permission_request`, `task_notification`, `complete`, …) and
  `server/modules/websocket/services/chat-websocket.service.ts:527-540`
  (outbound frames). The add-on wraps `window.WebSocket` and derives cues from
  incoming frames; it tracks the current session id from outgoing
  `chat.send` frames.
- The chat input is CodeMirror 6 (`dist/assets/vendor-codemirror-CYrSt7-U.js`,
  `cm-editor`/`cm-content`). Insertion focuses `.cm-content` and uses
  `document.execCommand('insertText')` (CM6-compatible), with an
  `InputEvent('beforeinput')` fallback; `dir="auto"` is set for Arabic RTL.


## Install
```sh
${AI_SETUP_ROOT}/cloudcli-voice/apply.sh            # into the CloudCLI npm install
${AI_SETUP_ROOT}/cloudcli-voice/apply.sh --dry-run
${AI_SETUP_ROOT}/cloudcli-voice/apply.sh --remove   # rollback (index.html restored)
```
Code is served from `dist/voice-addon/v/<sha256-12>/` (dist is cached immutable;
index.html is no-store). Re-run after any CloudCLI upgrade. No npm dependencies.
CloudCLI's built-in voice setting must stay OFF.

## Layout
- `voice-addon.js` — WS wrap + session tracking, 📞 button, top call bar, history seeding, wiring.
- `lib/live-call.mjs` — Gemini Live WebSocket protocol, tools, resumption/reconnect, `pushText`.
- `lib/live-audio.mjs` — mic capture worklet, 24 kHz playback queue, level meters.
- `lib/progress-log.mjs` — CloudCLI frame → per-session progress snapshot + update events.
- `lib/voice-bridge.mjs` — the three tools, busy/ask/queue logic, injection guard.
- `lib/session-target.mjs` — the call's session from the URL only, composer sender, call actions (WO-3).
- `lib/session-history.mjs`, `lib/call-transcript.mjs`, `lib/addon-version.mjs` — call-start briefing,
  per-call transcript, outdated-tab reload.
- `lib/push-to-talk.mjs` — optional push-to-talk controller (default OFF).
- `lib/chat-input.mjs`, `lib/live-refresh.mjs`, `lib/activity-bar.mjs`, `lib/bg-jobs.mjs`,
  `lib/feature-flags.mjs` — non-voice helpers (insert/submit, run tracking, activity bar).
- `tools/gemini-quota-check.mjs` — server-side quota check (not installed into CloudCLI).

## Tests
`cd ${AI_SETUP_ROOT}/cloudcli-voice && npm test` (no network; 356 tests as of WO-N6)

The pre-Live add-on (old local speech stack, removed 2026-10-07; its dictation button is unrelated to
today's PTT) is archived in the project archive.
