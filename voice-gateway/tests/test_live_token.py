"""POST /voice/live-token tests (WO-VL-GW 2026-10-07). Google is mocked via
httpx.MockTransport; the API key is a fake value that must never appear in a
response body or in captured logs."""

import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import app as vg
from conftest import make_token

FAKE_KEY = "FAKE-GEMINI-KEY-must-never-leak-9f1c"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    monkeypatch.setitem(vg._token_rate, "last", 0.0)


@pytest.fixture()
def mock_google(monkeypatch):
    """Install a MockTransport-backed client factory; returns a state dict the
    tests configure with (status, payload) and read captured requests from."""
    state = {"status": 200, "payload": {"name": "auth_tokens/abc123", "expireTime": "2026-10-07T13:00:00Z"}, "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        return httpx.Response(state["status"], json=state["payload"])

    def factory():
        return httpx.Client(transport=httpx.MockTransport(handler), timeout=vg.GOOGLE_HTTP_TIMEOUT_S)

    monkeypatch.setattr(vg, "_http_client", factory)
    return state


def _mint(client):
    return client.post("/voice/live-token")


# ------------------------------------------------------------------ success ---
def test_token_success_shape_and_no_store(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    r = _mint(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"token", "model", "expiresAt", "wsUrl"}
    assert body["token"] == "auth_tokens/abc123"
    assert body["model"] == "gemini-3.8-live"
    assert body["expiresAt"] == "2026-10-07T13:00:00Z"
    assert body["wsUrl"] == vg.LIVE_WS_URL
    assert r.headers["cache-control"] == "no-store"


def test_token_locked_request_body(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    t0 = datetime.now(timezone.utc)
    assert _mint(client).status_code == 200
    req = mock_google["requests"][0]
    assert str(req.url) == "https://generativelanguage.googleapis.com/v1beta/auth_tokens"
    assert req.headers["x-goog-api-key"] == FAKE_KEY

    sent = json.loads(req.content)
    assert sent["uses"] == 1

    exp = datetime.fromisoformat(sent["expireTime"].replace("Z", "+00:00"))
    nse = datetime.fromisoformat(sent["newSessionExpireTime"].replace("Z", "+00:00"))
    assert timedelta(minutes=29, seconds=30) <= exp - t0 <= timedelta(minutes=31)
    assert timedelta(seconds=55) <= nse - t0 <= timedelta(minutes=1, seconds=5)

    setup = sent["bidiGenerateContentSetup"]
    assert setup["model"] == "models/gemini-3.8-live"
    gen = setup["generationConfig"]
    assert gen["responseModalities"] == ["AUDIO"]
    assert gen["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Charon"
    assert gen["speechConfig"]["languageCode"] == "ar-EG"
    assert "thinkingConfig" not in gen  # gemini-3.8-live rejects thinkingLevel
    assert setup["systemInstruction"] == {"parts": [{"text": (vg.BASE_DIR / "live-system.md").read_text()}]}
    assert setup["sessionResumption"] == {}
    assert setup["contextWindowCompression"] == {"slidingWindow": {}}
    # F10: owner-speech transcription feeds the client gate; Gemini's speech
    # transcription feeds the call transcript (owner ruling 2026-10-07).
    assert setup["inputAudioTranscription"] == {"languageCodes": ["ar-EG", "en-US"]}
    assert setup["outputAudioTranscription"] == {}
    vad = setup["realtimeInputConfig"]["automaticActivityDetection"]
    assert vad == {"silenceDurationMs": 1200}  # no LOW end sensitivity: noise kept the turn open

    decls = setup["tools"][0]["functionDeclarations"]
    assert [d["name"] for d in decls] == [
        "get_claude_status",
        "send_to_claude",
        "stop_claude",
        "read_claude_message",
        "answer_claude_question",
    ]
    # async on every tool (required by the extended-thinking model, default on 3.8 Live)
    assert all(d["behavior"] == "NON_BLOCKING" for d in decls)
    # NEG CONTROL: no declaration may ever carry a blocking behavior
    assert not [d for d in decls if d.get("behavior") != "NON_BLOCKING"]
    send = decls[1]
    params = send["parameters"]
    assert params["required"] == ["instruction"]
    assert params["properties"]["instruction"]["type"] == "string"
    assert params["properties"]["when"]["enum"] == ["now", "after"]
    # owner 2026-10-07: read one full claude message + answer the on-screen question
    # owner 2026-10-07 (call 211015): the waiting plan is read with plan=true, so back is optional
    read = decls[3]
    assert read["parameters"]["properties"]["plan"]["type"] == "boolean"
    assert "required" not in read["parameters"]  # back is optional when plan=true
    read = decls[3]
    assert read["parameters"]["properties"]["back"]["type"] == "integer"
    # owner 2026-10-07 ("I kept saying كمّل"): optional part to resume a long message
    assert read["parameters"]["properties"]["part"]["type"] == "integer"
    assert "part" not in read["parameters"].get("required", [])
    # owner 2026-10-07 23:1x: "only this part" stops the automatic next parts
    assert read["parameters"]["properties"]["only"]["type"] == "boolean"
    assert "only" not in read["parameters"].get("required", [])
    answer = decls[4]
    assert answer["parameters"]["required"] == ["answers"]
    assert answer["parameters"]["properties"]["answers"]["type"] == "object"


def test_extended_thinking_model_sends_thinking_config(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    monkeypatch.setattr(vg, "LIVE_MODEL", "gemini-3.8-live-extended-thinking")
    monkeypatch.setattr(vg, "LIVE_THINKING", "low")
    assert _mint(client).status_code == 200
    setup = json.loads(mock_google["requests"][0].content)["bidiGenerateContentSetup"]
    assert setup["model"] == "models/gemini-3.8-live-extended-thinking"
    assert setup["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
    assert all(d["behavior"] == "NON_BLOCKING" for d in setup["tools"][0]["functionDeclarations"])


def test_token_falls_back_to_google_expire_time(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["payload"] = {"name": "auth_tokens/x"}  # no expireTime in Google reply
    r = _mint(client)
    assert r.status_code == 200
    assert r.json()["expiresAt"]  # falls back to the requested TTL timestamp


# -------------------------------------------------------------- error paths ---
def test_no_key_503(client, mock_google):
    r = _mint(client)
    assert r.status_code == 503
    assert r.json() == {"error": "not_configured"}
    assert r.headers["cache-control"] == "no-store"  # F10
    assert mock_google["requests"] == []  # never reached Google


def test_google_4xx_maps_502_no_body_leak(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["status"] = 400
    mock_google["payload"] = {"error": {"message": "secret-google-detail API_KEY_INVALID"}}
    r = _mint(client)
    assert r.status_code == 502
    assert r.json() == {"error": "token_failed", "status": 400}
    assert r.headers["cache-control"] == "no-store"  # F10
    assert "secret-google-detail" not in r.text
    assert FAKE_KEY not in r.text


def test_google_5xx_maps_502(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["status"] = 503
    mock_google["payload"] = {}
    r = _mint(client)
    assert r.status_code == 502
    assert r.json() == {"error": "token_failed", "status": 503}


def test_transport_error_maps_502(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)

    def broken_factory():
        def handler(request):
            raise httpx.ConnectError("boom")
        return httpx.Client(transport=httpx.MockTransport(handler), timeout=vg.GOOGLE_HTTP_TIMEOUT_S)

    monkeypatch.setattr(vg, "_http_client", broken_factory)
    r = _mint(client)
    assert r.status_code == 502
    assert r.json() == {"error": "token_failed", "status": 0}


def test_malformed_google_response_maps_502(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["payload"] = {"unexpected": True}
    r = _mint(client)
    assert r.status_code == 502
    assert r.json() == {"error": "token_failed", "status": 200}


# ---------------------------------------------------------------- rate limit ---
def test_rate_limit_429_after_success(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    assert _mint(client).status_code == 200
    r = _mint(client)  # immediate second request
    assert r.status_code == 429
    assert r.headers["cache-control"] == "no-store"  # F10
    assert len(mock_google["requests"]) == 1


def test_rate_limit_slot_consumed_on_failure(client, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["status"] = 500
    mock_google["payload"] = {}
    assert _mint(client).status_code == 502
    assert _mint(client).status_code == 429  # retries cannot hammer Google while it errors


# ---------------------------------------------------------------- secrets ----
def test_key_never_in_response_or_logs(client, monkeypatch, mock_google, caplog):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    mock_google["status"] = 400
    mock_google["payload"] = {"error": {"message": f"key {FAKE_KEY} invalid"}}
    with caplog.at_level(logging.DEBUG):
        r_fail = _mint(client)
        monkeypatch.setitem(vg._token_rate, "last", 0.0)
        mock_google["status"] = 200
        mock_google["payload"] = {"name": "auth_tokens/abc123"}
        r_ok = _mint(client)
    assert r_fail.status_code == 502 and r_ok.status_code == 200
    assert FAKE_KEY not in r_fail.text
    assert FAKE_KEY not in r_ok.text
    assert FAKE_KEY not in caplog.text
    assert r_ok.json()["token"] == "auth_tokens/abc123"  # token value itself is the payload, not the key


# ------------------------------------------------- NEG CONTROL: Access gate ---
def test_live_token_401_without_jwt(client, access_on, rsa_pair, monkeypatch, mock_google):
    """NEGATIVE CONTROL (spec): CF_ACCESS_AUD+TEAM set, no JWT header -> 401,
    and Google is never called."""
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    r = client.post("/voice/live-token")
    assert r.status_code == 401
    assert r.json() == {"detail": "unauthorized"}
    assert mock_google["requests"] == []


def test_live_token_200_with_valid_jwt(client, access_on, rsa_pair, monkeypatch, mock_google):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    priv_pem, _ = rsa_pair
    r = client.post("/voice/live-token", headers={"cf-access-jwt-assertion": make_token(priv_pem)})
    assert r.status_code == 200, r.text
    assert len(mock_google["requests"]) == 1
