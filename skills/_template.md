# Skill: <name>
> Promoted from: ${AI_SETUP_ROOT}/runs/<task-id>.md  
> Tier: A | B | C  
> Last verified: YYYY-MM-DD

## Purpose
One-sentence description of what this skill accomplishes.

## Prerequisites
- [ ] Condition 1
- [ ] Condition 2

## Triggers
When an agent should invoke this skill:
- Pattern/keyword/condition that signals this skill applies

## Allowed Scopes
List of directories, services, or resources this skill is permitted to touch.

## Required Tools
- `bash` — for shell commands
- `filesystem` — for file operations
- `memory` — to record outcome
- (add others as needed)

## Steps
1. **Verify preconditions** — check that prerequisites are met before proceeding
2. **Step description** — exact command or action
   ```bash
   # example command
   ```
3. **Validate** — how to confirm the step succeeded
4. **Continue or abort** — decision criteria

## Validation
How to confirm the skill completed successfully:
```bash
# validation command
```
Expected output: `...`

## Rollback
If validation fails, how to undo:
```bash
# rollback commands
```

## Learned
What to write to ${AI_SETUP_ROOT}/memory/memory.json after a successful run:
- Entity type: `<type>`
- Observation: `[VERIFIED] <fact> | evidence: <how> | date: <YYYY-MM>`

## Notes
Any edge cases, gotchas, or environment-specific caveats.
