# Local-Decide & CLI Ops (archive)

Detail behind core `AGENTS.md` HARD RULE 10.

## Local Decision Layer

- **local-decide** (`${AI_SETUP_ROOT}/local-decide/`, daemon `local-decide.service` 127.0.0.1:11438; rerankers `llama-rerank` :11435 (0.6B) and `llama-rerank-4b` :11439): GLiNER2.5 heads + deterministic rules behind Claude Code http hooks, the OpenCode `sync-shared.ts` plugin and agy's `hooks.json`; MCP `local-decide` (`decide`, `multi_check`, `rerank`, `select_browser_action`, `prune_preview`). All hooks fail open. Ledger + eval: `${AI_SETUP_ROOT}/state/local-decide/` (`LEDGER.md`, `eval-report.md`). Kill switch: `rm ${AI_SETUP_ROOT}/local-decide/ENABLED && python3 ${AI_SETUP_ROOT}/scripts/sync-claude-config.py` (+ `systemctl disable --now local-decide`).
- **Deterministic rules block; GLiNER heads only log/warn.** A head is promoted to `block` only by `local-decide/eval/eval.py --promote` (FB ≤ 5 %, acc ≥ 90 %, n ≥ 40; the labelled cases are not shipped, see `local-decide/eval/README.md`); `pii_secret`, `injection`, `complexity` are never auto-promoted. GLiNER is a triage signal, never a gate — §E4 re-running the TEST stays the gate.
- **Memory injection (D1)** is just-in-time: a snippet is injected at most once per session and only when the 0.6B reranker scores it ≥ 0.5 (≈ ≤ 1.5k tokens). If it ever hurts, set `memory.min_rerank_score: 1.01` in `local-decide/rules/`.
- **Code search:** use the `fast-explore` skill (ripgrep + embeddings RRF, no reranker by default — the code-location eval showed the rerankers add no points) before broad grep sweeps.
- **Router context shaping:** D10 (compaction pruning) and D12 (observation masking) stay OFF — masking every 20 turns costs more than it saves at the cache-read price of a frontier model, and the retention head false-drops most must-keep lines. Keep-warm (`ROUTER_KEEPWARM=1`) pings an idle main session at 55 min (stops at 12 h); `[KEEPWARM-MISS]` in the router journal means turn it off.

## Claude Code temp dir

`/var/tmp/claude` (disk) via `CLAUDE_CODE_TMPDIR` in the `claude` wrapper + generated `settings.json` — a runaway test log must never fill the RAM-backed `/tmp` (that fills the disk once and gives every session ENOSPC).

## Misc behavior rules

- **Rules:** test before apply; secrets in `.env` only; no proactive commits; write findings to `state/`; emit what changed / learned / failed per run.
- **Skills:** on-demand loading. Available skill directories are listed in `skills/` (e.g. `git-workflow`, `fast-explore`, `systematic-debugging`, `test-driven-development`, `homelab`, `subagent-driven-development`).

## OpenCode tuning (live values: `opencode.jsonc`)

- Auto-compact at 300k tokens (`limit.input` 1,048,576 on the flash model − `compaction.reserved` 748,576; prune, `tail_turns` 8, `preserve_recent_tokens` 40k) with a structured 8-section compactor prompt (goal, hard rules, state on disk, progress + gate evidence, decisions, open issues, files, next step).
- Stream stalls abort after 3 min without headers / 5 min without a chunk (`headerTimeout` / `chunkTimeout` in `opencode.jsonc`; large values here were the "OpenCode gets stuck" root cause).
- Providers are limited to `opencode-go` and `anthropic`. `model` and `small_model` are `opencode-go/deepseek-v4.1-flash`; the `plan` agent is the single Anthropic exception (`anthropic/claude-opus-5-5`).
- The OpenCode web UI unit stays disabled by choice; the weekly maintenance timer prunes the event log and runs VACUUM.
