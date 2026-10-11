"""voice-gateway: slim Gemini Live token service for the CloudCLI voice front.

Binds 127.0.0.1:3012, serves GET /voice/health, POST /voice/event and
POST /voice/live-token (single-use ephemeral Gemini token; the Live setup is
locked server-side and the API key never leaves this process).
Cloudflare Access fronts the public hostname. When CF_ACCESS_AUD and
CF_ACCESS_TEAM_DOMAIN are both set, every /voice/* route except a direct
loopback GET /voice/health requires a valid Cf-Access-Jwt-Assertion
(RS256); unset = no in-app auth (loopback-only trust).
"""

import json
import logging
import re
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

BASE_DIR = Path(__file__).resolve().parent

# Gemini Live voice front (WO-VL-GW 2026-10-07): the browser talks to the Live
# API over a WS with an ephemeral token minted here. The setup below is LOCKED
# server-side: model, AUDIO-only modality, prebuilt voice, language, system
# instruction (live-system.md), tools, resumption and context compression.
LIVE_MODEL = os.environ.get("VOICE_LIVE_MODEL", "gemini-3.8-live")
# Background reasoning depth, sent only for an extended-thinking model
# (low|medium|high). 2026-10-07: gemini-3.8-live-extended-thinking never
# emitted its tool calls (0/9 real sessions, direct key too) -> not default.
LIVE_THINKING = os.environ.get("VOICE_LIVE_THINKING", "medium")
LIVE_SILENCE_MS = int(os.environ.get("VOICE_LIVE_SILENCE_MS", "1200"))
LIVE_VOICE = os.environ.get("VOICE_LIVE_VOICE", "Charon")
LIVE_LANG = os.environ.get("VOICE_LIVE_LANG", "ar-EG")
LIVE_SETUP_MD = BASE_DIR / "live-system.md"
GOOGLE_AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"
GOOGLE_HTTP_TIMEOUT_S = 5.0
TOKEN_TTL_MIN = 30
NEW_SESSION_TTL_MIN = 1
TOKEN_RATE_LIMIT_S = 3.0  # process-wide: at most 1 mint attempt / 3 s
LIVE_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
)

log = logging.getLogger("voice-gateway")
log.setLevel(logging.INFO)
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))
    log.addHandler(_h)

# Mint rate limiting is process-wide (one uvicorn worker) and consumes a slot
# on every outbound attempt (success or Google failure) so retries cannot
# hammer Google while it is erroring.
_token_rate_lock = threading.Lock()
_token_rate: Dict[str, float] = {"last": 0.0}

# F10 (WO-VL-FIX): error responses (429/502/503) are never cacheable either.
_NO_STORE = {"Cache-Control": "no-store"}


def _gemini_api_key() -> Optional[str]:
    """systemd LoadCredential file first (CREDENTIALS_DIRECTORY/gemini_key),
    then the GEMINI_API_KEY env fallback (tests). The value is never logged."""
    cred_dir = os.environ.get("CREDENTIALS_DIRECTORY")
    if cred_dir:
        try:
            p = Path(cred_dir) / "gemini_key"
            if p.is_file():
                value = p.read_text().strip()
                if value:
                    return value
        except OSError:
            pass
    value = os.environ.get("GEMINI_API_KEY", "").strip()
    return value or None


def _http_client() -> httpx.Client:
    return httpx.Client(timeout=GOOGLE_HTTP_TIMEOUT_S)


def _rfc3339(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


LIVE_TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "get_claude_status",
                "description": "Get what the Claude session is doing right now (idle, busy, waiting).",
                "behavior": "NON_BLOCKING",
            },
            {
                "name": "send_to_claude",
                "description": "Send an instruction to the Claude session.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "instruction": {"type": "string", "description": "The owner's full request rewritten as a clear prompt in Arabic addressed directly to Claude (never translated, never summarized, every detail kept), prefixed with \"(voice) \"."},
                        "when": {"type": "string", "enum": ["now", "after"], "description": "now = interrupt the current run; after = queue until it finishes."},
                    },
                    "required": ["instruction"],
                },
                "behavior": "NON_BLOCKING",
            },
            {"name": "stop_claude", "description": "Stop the current Claude run.", "behavior": "NON_BLOCKING"},
            {
                "name": "read_claude_message",
                "description": "Read one of Claude's own recent messages (1 = newest), or with plan=true the plan waiting for the owner's on-screen approval, one spoken-size part at a time. Use it to explain any Claude message or plan and before claiming Claude's words are missing or cut off. The app sends the next parts automatically while the owner listens.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plan": {"type": "boolean", "description": "true = read the plan waiting for approval (then back is not needed)."},
                        "back": {"type": "integer", "description": "1 = Claude's newest message, 2 = the one before it, and so on."},
                        "part": {"type": "integer", "description": "Which part to read (1 = first, the default). Use it when the owner says to continue after you stopped."},
                        "only": {"type": "boolean", "description": "true when the owner asked for just this one part (for example \"الجزء الأول بس\"); the app then does not continue with the next parts."},
                    },
                },
                "behavior": "NON_BLOCKING",
            },
            {
                "name": "answer_claude_question",
                "description": "Answer the question Claude is showing on screen with the owner's spoken choice. Never use it for plan approval or tool permissions.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "answers": {
                            "type": "object",
                            "description": "One entry per on-screen question: the exact question text -> the owner's chosen option label exactly as shown, or his own words when no option fits.",
                        },
                    },
                    "required": ["answers"],
                },
                "behavior": "NON_BLOCKING",
            },
        ]
    }
]


# ------------------------------------------------------- cloudflare access ---
# S1 (owner ruling 2026-10-07): when CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN
# are both set, every /voice/* route except GET /voice/health requires a valid
# Cf-Access-Jwt-Assertion header (RS256, aud/iss checked, JWKS cached 1 h,
# fail closed). Token values are NEVER logged. Unset env = loopback trust.
CF_ACCESS_AUD = os.environ.get("CF_ACCESS_AUD")
CF_ACCESS_TEAM_DOMAIN = os.environ.get("CF_ACCESS_TEAM_DOMAIN")
JWKS_CACHE_S = float(os.environ.get("VOICE_JWKS_CACHE_S", "3600"))
JWKS_MIN_REFRESH_S = 60.0  # unknown-kid refetch rate limit (key rotation)

_jwks_cache: Dict[str, Tuple[float, list]] = {}
_jwks_lock = threading.Lock()

# A request that went through cloudflared / any proxy carries one of these;
# a genuine local probe (curl on the host, systemd) carries none.
_PROXY_HEADERS = ("cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for", "forwarded", "x-real-ip")
_LOOPBACK_HOSTS = ("127.0.0.1", "::1")


def access_auth_enabled() -> bool:
    return bool(CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN)


def is_local_probe(request) -> bool:
    """True only for a direct loopback request with no proxy/edge headers."""
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK_HOSTS:
        return False
    return not any(h in request.headers for h in _PROXY_HEADERS)


def _fetch_jwks(team_domain: str) -> Optional[list]:
    import httpx

    try:
        r = httpx.get(f"https://{team_domain}/cdn-cgi/access/certs", timeout=5.0)
        r.raise_for_status()
        keys = (r.json() or {}).get("keys")
        return keys if isinstance(keys, list) and keys else None
    except Exception as exc:
        log.error("access jwks fetch failed: %s", type(exc).__name__)
        return None


def _get_jwks(team_domain: str, force: bool = False) -> Optional[list]:
    """JWKS with a 1 h cache. force=True (unknown kid) refetches at most once
    per JWKS_MIN_REFRESH_S so forged kids cannot hammer the certs endpoint.
    A failed fetch never evicts a still-cached key set."""
    with _jwks_lock:
        now = time.monotonic()
        cached = _jwks_cache.get(team_domain)
        if cached:
            age = now - cached[0]
            if age < JWKS_CACHE_S and not (force and age >= JWKS_MIN_REFRESH_S):
                return cached[1]
        keys = _fetch_jwks(team_domain)
        if keys is not None:
            _jwks_cache[team_domain] = (now, keys)
            return keys
        if cached and now - cached[0] < JWKS_CACHE_S:
            return cached[1]
        return None


def verify_access_jwt(token: str) -> bool:
    """RS256 Cloudflare Access JWT check (aud + iss). Fail closed; no logging
    of the token or of any value derived from it."""
    if not access_auth_enabled() or not token:
        return False
    import json as _json

    import jwt  # PyJWT

    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256":
            return False
        kid = header.get("kid")
        if not kid:
            return False
        def _find(keys):
            return next((k for k in keys or [] if isinstance(k, dict) and k.get("kid") == kid), None)

        match = _find(_get_jwks(CF_ACCESS_TEAM_DOMAIN))
        if match is None:
            # key rotation: refetch once (rate-limited), then fail closed
            match = _find(_get_jwks(CF_ACCESS_TEAM_DOMAIN, force=True))
        if match is None:
            return False
        pub = jwt.algorithms.RSAAlgorithm.from_jwk(_json.dumps(match))
        jwt.decode(
            token,
            pub,
            algorithms=["RS256"],
            audience=CF_ACCESS_AUD,
            issuer=f"https://{CF_ACCESS_TEAM_DOMAIN}",
            options={"require": ["exp", "aud", "iss"]},
            leeway=30,
        )
        return True
    except Exception:
        return False


# ------------------------------------------------------------------- routes ---
from fastapi import APIRouter  # noqa: E402

router = APIRouter(prefix="/voice")


@router.get("/health")
def health():
    return {"ok": True, "live": _gemini_api_key() is not None, "model": LIVE_MODEL}


# Client diagnostics (2026-10-07): the browser reports live-call milestones so
# failures are visible in this journal. Allow-listed names + one number
# only; never text or audio.
CLIENT_EVENTS = {
    "call-start", "call-end", "mic-ok", "mic-error", "live-open", "live-close",
    "live-error", "tool-call", "reconnect", "push-update", "interrupted",
    "barge-in", "barge-echo", "turn-nudge", "reply-rescue",
    "mute", "unmute", "version-reload", "auto-call",
    # Barge retune 2 (owner 23:4x): loudest non-barging mic level per reply.
    "voice-peak",
    # Owner 2026-10-08: Google's close code per dropped live socket (n = code,
    # 4408 = no setupComplete) and the call bar's retry tap.
    "live-drop", "live-retry",
}


@router.post("/event")
def client_event(e: str, n: int = 0):
    if e not in CLIENT_EVENTS:
        raise HTTPException(status_code=400, detail="unknown event")
    log.info("client event=%s n=%d", e, max(-1, min(n, 10_000_000)))
    return {"ok": True}


# Call transcripts (owner ruling 2026-10-07): the browser posts what the owner
# said, what Gemini said, tool calls/results, context and updates; each call is
# appended as JSONL to TRANSCRIPT_DIR/<YYYY-MM-DD>/<call>.jsonl (0600) so Claude
# can review the call afterwards. Text is never written to the journal.
TRANSCRIPT_DIR = Path(os.environ.get("VOICE_TRANSCRIPT_DIR", "/var/lib/voice-gateway/transcripts"))
TRANSCRIPT_ROLES = {"owner", "gemini", "tool-call", "tool-result", "context", "update", "event"}
TRANSCRIPT_MAX_BODY = 512 * 1024
TRANSCRIPT_MAX_ENTRIES = 500
TRANSCRIPT_MAX_TEXT = 20_000
_CALL_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_transcript_lock = threading.Lock()
# Owner ruling 2026-10-07: transcripts are kept 7 days. Day folders older than
# that are pruned at startup and, at most hourly, on the next transcript write.
TRANSCRIPT_KEEP_DAYS = int(os.environ.get("VOICE_TRANSCRIPT_KEEP_DAYS", "7"))
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_last_prune = 0.0


def prune_transcripts(today=None) -> int:
    """Deletes <call>.jsonl files in day folders older than TRANSCRIPT_KEEP_DAYS
    (then the empty folder). Only YYYY-MM-DD folders are touched. Returns the
    number of files removed; never raises."""
    removed = 0
    # today plus the 6 days before it = 7 days kept
    cutoff = (today or datetime.now().date()) - timedelta(days=max(1, TRANSCRIPT_KEEP_DAYS) - 1)
    try:
        # wave-1 security: a symlinked folder is never followed out of the root
        days = [d for d in TRANSCRIPT_DIR.iterdir() if not d.is_symlink() and d.is_dir() and _DAY_RE.match(d.name)]
    except OSError:
        return 0
    for day in days:
        try:
            if datetime.strptime(day.name, "%Y-%m-%d").date() >= cutoff:
                continue
            for f in day.glob("*.jsonl"):
                f.unlink()
                removed += 1
            day.rmdir()
        except (OSError, ValueError):
            continue  # one bad folder never stops the rest
    if removed:
        log.info("transcripts pruned files=%d keep_days=%d", removed, TRANSCRIPT_KEEP_DAYS)
    return removed


def _maybe_prune() -> None:
    global _last_prune
    if time.monotonic() - _last_prune < 3600:
        return
    _last_prune = time.monotonic()
    prune_transcripts()


def _transcript_path(call: str) -> Path:
    # One file per call; the first write fixes the day folder, so a call that
    # crosses midnight stays in one file.
    for existing in sorted(TRANSCRIPT_DIR.glob(f"*/{call}.jsonl")):
        return existing
    return TRANSCRIPT_DIR / datetime.now().strftime("%Y-%m-%d") / f"{call}.jsonl"


@router.post("/transcript")
async def transcript(call: str, request: Request):
    if not _CALL_ID_RE.match(call):
        raise HTTPException(status_code=400, detail="bad call id")
    raw = await request.body()
    if len(raw) > TRANSCRIPT_MAX_BODY:
        raise HTTPException(status_code=413, detail="too large")
    try:
        entries = json.loads(raw).get("entries")
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    if not isinstance(entries, list) or len(entries) > TRANSCRIPT_MAX_ENTRIES:
        raise HTTPException(status_code=400, detail="bad entries")
    lines = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise HTTPException(status_code=400, detail="bad entry")
        role, text, at = entry.get("role"), entry.get("text"), entry.get("t")
        if role not in TRANSCRIPT_ROLES or not isinstance(text, str) or not isinstance(at, (int, float)):
            raise HTTPException(status_code=400, detail="bad entry")
        lines.append(json.dumps({"t": int(at), "role": role, "text": text[:TRANSCRIPT_MAX_TEXT]}, ensure_ascii=False))
    if lines:
        with _transcript_lock:
            path = _transcript_path(call)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
            _maybe_prune()
    log.info("transcript call=%s entries=%d", call[:12], len(lines))  # never the text
    return {"ok": True}


@router.post("/live-token")
def live_token():
    key = _gemini_api_key()
    if not key:
        return JSONResponse(status_code=503, content={"error": "not_configured"}, headers=_NO_STORE)
    try:
        system_text = LIVE_SETUP_MD.read_text()
    except OSError:
        log.error("live-system.md unreadable")
        return JSONResponse(status_code=503, content={"error": "not_configured"}, headers=_NO_STORE)

    with _token_rate_lock:
        now = time.monotonic()
        if now - _token_rate["last"] < TOKEN_RATE_LIMIT_S:
            return JSONResponse(status_code=429, content={"error": "rate_limited"}, headers=_NO_STORE)
        _token_rate["last"] = now

    now_dt = datetime.now(timezone.utc)
    body = {
        "uses": 1,
        "expireTime": _rfc3339(now_dt + timedelta(minutes=TOKEN_TTL_MIN)),
        "newSessionExpireTime": _rfc3339(now_dt + timedelta(minutes=NEW_SESSION_TTL_MIN)),
        "bidiGenerateContentSetup": {
            "model": "models/" + LIVE_MODEL,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": LIVE_VOICE}},
                    "languageCode": LIVE_LANG,
                },
                # The extended-thinking model accepts only async (NON_BLOCKING)
                # tools and no response scheduling; plain gemini-3.8-live
                # rejects thinkingConfig, so it is sent for the former only.
                **({"thinkingConfig": {"thinkingLevel": LIVE_THINKING}} if "extended-thinking" in LIVE_MODEL else {}),
            },
            "systemInstruction": {"parts": [{"text": system_text}]},
            "tools": LIVE_TOOLS,
            "sessionResumption": {},
            "contextWindowCompression": {"slidingWindow": {}},
            # F10 (WO-VL-FIX): owner-speech transcription frames feed the
            # client's prompt-injection gate (serverContent.inputTranscription).
            # Owner 2026-10-07: English words said inside Arabic stay in English
            # letters ("الـ settings", not "السيتنجز") — the en-US hint does it.
            "inputAudioTranscription": {"languageCodes": ["ar-EG", "en-US"]},
            # Call transcripts (owner ruling 2026-10-07): Gemini's own speech
            # as text, recorded next to the owner's words for later review.
            "outputAudioTranscription": {},
            # Owner 2026-10-07: mid-sentence pauses must not end the owner's
            # turn (Gemini answered half sentences); server default is ~800 ms.
            # END_SENSITIVITY_LOW was dropped: with room noise the turn never
            # ended and Gemini went silent.
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "silenceDurationMs": LIVE_SILENCE_MS,
                },
            },
        },
    }
    try:
        with _http_client() as hc:
            r = hc.post(GOOGLE_AUTH_TOKENS_URL, headers={"x-goog-api-key": key}, json=body)
    except httpx.HTTPError as exc:
        log.error("live token request failed: %s", type(exc).__name__)
        return JSONResponse(status_code=502, content={"error": "token_failed", "status": 0}, headers=_NO_STORE)
    if r.status_code != 200:
        # Never echo the Google response body (it can quote the key).
        log.error("live token rejected status=%d", r.status_code)
        return JSONResponse(status_code=502, content={"error": "token_failed", "status": r.status_code}, headers=_NO_STORE)
    try:
        data = r.json()
        token = data["name"]
        expires_at = data.get("expireTime") or body["expireTime"]
    except Exception:
        log.error("live token response malformed")
        return JSONResponse(status_code=502, content={"error": "token_failed", "status": r.status_code}, headers=_NO_STORE)
    log.info("live token ok model=%s", LIVE_MODEL)  # never the token or the key
    return JSONResponse(
        content={"token": token, "model": LIVE_MODEL, "expiresAt": expires_at, "wsUrl": LIVE_WS_URL},
        headers={"Cache-Control": "no-store"},
    )


# ----------------------------------------------------------------- startup ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("startup done live_model=%s key_configured=%s", LIVE_MODEL, _gemini_api_key() is not None)
    _maybe_prune()
    yield


app = FastAPI(title="voice-gateway", lifespan=lifespan)
app.include_router(router)


@app.middleware("http")
async def _cf_access_guard(request, call_next):
    """S1: opt-in Cloudflare Access JWT gate. Only a direct local probe of
    GET /voice/health (loopback peer, no proxy/edge headers) is exempt;
    everything else — including /voice/health arriving through the tunnel —
    needs a valid Cf-Access-Jwt-Assertion when CF_ACCESS_AUD +
    CF_ACCESS_TEAM_DOMAIN are set. Fails closed; token values never logged."""
    if access_auth_enabled():
        path = request.url.path
        health_probe = (
            request.method == "GET"
            and path.rstrip("/") == "/voice/health"
            and is_local_probe(request)
        )
        if not health_probe:
            token = request.headers.get("cf-access-jwt-assertion", "")
            ok = await run_in_threadpool(verify_access_jwt, token) if token else False
            if not ok:
                return JSONResponse(status_code=401, content={"detail": "unauthorized"})
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def _validation_to_400(request, exc):
    # contract: bad input is 400 (not FastAPI's 422); never echo submitted values
    detail = [{"loc": e.get("loc"), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()[:5]]
    return JSONResponse(status_code=400, content={"detail": detail})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("VOICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("VOICE_PORT", "3012")),
        log_level="info",
        access_log=True,
    )
