#!/usr/bin/env bash
# cloudcli-voice apply script — installs the browser voice add-on into a CloudCLI 1.37.3 install.
# Idempotent: running twice makes no further changes. --dry-run reports without writing.
# Usage: ./apply.sh [--dry-run|--remove] [cloudcli_root]
#   cloudcli_root defaults to ${AI_SETUP_ROOT}/cloudcli/node_modules/@cloudcli-ai/cloudcli
set -euo pipefail

MODE=apply
case "${1:-}" in
  --dry-run) MODE=dry-run; shift ;;
  --remove) MODE=remove; shift ;;
  -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
esac

ROOT="${AI_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET="${1:-$ROOT/cloudcli/node_modules/@cloudcli-ai/cloudcli}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEX="$TARGET/dist/index.html"
ADDON_DIR="$TARGET/dist/voice-addon"
START_MARK='<!-- cloudcli-voice:start -->'
END_MARK='<!-- cloudcli-voice:end -->'
# Code is served from a content-hashed folder: CloudCLI serves dist/ with
# "max-age=31536000, immutable", so an unversioned URL would pin stale code
# in browsers for a year. index.html itself is no-store, so a new hash in the
# tag reaches every browser on the next load.
VERSION="$(cat "$SRC/voice-addon.js" $(ls "$SRC"/lib/*.mjs | LC_ALL=C sort) | sha256sum | cut -c1-12)"
CODE_DIR="$ADDON_DIR/v/$VERSION"
SCRIPT_TAG="<script type=\"module\" src=\"/voice-addon/v/$VERSION/voice-addon.js\"></script>"
BLOCK="$START_MARK
$SCRIPT_TAG
$END_MARK"

log() { printf '[cloudcli-voice] %s\n' "$*"; }
die() { printf '[cloudcli-voice] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$TARGET" ] || die "target CloudCLI root not found: $TARGET (pass the package root as argument)"
[ -f "$INDEX" ] || die "dist/index.html not found under $TARGET — is this a production install?"
[ -f "$SRC/voice-addon.js" ] || die "voice-addon.js missing next to apply.sh ($SRC)"

inject_block() {
  local tmp
  tmp="$(mktemp)"
  if grep -qF "$START_MARK" "$INDEX"; then
    awk -v start="$START_MARK" -v end="$END_MARK" -v block="$BLOCK" '
      index($0, start) == 1 { skip=1; if (!printed) { print block; printed=1 } next }
      index($0, end) == 1 { skip=0; next }
      !skip { print }
    ' "$INDEX" > "$tmp"
  else
    awk -v block="$BLOCK" '
      /<\/body>/ && !printed { print block; printed=1 }
      { print }
    ' "$INDEX" > "$tmp"
  fi
  mv "$tmp" "$INDEX"
}

case "$MODE" in
  apply)
    mkdir -p "$CODE_DIR/lib"
    rm -rf "$ADDON_DIR/vad"  # Silero VAD assets of the old local voice pipeline (removed 2026-10-07)
    install -m 0644 "$SRC/voice-addon.js" "$CODE_DIR/voice-addon.js"
    install -m 0644 "$SRC"/lib/*.mjs "$CODE_DIR/lib/"
    if grep -qF "$SCRIPT_TAG" "$INDEX" && [ "$(grep -cF "$SCRIPT_TAG" "$INDEX")" -eq 1 ]; then
      log "script tag already present — injection skipped (idempotent)"
    else
      inject_block
      log "injected script tag (version $VERSION) into $INDEX"
    fi
    grep -qF "$SCRIPT_TAG" "$INDEX" || die "verification failed: script tag missing after injection"
    log "installed: $CODE_DIR (voice-addon.js + lib/*.mjs)"
    log "reload ${AI_SETUP_DOMAIN} (hard refresh) to activate; remove with: $0 --remove $TARGET"
    ;;
  dry-run)
    [ -w "$TARGET/dist" ] || die "dist/ not writable under $TARGET"
    if grep -qF "$SCRIPT_TAG" "$INDEX"; then
      log "DRY-RUN OK: version $VERSION already installed in $TARGET (would copy voice-addon.js + lib/*.mjs, injection skipped)"
    else
      log "DRY-RUN OK: would copy voice-addon.js + lib/*.mjs into $CODE_DIR"
      log "DRY-RUN OK: would inject one marked script block into $INDEX"
    fi
    ;;
  remove)
    if grep -qF "$START_MARK" "$INDEX"; then
      tmp="$(mktemp)"
      awk -v start="$START_MARK" -v end="$END_MARK" '
        index($0, start) == 1 { skip=1; next }
        index($0, end) == 1 { skip=0; next }
        !skip { print }
      ' "$INDEX" > "$tmp"
      mv "$tmp" "$INDEX"
      log "removed script block from $INDEX"
    else
      log "no marker found in $INDEX — nothing to remove (idempotent)"
    fi
    rm -rf "$ADDON_DIR"
    log "removed $ADDON_DIR"
    ;;
esac
