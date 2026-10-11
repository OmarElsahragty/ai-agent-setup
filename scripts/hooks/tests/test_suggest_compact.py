"""suggest-compact PreToolUse hook tests: one-shot compaction nudge with +40k re-fire gate."""
import json
import os
import time

from conftest import run_hook, write_transcript


def _usage_entry(total):
    return {"type": "assistant", "message": {
        "role": "assistant",
        "content": [{"type": "text", "text": "ok"}],
        "usage": {"input_tokens": 1000,
                  "cache_read_input_tokens": max(0, total - 1000),
                  "cache_creation_input_tokens": 0}}}


def _payload(session_id, transcript):
    return {"tool_name": "Bash", "tool_input": {"command": "ls"},
            "session_id": session_id, "transcript_path": transcript}


def _state_dir(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir(exist_ok=True)
    monkeypatch.setenv("SUGGEST_COMPACT_STATE_DIR", str(state))
    return state


def test_at_230k_one_suggestion_then_240k_silent(tmp_path, monkeypatch):
    _state_dir(tmp_path, monkeypatch)
    tr1 = write_transcript(tmp_path / "t1.jsonl", [_usage_entry(230_000)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s1", tr1))
    assert code == 0
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "230k/300k" in ctx and "/compact" in ctx and "checkpoint" in ctx
    tr2 = write_transcript(tmp_path / "t2.jsonl", [_usage_entry(240_000)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s1", tr2))
    assert code == 0 and out == ""  # not yet +40k: no re-fire


def test_below_threshold_silent(tmp_path, monkeypatch):
    _state_dir(tmp_path, monkeypatch)
    tr = write_transcript(tmp_path / "t.jsonl", [_usage_entry(150_000)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s2", tr))
    assert code == 0 and out == ""


def test_refires_after_plus_40k(tmp_path, monkeypatch):
    _state_dir(tmp_path, monkeypatch)
    tr1 = write_transcript(tmp_path / "t1.jsonl", [_usage_entry(220_000)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s3", tr1))
    assert code == 0 and out != ""
    tr2 = write_transcript(tmp_path / "t2.jsonl", [_usage_entry(250_000)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s3", tr2))
    assert code == 0 and out == ""  # 250k < 220k + 40k
    tr3 = write_transcript(tmp_path / "t3.jsonl", [_usage_entry(260_500)])
    code, out, _ = run_hook("suggest-compact.py", _payload("s3", tr3))
    assert code == 0 and out != ""  # >= 260k fires again


def test_state_swept_after_14_days(tmp_path, monkeypatch):
    state = _state_dir(tmp_path, monkeypatch)
    stale = state / "suggest-compact-old.json"
    stale.write_text(json.dumps({"fired": 220000, "ts": 0}), encoding="utf-8")
    old = time.time() - 20 * 24 * 3600
    os.utime(stale, (old, old))
    tr = write_transcript(tmp_path / "t.jsonl", [_usage_entry(150_000)])
    code, _, _ = run_hook("suggest-compact.py", _payload("fresh", tr))
    assert code == 0
    assert not stale.exists()


def test_missing_transcript_silent(tmp_path, monkeypatch):
    _state_dir(tmp_path, monkeypatch)
    code, out, _ = run_hook("suggest-compact.py", _payload("s4", str(tmp_path / "nope.jsonl")))
    assert code == 0 and out == ""
