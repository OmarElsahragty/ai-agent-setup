"""gateguard PreToolUse hook tests: warn-only nudge for never-read existing files."""
import json

from conftest import run_hook, write_transcript


def _edit(target, transcript):
    return {"tool_name": "Edit", "transcript_path": transcript,
            "tool_input": {"file_path": str(target), "old_string": "a", "new_string": "b"}}


def _read_entry(target):
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": str(target)}}]}}


def _bash_entry(command):
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": command}}]}}


def _plain_entry():
    return {"type": "user", "message": {"role": "user", "content": "please edit the file"}}


def test_unread_existing_file_warns_but_never_denies(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    transcript = write_transcript(tmp_path / "tr.jsonl", [_plain_entry()])
    code, out, _ = run_hook("gateguard.py", _edit(target, transcript))
    assert code == 0
    spec = json.loads(out)["hookSpecificOutput"]
    assert spec.get("permissionDecision") is None  # warn only, never a deny
    ctx = spec["additionalContext"]
    assert ctx.startswith("GATEGUARD:")
    assert str(target) in ctx


def test_read_tool_counts_as_read(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    transcript = write_transcript(tmp_path / "tr.jsonl", [_read_entry(target)])
    code, out, _ = run_hook("gateguard.py", _edit(target, transcript))
    assert code == 0 and out == ""


def test_own_earlier_write_counts_as_read(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    entry = {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t3", "name": "Write",
         "input": {"file_path": str(target), "content": "x = 1\n"}}]}}
    transcript = write_transcript(tmp_path / "tr.jsonl", [entry])
    code, out, _ = run_hook("gateguard.py", _edit(target, transcript))
    assert code == 0 and out == ""


def test_bash_reference_counts(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    transcript = write_transcript(tmp_path / "tr.jsonl",
                                  [_bash_entry(f"grep -n x {target}")])
    code, out, _ = run_hook("gateguard.py", _edit(target, transcript))
    assert code == 0 and out == ""


def test_new_file_is_silent(tmp_path):
    target = tmp_path / "does-not-exist-yet.py"
    transcript = write_transcript(tmp_path / "tr.jsonl", [_plain_entry()])
    code, out, _ = run_hook("gateguard.py", _edit(target, transcript))
    assert code == 0 and out == ""


def test_missing_transcript_is_silent(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    code, out, _ = run_hook("gateguard.py", _edit(target, str(tmp_path / "nope.jsonl")))
    assert code == 0 and out == ""


def test_other_tool_names_ignored(tmp_path):
    target = tmp_path / "t.py"
    target.write_text("x = 1\n", encoding="utf-8")
    transcript = write_transcript(tmp_path / "tr.jsonl", [_plain_entry()])
    code, out, _ = run_hook("gateguard.py",
                            {"tool_name": "Bash", "transcript_path": transcript,
                             "tool_input": {"command": "ls", "file_path": str(target)}})
    assert code == 0 and out == ""
