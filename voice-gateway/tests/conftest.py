"""Shared fixtures: app TestClient + Cloudflare Access guard helpers.

No speech models, GPU children or port env anymore (WO-VL-GW 2026-10-07).

The suite is hermetic: the shell that runs pytest exports the live CF_ACCESS_*
values, so they are dropped here before app is imported (app reads them at
import time). Guard tests switch the gate on per test through `access_on`.
"""

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

for _var in ("CF_ACCESS_AUD", "CF_ACCESS_TEAM_DOMAIN"):
    os.environ.pop(_var, None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as vg  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(vg.app) as c:
        yield c


# ------------------------------------------- Cloudflare Access guard (S1) ---
AUD = "915136dc-test-aud"
TEAM = "example-team.cloudflareaccess.com"


@pytest.fixture(scope="module")
def rsa_pair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import jwt as pyjwt

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    jwk = pyjwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": "test-kid", "alg": "RS256", "use": "sig"})
    return priv_pem, jwk


@pytest.fixture()
def access_on(monkeypatch, rsa_pair):
    """Enable the Access gate against a local fake JWKS; returns (make_token, fetches)."""
    _, jwk = rsa_pair
    monkeypatch.setattr(vg, "CF_ACCESS_AUD", AUD)
    monkeypatch.setattr(vg, "CF_ACCESS_TEAM_DOMAIN", TEAM)
    fetches = {"n": 0}

    def fake_fetch(team_domain):
        fetches["n"] += 1
        return [dict(jwk)]

    monkeypatch.setattr(vg, "_fetch_jwks", fake_fetch)
    vg._jwks_cache.clear()
    yield fetches
    vg._jwks_cache.clear()


def make_token(priv_pem, aud=AUD, team=TEAM, exp_delta=600, kid="test-kid", alg="RS256"):
    import jwt as pyjwt

    now = int(time.time())
    claims = {"aud": aud, "iss": f"https://{team}", "sub": "test-user", "iat": now}
    if exp_delta is not None:
        claims["exp"] = now + exp_delta
    return pyjwt.encode(claims, priv_pem, algorithm=alg, headers={"kid": kid})


@pytest.fixture()
def loopback_client(client):
    # same app (lifespan already up via the session client); peer = 127.0.0.1
    return TestClient(vg.app, client=("127.0.0.1", 50123))
