"""Gate-wave2 QA AC1: every PreToolUse guard fails OPEN (exit 0, no deny JSON) on malformed stdin,
including non-dict tool_input, non-string command and JSON nested deep enough to raise RecursionError."""
import json
import os
import subprocess
import sys

import pytest

HOOKS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# guard-study-delete.py is a private study-specific hook and is not part of this repo.
GUARDS = ["agent-claude-launch-guard.py", "file-lease.py", "restart-guard.py"]

CASES = [
    ("empty", b""),
    ("garbage", b"not json {"),
    ("truncated", b'{"tool_name": "Bash", "tool_input": {"comm'),
    ("bad utf8", b"\xff\xfe\xfa"),
    ("array", b"[1, 2]"),
    ("string", b'"x"'),
    ("null", b"null"),
    ("number", b"7"),
    ("tool_input string", json.dumps({"tool_name": "Bash", "tool_input": "rm -rf /"}).encode()),
    ("tool_input list", json.dumps({"tool_name": "Bash", "tool_input": ["rm", "-rf"]}).encode()),
    ("command int", json.dumps({"tool_name": "Bash", "tool_input": {"command": 7}}).encode()),
    ("command list", json.dumps({"tool_name": "Bash", "tool_input": {"command": ["rm", "-rf", "x"]}}).encode()),
    ("cwd list", json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": ["/"]}).encode()),
    ("deep nesting", b"[" * 100000 + b"]" * 100000),
]


@pytest.mark.parametrize("guard", GUARDS)
@pytest.mark.parametrize("label,payload", CASES, ids=[c[0] for c in CASES])
def test_guard_fails_open_on_malformed_stdin(guard, label, payload, tmp_path):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1",
               HOME=str(tmp_path), AI_SETUP_HOME=str(tmp_path),
               FILE_LEASE_DB=str(tmp_path / "lease.db"),
               RESTART_GUARD_ATTR_LOG=str(tmp_path / "attr.log"))
    r = subprocess.run([sys.executable, os.path.join(HOOKS, guard)], input=payload,
                       capture_output=True, timeout=60, env=env, cwd=str(tmp_path))
    assert r.returncode == 0, f"{guard} [{label}] exit {r.returncode}: {r.stderr.decode(errors='replace')[-300:]}"
    assert b'"deny"' not in r.stdout, f"{guard} [{label}] denied on malformed input"
    assert b"Traceback" not in r.stderr, f"{guard} [{label}] crashed"
