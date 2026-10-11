"""sync-claude-config.py: local-decide hook registration and SessionStart wiring."""
import os

from conftest import load_hook


def _fresh_module(monkeypatch):
    # Force the ENABLED-gated branch deterministically regardless of repo state.
    monkeypatch.setattr(os.path, "exists", lambda path: True)
    return load_hook("sync-claude-config.py", unique_name="sync_claude_config_under_test")


def test_pre_tool_matcher_includes_read(monkeypatch):
    mod = _fresh_module(monkeypatch)
    assert "Read" in mod.LOCAL_DECIDE_PRE_TOOL["matcher"].split("|")


def test_secret_write_guard_registered_for_bash(monkeypatch):
    mod = _fresh_module(monkeypatch)
    bash_entries = [e for e in mod.WAVE_B_HOOKS["PreToolUse"] if e.get("matcher") == "Bash"]
    assert len(bash_entries) == 1
    hook = bash_entries[0]["hooks"][0]
    assert hook["type"] == "command"
    assert "secret-write-guard.py" in hook["command"]
    assert hook["timeout"] == 10


def test_restart_guard_registered_for_bash(monkeypatch):
    mod = _fresh_module(monkeypatch)
    bash_entries = [e for e in mod.WAVE_B_HOOKS["PreToolUse"] if e.get("matcher") == "Bash"]
    commands = [h["command"] for h in bash_entries[0]["hooks"]]
    assert any("restart-guard.py" in c for c in commands)


def test_stop_hook_registered(monkeypatch):
    mod = _fresh_module(monkeypatch)
    stop = mod.LOCAL_DECIDE_HOOKS["Stop"]
    hook = stop[0]["hooks"][0]
    assert hook["url"] == "http://127.0.0.1:11438/hook/claude/Stop"
    assert hook["timeout"] == 5
    assert hook["type"] == "http"


def test_session_start_registers_postcompact_only(monkeypatch):
    mod = _fresh_module(monkeypatch)
    entries = mod.session_start_hooks()
    assert len(entries) == 1
    assert entries[0]["matcher"] == "compact|resume"
    assert "postcompact-anchor.py" in entries[0]["hooks"][0]["command"]
    # the study-specific cert2-context.sh entry is not part of this repo
    assert all("cert2" not in h["command"] for e in entries for h in e["hooks"])


def test_disabled_state_strips_local_decide_hooks(monkeypatch):
    monkeypatch.setattr(os.path, "exists", lambda path: False)
    mod = load_hook("sync-claude-config.py", unique_name="sync_claude_config_disabled")
    assert mod.LOCAL_DECIDE_HOOKS == {}
