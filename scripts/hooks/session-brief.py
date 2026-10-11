#!/usr/bin/env python3
"""SessionStart hook (matcher startup, WO-3): historical brief for the main session.

Prints SessionStart additionalContext JSON, capped at 8000 characters: the last 3
session summaries recorded for this project, WHAT NOT TO RETRY lines (from their
did_not_work sections), and up to 6 'main' instincts with effective confidence
>= 0.7 (read-time decay). Every line sits under the HISTORICAL REFERENCE ONLY
header. Kill switch SESSION_MEMORY=off, or any failure -> no output, exit 0.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memlib  # noqa: E402

MAX_SUMMARIES = 3
MAX_INSTINCTS = 6
MIN_INSTINCT_CONF = 0.7
MAX_NOT_RETRY = 8


def last_summaries(project):
    """Newest <=3 session summaries for this project: DISK first (the 3 newest
    matching files in state/sessions/ by mtime, project matched from the file
    content), unified-memory search only as a fallback."""
    picked = _from_disk(project)
    if not picked:
        picked = _from_memory(project)
    return picked


def _from_disk(project):
    picked = []
    try:
        sdir = memlib.sessions_dir()
        if os.path.isdir(sdir):
            files = sorted((os.path.join(sdir, f) for f in os.listdir(sdir)
                            if f.endswith(".md")),
                           key=os.path.getmtime, reverse=True)
            for path in files[:200]:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    text = fh.read(4000)
                if f"— {project}\n" in text or project in text.splitlines()[0]:
                    picked.append(text)
                if len(picked) >= MAX_SUMMARIES:
                    break
    except Exception:
        return []
    return picked


def _from_memory(project):
    picked = []
    try:
        results = memlib.search_memory(query=f"session log {project}",
                                       namespace="session", agent="main", limit=15)
        rows = [r for r in results.get("results", [])
                if project in str(r.get("content", ""))[:200] or project in str(r.get("title", ""))]
        rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        seen = set()
        for row in rows:
            title = row.get("title", "")
            if title in seen:
                continue
            seen.add(title)
            picked.append(row.get("content", ""))
            if len(picked) >= MAX_SUMMARIES:
                break
    except Exception:
        return []
    return picked


def not_retry_lines(summaries):
    lines = []
    for text in summaries:
        try:
            in_section = False
            for line in text.splitlines():
                if line.startswith("## "):
                    in_section = line.startswith("## Did not work")
                    continue
                if in_section and line.strip().startswith("- "):
                    item = line.strip()[2:].strip()
                    if item and item != "(none recorded)":
                        lines.append(item[:240])
        except Exception:
            continue
    out = []
    for line in lines:
        if line not in out:
            out.append(line)
    return memlib.safe_lines(out)[:MAX_NOT_RETRY]


def build_brief(project, summaries, instincts, not_retry):
    parts = [memlib.BRIEF_HEADER,
             f"Session memory (project {project}) — auto-generated from past session logs.",
             "", "## Last sessions"]
    for i, text in enumerate(summaries, 1):
        body = text.strip()
        # drop the per-file header line to avoid re-anchoring on old instructions,
        # then drop imperative-injection / query-URL lines (security F4)
        body = "\n".join(body.splitlines()[1:]).strip() if body.startswith("#") else body
        parts.append(f"--- session {i} ---\n{memlib.cap_chars(memlib.sanitize_text(body), 1600)}")
    if not_retry:
        parts.append("\n## WHAT NOT TO RETRY")
        parts.extend(f"- {line}" for line in not_retry)
    instincts = [i for i in instincts if memlib.safe_line(i.get("statement", ""))]
    if instincts:
        parts.append("\n## Standing instincts (main, decayed confidence)")
        parts.extend(f"- {i['statement'][:300]} (conf {i['confidence']}, "
                     f"{i['seen_sessions']} sessions)" for i in instincts)
    return memlib.cap_chars("\n".join(parts) + "\n", memlib.SESSION_CAP)


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
        project = memlib.project_of(payload.get("cwd") or payload.get("workspace")
                                    or os.environ.get("PWD") or os.getcwd())
        summaries = last_summaries(project)
        instincts = memlib.get_instincts("main", MIN_INSTINCT_CONF, MAX_INSTINCTS)
        if not summaries and not instincts:
            return
        brief = memlib.cap_chars(
            build_brief(project, summaries, instincts, not_retry_lines(summaries)),
            memlib.SESSION_CAP)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": brief,
        }}))
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
