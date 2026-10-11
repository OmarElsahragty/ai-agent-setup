"""Tests for local-decide/mcp.py — stdio MCP server over the local daemon.

The daemon (127.0.0.1:11438) is NOT required: every test swaps mcp._CLIENT for a
fake, so the suite passes with the service down (its normal state until the server
worker lands). The only real process test drives mcp.py over a pipe.

Negative controls are explicit: `test_fake_backend_is_consulted`,
`test_decide_tracks_labels` and `test_rerank_tracks_documents` fail if the tools
ever stop calling the backend or start answering from constants.
"""

import hashlib
import inspect
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import mcp  # noqa: E402

TOOL_NAMES = ["decide", "multi_check", "rerank", "select_browser_action", "prune_preview"]


# --------------------------------------------------------------------------
# fake backend — signature matches client.py so mcp._bind selects the same args
# --------------------------------------------------------------------------
class FakeClient:
    def __init__(self, results=None, rerank_rows=None, error=None):
        self.results = results or {}
        self.rerank_rows = rerank_rows
        self.error = error
        self.calls = []

    def _fail(self):
        if self.error is not None:
            raise self.error

    def _result_for(self, head, text, spec):
        value = self.results.get(head)
        if callable(value):
            arity = 1
            try:
                arity = len([p for p in inspect.signature(value).parameters.values()
                             if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)])
            except (TypeError, ValueError):
                arity = 1
            value = value(text, head, spec) if arity >= 3 else value(text)
        return dict(value) if value else {"label": None, "conf": 0.0, "margin": 0.0, "abstain": True}

    def decide(self, text, heads, long=False):
        self.calls.append(("decide", text, heads, long))
        self._fail()
        return {head: self._result_for(head, text, heads[head]) for head in heads}

    def multi(self, text, heads, long=False):
        self.calls.append(("multi", text, heads, long))
        self._fail()
        return {head: self._result_for(head, text, heads[head]) for head in heads}

    def rerank(self, query, documents, model="0.6b", top_n=None):
        self.calls.append(("rerank", query, documents, model, top_n))
        self._fail()
        if self.rerank_rows is not None:
            return self.rerank_rows
        return [{"index": i, "score": round(1.0 - i * 0.1, 4)} for i in range(len(documents))]

    def hook(self, agent, event, payload):
        self.calls.append(("hook", agent, event, payload))
        self._fail()
        return {}


@pytest.fixture
def fake(monkeypatch):
    def install(**kwargs):
        client = FakeClient(**kwargs)
        monkeypatch.setattr(mcp, "_CLIENT", client)
        return client

    return install


def transcript(tmp_path, name="t.jsonl", lines=None):
    path = tmp_path / name
    if lines is None:
        lines = [
            {"type": "user", "message": {"role": "user", "content": "implement the decide tool"},
             "timestamp": "2026-10-02T00:00:00Z"},
            {"type": "assistant", "message": {"role": "assistant",
                                              "content": [{"type": "text", "text": "running pytest now"}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "the same progress line again"}]}},
        ]
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
    return path


def sha256_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


# --------------------------------------------------------------------------
# wiring
# --------------------------------------------------------------------------
def test_backend_exposes_the_four_client_functions():
    for name in ("decide", "multi", "rerank", "hook"):
        assert callable(getattr(mcp._CLIENT, name)), name


def test_daemon_base_is_loopback_only():
    assert mcp.DAEMON_BASE.startswith("http://127.0.0.1:")
    with pytest.raises(RuntimeError):
        mcp._StdlibClient(base="http://10.0.0.5:11438")._post("/v1/decide", {})


def test_non_loopback_url_override_is_ignored(monkeypatch):
    monkeypatch.setenv("LOCAL_DECIDE_URL", "http://10.0.0.5:11438")
    assert isinstance(mcp._load_client(), mcp._StdlibClient)
    monkeypatch.setenv("LOCAL_DECIDE_URL", "http://127.0.0.1:9999")
    assert not isinstance(mcp._load_client(), mcp._StdlibClient)  # loopback override keeps client.py


# --------------------------------------------------------------------------
# client.py binding (client.py is a sibling module; skip if it is not written yet)
# --------------------------------------------------------------------------
CLIENT_PY = os.path.join(ROOT, "client.py")


@pytest.mark.skipif(not os.path.isfile(CLIENT_PY), reason="client.py not written yet")
class TestRealClientBinding:
    """The adapter must speak the client.py that actually ships."""

    def client(self):
        import client as real_client  # type: ignore
        return real_client

    def test_bind_maps_to_the_real_parameter_names(self):
        seen = {}

        def decide(text, heads, long=False, timeout=3.0):
            seen.update(text=text, heads=heads, long=long, timeout=timeout)
            return {"h": {"label": "x", "conf": 0.9, "margin": 0.2, "abstain": False}}

        mcp._bind(decide, {"text": "t", "texts": ["t"], "heads": {"h": {}}, "labels": {"h": {}},
                           "long": True, "timeout": 2.0})
        assert seen == {"text": "t", "heads": {"h": {}}, "long": True, "timeout": 2.0}

    def test_bind_maps_texts_for_multi(self):
        seen = {}

        def multi(texts, heads, long=False, timeout=3.0):
            seen.update(texts=texts, heads=heads)
            return []

        mcp._bind(multi, {"text": "t", "texts": ["t"], "heads": {"h": {}}, "long": False,
                          "timeout": 2.0})
        assert seen == {"texts": ["t"], "heads": {"h": {}}}

    def test_bind_maps_docs_for_rerank(self):
        seen = {}

        def rerank(query, docs, model="0.6b", top_n=None, timeout=3.0):
            seen.update(query=query, docs=docs, model=model, top_n=top_n, timeout=timeout)
            return [{"index": 0, "score": 1.0}]

        mcp._bind(rerank, {"query": "q", "documents": ["a"], "model": "4b", "top_n": 3,
                           "timeout": 8.0})
        assert seen == {"query": "q", "docs": ["a"], "model": "4b", "top_n": 3, "timeout": 8.0}

    def test_live_client_functions_exist_with_the_contract_signatures(self):
        import inspect
        client = self.client()
        assert list(inspect.signature(client.decide).parameters)[:2] == ["text", "heads"]
        assert list(inspect.signature(client.rerank).parameters)[:2] == ["query", "docs"]

    def test_real_client_down_does_not_abstain_silently(self, monkeypatch):
        """With the real client and a dead daemon, tools must fail open, not abstain."""
        monkeypatch.setenv("LOCAL_DECIDE_URL", "http://127.0.0.1:1")  # nothing listens
        monkeypatch.setattr(mcp, "_CLIENT", mcp._load_client())
        for name, args in (
            ("decide", {"text": "t", "labels": {"a": "x"}}),
            ("rerank", {"query": "q", "documents": ["a"]}),
        ):
            out = mcp.call_tool(name, args)
            assert out["fail_open"] is True and out["error"] == mcp.UNAVAILABLE, name


def test_tools_list_has_exactly_the_five_contract_tools():
    assert [tool["name"] for tool in mcp.TOOLS] == TOOL_NAMES
    for tool in mcp.TOOLS:
        assert tool["description"].strip()
        schema = tool["inputSchema"]
        assert schema["type"] == "object"
        assert schema["required"]
        assert set(schema["required"]) <= set(schema["properties"])
        assert all(prop.get("type") or prop.get("enum")
                   for prop in schema["properties"].values())
        assert set(mcp._DISPATCH) == set(TOOL_NAMES)


# --------------------------------------------------------------------------
# decide
# --------------------------------------------------------------------------
def test_decide_returns_the_contract_fields(fake):
    fake(results={"default": {"label": "security", "conf": 0.91, "margin": 0.32,
                             "abstain": False, "reason": "top head"}})
    out = mcp.tool_decide("patch the auth token path", {"security": "auth/secrets", "ui": "rendering"})
    assert out["label"] == "security"
    assert out["conf"] == 0.91
    assert out["margin"] == 0.32
    assert out["abstain"] is False


def test_decide_reports_abstention(fake):
    fake(results={"default": {"label": None, "conf": 0.41, "margin": 0.05,
                             "abstain": True, "reason": "below threshold"}})
    out = mcp.tool_decide("hm", {"a": "x", "b": "y"})
    assert out["abstain"] is True and out["label"] is None


def test_decide_fails_open_when_the_daemon_is_down(fake):
    fake(error=ConnectionRefusedError("127.0.0.1:11438 refused"))
    out = mcp.tool_decide("anything", {"a": "x"})
    assert out == {"error": "local-decide unavailable", "fail_open": True,
                   "detail": "127.0.0.1:11438 refused"}


def test_decide_normalizes_list_and_flat_shapes(fake):
    fake(results={"default": {"label": "a", "conf": 0.8, "margin": 0.2, "abstain": False}})
    client = mcp._CLIENT
    listy = client.decide
    client.decide = lambda text, heads, long=False: [
        {"head": h, "label": "a", "conf": 0.8, "margin": 0.2, "abstain": False} for h in heads]
    assert mcp.tool_decide("t", {"a": "x"})["label"] == "a"
    client.decide = lambda text, heads, long=False: {"label": "b", "conf": 0.77, "margin": 0.1,
                                                     "abstain": False}
    assert mcp.tool_decide("t", {"b": "x"})["label"] == "b"
    client.decide = listy


def test_decide_caps_labels_at_32(fake):
    client = fake()
    labels = {"l%d" % i: "desc %d" % i for i in range(50)}
    mcp.tool_decide("t", labels)
    _, _, heads, _ = client.calls[0]
    assert len(heads["default"]["labels"]) == mcp.MAX_LABELS_PER_HEAD


def test_decide_truncates_overlong_text(fake):
    client = fake()
    mcp.tool_decide("x" * (mcp.MAX_TEXT_BYTES + 5000), {"a": "x"})
    _, text, heads, long_flag = client.calls[0]
    assert len(text.encode("utf-8")) <= mcp.MAX_TEXT_BYTES
    assert long_flag is True


def test_decide_rejects_an_empty_label_set(fake):
    fake()
    out = mcp.tool_decide("t", {})
    assert out["fail_open"] is True and "error" in out


# --------------------------------------------------------------------------
# multi_check
# --------------------------------------------------------------------------
def test_multi_check_answers_each_head(fake):
    def by_head(text, head, spec):
        want_yes = head == "has_tests" and "needs" in text
        return {"label": "yes" if want_yes else "no", "conf": 0.88, "margin": 0.4, "abstain": False}

    fake(results={"has_tests": by_head, "is_money": by_head})
    out = mcp.tool_multi_check(
        "this needs tests and is not money",
        {"has_tests": {"yes_desc": "the passage exercises a test", "no_desc": "no test is exercised"},
         "is_money": {"yes_desc": "the passage touches money or quant logic", "no_desc": "unrelated to money"}},
    )
    assert out["has_tests"]["answer"] == "yes"
    assert out["is_money"]["answer"] == "no"


def test_multi_check_keeps_head_label_sets_independent(fake):
    """Heads must not share one label map — a yes/no pair is per check."""
    client = fake(results={"a": {"label": "yes", "conf": 0.9, "margin": 0.3, "abstain": False},
                           "b": {"label": "no", "conf": 0.9, "margin": 0.3, "abstain": False}})
    mcp.tool_multi_check("t", {"a": {"yes_desc": "yes a", "no_desc": "no a"},
                               "b": {"yes_desc": "yes b", "no_desc": "no b"}})
    _, _, heads, _ = client.calls[0]
    assert heads["a"]["labels"] == {"yes": "yes a", "no": "no a"}
    assert heads["b"]["labels"] == {"yes": "yes b", "no": "no b"}


def test_multi_check_marks_abstained_heads(fake):
    fake(results={"a": {"label": None, "conf": 0.2, "margin": 0.0, "abstain": True}})
    out = mcp.tool_multi_check("t", {"a": {"yes_desc": "y", "no_desc": "n"}})
    assert out["a"]["abstain"] is True and out["a"]["answer"] is None


def test_multi_check_rejects_a_half_spec(fake):
    fake()
    out = mcp.tool_multi_check("t", {"a": {"yes_desc": "y"}})
    assert out["fail_open"] is True


def test_multi_check_caps_at_16_heads(fake):
    client = fake()
    checks = {"c%d" % i: {"yes_desc": "y%d" % i, "no_desc": "n%d" % i} for i in range(25)}
    out = mcp.tool_multi_check("t", checks)
    _, _, heads, _ = client.calls[0]
    assert len(heads) == mcp.MAX_HEADS
    assert out["checks_dropped"] == 9


def test_multi_check_fails_open(fake):
    fake(error=TimeoutError("2s budget exceeded"))
    assert mcp.tool_multi_check("t", {"a": {"yes_desc": "y", "no_desc": "n"}})["fail_open"] is True


# --------------------------------------------------------------------------
# rerank
# --------------------------------------------------------------------------
def test_rerank_orders_by_score(fake):
    fake(rerank_rows=[{"index": 2, "score": 9.1}, {"index": 0, "score": 0.2}, {"index": 1, "score": 5.0}])
    out = mcp.tool_rerank("q", ["a", "b", "c"], top_n=3)
    assert [row["index"] for row in out["results"]] == [2, 1, 0]
    assert out["results"][0]["document"] == "c"


def test_rerank_normalizes_openai_and_jina_shapes(fake):
    fake(rerank_rows={"results": [{"index": 1, "relevance_score": 0.7}]})
    out = mcp.tool_rerank("q", ["a", "b"])
    assert out["results"] == [{"index": 1, "score": 0.7, "document": "b"}]


def test_rerank_drops_out_of_range_and_duplicate_rows(fake):
    fake(rerank_rows=[{"index": 9, "score": 9}, {"index": 1, "score": 1}, {"index": 1, "score": 8}])
    out = mcp.tool_rerank("q", ["a", "b"])
    assert [row["index"] for row in out["results"]] == [1]


def test_rerank_rejects_an_unknown_model(fake):
    client = fake()
    out = mcp.tool_rerank("q", ["a"], model="70b")
    assert out["fail_open"] is True
    assert client.calls == []


def test_rerank_empty_answer_is_an_outage_not_an_abstain(fake):
    """client.rerank returns [] for a dead daemon; that must never read as "no results"."""
    fake(rerank_rows=[])
    out = mcp.tool_rerank("q", ["a", "b", "c"], top_n=2)
    assert out["fail_open"] is True
    assert "no ranking" in out["detail"]


def test_rerank_flags_a_flat_ranking(fake):
    """A broken model conversion answers with equal scores; flag it, do not hide it."""
    fake(rerank_rows=[{"index": 0, "score": 0.0}, {"index": 1, "score": 0.0}])
    out = mcp.tool_rerank("q", ["a", "b"])
    assert out["degenerate_ranking"] is True
    fake(rerank_rows=[{"index": 0, "score": 0.4}, {"index": 1, "score": 0.9}])
    assert "degenerate_ranking" not in mcp.tool_rerank("q", ["a", "b"])


def test_rerank_fails_open(fake):
    fake(error=ConnectionRefusedError("daemon down"))
    assert mcp.tool_rerank("q", ["a"])["fail_open"] is True


# --------------------------------------------------------------------------
# select_browser_action
# --------------------------------------------------------------------------
def test_select_browser_action_picks_one_id(fake):
    fake(results={"default": {"label": "click_login", "conf": 0.9, "margin": 0.4,
                             "abstain": False, "reason": "matches goal"}})
    out = mcp.tool_select_browser_action(
        "log in to the console",
        [{"id": "click_login", "label": "click the Sign in button"},
         {"id": "fill_form", "label": "fill the registration form"}],
    )
    assert out["action_id"] == "click_login"
    assert out["abstain"] is False
    assert out["considered"] == ["click_login", "fill_form"]


def test_select_browser_action_abstains(fake):
    fake(results={"default": {"label": None, "conf": 0.2, "margin": 0.0, "abstain": True}})
    out = mcp.tool_select_browser_action("do something unrelated", [{"id": "a", "label": "A"}])
    assert out["action_id"] is None and out["abstain"] is True


def test_select_browser_action_refuses_more_than_32_actions(fake):
    client = fake()
    actions = [{"id": "a%d" % i, "label": "L%d" % i} for i in range(33)]
    out = mcp.tool_select_browser_action("g", actions)
    assert out["fail_open"] is True and "32" in out["error"]
    assert client.calls == []


def test_select_browser_action_fails_open(fake):
    fake(error=ConnectionRefusedError("down"))
    assert mcp.tool_select_browser_action("g", [{"id": "a", "label": "A"}])["fail_open"] is True


# --------------------------------------------------------------------------
# prune_preview
# --------------------------------------------------------------------------
def test_prune_preview_never_modifies_the_transcript(fake, tmp_path):
    fake(results={"retention": {"label": "drop", "conf": 0.9, "margin": 0.3, "abstain": False}})
    path = transcript(tmp_path)
    before = sha256_file(path)
    out = mcp.tool_prune_preview(str(path))
    assert out["modified"] is False
    assert sha256_file(path) == before
    assert len(out["dropped"]) == out["scanned"]


def test_prune_preview_separates_kept_and_dropped(fake, tmp_path):
    def retention(text):
        return {"label": "drop", "conf": 0.9, "margin": 0.2, "abstain": False} \
            if "progress line again" in text \
            else {"label": "keep", "conf": 0.9, "margin": 0.2, "abstain": False}

    fake(results={"retention": retention})
    out = mcp.tool_prune_preview(str(transcript(tmp_path)))
    assert [item["type"] for item in out["kept"]] == ["user", "assistant"]
    assert out["dropped"][0]["line"] == 3
    assert out["kept"][0]["head"].startswith("implement the decide tool")


def test_prune_preview_reports_abstained_messages(fake, tmp_path):
    fake(results={"retention": {"label": None, "conf": 0.1, "margin": 0.0, "abstain": True}})
    out = mcp.tool_prune_preview(str(transcript(tmp_path)))
    assert out["abstained"] and not out["dropped"] and not out["kept"]


def test_prune_preview_scans_only_the_tail(fake, tmp_path):
    fake(results={"retention": {"label": "keep", "conf": 0.9, "margin": 0.2, "abstain": False}})
    lines = [{"type": "user", "message": {"content": "msg %d" % i}} for i in range(30)]
    path = transcript(tmp_path, lines=lines)
    out = mcp.tool_prune_preview(str(path), max_messages=5)
    assert out["scanned"] == 5
    assert any("last 5 of 30" in note for note in out["notes"])


def test_prune_preview_missing_file_is_not_fatal(fake, tmp_path):
    fake()
    out = mcp.tool_prune_preview(str(tmp_path / "nope.jsonl"))
    assert out["kept"] == [] and out["dropped"] == []
    assert any("no such transcript" in note for note in out["notes"])


def test_prune_preview_fails_open_when_the_daemon_is_down(fake, tmp_path):
    fake(error=ConnectionRefusedError("down"))
    out = mcp.tool_prune_preview(str(transcript(tmp_path)))
    assert out == {"error": "local-decide unavailable", "fail_open": True,
                   "detail": "down"}


def test_prune_preview_uses_the_retention_head(fake, tmp_path):
    client = fake()
    path = transcript(tmp_path)
    mcp.tool_prune_preview(str(path))
    for name in ("decide", "multi"):
        for call in client.calls:
            if call[0] == name:
                assert "retention" in call[2]


# --------------------------------------------------------------------------
# dispatch + protocol
# --------------------------------------------------------------------------
def test_call_tool_never_raises(fake):
    fake(error=RuntimeError("everything is broken"))
    for name in TOOL_NAMES:
        args = {
            "decide": {"text": "t", "labels": {"a": "x"}},
            "multi_check": {"text": "t", "checks": {"c": {"yes_desc": "y", "no_desc": "n"}}},
            "rerank": {"query": "q", "documents": ["a"]},
            "select_browser_action": {"goal": "g", "actions": [{"id": "a", "label": "A"}]},
            "prune_preview": {"transcript_path": "/nonexistent"},
        }[name]
        payload = mcp.call_tool(name, args)
        assert isinstance(payload, dict)


def test_call_tool_handles_unknown_and_malformed_calls(fake):
    fake()
    assert mcp.call_tool("nope", {})["fail_open"] is True
    assert mcp.call_tool("decide", {"bogus": 1})["fail_open"] is True
    assert mcp.call_tool("decide", "not-a-dict")["fail_open"] is True


def test_initialize_and_tools_list_handshake(fake):
    fake()
    init = mcp.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                               "params": {"protocolVersion": mcp.PROTOCOL_VERSION}})
    assert init["result"]["serverInfo"]["name"] == "local-decide"
    assert "tools" in init["result"]["capabilities"]
    listing = mcp.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert [tool["name"] for tool in listing["result"]["tools"]] == TOOL_NAMES


def test_notifications_get_no_response(fake):
    fake()
    assert mcp.handle_request({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert mcp.handle_request({"jsonrpc": "2.0", "method": "nope/whatever"}) is None


def test_unknown_method_is_a_jsonrpc_error(fake):
    fake()
    err = mcp.handle_request({"jsonrpc": "2.0", "id": 7, "method": "resources/list"})
    assert err["error"]["code"] == -32601


def test_tools_call_wraps_the_payload_as_text_content(fake):
    fake(results={"default": {"label": "yes", "conf": 0.9, "margin": 0.2, "abstain": False}})
    res = mcp.handle_request({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                              "params": {"name": "decide",
                                         "arguments": {"text": "t", "labels": {"yes": "yes desc"}}}})
    payload = json.loads(res["result"]["content"][0]["text"])
    assert payload["label"] == "yes"
    assert res["result"]["isError"] is False


def test_stdout_is_one_json_message_per_line():
    """NDJSON invariant: every response is a single physical line."""
    for request in ({"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                     "params": {"name": "decide", "arguments": {"text": "t", "labels": {"a": "x"}}}}):
        line = json.dumps(mcp.handle_request(request), separators=(",", ":"))
        assert "\n" not in line


# --------------------------------------------------------------------------
# negative controls
# --------------------------------------------------------------------------
def test_fake_backend_is_consulted(fake):
    client = fake(results={"default": {"label": "a", "conf": 0.9, "margin": 0.2, "abstain": False}})
    mcp.tool_decide("t", {"a": "x"})
    assert [call[0] for call in client.calls] == ["decide"]
    assert client.calls[0][2]["default"]["labels"] == {"a": "x"}


def test_decide_tracks_labels(fake):
    client = fake(results={"default": lambda text: {
        "label": next(iter(sorted(text.split())), None), "conf": 0.9, "margin": 0.2, "abstain": False}})
    assert mcp.tool_decide("alpha", {"alpha": "x"})["label"] == "alpha"
    assert mcp.tool_decide("beta", {"beta": "x"})["label"] == "beta"
    assert len(client.calls) == 2


def test_rerank_tracks_documents(fake):
    client = fake()
    mcp.tool_rerank("q", ["a", "b", "c"], model="4b")
    _, query, documents, model, top_n = client.calls[0]
    assert documents == ["a", "b", "c"] and model == "4b" and top_n == 3 and query == "q"


def test_outage_is_distinguishable_from_an_abstain(fake):
    fake(error=ConnectionRefusedError("down"))
    down = mcp.tool_decide("t", {"a": "x"})
    fake(results={"default": {"label": None, "conf": 0.0, "margin": 0.0, "abstain": True}})
    abstain = mcp.tool_decide("t", {"a": "x"})
    assert down["fail_open"] is True
    assert "fail_open" not in abstain and abstain["abstain"] is True


# --------------------------------------------------------------------------
# real process: NDJSON over a pipe (no daemon required)
# --------------------------------------------------------------------------
def test_process_serves_ndjson_and_exits_zero():
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "mcp.py")],
        input="".join(json.dumps(r) + "\n" for r in requests),
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 2
    responses = [json.loads(line) for line in lines]
    assert responses[0]["result"]["serverInfo"]["name"] == "local-decide"
    assert [tool["name"] for tool in responses[1]["result"]["tools"]] == TOOL_NAMES


def test_process_rejects_garbage_without_dying():
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "mcp.py")],
        input='not json\n{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n',
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
    responses = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert responses[0]["error"]["code"] == -32700
    assert responses[1]["result"]["tools"]


def test_list_tools_cli_prints_one_line_per_tool():
    proc = subprocess.run([sys.executable, os.path.join(ROOT, "mcp.py"), "--list-tools"],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0
    assert [line.split("\t")[0] for line in proc.stdout.splitlines()] == TOOL_NAMES

def test_prune_preview_refuses_paths_outside_transcript_roots(fake, tmp_path):
    out = mcp.tool_prune_preview("${AI_SETUP_ROOT}/claude-router/.env")
    assert "transcript_path must be" in json.dumps(out)
    assert "API_KEY" not in json.dumps(out)


def test_prune_preview_refuses_symlink_escape(fake, tmp_path):
    link = tmp_path / "evil.jsonl"
    link.symlink_to("/etc/hostname")
    out = mcp.tool_prune_preview(str(link))
    assert "transcript_path must be" in json.dumps(out)


def test_prune_preview_redacts_secrets_in_the_reported_head(fake, tmp_path):
    """prune_preview echoes transcript heads back to the caller: they must pass
    through the same redactor as decisions.text_head (security CRITICAL-1 follow-up)."""
    secret = "hunter" + "2scribe"
    aws = "AKIA" + "IOSFODNN7EXAMPLE"
    lines = [{"type": "user", "message": {"content": "deploy with DB_PASSWORD=%s and %s" % (secret, aws)}}]
    path = transcript(tmp_path, lines=lines)
    fake(results={"retention": {"label": "keep", "conf": 0.9, "margin": 0.2, "abstain": False}})
    out = mcp.tool_prune_preview(str(path))
    report = json.dumps(out)
    assert secret not in report and aws not in report
    assert "<redacted>" in out["kept"][0]["head"]
