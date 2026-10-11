"""poll-guard PreToolUse hook tests (M-045: deny the 6th identical Bash command in 10 minutes).

The clock is injected through check(now=...), so the window tests never sleep. The end-to-end
tests run the hook as a subprocess with POLL_GUARD_STATE_DIR pointed at tmp_path. Negative
controls: different commands, other transcripts, other cwds, run_in_background, aged-out runs.
"""
import json
import os
import subprocess
import sys

import pytest

from conftest import HOOKS_DIR, load_hook

_ORIG = "/var/tmp/claude/acg-probe/orig/poll-guard.py"
if os.environ.get("FILE_LEASE_NEGATIVE_CONTROL") == "1" and os.path.exists(_ORIG):
    pg = load_hook(_ORIG, unique_name="pg_negctl")  # negative control: the ORIGINAL guard
else:
    pg = load_hook("poll-guard.py")

POLL = "cat /var/tmp/claude/tasks/abc.output; tail -10 /var/tmp/claude/tasks/abc.output"


def _payload(command, session="sess-1", agent=None, cwd="/root", background=None):
    data = {"tool_name": "Bash", "session_id": session, "cwd": cwd,
            "tool_input": {"command": command, "description": "poll"}}
    if agent is not None:
        data["agent_id"] = agent
    if background is not None:
        data["tool_input"]["run_in_background"] = background
    return data


def _run(payload, state_dir):
    env = dict(os.environ, POLL_GUARD_STATE_DIR=str(state_dir))
    proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "poll-guard.py")],
                          input=json.dumps(payload).encode("utf-8"), capture_output=True,
                          timeout=10, env=env)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


def _runs(state_dir, payload, times):
    return [pg.check(payload, now=t, state_dir=str(state_dir)) for t in times]


def test_sixth_identical_command_denied_end_to_end(tmp_path):
    for _ in range(5):
        code, out, err = _run(_payload(POLL), tmp_path)
        assert code == 0 and out == "" and err == ""
    code, out, _ = _run(_payload(POLL), tmp_path)
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec["hookEventName"] == "PreToolUse"
    assert spec["permissionDecision"] == "deny"
    reason = spec["permissionDecisionReason"]
    assert "poll-guard" in reason and "run_in_background=true" in reason
    assert "5 times in the last 10 minutes" in reason


def test_every_later_retry_is_denied_too(tmp_path):
    verdicts = _runs(tmp_path, _payload(POLL), [0, 1, 2, 3, 4, 5, 6, 7])
    assert verdicts[:5] == [None] * 5
    assert all(v for v in verdicts[5:])


def test_whitespace_variants_are_the_same_command(tmp_path):
    variants = [POLL, "  " + POLL, POLL.replace("; ", ";   "), POLL.replace(" ", "\t"), POLL + "\n",
                POLL.replace(" -10 ", "  -10  ")]
    verdicts = [pg.check(_payload(c), now=i, state_dir=str(tmp_path)) for i, c in enumerate(variants)]
    assert verdicts[:5] == [None] * 5 and verdicts[5]


def test_test_runner_reruns_are_not_exempt(tmp_path):
    verdicts = _runs(tmp_path, _payload("python3 -m pytest -q tests"), range(6))
    assert verdicts[:5] == [None] * 5 and verdicts[5]


def test_negative_control_different_commands_do_not_add_up(tmp_path):
    for i in range(5):
        assert pg.check(_payload(POLL), now=i, state_dir=str(tmp_path)) is None
    for i, cmd in enumerate(("git status", "ls -la", "tail -10 /var/tmp/claude/tasks/abc.output")):
        assert pg.check(_payload(cmd), now=10 + i, state_dir=str(tmp_path)) is None
    assert pg.check(_payload(POLL), now=20, state_dir=str(tmp_path))


def test_window_slides_runs_older_than_ten_minutes_age_out(tmp_path):
    assert _runs(tmp_path, _payload(POLL), [0, 60, 120, 180, 240]) == [None] * 5
    assert pg.check(_payload(POLL), now=599, state_dir=str(tmp_path))       # t=0 still inside
    assert pg.check(_payload(POLL), now=600, state_dir=str(tmp_path)) is None  # t=0 aged out
    assert pg.check(_payload(POLL), now=601, state_dir=str(tmp_path))       # 60..240 + 600 = 5


def test_denied_attempts_never_extend_the_window(tmp_path):
    assert _runs(tmp_path, _payload(POLL), [0, 1, 2, 3, 4]) == [None] * 5
    assert all(_runs(tmp_path, _payload(POLL), [100, 200, 300, 400, 500, 590]))
    assert pg.check(_payload(POLL), now=600.5, state_dir=str(tmp_path)) is None


def test_negative_control_each_transcript_counts_alone(tmp_path):
    assert _runs(tmp_path, _payload(POLL, session="s1"), range(5)) == [None] * 5
    assert pg.check(_payload(POLL, session="s2"), now=6, state_dir=str(tmp_path)) is None
    assert pg.check(_payload(POLL, session="s1", agent="agent-a1"), now=6, state_dir=str(tmp_path)) is None
    assert pg.check(_payload(POLL, session="s1", agent=""), now=7, state_dir=str(tmp_path))  # "" = main
    assert pg.check(_payload(POLL, session="s1"), now=8, state_dir=str(tmp_path))


def test_parallel_subagents_of_one_session_do_not_share_a_count(tmp_path):
    for i in range(6):
        assert pg.check(_payload("git status --short", session="s1", agent="agent-%d" % i),
                        now=i, state_dir=str(tmp_path)) is None


def test_negative_control_other_cwd_is_another_command(tmp_path):
    assert _runs(tmp_path, _payload("python3 -m pytest -q tests", cwd="/a"), range(5)) == [None] * 5
    assert pg.check(_payload("python3 -m pytest -q tests", cwd="/b"), now=6, state_dir=str(tmp_path)) is None


def test_run_in_background_is_neither_counted_nor_denied(tmp_path):
    for i in range(8):
        assert pg.check(_payload(POLL, background=True), now=i, state_dir=str(tmp_path)) is None
    assert _runs(tmp_path, _payload(POLL), [10, 11, 12, 13, 14]) == [None] * 5
    assert pg.check(_payload(POLL), now=15, state_dir=str(tmp_path))
    assert pg.check(_payload(POLL, background=True), now=16, state_dir=str(tmp_path)) is None
    assert pg.check(_payload(POLL, background=False), now=17, state_dir=str(tmp_path))


@pytest.mark.parametrize("payload", [
    {"tool_name": "Read", "session_id": "s", "tool_input": {"file_path": "/x"}},
    {"tool_name": "Bash", "session_id": "s", "tool_input": {"command": "   "}},
    {"tool_name": "Bash", "session_id": "s", "tool_input": {"command": 42}},
    {"tool_name": "Bash", "session_id": "s", "tool_input": "ls"},
    {"tool_name": "Bash", "tool_input": {"command": "ls"}},  # no session id, no transcript path
])
def test_ignored_payloads_never_deny(tmp_path, payload):
    for i in range(8):
        assert pg.check(payload, now=i, state_dir=str(tmp_path)) is None


def test_transcript_path_is_the_fallback_key(tmp_path):
    payload = {"tool_name": "Bash", "transcript_path": "/root/.claude/projects/x/t.jsonl",
               "tool_input": {"command": POLL}}
    assert _runs(tmp_path, payload, range(5)) == [None] * 5
    assert pg.check(payload, now=6, state_dir=str(tmp_path))


def test_corrupt_state_file_restarts_the_count(tmp_path):
    assert pg.check(_payload(POLL), now=0, state_dir=str(tmp_path)) is None
    files = [f for f in os.listdir(tmp_path) if f.endswith(".json")]
    assert len(files) == 1
    (tmp_path / files[0]).write_text("{not json", encoding="utf-8")
    assert _runs(tmp_path, _payload(POLL), [1, 2, 3, 4, 5]) == [None] * 5
    assert pg.check(_payload(POLL), now=6, state_dir=str(tmp_path))


def test_state_file_is_private_and_bounded(tmp_path):
    for i in range(pg.MAX_ENTRIES + 50):
        pg.check(_payload("echo %d" % i), now=i * 0.01, state_dir=str(tmp_path))
    (name,) = [f for f in os.listdir(tmp_path) if f.endswith(".json")]
    path = tmp_path / name
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"
    assert len(json.loads(path.read_text(encoding="utf-8"))) == pg.MAX_ENTRIES
    assert "echo" not in path.read_text(encoding="utf-8")  # hashes only, never command text


def test_idle_transcript_files_are_swept_when_a_new_one_starts(tmp_path):
    stale = tmp_path / ("0" * 40 + ".json")
    stale.write_text("[]", encoding="utf-8")
    old = 1_000_000.0
    os.utime(stale, (old, old))
    pg.check(_payload(POLL, session="fresh"), now=old + pg.SWEEP_AGE_S + 10, state_dir=str(tmp_path))
    assert not stale.exists()


def _edit(tool="Edit", session="sess-1", agent=None):
    data = {"tool_name": tool, "session_id": session, "cwd": "/root",
            "tool_input": {"file_path": "/root/x.py", "old_string": "a", "new_string": "b"}}
    if agent is not None:
        data["agent_id"] = agent
    return data


@pytest.mark.parametrize("tool", ["Edit", "Write", "MultiEdit"])
def test_edit_in_same_transcript_resets_the_counter(tmp_path, tool):
    # orchestrator ruling 2026-10-10: an edit-test loop is not a poll
    assert _runs(tmp_path, _payload(POLL), range(5)) == [None] * 5
    assert pg.check(_edit(tool), now=5, state_dir=str(tmp_path)) is None
    assert _runs(tmp_path, _payload(POLL), range(6, 11)) == [None] * 5
    assert pg.check(_payload(POLL), now=11, state_dir=str(tmp_path))


def test_negative_control_other_tools_and_other_transcripts_do_not_reset(tmp_path):
    assert _runs(tmp_path, _payload(POLL), range(5)) == [None] * 5
    read = {"tool_name": "Read", "session_id": "sess-1", "tool_input": {"file_path": "/root/x.py"}}
    for i, payload in enumerate((read, _edit(session="sess-2"), _edit(agent="agent-b"),
                                 _payload("git diff --stat"))):
        assert pg.check(payload, now=5 + i, state_dir=str(tmp_path)) is None
    assert pg.check(_payload(POLL), now=10, state_dir=str(tmp_path))


def test_edit_reset_never_creates_state(tmp_path):
    for tool in ("Edit", "Write", "MultiEdit"):
        assert pg.check(_edit(tool, session="new"), now=0, state_dir=str(tmp_path)) is None
    assert pg.check({"tool_name": "Edit", "tool_input": {}}, state_dir=str(tmp_path)) is None
    assert os.listdir(tmp_path) == []


def test_edit_reset_end_to_end(tmp_path):
    for _ in range(5):
        assert _run(_payload(POLL), tmp_path)[1] == ""
    assert _run(_edit("Write"), tmp_path) == (0, "", "")
    assert _run(_payload(POLL), tmp_path)[1] == ""


def test_fails_open_on_bad_stdin_and_unwritable_state(tmp_path):
    for raw in (b"not json", b"[1, 2]", b"\"str\"", b"42", b"null"):
        proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "poll-guard.py")], input=raw,
                              capture_output=True, timeout=10,
                              env=dict(os.environ, POLL_GUARD_STATE_DIR=str(tmp_path)))
        assert proc.returncode == 0 and proc.stdout == b"" and proc.stderr == b""
    blocker = tmp_path / "file-not-dir"
    blocker.write_text("x", encoding="utf-8")
    for _ in range(7):
        code, out, err = _run(_payload(POLL), blocker / "state")
        assert code == 0 and out == "" and err == ""
