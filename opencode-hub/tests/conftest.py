"""Fixtures for the opencode-hub tests: a throwaway hub on a free loopback port with a temp token file,
a temp servers file (one tiny stdio MCP) and a temp public dir. Never the live hub, port 8790 or the real
${AI_SETUP_ROOT}/mcp/mcp_servers.json. HUB_UNDER_TEST selects the hub file (negative control: git HEAD)."""
import json
import os
import secrets
import signal
import site
import socket
import subprocess
import sys
import time

import httpx
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
HUB = os.environ.get("HUB_UNDER_TEST", os.path.join(os.path.dirname(HERE), "opencode-hub.py"))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Hub:
    def __init__(self, port: int, proc: subprocess.Popen, log_path: str, token: str | None):
        self.port, self.proc, self.log_path, self.token = port, proc, log_path, token

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def log_text(self) -> str:
        with open(self.log_path, encoding="utf-8", errors="replace") as fh:
            return fh.read()

    def stop(self) -> None:
        """Stops only this test's own process group (the temp hub and its tiny MCP child)."""
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(timeout=5)


@pytest.fixture
def start_hub(tmp_path):
    """Factory: start_hub(token_mode) with token_mode None (no OPENCODE_HUB_TOKEN_FILE), "valid" (0600)
    or "group-readable" (0644: the hub must fail closed)."""
    hubs = []

    def start(token_mode: str | None = "valid", extra_env: dict | None = None, hub_path: str | None = None) -> Hub:
        root = tmp_path / f"hub{len(hubs)}"
        (root / "public" / "plugins").mkdir(parents=True)
        (root / "home").mkdir()
        (root / "public" / "wellknown.json").write_text('{"config": {"hub": "{HUB}"}}\n')
        (root / "public" / "plugins" / "demo-1.0.0.tgz").write_bytes(b"demo")
        userbase = site.getuserbase()
        servers = {"mcpServers": {"tiny": {"command": sys.executable,
                                           "args": [os.path.join(HERE, "tiny_mcp.py")],
                                           "env": {"PYTHONUSERBASE": userbase}}}}
        (root / "servers.json").write_text(json.dumps(servers))
        port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_HUB_")}
        env.update({
            "HOME": str(root / "home"), "PYTHONUSERBASE": userbase,
            "OPENCODE_HUB_SERVERS": str(root / "servers.json"),
            "OPENCODE_HUB_PUBLIC_DIR": str(root / "public"),
            "OPENCODE_HUB_BIND": "127.0.0.1", "OPENCODE_HUB_PORT": str(port),
            "OPENCODE_HUB_URL": f"http://127.0.0.1:{port}",
            "OPENCODE_HUB_ALLOWED_NETS": "127.0.0.0/8",
            "OPENCODE_HUB_ALLOWED_HOSTS": "127.0.0.1,localhost",
            "OPENCODE_HUB_SELF_ADDRS": "", "OPENCODE_HUB_OFFBOX": "",
            "OPENCODE_HUB_DECIDE_URL": "http://127.0.0.1:9",  # closed: never the live local-decide
        })
        token = None
        if token_mode is not None:
            token = secrets.token_urlsafe(48)
            token_file = root / "token"
            fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(token + "\n")
            if token_mode == "group-readable":
                os.chmod(token_file, 0o644)
            env["OPENCODE_HUB_TOKEN_FILE"] = str(token_file)
        env.update(extra_env or {})
        log_path = str(root / "hub.log")
        with open(log_path, "wb") as log:
            proc = subprocess.Popen([sys.executable, hub_path or HUB], env=env, stdout=log, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        hub = Hub(port, proc, log_path, token)
        hubs.append(hub)
        deadline = time.monotonic() + 30
        while True:
            if proc.poll() is not None:
                pytest.fail(f"hub exited with {proc.returncode}:\n{hub.log_text()[-2000:]}")
            try:
                if httpx.get(hub.url("/health"), timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                pytest.fail(f"hub not healthy after 30 s:\n{hub.log_text()[-2000:]}")
            time.sleep(0.2)
        return hub

    yield start
    for hub in hubs:
        hub.stop()


@pytest.fixture
def head_hub(tmp_path) -> str:
    """git HEAD's opencode-hub.py (the pre-F3 hub) as a temp file: the reference for the unset-env case.
    A checkout with no commits yet (a fresh clone/export) has no HEAD, so there is no pre-F3 reference to
    compare against: the case is skipped there and runs again as soon as HEAD exists."""
    root = os.path.dirname(HERE)
    if subprocess.run(["git", "-C", root, "rev-parse", "--verify", "HEAD"],
                      capture_output=True).returncode:
        pytest.skip("no git HEAD in this checkout: the pre-F3 reference hub is unavailable")
    out = subprocess.run(["git", "-C", root, "show", "HEAD:./opencode-hub.py"],
                         capture_output=True, check=True, timeout=30).stdout
    path = tmp_path / "head-opencode-hub.py"
    path.write_bytes(out)
    return str(path)
