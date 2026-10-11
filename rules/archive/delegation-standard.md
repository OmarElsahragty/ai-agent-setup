# Delegation Standard (archive)

Detailed prose behind core `AGENTS.md` HARD RULES 3–5.

## Orchestrator Delegation Protocol (all agents — MANDATORY)

The main agent operates as an **Orchestrator and Verifier**; the DIRECT lane below is the only case where it implements itself.

**Context Window Cleanliness Invariant:**
The Orchestrator's conversation context MUST remain lean, high-signal, and uncluttered. Do NOT run exploratory command chains, multi-file code scans, full test-suite executions, log reading or deep investigations in the main session — dispatch them to a subagent in its own context window and consume ONLY its structured summary. (Claude Code: `Agent` tool; OpenCode: `task` tool; agy: its subagent runner.)

**Mandatory Delegation Mapping:**
1. **Research** (external docs, benchmarks, web): `research` (Exa only).
2. **Implementation / refactoring**: `implementer` (MEDIUM) or `quant-engineer` (HEAVY); DIRECT lane for ≤3 files.
3. **Review**: `code-reviewer` — one pass, both checklists.
4. **Testing & bug reproduction**: `tester`.
5. **QA, API probing & browser validation**: `qa`.
6. **Database / migrations**: `database-analyst` (read-only).
7. **Homelab & system operations**: `homelab-operator`.
8. **Session / codebase sweeps & plan analysis**: a subagent reads the logs/sessions and returns findings; never the main session.

**Orchestrator Workflow Loop:** Dispatch (dense work order) → **wait for the completion notification — never poll `ListAgents`/`SendMessage`/`Monitor` to ask "are you done?"; every poll turn re-reads the whole context for nothing** → Verify (§E4: re-run the worker's TEST yourself; non-HEAVY in the background alongside the next independent dispatch) → Gate wave 1 in ONE message (`code-reviewer` + `tester` + `security-reviewer`/`database-analyst` when triggered) → one merged fix pass + affected-test re-run → `qa` → Apply/Restart → Health Check, once per batch → Consolidate. **Before** the loop: owner-confirmed plan, all ambiguities asked in ONE AskUserQuestion batch (HARD RULE 11). **During** it: each wave gets one background budget timer (45 min default, 4 h HEAVY); a fired timer means inspect that agent once, then resume or re-dispatch — never poll.

## Execution Lanes (Claude Code three-tier)

Pick the lane by task shape BEFORE writing any work order — dispatching a tiny task or implementing a huge one inline are both errors:
- **DIRECT** — trigger: ≤3 files + 1 test command + no parallel siblings. The main agent (Opus) implements it itself: read, edit, run the test, done. Gate: one `code-reviewer` pass afterward. No Task dispatch, no work-order ceremony, no claim-vs-proof gap.
- **MEDIUM (fan-out)** — trigger: >3 files, or a parallelizable batch of independent tasks. Dispatch to `implementer` / specialist subagents, 4–7 wide, per Atomic Task Scoping. Gate: full chain, run once per batch.
- **HEAVY** — trigger: C++ engine, quant math, money paths, parity/oracle work. Dispatch to `quant-engineer` — the canonical heavy implementer. Gate: full chain + §E4 re-verification.

Lane rule of thumb: if dispatch overhead (work-order composition + report parsing + re-verification) exceeds the implementation itself, drop to DIRECT; if the work is engine/money/parity, never drop below HEAVY.

## Context Hygiene & Session Discipline (measured, not assumed)

One measured long-running session (46 h, 5,814 turns, 1.47 B cache-read tokens, contexts up to 566 k tokens, 57 compactions, 10 workers killed with "Prompt is too long", death on a cold-cache resume: 315 k uncached tokens → instant 429, then 529 → 500) is the reason for these rules:

1. **Auto-compact is 300 k.** Never raise it. A turn at 150–250 k context is 2–3× faster and cheaper than one at 500 k and produces the same answer when the state lives on disk.
2. **State lives on disk, not in context.** The plan (`~/.claude/plans/*.md`), the progress ledger (`<project>/state/*.md`) and `unified-memory` are the source of truth; write to them before every dispatch batch and after every gate. After a compaction, re-read the ledger, not the transcript.
3. **Never `Read` a file over ~40 KB whole.** For plans and specs: `grep -n` the step id or heading, then `Read` with `offset`/`limit` (≤ 250 lines).
4. **One phase batch per session.** Start a fresh `claude` session per phase (or per 6–8 dispatched steps) from the ledger instead of `--resume` on a giant transcript; `--resume` is for a session interrupted minutes ago, not hours (after the 1 h cache TTL the whole context is re-billed as uncached input and trips the per-minute limit). After > 45 min idle, also start fresh; `/compact` before a planned break.
5. **Dispatch, then stop.** After launching subagents, end the turn; the harness notifies on completion. No polling, no `Monitor` loops, no `SendMessage` status pings.
6. **Work orders point, never paste.** File paths + line ranges + the step's own text; a worker whose prompt is a pasted spec dies at "Prompt is too long".
7. **On 429 / 529:** do not hammer. Compact (`/compact`) or start a fresh session from the ledger; if the subscription window is genuinely dry (check the rate-limit response headers, not the error text), switch the session to the DeepSeek main lane (`claude --model deepseek-v4.1-flash`). Never let the orchestrator silently continue on a smaller model.
8. **Owner commits.** Ask the owner to commit at every phase gate so a filesystem mistake cannot erase a day of work.

Long tasks: writes are single-threaded; only read-only lanes run in parallel. Subagent summaries ≤ 2k tokens; subagents keep working context < 150k and a `state/progress-<task>.md` checkpoint on any > 50-turn task (`maxTurns` returns PARTIAL, resumable). The PreCompact hook steers every compaction to the 8-section summary; rules that must survive compaction never use `paths:` frontmatter.

## Delegation & Verification Gates (High-Quality / Min-Token Protocol)

- **High-Density, Low-Token Delegation Standard (MANDATORY)**:
  When the CEO / Orchestrator dispatches any task to a subagent, the instructions MUST be exhaustively detailed with exact requirements, rules, boundaries, and acceptance criteria to ensure flawless execution quality. HOWEVER, to keep token cost minimal:
  1. **Strict Format**: Use the high-density key-value schema (approx. 60–120 tokens total, zero conversational filler):
     ```
     TASK: <exact imperative objective>
     SCOPE: <permitted files and boundaries>
     FILES: <file paths + line ranges, or symbol names>
     REQUIREMENTS:
     - <explicit behavioral rule / invariant 1>
     - <explicit edge case / invariant 2>
     CONSTRAINTS: <scoped boundary, zero-mock rule, English only, no git commits>
     TEST: <exact command to run for verification>
     OUTPUT: <expected return block & deliverables>
     ```
  2. **Zero Code Dumping**: NEVER paste whole files, multi-line code blocks, or full transcripts from the orchestrator prompt into the subagent invocation. Subagents have their own file reading (`Read`, `Grep`) and AST tools (`codebase-memory`). Point to exact files and line numbers.
  3. **Zero Conversational Preamble**: No greetings, pleasantries, or meta-chatter. Jump directly into the dense specification block.
  4. **Atomic Task Scoping Invariant**: NEVER dispatch broad, open-ended "megatasks" spanning entire monorepos without exact target files and symbols. Every subagent delegation MUST be atomic (targeting 1–3 specific files, specific symbols, and 1 specific test command). If a feature requires changes across multiple modules, decompose it into parallel atomic dispatches rather than 1 monolithic 400-turn subagent.
- **Plan check & NEEDS_OWNER**: every subagent first confirms its order states goal, files/scope, acceptance criteria and the test command. Missing or ambiguous items, or any value/path/requirement/ruling it would have to guess, return `STATUS: NEEDS_OWNER` with the exact question (the D6 contract still applies: `FILES MODIFIED: none` + GATE EVIDENCE of the lookup that was run). The orchestrator relays it to the owner verbatim and never answers on the owner's behalf; unblocked siblings keep running.
- **Contract & Return**: Subagents return: STATUS (COMPLETED / PARTIAL / CLARIFICATION NEEDED / NEEDS_OWNER / FAILED), FILES MODIFIED, CHANGES, DECISIONS, RISKS, **GATE EVIDENCE** (`<command> → exit <n>` per verification command), NEXT STEPS. Self-reporting a defect found in one's own verification is pass-grade behavior; hiding it is a failure. A report without these fields, or listing files with no edit in its transcript, is sent back once (D6). Never "correct" an honest report by dropping a file you did write — keep it and explain under DECISIONS.
- **§E4 Orchestrator Re-verification (MANDATORY)**: A worker's claim of success is NEVER evidence. The orchestrator re-runs the worker's TEST command itself and reads the exit codes/output directly — gate output, not narrative. This closes the claim-vs-proof gap at ~zero cost (one command re-run) and is the load-bearing wall of the delegation system.
- **Verification Gates (Waves):** Implementation batch → **wave 1, dispatched in ONE message on the frozen diff:** `code-reviewer` (one pass: correctness + clean architecture) + `tester` + `security-reviewer` (if auth/net/secrets) + `database-analyst` (if DB schema) → orchestrator merges findings → ONE fix pass → re-run only the affected tests → `qa` → Apply/Restart → Health Check. Wave 1 gates read the same frozen diff, so they are independent; run a single final verification sequence after batch completion and avoid intermediate gate loops. For critical gates (money, safety, schema, parity), `tester` must prove the gate can fail (one negative control) — a test that cannot fail is vacuous and does not count as coverage.
- **Failure:** Retry specialist once with smaller scope. 2nd failure = BLOCKED. Silently substituting roles is forbidden.

## Subagent roster (canonical, `${AI_SETUP_ROOT}/subagents/`)

- `implementer`: create/fix/refactor/scaffold, MEDIUM lane (Read/Write/Edit/Bash/Memory)
- `quant-engineer`: HEAVY lane — C++ engine, quant math, money paths, parity/oracles (Read/Write/Edit/Bash/Memory/Postgres)
- `code-reviewer`: the single review gate — correctness, security, regressions AND clean architecture / modularity / smells in one pass (Read-only + Bash/Memory)
- `tester`: test discovery & execution, one negative control per critical gate (Read-only + Bash/Memory)
- `qa`: acceptance, API probing & browser evidence (Read-only + Playwright/Bash/Memory)
- `homelab-operator`: Docker/systemd/network/backup, Tier B (Read/Write/Bash/Memory)
- `security-reviewer`: read-only security audit
- `database-analyst`: read-only DB schema/queries (PostgreSQL safe)
- `research`: sole internet research (`exa`)
- `ui-designer`: UI/UX design consumer
- `android-engineer`: native Android (Compose, emulator verification)
- Built-ins (Claude Code): `Explore` (code discovery), `Plan` (design only), `general-purpose` (fallback)

## Thinking & reasoning tools (detail behind core rules)

- `sequentialthinking` (`mcp__sequential-thinking__sequentialthinking`): step-by-step problem breakdown, plan formulation, debugging workflows.
- `mcp-reasoner` (`mcp__mcp-reasoner__*`): comparing design approaches, engineering trade-offs (latency vs memory, caching vs live queries), algorithm selection, multi-branch decisions (supports `beam_search` and `mcts`).
- Skip thinking tools only for trivial 1-line factual lookups.
