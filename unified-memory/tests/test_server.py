"""MCP surface: tools/list schemas, get_topic dispatch, backward compatibility."""
import json

import server as um_server


def _tools():
    resp = um_server.handle_mcp_line(json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
    assert resp["id"] == 1
    return {t["name"]: t for t in resp["result"]["tools"]}


def test_tools_list_has_get_topic():
    tools = _tools()
    assert "get_topic" in tools
    schema = tools["get_topic"]["inputSchema"]
    assert schema["required"] == ["topic"]
    assert set(schema["properties"]) >= {"topic", "namespace", "agent"}


def test_importance_scale_unified_1_to_10():
    tools = _tools()
    for name in ("store_memory", "append_memory"):
        imp = tools[name]["inputSchema"]["properties"]["importance"]
        assert imp["minimum"] == 1 and imp["maximum"] == 10, name


def test_search_recall_new_optional_args():
    tools = _tools()
    assert "include_archive" in tools["search_memory"]["inputSchema"]["properties"]
    rp = tools["recall_memory"]["inputSchema"]["properties"]
    assert "importance_min" in rp and "include_archive" in rp


def test_get_topic_dispatch(monkeypatch):
    called = {}

    def fake_get_topic(topic, namespace=None, agent=None):
        called.update(topic=topic, namespace=namespace, agent=agent)
        return {"topic": topic, "chunks": 0, "results": []}

    monkeypatch.setattr(um_server, "get_topic", fake_get_topic)
    resp = um_server.handle_mcp_line(json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "get_topic",
                   "arguments": {"topic": "Trading Systems", "namespace": "knowledge"}}}))
    assert resp["id"] == 2
    body = json.loads(resp["result"]["content"][0]["text"])
    assert body["chunks"] == 0
    assert called == {"topic": "Trading Systems", "namespace": "knowledge", "agent": None}


def test_append_memory_backward_compat_old_args(monkeypatch):
    seen = {}

    def fake_append(topic, new_content, namespace="knowledge", agent="system",
                    tags=None, importance=9):
        seen.update(topic=topic, new_content=new_content, namespace=namespace)
        return {"action": "created", "id": 1, "chunks": 1, "topic": topic,
                "title": topic + " — SINGLE SOURCE OF TRUTH"}

    monkeypatch.setattr(um_server, "append_to_topic", fake_append)
    resp = um_server.handle_mcp_line(json.dumps({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "append_memory",
                   "arguments": {"topic": "T", "content": "c"}}}))
    assert resp["id"] == 3
    assert "error" not in resp
    assert seen == {"topic": "T", "new_content": "c", "namespace": "knowledge"}


def test_stdio_protocol_unchanged():
    assert um_server.handle_mcp_line(json.dumps(
        {"jsonrpc": "2.0", "method": "notifications/initialized"})) is None
    resp = um_server.handle_mcp_line(json.dumps({"jsonrpc": "2.0", "id": 4, "method": "ping"}))
    assert resp == {"jsonrpc": "2.0", "id": 4, "result": {}}
    err = um_server.handle_mcp_line(json.dumps(
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
         "params": {"name": "nope", "arguments": {}}}))
    assert err["error"]["code"] == -32601


def test_error_message_is_scrubbed(monkeypatch):
    # sentinel assembled at runtime: never a literal on disk
    fake_key = "sk-live-" + "servererr0123456789"

    def boom(**kwargs):
        raise ValueError('connect failed, key was "' + fake_key + '"')

    monkeypatch.setattr(um_server, "store", boom)
    resp = um_server.handle_mcp_line(json.dumps({
        "jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": {"name": "store_memory",
                   "arguments": {"namespace": "knowledge", "title": "t", "content": "c"}}}))
    msg = resp["error"]["message"]
    assert fake_key not in msg
    assert "[REDACTED:" in msg
