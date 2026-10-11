# Local-first AI agent setup — Claude Code + OpenCode + web UI + agy

A complete, self-hosted AI coding environment for a single Linux host: one rules file that all
agents obey, one roster of 11 specialist subagents reused by three CLIs, one MCP host, one shared
memory store, an advisory local decision layer, and an optional browser/phone UI with a Gemini Live
voice call.

Everything runs on your machine; the only external dependencies are the model providers you
configure and the MCP servers you enable.

## Architecture

```text
claude   (wrapper) ──ANTHROPIC_BASE_URL──▶ claude-router :3920 ──▶ Anthropic (subscription, then ANTHROPIC_API_KEY)
                                                    └──────────────▶ OpenCode Go (deepseek-v4.1-flash)
opencode (wrapper) ─────────────────────▶ OpenCode CLI ──▶ opencode-go / anthropic providers
agy CLI            ─────────────────────▶ Google Gemini (native OAuth)

all harnesses ──▶ opencode-hub :8790 (the single MCP host: 11 servers, token-guarded)
                    ├─▶ unified-memory (PostgreSQL + pgvector; embeddings :11437)
                    ├─▶ local-decide   :11438 (GLiNER2.5 + deterministic rules, advisory hooks)
                    └─▶ exa, playwright, postgres, cloudflare, codebase-memory, gcloud, testsprite,
                        sequential-thinking, mcp-reasoner

CloudCLI web UI :3011 ──▶ Claude Code sessions in a browser; voice-gateway :3012 mints
                          short-lived Gemini Live tokens for the one-button voice call
```

| Component | Default bind | Purpose |
| --- | --- | --- |
| `claude-router` | `127.0.0.1:3920` | Anthropic-protocol proxy: model lanes, one-hop fallbacks, compaction, keep-warm |
| `opencode-hub` | `:8790` (loopback + private networks) | runs every MCP server exactly once and multiplexes them to all clients |
| `local-decide` | `127.0.0.1:11438` | advisory decide/rerank API + MCP: deterministic rules, GLiNER heads |
| `llama-rerank` / `llama-rerank-4b` / `llama-embed` | `11435` / `11439` / `11437` | local inference for the rerankers and memory embeddings |
| PostgreSQL + pgvector | `:5432` | unified memory backend |
| CloudCLI | `127.0.0.1:3011` | browser UI for Claude Code sessions (put your own tunnelled access proxy in front) |
| `voice-gateway` | `127.0.0.1:3012` | optional: Gemini Live ephemeral tokens; the provider key never leaves the host |

Subagents, skills and rules are written once and generated into each harness's native format, so
Claude Code, OpenCode and agy share one source of truth.

## Repository layout

```
rules/            AGENTS.md (the rules every agent obeys) + archive/ (delegation standard, local-decide ops)
bin/              claude and opencode wrappers (installed to ~/.local/bin; CLAUDE_CLI_PATH / OPENCODE_BIN pick the CLI)
subagents/        the 11 canonical subagent definitions (source of truth)
claude-agents/    generated Claude Code agent files
opencode-agents/  generated OpenCode agent files
claude-router/    server.js (lanes, fallbacks, compaction), keepwarm.js, context-shaping.js, test/
opencode/         opencode.jsonc.template (rendered by install.sh) + plugins (sync wiring, parity hooks)
scripts/          sync-all-agents.py, sync-claude-config.py, sync-opencode-agents.py, hooks/
commands/         slash commands (checkpoint, cost, gate, save/resume session)
skills/           on-demand skill playbooks, symlinked into every harness
mcp/              *.example.json templates; install.sh renders mcp_servers.json (launch definitions + secrets) and mcp_config.json
package.json      Node dependencies of the MCP servers launched from mcp/mcp_servers.json (npm install)
opencode-hub/     the MCP hub, migrate-mcp-config.py, switch-clients.sh, gen-hub-content.py (builds public/ from mac/homelab-bridge.ts)
unified-memory/   MCP server + PostgreSQL/pgvector client
local-decide/     engine, policy rules (YAML), eval/, MCP server
voice-gateway/    Gemini Live token service (optional)
cloudcli/         pinned CloudCLI version (package.json), install.sh, patches/ (see cloudcli/README.md)
cloudcli-voice/   the voice add-on for the CloudCLI chat bar (optional)
systemd/          unit files for every service
```

## Prerequisites

- Linux with systemd, run as root or with sudo
- Python 3.12, Node.js 22+, git
- PostgreSQL 16 with the `pgvector` extension
- 16 GB RAM recommended (CPU-only by default; no GPU required)

## Install

```sh
cp .env.example .env          # then fill in the keys below and chmod 600 .env
npm install                   # the Node MCP servers mcp/mcp_servers.json launches (see package.json)
./install.sh --dry-run        # prints every action, changes nothing
./install.sh                  # user-space install: wrappers, agent trees, rule symlinks, skills, MCP config
./install.sh --with-services  # additionally installs and starts the systemd units (Tier B: review the units, keep the rollback command)
```

`install.sh` renders `mcp/mcp_servers.json` from `mcp/mcp_servers.example.json` and substitutes only
`${AI_SETUP_ROOT}`. Every other `${...}` placeholder in the template (`POSTGRES_CONNECTION_STRING`,
`DISPLAY`, `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`, `CLOUDSDK_CORE_DISABLE_PROMPTS`, `LOCAL_DECIDE_URL`, …)
is left exactly as written and has to be filled in by hand for your host.

Re-running `install.sh` is safe: every sync script is idempotent (`python3 scripts/sync-all-agents.py --check`
verifies the generated files match their source).

## Required `.env` keys (names only)

| Key | Used by |
| --- | --- |
| `ANTHROPIC_API_KEY` | router: retry of the main/compaction lanes when the subscription is rate-limited |
| `OPENCODE_GO_API_KEY` | router OpenCode Go lane, OpenCode CLI |
| `EXA_API_KEY` | the `exa` MCP server (the only internet tool agents are allowed to use) |
| `GEMINI_API_KEY` (alias `GOOGLE_GENERATIVE_AI_API_KEY`) | `voice-gateway` Gemini Live tokens |

Optional: `AI_SETUP_ROOT`, `AI_SETUP_DOMAIN`, `ROLE_PLAN_<ROLE>`, `SUBAGENT_PRIMARY`, `ROUTER_KEEPWARM`,
`OPENCODE_HUB_PORT` / `OPENCODE_HUB_BIND` / `OPENCODE_HUB_URL` / `OPENCODE_HUB_ALLOWED_HOSTS`,
`VOICE_LIVE_MODEL` / `VOICE_LIVE_VOICE` / `VOICE_LIVE_LANG`, `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN`
(origin-side JWT check for the UI and voice routes), `CLAUDE_CLI_PATH`, `OPENCODE_BIN`,
`OPENCODE_HUB_ALLOWED_NETS` (rendered into the hub unit; default `127.0.0.0/8`),
`CLOUDCLI_BROWSER_USE_MCP_TOKEN` (CloudCLI's browser-use MCP token, read by `opencode.jsonc`),
`CLOUDFLARE_ACCOUNT_ID` (cloudflare MCP server), `CF_ACCOUNT_ID` / `CF_ZONE_ID` / `CF_TUNNEL_ID`
(the optional `cloudcli/*.sh` tunnel and DNS helpers).

Never commit `.env`; every component reads secrets from the environment or a systemd credential file.

## Changing models

1. **Router lanes** — set `ROLE_PLAN_<ROLE>` in `claude-router/.env` as
   `"<target>:<model>:<fallback>:<effort>"` with target `opencode-go` or `anthropic`, e.g.
   `ROLE_PLAN_IMPLEMENTER="opencode-go:deepseek-v4.1-flash:claude-haiku-5-5:max"`, then restart
   `claude-router`. Unknown targets are ignored with a warning. `SUBAGENT_PRIMARY=opencode-go` forces
   every role onto OpenCode Go with no per-role plan (emergency switch). Defaults live in
   `DEFAULT_ROLE_PLAN` / `COMPACTION_PLAN` in `claude-router/server.js`.
2. **OpenCode subagents** — change `MODEL` in `scripts/sync-opencode-agents.py` and run
   `python3 scripts/sync-all-agents.py`.
3. **OpenCode itself** — `model`, `small_model` and the `plan` agent's `model` in `~/.config/opencode/opencode.jsonc`
   (rendered once from `opencode/opencode.jsonc.template`; delete it and re-run `install.sh` to re-render).

## Adding an MCP server

1. Add the launch definition (and its secrets) to `mcp/mcp_servers.json` — keep it `0600`, the hub is
   the only reader.
2. `python3 opencode-hub/migrate-mcp-config.py` regenerates the clients' `mcp_config.json` (hub URLs only).
3. `systemctl restart opencode-hub`.
4. `python3 scripts/sync-claude-config.py` re-injects the server list into the Claude Code config.

Revert the client wiring with `opencode-hub/switch-clients.sh --revert`.

## Verification

| Command | Checks |
| --- | --- |
| `node --test claude-router/test/*.test.js` | router lanes, fallbacks, auth headers, usage log |
| `cd scripts/hooks && python3 -m pytest -q tests` | every hook (fail-open behaviour included) |
| `python3 -m pytest -q opencode-hub/tests` | hub auth, tokens, config migration |
| `cd scripts && python3 -m pytest -q tests/test_sync_claude_config_idempotence.py` | config generation is idempotent |
| `python3 scripts/sync-all-agents.py --check` | generated agent trees match their source |
| `cd local-decide && python3 -m pytest -q tests` | decision policy + rules (needs the venv with fastapi) |
| `cd unified-memory && python3 -m pytest -q tests` | memory server |
| `cd voice-gateway && python3 -m pytest -q` | voice token service |
| `cd cloudcli-voice && node --test test/*.test.mjs` | voice add-on |
| `curl -s http://127.0.0.1:3920/health` | router alive |
| `curl -s http://127.0.0.1:8790/health` | hub alive + per-server health |
| `curl -s http://127.0.0.1:11438/health` | local-decide alive (models loaded) |
| `curl -s http://127.0.0.1:3012/voice/health` | voice gateway configured (`live` flag) |

## Security notes

- Secrets live only in `.env` (0600) or systemd credential files; agents are instructed never to log,
  echo or read `.env` contents, and the generated Claude Code config denies `Read` on `.env`.
- The hub binds to loopback plus explicitly allowed networks and requires a token on every route except
  `/health`; MCP launch secrets never reach clients.
- `local-decide` is advisory: deterministic rules may block, model heads only log/warn, and every hook
  fails open. Its kill switch is documented in `rules/AGENTS.md` (HARD RULE 10).
- The optional web UI and voice routes verify a Cloudflare Access JWT at the origin when
  `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` are set; the voice token endpoint mints single-use,
  short-lived tokens and never exposes the provider key to the browser.
- Agents never commit, push or branch without explicit owner approval.

## License

MIT — see `LICENSE`.
