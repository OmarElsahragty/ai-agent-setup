#!/usr/bin/env bash
# CloudCLI install: pinned npm package + lockfile + idempotent patch + env bootstrap
# + native module checks. Safe to re-run (never overwrites an existing .env).
# Does not touch systemd (cloudcli.service) or Cloudflare (see README).
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example (0600)"
fi
npm ci --no-fund --no-audit
bash patches/apply.sh
mkdir -p data
# Native bindings must load or the server crashes at runtime (node-pty, sqlite, bcrypt)
node -e "require('node-pty'); require('better-sqlite3'); require('bcrypt'); console.log('native modules OK')"
# C7 NIT: never fail the whole install when package-lock.json is absent after success
if [ -f package-lock.json ]; then
  echo "install OK (pinned $(node -p "require('./node_modules/@cloudcli-ai/cloudcli/package.json').version"))"
else
  echo "install OK (warning: package-lock.json absent, version not pinned)"
fi
