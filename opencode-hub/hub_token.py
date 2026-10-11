"""Client side of the opencode-hub bearer token (audit F3, 2026-10-09).

The hub enforces the token only when its unit sets OPENCODE_HUB_TOKEN_FILE. The client generators act
ONLY while TOKEN_FILE exists (no file = the pre-F3 configs), on loopback hub URLs only:
- agy (migrate-mcp-config.py): `Authorization: Bearer <token>` in its own 0600 config copy;
- OpenCode (sync-shared.ts, same rule in TypeScript): the header in its in-memory config;
- Claude Code (sync-claude-config.py): NO token in any file. Each hub entry in ~/.claude.json gets
  `headersHelper` = helper_command(), and the CLI runs `hub_token.py --headers` when it connects. CloudCLI
  copies ~/.claude.json's servers into the CLI's argv (`--mcp-config <json>`, world-readable through
  /proc/<pid>/cmdline), so a literal header there would leak the token to every local account.

The value is never logged. `--headers` writes it only to the stdout pipe of the CLI that runs it, and
refuses a terminal. The git-tracked ${AI_SETUP_ROOT}/mcp/mcp_config.json (and ${AI_SETUP_ROOT}/.mcp.json) never
carries it.
"""
import json
import os
import shlex
import stat
import sys
from urllib.parse import urlsplit

TOKEN_FILE = os.environ.get("OPENCODE_HUB_TOKEN_FILE", "/etc/opencode-hub/token")
TOKEN_MIN_BYTES = 32
HUB_PORT = int(os.environ.get("OPENCODE_HUB_PORT", "8790"))
# the token never leaves the box: only loopback hub URLs get the header
HUB_HOSTS = {"127.0.0.1", "localhost", "::1"}


class TokenError(Exception):
    """The token file exists but cannot be used. The message names the reason, never the content."""


def read_token(path: str | None = None) -> str | None:
    """The token, or None when there is no token file. Raises TokenError for a file that exists but is
    not a regular 0600-style file (no group/other bits, no symlink) holding one printable ASCII token of
    >= TOKEN_MIN_BYTES bytes: the same rule the hub applies when it loads the file."""
    path = path or TOKEN_FILE
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise TokenError(f"{path}: cannot open ({exc.__class__.__name__})") from None
    with os.fdopen(fd, "rb") as fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
            raise TokenError(f"{path}: must be a regular file with mode 0600")
        value = fh.read(4096).strip()
    if len(value) < TOKEN_MIN_BYTES or not all(0x21 <= c <= 0x7E for c in value):
        raise TokenError(f"{path}: must hold one printable token of >= {TOKEN_MIN_BYTES} bytes")
    return value.decode("ascii")


def is_hub_url(url, hub_port: int | None = None) -> bool:
    """True for http://<loopback>:<hub port>/mcp/... without credentials in the URL."""
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "http" and parts.hostname in HUB_HOSTS
            and port == (HUB_PORT if hub_port is None else hub_port)
            and parts.path.startswith("/mcp/") and not parts.username and not parts.password)


def with_hub_auth(servers: dict, token: str | None) -> dict:
    """A copy of an mcpServers map where every entry whose URL fields (url / serverUrl) all point at the
    loopback hub carries `Authorization: Bearer <token>`. token None returns a plain copy (no header)."""
    out = {}
    for name, entry in servers.items():
        entry = dict(entry)
        urls = [entry[k] for k in ("url", "serverUrl") if k in entry]
        if token and urls and all(is_hub_url(u) for u in urls):
            entry["headers"] = {**(entry.get("headers") or {}), "Authorization": f"Bearer {token}"}
        out[name] = entry
    return out


# Claude Code headersHelper (see the module docstring). A fixed interpreter path, never sys.executable:
# the command string is part of ~/.claude.json, which must not change with whoever ran the generator.
HELPER_PYTHON = "/usr/bin/python3"


def helper_command(token_file: str | None = None, hub_port: int | None = None) -> str:
    """The headersHelper command line (printable ASCII, no secret): python3 -I hub_token.py --headers
    <token file> [--port N]. The CLI runs it through a shell when it connects to a hub entry."""
    argv = [HELPER_PYTHON, "-I", os.path.abspath(__file__), "--headers", token_file or TOKEN_FILE]
    if hub_port is not None and hub_port != HUB_PORT:
        argv += ["--port", str(hub_port)]
    return " ".join(shlex.quote(a) for a in argv)


def with_hub_helper(servers: dict, command: str | None) -> dict:
    """A copy of an mcpServers map where every entry whose URL fields all point at the loopback hub
    carries `headersHelper: command` (and no literal Authorization). command None = a plain copy."""
    out = {}
    for name, entry in servers.items():
        entry = dict(entry)
        urls = [entry[k] for k in ("url", "serverUrl") if k in entry]
        if command and urls and all(is_hub_url(u) for u in urls):
            entry["headersHelper"] = command
        out[name] = entry
    return out


def emit_headers(argv: list[str]) -> int:
    """`hub_token.py --headers [TOKEN_FILE] [--port N]`: the Claude Code headersHelper. Writes
    {"Authorization": "Bearer ..."} to stdout ({} without a token file) for the CLI that runs it, only
    when CLAUDE_CODE_MCP_SERVER_URL (set by the CLI) is a loopback hub URL; never to a terminal. Errors
    name the reason, never the value; a non-zero exit makes the CLI connect without the header."""
    path, hub_port, rest = None, None, list(argv)
    while rest:
        arg = rest.pop(0)
        if arg == "--port" and rest and rest[0].isdigit():
            hub_port = int(rest.pop(0))
        elif path is None and not arg.startswith("-"):
            path = arg
        else:
            print(f"hub_token.py --headers: unexpected argument {arg[:40]!r}", file=sys.stderr)
            return 2
    if sys.stdout.isatty():
        print("hub_token.py --headers: refusing to write the token to a terminal", file=sys.stderr)
        return 2
    if not is_hub_url(os.environ.get("CLAUDE_CODE_MCP_SERVER_URL"), hub_port):
        print("hub_token.py --headers: CLAUDE_CODE_MCP_SERVER_URL is not a loopback opencode-hub URL:"
              " no header", file=sys.stderr)
        return 1
    try:
        value = read_token(path)
    except TokenError as exc:
        print(f"hub_token.py --headers: token unusable ({exc}): no header", file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps({"Authorization": f"Bearer {value}"} if value else {}))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] != ["--headers"]:
        sys.exit("usage: hub_token.py --headers [TOKEN_FILE] [--port N]   (Claude Code headersHelper)")
    sys.exit(emit_headers(sys.argv[2:]))
