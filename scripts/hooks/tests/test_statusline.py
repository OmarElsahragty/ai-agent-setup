"""statusline today-token accounting: only the LAST 2 MB of router-usage.jsonl is
read (seek from end); today's lines inside the window are summed, everything
older (or beyond the window) is ignored."""
import json
from datetime import datetime, timedelta, timezone

from conftest import load_hook

statusline = load_hook("statusline.py")


def _rec(ts, total):
    return json.dumps({"ts": ts, "input": total, "output": 0,
                       "cache_read": 0, "cache_creation": 0})


def _filler(ts, size):
    return json.dumps({"ts": ts, "input": 0, "note": "x" * size})


def test_today_tokens_reads_only_last_2mb(tmp_path, monkeypatch):
    log = tmp_path / "router-usage.jsonl"
    cache = tmp_path / "statusline-today.json"
    monkeypatch.setattr(statusline, "USAGE_LOG", log)
    monkeypatch.setattr(statusline, "CACHE", cache)
    now = datetime.now(timezone.utc).astimezone()
    old = (now - timedelta(days=3)).isoformat()
    today = now.isoformat()
    lines = [_rec(today, 10_000_000)]  # today, but pushed out of the 2 MB window
    while sum(len(l) for l in lines) < statusline.USAGE_TAIL_BYTES + 64 * 1024:
        lines.append(_filler(old, 200))
    lines.extend([_rec(today, 100) for _ in range(3)])  # today, inside the window
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert log.stat().st_size > statusline.USAGE_TAIL_BYTES
    assert statusline.today_tokens() == 300  # the 10M record is beyond the tail
    # cached second read returns the same total without re-reading
    assert statusline.today_tokens() == 300
    assert json.loads(cache.read_text("utf-8"))["total"] == 300


def test_today_tokens_small_file_counts_everything(tmp_path, monkeypatch):
    log = tmp_path / "router-usage.jsonl"
    monkeypatch.setattr(statusline, "USAGE_LOG", log)
    monkeypatch.setattr(statusline, "CACHE", tmp_path / "statusline-today.json")
    now = datetime.now(timezone.utc).astimezone()
    lines = [_rec((now - timedelta(days=1)).isoformat(), 7),   # yesterday: ignored
             _rec(now.isoformat(), 5), _rec(now.isoformat(), 6)]
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert log.stat().st_size < statusline.USAGE_TAIL_BYTES
    assert statusline.today_tokens() == 11


def test_today_tokens_missing_log_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(statusline, "USAGE_LOG", tmp_path / "nope.jsonl")
    monkeypatch.setattr(statusline, "CACHE", tmp_path / "statusline-today.json")
    assert statusline.today_tokens() is None


def _badge(tmp_path, monkeypatch, state):
    f = tmp_path / "fallback-state.json"
    if state is not None:
        f.write_text(state if isinstance(state, str) else json.dumps(state), "utf-8")
    monkeypatch.setattr(statusline, "FALLBACK_STATE", f)
    return statusline.fallback_badge()


def _at(delta_s):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).isoformat()


def test_fallback_badge_fresh_shows_real_model(tmp_path, monkeypatch):
    assert _badge(tmp_path, monkeypatch, {"model": "deepseek-v4.1-flash", "at": _at(-10)}) == "actually deepseek-v4.1-flash (router fallback)"


def test_fallback_badge_hidden_when_missing_stale_future_or_corrupt(tmp_path, monkeypatch):
    assert _badge(tmp_path, monkeypatch, None) is None
    assert _badge(tmp_path, monkeypatch, {"model": "deepseek-v4.1-flash", "at": _at(-901)}) is None
    assert _badge(tmp_path, monkeypatch, {"model": "deepseek-v4.1-flash", "at": _at(3600)}) is None
    assert _badge(tmp_path, monkeypatch, "{not json") is None
    assert _badge(tmp_path, monkeypatch, {"model": "", "at": _at(-10)}) is None


def test_fallback_badge_rejects_terminal_escape_in_model(tmp_path, monkeypatch):
    assert _badge(tmp_path, monkeypatch, {"model": "deepseek-v4.1-flash\x1b[2J", "at": _at(-10)}) is None
    assert _badge(tmp_path, monkeypatch, {"model": "claude-opus-5-5[1m]", "at": _at(-10)}) == "actually claude-opus-5-5[1m] (router fallback)"
