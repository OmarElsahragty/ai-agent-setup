#!/usr/bin/env python3
"""UserPromptSubmit hook: single-writer guard for CloudCLI-held session ids (audit H GAP-6).

A terminal `claude` prompt is BLOCKED when the CloudCLI runtime state file lists a live process
(in-turn / bg-work / retiring) holding the SAME session id — a second writer would fork the
session — unless that pid is this process or one of its ancestors (the terminal resumed its own
holder session). idle-held only warns and continues (p10 R4 waits for exit before its next spawn).
Missing or malformed state file, any error, or TERMINAL_PROMPT_GUARD_DISABLED=1 -> allow (fail
open; the hook is a guard, not a lock). The owner's stop is the CloudCLI UI or safe-restart.
"""
import json
import os
import sys

STATE_FILE = os.environ.get("CLOUDCLI_RUNTIME_STATE", "/run/cloudcli/runtime-state.json")
BUSY = ("in-turn", "bg-work", "retiring")
KILL_SWITCH = "TERMINAL_PROMPT_GUARD_DISABLED"


def _ancestors(pid):
    """Parent-pid chain of `pid` (walking /proc PPid lines); empty on any error."""
    out, cur = set(), pid
    for _ in range(64):
        try:
            with open("/proc/%d/status" % cur, "r", encoding="utf-8") as fh:
                ppid = None
                for line in fh:
                    if line.startswith("PPid:"):
                        ppid = int(line.split()[1])
                        break
        except (OSError, ValueError):
            return out
        if ppid is None or ppid <= 1 or ppid in out:
            return out
        out.add(ppid)
        cur = ppid
    return out


def verdict(payload, state_file=None, self_pid=None, ancestors=None):
    """Block reason (str) or None = allow. `payload` is the UserPromptSubmit JSON dict."""
    try:
        if not isinstance(payload, dict):
            return None
        sid = payload.get("session_id")
        if not isinstance(sid, str) or not sid:
            return None
        with open(state_file or STATE_FILE, "r", encoding="utf-8") as fh:
            entries = json.load(fh)
        if not isinstance(entries, list):
            return None
        me = self_pid if self_pid is not None else os.getpid()
        own = {me} | (set(ancestors) if ancestors is not None else _ancestors(me))
        for e in entries:
            if not isinstance(e, dict):
                continue
            if sid not in (e.get("providerSessionId"), e.get("appSessionId")):
                continue
            state = e.get("state")
            if state == "idle-held":
                sys.stderr.write("terminal-prompt-guard: session %s is idle-held by CloudCLI pid %s; "
                                 "continuing (the server waits for exit before its next spawn)\n"
                                 % (sid[:8], e.get("pid", "?")))
                continue
            if state not in BUSY:
                continue
            pid = e.get("pid")
            if isinstance(pid, int) and pid in own:
                continue  # this terminal IS the holder lineage
            return ("session %s is held by a live CloudCLI process (pid %s, state %s); a second "
                    "writer would fork the session. Let the holder finish, or resume only after "
                    "it exits (the owner can stop it in the CloudCLI UI)." % (sid[:8], pid, state))
    except Exception:
        return None
    return None


def main():
    try:
        if os.environ.get(KILL_SWITCH) == "1":
            return
        data = json.load(sys.stdin)
        why = verdict(data)
        if why:
            print(json.dumps({"decision": "block", "reason": "terminal-prompt-guard: " + why}))
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
