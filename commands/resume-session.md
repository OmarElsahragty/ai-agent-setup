---
description: Resume from the latest saved session (brief includes WHAT NOT TO RETRY)
---
Brief me to resume work: $ARGUMENTS

1. Read the latest file in ${AI_SETUP_ROOT}/state/sessions/ (or the one named by the argument).
2. Read the progress ledger it points to (${AI_SETUP_ROOT}/state/progress-<task>.md) — tail only if large.
3. Brief me in this exact shape, under 200 words:
   - TASK: one line.
   - STATE: done vs remaining, from the ledger's last checkpoint.
   - WHAT NOT TO RETRY: every DID NOT WORK item, verbatim, each with its why.
   - EXACT NEXT STEP: the command/path from the session file.
4. If the next step is ambiguous or depends on an owner ruling, say so explicitly and stop — do not guess.
