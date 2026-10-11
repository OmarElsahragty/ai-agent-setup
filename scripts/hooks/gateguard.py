#!/usr/bin/env python3
"""PreToolUse hook (Edit|Write|MultiEdit): WARN ONLY when editing a never-read existing file.

Owner ruling: this guard never denies. If the target file exists on disk but was neither Read
(tool_use Read with that file_path) nor referenced in an earlier Bash command in the last 4 MB
of the transcript, it emits one additionalContext nudge to read the file first. New (not yet
existing) targets and unreadable/missing transcripts stay silent. Fails open on any error.
"""
import json
import os
import sys

TAIL_BYTES = 4 * 1024 * 1024


def tail_lines(path, limit=TAIL_BYTES):
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - limit))
        data = fh.read()
    lines = data.decode("utf-8", "replace").splitlines()
    if size > limit and lines:  # first line is likely partial
        lines = lines[1:]
    return lines


def path_forms(p):
    forms = set()
    try:
        a = os.path.normpath(os.path.abspath(os.path.expanduser(p)))
        forms.add(a)
        forms.add(os.path.realpath(a))
    except Exception:
        pass
    return forms


def seen_in_transcript(transcript_path, target_forms, raw_target):
    for line in tail_lines(transcript_path):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "tool_use":
                continue
            name, inp = item.get("name"), item.get("input") or {}
            if name in ("Read", "Write", "Edit", "MultiEdit"):
                # an earlier own Write/Edit of the file also means its content is known
                if path_forms(inp.get("file_path") or "") & target_forms:
                    return True
            elif name == "Bash":
                command = inp.get("command") or ""
                if raw_target and raw_target in command:
                    return True
                if any(f and f in command for f in target_forms):
                    return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return  # non-dict JSON (list/string/number): fail open
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit"):
        return
    target = (data.get("tool_input") or {}).get("file_path") or ""
    if not target or not os.path.exists(target):
        return  # new file: silent
    transcript = data.get("transcript_path")
    if not transcript or not os.path.exists(transcript):
        return  # cannot prove anything: stay quiet, warn-only hook
    try:
        read = seen_in_transcript(transcript, path_forms(target), target)
    except Exception:
        return  # fail open
    if read:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "GATEGUARD: you have not read %s this session — read it and state "
                             "the facts you rely on before editing." % target,
    }}))


if __name__ == "__main__":
    main()
