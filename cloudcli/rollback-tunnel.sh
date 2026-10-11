#!/usr/bin/env bash
# Restores a backed-up tunnel configuration. Usage: rollback-tunnel.sh <timestamp>
# (timestamp = suffix of backups/tunnel-config-preapply-<ts>.json or tunnel-config-<ts>.json)
set -euo pipefail
AI_SETUP_ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TS="${1:?usage: rollback-tunnel.sh <timestamp>}"
BK="${AI_SETUP_ROOT}/cloudcli/backups"
API=https://api.cloudflare.com/client/v4
set -a; . ${AI_SETUP_ROOT}/.env; set +a
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID missing in ${AI_SETUP_ROOT}/.env (Cloudflare account id)}"
ACC="${CF_ACCOUNT_ID}"
TID="${CF_TUNNEL_ID}"
TOK="${CLOUDFLARE_API_TOKEN:-$CF_API_TOKEN}"
SRC="$BK/tunnel-config-preapply-$TS.json"; [ -f "$SRC" ] || SRC="$BK/tunnel-config-$TS.json"
[ -f "$SRC" ] || { echo "no backup for $TS"; exit 1; }
jq '{config: .result.config}' "$SRC" > /tmp/cf-tunnel-restore.json
code=$(curl -sS -o /tmp/cf-tunnel-restore-resp.json -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  --data @/tmp/cf-tunnel-restore.json "$API/accounts/$ACC/cfd_tunnel/$TID/configurations")
echo "RESTORE PUT HTTP $code"; jq -c '{success, errors: [.errors[]?.message], ingress: [.result.config.ingress[]? | {hostname, service}]}' /tmp/cf-tunnel-restore-resp.json
