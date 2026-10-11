---
description: Write a progress checkpoint to state/ and memory (resumable after compaction)
---
Checkpoint the current task: $ARGUMENTS

1. Determine the active task name (from the argument, else the newest ledger in ${AI_SETUP_ROOT}/state/progress-*.md).
2. Append to ${AI_SETUP_ROOT}/state/progress-<task>.md a dated section with: DONE (with file paths), VERIFIED (each claim carries `cmd → exit n` evidence), NEXT STEP (one concrete action), OPEN QUESTIONS (if any).
3. Call unified-memory `append_memory` on the task's SOT topic with the same summary (what/why/result/files).
4. Reply with the checkpoint file path and the topic name only — no prose recap.
