# Skill: search-first
> Promoted from a local session plan (WO-5)
> Tier: A | Last verified: 2026-10-07

## Purpose
Research the existing system before writing new code: prefer reuse over reinvention.

## Prerequisites
- [ ] A task that may add a new file, script, tool or dependency

## Triggers
- Before creating any new module, script, helper or wrapper
- Before introducing a dependency or copying a pattern from elsewhere

## Allowed Scopes
Read-only: ${AI_SETUP_ROOT} (skills, scripts, subagents), MCP tools, unified-memory.

## Required Tools
- `codebase-memory` MCP — graph search for symbols/files/callers
- `unified-memory` MCP — prior SOT entries
- `bash` — ls/grep over ${AI_SETUP_ROOT} only

## Steps (the ladder — stop at the first hit)
1. **Preflight tool availability** — `list_projects` on codebase-memory; if the project is
   missing or stale, fall back to targeted `grep -n` (never whole-tree reads).
2. **codebase-memory first** — `search_code` / `search_graph` / `get_code_snippet` for the
   symbol, file or relationship. Local code beats internet answers.
3. **Existing assets** — check `${AI_SETUP_ROOT}/skills/`, `${AI_SETUP_ROOT}/scripts/`,
   `${AI_SETUP_ROOT}/subagents/` for a skill or script that already does it.
4. **Prior knowledge** — `search_memory` for an existing SOT topic before writing a new one.
5. **exa MCP — internet, and ONLY exa** (WebSearch/WebFetch are denied). Use for upstream
   docs/changelogs only; cite the URL.

## Decision
Adopt (use as-is) > Extend (edit in place) > Compose (combine) > Build (last resort, state why
the ladder failed). Record the choice in the task report.

## Validation
The plan or report cites file:line for every reused asset and names the ladder step that hit.

## Rollback
None — read-only skill.

## Notes
Never re-read a codebase from scratch when codebase-memory has it indexed. New net-new code
must say why steps 2–4 missed.
