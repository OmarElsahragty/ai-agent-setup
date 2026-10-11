#!/usr/bin/env python3
"""SessionStart hook (matcher compact|resume): re-anchor the session on disk state after compaction.

SessionStart stdout is injected into the fresh context. After a compaction (or resume) this prints the
ledger/plan/progress files the transcript actually touched, plus the tail of the most recent one, so the
session re-reads disk state instead of trusting the summary. Gating (which matchers run it) lives in
sync-claude-config.py. Never fails: any error prints nothing and exits 0. Output is capped at 3 KB.
LEDGER_RE is imported from precompact-recite.py so both hooks share one pattern.
"""
import json
import os
import sys

HEAD = "After compaction: re-read these files before acting:"
MAX_FILES = 3
TAIL_LINES = 15
MAX_BYTES = 3 * 1024
TAIL_BYTES = 4 * 1024 * 1024


def _ledger_re():
    try:
        import importlib.util

        src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "precompact-recite.py")
        spec = importlib.util.spec_from_file_location("precompact_recite", src)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.LEDGER_RE
    except Exception:
        import re

        # Fallback: keep byte-identical with precompact-recite.py LEDGER_RE.
        return re.compile(r"(/[\w.\-/]+/(?:[\w.\-]*LEDGER[\w.\-]*\.md|plans/[\w.\-]+\.md|STATUS[\w.\-]*\.md|[\w.\-]*progress-[\w.\-]*\.md))")


LEDGER_RE = _ledger_re()


def touched_ledgers(transcript_path):
    with open(transcript_path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - TAIL_BYTES))
        text = fh.read().decode("utf-8", "replace")
    seen = []
    for match in LEDGER_RE.finditer(text):
        path = match.group(1)
        if path in seen:
            seen.remove(path)
        seen.append(path)  # most recent mention last
    return [p for p in reversed(seen) if os.path.isfile(p)][:MAX_FILES]


def _cap(text):
    data = text.encode("utf-8", "replace")
    if len(data) <= MAX_BYTES:
        return text
    data = data[:MAX_BYTES]
    cut = data.rfind(b"\n")
    if cut > 0:
        data = data[:cut]
    return data.decode("utf-8", "replace") + "\n"


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(payload, dict):
        return  # non-dict JSON (list/string/number): fail open
    paths = touched_ledgers(payload.get("transcript_path") or "")
    if not paths:
        return
    parts = [HEAD]
    parts.extend(f"- {path}" for path in paths)
    most_recent = paths[0]
    try:
        with open(most_recent, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()[-TAIL_LINES:]
    except OSError:
        lines = []
    if lines:
        parts.append(f"--- last {len(lines)} lines of {most_recent} ---")
        parts.extend(lines)
    sys.stdout.write(_cap("\n".join(parts) + "\n"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
