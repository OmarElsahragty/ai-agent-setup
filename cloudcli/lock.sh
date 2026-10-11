#!/usr/bin/env bash
# Step 5b LOCK (owner ruling "Test first, then lock"). Rollback: lock.sh --rollback
set -euo pipefail
AI_SETUP_ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
B=${AI_SETUP_ROOT}/cloudcli/backups/lock-20261007; E=${AI_SETUP_ROOT}/cloudcli/.env; U=/etc/systemd/system/voice-gateway.service
AUD_FILE=${AI_SETUP_ROOT}/cloudcli/backups/access-aud.txt; TEAM=${CF_ACCESS_TEAM_DOMAIN}
if [ "${1:-}" = --rollback ]; then
  install -m 600 $B/cloudcli.env $E; install -m 644 $B/voice-gateway.service $U
  systemctl daemon-reload; systemctl restart voice-gateway; ${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --reason "lock.sh $0 ${1:-apply}"; echo "rolled back"; exit 0
fi
mkdir -p $B; chmod 750 $B
[ -f $B/cloudcli.env ] || cp -p $E $B/cloudcli.env; [ -f $B/voice-gateway.service ] || cp -p $U $B/voice-gateway.service
chmod 640 $B/*
AUD=$(tr -d '[:space:]' < $AUD_FILE)
grep -q '^CF_ACCESS_AUD=' $E || printf 'CF_ACCESS_AUD=%s\nCF_ACCESS_TEAM_DOMAIN=%s\n' "$AUD" "$TEAM" >> $E
grep -q 'CF_ACCESS_AUD' $U || sed -i "/^Environment=VOICE_GPU_MIN_FREE_MB=/a Environment=CF_ACCESS_TEAM_DOMAIN=$TEAM\nEnvironment=CF_ACCESS_AUD=$AUD" $U
systemctl daemon-reload; systemctl restart voice-gateway; ${AI_SETUP_ROOT}/scripts/safe-restart.sh cloudcli --reason "lock.sh $0 ${1:-apply}"
echo "locked (keys: $(grep -oE '^CF_ACCESS_[A-Z_]+' $E | tr '\n' ' '))"
