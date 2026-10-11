---
name: spec-audit
description: Audit a specification against its test suite and report the normative rules (MUST/SHALL/never/always) that no test actually checks. Use after writing or changing a spec, and before claiming a spec is covered.
---

# Spec Audit

Finds the gap between what a spec says **must** happen and what the tests
actually verify. The failure it catches is the common one: a rule exists in
prose, a test file *mentions* the area, and everyone believes it is covered.

## Purpose

For each normative rule line in a spec, decide — with the local models, not by
keyword matching — whether any test file genuinely asserts it. Report the rules
that nothing checks.

## When to use it

- After writing or amending a spec/contract/rulebook.
- Before a phase gate that claims "the spec is implemented and tested".
- When a rule keeps being violated: check whether any test covers it at all.
- When onboarding: it ranks which rules are actually enforced by CI.

Do **not** use it to decide *whether the implementation is correct* — that is
`code-reviewer`. This answers only "is there a test for this rule".

## Prerequisites

- [ ] a spec file with normative lines (`MUST`, `SHALL`, `never`, `always`,
      `required`, `forbidden`, `prohibited`, `mandatory`)
- [ ] a directory of tests
- [ ] `llama-rerank` on `127.0.0.1:11435` (0.6B) and the `local-decide` daemon on
      `127.0.0.1:11438` — without them the script exits 1 rather than guessing

## Allowed scopes

Read-only. It reads the spec and the test files and writes nothing anywhere.

## Required tools

- `bash` — to run the script

## Steps

1. **Run the audit**
   ```bash
   python3 ${AI_SETUP_ROOT}/skills/spec-audit/spec_audit.py <spec> <tests_dir>
   ```
   Options: `--top N` (candidates judged per rule, default 3), `--threshold 0.6`
   (minimum confidence for "covered"), `--max-rules 60`, `--json`,
   `--fail-on-uncovered` (exit 2 when anything is uncovered).

2. **Read the uncovered list** — each entry carries the rule id, its line number
   in the spec, the rule text and the closest candidate test file.

3. **Decide per rule** — an uncovered rule means: *write the missing test* or
   *delete the rule* because nothing enforces it. Do not silently accept it.

## How it works

1. **Rule extraction** — every non-fenced, non-comment line matching a normative
   keyword becomes a rule, prefixed with its nearest markdown heading for context.
2. **Candidate rerank** — the 0.6B cross-encoder ranks every test file against the
   rule; the top `--top` files are kept.
3. **Yes/no judgement** — grouped *by test file* (one multi-head decide call per
   file, chunked at the engine's 16-head cap): "does this test file assert this
   rule?" A rule is covered only on an explicit `yes` at or above `--threshold`.

**Abstain is not coverage.** An abstained rule is reported UNCOVERED with
`abstained: true` — never counted as covered.

## Validation

```bash
python3 ${AI_SETUP_ROOT}/skills/spec-audit/spec_audit.py \
  ${AI_SETUP_ROOT}/local-decide/INTERFACES.md ${AI_SETUP_ROOT}/local-decide/tests --json
```
Expected: `"status": "ok"` with a `coverage` fraction and an `uncovered` array.
`"status": "unavailable"` with exit 1 means the daemon is down — fix that, do not
report the audit as clean.

## Rollback

None needed — read-only.

## Learned

- Verifying with the *sentence* in the label, not a bare "does this relate?", is
  what keeps the false-positive rate down; a vague question makes every test file
  look relevant.
- Grouping judgements by test file (rather than one call per rule/candidate pair)
  is both correct and far cheaper, because `/v1/decide` asks one question set
  about one text.

## Notes

- Fenced code blocks, HTML comments and `//` comments are skipped, so a rule quoted
  inside an example does not become a rule.
- The default `--max-rules 60` bounds a long spec; the note line reports truncation.
- Standard library only; runs under `/usr/bin/python3` with no venv.