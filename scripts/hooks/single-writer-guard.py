#!/usr/bin/env python3
"""SessionStart / UserPromptSubmit / PreToolUse hook: one writer session at a time.

Owner directive 2026-10-09 (R-DATA-16D): while a long-running dataset job holds the writer lease, the session
named in the lock is the ONLY session; any other interactive Claude Code session is
blocked and closed as soon as it starts, gets a prompt or tries a tool. CloudCLI can
run two claude.exe processes that resume the SAME conversation, so the lock keys on
the claude.exe PID, not the session id. A dead lock PID is adopted only by the same
session id (CloudCLI restarting the owning conversation). Headless helper calls
(`claude -p` / `--print`) are exempt. No lock file = guard off. Fails open on its
own errors, like every other hook.
"""
import json
import os
import subprocess
import sys
import time

DEFAULT_LOCK = "/var/tmp/claude/single-writer.lock"
LOCK = os.environ.get("SINGLE_WRITER_LOCK", DEFAULT_LOCK)
LOG = "/var/tmp/claude/hooks/single-writer-guard.log"
CLAUDE_NAMES = ("claude.exe", "claude")


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%F %T %Z"), msg))
    except OSError:
        pass


def ppid_of(pid):
    with open("/proc/%d/stat" % pid, encoding="utf-8") as fh:
        stat = fh.read()
    return int(stat[stat.rindex(")") + 2:].split()[1])


def comm_of(pid):
    try:
        with open("/proc/%d/comm" % pid, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def argv_of(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            return [a.decode("utf-8", "replace") for a in fh.read().split(b"\0") if a]
    except OSError:
        return []


def claude_ancestor(start=None):
    """PID of the nearest claude.exe ancestor of this hook, or None."""
    pid = start or os.getppid()
    for _ in range(8):
        if pid <= 1:
            return None
        if comm_of(pid) in CLAUDE_NAMES:
            return pid
        try:
            pid = ppid_of(pid)
        except (OSError, ValueError, IndexError):
            return None
    return None


def is_print_mode(argv):
    return any(a in ("-p", "--print") for a in argv)


def alive_claude(pid):
    return isinstance(pid, int) and pid > 1 and comm_of(pid) in CLAUDE_NAMES


def decide(lock, my_pid, session_id):
    """Return (allow: bool, adopt: bool)."""
    owner = lock.get("pid")
    if owner == my_pid:
        return True, False
    if alive_claude(owner):
        return False, False
    if session_id and session_id == lock.get("session_id"):
        return True, True
    return False, False


def write_lock(lock):
    tmp = LOCK + ".tmp-%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(lock, fh)
    os.replace(tmp, LOCK)


def block(event, reason, my_pid):
    if event == "PreToolUse":
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                      "permissionDecision": "deny",
                                      "permissionDecisionReason": reason}}
    elif event == "UserPromptSubmit":
        out = {"decision": "block", "reason": reason}
    else:
        out = {"hookSpecificOutput": {"hookEventName": event, "additionalContext": reason}}
    print(json.dumps(out))
    sys.stdout.flush()
    if os.environ.get("SINGLE_WRITER_NO_KILL") != "1":
        subprocess.Popen(["/bin/sh", "-c", "sleep 2; kill -TERM %d" % my_pid],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    try:
        with open(LOCK, encoding="utf-8") as fh:
            lock = json.load(fh)
    except FileNotFoundError:
        return
    except (OSError, ValueError) as exc:
        log("FAIL-OPEN unreadable lock: %s" % exc)
        return
    if not isinstance(lock, dict):
        log("FAIL-OPEN lock is not an object")
        return
    # test override only honoured together with a non-default lock path (W1 review:
    # a session started with SINGLE_WRITER_SELF_PID must not impersonate the owner)
    test_pid = os.environ.get("SINGLE_WRITER_SELF_PID") if LOCK != DEFAULT_LOCK else None
    my_pid = int(test_pid or 0) or claude_ancestor()
    if my_pid is None or is_print_mode(argv_of(my_pid)):
        return
    session_id = data.get("session_id") or ""
    allow, adopt = decide(lock, my_pid, session_id)
    if adopt:
        log("ADOPT pid %s -> %d session=%s" % (lock.get("pid"), my_pid, session_id))
        lock["pid"] = my_pid
        lock["adopted_at"] = time.strftime("%FT%T%z")
        write_lock(lock)
    if allow:
        return
    event = data.get("hook_event_name") or "PreToolUse"
    reason = ("CLOSED by owner rule R-DATA-16D: session '%s' (pid %s) is the ONLY session allowed "
              "while a long-running dataset job holds the writer lease. This session (pid %d) is blocked and will exit. "
              "Owner kill switch: rm %s" % (lock.get("label", "?"), lock.get("pid"), my_pid, LOCK))
    log("BLOCK event=%s pid=%d session=%s owner=%s" % (event, my_pid, session_id, lock.get("pid")))
    block(event, reason, my_pid)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never break a session on a guard bug
        log("FAIL-OPEN %r" % exc)
