#!/usr/bin/env python3
"""Stage the opencode-hub bearer token into OpenCode's sync-shared.ts plugin (audit F3, WO-6).

  patch-sync-shared.py [--check | --revert] [PLUGIN]   (default /root/.config/opencode/plugin/sync-shared.ts)

  apply      idempotent anchor patch; the first apply keeps PLUGIN.bak-pre-wo6; atomic write, mode kept
  --check    no write: exit 0 when applied or cleanly applicable, 1 when an anchor moved (patch by hand)
  --revert   the exact inverse (rollback); edits made elsewhere in the file since then are kept

The patched plugin reads the token FILE (OPENCODE_HUB_TOKEN_FILE, default /etc/opencode-hub/token) each
time OpenCode builds its config, and adds `Authorization` to loopback hub URLs only; no file = no header.
This script never reads or prints the token.
"""
import os
import shutil
import sys

DEFAULT = os.path.join(os.path.expanduser("~"), ".config", "opencode", "plugin", "sync-shared.ts")
MARKER = "OPENCODE_HUB_TOKEN_FILE"
SHARED = 'const SHARED_MCP = `${AI_SETUP_ROOT}/mcp/mcp_config.json`\n'
HELPERS = r'''
// opencode-hub bearer token (audit F3, WO-6; same rule as opencode-hub/hub_token.py): read from its 0600
// file each time the config is built and sent to loopback hub URLs only. No file = no header (the pre-F3
// config). The value is never logged. Rollback: opencode-hub/patch-sync-shared.py --revert.
const HUB_TOKEN_FILE = process.env.OPENCODE_HUB_TOKEN_FILE ?? "/etc/opencode-hub/token"
const HUB_PORT = process.env.OPENCODE_HUB_PORT ?? "8790"

function hubAuthorization(): string | null {
  let fd: number
  try {
    fd = openSync(HUB_TOKEN_FILE, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.warn(`[sync-shared] hub token file unusable (${e?.code ?? "error"}): no hub Authorization header`)
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > 4096) {
      console.warn("[sync-shared] hub token file must be a regular 0600 file: no hub Authorization header")
      return null
    }
    const value = readFileSync(fd, "latin1").trim()
    if (value.length < 32 || !/^[\x21-\x7e]+$/.test(value)) {
      console.warn("[sync-shared] hub token file must hold one printable token of >= 32 bytes: no hub Authorization header")
      return null
    }
    return `Bearer ${value}`
  } finally {
    closeSync(fd)
  }
}

function isHubUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      u.port === HUB_PORT && u.pathname.startsWith("/mcp/") && !u.username && !u.password
  } catch {
    return false
  }
}
'''
EDITS = [
    ('import { readFileSync, existsSync } from "fs"\n',
     'import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync } from "fs"\n'),
    (SHARED, SHARED + HELPERS),
    ("function convert(name: string, server: SharedServer) {\n",
     "function convert(name: string, server: SharedServer, hubHeaderValue: string | null = null) {\n"),
    ("      headers: server.headers,\n",
     "      headers: hubHeaderValue && isHubUrl(server.url)\n"
     "        ? { ...(server.headers ?? {}), Authorization: hubHeaderValue }\n"
     "        : server.headers,\n"),
    ("      for (const [name, server] of Object.entries(parsed.mcpServers)) {\n"
     "        mcp[name] = convert(name, server)\n",
     "      const hubHeaderValue = hubAuthorization()\n"
     "      for (const [name, server] of Object.entries(parsed.mcpServers)) {\n"
     "        mcp[name] = convert(name, server, hubHeaderValue)\n"),
]


def transform(src: str, pairs) -> str:
    for old, new in pairs:
        if src.count(old) != 1:
            raise ValueError(f"anchor found {src.count(old)}x (need 1): {old.strip().splitlines()[0][:70]!r}")
        src = src.replace(old, new)
    return src


def write_atomic(path: str, text: str) -> None:
    tmp = f"{path}.tmp-wo6.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    shutil.copymode(path, tmp)
    os.replace(tmp, path)


def main(argv) -> int:
    mode = argv[0] if argv and argv[0] in ("--check", "--revert") else "apply"
    rest = argv[1:] if mode != "apply" else argv
    path = rest[0] if rest else DEFAULT
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    applied = MARKER in src
    try:
        if mode == "--check":
            if not applied:
                transform(src, EDITS)
            print(f"{path}: {'applied' if applied else 'applicable'}")
            return 0
        if mode == "--revert":
            if not applied:
                print(f"{path}: not applied, nothing to revert")
                return 0
            write_atomic(path, transform(src, [(new, old) for old, new in reversed(EDITS)]))
            print(f"{path}: reverted (OpenCode sends no hub Authorization header from its next start)")
            return 0
        if applied:
            print(f"{path}: already applied")
            return 0
        out = transform(src, EDITS)
    except ValueError as exc:
        print(f"{path}: {exc}; sync-shared.ts changed, patch it by hand", file=sys.stderr)
        return 1
    if not os.path.exists(path + ".bak-pre-wo6"):
        shutil.copy2(path, path + ".bak-pre-wo6")
    write_atomic(path, out)
    print(f"{path}: patched (backup {path}.bak-pre-wo6); OpenCode reads the hub token file from its next start")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
