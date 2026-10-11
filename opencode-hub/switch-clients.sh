#!/usr/bin/env bash
# Point the server's own MCP clients (Claude Code, OpenCode, agy) at opencode-hub, so each MCP runs once
# (owner ruling 2026-10-05). Needs a healthy hub. New client sessions use the hub; running sessions keep
# their stdio children until they end.
#   switch-clients.sh            switch    (backups: mcp_config.pre-hub.json, sync-shared.ts.pre-hub)
#   switch-clients.sh --revert   back to one stdio process per client session
set -euo pipefail
ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="$ROOT/opencode-hub"
PLUGIN="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugin/sync-shared.ts"

if [ "${1:-}" = "--revert" ]; then
  rc=0
  python3 "$DEST/migrate-mcp-config.py" --revert || rc=$?   # keep going: restore the plugin regardless
  if [ -e "$PLUGIN.pre-hub" ]; then cp -p "$PLUGIN.pre-hub" "$PLUGIN"; fi
  python3 "$ROOT/scripts/sync-claude-config.py"
  [ "$rc" -eq 0 ] && echo "reverted: new sessions start their own stdio MCPs again"
  exit "$rc"
fi

curl -sf http://127.0.0.1:8790/health >/dev/null || { echo "opencode-hub is not healthy; not switching" >&2; exit 1; }
# OpenCode probes remote MCPs for OAuth unless told not to; the hub has no OAuth (at most a static bearer
# token, audit F3 / WO-6, which every client reads from the token file when its config is generated)
if ! grep -q 'oauth: false as const' "$PLUGIN"; then
  [ -e "$PLUGIN.pre-hub" ] || cp -p "$PLUGIN" "$PLUGIN.pre-hub"
  python3 - "$PLUGIN" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "      headers: server.headers,\n      enabled: true,"
assert s.count(old) == 1, "sync-shared.ts convert() changed: patch it by hand"
open(p, "w").write(s.replace(old, "      headers: server.headers,\n      oauth: false as const,\n      enabled: true,"))
PY
fi
# WO-6: OpenCode adds the hub bearer header from the token file at its start (idempotent; no file = no header)
python3 "$DEST/patch-sync-shared.py" "$PLUGIN"
python3 "$DEST/migrate-mcp-config.py"
python3 "$ROOT/scripts/sync-claude-config.py"
echo "switched: new sessions use http://127.0.0.1:8790/mcp/<name>"
