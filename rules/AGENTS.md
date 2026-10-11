# Agent rules (generic)

**Priorities:** API-first operations, maximum safe autonomy, no noise, no unsolicited notifications, no proactive commits, no secret leaks.

**Language invariant:** every agent, subagent, job and gate thinks, reasons and outputs EXCLUSIVELY in English — zero other languages in thinking or output.

Paths below: `${AI_SETUP_ROOT}` = the root of this installation (the clone root; `install.sh` and every sync script resolve it from this environment variable and fall back to their own file location); `~` = the home directory of whoever runs it.

## Model Routing

Truth: `DEFAULT_ROLE_PLAN` / `COMPACTION_PLAN` in `claude-router/server.js`; OpenCode: `model` / `small_model` in `opencode.jsonc`. Per-role override: `ROLE_PLAN_<ROLE>` in `claude-router/.env`.

| Lane | Target | Model | Effort | One-hop fallback |
| --- | --- | --- | --- | --- |
| Claude Code main (CEO; runs DIRECT) — the `claude` wrapper | Anthropic subscription | `claude-opus-5-5[1m]` | high | on quota / rate-limit (429, 402, 403) the router retries the SAME model once with the router `ANTHROPIC_API_KEY`; if that also fails the real error goes back to the client. This lane never falls back to a third-party model. |
| DeepSeek main lane (`claude --model deepseek-v4.1-flash`) | OpenCode Go | `deepseek-v4.1-flash` | max | `claude-opus-5-5` (high) |
| Compaction only | Anthropic subscription | `claude-opus-5-5` | medium | same-model `ANTHROPIC_API_KEY` retry (no model substitution) |
| All 11 subagents + built-ins (Explore, Plan, general-purpose, …) | OpenCode Go | `deepseek-v4.1-flash` | max | `claude-haiku-5-5` (max) |
| Background jobs (titles, summaries, command checks, CLI background calls) | OpenCode Go | `deepseek-v4.1-flash` | max | `claude-haiku-5-5` (max) |
| OpenCode: every agent and background job | OpenCode Go | `opencode-go/deepseek-v4.1-flash` | max | — |
| OpenCode `plan` agent (the only exception) | Anthropic | `anthropic/claude-opus-5-5` | default | — |
| Voice front (optional, CloudCLI web UI) | Google Gemini Live API (browser ⇄ Google, ephemeral token minted by `voice-gateway` :3012) | `gemini-3.8-live` | — | — |
| agy CLI | Google | Gemini 3.7 Flash, native OAuth | — | — |

The `claude` wrapper exports `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5`, `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5` and `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5`, so every Claude 5.x model is selectable with `--model`.

## Source-of-Truth Path Map (single source: `${AI_SETUP_ROOT}`)

- **Rules:** this file, symlinked to `~/.claude/CLAUDE.md`, `${AI_SETUP_ROOT}/CLAUDE.md`, the OpenCode `instructions` entry and agy's `~/.gemini/GEMINI.md`. Archives: `rules/archive/`.
- **Subagents:** canonical `subagents/` (11 roles); consumers `claude-agents/` and `opencode-agents/` (generated — never hand-edit). Run `scripts/sync-all-agents.py` after any edit.
- **MCP:** every MCP server runs once, inside `opencode-hub` (:8790). Launch definitions + secrets: `mcp/mcp_servers.json` (0600, hub only). Clients read `mcp/mcp_config.json`, which contains hub URLs only (Claude Code: `<root>/.mcp.json` symlink + `~/.claude.json` via `scripts/sync-claude-config.py`; OpenCode: the `sync-shared.ts` plugin; agy: config symlink). Add a server: edit `mcp/mcp_servers.json` → `python3 opencode-hub/migrate-mcp-config.py` → restart `opencode-hub` → `python3 scripts/sync-claude-config.py`. Revert: `opencode-hub/switch-clients.sh --revert`.
- **Skills:** `skills/`, symlinked into all three harnesses. Never list it twice in `opencode.jsonc`.
- **Sessions:** `~/.claude/projects/`; `~/.local/share/opencode/opencode.db`.
- **State:** plans, ledgers and checkpoints live in `${AI_SETUP_ROOT}/state/` (on disk, never only in context).

## Dispatch Map

research (exa) · review→`code-reviewer` · tests→`tester` · QA/API/browser→`qa` · DB→`database-analyst` · Docker/systemd/network→`homelab-operator` · security→`security-reviewer` · C++/quant/money→`quant-engineer` · refactor→`implementer` · UI→`ui-designer` · Android→`android-engineer` · sweeps/plan analysis→a subagent, never the main session.

## HARD RULES

1. **MUST run the memory protocol on every prompt, as ONE parallel first message:** `search_memory` + `recall_memory(agent="build")` for the known SOT topics + the codebase-memory query, issued together; BEFORE scanning or reading multiple code files, query the `codebase-memory` MCP (project = the repo being worked on) — never re-read a codebase from scratch; after changes run `detect_changes()` / `index_repository`; non-trivial tasks end with `append_memory(topic=…)` (never `store_memory` for topic work) + a checkpoint in `${AI_SETUP_ROOT}/state/`. → Test: transcript shows the memory call, a codebase-memory call, a post-task `append_memory`.
2. **MUST use the `exa` MCP as the sole internet tool** — WebSearch/FetchURL are denied. → Test: zero non-exa web calls in transcripts.
3. **MUST delegate via dense atomic work orders + re-verify (§E4):** orders carry TASK / SCOPE / FILES / REQUIREMENTS / CONSTRAINTS / TEST / OUTPUT, point to paths + line ranges (never paste files/specs), target 1–3 files + named symbols + 1 test command; workers return STATUS / FILES MODIFIED / CHANGES / DECISIONS / RISKS / GATE EVIDENCE (`cmd → exit n`) / NEXT STEPS — a report missing these goes back once (D6); the orchestrator ALWAYS re-runs the worker's TEST itself — for non-HEAVY lanes with `run_in_background` alongside the next independent dispatch, for HEAVY/money/parity synchronously. Every order carries a wall-clock budget (45 min default, 4 h HEAVY). Detail → `rules/archive/delegation-standard.md`. → Test: dispatches carry all 7 fields; completions are followed by an executed TEST + exit code.
4. **MUST run gates as waves, once per batch:** implementation → **wave 1 in ONE message on the frozen diff:** `code-reviewer` + `tester` + `security-reviewer` (if auth/net/secrets) + `database-analyst` (if DB schema) → the orchestrator merges findings, runs ONE fix pass and re-runs only the affected tests → `qa` → Apply/Restart → Health Check; no intermediate gate loops; critical gates (money/safety/schema/parity) need one negative control. → Test: wave-1 gates appear as one multi-agent message, then `qa`, then apply.
5. **MUST pick the lane by task shape:** DIRECT = ≤3 files + 1 test command + no parallel siblings (main agent; one review pass after); MEDIUM = >3 files or a parallelizable batch (`implementer`/specialists, 4–7 wide); HEAVY = C++/quant/money/parity (`quant-engineer`; never dropped below). **Parallel by default:** independent tool calls (reads, greps, memory/codebase queries) and independent dispatches MUST go in a single message; MEDIUM = 4–7 agent calls in one message. → Test: each work order names a lane matching its trigger; independent calls share a message.
6. **MUST practice context hygiene:** never `Read` a file > ~40 KB whole — `grep -n` first, then `offset`/`limit` ≤ 250 lines; dispatch then end turn — no polling/status pings (`ListAgents`/`SendMessage`/`Monitor`); auto-compact stays 300k; state lives on disk (plan/ledger/unified-memory) — re-read the ledger after compaction; fresh session per phase over long `--resume`; temp dir `/var/tmp/claude`. **Waits:** use `run_in_background` with one terminating condition or a single notification — `sleep`/`until` poll loops are banned. **Watchdog:** per dispatch wave arm one background timer (`sleep <budget>; echo BUDGET <agent>`); if it fires before completion, inspect that agent once, then resume or re-dispatch. → Test: no whole-file Read > 40 KB; no status-poll turn; no poll loop.
7. **MUST respect autonomy tiers:** A repo edits/docs/probes = autonomous; B Docker/systemd/network = review + rollback plan; C destructive deletes/secrets/migrations = human approval. → Test: Tier B ships a rollback plan; Tier C waits for the owner.
8. **NEVER commit without owner approval:** agents never commit/push/branch; ask the owner at phase gates. → Test: zero agent-made commits in `git log`.
9. **MUST keep secrets in `.env` only**; never log/echo secret values or `.env` contents; reference keys by name. → Test: no secret material in transcripts/logs.
10. **MUST treat local-decide as advisory-only:** deterministic rules may block; GLiNER heads log/warn only; promotion to `block` only via `local-decide/eval/eval.py --promote` (FB ≤ 5 %, acc ≥ 90 %, n ≥ 40); `pii_secret`/`injection`/`complexity` are never auto-promoted; all hooks fail open. Kill switch: `rm ${AI_SETUP_ROOT}/local-decide/ENABLED && python3 ${AI_SETUP_ROOT}/scripts/sync-claude-config.py` (+ `systemctl disable --now local-decide`). Ops detail → `rules/archive/local-decide-ops.md`. → Test: ENABLED absent ⇒ generated config has no local-decide hooks.
11. **MUST plan with the owner, then run to a verified finish (ALL agents — Claude Code, OpenCode, agy, every subagent):** every non-trivial task starts with a planning phase shown to the owner BEFORE any edit or dispatch: understanding of the goal, approach + steps, assumptions, acceptance criteria + test commands, risks + tier, and **every open question** (including choices you would otherwise default). Nothing executes until the owner confirms (Claude Code: plan mode + AskUserQuestion + ExitPlanMode; OpenCode: the `plan` agent + question tool; agy: same text). Ask all ambiguities in ONE AskUserQuestion batch; NEVER guess a requirement, value, path or ruling. Exempt: single read-only lookups and explicit one-line instructions — still ask when anything is unclear. After confirmation, run to a verified finish without stopping early; pause only for Tier C or owner-only facts, and keep every unblocked sibling running meanwhile. Subagents cannot reach the owner: their "Plan check" step returns `STATUS: NEEDS_OWNER` with the exact question; the orchestrator relays it and never answers for the owner. → Test: a vague task gets questions before any edit; no subagent report contains a guessed requirement.

## Definition of DONE (every task)

Every acceptance criterion checked off · GATE EVIDENCE `cmd → exit n` for each changed file group · no TODO/PARTIAL left unless `NEEDS_OWNER` · `append_memory` + a checkpoint in `${AI_SETUP_ROOT}/state/` written · the final reply states verified vs unverified explicitly.

## Zero Hardcoded / Mocked Data Rule (MANDATORY across ALL projects)

- **STRICT PROHIBITION**: NEVER hardcode KPI values (CAGR, Profit Factor, Win Rate, MaxDD, Sharpe, etc.), business metrics, mock fallbacks (e.g. `?? 358.46`, `?? 4.44`), or offline benchmark placeholders in any frontend component, page, or API route.
- **REAL DATA SOURCE OF TRUTH**: ALL metrics, performance charts, ledgers and heatmaps MUST be calculated dynamically from authoritative database queries. If records are empty or missing, display proper empty/loading states (`0`, `null`, or "No Data Recorded in Database") — NEVER substitute mock or simulated numbers.
