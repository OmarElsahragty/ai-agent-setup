#!/usr/bin/env python3
"""PreToolUse hook (any tool): one-shot nudge to compact before the context window fills.

Reads the LATEST assistant usage block in the transcript tail (input + cache_read +
cache_creation). At >= 220k it emits a single additionalContext suggestion; it re-fires only
after a further +40k (state file /var/tmp/claude/suggest-compact-<session_id>.json). State
files older than 14 days are swept. Cheap: one bounded tail read, one tiny state file.
Fails open on any error; stdlib only.
"""
import glob
import json
import os
import re
import sys
import time

THRESHOLD = 220_000
REFIRE_STEP = 40_000
TAIL_BYTES = 1024 * 1024
STATE_DIR = os.environ.get("SUGGEST_COMPACT_STATE_DIR", "/var/tmp/claude")
STATE_PREFIX = "suggest-compact-"
SWEEP_SECONDS = 14 * 24 * 3600


def latest_usage_total(transcript_path):
    with open(transcript_path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - TAIL_BYTES))
        data = fh.read()
    lines = data.decode("utf-8", "replace").splitlines()
    if size > TAIL_BYTES and lines:
        lines = lines[1:]
    for line in reversed(lines):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") != "assistant":
            continue
        usage = (obj.get("message") or {}).get("usage")
        if isinstance(usage, dict):
            return sum(int(usage.get(k) or 0) for k in
                       ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    return 0


def state_path(session_id):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session_id or "default"))[:64] or "default"
    return os.path.join(STATE_DIR, STATE_PREFIX + sid + ".json")


def read_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
        return int(value.get("fired") or 0)
    except Exception:
        return 0


def write_state(path, total):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"fired": total, "ts": time.time()}, fh)


def sweep_old_state():
    cutoff = time.time() - SWEEP_SECONDS
    for path in glob.glob(os.path.join(STATE_DIR, STATE_PREFIX + "*.json")):
        try:
            if os.path.getmtime(path) < cutoff:
                os.unlink(path)
        except OSError:
            pass


def main():
    try:
        sweep_old_state()
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return  # non-dict JSON (list/string/number): fail open
    transcript = data.get("transcript_path")
    if not transcript or not os.path.exists(transcript):
        return
    try:
        total = latest_usage_total(transcript)
    except Exception:
        return  # fail open
    if total < THRESHOLD:
        return
    spath = state_path(data.get("session_id"))
    fired = read_state(spath)
    if total < fired + REFIRE_STEP:
        return  # already suggested at this level
    try:
        write_state(spath, total)
    except Exception:
        pass  # state is best-effort; still suggest
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "SUGGEST-COMPACT: context %dk/300k — checkpoint the ledger, then "
                             "/compact at the next phase boundary." % round(total / 1000),
    }}))


if __name__ == "__main__":
    main()
