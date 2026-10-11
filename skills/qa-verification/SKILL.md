---
name: qa-verification
description: Acceptance criteria validation, live API probing, zero-mock invariant enforcement, and anti-hallucination checks for QA agents.
---

# QA Verification Skill

A rigorous, lightweight playbook for verifying observable behavior, live APIs, and acceptance criteria without hallucinations or false positives.

## Core Invariants

1. **Observable Truth Over Assumptions**: Never assume a feature works because code was committed or an agent claimed "done". Verify live endpoints, responses, or process states.
2. **Zero-Mock Enforcement**: In production and QA pipelines, all API endpoints and server loaders MUST execute against real databases/services. Never accept hardcoded fallback KPIs, mock data arrays, or artificial 200 OKs.
3. **Anti-Hallucination Gate**: Verify that the port is listening, process is running, and responses contain actual domain data before signing off.

## Verification Checklist

### 1. Acceptance Criteria Mapping
- Break down user requirements into discrete, testable assertions (`Given <precondition>, When <action>, Then <expected result>`).
- Test both the happy path and critical edge paths (unauthorized, empty database, malformed input).

### 2. Live API & HTTP Probing
- **Status & Headers**: Assert exact HTTP status codes (`200 OK`, `201 Created`, `400 Bad Request`, `404 Not Found`, `422 Unprocessable`).
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/api/endpoint
  ```
- **Response Shape**: Verify JSON schema, non-empty payload, and expected data keys using `jq` or node scripts.
  ```bash
  curl -s http://127.0.0.1:<port>/api/endpoint | jq -e '.data | length >= 0'
  ```
- **Empty / Loading States**: Confirm that when data is absent, the response gracefully returns empty collections or clear error messages—NEVER mock placeholders.

### 3. Regression & Health Probing
- After service restart, verify systemd service status:
  ```bash
  systemctl is-active --quiet <service-name> && echo "ACTIVE"
  ```
- Probe health endpoints:
  ```bash
  curl -sI http://127.0.0.1:<port>/health | grep -E "HTTP/[12].* 200"
  ```
- Inspect systemd journal logs for unhandled rejections or runtime exceptions during the verification window:
  ```bash
  journalctl -u <service-name> -n 30 --no-pager | grep -iE "error|exception|unhandled"
  ```

## Report Format
Report findings using the structured QA gate format:
- **Scope Tested**: Endpoints, routes, or workflows probed.
- **Pass/Fail Table**: Matrix of criteria vs verified result.
- **Evidence**: Live HTTP status, curl response snippets, or log confirmations.
- **Verdict**: `VERIFIED` | `BLOCKED` (with reproduction steps).
