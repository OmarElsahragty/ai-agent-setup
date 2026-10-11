"""Slim app tests (WO-VL-GW 2026-10-07): health, client events and the
Cloudflare Access guard. Token endpoint tests live in test_live_token.py."""

import pytest
from fastapi.testclient import TestClient

import app as vg
from conftest import AUD, TEAM, make_token


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    """Deterministic key-configured state for health assertions."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)


# ------------------------------------------------------------------ health ---
def test_health(client):
    r = client.get("/voice/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "live": False, "model": "gemini-3.8-live"}


def test_health_reports_key_configured(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-value")
    assert client.get("/voice/health").json()["live"] is True


# ------------------------------------------------------------------ events ---
def test_client_event_allow_list(client):
    for e in (
        "call-start", "call-end", "mic-ok", "mic-error", "live-open", "live-close",
        "live-error", "tool-call", "reconnect", "push-update", "interrupted", "barge-in", "barge-echo", "turn-nudge", "reply-rescue",
        "mute", "unmute", "version-reload", "auto-call", "voice-peak", "live-drop", "live-retry",
    ):
        r = client.post(f"/voice/event?e={e}&n=2")
        assert r.status_code == 200, e
        assert r.json() == {"ok": True}


def test_client_event_rejects_unknown(client):
    assert client.post("/voice/event?e=vad-start").status_code == 400  # old allow-list name
    assert client.post("/voice/event?e=hello").status_code == 400


def test_client_event_bad_number_is_400(client):
    assert client.post("/voice/event?e=mic-ok&n=abc").status_code == 400


# --------------------------------------------- Cloudflare Access guard (S1) ---
def test_access_disabled_by_default(client, monkeypatch):
    monkeypatch.setattr(vg, "CF_ACCESS_AUD", None)
    monkeypatch.setattr(vg, "CF_ACCESS_TEAM_DOMAIN", None)
    r = client.post("/voice/event?e=call-start")
    assert r.status_code == 200, r.text


def test_access_missing_token_401(client, access_on):
    assert client.post("/voice/event?e=call-start").status_code == 401


def test_access_garbage_token_401(client, access_on):
    r = client.post(
        "/voice/event?e=call-start",
        headers={"cf-access-jwt-assertion": "not-a-jwt"},
    )
    assert r.status_code == 401


def test_access_valid_token_200(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    token = make_token(priv_pem)
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
    assert r.status_code == 200, r.text


def test_access_wrong_aud_401(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    token = make_token(priv_pem, aud="some-other-app")
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
    assert r.status_code == 401


def test_access_wrong_iss_401(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    token = make_token(priv_pem, team="evil.example.com")
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
    assert r.status_code == 401


def test_access_expired_token_401(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    token = make_token(priv_pem, exp_delta=-300)
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
    assert r.status_code == 401


def test_access_unknown_kid_401(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    token = make_token(priv_pem, kid="unknown-kid")
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
    assert r.status_code == 401


def test_access_health_local_probe_exempt(loopback_client, access_on):
    assert loopback_client.get("/voice/health").status_code == 200


def test_access_health_via_tunnel_needs_jwt(loopback_client, access_on, rsa_pair):
    # loopback peer BUT edge/proxy headers = came through cloudflared -> JWT required
    for hdr in ({"cf-connecting-ip": "203.0.113.7"}, {"cf-ray": "abc-CAI"}, {"x-forwarded-for": "203.0.113.7"}):
        assert loopback_client.get("/voice/health", headers=hdr).status_code == 401
    priv_pem, _ = rsa_pair
    hdr = {"cf-connecting-ip": "203.0.113.7", "cf-access-jwt-assertion": make_token(priv_pem)}
    assert loopback_client.get("/voice/health", headers=hdr).status_code == 200


def test_access_health_non_loopback_needs_jwt(client, access_on):
    # TestClient default peer is "testclient" (not loopback) -> no exemption
    assert client.get("/voice/health").status_code == 401


def test_access_health_non_get_still_guarded(loopback_client, access_on):
    assert loopback_client.post("/voice/health").status_code == 401


def test_access_other_routes_need_jwt_even_from_loopback(loopback_client, access_on):
    assert loopback_client.post("/voice/live-token").status_code == 401
    assert loopback_client.post("/voice/event?e=call-start").status_code == 401


def test_access_unknown_kid_refetch_rate_limited(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    hdr = {"cf-access-jwt-assertion": make_token(priv_pem, kid="rotated-kid")}
    assert client.post("/voice/event?e=call-start", headers=hdr).status_code == 401
    first = access_on["n"]
    assert first >= 1
    for _ in range(3):  # forged kids cannot hammer the certs endpoint
        assert client.post("/voice/event?e=call-start", headers=hdr).status_code == 401
    assert access_on["n"] == first


def test_access_jwks_cached(client, access_on, rsa_pair):
    priv_pem, _ = rsa_pair
    for _ in range(3):
        r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": make_token(priv_pem)})
        assert r.status_code == 200
    assert access_on["n"] == 1  # JWKS fetched once, then served from the 1 h cache


def test_access_jwks_down_fails_closed(client, monkeypatch, rsa_pair):
    monkeypatch.setattr(vg, "CF_ACCESS_AUD", AUD)
    monkeypatch.setattr(vg, "CF_ACCESS_TEAM_DOMAIN", TEAM)
    monkeypatch.setattr(vg, "_fetch_jwks", lambda td: None)  # JWKS unreachable
    vg._jwks_cache.clear()
    priv_pem, _ = rsa_pair
    r = client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": make_token(priv_pem)})
    assert r.status_code == 401
    vg._jwks_cache.clear()


def test_access_token_never_logged(client, access_on, rsa_pair, caplog):
    import logging as _logging

    priv_pem, _ = rsa_pair
    token = make_token(priv_pem)
    with caplog.at_level(_logging.DEBUG):
        client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": token})
        client.post("/voice/event?e=call-start", headers={"cf-access-jwt-assertion": "garbage"})
        client.get("/voice/health")
    assert token not in caplog.text


def test_every_client_event_name_is_allow_listed():
    """Review 23:5x: voice-peak was emitted but not allow-listed (400, never in
    the journal). Every literal event name the add-on can send must be listed.

    The add-on tree sits next to this repo in the installation root; the check
    never depends on a hardcoded host path."""
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "cloudcli-voice"
    if not root.is_dir():
        pytest.skip(f"cloudcli-voice add-on tree not installed at {root}")
    names = set()
    for f in [root / "voice-addon.js", *sorted((root / "lib").glob("*.mjs"))]:
        text = f.read_text()
        names |= set(re.findall(r"emitEvent\('([a-z-]+)'", text))
        names |= set(re.findall(r"beacon\('([a-z-]+)'", text))
        for a, b in re.findall(r"emitEvent\([^,]*\? '([a-z-]+)' : '([a-z-]+)'", text):
            names |= {a, b}
    assert "voice-peak" in names and "barge-in" in names, names
    assert names <= vg.CLIENT_EVENTS, sorted(names - vg.CLIENT_EVENTS)
