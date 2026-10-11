---
description: Run wave-1 gates on the current diff (per CLAUDE.md HARD RULE 4)
---
Run the gate wave on the current uncommitted diff: $ARGUMENTS

1. First refresh the code graph: call codebase-memory `detect_changes` (project "homeLap", scope "impact"). If the diff touches files the index does not know, run `index_repository` for the project first.
2. Then dispatch wave 1 in ONE message (never sequential): `code-reviewer` + `tester` + `security-reviewer` (if the diff touches auth/net/secrets/hooks) + `database-analyst` (if it touches DB schema). Each gets a dense work order: files + line ranges, the TEST command to run itself, and the STATUS/FILES/CHANGES/DECISIONS/RISKS/GATE-EVIDENCE/NEXT-STEPS contract.
3. Merge findings, run ONE fix pass, re-run only the affected tests.
4. Report: verdict per gate (pass/fail), the executed test commands with exit codes, and the single fix-pass diff summary. Do not apply, restart, or commit anything — apply is a separate owner-visible step.
