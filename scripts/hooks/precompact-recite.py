#!/usr/bin/env python3
"""PreCompact hook (manual + auto): steer the compaction summary so long, multi-day tasks survive it.

Plain-text stdout of a PreCompact hook is merged into the summarizer's instructions (the only channel that
reaches AUTO-compaction; see ${AI_SETUP_ROOT}/state/local-decide/RESEARCH-LONGTASK.md Q3/M7). It prints a fixed
preservation template plus the tail of the on-disk ledgers/plans this session actually touched, so the summary
re-anchors on disk state instead of transcript memory. Never fails: any error prints only the template.

2026-10-02: LEDGER_RE also matches progress-*.md state files; the template pins the last owner messages and any
unanswered owner request verbatim (section 9); prior compactions are counted in the transcript and at >= 3 the
summary is told to recommend a fresh session from the ledger (context-hygiene policy).
"""
import json
import os
import re
import sys

TEMPLATE = """COMPACTION INSTRUCTIONS (owner policy, long multi-day task). The summary MUST contain these sections, in order:
1. GOAL — the owner's overall objective and current phase, in the owner's words where possible.
2. HARD RULES — every owner directive/ruling given in this session (verbatim when short), incl. model/lane and safety rules.
3. STATE ON DISK — the ledger/plan/state file paths (listed below) as the source of truth; say "re-read these first".
4. PROGRESS + GATE EVIDENCE — what is done and verified, with the exact `<command> → exit <n>` evidence; mark claims not yet re-verified.
5. DECISIONS — settled decisions and why; DEAD ENDS — what failed and why (so it is not retried).
6. OPEN ISSUES — defects, blockers, pending owner questions, running background agents (with their task).
7. FILES — every file created or modified (absolute paths) and backups taken.
8. NEXT STEP — the single immediate next action.
9. OWNER VERBATIM — quote the last owner messages and ANY unanswered owner request WORD-FOR-WORD (verbatim,
   exact wording), so no directive is paraphrased away or lost across the compaction.
Do not drop specifics (paths, ports, numbers, model ids, thresholds). Prefer recall over brevity."""

LEDGER_RE = re.compile(r"(/[\w.\-/]+/(?:[\w.\-]*LEDGER[\w.\-]*\.md|plans/[\w.\-]+\.md|STATUS[\w.\-]*\.md|[\w.\-]*progress-[\w.\-]*\.md))")
TAIL_BYTES = 4 * 1024 * 1024
MAX_FILES = 3
TAIL_LINES = 25
# Opener of every compaction summary Claude Code writes into the transcript (one per prior compaction).
CONTINUATION_MARKER = "This session is being continued"
COUNT_SCAN_BYTES = 32 * 1024 * 1024
FRESH_SESSION_RECOMMENDATION = (
    "\nCOMPACTION LOAD WARNING: this transcript already contains {n} prior compaction summaries. In section 8 "
    "(NEXT STEP), recommend that the owner start a FRESH session re-read from the on-disk ledger instead of "
    "continuing this context (context-hygiene policy: a cold resume re-bills the whole window as uncached input)."
)


def count_prior_compactions(transcript_path):
    with open(transcript_path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - COUNT_SCAN_BYTES))
        text = fh.read().decode("utf-8", "replace")
    return text.count(CONTINUATION_MARKER)


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


def main():
    print(TEMPLATE)
    try:
        payload = json.load(sys.stdin)
        transcript_path = payload.get("transcript_path") or ""
        prior = count_prior_compactions(transcript_path)
        paths = touched_ledgers(transcript_path)
    except Exception:
        return
    if prior >= 3:
        print(FRESH_SESSION_RECOMMENDATION.format(n=prior))
    if not paths:
        return
    print("\nSTATE FILES TOUCHED IN THIS SESSION (most recent first) — list them in section 3:")
    for path in paths:
        print(f"- {path}")
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                lines = fh.read().splitlines()[-TAIL_LINES:]
        except OSError:
            continue
        print(f"\n--- tail of {path} ---")
        print("\n".join(lines))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
