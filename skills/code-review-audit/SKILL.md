---
name: code-review-audit
description: High-signal code review and security audit checklist covering logic flaws, OWASP vulnerabilities, secret leaks, and architectural drift.
---

# Code Review & Security Audit Skill

Lightweight, high-signal checklist for reviewing code diffs, identifying logic flaws, and auditing security vulnerabilities.

## Review Philosophy
- **High Signal, Low Noise**: Focus on logic bugs, security risks, breaking contracts, and regressions. Do not nitpick formatting unless it affects maintainability.
- **Diff-Scoped Verification**: Verify changed symbols, callers, imports, and side effects across the dependency graph.

## Review Checklist

### 1. Correctness & Logic Flaws
- **Boundary & Null Checks**: Are optional fields, empty collections, and null/undefined values safely handled?
- **Async & Error Handling**: Are all promises awaited? Are rejection paths caught? Are background tasks monitored?
- **Resource Leaks**: Are database connections, file handles, event listeners, and timers closed/released?
- **State Mutation**: Is shared state mutated concurrently or unpredictably?

### 2. Security & Vulnerability Audit (OWASP)
- **Secrets & Credentials**: Strictly check that NO API keys, passwords, bearer tokens, or `.env` secrets are hardcoded in diffs or commit history.
- **Injection Risks**: Ensure all SQL uses parameterized queries (Drizzle/ORM); ensure shell commands never concatenate untrusted user inputs.
- **Path Traversal & SSRF**: Verify file paths and outbound URLs are strictly validated and constrained to allowed directories/hosts.
- **Access Control & Safe Defaults**: Are mutations protected? Are least-privilege principles respected?

### 3. Architectural Drift & Invariants
- **Database Parity**: Do schema changes maintain bi-directional parity between Drizzle ORM and PostgreSQL?
- **Single Source of Truth**: Are configs and routing sourced from authoritative homelab files (`${AI_SETUP_ROOT}`)?
- **Zero Mock Rule**: Are mock metrics or placeholder numbers strictly prohibited in production web/dashboard code?

## Review Output Format
- **Status**: `APPROVE` | `REQUEST_CHANGES`
- **Critical Findings**: Logic bugs or security vulnerabilities (blocking).
- **Suggestions**: Architectural improvements or edge-case handling (non-blocking).
- **Verified Gates**: Confirm static lint, typechecks, and automated tests pass.
