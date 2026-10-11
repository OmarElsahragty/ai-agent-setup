# Skills Library
> Reusable playbooks promoted from successful agent runs. Each skill is a self-contained instruction set for a recurring task type.

## Promotion Criteria
A run may be promoted to a skill when ALL of the following are true:
1. The task succeeded end-to-end with verified output
2. The task is likely to recur (same service, same pattern)
3. The steps are deterministic (same inputs → same safe outputs)
4. The rollback path is captured

## Skill Format
See `_template.md` for the canonical format.

## Naming Convention
`<verb>-<noun>.md` — e.g., `restart-service.md`, `rebuild-docker-image.md`, `rotate-secret.md`

## Index
| Skill | Purpose | Tier | Last Verified |
|---|---|---|---|---|
| `n8n-cli-access.md` | Modify, activate, export/import n8n workflows via CLI and REST API without the web editor | A | 2026-05-20 |
<!-- Append rows as skills are added -->
