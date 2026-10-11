---
description: Save a handoff summary of this session (WORKED / DID NOT WORK / NEXT STEP)
---
Write the session handoff now: $ARGUMENTS

1. Create ${AI_SETUP_ROOT}/state/sessions/<YYYYMMDD>-<HHMM>-<short-slug>.md (slug from the task or argument).
2. The file has exactly these sections, each 1-5 bullets, no filler:
   - WORKED — what produced verified results (with the test command + exit code).
   - DID NOT WORK — approaches that failed and WHY; write these so a future session never retries them blind.
   - EXACT NEXT STEP — the single next action, with paths and the command to run.
3. If a ${AI_SETUP_ROOT}/state/progress-<task>.md ledger exists for this work, append a pointer line to the session file path.
4. Reply with the session file path only.
