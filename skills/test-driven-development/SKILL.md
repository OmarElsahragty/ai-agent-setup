---
name: test-driven-development
description: RED-GREEN-REFACTOR cycle for new behavior and bug fixes. Use when writing new functionality, fixing a bug with a test, or adding behavior that needs verification.
---

# Test-Driven Development Skill

## Cycle

### RED

Write the smallest test that captures the intended behavior or the reported bug. Run it. **It must fail.** Verify it fails for the intended reason — not a syntax error, import failure, or unrelated assertion.

### GREEN

Write the minimal implementation that makes the test pass. No premature optimization, no extra features, no speculative abstraction.

### REFACTOR

Only while all tests are green: improve structure, naming, clarity, or performance. Re-run tests after every meaningful change to confirm green is preserved.

## Verification

- **Targeted:** Run the specific test file or test case after each RED/GREEN/REFACTOR cycle.
- **Broader:** After the cycle is complete, run the full relevant test suite to confirm no regressions.

## Explicit Exceptions

These do not require RED-GREEN-REFACTOR but still require validation:

- **Generated code** — validate output correctness, not intermediate steps.
- **Pure declarative config** (TOML, YAML, JSON, CSS) — validate syntax and expected values.
- **Documentation-only edits** — validate no broken links or formatting.
- **Throwaway diagnostic probes** — validate the probe produces useful output; discard after.

## Rules

- Never skip proving RED. A test that was never seen failing provides no regression safety.
- Never write the implementation before the test (for non-exception work).
- Never refactor while tests are failing.
- Keep GREEN minimal.
- If a test is flaky, stabilize it before using it as a regression gate.
