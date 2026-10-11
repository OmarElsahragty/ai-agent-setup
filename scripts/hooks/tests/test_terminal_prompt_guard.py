"""terminal-prompt-guard UserPromptSubmit hook tests (audit H GAP-6, WO-5 staged).

held in-turn by another pid -> block; idle-held -> allow + warn; missing/malformed state file ->
allow; own pid or an ancestor -> allow; kill switch -> allow (negative control for "hook
disabled": the same held payload passes with TERMINAL_PROMPT_GUARD_DISABLED=1).
"""
import json
import os
import subprocess
import sys

import pytest

from conftest import HOOKS_DIR, load_hook

tp = load_hook("terminal-prompt-guard.py")

SID = "6c609abcdeadbeefcafe1234567890abcdef01234567890abcdef1234567890"
PAYLOAD = {"session_id": SID, "prompt": "continue the analysis", "cwd": "/root"}


def state(tmp_path, entries):
    p = tmp_path / "runtime-state.json"
    p.write_text(json.dumps(entries))
    return str(p)


def entry(pid, st, sid=SID):
    return {"appSessionId": "app-1", "providerSessionId": sid, "pid": pid, "state": st,
            "since": "2026-10-10T11:00:00Z"}


def test_held_in_turn_by_other_pid_blocks(tmp_path):
    v = tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(999999, "in-turn")]),
                   self_pid=1, ancestors=set())
    assert v and "held by a live CloudCLI process" in v and "999999" in v


@pytest.mark.parametrize("st", ["bg-work", "retiring"])
def test_bg_work_and_retiring_block(tmp_path, st):
    assert tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(999999, st)]),
                      self_pid=1, ancestors=set())


def test_idle_held_allows_with_warning(tmp_path, capsys):
    assert tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(999999, "idle-held")]),
                      self_pid=1, ancestors=set()) is None
    assert "idle-held" in capsys.readouterr().err


def test_own_pid_allows(tmp_path):
    assert tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(4242, "in-turn")]),
                      self_pid=4242, ancestors=set()) is None


def test_ancestor_pid_allows(tmp_path):
    assert tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(100, "in-turn")]),
                      self_pid=4242, ancestors={100, 1}) is None


def test_missing_state_file_allows(tmp_path):
    assert tp.verdict(PAYLOAD, state_file=str(tmp_path / "nope.json"),
                      self_pid=1, ancestors=set()) is None


def test_malformed_state_file_allows(tmp_path):
    p = tmp_path / "runtime-state.json"
    p.write_text("{not json")
    assert tp.verdict(PAYLOAD, state_file=str(p), self_pid=1, ancestors=set()) is None


def test_other_session_ids_do_not_block(tmp_path):
    assert tp.verdict(PAYLOAD, state_file=state(tmp_path, [entry(999999, "in-turn", sid="other")]),
                      self_pid=1, ancestors=set()) is None


def _run_hook(payload, env=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "terminal-prompt-guard.py")],
                          input=json.dumps(payload), capture_output=True, text=True, env=e, timeout=10)


def test_main_blocks_held_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("CLOUDCLI_RUNTIME_STATE", state(tmp_path, [entry(999999, "in-turn")]))
    res = _run_hook(PAYLOAD)
    assert res.returncode == 0
    assert json.loads(res.stdout)["decision"] == "block"


def test_negative_control_hook_disabled_lets_held_prompt_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("CLOUDCLI_RUNTIME_STATE", state(tmp_path, [entry(999999, "in-turn")]))
    monkeypatch.setenv("TERMINAL_PROMPT_GUARD_DISABLED", "1")
    res = _run_hook(PAYLOAD)
    assert res.returncode == 0 and res.stdout.strip() == ""
