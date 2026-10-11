"""PreCompact hook: template output, compaction counting, ledger anchoring."""
import os

from conftest import compacted_transcript, load_hook, run_hook

precompact = load_hook("precompact-recite.py")


def test_zero_compactions_no_fresh_session_recommendation(tmp_path):
    transcript = compacted_transcript(tmp_path / "t0.jsonl", 0)
    code, out, _ = run_hook("precompact-recite.py", {"transcript_path": transcript})
    assert code == 0
    assert "COMPACTION INSTRUCTIONS" in out
    assert "OWNER VERBATIM" in out
    assert "FRESH session" not in out


def test_four_compactions_recommends_fresh_session(tmp_path):
    transcript = compacted_transcript(tmp_path / "t4.jsonl", 4)
    code, out, _ = run_hook("precompact-recite.py", {"transcript_path": transcript})
    assert code == 0
    assert "COMPACTION LOAD WARNING" in out
    assert "4 prior compaction summaries" in out
    assert "start a FRESH session" in out
    assert "on-disk ledger" in out


def test_count_prior_compactions_direct():
    assert precompact.count_prior_compactions(__file__) == 0


def test_ledger_path_mention_lists_file_and_tail(tmp_path):
    ledger = tmp_path / "TASK-LEDGER.md"
    ledger.write_text("\n".join(f"ledger line {i}" for i in range(1, 41)) + "\n", encoding="utf-8")
    transcript = compacted_transcript(tmp_path / "t.jsonl", 0)
    with open(transcript, "a", encoding="utf-8") as fh:
        fh.write('{"type": "assistant", "message": {"content": "updated ' + str(ledger) + '"}}\n')
    code, out, _ = run_hook("precompact-recite.py", {"transcript_path": transcript})
    assert code == 0
    assert str(ledger) in out
    assert "STATE FILES TOUCHED" in out
    assert "ledger line 40" in out  # tail included


def test_progress_file_matched_by_ledger_re(tmp_path):
    progress = tmp_path / "state" / "progress-mytask.md"
    progress.parent.mkdir()
    progress.write_text("step: done\n", encoding="utf-8")
    transcript = compacted_transcript(tmp_path / "t.jsonl", 0)
    with open(transcript, "a", encoding="utf-8") as fh:
        fh.write('{"type": "assistant", "message": {"content": "checkpoint at ' + str(progress) + '"}}\n')
    paths = precompact.touched_ledgers(transcript)
    assert str(progress) in paths


def test_missing_transcript_still_prints_template():
    code, out, _ = run_hook("precompact-recite.py", {"transcript_path": "/nonexistent/x.jsonl"})
    assert code == 0
    assert "COMPACTION INSTRUCTIONS" in out


def test_bad_stdin_never_fails():
    import subprocess
    import sys

    proc = subprocess.run(
        [sys.executable, os.path.join(precompact.__file__)],
        input=b"not-json",
        capture_output=True,
        timeout=10,
    )
    assert proc.returncode == 0
    assert b"COMPACTION INSTRUCTIONS" in proc.stdout
