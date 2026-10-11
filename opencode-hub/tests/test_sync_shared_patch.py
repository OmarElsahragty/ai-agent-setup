"""patch-sync-shared.py on a COPY of this installation's OpenCode plugin (the source file is only read):
idempotent apply, --check, exact --revert, refusal on a moved anchor, and the patched config sends the hub
header only from a valid 0600 token file. The copy lives in a temp tree that carries its own
mcp/mcp_config.json, so the plugin reads nothing outside tmp. The unpatched copy is the negative control."""
import json
import os
import secrets
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(os.path.dirname(HERE))
PATCHER = os.path.join(os.path.dirname(HERE), "patch-sync-shared.py")
PLUGIN_SRC = os.path.join(ROOT, "opencode", "plugin", "sync-shared.ts")
CHECK = os.path.join(HERE, "check_sync_shared.mjs")
NODE = shutil.which("node")
# the plugin's own server list, hub URLs only (mcp_config.json carries no credentials)
MCP_CONFIG = {"mcpServers": {"exa": {"type": "http", "url": "http://127.0.0.1:8790/mcp/exa",
                                     "serverUrl": "http://127.0.0.1:8790/mcp/exa"}}}


def run_patcher(*args):
    return subprocess.run([sys.executable, PATCHER, *args], capture_output=True, text=True, timeout=30)


def run_check(plugin, expect, token_file):
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_HUB_")}
    env["OPENCODE_HUB_TOKEN_FILE"] = token_file
    # the plugin root is the temp dir two levels above opencode/plugin: pin it so no outside config is read
    env["AI_SETUP_ROOT"] = os.path.dirname(os.path.dirname(os.path.dirname(plugin)))
    return subprocess.run([NODE, "--no-warnings", CHECK, plugin, expect], capture_output=True, text=True,
                          timeout=60, env=env, cwd=os.path.dirname(plugin))


@pytest.fixture
def plugin(tmp_path):
    assert NODE, "node is required for this test"
    assert os.path.isfile(PLUGIN_SRC), f"plugin source not found: {PLUGIN_SRC} (set AI_SETUP_ROOT)"
    folder = tmp_path / "opencode" / "plugin"
    folder.mkdir(parents=True)
    dst = folder / "sync-shared.ts"
    shutil.copyfile(PLUGIN_SRC, dst)
    (tmp_path / "mcp").mkdir()
    (tmp_path / "mcp" / "mcp_config.json").write_text(json.dumps(MCP_CONFIG) + "\n")
    return str(dst)


def make_sample(tmp_path, mode=0o600):
    sample = secrets.token_urlsafe(36)
    path = tmp_path / "hub-token"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, sample.encode())
    os.close(fd)
    os.chmod(path, mode)
    return str(path), sample


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def test_apply_is_idempotent_and_revert_is_exact(plugin):
    original = read(plugin)
    assert run_patcher("--check", plugin).returncode == 0
    res = run_patcher(plugin)
    assert res.returncode == 0 and "patched" in res.stdout
    once = read(plugin)
    assert run_patcher(plugin).returncode == 0 and read(plugin) == once
    assert read(plugin + ".bak-pre-wo6") == original
    assert "applied" in run_patcher("--check", plugin).stdout
    assert run_patcher("--revert", plugin).returncode == 0
    assert read(plugin) == original


def test_patched_config_sends_header_only_with_a_valid_file(plugin, tmp_path):
    assert run_patcher(plugin).returncode == 0
    path, sample = make_sample(tmp_path)
    res = run_check(plugin, "header", path)
    assert res.returncode == 0, res.stdout + res.stderr
    assert sample not in res.stdout + res.stderr
    res = run_check(plugin, "none", str(tmp_path / "absent"))
    assert res.returncode == 0, res.stdout + res.stderr
    os.chmod(path, 0o644)
    res = run_check(plugin, "none", path)
    assert res.returncode == 0 and "0600" in res.stderr
    assert sample not in res.stdout + res.stderr


def test_unpatched_plugin_sends_no_header(plugin, tmp_path):
    path, _ = make_sample(tmp_path)
    assert run_check(plugin, "header", path).returncode == 1
    assert run_check(plugin, "none", path).returncode == 0


def test_moved_anchor_is_refused(plugin):
    with open(plugin, "w", encoding="utf-8") as fh:
        fh.write(read(plugin).replace("      headers: server.headers,\n", "      headers: server.headers ?? {},\n"))
    res = run_patcher("--check", plugin)
    assert res.returncode == 1 and "by hand" in res.stderr
    assert run_patcher(plugin).returncode == 1
    assert not os.path.exists(plugin + ".bak-pre-wo6")
