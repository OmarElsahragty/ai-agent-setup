---
name: systematic-debugging
description: Structured debugging workflow from reproduction to root-cause fix with regression test. Use when a bug is reported, a test fails, a service misbehaves, or a regression is suspected.
---

# Systematic Debugging Skill

## Workflow

1. **Reproduce** — Confirm the failure is reproducible. Capture exact command, input, and output.
2. **Gather Evidence** — Read logs, stack traces, recent changes, and related tests. Search memory for prior context.
3. **Understand** — Map the failure to a specific code path or configuration. Identify the expected vs actual behavior.
4. **Rank Hypotheses** — List plausible causes ordered by likelihood. State what evidence would confirm or rule out each.
5. **Test One Variable** — Change exactly one thing at a time. Verify the effect before proceeding to the next hypothesis.
6. **Minimal Root-Cause Fix** — Apply the smallest change that addresses the identified cause. No speculative multi-fix patches.
7. **Regression Test** — Add or update a test that would have caught this bug. Prove it passes.
8. **Verify No Collateral Damage** — Run the full relevant test suite. Confirm no new failures.

## Rules

- Change one variable per test. Never batch fixes during diagnosis.
- Never change a test to make it pass unless the test itself was provably wrong.
- Never apply a speculative multi-fix patch. Each fix must be tied to one confirmed root cause.
- Document the root cause and the fix rationale in the response.
- If the fix requires a service change, state the rollback path before applying.
