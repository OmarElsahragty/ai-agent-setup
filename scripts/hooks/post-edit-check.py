#!/usr/bin/env python3
"""PostToolUse hook (Edit|Write|MultiEdit): syntax-check the file just written, warn only.

By extension: .py -> python3 -m py_compile, .js/.mjs/.cjs -> node --check, .sh/.bash -> bash -n,
.json -> json.load (in-process). Each subprocess check has a 5 s timeout; files larger than
2 MB and unknown extensions are skipped. A failing check emits additionalContext with the first
20 error lines; the hook always exits 0 (advisory, never blocks). Fails open on any error.
"""
import json
import os
import subprocess
import sys

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT_S = 5
MAX_ERROR_LINES = 20

EXT_COMMANDS = {
    ".py": ("python3 -m py_compile", ["python3", "-m", "py_compile"]),
    ".js": ("node --check", ["node", "--check"]),
    ".mjs": ("node --check", ["node", "--check"]),
    ".cjs": ("node --check", ["node", "--check"]),
    ".sh": ("bash -n", ["bash", "-n"]),
    ".bash": ("bash -n", ["bash", "-n"]),
}


def run_check(path, ext):
    """Return (ok, message) for the file; message is None when ok."""
    if ext == ".json":
        try:
            with open(path, encoding="utf-8") as fh:
                json.load(fh)
            return True, None
        except (ValueError, OSError) as exc:
            return False, "json.load: %s" % exc
    label, argv = EXT_COMMANDS[ext]
    try:
        proc = subprocess.run(argv + [path], capture_output=True, timeout=TIMEOUT_S)
    except FileNotFoundError:
        return True, None  # checker binary missing: nothing we can verify, stay quiet
    except subprocess.TimeoutExpired:
        return False, "%s: timed out after %ds" % (label, TIMEOUT_S)
    if proc.returncode == 0:
        return True, None
    text = (proc.stderr or b"") + (proc.stdout or b"")
    lines = [ln for ln in text.decode("utf-8", "replace").splitlines() if ln.strip()]
    return False, label + ":\n" + ("\n".join(lines[:MAX_ERROR_LINES]) or "(no error output)")


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return  # non-dict JSON (list/string/number): fail open
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        return
    path = (data.get("tool_input") or {}).get("file_path") or ""
    if not path or not os.path.isfile(path):
        return
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return
        ext = os.path.splitext(path)[1].lower()
        if ext != ".json" and ext not in EXT_COMMANDS:
            return
        ok, message = run_check(path, ext)
    except Exception:
        return  # fail open
    if ok:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": "post-edit-check WARNING: %s failed a syntax check (%s first "
                             "lines shown):\n%s" % (path, MAX_ERROR_LINES, message),
    }}))


if __name__ == "__main__":
    main()
