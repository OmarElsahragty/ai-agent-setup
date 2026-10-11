---
name: test-engineering
description: Boundary value analysis, automated test discovery, test isolation, and flaky test mitigation for tester agents.
---

# Test Engineering Skill

A practical guide for test discovery, boundary edge case testing, test isolation, and eliminating flaky tests.

## Test Discovery & Execution Cadence

1. **Auto-Detect Test Harness**:
   - Node/TypeScript: `pnpm test`, `npx vitest run`, `npm test`
   - Python: `pytest -v`, `python3 -m unittest`
   - Rust: `cargo test`
   - C++: `ctest --output-on-failure`, `ninja test`
2. **Targeted Execution**: Always run targeted test files or test filters during development before executing full project suites.
   ```bash
   pnpm test -- <path/to/test.ts>
   pytest tests/test_specific.py -k "test_feature"
   ```

## Boundary Value Analysis (BVA) & Corner Cases

When verifying functions, API endpoints, or calculations, systematically probe boundary conditions:
- **Numeric**: `0`, `-1`, `1`, `MAX_INT`, `MIN_INT`, extreme floating point precision, `NaN`, `Infinity`.
- **Collections**: Empty array/map (`[]`, `{}`), single-item collection, duplicate items, large dataset (10k+ items).
- **Strings**: Empty string `""`, whitespace-only `"   "`, multiline, special characters (`<>&"'/`), unicode/emojis, 1000+ char strings.
- **Temporal / Dates**: Daylight saving transitions, month/year boundaries, timezone differences, past vs future timestamps.

## Test Isolation & Hermeticity

- **Zero Inter-Test Pollution**: Each test MUST initialize its own state and clean up after itself. Never rely on test execution order.
- **Hermetic Fixtures**: Use unique identifiers (e.g. `nanoid()`, timestamped records) when testing databases to prevent collisions with parallel runs.
- **Transactional Rollbacks**: Wrap test database mutations in transactions and roll back after completion where supported.

## Flaky Test Triage & Elimination

- **Root Causes**:
  - Arbitrary sleeps (`setTimeout(..., 1000)`): Replace with polling predicates (`waitFor(() => condition, { timeout })`).
  - Shared mutable state or uncleaned database records.
  - Non-deterministic ordering in SQL queries (always specify `ORDER BY` when asserting list responses).
  - Unseeded random generators.
- **Quarantine & Fix**: If a test fails intermittently, isolate the race condition or async wait before treating the test suite as green.
