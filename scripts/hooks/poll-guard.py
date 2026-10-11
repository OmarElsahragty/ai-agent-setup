#!/usr/bin/env python3
"""PreToolUse hook (Bash): deny the 6th identical command within 10 minutes in one transcript (M-045).

Issue sweep I-09 (2026-10-10): a subagent ran the identical `cat .../tasks/<id>.output; tail ...`
87 times (a 54-minute hang) while polling a background task; 26 other transcripts repeated one
call 5-14 times. HARD RULE 6 bans poll loops, and the D18 foreground-sleep rule only sees `sleep`.

A command counts as identical after its whitespace is collapsed, in the same working directory,
in the same transcript (session_id + agent_id; the main thread is "main"). The first 5 runs in
any 10-minute window pass; the 6th and later are denied until the oldest run ages out. Denied
attempts are not recorded, so retrying never extends the window. Test runners are not exempt:
six identical test runs in ten minutes are a poll too. A call with run_in_background=true is
neither counted nor denied (it is the remedy). State is one small JSON file per transcript under
POLL_GUARD_STATE_DIR (default /var/tmp/claude/poll-guard), flock-serialized; files idle for a
day are swept when a new transcript starts. Stdlib only; fails open on any error.

Edit-test loops are not polls (orchestrator ruling 2026-10-10): an Edit, Write or MultiEdit
payload in a transcript clears that transcript's counts (an existing state file is emptied, a
missing one is never created). Registration therefore needs matcher `Bash|Edit|Write|MultiEdit`
(PreToolUse; a PostToolUse `Edit|Write|MultiEdit` entry also works and resets only after the edit ran).
"""
import fcntl
import hashlib
import json
import os
import sys
import time

STATE_DIR = os.environ.get("POLL_GUARD_STATE_DIR", "/var/tmp/claude/poll-guard")
WINDOW_S = 600
MAX_RUNS = 5           # identical runs allowed per window; the next one is denied
MAX_ENTRIES = 400      # newest runs kept per transcript file
SWEEP_AGE_S = 86400
SWEEP_MAX_FILES = 2000
RESET_TOOLS = ("Edit", "Write", "MultiEdit")

REASON = ("poll-guard: BLOCKED. This exact command already ran {n} times in the last 10 minutes in "
          "this transcript, so running it again is a poll loop (HARD RULE 6). Wait instead: start ONE "
          "Bash call with run_in_background=true whose command ends on the condition you are waiting "
          "for (for example `until grep -q DONE out.log; do sleep 5; done`, or `tail --pid=<pid> -f "
          "/dev/null`), then end your turn and act on its completion notification. Run a different "
          "command only when you need different information.")


def normalize(command):
    """The identity of a command: whitespace runs collapsed, ends trimmed."""
    return " ".join(str(command).split())


def transcript_key(data):
    """One key per transcript: session_id + agent_id ("main" for the main thread).

    Falls back to transcript_path when there is no session id; None when neither exists.
    """
    session = str(data.get("session_id") or data.get("transcript_path") or "")
    if not session:
        return None
    agent = str(data.get("agent_id") or "") or "main"
    return hashlib.sha256(("%s\0%s" % (session, agent)).encode("utf-8", "replace")).hexdigest()[:40]


def command_hash(command, cwd):
    return hashlib.sha256(("%s\0%s" % (cwd, normalize(command))).encode("utf-8", "replace")).hexdigest()[:32]


def _load(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw.strip():
        return []
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        return []  # a torn or corrupt file restarts the count instead of disabling the guard
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, list) and len(e) == 2
            and isinstance(e[0], (int, float)) and isinstance(e[1], str)]


def _store(fd, entries):
    payload = json.dumps(entries, separators=(",", ":")).encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, payload)


def _sweep(state_dir, keep, now):
    """Remove transcript files idle for a day (bounded listing; errors ignored)."""
    try:
        with os.scandir(state_dir) as it:
            for n, entry in enumerate(it):
                if n >= SWEEP_MAX_FILES:
                    break
                if entry.name == keep or not entry.name.endswith(".json"):
                    continue
                try:
                    if now - entry.stat().st_mtime > SWEEP_AGE_S:
                        os.unlink(entry.path)
                except OSError:
                    continue
    except OSError:
        pass


def reset(data, state_dir=None):
    """An Edit/Write/MultiEdit in this transcript clears its counts; never creates a state file."""
    key = transcript_key(data)
    if key is None:
        return
    try:
        fd = os.open(os.path.join(state_dir or STATE_DIR, key + ".json"), os.O_RDWR)
    except OSError:
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _store(fd, [])
    finally:
        os.close(fd)


def check(data, now=None, state_dir=None):
    """Deny reason for this PreToolUse payload, or None to allow. Records allowed runs."""
    if not isinstance(data, dict):
        return None
    if data.get("tool_name") in RESET_TOOLS:
        reset(data, state_dir)
        return None
    if data.get("tool_name") != "Bash":
        return None
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str) or not normalize(command):
        return None
    if tool_input.get("run_in_background") is True:
        return None
    key = transcript_key(data)
    if key is None:
        return None
    now = time.time() if now is None else float(now)
    state_dir = state_dir or STATE_DIR
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    name = key + ".json"
    path = os.path.join(state_dir, name)
    digest = command_hash(command, str(data.get("cwd") or ""))
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        fresh = os.fstat(fd).st_size == 0
        entries = [e for e in _load(fd) if now - e[0] < WINDOW_S]
        runs = sum(1 for e in entries if e[1] == digest)
        if runs >= MAX_RUNS:
            _store(fd, entries)
            return REASON.format(n=runs)
        entries.append([now, digest])
        _store(fd, entries[-MAX_ENTRIES:])
    finally:
        os.close(fd)
    if fresh:
        _sweep(state_dir, name, now)
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    try:
        reason = check(data)
    except Exception:
        return  # fail open: a guard bug must never block the command
    if reason:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))


if __name__ == "__main__":
    main()
