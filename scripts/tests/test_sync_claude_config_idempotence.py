"""sync-claude-config.py (WO-6): settings.json and ~/.claude.json are rewritten only when their content
changes, and the opencode-hub token reaches Claude Code only through a headersHelper command: no token
value in ~/.claude.json, in the git-tracked mcp_config.json or in any output. Every path is redirected
to tmp_path (a temp config prefix) and main() is never called, so the live ~/.claude, ~/.claude.json and
${AI_SETUP_ROOT} links are untouched. SYNC_UNDER_TEST selects the script (negative control: a mutant copy)."""
import importlib.util
import json
import os
import secrets

import pytest

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.environ.get("SYNC_UNDER_TEST", os.path.join(SCRIPTS_DIR, "sync-claude-config.py"))
HUB_URL = "http://127.0.0.1:8790/mcp/exa"


@pytest.fixture
def mod(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("AI_SETUP_HOME", str(home))
    spec = importlib.util.spec_from_file_location("sync_claude_config_wo6", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cfg = tmp_path / "mcp_config.json"
    cfg.write_text(json.dumps({"mcpServers": {
        "exa": {"type": "http", "url": HUB_URL, "serverUrl": HUB_URL},
        "other": {"type": "http", "url": "https://mcp.example.com/x"}}}, indent=2))
    monkeypatch.setattr(module, "MCP_CONFIG", str(cfg))
    monkeypatch.setattr(module, "CLAUDE_JSON_PATH", str(tmp_path / "claude.json"))
    monkeypatch.setattr(module, "CLAUDE_CONFIG_DIR", str(tmp_path / "dot-claude"))
    monkeypatch.setattr(module, "PROJECT_SETTINGS_LINK", str(tmp_path / "proj" / ".claude" / "settings.json"))
    monkeypatch.setattr(module, "PROJECT_MCP_LINK", str(tmp_path / "proj" / ".mcp.json"))
    monkeypatch.setattr(module, "PROJECT_MCP_EMPTY", str(tmp_path / "mcp_project_empty.json"))
    monkeypatch.setattr(module.hub_token, "TOKEN_FILE", str(tmp_path / "hub-token"))
    return module


def ident(path):
    """(inode, mtime): an atomic rewrite always changes the inode, so this catches same-tick writes too."""
    st = os.stat(path)
    return st.st_ino, st.st_mtime_ns


def outputs(mod):
    """Every file the MCP + settings sync writes (links resolved), with its identity."""
    paths = [os.path.join(mod.CLAUDE_CONFIG_DIR, "settings.json"), mod.CLAUDE_JSON_PATH,
             mod.PROJECT_MCP_LINK, mod.PROJECT_SETTINGS_LINK]
    if os.path.exists(mod.PROJECT_MCP_EMPTY):
        paths.append(mod.PROJECT_MCP_EMPTY)
    return {p: (ident(p), os.lstat(p).st_ino, os.lstat(p).st_mtime_ns) for p in paths}


def settings_path(mod):
    return os.path.join(mod.CLAUDE_CONFIG_DIR, "settings.json")


def put_sample(mod, mode=0o600):
    sample = secrets.token_urlsafe(36)
    fd = os.open(mod.hub_token.TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    os.write(fd, sample.encode())
    os.close(fd)
    os.chmod(mod.hub_token.TOKEN_FILE, mode)
    return sample


# ---- end to end: the MCP + settings half of main(), run twice on a temp prefix ----------------------

@pytest.mark.parametrize("token_on", [False, True])
def test_second_run_writes_nothing(mod, token_on):
    if token_on:
        put_sample(mod)
    with open(mod.CLAUDE_JSON_PATH, "w") as fh:
        json.dump({"numStartups": 3}, fh)
    first = mod.sync_mcp_and_settings()
    assert first["settings_written"] is True and first["helper"] is token_on
    before = outputs(mod)
    second = mod.sync_mcp_and_settings()
    assert second["settings_written"] is False
    assert outputs(mod) == before  # no file, link or link target replaced; no mtime moved


# ---- settings.json ---------------------------------------------------------------------------------

def test_settings_second_run_does_not_touch_the_file(mod):
    assert mod.write_claude_settings(["exa"]) is True
    path = settings_path(mod)
    assert os.stat(path).st_mode & 0o777 == 0o600
    before = ident(path)
    assert mod.write_claude_settings(["exa"]) is False
    assert ident(path) == before


def test_settings_rewritten_when_content_changes(mod):
    mod.write_claude_settings(["exa"])
    before = ident(settings_path(mod))
    assert mod.write_claude_settings(["exa", "other"]) is True
    assert ident(settings_path(mod)) != before
    with open(settings_path(mod)) as fh:
        assert "mcp__other__*" in json.load(fh)["permissions"]["allow"]


def test_format_only_difference_is_not_a_change(mod):
    mod.write_claude_settings(["exa"])
    path = settings_path(mod)
    with open(path) as fh:
        data = json.load(fh)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=4, sort_keys=True)
    before = ident(path)
    assert mod.write_claude_settings(["exa"]) is False
    assert ident(path) == before


def test_live_model_choice_kept_without_rewrite(mod):
    mod.write_claude_settings(["exa"])
    path = settings_path(mod)
    with open(path) as fh:
        data = json.load(fh)
    data["model"] = "claude-fable-5-1[1m]"  # what /model saves into settings.json
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
    before = ident(path)
    assert mod.write_claude_settings(["exa"]) is False
    assert ident(path) == before


def test_mode_drift_fixed_without_rewrite(mod):
    mod.write_claude_settings(["exa"])
    path = settings_path(mod)
    os.chmod(path, 0o644)
    before = ident(path)
    assert mod.write_claude_settings(["exa"]) is False
    assert os.stat(path).st_mode & 0o777 == 0o600 and ident(path) == before


def test_settings_symlink_stays_a_link(mod, tmp_path):
    os.makedirs(mod.CLAUDE_CONFIG_DIR)
    target = tmp_path / "real-settings.json"
    target.write_text("{}")
    os.symlink(target, settings_path(mod))
    assert mod.write_claude_settings(["exa"]) is True
    assert os.path.islink(settings_path(mod)) and os.path.islink(mod.PROJECT_SETTINGS_LINK)
    assert "permissions" in json.loads(target.read_text())


# ---- ~/.claude.json + the hub token ----------------------------------------------------------------

def test_claude_json_without_token_is_pre_f3_and_idempotent(mod):
    with open(mod.CLAUDE_JSON_PATH, "w") as fh:
        json.dump({"numStartups": 7, "projects": {"/x": {}}}, fh)
    assert mod.hub_helper_command() is None  # no token file
    mod.sync_mcp_to_claude_json(None)
    with open(mod.CLAUDE_JSON_PATH) as fh:
        data = json.load(fh)
    with open(mod.MCP_CONFIG) as fh:
        assert data["mcpServers"] == json.load(fh)["mcpServers"]
    assert data["numStartups"] == 7 and data["projects"] == {"/x": {}}
    before = ident(mod.CLAUDE_JSON_PATH)
    mod.sync_mcp_to_claude_json(mod.hub_helper_command())
    assert ident(mod.CLAUDE_JSON_PATH) == before
    assert mod.sync_project_mcp_link(False) == mod.MCP_CONFIG
    assert os.readlink(mod.PROJECT_MCP_LINK) == mod.MCP_CONFIG


def test_token_reaches_claude_json_only_as_a_helper(mod, capsys):
    sample = put_sample(mod)
    with open(mod.MCP_CONFIG) as fh:
        tracked_before = fh.read()
    helper = mod.hub_helper_command()
    assert helper and "--headers" in helper and mod.hub_token.TOKEN_FILE in helper
    mod.sync_mcp_to_claude_json(helper)
    target = mod.sync_project_mcp_link(helper is not None)
    with open(mod.CLAUDE_JSON_PATH) as fh:
        raw = fh.read()
    servers = json.loads(raw)["mcpServers"]
    assert sample not in raw and "Authorization" not in raw  # no literal token: CloudCLI copies this to argv
    assert servers["exa"]["headersHelper"] == helper and "headers" not in servers["exa"]
    assert "headersHelper" not in servers["other"]  # never for another host
    with open(mod.MCP_CONFIG) as fh:
        assert fh.read() == tracked_before  # the git-tracked client file never changes
    assert target == mod.PROJECT_MCP_EMPTY and os.readlink(mod.PROJECT_MCP_LINK) == mod.PROJECT_MCP_EMPTY
    with open(mod.PROJECT_MCP_EMPTY) as fh:
        assert json.load(fh) == {"mcpServers": {}}
    before = ident(mod.CLAUDE_JSON_PATH)
    mod.sync_mcp_to_claude_json(mod.hub_helper_command())
    assert ident(mod.CLAUDE_JSON_PATH) == before  # second run: no change
    out = capsys.readouterr()
    assert sample not in out.out + out.err
    os.unlink(mod.hub_token.TOKEN_FILE)  # token gone -> back to the pre-F3 layout
    mod.sync_mcp_to_claude_json(mod.hub_helper_command())
    with open(mod.CLAUDE_JSON_PATH) as fh:
        assert "headersHelper" not in json.load(fh)["mcpServers"]["exa"]
    assert mod.sync_project_mcp_link(False) == mod.MCP_CONFIG


def test_unusable_token_file_warns_without_the_value(mod, capsys):
    sample = put_sample(mod, 0o644)
    assert mod.hub_helper_command() is None
    out = capsys.readouterr()
    assert "WARN" in out.err and "mode 0600" in out.err
    assert sample not in out.out + out.err


@pytest.mark.parametrize("content", ['{"numStartups": 9, "projects": {', "[1, 2]"])
def test_unparsable_claude_json_is_never_clobbered(mod, capsys, content):
    with open(mod.CLAUDE_JSON_PATH, "w") as fh:
        fh.write(content)  # e.g. read while the CLI is mid-write
    before = ident(mod.CLAUDE_JSON_PATH)
    assert mod.sync_mcp_to_claude_json(None) == ["exa", "other"]
    assert ident(mod.CLAUDE_JSON_PATH) == before
    with open(mod.CLAUDE_JSON_PATH) as fh:
        assert fh.read() == content
    assert "NOT synced" in capsys.readouterr().err
