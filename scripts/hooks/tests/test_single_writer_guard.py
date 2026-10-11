"""single-writer-guard hook tests (one writer session; others blocked, -p exempt, fail-open)."""
import json
import os
import shutil
import subprocess
import sys

import pytest

from conftest import HOOKS_DIR

HOOK = os.path.join(HOOKS_DIR, "single-writer-guard.py")


@pytest.fixture
def fake_claude(tmp_path):
    """Start processes whose /proc comm is 'claude.exe' (a copy of /bin/sh)."""
    exe = tmp_path / "claude.exe"
    shutil.copy("/bin/sh", exe)
    procs = []

    def start(*extra):
        p = subprocess.Popen([str(exe), "-c", "sleep 30; :"] + list(extra))
        procs.append(p)
        return p.pid

    yield start
    for p in procs:
        p.kill()
        p.wait()


def run(tmp_path, lock, self_pid, event="UserPromptSubmit", session_id="S1"):
    lock_path = tmp_path / "single-writer.lock"
    if lock is not None:
        lock_path.write_text(lock if isinstance(lock, str) else json.dumps(lock))
    env = dict(os.environ, SINGLE_WRITER_LOCK=str(lock_path), SINGLE_WRITER_SELF_PID=str(self_pid),
               SINGLE_WRITER_NO_KILL="1")
    res = subprocess.run([sys.executable, "-I", HOOK], input=json.dumps(
        {"hook_event_name": event, "session_id": session_id}), capture_output=True, text=True, env=env)
    assert res.returncode == 0
    lock_now = json.loads(lock_path.read_text()) if lock_path.exists() and lock is not None \
        and not isinstance(lock, str) else None
    return (json.loads(res.stdout) if res.stdout.strip() else None), lock_now


def test_no_lock_allows(tmp_path, fake_claude):
    out, _ = run(tmp_path, None, fake_claude())
    assert out is None


def test_owner_pid_allows(tmp_path, fake_claude):
    me = fake_claude()
    out, _ = run(tmp_path, {"pid": me, "session_id": "S1", "label": "a"}, me)
    assert out is None


@pytest.mark.parametrize("event", ["UserPromptSubmit", "PreToolUse", "SessionStart"])
def test_foreign_live_owner_blocks(tmp_path, fake_claude, event):
    owner, me = fake_claude(), fake_claude()
    out, _ = run(tmp_path, {"pid": owner, "session_id": "S1", "label": "a"}, me, event=event, session_id="S1")
    text = json.dumps(out)
    assert "R-DATA-16D" in text
    if event == "UserPromptSubmit":
        assert out["decision"] == "block"
    elif event == "PreToolUse":
        assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_dead_owner_same_session_adopts(tmp_path, fake_claude):
    me = fake_claude()
    out, lock = run(tmp_path, {"pid": 999999999, "session_id": "S1", "label": "a"}, me, session_id="S1")
    assert out is None and lock["pid"] == me


def test_dead_owner_other_session_blocks(tmp_path, fake_claude):
    me = fake_claude()
    out, lock = run(tmp_path, {"pid": 999999999, "session_id": "S1", "label": "a"}, me, session_id="S2")
    assert out["decision"] == "block" and lock["pid"] == 999999999


def test_print_mode_exempt(tmp_path, fake_claude):
    owner, me = fake_claude(), fake_claude("-p")
    out, _ = run(tmp_path, {"pid": owner, "session_id": "S1", "label": "a"}, me, session_id="S2")
    assert out is None


def test_corrupt_lock_fails_open(tmp_path, fake_claude):
    out, _ = run(tmp_path, "{not json", fake_claude())
    assert out is None


def test_kill_switch_really_kills(tmp_path, fake_claude):
    """Negative control: without NO_KILL the blocked claude process is terminated."""
    owner = fake_claude()
    victim = subprocess.Popen([str(tmp_path / "claude.exe"), "-c", "sleep 30; :"])
    lock_path = tmp_path / "single-writer.lock"
    lock_path.write_text(json.dumps({"pid": owner, "session_id": "S1", "label": "a"}))
    env = dict(os.environ, SINGLE_WRITER_LOCK=str(lock_path), SINGLE_WRITER_SELF_PID=str(victim.pid))
    subprocess.run([sys.executable, "-I", HOOK], input='{"hook_event_name":"UserPromptSubmit","session_id":"S2"}',
                   capture_output=True, text=True, env=env, check=True)
    assert victim.wait(timeout=10) != 0
