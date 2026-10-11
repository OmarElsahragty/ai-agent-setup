"""decisions.py redaction: every secret form must die before the JSONL.

One test per form (security follow-up LOW-2, E3 2026-10-02): SECRET_PATTERNS
literals, unquoted KEY=value, `--password value`, `Authorization: Bearer x`.
The fake credential strings are built by runtime concatenation so this file
itself never contains a credential-shaped literal — the D7 guard must keep
passing over its own test suite. The decision log is redirected by the shared
conftest autouse fixture, so nothing here touches the real decisions.jsonl.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import decisions  # noqa: E402

_AWS = "AKIA" + "IOSFODNN7EXAMPLE"          # fires decisions.SECRET_PATTERNS at runtime
_SLACK = "xoxb-" + "1234567890abcdef"
_LONG_QUOTED = "abcdefghij" + "0123456789"
_BEARER = "tok_" + "abcdef1234567890"


def test_secret_pattern_literals_are_redacted():
    out = decisions.redact("key = %s and tok %s" % (_AWS, _SLACK))
    assert _AWS not in out
    assert _SLACK not in out
    assert "[REDACTED]" in out


def test_unquoted_key_value_assignment_is_redacted():
    out = decisions.redact("export DB_PASSWORD=hunter2scribe run it")
    assert "hunter2scribe" not in out
    assert "DB_PASSWORD=<redacted>" in out


def test_unquoted_star_key_value_assignment_is_redacted():
    out = decisions.redact("OPENAI_API_KEY=sk-nope123456 no echo")
    assert "sk-nope123456" not in out
    assert "OPENAI_API_KEY=<redacted>" in out


def test_quoted_key_value_assignment_is_redacted():
    out = decisions.redact('password="short1" api_key = "%s"' % _LONG_QUOTED)
    assert "short1" not in out
    assert _LONG_QUOTED not in out


def test_cli_password_flag_value_is_redacted():
    out = decisions.redact("pg_dump --password hunter2secret --host db")
    assert "hunter2secret" not in out
    assert "--password <redacted>" in out


def test_cli_password_flag_equals_form_is_redacted():
    out = decisions.redact("curl --password=topsecretpw https://host")
    assert "topsecretpw" not in out
    assert "--password=<redacted>" in out


def test_authorization_bearer_header_is_redacted():
    out = decisions.redact("Authorization: Bearer %s send" % _BEARER)
    assert _BEARER not in out
    assert "Authorization: Bearer <redacted>" in out


def test_benign_commands_are_not_mangled():
    text = "systemctl restart web-app && grep -R token /var/log"
    assert decisions.redact(text) == text


def test_redact_never_raises_and_honours_limit():
    assert decisions.redact("") == ""
    assert decisions.redact(None) == ""
    out = decisions.redact("x" * 500, limit=10)
    assert len(out) == 10


def test_log_writes_the_redacted_head(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_DECIDE_LOG", str(tmp_path / "d.jsonl"))
    decisions._cfg_cache = None
    assert decisions.log(agent="t", event="e", decision_id="D7",
                         text="PASSWORD=hunter2secret") is True
    line = json.loads((tmp_path / "d.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert "hunter2secret" not in line["text_head"]
    assert "<redacted>" in line["text_head"]


def test_log_records_reason_only_when_given(tmp_path):
    """G2 2026-10-02: an abstaining head must say why, so D1 triage is one query."""
    log = tmp_path / "decisions.jsonl"
    assert decisions.log("claude", "UserPromptSubmit", "D1", "domain", None, 0.3, 0.1,
                         "log", "log", 1.0, "hello", path=str(log), reason="below_threshold")
    assert decisions.log("claude", "PreToolUse", "D8", "tier_c:x", "rm", 1.0, 0.0,
                         "block", "ask", 1.0, "rm -rf x", path=str(log))
    rows = [json.loads(line) for line in log.read_text().splitlines()]
    assert rows[0]["reason"] == "below_threshold"
    assert "reason" not in rows[1]


def test_eval_harness_logs_outside_the_production_file(tmp_path):
    """I-14: importing eval/eval.py moves the decision log off decisions.jsonl,
    unless the caller chose a LOCAL_DECIDE_LOG. Runs in a child: nothing is written."""
    import subprocess

    eval_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval")
    code = ("import sys; sys.path.insert(0, %r); import eval as ev, decisions; "
            "print(ev.EVAL_DECISIONS_LOG); print(decisions.retention_config()['path'])" % eval_dir)
    env = {k: v for k, v in os.environ.items() if k != "LOCAL_DECIDE_LOG"}

    def run():
        return subprocess.run([sys.executable, "-c", code], env=env, cwd=str(tmp_path),
                              capture_output=True, text=True, check=True).stdout.split()

    eval_log, used = run()
    assert used == eval_log
    assert eval_log != decisions.DEFAULT_RETENTION["path"]
    root = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(os.path.dirname(eval_dir))
    assert eval_log.startswith(os.path.join(root, "state", "local-decide") + os.sep)
    env["LOCAL_DECIDE_LOG"] = str(tmp_path / "mine.jsonl")
    assert run()[1] == str(tmp_path / "mine.jsonl")
