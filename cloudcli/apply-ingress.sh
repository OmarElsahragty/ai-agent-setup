#!/usr/bin/env bash
# Applies the staged tunnel ingress for ${AI_SETUP_DOMAIN} (CloudCLI 3011, /voice/ 3012).
# ORDERING (security-critical): refuses to run unless
#   1) ${AI_SETUP_DOMAIN} resolves (DNS CNAME to the tunnel exists), and
#   2) https://${AI_SETUP_DOMAIN} redirects to cloudflareaccess.com (Access app live)
# so the Access application is ALWAYS verified before ingress is added.
set -euo pipefail
AI_SETUP_ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BK="${AI_SETUP_ROOT}/cloudcli/backups"
STAGED="$BK/ingress-staged-agent.json"
API=https://api.cloudflare.com/client/v4
set -a; . ${AI_SETUP_ROOT}/.env; set +a
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID missing in ${AI_SETUP_ROOT}/.env (Cloudflare account id)}"
ACC="${CF_ACCOUNT_ID}"
TID="${CF_TUNNEL_ID}"
# Tunnel config needs Account:Cloudflare Tunnel:Edit (CF_DNS_API_TOKEN is DNS-only, 401 here)
TOK="${CLOUDFLARE_API_TOKEN:-$CF_API_TOKEN}"

echo "[1/4] DNS resolution check"
# C7 NIT: A records only — a CNAME/AAAA answer must not pass the gate.
{ getent hosts ${AI_SETUP_DOMAIN} || dig +short A ${AI_SETUP_DOMAIN} @1.1.1.1 | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; } >/dev/null || { echo "FAIL: ${AI_SETUP_DOMAIN} has no A record. Run add-dns.sh first (needs CF_DNS_API_TOKEN)."; exit 1; }

echo "[2/4] Cloudflare Access verification (expect 302 to cloudflareaccess.com)"
# Local resolver (AdGuard) may still cache the pre-CNAME NXDOMAIN; pin a public answer if so.
# C7 NIT: --resolve needs an IP, so filter the dig answer down to A records only.
RES=(); getent hosts ${AI_SETUP_DOMAIN} >/dev/null || RES=(--resolve "${AI_SETUP_DOMAIN}:443:$(dig +short A ${AI_SETUP_DOMAIN} @1.1.1.1 | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | head -1)")
loc=$(curl -sI "${RES[@]}" https://${AI_SETUP_DOMAIN} | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
code=$(curl -sI "${RES[@]}" -o /dev/null -w '%{http_code}' https://${AI_SETUP_DOMAIN})
echo "HTTP $code Location: ${loc:-<none>}"
case "$loc" in *cloudflareaccess.com*) : ;; *) echo "FAIL: Access login redirect not present — ingress NOT applied."; exit 1 ;; esac

echo "[3/4] Backup current tunnel config"
TS=$(date +%Y%m%d-%H%M%S)
curl -sS -H "Authorization: Bearer $TOK" "$API/accounts/$ACC/cfd_tunnel/$TID/configurations" -o "$BK/tunnel-config-preapply-$TS.json"
jq -c '{success, ingress: (.result.config.ingress | length)}' "$BK/tunnel-config-preapply-$TS.json"

echo "[3b] Guard: staged config must keep every live hostname (PUT replaces the whole config)"
missing=$(jq -n --slurpfile live "$BK/tunnel-config-preapply-$TS.json" --slurpfile stg "$STAGED" \
  '[$live[0].result.config.ingress[].hostname // empty] - [$stg[0].config.ingress[].hostname // empty]')
[ "$missing" = "[]" ] || { echo "FAIL: staged config would drop live hostnames: $missing"; exit 1; }
jq -e '.config.ingress[-1].hostname == null' "$STAGED" >/dev/null || { echo "FAIL: last rule must be the catch-all"; exit 1; }

echo "[4/4] PUT staged ingress"
code=$(curl -sS -o /tmp/cf-tunnel-put.json -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  --data @"$STAGED" "$API/accounts/$ACC/cfd_tunnel/$TID/configurations")
echo "TUNNEL PUT HTTP $code"; jq -c '{success, errors: [.errors[]?.message], ingress: [.result.config.ingress[]? | {hostname, path, service}]}' /tmp/cf-tunnel-put.json
echo "Remote-managed tunnel hot-reloads; no cloudflared restart needed."
echo "Rollback: bash ${AI_SETUP_ROOT}/cloudcli/rollback-tunnel.sh $TS"
