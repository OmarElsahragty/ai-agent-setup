"""post-edit-check PostToolUse hook tests: warn-only syntax checks by extension."""
import json

from conftest import run_hook


def _hook(target):
    return {"tool_name": "Write", "tool_input": {"file_path": str(target)},
            "tool_response": {"success": True}}


def test_broken_python_warns(tmp_path):
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n", encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(bad))
    assert code == 0
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert str(bad) in ctx
    assert "py_compile" in ctx or "SyntaxError" in ctx


def test_negative_control_valid_python_silent(tmp_path):
    good = tmp_path / "good.py"
    good.write_text("x = 1\nprint(x * 2)\n", encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(good))
    assert code == 0 and out == ""


def test_broken_json_warns(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"a": ', encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(bad))
    assert code == 0
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "json.load" in ctx


def test_valid_json_silent(tmp_path):
    good = tmp_path / "good.json"
    good.write_text('{"a": 1}\n', encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(good))
    assert code == 0 and out == ""


def test_broken_shell_warns(tmp_path):
    bad = tmp_path / "bad.sh"
    bad.write_text("if [ x\nthen\n", encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(bad))
    assert code == 0
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "bash -n" in ctx


def test_error_output_capped_at_20_lines(tmp_path):
    bad = tmp_path / "many.py"
    bad.write_text("\n".join(f"def broken_{i}(:" for i in range(60)) + "\n", encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(bad))
    assert code == 0
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert len([ln for ln in ctx.splitlines() if ln.strip()]) <= 22  # header + 20 error lines


def test_oversized_file_skipped(tmp_path):
    big = tmp_path / "big.py"
    big.write_text("# padding\n" + "x" * (3 * 1024 * 1024), encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(big))
    assert code == 0 and out == ""


def test_unknown_extension_silent(tmp_path):
    doc = tmp_path / "notes.md"
    doc.write_text("just text\n", encoding="utf-8")
    code, out, _ = run_hook("post-edit-check.py", _hook(doc))
    assert code == 0 and out == ""
