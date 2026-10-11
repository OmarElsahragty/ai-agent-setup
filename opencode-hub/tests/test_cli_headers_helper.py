"""End to end with the real Claude Code CLI (WO-6): a temp hub ENFORCING a temp token, a temp HOME, and a
local stub API that fails every call (no network, no account, no live config). The CLI's init event reports
whether the hub MCP connected:
  user-scope headersHelper (sync-claude-config.py's ~/.claude.json form) -> connected
  --mcp-config headersHelper (what CloudCLI passes in argv)               -> connected
  --mcp-config literal header (CloudCLI header pass-through)               -> connected
  --mcp-config without auth (negative control)                             -> not connected
The probe CLIs run with a scratch environment and exit by themselves; no live session is touched."""
import http.server
import json
import os
import subprocess
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hub_token  # noqa: E402

CLI = os.environ.get("CLAUDE_EXE", "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")
pytestmark = pytest.mark.skipif(not os.access(CLI, os.X_OK), reason=f"no Claude Code CLI at {CLI}")


class StubApi(http.server.BaseHTTPRequestHandler):
    """Every API call fails at once with a NON-retryable 400 (a 401 makes the CLI back off for minutes)."""

    def answer(self):
        body = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "wo6 stub"}})
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())

    do_GET = do_POST = do_HEAD = answer

    def log_message(self, *_):
        pass


@pytest.fixture
def stub_api():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StubApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def probe(tmp_path, stub_api, name, user_servers=None, dynamic_servers=None):
    """Runs the CLI once; returns (status of the 'tiny' MCP in the init event, all output text)."""
    home = tmp_path / f"home-{name}"
    (home / "proj").mkdir(parents=True)
    (home / ".claude.json").write_text(json.dumps({"mcpServers": user_servers or {}}))
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "ANTHROPIC_BASE_URL": stub_api,
           "ANTHROPIC_API_KEY": "wo6-dummy-not-a-key", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1",
           "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "CLAUDE_CODE_MAX_RETRIES": "0"}
    argv = [CLI, "-p", "probe", "--output-format", "stream-json", "--verbose"]
    if dynamic_servers is not None:
        argv += ["--mcp-config", json.dumps({"mcpServers": dynamic_servers})]
    res = subprocess.run(argv, cwd=home / "proj", env=env, stdin=subprocess.DEVNULL, capture_output=True,
                         text=True, timeout=90)
    status = None
    for line in res.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            status = next((s.get("status") for s in event.get("mcp_servers", []) if s.get("name") == "tiny"), None)
            break
    return status, res.stdout + res.stderr


def test_cli_sends_the_header_through_every_claude_code_path(start_hub, stub_api, tmp_path):
    hub = start_hub("valid")
    token_file = os.path.join(os.path.dirname(hub.log_path), "token")
    url = hub.url("/mcp/tiny")
    helper = {"tiny": {"type": "http", "url": url,
                       "headersHelper": hub_token.helper_command(token_file, hub.port)}}
    literal = {"tiny": {"type": "http", "url": url, "headers": {"Authorization": f"Bearer {hub.token}"}}}
    bare = {"tiny": {"type": "http", "url": url}}
    results = {
        "user-helper": probe(tmp_path, stub_api, "user", user_servers=helper),
        "dynamic-helper": probe(tmp_path, stub_api, "dyn-helper", dynamic_servers=helper),
        "dynamic-literal": probe(tmp_path, stub_api, "dyn-literal", dynamic_servers=literal),
        "dynamic-none": probe(tmp_path, stub_api, "dyn-none", dynamic_servers=bare),
    }
    statuses = {k: v[0] for k, v in results.items()}
    print("init mcp status:", statuses)
    assert statuses["user-helper"] == "connected", statuses
    assert statuses["dynamic-helper"] == "connected", statuses
    assert statuses["dynamic-literal"] == "connected", statuses
    assert statuses["dynamic-none"] not in (None, "connected"), statuses  # negative control: hub refused it
    for name in ("user-helper", "dynamic-helper", "dynamic-none"):
        assert hub.token not in results[name][1], name  # the CLI never echoed the helper's output
    assert hub.token not in hub.log_text()
