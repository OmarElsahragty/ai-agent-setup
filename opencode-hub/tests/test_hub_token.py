"""hub_token.py: the client generators' token reader, header injector and the Claude Code headersHelper
(audit F3). The token here is a runtime sample, discarded after the run."""
import json
import os
import pty
import secrets
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hub_token  # noqa: E402

SAMPLE = secrets.token_urlsafe(36)  # runtime value, discarded after the run


def make(tmp_path, name, data: bytes, mode=0o600):
    path = tmp_path / name
    path.write_bytes(data)
    os.chmod(path, mode)
    return str(path)


def test_read_token_rules(tmp_path):
    assert hub_token.read_token(str(tmp_path / "absent")) is None  # no file = feature off
    assert hub_token.read_token(make(tmp_path, "ok", SAMPLE.encode() + b"\n")) == SAMPLE
    for name, data, mode in (("grp", SAMPLE.encode(), 0o640), ("short", b"T" * 31, 0o600),
                             ("space", b"T" * 20 + b" " + b"T" * 20, 0o600), ("utf8", "é".encode() * 20, 0o600)):
        with pytest.raises(hub_token.TokenError) as err:
            hub_token.read_token(make(tmp_path, name, data, mode))
        assert SAMPLE not in str(err.value)
    os.symlink(make(tmp_path, "target", SAMPLE.encode()), tmp_path / "link")
    with pytest.raises(hub_token.TokenError):
        hub_token.read_token(str(tmp_path / "link"))


def test_is_hub_url():
    assert hub_token.is_hub_url("http://127.0.0.1:8790/mcp/exa")
    assert hub_token.is_hub_url("http://localhost:8790/mcp/exa")
    for url in ("https://127.0.0.1:8790/mcp/exa", "http://100.64.0.1:8790/mcp/exa", "http://127.0.0.1:8791/mcp/exa",
                "http://127.0.0.1:8790/health", "http://someone@127.0.0.1:8790/mcp/exa", "http://127.0.0.1/mcp/exa",
                "https://mcp.example.com/mcp/exa", "http://127.0.0.1:99999/mcp/x", None, 7):
        assert not hub_token.is_hub_url(url), url


def test_with_hub_auth_only_on_hub_entries():
    servers = {
        "exa": {"type": "http", "url": "http://127.0.0.1:8790/mcp/exa", "serverUrl": "http://127.0.0.1:8790/mcp/exa"},
        "keep": {"type": "http", "url": "http://127.0.0.1:8790/mcp/keep", "headers": {"X-Trace": "1"}},
        "remote": {"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"X-Trace": "2"}},
        "mixed": {"url": "http://127.0.0.1:8790/mcp/m", "serverUrl": "https://elsewhere.example/mcp/m"},
        "stdio": {"command": "node", "args": ["x.js"]},
    }
    out = hub_token.with_hub_auth(servers, SAMPLE)
    assert out["exa"]["headers"] == {"Authorization": f"Bearer {SAMPLE}"}
    assert out["keep"]["headers"] == {"X-Trace": "1", "Authorization": f"Bearer {SAMPLE}"}
    for name in ("remote", "mixed", "stdio"):  # the token never goes to another host or a stdio child
        assert out[name] == servers[name]
    assert "headers" not in servers["exa"]  # input untouched
    assert hub_token.with_hub_auth(servers, None) == servers


# ---- Claude Code headersHelper ---------------------------------------------------------------------

HELPER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hub_token.py")


def run_helper(*args, url="http://127.0.0.1:8790/mcp/exa", stdout=subprocess.PIPE):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENCODE_HUB_", "CLAUDE_CODE_MCP_"))}
    if url is not None:
        env["CLAUDE_CODE_MCP_SERVER_URL"] = url
    return subprocess.run([sys.executable, "-I", HELPER, "--headers", *args], env=env, stdout=stdout,
                          stderr=subprocess.PIPE, text=True, timeout=30)


def test_helper_command_and_entries(tmp_path):
    cmd = hub_token.helper_command(str(tmp_path / "tok"))
    assert cmd.isprintable() and cmd.isascii() and "    " not in cmd
    assert cmd.startswith("/usr/bin/python3 -I ") and cmd.endswith(f"--headers {tmp_path / 'tok'}")
    assert "--port" not in cmd and "--port 9999" in hub_token.helper_command(str(tmp_path / "tok"), 9999)
    servers = {"exa": {"type": "http", "url": "http://127.0.0.1:8790/mcp/exa"},
               "remote": {"type": "http", "url": "https://mcp.example.com/mcp"},
               "stdio": {"command": "node"}}
    out = hub_token.with_hub_helper(servers, cmd)
    assert out["exa"] == {**servers["exa"], "headersHelper": cmd} and "headers" not in out["exa"]
    assert out["remote"] == servers["remote"] and out["stdio"] == servers["stdio"]
    assert "headersHelper" not in servers["exa"] and hub_token.with_hub_helper(servers, None) == servers


def test_helper_prints_the_header_only_for_a_hub_url(tmp_path):
    path = make(tmp_path, "tok", SAMPLE.encode() + b"\n")
    res = run_helper(path)
    assert res.returncode == 0 and json.loads(res.stdout) == {"Authorization": f"Bearer {SAMPLE}"}
    assert SAMPLE not in res.stderr
    for url in ("https://mcp.example.com/mcp/exa", "http://100.64.0.1:8790/mcp/exa", "http://127.0.0.1:8790/x",
                "http://127.0.0.1:9999/mcp/exa", None):  # negative controls: never off-box, never without the CLI
        res = run_helper(path, url=url)
        assert res.returncode == 1 and res.stdout == "" and SAMPLE not in res.stderr, url
    res = run_helper(path, "--port", "9999", url="http://localhost:9999/mcp/tiny")
    assert res.returncode == 0 and SAMPLE in res.stdout
    assert run_helper(path, "--port", "9999").returncode == 1  # 8790 is not the hub then


def test_helper_without_or_with_bad_file(tmp_path):
    res = run_helper(str(tmp_path / "absent"))
    assert res.returncode == 0 and json.loads(res.stdout) == {}  # no file = no header (pre-F3)
    res = run_helper(make(tmp_path, "grp", SAMPLE.encode(), 0o644))
    assert res.returncode == 1 and res.stdout == "" and "mode 0600" in res.stderr and SAMPLE not in res.stderr
    assert run_helper("a", "b").returncode == 2


def test_helper_refuses_a_terminal(tmp_path):
    path = make(tmp_path, "tok", SAMPLE.encode())
    master, slave = pty.openpty()
    try:
        res = run_helper(path, stdout=slave)
        os.set_blocking(master, False)
        try:
            shown = os.read(master, 4096)
        except BlockingIOError:
            shown = b""
    finally:
        os.close(master)
        os.close(slave)
    assert res.returncode == 2 and SAMPLE.encode() not in shown and "terminal" in res.stderr
