#!/usr/bin/env python3
"""Point every server MCP client at opencode-hub (owner ruling 2026-10-05: one shared instance per MCP).

  ${AI_SETUP_ROOT}/mcp/mcp_servers.json  how to LAUNCH each server (commands, env, secrets); root-only,
                                        read by opencode-hub alone. Created once from the old client file.
  ${AI_SETUP_ROOT}/mcp/mcp_config.json   what CLIENTS connect to: one hub URL per server. Read by Claude Code
                                        (sync-claude-config.py), OpenCode (sync-shared.ts) and agy
                                        (symlink); "url" serves the first two, "serverUrl" agy.

Usage: migrate-mcp-config.py [--revert]   (--revert restores the pre-migration client file)
Idempotent: launch definitions are only ever taken from a file that still has commands in it.

Hub bearer token (audit F3, WO-6): mcp_config.json is git-tracked, so it never carries the token. While
the token file exists (hub_token.TOKEN_FILE), agy's config (AGY_CONFIG) becomes its own 0600 copy with
`Authorization: Bearer ...` on every loopback hub URL; without it (and on --revert) it is the symlink to
mcp_config.json again. The value is never printed.
"""
import contextlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

try:
    import hub_token  # same directory: the client half of the hub bearer token
except ImportError:
    hub_token = None

# AI_SETUP_ROOT wins (install.sh and the bin/ wrappers export it); else <root> is this file's parent dir
MCP_DIR = os.environ.get("OPENCODE_HUB_MCP_DIR") or str(
    Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1]) / "mcp"
)
CLIENTS = os.path.join(MCP_DIR, "mcp_config.json")
SERVERS = os.path.join(MCP_DIR, "mcp_servers.json")
BACKUP = os.path.join(MCP_DIR, "mcp_config.pre-hub.json")
HUB = f"http://127.0.0.1:{os.environ.get('OPENCODE_HUB_PORT', '8790')}/mcp"
AGY_CONFIG = os.environ.get("OPENCODE_HUB_AGY_CONFIG") or str(
    Path(os.environ.get("AI_SETUP_HOME") or Path.home()) / ".gemini" / "config" / "mcp_config.json"
)


def write(path: str, data: dict, mode: int) -> None:
    """Atomic: os.replace swaps the directory entry, so a symlink at `path` is replaced, never written
    through (agy's link must never carry the token into the git-tracked mcp_config.json)."""
    tmp = path + ".tmp"
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def link_agy() -> str:
    """The pre-F3 layout: agy reads mcp_config.json through a symlink (atomically replaces a generated copy)."""
    if not os.path.isdir(os.path.dirname(AGY_CONFIG)):
        return f"no {os.path.dirname(AGY_CONFIG)} (agy not installed): skipped"
    if os.path.islink(AGY_CONFIG) and os.readlink(AGY_CONFIG) == CLIENTS:
        return f"{AGY_CONFIG} -> {CLIENTS}"
    tmp = AGY_CONFIG + ".tmp-link"
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)
    os.symlink(CLIENTS, tmp)
    os.replace(tmp, AGY_CONFIG)
    return f"{AGY_CONFIG} -> {CLIENTS} (relinked)"


def sync_agy(servers: dict) -> str:
    """With the hub token file present, agy gets its own 0600 copy with the bearer header; else the link."""
    if hub_token is None:
        print("WARN: hub_token.py not importable: agy gets no hub Authorization header", file=sys.stderr)
        return link_agy()
    try:
        value = hub_token.read_token()
    except hub_token.TokenError as exc:
        print(f"WARN: hub token unusable ({exc}): agy gets no hub Authorization header", file=sys.stderr)
        value = None
    if value is None:
        return link_agy()
    if not os.path.isdir(os.path.dirname(AGY_CONFIG)):
        return f"no {os.path.dirname(AGY_CONFIG)} (agy not installed): skipped"
    write(AGY_CONFIG, {"mcpServers": hub_token.with_hub_auth(servers, value)}, 0o600)
    return f"{AGY_CONFIG}: own 0600 copy with the hub Authorization header"


if sys.argv[1:] == ["--revert"]:
    if not os.path.isfile(BACKUP):
        sys.exit(f"no backup {BACKUP}: nothing to revert (mcp_config.json left as it is)")
    shutil.copy2(BACKUP, CLIENTS)
    os.chmod(CLIENTS, 0o600)
    print(f"agy: {link_agy()}")
    print(f"restored {CLIENTS} from {BACKUP}; now run sync-claude-config.py and restart clients")
    sys.exit(0)

with open(CLIENTS) as fh:
    current = json.load(fh)
if any(s.get("command") for s in current["mcpServers"].values()):
    if not os.path.exists(BACKUP):
        shutil.copy2(CLIENTS, BACKUP)
        os.chmod(BACKUP, 0o600)
    write(SERVERS, current, 0o600)
    launch = current
else:
    with open(SERVERS) as fh:
        launch = json.load(fh)

clients = {"mcpServers": {name: {"type": "http", "url": f"{HUB}/{name}", "serverUrl": f"{HUB}/{name}"}
                          for name in launch["mcpServers"]}}
write(CLIENTS, clients, 0o644)  # URLs only, no secrets: readable like any other config
print(f"{SERVERS}: {len(launch['mcpServers'])} launch definitions (0600)")
print(f"{CLIENTS}: {len(clients['mcpServers'])} hub URLs; backup {BACKUP} ({time.strftime('%F')})")
print(f"agy: {sync_agy(clients['mcpServers'])}")
