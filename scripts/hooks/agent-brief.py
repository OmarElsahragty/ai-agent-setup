#!/usr/bin/env python3
"""SubagentStart hook (WO-3): per-agent experience brief, capped at 1500 characters.

Prints SubagentStart additionalContext JSON for the starting subagent: up to 6
instincts with effective confidence >= 0.7 and up to 3 mistakes_to_avoid recorded
for that agent name, under the HISTORICAL REFERENCE ONLY header. Nothing is read
from or written to ${AI_SETUP_ROOT}/subagents/. Kill switch SESSION_MEMORY=off,
unknown agent or any failure -> no output, exit 0.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memlib  # noqa: E402

MAX_INSTINCTS = 6
MAX_MISTAKES = 3
MIN_INSTINCT_CONF = 0.7
NAME_RE = r"^[a-z0-9][a-z0-9_-]{0,63}$"


def agent_name(payload):
    for key in ("agent_name", "agent", "subagent_type", "agent_type", "subagent"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    value = str(os.environ.get("CLAUDE_SUBAGENT") or "").strip()
    return value


def build_brief(name, instincts, mistakes):
    parts = [memlib.BRIEF_HEADER,
             f"Experience memory for agent '{name}' — auto-generated, verify before acting.",
             ""]
    # security F4: stored-memory lines that look like imperative injections or
    # carry URLs with query strings never reach the brief
    instincts = [i for i in instincts if memlib.safe_line(i.get("statement", ""))]
    mistakes = memlib.safe_lines(mistakes)
    # adaptive per-line budget so every section survives the 1500-char cap
    n_lines = max(1, len(instincts) + len(mistakes))
    per_line = max(60, (memlib.AGENT_CAP - 320) // n_lines)
    if instincts:
        parts.append("Lessons learned in past runs:")
        parts.extend(f"- {i['statement'][:per_line]} (conf {i['confidence']}, "
                     f"{i['seen_sessions']} sessions)" for i in instincts)
    if mistakes:
        parts.append("Mistakes to avoid:")
        parts.extend(f"- {m[:per_line]}" for m in mistakes)
    return memlib.cap_chars("\n".join(parts) + "\n", memlib.AGENT_CAP)


def main():
    if not memlib.enabled():
        sys.exit(0)
    try:
        payload = {}
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        if raw.strip():
            payload = json.loads(raw)
        if not isinstance(payload, dict):
            payload = {}
        name = agent_name(payload)
        if not name or not __import__("re").match(NAME_RE, name):
            return
        instincts = memlib.get_instincts(name, MIN_INSTINCT_CONF, MAX_INSTINCTS)
        mistakes = memlib.get_mistakes(name, MAX_MISTAKES)
        if not instincts and not mistakes:
            return
        brief = memlib.cap_chars(build_brief(name, instincts, mistakes), memlib.AGENT_CAP)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SubagentStart",
            "additionalContext": brief,
        }}))
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
