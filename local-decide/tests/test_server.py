"""Server tests: caps (413/422), routing, hook fail-open, client fail-open."""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

import client as cli
import server as srv

HEADS = {
    "intent": {
        "labels": {"deploy": "deploy something", "delete": "delete something"},
        "threshold": 0.0,
        "margin": 0.0,
    }
}


@pytest.fixture(scope="module")
def api():
    # base_url pins the Host header to 127.0.0.1 — the LoopbackGuard 403s any
    # other host, exactly like it will 403 a browser-born request.
    with TestClient(srv.app, base_url="http://127.0.0.1") as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# LoopbackGuard: Host must be loopback, Origin must be absent (security MEDIUM-4)
# ---------------------------------------------------------------------------
def test_rejects_a_foreign_host_header_with_403(api):
    resp = api.post("/v1/decide", json={"text": "x", "heads": HEADS},
                    headers={"host": "attacker.example:11438"})
    assert resp.status_code == 403
    assert resp.json()["error"] == "forbidden_origin"


def test_rejects_a_request_carrying_an_origin_header_with_403(api):
    resp = api.post("/hook/claude/PreToolUse", json={"tool_name": "Bash",
                                                     "tool_input": {"command": "ls"}},
                    headers={"origin": "http://attacker.example"})
    assert resp.status_code == 403


def test_normal_hook_call_from_a_hook_client_still_returns_200(api, monkeypatch):
    monkeypatch.setattr(srv, "policy", _FakePolicy(body={}))
    resp = api.post("/hook/claude/PreToolUse",
                    json={"tool_name": "Bash", "tool_input": {"command": "ls"}})
    assert resp.status_code == 200
    assert resp.json() == {}


def test_loopback_host_with_any_port_is_allowed(api):
    resp = api.get("/health", headers={"host": "127.0.0.1:51999"})
    assert resp.status_code == 200


def test_rejects_70kb_body_with_413(api):
    payload = {"text": "x" * (70 * 1024), "heads": HEADS}
    resp = api.post("/v1/decide", json=payload)
    assert resp.status_code == 413
    assert resp.json()["error"] == "payload_too_large"


def test_rejects_oversized_hook_body_with_413(api):
    resp = api.post("/hook/claude/UserPromptSubmit",
                    content=json.dumps({"prompt": "y" * (70 * 1024)}),
                    headers={"content-type": "application/json"})
    assert resp.status_code == 413


def test_accepts_a_body_just_under_the_cap(api):
    resp = api.post("/v1/decide", json={"text": "x" * 1024, "heads": {}})
    # heads empty -> 422 (validation), but the body itself was accepted.
    assert resp.status_code == 422


def test_rejects_more_than_16_heads(api):
    heads = {f"h{i}": {"labels": ["a", "b"]} for i in range(17)}
    resp = api.post("/v1/decide", json={"text": "hello", "heads": heads})
    assert resp.status_code == 422
    assert "too many heads" in resp.json()["detail"]


def test_rejects_more_than_32_labels(api):
    heads = {"h": {"labels": [f"l{i}" for i in range(33)]}}
    resp = api.post("/v1/decide", json={"text": "hello", "heads": heads})
    assert resp.status_code == 422
    assert "labels" in resp.json()["detail"]


def test_decide_route_abstains_on_negation(api):
    resp = api.post("/v1/decide", json={
        "text": "do not delete the production database", "heads": HEADS})
    assert resp.status_code == 200
    out = resp.json()["intent"]
    assert out["abstain"] is True
    assert out["reason"] == "negation"


def test_multi_route_returns_one_result_per_text(api):
    resp = api.post("/v1/multi", json={
        "texts": ["do not deploy anything", "tell me about the weather"],
        "heads": HEADS})
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list) and len(body) == 2
    assert body[0]["intent"]["reason"] == "negation"
    assert set(body[1]) == {"intent"}


def test_rerank_route_degrades_to_empty(api, monkeypatch):
    monkeypatch.setattr(srv.ENGINE, "rerank",
                        lambda *a, **k: [])
    resp = api.post("/v1/rerank", json={"query": "q", "docs": ["a", "b"]})
    assert resp.status_code == 200
    assert resp.json() == []


def test_rerank_route_passes_top_n(api, monkeypatch):
    seen = {}

    def fake(query, docs, model="0.6b", top_n=None):
        seen.update(query=query, docs=docs, model=model, top_n=top_n)
        return [{"index": 1, "score": 0.9}]

    monkeypatch.setattr(srv.ENGINE, "rerank", fake)
    resp = api.post("/v1/rerank", json={
        "query": "q", "docs": ["a", "b"], "model": "4b", "top_n": 1})
    assert resp.status_code == 200
    assert resp.json() == [{"index": 1, "score": 0.9}]
    assert seen["model"] == "4b" and seen["top_n"] == 1


def test_guard_routes_degrade(api, monkeypatch):
    monkeypatch.setattr(srv.ENGINE, "pii", lambda text: [])
    monkeypatch.setattr(srv.ENGINE, "injection",
                        lambda text: {"label": "benign", "conf": 0.0})
    assert api.post("/v1/guard/pii", json={"text": "x"}).json() == []
    assert api.post("/v1/guard/injection",
                    json={"text": "x"}).json() == {"label": "benign", "conf": 0.0}


def test_health_shape(api):
    body = api.get("/health").json()
    for key in ("ok", "models_loaded", "worker_pid", "rerank_0_6b", "rerank_4b"):
        assert key in body, key


# ---------------------------------------------------------------------------
# Hook fail-open.  policy.py belongs to another worker; when it is absent the
# route must still return the agent's own no-op body with HTTP 200.
# ---------------------------------------------------------------------------
class _FakePolicy:
    def __init__(self, body=None, boom=False):
        self.body = body if body is not None else {}
        self.boom = boom
        self.seen = []

    def evaluate(self, agent, event, payload, engine):
        self.seen.append((agent, event, payload))
        if self.boom:
            raise RuntimeError("policy exploded")
        return self.body


def test_hook_delegates_to_policy(api, monkeypatch):
    fake = _FakePolicy(body={"decision": "block"})
    monkeypatch.setattr(srv, "policy", fake)
    resp = api.post("/hook/opencode/tool.execute.before",
                    json={"tool": "Bash", "input": {"command": "rm -rf /"}})
    assert resp.status_code == 200
    assert resp.json() == {"decision": "block"}
    assert fake.seen[0][0] == "opencode"
    assert fake.seen[0][1] == "tool.execute.before"
    assert fake.seen[0][2]["input"]["command"] == "rm -rf /"


def test_hook_returns_agent_noop_when_policy_raises(api, monkeypatch):
    monkeypatch.setattr(srv, "policy", _FakePolicy(boom=True))
    for agent, expected in (("claude", {}), ("opencode", {"action": "allow"}),
                            ("agy", {})):
        resp = api.post(f"/hook/{agent}/PreToolUse", json={"tool": "Bash"})
        assert resp.status_code == 200
        assert resp.json() == expected


def test_hook_returns_agent_noop_when_policy_is_absent(api, monkeypatch):
    monkeypatch.setattr(srv, "policy", None)
    resp = api.post("/hook/opencode/chat.message", json={"text": "hi"})
    assert resp.status_code == 200
    assert resp.json() == {"action": "allow"}


def test_hook_survives_non_json_body(api, monkeypatch):
    fake = _FakePolicy(body={})
    monkeypatch.setattr(srv, "policy", fake)
    resp = api.post("/hook/claude/UserPromptSubmit",
                    content=b"not json at all",
                    headers={"content-type": "application/json"})
    assert resp.status_code == 200
    assert "raw" in fake.seen[0][2]


# ---------------------------------------------------------------------------
# client.py: stdlib only, fail-open on a dead daemon
# ---------------------------------------------------------------------------
def test_client_imports_stdlib_only():
    src = open(os.path.join(os.path.dirname(srv.__file__),
                            "client.py"), encoding="utf-8").read()
    banned = ("import requests", "import httpx", "from httpx", "import fastapi",
              "import pydantic")
    for name in banned:
        assert name not in src, name


def test_client_fails_open_on_dead_daemon(monkeypatch):
    monkeypatch.setenv("LOCAL_DECIDE_URL", "http://127.0.0.1:9")
    assert cli.decide("x", HEADS, timeout=0.3) is None
    assert cli.multi(["x"], HEADS, timeout=0.3) is None
    assert cli.rerank("q", ["a"], timeout=0.3) == []
    assert cli.pii("x", timeout=0.3) == []
    assert cli.injection("x", timeout=0.3) is None
    assert cli.hook("claude", "PreToolUse", {}, timeout=0.3) is None
    assert cli.health(timeout=0.3) is None


def test_client_default_url(monkeypatch):
    monkeypatch.delenv("LOCAL_DECIDE_URL", raising=False)
    assert cli.base_url() == "http://127.0.0.1:11438"
    monkeypatch.setenv("LOCAL_DECIDE_URL", "http://127.0.0.1:11448/")
    assert cli.base_url() == "http://127.0.0.1:11448"


def test_client_talks_to_the_live_app(api, monkeypatch):
    """Drive client.py against the in-process app on a real socket.

    policy.py is another worker's module and is stubbed here so this test
    covers the HTTP layer only.
    """
    import threading
    import uvicorn

    monkeypatch.setattr(srv, "policy", _FakePolicy(body={}))
    monkeypatch.setenv("LOCAL_DECIDE_URL", "http://127.0.0.1:11448")
    config = uvicorn.Config(srv.app, host="127.0.0.1", port=11448, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    import time as _time
    deadline = _time.monotonic() + 20
    while _time.monotonic() < deadline and not server.started:
        _time.sleep(0.05)
    assert server.started, "uvicorn did not come up on 11448"
    try:
        health = cli.health(timeout=2)
        assert isinstance(health, dict) and "ok" in health
        out = cli.decide("do not delete the production database", HEADS, timeout=3)
        assert out["intent"]["reason"] == "negation"
        ranked = cli.rerank("q", ["alpha", "beta", "gamma"], timeout=3)
        assert isinstance(ranked, list)
        scores = [row["score"] for row in ranked]
        assert scores == sorted(scores, reverse=True)
        assert all(0 <= row["index"] < 3 for row in ranked)
        assert cli.pii("nothing here", timeout=3) == []
        hook_body = cli.hook("claude", "UserPromptSubmit", {"prompt": "hi"},
                             timeout=3)
        assert hook_body == {}          # policy absent -> claude no-op body
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def test_rerank_rejects_oversized_batches(api):
    resp = api.post("/v1/rerank", json={"query": "q", "docs": ["d"] * 513})
    assert resp.status_code == 413


# --- hook model deadline (2026-10-02): a busy/slow engine never stalls a hook; deterministic rules still apply ---
def test_hook_slow_engine_falls_back_to_deterministic_deny(monkeypatch):
    import time as _t
    import server as srv
    from fastapi.testclient import TestClient
    calls = []
    real = srv.policy.evaluate
    def slow_eval(agent, event, payload, engine):
        calls.append(engine is None)
        if engine is not None:
            _t.sleep(1.5)
        return real(agent, event, payload, None)
    monkeypatch.setattr(srv.policy, "evaluate", slow_eval)
    monkeypatch.setattr(srv, "HOOK_MODEL_BUDGET_S", 0.2)
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    t0 = _t.monotonic()
    body = {"tool_name": "Write", "tool_input": {"file_path": "${AI_SETUP_ROOT}/trader-app/apps/web/app/page.tsx",
                                                 "content": "const v = kpi ?? 358.46;"}, "cwd": "/root"}
    out = client.post("/hook/claude/PreToolUse", json=body).json()
    assert _t.monotonic() - t0 < 1.2
    assert "deny" in str(out)
    assert calls[-1] is True
    _t.sleep(1.5)   # let the background model pass release its slot


def test_hook_slots_full_skips_model(monkeypatch):
    import server as srv
    from fastapi.testclient import TestClient
    seen = []
    monkeypatch.setattr(srv.policy, "evaluate", lambda a, e, p, engine: seen.append(engine) or {})
    taken = [srv.HOOK_MODEL_SLOTS.acquire(blocking=False) for _ in range(8)]
    try:
        client = TestClient(srv.app, base_url="http://127.0.0.1")
        assert client.post("/hook/claude/UserPromptSubmit", json={"prompt": "hi"}).status_code == 200
        assert seen == [None]
    finally:
        for ok in taken:
            if ok:
                srv.HOOK_MODEL_SLOTS.release()


# --- tool-call fast path (2026-10-02): Bash/Read/Edit/Write never wait on the model -----------------------------
def test_pretool_non_dispatch_answers_without_model(monkeypatch):
    import time as _t
    import server as srv
    from fastapi.testclient import TestClient
    calls = []
    real = srv.policy.evaluate
    def slow_eval(agent, event, payload, engine):
        calls.append(engine is None)
        if engine is not None:
            _t.sleep(1.0)
        return real(agent, event, payload, None)
    monkeypatch.setattr(srv.policy, "evaluate", slow_eval)
    monkeypatch.setattr(srv, "_host_busy", lambda: False)
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    t0 = _t.monotonic()
    out = client.post("/hook/claude/PreToolUse",
                      json={"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/root"}).json()
    assert _t.monotonic() - t0 < 0.5
    assert out == {}
    assert calls[0] is True                 # the answer came from the deterministic pass
    # the deterministic deny still fires on the fast path
    deny = client.post("/hook/claude/PreToolUse",
                       json={"tool_name": "Bash", "tool_input": {"command": "sleep 30"}, "cwd": "/root"}).json()
    assert "deny" in str(deny)
    _t.sleep(1.2)                           # let the background model pass release its slot


def test_pretool_dispatch_still_waits_for_model(monkeypatch):
    import server as srv
    from fastapi.testclient import TestClient
    seen = []
    monkeypatch.setattr(srv.policy, "evaluate", lambda a, e, p, engine: seen.append(engine) or {})
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    client.post("/hook/claude/PreToolUse", json={"tool_name": "Agent", "tool_input": {"prompt": "x"}})
    assert seen and seen[0] is not None     # Agent dispatch runs the model synchronously (D3 warn context)


def test_posttool_uses_short_budget(monkeypatch):
    import time as _t
    import server as srv
    from fastapi.testclient import TestClient
    monkeypatch.setattr(srv, "HOOK_EVENT_BUDGET_S", {"PostToolUse": 0.2})
    real = srv.policy.evaluate
    def slow_eval(agent, event, payload, engine):
        if engine is not None:
            _t.sleep(1.0)
        return real(agent, event, payload, None)
    monkeypatch.setattr(srv.policy, "evaluate", slow_eval)
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    t0 = _t.monotonic()
    assert client.post("/hook/claude/PostToolUse", json={"tool_name": "Read"}).status_code == 200
    assert _t.monotonic() - t0 < 0.8
    _t.sleep(1.2)


def test_fast_path_heads_stay_log_only():
    """The PreToolUse fast path never waits on the model, so every model head it skips must be log-only.
    Promoting one of these (eval.py --promote) must first take its tool off server._model_free_tool."""
    import yaml
    from pathlib import Path
    rules = Path(__file__).resolve().parent.parent / "rules"
    guard = yaml.safe_load((rules / "guardrail.yaml").read_text())
    bash = yaml.safe_load((rules / "bash.yaml").read_text())
    assert guard["d7"]["pii"]["mode"] == "log"
    assert guard["d7"]["policy_heads"]["mode"] == "log"
    assert bash["risk_tier"]["mode"] == "log"


def test_fast_path_uses_policy_dispatch_detection():
    """Review LOW 2026-10-02: every spelling the policy treats as a dispatch must wait for the model."""
    import server as srv
    for payload in ({"tool_name": "Agent"}, {"tool_name": "Task"}, {"toolName": "Task"}, {"name": "Task"},
                    {"tool_name": "task"}, {"tool": "agent"}):
        assert srv._model_free_tool("PreToolUse", payload) is False, payload
    for payload in ({"tool_name": "Bash"}, {"tool_name": "Read"}, {"toolName": "edit"}, {}):
        assert srv._model_free_tool("PreToolUse", payload) is True, payload
    assert srv._model_free_tool("UserPromptSubmit", {"tool_name": "Bash"}) is False


def test_slot_released_when_pool_rejects(monkeypatch):
    import server as srv
    from fastapi.testclient import TestClient

    class DeadPool:
        def submit(self, *a, **k):
            raise RuntimeError("cannot schedule new futures after shutdown")

    monkeypatch.setattr(srv, "_HOOK_POOL", DeadPool())
    monkeypatch.setattr(srv, "_host_busy", lambda: False)
    monkeypatch.setattr(srv.policy, "evaluate", lambda a, e, p, engine: {})
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    for _ in range(6):                      # > slot count: a leak would exhaust the semaphore
        assert client.post("/hook/claude/PreToolUse", json={"tool_name": "Bash"}).status_code == 200
        assert client.post("/hook/claude/UserPromptSubmit", json={"prompt": "hi"}).status_code == 200
    taken = [srv.HOOK_MODEL_SLOTS.acquire(blocking=False) for _ in range(2)]
    assert all(taken)                       # both slots still free
    for _ in taken:
        srv.HOOK_MODEL_SLOTS.release()


def test_background_pass_yields_to_session_hooks(monkeypatch):
    """2026-10-02: log-only background passes must never starve the prompt/dispatch model passes."""
    import time as _t
    import server as srv
    from fastapi.testclient import TestClient
    started = []
    real = srv.policy.evaluate
    def eval_(agent, event, payload, engine):
        if engine is not None:
            started.append(event)
            _t.sleep(0.6)
        return real(agent, event, payload, None)
    monkeypatch.setattr(srv.policy, "evaluate", eval_)
    client = TestClient(srv.app, base_url="http://127.0.0.1")
    bash = {"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/root"}
    monkeypatch.setattr(srv, "_host_busy", lambda: True)          # busy host: no background pass at all
    client.post("/hook/claude/PreToolUse", json=bash)
    _t.sleep(0.1)
    assert started == []
    monkeypatch.setattr(srv, "_host_busy", lambda: False)         # idle host: at most ONE background pass
    for _ in range(4):
        client.post("/hook/claude/PreToolUse", json=bash)
    _t.sleep(0.1)
    assert started == ["PreToolUse"]
    started.clear()                                               # a model slot is still free for the prompt
    client.post("/hook/claude/UserPromptSubmit", json={"prompt": "check the trading shield timing"})
    assert started == ["UserPromptSubmit"]
    _t.sleep(0.8)


def test_host_busy_reads_load():
    import server as srv
    assert srv._host_busy() in (True, False)
