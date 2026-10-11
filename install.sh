#!/usr/bin/env bash
# install.sh — user-space install of this AI agent setup.
#
#   ./install.sh --dry-run        print every action, change nothing
#   ./install.sh                  wrappers, agent trees, rules links, skills, MCP config
#   ./install.sh --with-services  also render + enable the systemd units (Tier B: review them first)
#
# Idempotent: every link and rendered file is compared before it is written, so a second run is a no-op.
set -euo pipefail

AI_SETUP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AI_SETUP_ROOT
# The sync scripts default to the account's passwd home; pin them to the HOME this install targets.
export AI_SETUP_HOME="${AI_SETUP_HOME:-$HOME}"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
OPENCODE_HOME="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"

DRY_RUN=0
WITH_SERVICES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-services) WITH_SERVICES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  %s\n' "$*"
    "$@"
  fi
}

say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- prerequisites
say "prerequisites"
missing=0
for bin in node python3; do
  if command -v "$bin" >/dev/null 2>&1; then
    printf '  ok      %s (%s)\n' "$bin" "$($bin --version 2>&1 | head -1)"
  else
    printf '  MISSING %s\n' "$bin"; missing=1
  fi
done
for bin in claude opencode; do
  if command -v "$bin" >/dev/null 2>&1; then
    printf '  ok      %s (%s)\n' "$bin" "$(command -v "$bin")"
  else
    printf '  note    %s not on PATH (install the CLI, then re-run)\n' "$bin"
  fi
done
[ "$missing" = 0 ] || { echo "install: node and python3 are required" >&2; exit 1; }
printf '  root    %s\n' "$AI_SETUP_ROOT"

# ---------------------------------------------------------------- .env
say "secrets file"
if [ -f "$AI_SETUP_ROOT/.env" ]; then
  printf '  keep    %s (never overwritten)\n' "$AI_SETUP_ROOT/.env"
else
  run install -m 0600 "$AI_SETUP_ROOT/.env.example" "$AI_SETUP_ROOT/.env"
  printf '  fill    %s with your provider keys (mode 0600, never committed)\n' "$AI_SETUP_ROOT/.env"
fi

# ---------------------------------------------------------------- wrappers
say "CLI wrappers -> $LOCAL_BIN"
run mkdir -p "$LOCAL_BIN"
for w in claude opencode; do
  src="$AI_SETUP_ROOT/bin/$w"; dst="$LOCAL_BIN/$w"
  if [ -f "$src" ]; then
    if [ "$DRY_RUN" = 0 ]; then install -m 0755 "$src" "$dst"; else printf '  [dry-run] install %s -> %s\n' "$src" "$dst"; fi
  fi
done

# ---------------------------------------------------------------- links
link() {  # link <target> <linkpath>
  local target="$1" linkpath="$2"
  if [ -L "$linkpath" ] && [ "$(readlink "$linkpath")" = "$target" ]; then
    printf '  ok      %s -> %s\n' "$linkpath" "$target"
    return
  fi
  if [ -e "$linkpath" ] && [ ! -L "$linkpath" ]; then
    printf '  backup  %s -> %s.bak.install\n' "$linkpath" "$linkpath"
    [ "$DRY_RUN" = 1 ] || mv "$linkpath" "$linkpath.bak.install"
  fi
  run ln -sfn "$target" "$linkpath"
}

say "rules -> Claude Code"
run mkdir -p "$CLAUDE_HOME"
link "$AI_SETUP_ROOT/rules/AGENTS.md" "$CLAUDE_HOME/CLAUDE.md"

say "agent trees, skills, commands"
run mkdir -p "$CLAUDE_HOME/commands" "$OPENCODE_HOME/command"
link "$AI_SETUP_ROOT/claude-agents" "$CLAUDE_HOME/agents"
link "$AI_SETUP_ROOT/opencode-agents" "$OPENCODE_HOME/agents"
link "$AI_SETUP_ROOT/skills" "$CLAUDE_HOME/skills"
for c in "$AI_SETUP_ROOT"/commands/*.md; do
  [ -e "$c" ] || continue
  base="$(basename "$c")"
  link "$c" "$CLAUDE_HOME/commands/$base"
  link "$c" "$OPENCODE_HOME/command/$base"
done

say "OpenCode config"
# values envsubst needs a concrete default for (the template has no shell syntax of its own)
export AI_SETUP_USER="${AI_SETUP_USER:-$(id -un)}"
export OPENCODE_GO_BASE_URL="${OPENCODE_GO_BASE_URL:-https://opencode.ai/go}"
export OPENCODE_HUB_ALLOWED_NETS="${OPENCODE_HUB_ALLOWED_NETS:-127.0.0.0/8}"
run mkdir -p "$OPENCODE_HOME/plugin"
for p in sync-shared.ts quota-wait.ts; do
  [ -e "$AI_SETUP_ROOT/opencode/plugin/$p" ] && link "$AI_SETUP_ROOT/opencode/plugin/$p" "$OPENCODE_HOME/plugin/$p"
done
for f in parity-hooks.ts package.json tui.json; do
  [ -e "$AI_SETUP_ROOT/opencode/$f" ] && link "$AI_SETUP_ROOT/opencode/$f" "$OPENCODE_HOME/$f"
done
if [ -f "$OPENCODE_HOME/opencode.jsonc" ]; then
  printf '  keep    %s (already rendered; delete it to re-render)\n' "$OPENCODE_HOME/opencode.jsonc"
else
  if command -v envsubst >/dev/null 2>&1; then
    if [ "$DRY_RUN" = 1 ]; then
      printf '  [dry-run] envsubst < opencode/opencode.jsonc.template > %s\n' "$OPENCODE_HOME/opencode.jsonc"
    else
      envsubst < "$AI_SETUP_ROOT/opencode/opencode.jsonc.template" > "$OPENCODE_HOME/opencode.jsonc"
      chmod 600 "$OPENCODE_HOME/opencode.jsonc"
      printf '  wrote   %s\n' "$OPENCODE_HOME/opencode.jsonc"
    fi
  else
    echo "  WARN envsubst (gettext) not found: render opencode.jsonc.template by hand" >&2
  fi
fi

say "MCP config (hub clients)"
render_mcp_example() {  # render_mcp_example <name> <mode>: mcp/<name>.example.json -> mcp/<name>.json
  local name="$1" mode="$2"
  local src="$AI_SETUP_ROOT/mcp/$name.example.json" dst="$AI_SETUP_ROOT/mcp/$name.json"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] render %s -> %s (mode %s)\n' "$src" "$dst" "$mode"
    return 0
  fi
  # The examples carry ${AI_SETUP_ROOT} in command/args values. The variable list is restricted to it:
  # a bare envsubst would also blank $PATH, $DISPLAY and the $(grep ...) substitutions they rely on.
  if command -v envsubst >/dev/null 2>&1; then
    envsubst '${AI_SETUP_ROOT}' < "$src" > "$dst"
  else
    printf '  note    envsubst (gettext) not found: substituting with sed\n'
    sed -e "s|\${AI_SETUP_ROOT}|$AI_SETUP_ROOT|g" "$src" > "$dst"
  fi
  chmod "$mode" "$dst"
  printf '  wrote   %s (mode %s)\n' "$dst" "$mode"
}
if [ ! -e "$AI_SETUP_ROOT/mcp/mcp_config.json" ]; then
  render_mcp_example mcp_config 0644
fi
if [ -f "$AI_SETUP_ROOT/mcp/mcp_servers.json" ]; then
  printf '  keep    mcp/mcp_servers.json exists\n'
else
  render_mcp_example mcp_servers 0600
  printf '  fill    mcp/mcp_servers.json with your provider keys (mode 0600)\n'
fi

# ---------------------------------------------------------------- generate
say "generated agent trees + hook config"
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] python3 scripts/sync-all-agents.py\n'
  printf '  [dry-run] python3 opencode-hub/gen-hub-content.py\n'
else
  python3 "$AI_SETUP_ROOT/scripts/sync-all-agents.py"
  # the hub serves opencode-hub/public/ (plugin tarball + well-known config) and will not start without it
  python3 "$AI_SETUP_ROOT/opencode-hub/gen-hub-content.py"
fi

# ---------------------------------------------------------------- services
if [ "$WITH_SERVICES" = 1 ]; then
  say "systemd units (Tier B: review them; rollback = systemctl disable --now <unit>)"
  if [ ! -d /etc/systemd/system ]; then
    echo "  SKIP no /etc/systemd/system on this host" >&2
  else
    for unit in "$AI_SETUP_ROOT"/systemd/*.service; do
      [ -e "$unit" ] || continue
      name="$(basename "$unit")"
      if [ "$DRY_RUN" = 1 ]; then
        printf '  [dry-run] render %s -> /etc/systemd/system/%s\n' "$unit" "$name"
      else
        if command -v envsubst >/dev/null 2>&1; then
          envsubst < "$unit" > "/etc/systemd/system/$name"
        else
          sed -e "s|\${AI_SETUP_ROOT}|$AI_SETUP_ROOT|g" -e "s|\${HOME}|$HOME|g" -e "s|\${USER}|$(id -un)|g" \
              -e "s|\${AI_SETUP_DOMAIN}|${AI_SETUP_DOMAIN:-}|g" -e "s|\${CF_ACCESS_AUD}|${CF_ACCESS_AUD:-}|g" \
              -e "s|\${CF_ACCESS_TEAM_DOMAIN}|${CF_ACCESS_TEAM_DOMAIN:-}|g" \
              -e "s|\${OPENCODE_HUB_ALLOWED_NETS}|${OPENCODE_HUB_ALLOWED_NETS:-127.0.0.0/8}|g" \
              "$unit" > "/etc/systemd/system/$name"
        fi
        printf '  wrote   /etc/systemd/system/%s\n' "$name"
      fi
      dropdir="$AI_SETUP_ROOT/systemd/$name.d"
      if [ -d "$dropdir" ]; then
        run mkdir -p "/etc/systemd/system/$name.d"
        for drop in "$dropdir"/*.conf; do
          [ -e "$drop" ] || continue
          if [ "$DRY_RUN" = 1 ]; then
            printf '  [dry-run] render %s\n' "$drop"
          else
            if command -v envsubst >/dev/null 2>&1; then
              envsubst < "$drop" > "/etc/systemd/system/$name.d/$(basename "$drop")"
            else
              sed -e "s|\${AI_SETUP_ROOT}|$AI_SETUP_ROOT|g" -e "s|\${HOME}|$HOME|g" -e "s|\${USER}|$(id -un)|g" \
                  -e "s|\${OPENCODE_HUB_ALLOWED_NETS}|${OPENCODE_HUB_ALLOWED_NETS:-127.0.0.0/8}|g" \
                  "$drop" > "/etc/systemd/system/$name.d/$(basename "$drop")"
            fi
            printf '  wrote   /etc/systemd/system/%s.d/%s\n' "$name" "$(basename "$drop")"
          fi
        done
      fi
    done
    if [ "$DRY_RUN" = 0 ]; then
      systemctl daemon-reload
      for unit in "$AI_SETUP_ROOT"/systemd/*.service; do
        [ -e "$unit" ] || continue
        name="$(basename "$unit")"
        if systemctl list-unit-files "$name" >/dev/null 2>&1; then
          systemctl enable --now "$name" || printf '  WARN %s did not start (check its .env keys)\n' "$name" >&2
        fi
      done
    fi
  fi
else
  say "services"
  printf '  skipped (pass --with-services to render, enable and start them)\n'
fi

printf '\ninstall: done (%s)\n' "$([ "$DRY_RUN" = 1 ] && echo 'dry-run, nothing changed' || echo "root=$AI_SETUP_ROOT")"
printf 'next: fill .env, then run the verification commands in README.md\n'
