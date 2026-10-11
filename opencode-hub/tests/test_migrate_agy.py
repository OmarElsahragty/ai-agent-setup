"""migrate-mcp-config.py (WO-6) in a sandbox (OPENCODE_HUB_MCP_DIR / _AGY_CONFIG / _TOKEN_FILE point at
tmp_path): the git-tracked client file never carries the token; agy gets a 0600 copy with the header only
while the token file exists, and its symlink back otherwise (also on --revert)."""
import json
import os
import secrets
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "migrate-mcp-config.py")


def setup(tmp_path):
    mcp = tmp_path / "mcp"
    mcp.mkdir()
    (mcp / "mcp_servers.json").write_text(json.dumps({"mcpServers": {"exa": {"command": "x"}, "tiny": {"command": "y"}}}))
    (mcp / "mcp_config.json").write_text(json.dumps({"mcpServers": {"exa": {"type": "http", "url": "u"}}}))
    (mcp / "mcp_config.pre-hub.json").write_text(json.dumps({"mcpServers": {"exa": {"command": "x"}}}))
    agy_dir = tmp_path / "gemini" / "config"
    agy_dir.mkdir(parents=True)
    agy = agy_dir / "mcp_config.json"
    os.symlink(mcp / "mcp_config.json", agy)
    return str(mcp / "mcp_config.json"), str(agy), str(tmp_path / "hub-token")


def run(tmp_path, *args, agy=None, token_file=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_HUB_")}
    env.update(OPENCODE_HUB_MCP_DIR=str(tmp_path / "mcp"), OPENCODE_HUB_AGY_CONFIG=agy,
               OPENCODE_HUB_TOKEN_FILE=token_file)
    return subprocess.run([sys.executable, SCRIPT, *args], env=env, capture_output=True, text=True, timeout=30)


def put_sample(path):
    sample = secrets.token_urlsafe(36)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, sample.encode())
    os.close(fd)
    return sample


def test_no_token_keeps_the_symlink_layout(tmp_path):
    clients, agy, token_file = setup(tmp_path)
    res = run(tmp_path, agy=agy, token_file=token_file)
    assert res.returncode == 0, res.stderr
    assert os.path.islink(agy) and os.readlink(agy) == clients
    with open(clients) as fh:
        data = json.load(fh)
    assert sorted(data["mcpServers"]) == ["exa", "tiny"]
    assert all("headers" not in e for e in data["mcpServers"].values())


def test_token_goes_to_agy_copy_never_to_the_tracked_file(tmp_path):
    clients, agy, token_file = setup(tmp_path)
    sample = put_sample(token_file)
    res = run(tmp_path, agy=agy, token_file=token_file)
    assert res.returncode == 0, res.stderr
    assert sample not in res.stdout + res.stderr
    assert not os.path.islink(agy) and os.stat(agy).st_mode & 0o777 == 0o600
    with open(agy) as fh:
        servers = json.load(fh)["mcpServers"]
    assert all(e["headers"] == {"Authorization": f"Bearer {sample}"} for e in servers.values())
    with open(clients) as fh:
        tracked = fh.read()
    assert sample not in tracked and "Authorization" not in tracked
    # token gone again -> the link is back and the copy with the token is replaced
    os.unlink(token_file)
    assert run(tmp_path, agy=agy, token_file=token_file).returncode == 0
    assert os.path.islink(agy) and os.readlink(agy) == clients


def test_revert_relinks_agy(tmp_path):
    clients, agy, token_file = setup(tmp_path)
    put_sample(token_file)
    assert run(tmp_path, agy=agy, token_file=token_file).returncode == 0 and not os.path.islink(agy)
    res = run(tmp_path, "--revert", agy=agy, token_file=token_file)
    assert res.returncode == 0, res.stderr
    assert os.path.islink(agy) and os.readlink(agy) == clients


def test_unusable_token_warns_and_keeps_the_link(tmp_path):
    clients, agy, token_file = setup(tmp_path)
    sample = put_sample(token_file)
    os.chmod(token_file, 0o644)
    res = run(tmp_path, agy=agy, token_file=token_file)
    assert res.returncode == 0 and "WARN" in res.stderr and sample not in res.stdout + res.stderr
    assert os.path.islink(agy) and os.readlink(agy) == clients


def test_missing_agy_dir_is_skipped(tmp_path):
    _, _, token_file = setup(tmp_path)
    put_sample(token_file)
    res = run(tmp_path, agy=str(tmp_path / "no-agy" / "mcp_config.json"), token_file=token_file)
    assert res.returncode == 0 and "skipped" in res.stdout
