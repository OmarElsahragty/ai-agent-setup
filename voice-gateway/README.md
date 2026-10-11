# voice-gateway — Gemini Live token service

Slimmed 2026-10-07 (owner ruling): the old local speech stack (whisper.cpp STT,
Kokoro/Piper TTS, llama.cpp narrator, models) is gone. This service now only
mints short-lived **Gemini Live** tokens for the one-button voice call in the
CloudCLI web UI (`${AI_SETUP_ROOT}/cloudcli-voice`). The browser talks to Google
directly; the API key never leaves this host. FastAPI, binds `127.0.0.1:3012`;
`${AI_SETUP_DOMAIN}/voice/*` reaches it through the Cloudflare tunnel.

## Endpoints
- `GET /voice/health` → `{"ok":true,"live":<key configured>,"model":"gemini-3.8-live"}`
  (direct-loopback GET is the only request exempt from the Access check).
- `POST /voice/live-token` → `{token, model, expiresAt, wsUrl}` (`Cache-Control: no-store`).
  Calls `v1beta/auth_tokens` with `uses=1`, 30 min expiry, 1 min to open a session,
  and **locks the whole setup server-side**: model, AUDIO only, voice, `ar-EG`,
  system instruction (`live-system.md`, re-read per request), tools
  (`get_claude_status`, `send_to_claude(instruction, when=now|after)` NON_BLOCKING,
  `stop_claude`), input transcription, session resumption, sliding-window compression.
  Errors: 429 `rate_limited` (1 attempt / 3 s, process-wide), 502 `token_failed`
  (Google body never echoed), 503 `not_configured`.
- `POST /voice/event?e=<name>&n=<int>` — allow-listed client diagnostics logged to the journal
  (`call-start, call-end, mic-ok, mic-error, live-open, live-close, live-error, tool-call, reconnect, push-update`,
  plus `mute, unmute, version-reload, auto-call` and the others listed in `CLIENT_EVENTS`).
- Call transcripts: day folders `YYYY-MM-DD/*.jsonl`; only the last 7 days are kept
  (`VOICE_TRANSCRIPT_KEEP_DAYS`, default 7), pruned at startup and at most hourly on write.

## Configuration
- Key: systemd `LoadCredential=gemini_key:/etc/voice-gateway/gemini_key` (0600 root;
  value = `GOOGLE_GENERATIVE_AI_API_KEY` from `${AI_SETUP_ROOT}/.env`, free tier — Google may use
  call audio to improve its models until billing is attached to that project).
  Tests use env `GEMINI_API_KEY`.
- `VOICE_LIVE_MODEL` (default `gemini-3.8-live`; `gemini-3.8-live-extended-thinking` is supported but on 2026-10-07 never emitted its tool calls), `VOICE_LIVE_THINKING` (`medium`; sent only for extended-thinking models), `VOICE_LIVE_VOICE` (`Charon`), `VOICE_LIVE_LANG` (`ar-EG`).
- `--workers 1` is required: the rate limiter and JWKS cache are per-process.
- Google AI Pro/Ultra subscriptions do NOT cover Gemini API usage (OAuth or key both bill a Cloud project).

## Cloudflare Access origin auth (S1, owner ruling 2026-10-07)

Opt-in: set BOTH `CF_ACCESS_AUD` (the Access application AUD tag) and
`CF_ACCESS_TEAM_DOMAIN` (`${CF_ACCESS_TEAM_DOMAIN}`); the unit template
sets them. Then every request must carry a valid `Cf-Access-Jwt-Assertion`:

- RS256 only (header `alg` must be RS256, `kid` required); signature checked
  against `https://<team>/cdn-cgi/access/certs`; `aud` must contain
  `CF_ACCESS_AUD`, `iss` must equal `https://<team>`; `exp`/`aud`/`iss`
  required; 30 s clock leeway.
- JWKS cached 1 h (`VOICE_JWKS_CACHE_S`); an unknown `kid` triggers one refetch
  (key rotation), rate-limited to once per 60 s; a failed fetch keeps the
  cached keys; no keys at all -> reject (fail closed).
- Missing/invalid token -> `401 {"detail":"unauthorized"}` (same status as
  the CloudCLI origin check). Token values are never logged.
- Only exemption: `GET /voice/health` from a **local probe** — loopback peer
  (`127.0.0.1`/`::1`) with NO proxy/edge headers (`cf-connecting-ip`,
  `cf-ray`, `cf-visitor`, `x-forwarded-for`, `forwarded`, `x-real-ip`).
  `/voice/health` arriving through the tunnel needs the JWT like every other
  route. Non-`/voice` paths (FastAPI `/docs`, `/openapi.json`) are gated too.

Either variable unset -> no in-app auth (previous loopback-trust behaviour).

## Service user (S3, owner ruling 2026-10-07)

Runs as `User=voice` with `NoNewPrivileges`, `ProtectSystem=strict`, empty
`CapabilityBoundingSet`, `PrivateDevices`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
kernel/proc protections and no writable paths; the only secret is the
`gemini_key` credential. No GPU or model access anymore.

## Test
```sh
cd ${AI_SETUP_ROOT}/voice-gateway && env -u CF_ACCESS_AUD -u CF_ACCESS_TEAM_DOMAIN .venv/bin/pytest -q
```

## Install / rollback
Venv: `uv venv --python /opt/uv-python/cpython-3.12.13-linux-x86_64-gnu/bin/python3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt`
(build it in place — moving a venv breaks script shebangs; since 2026-10-07 the unit runs
`.venv/bin/python -m uvicorn … --no-access-log` so a moved venv no longer crash-loops on a
shebang, and `StartLimitBurst=5`/`StartLimitIntervalSec=120` stop a restart storm). Unit: copy `voice-gateway.service`
to `/etc/systemd/system/`, `systemctl daemon-reload && systemctl restart voice-gateway`.
Pre-Live code, unit and add-on are kept in the project archive.
