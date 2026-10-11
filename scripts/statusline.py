#!/usr/bin/env python3
"""WO-6 cost visibility: Claude Code statusLine script.

Reads the statusLine JSON from stdin and prints ONE line:
  <model> · <ctx%> · <today's tokens>
- ctx% = transcript context usage (last usage entry: input + cache_read +
  cache_creation) vs a 300k window.
- today's tokens come from the router's usage log, cached 30 s in /var/tmp/claude
  so frequent redraws stay well under 100 ms.
Any failure degrades to printing the model name only, exit 0 (never break the UI).
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1])
USAGE_LOG = ROOT / "state" / "router-usage.jsonl"
CACHE = Path("/var/tmp/claude/statusline-today.json")
CTX_WINDOW = 300_000
CACHE_TTL_S = 30
TAIL_BYTES = 65536
USAGE_TAIL_BYTES = 2 * 1024 * 1024


def last_context(transcript_path):
    if not transcript_path:
        return None
    p = Path(transcript_path)
    size = p.stat().st_size
    with p.open("rb") as fh:
        fh.seek(max(0, size - TAIL_BYTES))
        tail = fh.read().decode("utf-8", "replace")
    for line in reversed(tail.splitlines()):
        if '"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        msg = entry.get("message") if isinstance(entry.get("message"), dict) else {}
        usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else entry.get("usage")
        if isinstance(usage, dict):
            tot = 0
            for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                v = usage.get(k)
                if isinstance(v, (int, float)):
                    tot += v
            if tot > 0:
                return tot
    return None


def today_tokens():
    today = datetime.now(timezone.utc).astimezone().date().isoformat()
    try:
        cached = json.loads(CACHE.read_text("utf-8"))
        if cached.get("date") == today and time.time() - cached.get("ts", 0) < CACHE_TTL_S:
            return cached["total"]
    except Exception:
        pass
    total = 0
    try:
        # read only the LAST 2 MB (seek from end) — today's lines are at the tail
        # and the file can grow without bound
        with USAGE_LOG.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - USAGE_TAIL_BYTES))
            tail = fh.read().decode("utf-8", "replace")
        lines = tail.splitlines()
        if size > USAGE_TAIL_BYTES and lines:
            lines = lines[1:]  # first line is a partial cut
        for line in lines:
            if '"ts"' not in line:
                continue
            try:
                rec = json.loads(line)
                dt = datetime.fromisoformat(str(rec.get("ts", "")).replace("Z", "+00:00")).astimezone()
                if dt.date().isoformat() != today:
                    continue
                for f in ("input", "output", "cache_read", "cache_creation"):
                    v = rec.get(f)
                    if isinstance(v, (int, float)) and v >= 0:
                        total += v
            except Exception:
                continue
    except OSError:
        return None
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps({"date": today, "ts": time.time(), "total": total}), "utf-8")
    except Exception:
        pass
    return total


def fmt_tok(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else (f"{n / 1e3:.0f}k" if n >= 1000 else str(n))


FALLBACK_STATE = Path("/run/claude-router/fallback-state.json")
FALLBACK_FRESH_S = 900  # badge shows for 15 min after the last fallback-served main-lane response
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}")


def fallback_badge():
    """R4 (2026-10-10): the router writes this file when the MAIN lane was served by a
    fallback model; Claude Code's own label always shows the SELECTED model, so this is
    the only truthful 'actually running on' signal. Any failure hides the badge."""
    try:
        st = json.loads(FALLBACK_STATE.read_text("utf-8"))
        at = datetime.fromisoformat(str(st.get("at", "")).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - at).total_seconds()
        if not -60 <= age <= FALLBACK_FRESH_S:  # stale, or future-dated (clock skew / tampering)
            return None
        model = str(st.get("model") or "").strip()
        if not MODEL_RE.fullmatch(model):  # never paint arbitrary file content into the terminal
            return None
        return f"actually {model} (router fallback)"
    except Exception:
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    model = "Claude"
    try:
        m = data.get("model") or {}
        model = str(m.get("display_name") or m.get("id") or "Claude")
    except Exception:
        pass
    try:
        parts = [model]
        badge = fallback_badge()
        if badge:
            parts.append(f"⚠ {badge}")
        ctx = last_context(data.get("transcript_path"))
        if ctx:
            parts.append(f"ctx {min(999, round(ctx * 100 / CTX_WINDOW))}%")
        tok = today_tokens()
        if tok is not None:
            parts.append(f"{fmt_tok(tok)} today")
        print(" · ".join(parts))
    except Exception:
        print(model)
    return 0


if __name__ == "__main__":
    sys.exit(main())
