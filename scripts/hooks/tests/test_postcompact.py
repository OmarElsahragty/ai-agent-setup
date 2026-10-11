"""PostCompact anchor hook: SessionStart (compact|resume) re-anchoring output."""
from conftest import compacted_transcript, load_hook, run_hook

postcompact = load_hook("postcompact-anchor.py")


def _transcript_mentioning(tmp_path, target):
    transcript = compacted_transcript(tmp_path / "t.jsonl", 2)
    with open(transcript, "a", encoding="utf-8") as fh:
        fh.write('{"type": "assistant", "message": {"content": "wrote ' + str(target) + '"}}\n')
    return transcript


def test_prints_head_paths_and_tail(tmp_path):
    ledger = tmp_path / "BIGTASK-LEDGER.md"
    ledger.write_text("\n".join(f"row {i}" for i in range(1, 51)) + "\n", encoding="utf-8")
    transcript = _transcript_mentioning(tmp_path, ledger)
    code, out, _ = run_hook("postcompact-anchor.py", {"transcript_path": transcript, "source": "compact"})
    assert code == 0
    assert "After compaction: re-read these files before acting:" in out
    assert str(ledger) in out
    assert "--- last 15 lines of" in out
    assert "row 50" in out      # last line of the ledger
    assert "row 35" not in out   # only the last 15 lines (36..50)
    assert len(out.encode()) <= 3 * 1024


def test_no_touched_files_prints_nothing(tmp_path):
    transcript = compacted_transcript(tmp_path / "t.jsonl", 0)
    code, out, _ = run_hook("postcompact-anchor.py", {"transcript_path": transcript})
    assert code == 0
    assert out == ""


def test_missing_transcript_prints_nothing():
    code, out, _ = run_hook("postcompact-anchor.py", {"transcript_path": "/nonexistent/x.jsonl"})
    assert code == 0
    assert out == ""


def test_output_capped_at_3kb(tmp_path):
    ledger = tmp_path / "HUGE-LEDGER.md"
    ledger.write_text("\n".join("x" * 300 for _ in range(200)) + "\n", encoding="utf-8")
    transcript = _transcript_mentioning(tmp_path, ledger)
    code, out, _ = run_hook("postcompact-anchor.py", {"transcript_path": transcript})
    assert code == 0
    assert 0 < len(out.encode()) <= 3 * 1024
    assert out.endswith("\n")


def test_progress_file_anchored(tmp_path):
    progress = tmp_path / "state" / "progress-anchors.md"
    progress.parent.mkdir()
    progress.write_text("done: step 1\nnext: step 2\n", encoding="utf-8")
    transcript = _transcript_mentioning(tmp_path, progress)
    code, out, _ = run_hook("postcompact-anchor.py", {"transcript_path": transcript, "source": "resume"})
    assert code == 0
    assert str(progress) in out
    assert "next: step 2" in out


def test_touched_ledgers_most_recent_first(tmp_path):
    old = tmp_path / "OLD-LEDGER.md"
    new = tmp_path / "NEW-LEDGER.md"
    old.write_text("old\n", encoding="utf-8")
    new.write_text("new\n", encoding="utf-8")
    transcript = compacted_transcript(tmp_path / "t.jsonl", 0)
    with open(transcript, "a", encoding="utf-8") as fh:
        fh.write('{"content": "see ' + str(old) + '"}\n')
        fh.write('{"content": "see ' + str(new) + '"}\n')
    paths = postcompact.touched_ledgers(transcript)
    assert paths[0] == str(new)


def test_fallback_ledger_re_matches_precompact_source():
    """The fallback copy in postcompact-anchor.py must never drift from precompact-recite.py."""
    import re
    from pathlib import Path

    here = Path(__file__).resolve().parent.parent
    pattern = re.compile(r'LEDGER_RE = re\.compile\((r"[^"]+")\)')
    fallback = re.search(r'return re\.compile\((r"[^"]+")\)', (here / "postcompact-anchor.py").read_text())
    source = pattern.search((here / "precompact-recite.py").read_text())
    assert fallback and source
    assert fallback.group(1) == source.group(1)
