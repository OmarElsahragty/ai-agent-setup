#!/usr/bin/env bash
# Creates the DNS CNAME ${AI_SETUP_DOMAIN} -> <tunnel>.cfargotunnel.com (proxied).
# Requires a Cloudflare API token with Zone : DNS : Edit for zone ${AI_SETUP_DOMAIN},
# provided under key name CF_DNS_API_TOKEN in ${AI_SETUP_ROOT}/.env (owner action).
set -euo pipefail
AI_SETUP_ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
set -a; . ${AI_SETUP_ROOT}/.env; set +a
: "${CF_DNS_API_TOKEN:?CF_DNS_API_TOKEN missing in ${AI_SETUP_ROOT}/.env (Zone:DNS:Edit scoped token)}"
: "${CF_ZONE_ID:?CF_ZONE_ID missing in ${AI_SETUP_ROOT}/.env (Cloudflare zone id for ${AI_SETUP_DOMAIN})}"
API=https://api.cloudflare.com/client/v4
ZONE="${CF_ZONE_ID}"
TUNNEL="${CF_TUNNEL_ID}"
BODY=$(printf '{"type":"CNAME","name":"${AI_SETUP_DOMAIN}","content":"%s.cfargotunnel.com","proxied":true}' "$TUNNEL")
code=$(curl -sS -o /tmp/cf-dns-resp.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $CF_DNS_API_TOKEN" -H 'Content-Type: application/json' \
  --data "$BODY" "$API/zones/$ZONE/dns_records")
echo "DNS POST HTTP $code"; jq -c '{success, errors: [.errors[]?.message], name: .result.name, content: .result.content, proxied: .result.proxied}' /tmp/cf-dns-resp.json
