"""Bearer-token gate of opencode-hub (audit F3). Integration cases run a temp hub (conftest.start_hub);
unit cases import the hub module. Against git HEAD (no token support) the token cases must fail."""
import importlib.util
import os
import time

import anyio
import httpx
import mcp.types as types
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from conftest import HUB

INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": types.LATEST_PROTOCOL_VERSION, "capabilities": {},
                   "clientInfo": {"name": "hub-test", "version": "0"}}}
MCP_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


def post_init(hub, headers=None):
    return httpx.post(hub.url("/mcp/tiny"), json=INIT, headers={**MCP_HEADERS, **(headers or {})}, timeout=15)


def list_tools(hub, token=None) -> list[str]:
    async def main():
        headers = {"Authorization": f"Bearer {token}"} if token else None
        async with streamablehttp_client(hub.url("/mcp/tiny"), headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return [tool.name for tool in (await session.list_tools()).tools]
    return anyio.run(main)


# ---- integration: token required ----------------------------------------------------------------

def test_no_token_is_401(start_hub):
    hub = start_hub("valid")
    res = post_init(hub)
    assert res.status_code == 401
    assert res.headers.get("www-authenticate", "").lower().startswith("bearer")
    assert httpx.get(hub.url("/mcp/tiny"), headers={"accept": "text/event-stream"}, timeout=10).status_code == 401


def test_wrong_token_is_401(start_hub):
    hub = start_hub("valid")
    tok = hub.token
    # ("Bearer " with a trailing space cannot be sent: httpx rejects it as an illegal header value)
    for value in (f"Bearer {'x' * len(tok)}", f"Bearer {tok[:-1]}", f"Bearer {tok}x", f"Basic {tok}", tok,
                  "Bearer"):
        assert post_init(hub, {"authorization": value}).status_code == 401, value[:7]


def test_right_token_lists_tools(start_hub):
    hub = start_hub("valid")
    assert post_init(hub, {"authorization": f"Bearer {hub.token}"}).status_code == 200
    assert post_init(hub, {"authorization": f"bearer   {hub.token}"}).status_code == 200  # scheme any case
    assert "ping" in list_tools(hub, hub.token)


def test_static_routes_need_no_token(start_hub):
    hub = start_hub("valid")
    health = httpx.get(hub.url("/health"), timeout=10)
    assert health.status_code == 200 and health.json()["auth"] == "token"
    assert httpx.get(hub.url("/.well-known/opencode"), timeout=10).status_code == 200
    assert httpx.get(hub.url("/plugins/demo-1.0.0.tgz"), timeout=10).status_code == 200
    # exempt means GET/HEAD of those paths only
    assert httpx.post(hub.url("/health"), timeout=10).status_code == 401
    assert httpx.post(hub.url("/decide/hook/opencode/Stop"), json={}, timeout=10).status_code == 401


def test_browser_origin_refused_even_with_token(start_hub):
    hub = start_hub("valid")
    res = post_init(hub, {"authorization": f"Bearer {hub.token}", "origin": "https://evil.example"})
    assert res.status_code == 403


def test_token_is_never_logged(start_hub):
    hub = start_hub("valid")
    wrong = "W" * 64
    post_init(hub)
    post_init(hub, {"authorization": f"Bearer {wrong}"})
    post_init(hub, {"authorization": f"Bearer {hub.token}"})
    text = hub.log_text()
    assert "401" in text
    assert hub.token not in text and wrong not in text


def test_unusable_token_file_fails_closed(start_hub):
    hub = start_hub("group-readable")
    assert httpx.get(hub.url("/health"), timeout=10).json()["auth"] == "token-file-unusable"
    assert post_init(hub, {"authorization": f"Bearer {hub.token}"}).status_code == 401
    text = hub.log_text()
    assert "mode 0600" in text and hub.token not in text


def test_report_mode_lets_through_and_logs(start_hub):
    hub = start_hub("valid", {"OPENCODE_HUB_TOKEN_MODE": "report"})
    assert httpx.get(hub.url("/health"), timeout=10).json()["auth"] == "token-report"
    assert post_init(hub).status_code == 200
    assert "ping" in list_tools(hub)
    text = hub.log_text()
    assert "report-only" in text and hub.token not in text


def test_no_token_file_keeps_pre_f3_behaviour(start_hub):
    hub = start_hub(None)
    assert "auth" not in httpx.get(hub.url("/health"), timeout=10).json()
    assert post_init(hub).status_code == 200
    assert post_init(hub, {"authorization": "Bearer anything"}).status_code == 200  # ignored, as before
    assert "ping" in list_tools(hub)
    assert "auth:" not in hub.log_text()


def test_unset_env_is_byte_identical_to_head(start_hub, head_hub):
    """OPENCODE_HUB_TOKEN_FILE unset: the working-tree hub answers exactly like git HEAD's (status,
    content-type, www-authenticate, body bytes) for every route class the token gate touches."""
    same_url = {"OPENCODE_HUB_URL": "http://127.0.0.1:1"}  # /.well-known templating must not embed the port
    old, new = start_hub(None, same_url, hub_path=head_hub), start_hub(None, same_url)
    probes = [
        ("GET", "/.well-known/opencode", {}, None), ("GET", "/plugins/demo-1.0.0.tgz", {}, None),
        ("HEAD", "/health", {}, None), ("GET", "/nope", {}, None), ("POST", "/health", {}, None),
        ("POST", "/mcp/tiny", MCP_HEADERS, INIT),
        ("POST", "/mcp/tiny", {**MCP_HEADERS, "authorization": "Bearer x"}, INIT),
        ("POST", "/mcp/tiny", {**MCP_HEADERS, "origin": "https://evil.example"}, INIT),
        ("GET", "/mcp/tiny", {"host": "evil.example"}, None),
        ("POST", "/decide/hook/opencode/Stop", {"x-raw": b"\xff"}, {}),  # non-UTF-8 header: HEAD's 500
    ]

    def answer(hub, method, path, headers, body):
        res = httpx.request(method, hub.url(path), headers=headers, json=body, timeout=15)
        return (res.status_code, res.headers.get("content-type"), res.headers.get("www-authenticate"),
                res.content)

    for method, path, headers, body in probes:
        assert answer(old, method, path, headers, body) == answer(new, method, path, headers, body), (method, path)
    deadline = time.monotonic() + 15  # /health bytes once both report the same running set
    while True:
        old_health, new_health = (httpx.get(h.url("/health"), timeout=10).content for h in (old, new))
        if old_health == new_health or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    assert old_health == new_health


# ---- unit: token_verdict / load_token --------------------------------------------------------------

@pytest.fixture
def hubmod(monkeypatch):
    monkeypatch.delenv("OPENCODE_HUB_TOKEN_FILE", raising=False)
    spec = importlib.util.spec_from_file_location("hub_under_test", HUB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.TOKEN_FILE, mod.EXPECTED_BEARER, mod.TOKEN_OFFBOX = "/unused", b"t" * 40, True
    return mod


def scope(method="POST", path="/mcp/exa", client="127.0.0.1", auth=None):
    headers = [(b"host", b"127.0.0.1")] + ([(b"authorization", auth)] if auth is not None else [])
    return {"type": "http", "method": method, "path": path, "headers": headers, "client": (client, 5000)}


def test_verdict_offbox_switch(hubmod):
    mac = scope(client="100.64.0.2")
    assert hubmod.token_verdict(mac) == "missing"
    hubmod.TOKEN_OFFBOX = False
    assert hubmod.token_verdict(mac) is None
    assert hubmod.token_verdict(scope()) == "missing"  # loopback always needs it


def test_verdict_exempt_paths(hubmod):
    v = hubmod.token_verdict
    assert v(scope("GET", "/health")) is None and v(scope("HEAD", "/health")) is None
    assert v(scope("GET", "/.well-known/opencode")) is None
    assert v(scope("GET", "/plugins/homelab-bridge-1.0.0-92eb2ff85dba.tgz")) is None
    for method, path in (("GET", "/plugins/.hidden"), ("GET", "/plugins/a/b"), ("GET", "/plugins/../x"),
                         ("GET", "/healthz"), ("GET", "/mcp/exa"), ("POST", "/.well-known/opencode"),
                         ("DELETE", "/health")):
        assert v(scope(method, path)) == "missing", (method, path)


def test_verdict_compare(hubmod):
    v, tok = hubmod.token_verdict, b"t" * 40
    assert v(scope(auth=b"Bearer " + tok)) is None
    assert v(scope(auth=b"BEARER  " + tok + b" ")) is None
    assert v(scope(auth=b"Bearer " + tok[:-1])) == "wrong"
    assert v(scope(auth=b"Token " + tok)) == "wrong"
    hubmod.EXPECTED_BEARER = None
    assert v(scope(auth=b"Bearer " + tok)) == "unusable token file"
    hubmod.TOKEN_FILE = ""
    assert v(scope()) is None  # unset = the pre-F3 hub


def test_load_token_rules(hubmod, tmp_path):
    def make(name, data, mode=0o600):
        path = tmp_path / name
        path.write_bytes(data)
        os.chmod(path, mode)
        return str(path)

    good = b"A" * 40
    assert hubmod.load_token(make("ok", good + b"\n")) == good
    assert hubmod.load_token(make("grp", good, 0o640)) is None
    assert hubmod.load_token(make("short", b"A" * 31)) is None
    assert hubmod.load_token(make("space", b"A" * 20 + b" " + b"A" * 20)) is None
    assert hubmod.load_token(make("utf8", "é".encode() * 20)) is None
    os.symlink(make("target", good), tmp_path / "link")
    assert hubmod.load_token(str(tmp_path / "link")) is None
    assert hubmod.load_token(str(tmp_path / "missing")) is None
