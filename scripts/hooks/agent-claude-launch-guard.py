#!/usr/bin/env python3
"""PreToolUse hook (Bash): agents never launch interactive or background Claude Code sessions.

Owner ruling 2026-10-10 (audit H GAP-8; R1 "nothing automatic ever starts a session"): an agent,
in any session or subagent, may not start `claude` / `claude.exe` (any path) as an interactive or
background session; a FOREGROUND one-shot `claude -p` / `--print` is allowed. Denied:
  - every `claude` form, -p included, started through a launch vehicle: tmux (new-session/new,
    new-window, split-window, respawn-pane, respawn-window, send-keys, run-shell, display-popup),
    screen (a new window, `-X screen`, `-X stuff`, `-X eval`), systemd-run, nohup, setsid,
    `script -c`, start-stop-daemon, at/batch, coproc, ssh to this host, a trailing `&` (the whole
    pipeline / and-or list, `( ... ) &` / `{ ...; } &` groups, and a $(...) inside a backgrounded
    command), a process substitution `<(...)` / `>(...)`, or the Bash tool's own
    run_in_background flag (owner 2026-10-10: `claude -p` included);
  - a plain foreground `claude` without -p/--print (interactive; --resume/-c included), also
    behind the wrappers VAR=x, sudo, doas, env, nice, ionice, timeout, stdbuf, exec, command, time,
    xargs, chrt, taskset, flock, watch and busybox/toybox (these keep a -p one-shot allowed);
  - `claude --bg / --background / --cloud / --teleport` (any other flags, -p included);
  - launches hidden in shell structure: `$(which claude)` / `"$(command -v claude)"` / backticks
    as the command name, `bash <<EOF` / `bash <<< '...'` / `echo claude | bash` (backgrounded or
    not), `cat <<'EOF' | bash`, shell function bodies (`f() { claude & }; f`), case arms,
    `find ... -exec claude ...`, `sudo -iu/-Eu user claude`, `$'claude'`, glob/brace names
    (`cla[u]de`, `{claude,}`). A here-string (`cmd <<< word`) is never a heredoc, and neither is
    an arithmetic shift (`$((a << b))`): the lines after them are still scanned as commands;
  - GAP-8 inline payloads (owner ruling, gate wave 2): code passed via sh/bash/dash/zsh/ksh/ash/
    mksh/... -c, `$SHELL` / `$BASH` / `$0` -c, busybox sh -c, awk/gawk/mawk programs,
    python/node/perl/ruby -c/-e, or expect -c that names claude as a command or argv word is
    denied, -p included, when the outer command is backgrounded (any vehicle above, `& disown`
    included) or the payload carries a background marker (& nohup setsid disown Popen spawn
    start_new_session detached fork child_process); otherwise only an interactive claude (no
    -p/--print) in the payload is denied: `python3 -c "...subprocess.run(['claude','-p','x'])"`
    and `sh -c 'claude -p x'` are allowed, `subprocess.Popen([...'claude'...])`,
    `awk 'BEGIN{system("claude ... &")}'` and `expect -c 'spawn claude ...'` are not.
Allowed: FOREGROUND one-shots `claude -p ...` / `claude --print ...` (also behind the wrappers
above, in pipes and in a foreground $(...)), and the read-only `claude --version|-v|--help|-h`,
`claude mcp list|get ...`, `claude auth status`, `claude config ...`, `claude doctor` and
`claude agents`.
Static analysis only, nothing is executed: quotes, comments and heredoc bodies are honoured
(heredocs are analysed as the text fed to their consumer); `bash -c` / `su -c` / `eval` strings,
$(...) / `...` / <(...) / >(...) and piped-into-shell scripts are analysed recursively.
Same-command variables resolve to a fixpoint (D1 2026-10-11 + gate wave 2): `X=claude; $X`,
`${X}`, hops (`X=claude; Y=$X; $Y`), concatenation (`X=cla; ${X}ude`, `"$X"ude`, `X+=ude`,
`A=cla B=ude; $A$B`), `declare -n R=X`, `${!R}`, `${X:-claude}`, `for X in claude`,
export/local/declare/readonly/typeset, and `X="claude --resume a"; eval $X`; every value a
reassigned variable may hold is judged.
D1 2026-10-11 (owner: fix all debt) also denies: the claude-code package run through npx/bunx/pnpx,
`npm|pnpm|yarn|bun exec|dlx|x`, or `node|bun .../@anthropic-ai/claude-code/cli.js`, `at`/`batch`
fed a claude command (pipe, here-string, heredoc; any form, -p included), `coproc` + claude (any
form), `ssh` to this host running claude (any form). This host = 127.0.0.0/8 in any inet_aton
form (127.1, 2130706433, 0x7f.1, 0177.0.0.1), 0 / 0.0.0.0, ::1 / :: and ::ffff:127.x, localhost,
localhost.*, *.localhost, ip6-localhost, the host name, also when set by `-o HostName=` /
`-oHostName=` or by options given after the destination. Also denied: a renamed symlink (`ln -s[f]
<claude> /tmp/cc; /tmp/cc`, also `$(which claude)` as the source) executed in the same command,
and EVERY base64/base32/basenc/openssl/xxd-decoded payload piped into a shell, interpreter,
at/batch or ssh, or substituted into eval/source/`bash -c`/a here-string (the decoded bytes cannot
be judged statically, so the shape itself is refused).
Documented limits (not caught): script files (`bash file.sh`, `python file.py`, `awk -f prog`,
`expect script.exp`, `source x`, `at -f file`), obfuscated interpreter code
(`exec(codecs.decode(...))`), claude handed to interpreter code through its argv or awk `-v`
values, copies of the binary (`cp $(which claude) cc; cc`), variables assigned in an earlier tool
call or by read / printf -v / mapfile / arrays, parameter operators other than :- - := = :+ + :?
(`${X%...}`, `${X/...}`, `${X:0:6}` count only when claude is already in the value or operand),
`ssh` to another name for this machine (ssh_config Host aliases, LAN addresses), ssh
ProxyCommand / LocalCommand, cron/dtach/daemonize launches, a `case` nested inside another case's
arm.
Kill/restart of existing sessions and `--resume <live sid>` stay with restart-guard.py.
Stdlib only; fails open on any internal error.
"""
import json
import os
import re
import shlex
import sys

CLAUDE_NAMES = {"claude", "claude.exe"}
SHELLS = {"bash", "sh", "dash", "zsh", "ksh", "ash", "hush", "mksh", "lksh", "yash", "posh", "rbash",
          "fish", "csh", "tcsh"}
SHELL_VAR_RE = re.compile(r"\$\{?(?:SHELL|BASH|0)\}?")
KEYWORDS = {"!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until",
            "{", "}", "(", ")"}
COMPOUND_OPEN = {"while", "until", "for", "if", "case", "select"}
COMPOUND_CLOSE = {"done", "fi", "esac"}
READONLY_FLAGS = {"--version", "-v", "--help", "-h"}
BG_FLAGS = {"--bg", "--background", "--cloud", "--teleport"}
MAX_DEPTH = 8
BG_LABEL = "a trailing `&` (background job)"
PROCSUB_LABEL = "a process substitution <(...) / >(...) (runs in the background)"
BG_MARKER_RE = re.compile(r"\b(?:nohup|setsid|disown|Popen|start_new_session|detach\w*|child_process)\b"
                          r"|spawn|\bfork")
AWK_NAMES = {"awk", "gawk", "mawk", "nawk", "original-awk"}
AWK_SPAWN_RE = re.compile(r"\bsystem\b|\|")
EXPECT_SPAWN_RE = re.compile(r"\b(?:spawn|exec|system|open)\b")
MAX_ALIAS_HOPS = 8
MAX_ALIAS_VALUES = 6
MAX_VALUE_LEN = 512
MAX_EXPANSIONS = 16
_VAR_RE = re.compile(r"\$(?:\{(!?)([A-Za-z_]\w*)(?:(:?[-=+?])([^}]*)|([^}]*))\}|([A-Za-z_]\w*))")
_ASSIGN_RAW_RE = re.compile(r"([A-Za-z_]\w*)(?:\[[^\]]*\])?(\+?)=(.*)$", re.S)
DECLARE_WORDS = {"export", "local", "declare", "readonly", "typeset"}

ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")
REDIR_RE = re.compile(r"^(?:\d+|&)?(?:>>|>\||>&|>|<<<|<<-?|<&|<>|<)(.*)$", re.S)
HEREDOC_OP_RE = re.compile(r"<<(-?)[ \t]*\\?(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
# static stdout lookups: $(which claude) and friends render as `claude`
LOOKUPS = {"which", "whence", "where", "type", "command", "hash", "readlink", "realpath",
           "basename"}
_INTERP_RE = re.compile(r"^(?:python[\d.]*|pypy[\d.]*|node|nodejs|perl[\d.]*|ruby[\d.]*)$")
INTERP_FAMILY = {"python": {"-c"}, "node": {"-e", "-p", "--eval"}, "perl": {"-e"},
                 "ruby": {"-e"}}
CODE_SPAWN_RE = re.compile(
    r"subprocess|Popen\b|child_process|\bos\.system\b|\bsystem\s*\(|\bpopen\b"
    r"|spawn|\bexec\w*\s*\(|\bfork|\bpty\b|Open3"
    r"|create_subprocess|getoutput|check_output|check_call|Deno\.\w+|Bun\.\w+|\bqx\s*[({]|`")
_CODE_LIT_RE = re.compile(
    r"'''(?:[^'\\]|\\.)*?'''|\"\"\"(?:[^\"\\]|\\.)*?\"\"\""
    r"|'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`")

# wrapper -> (short options taking a value, long options taking a value, flags)
WRAP = {
    "sudo": ("ugCDhprtTU", {"--user", "--group", "--host", "--prompt", "--role", "--type",
                            "--other-user", "--chdir", "--close-from", "--command-timeout"},
             {"-b", "-i", "-s", "-E", "-H", "-l", "-v", "-k", "-K", "-n", "-A", "-a"}),
    "doas": ("u", set(), {"-n"}),
    "env": ("uC", {"--unset", "--chdir"}, {"-i", "-v", "-0"}),
    "nice": ("n", {"--adjustment"}, set()),
    "ionice": ("cnPu", {"--class", "--classdata"}, set()),
    "timeout": ("sk", {"--signal", "--kill-after", "--preserve-status", "--foreground"},
                {"-i", "-v"}),
    "stdbuf": ("ioe", {"--input", "--output", "--error"}, set()),
    "exec": ("a", set(), set()),
    "xargs": ("aEdILnPsS", {"--arg-file", "--delimiter", "--max-args", "--max-lines",
                            "--max-procs", "--max-chars", "--process-slot-var", "--eof"},
              {"-r", "-x", "-t", "-o", "-0", "-p"}),
    "command": ("", set(), {"-p", "-v", "-V"}),
    "builtin": ("", set(), set()),
    "time": ("fo", {"--format", "--output"}, {"-p"}),
    "chrt": ("", set(), {"-a", "-b", "-R"}),
    "taskset": ("c", {"--cpu-list"}, {"-a"}),
    "flock": ("Ewc", {"--conflict-exit-code", "--wait", "--command"}, {"-n", "-o", "-s", "-x",
                                                                       "-F", "-T"}),
    "watch": ("n", {"--interval", "--differences"}, {"-b", "-d", "-e", "-g", "-t", "-x", "-c",
                                                     "-p", "-q"}),
    "busybox": ("", set(), set()),
    "toybox": ("", set(), set()),
}
WRAP_POSITIONAL = {"timeout": 1, "chrt": 1, "taskset": 0, "flock": 1, "watch": 0}
SSD_LONG = {"--exec", "--pidfile", "--chdir", "--user", "--chroot", "--signal", "--retry",
            "--stop-timeout", "--nicelevel", "--umask", "--name", "--startas", "--remove-pidfile"}

# vehicles that start a detached / background / pty session
VEHICLES = {"nohup", "setsid", "systemd-run", "tmux", "screen", "script"}
SETSID_FLAGS = {"-c", "-f", "-w", "--ctty", "--fork", "--wait"}
SYSTEMD_RUN_VALUE_SHORT = "upEMH"
SYSTEMD_RUN_VALUE_LONG = {"--unit", "--property", "--description", "--slice", "--setenv", "--uid",
                          "--gid", "--nice", "--working-directory", "--machine", "--host",
                          "--service-type", "--on-active", "--on-boot", "--on-startup",
                          "--on-unit-active", "--on-unit-inactive", "--on-calendar",
                          "--timer-property", "--path-property", "--socket-property", "--capsule"}
TMUX_GLOBAL_VALUES = "cfLST"
TMUX_SPAWN = {"new-session": "cefFnstxy", "new": "cefFnstxy", "new-window": "ceFnt", "neww": "ceFnt",
              "split-window": "celtFp", "splitw": "celtFp", "respawn-pane": "cet", "respawnp": "cet",
              "respawn-window": "cet", "respawnw": "cet"}
TMUX_SEND = {"send-keys": "cNt", "send": "cNt"}
TMUX_SHELL_CMDS = {"run-shell": "tdF", "display-popup": "whtdSCF"}
TMUX_ENTER = {"Enter", "C-m", "KPEnter", "C-j"}
TMUX_KEYNAME_RE = re.compile(r"^(?:(?:[CMS]-)+.+|F\d{1,2}|Escape|Tab|BTab|BSpace|Up|Down|Left|Right"
                             r"|Home|End|PageUp|PgUp|PPage|PageDown|PgDn|NPage|IC|Insert|DC|Delete)$")
SCREEN_VALUES = "cehpsStTX"

CLAUDE_PKG_RE = re.compile(r"@anthropic-ai/claude-code(?![\w-])|(?:^|/)claude-code/[^/]*\.m?js$")
NPX_LIKE = {"npx", "bunx", "pnpx"}
PKG_RUNNERS = {"npm", "pnpm", "yarn", "bun"}
PKG_EXEC_SUBCMDS = {"exec", "dlx", "x"}
PKG_VALUE_OPTS = {"-p", "--package", "--prefix", "-C", "--dir", "--cwd", "-w", "--workspace",
                  "--registry", "--cache", "--userconfig", "--node-options"}
NODE_FAMILY = {"node", "nodejs", "bun"}
NODE_VALUE_OPTS = {"-r", "--require", "--import", "--loader", "--experimental-loader", "-C",
                   "--conditions", "--input-type", "--title", "--env-file", "--inspect-port",
                   "--stack-size", "--max-old-space-size"}
AT_LIKE = {"at", "batch"}
SSH_VALUES = "BbcDEeFIiJLlmOoPpQRSWw"
LOCAL_HOSTS = {"localhost", "ip6-localhost", "ip6-loopback"}
_IPV4_PART_RE = re.compile(r"0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*")
_SSH_HOSTNAME_RE = re.compile(r"\s*hostname\s*(?:=\s*|\s+)(\S+)", re.I)
DECODED = "__DECODED__"
DECODE_SINKS = SHELLS | AT_LIKE | {"eval", "source", ".", "coproc", "ssh"}
DECODE_RE = re.compile(
    r"(?:^|[\s/])(?:base64|base32|basenc|gbase64)(?=\s)[^|;&]*\s(?:-[A-Za-z]*[dD][A-Za-z]*|--decode)(?:\s|$)"
    r"|(?:^|[\s/])openssl(?=\s)[^|;&]*\s-(?:d|base64\s+-d)(?:\s|$)"
    r"|(?:^|[\s/])xxd(?=\s)[^|;&]*\s-[A-Za-z]*r"
    r"|(?:^|[\s/])(?:uudecode|python[\d.]*\s+-m\s+base64\s+-d)(?:\s|$)")
DECODED_LABEL = ("a base64/encoded payload decoded into a shell, interpreter, at/batch, ssh or eval "
                 "(its content cannot be checked statically)")
_ALIAS = {"vars": set(), "paths": set(), "names": set(), "raw": {}, "env": {}}

REASON = ("agent-claude-launch-guard: BLOCKED {what}. Owner ruling 2026-10-10 (audit H GAP-8; R1 "
          "\"nothing automatic ever starts a session\"): agents and subagents never launch interactive "
          "or background Claude Code sessions, so no tmux, screen, systemd-run, nohup, setsid, "
          "script -c, at/batch, coproc, ssh-to-this-host, process-substitution or trailing-& launch, "
          "no inline code with a background marker (Popen/spawn/fork/...) naming claude, no "
          "decoded payload run by a shell, and no `claude` without -p. Allowed: a foreground one-shot "
          "`claude -p \"...\"` (or --print) and the read-only `claude --version`, `--help`, "
          "`mcp list` and `config ...`. If a real session is needed, ask the owner to start it.")


# ── text preprocessing (comments, functions, case, heredocs) ──
def _strip_comments(text):
    """Blank `#` comments (quote aware; `${#x}` is not a comment). Comments are never code."""
    out, i, n, quote = [], 0, len(text), None
    while i < n:
        c = text[i]
        if quote:
            out.append(c)
            if c == "\\" and quote == '"':
                out.append(text[i + 1:i + 2])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c == "$" and text.startswith("${", i):
            j = text.find("}", i)
            j = n if j < 0 else j + 1
            out.append(text[i:j])
            i = j
            continue
        if c in "'\"":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "\\":
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == "#" and (i == 0 or text[i - 1] in " \t\n;&|({}"):
            j = text.find("\n", i)
            if j < 0:
                break
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _match_brace(text, k):
    """Index of the `}` closing the `{` at text[k], quotes honoured; -1 when unbalanced."""
    depth, quote, i = 0, None, k
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "\\":
            i += 2
            continue
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


_FUNC_DEF_RE = re.compile(r"[A-Za-z_]\w*[ \t]*\([ \t]*\)[ \t]*\{|function[ \t]+[A-Za-z_]\w*[ \t]*\{")


def _quoted_mask(text):
    """mask[k] is True when text[k] sits inside '...' or "..." (backslash escapes honoured)."""
    mask, quote, i, n = [False] * len(text), None, 0, len(text)
    while i < n:
        c = text[i]
        if quote:
            mask[i] = True
            if c == "\\" and quote == '"' and i + 1 < n:
                mask[i + 1] = True
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "\\":
            i += 2
            continue
        i += 1
    return mask


def _strip_functions(text, depth, out, vehicle):
    """Scan shell function bodies (`f() { ...; }`, `function f { ...; }`) and drop the definition.
    A definition inside a quoted string is data here (it is scanned when that string runs)."""
    res, i, n = [], 0, len(text)
    mask = _quoted_mask(text) if ("'" in text or '"' in text) else None
    while i < n:
        m = _FUNC_DEF_RE.search(text, i)
        if not m:
            res.append(text[i:])
            break
        start = m.start()
        if (start and text[start - 1] not in " \t\n;&|({}") or (mask and mask[start]):
            res.append(text[i:m.end()])
            i = m.end()
            continue
        b = text.find("{", m.end() - 1)
        e = _match_brace(text, b)
        if e < 0:
            res.append(text[i:])
            break
        res.append(text[i:start])
        res.append(" ")
        _scan(text[b + 1:e], vehicle, depth + 2, out)
        i = e + 1
    return "".join(res)


_CASE_KW_RE = re.compile(r"(?:^|(?<=[\s;&|({]))case(?=[\s])")


def _case_end(text, k):
    """Index after the `esac` matching a `case` whose keyword ends at k; -1 when absent."""
    depth, quote, i, n = 1, None, k, len(text)
    while i < n:
        c = text[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"":
            quote = c
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if _CASE_KW_RE.match(text, i):
            depth += 1
            i += 4
            continue
        if (text.startswith("esac", i) and (i == 0 or text[i - 1] in " \t\n;&|)")
                and (i + 4 >= n or text[i + 4] in " \t\n;&|")):
            depth -= 1
            if depth == 0:
                return i + 4
            i += 4
            continue
        i += 1
    return -1


def _case_arms(region):
    """The arm bodies of a `case WORD in ...` region (between `in` and `esac`), as script text."""
    m = re.search(r"(?:^|[\s])in(?=[\s])", region)
    if not m:
        return ""
    body = region[m.end():]
    pieces, buf, quote, depth, i = [], [], None, 0, 0
    while i < len(body):
        c = body[i]
        if quote:
            buf.append(c)
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"":
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == "\\":
            buf.append(body[i:i + 2])
            i += 2
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == ";" and body[i:i + 2] in (";;", ";&") and depth <= 0:
            pieces.append("".join(buf))
            buf = []
            i += 2
            continue
        buf.append(c)
        i += 1
    pieces.append("".join(buf))
    arms = []
    for p in pieces:
        q, d = None, 0
        for j, c in enumerate(p):
            if q:
                if c == q:
                    q = None
                continue
            if c in "'\"":
                q = c
                continue
            if c == "(":
                d += 1
            elif c == ")":
                if d == 0:
                    arms.append(p[j + 1:])
                    break
                d -= 1
        else:
            arms.append(p)
    return "\n" + "\n".join(arms)


def _strip_case(text):
    """Replace each `case ... esac` block with its arm bodies (patterns dropped, bodies kept)."""
    out, i, n = [], 0, len(text)
    while i < n:
        m = _CASE_KW_RE.search(text, i)
        if not m:
            out.append(text[i:])
            break
        end = _case_end(text, m.end())
        if end < 0:
            out.append(text[i:])
            break
        out.append(text[i:m.start()])
        out.append(_case_arms(text[m.end():end]))
        i = end
    return "".join(out)


_SUBST_BODY_RE = re.compile(r"\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`")


def _heredocs(text):
    """Inline every heredoc as a here-string (`<<EOF` + body -> `<<< '<body>'`), so the consumer
    is judged with the body as its stdin. Returns (text, expansion_bodies): the bodies of $(...)
    / `...` inside UNquoted-delimiter heredocs (bash expands those into the data)."""
    lines = text.split("\n")
    out, bodies, pending, buf = [], [], [], []
    for line in lines:
        if pending:
            strip_tabs, delim, quoted, idx = pending[0]
            cand = line.lstrip("\t") if strip_tabs else line
            if cand.strip() == delim:
                pending.pop(0)
                body = "\n".join(buf)
                buf = []
                out[idx] += " <<< " + shlex.quote(body)
                if not quoted:
                    for m in _SUBST_BODY_RE.finditer(body):
                        bodies.append(m.group(1) if m.group(1) is not None else m.group(2))
            else:
                buf.append(line)
            continue
        # scan this line for heredoc operators outside quotes
        newline, quote, k = line, None, 0
        while k < len(newline):
            c = newline[k]
            if quote:
                if c == quote:
                    quote = None
                k += 1
                continue
            if c in "'\"":
                quote = c
                k += 1
                continue
            if c == "\\":
                k += 2
                continue
            if c == "<" and newline.startswith("<<<", k):
                k += 3  # a here-string: its word is data on this line, never a heredoc delimiter
                continue
            if (newline.startswith("$((", k) or (newline.startswith("((", k)
                                                  and (k == 0 or newline[k - 1] in " \t;&|("))):
                e = newline.find("))", k + 2)
                if e >= 0:  # arithmetic: `a << b` is a shift, not a heredoc
                    k = e + 2
                    continue
            if c == "<" and newline.startswith("<<", k):
                m = HEREDOC_OP_RE.match(newline, k)
                if m:
                    pending.append([m.group(1) == "-", m.group(3), bool(m.group(2)), len(out)])
                    newline = newline[:k] + " " + newline[m.end():]
                    continue
            k += 1
        out.append(newline)
    for strip_tabs, delim, quoted, idx in pending:  # unterminated: body runs to the end
        body = "\n".join(buf)
        out[idx] += " <<< " + shlex.quote(body)
        if not quoted:
            for m in _SUBST_BODY_RE.finditer(body):
                bodies.append(m.group(1) if m.group(1) is not None else m.group(2))
    return "\n".join(out), bodies


# ── shell text → simple commands (static) ──
def _match_close(text, k):
    """Index of the `)` closing the `(` at text[k], quotes honoured; -1 when unbalanced."""
    depth, quote, i = 0, None, k
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "\\":
            i += 2
            continue
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _words(segment):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def _name_of(tok):
    """The command name a token resolves to: $'claude', cla[u]de and {claude,} are claude."""
    t = tok
    if len(t) >= 4 and t[0] == "$" and t[1] in "'\"" and t[-1] == t[1]:
        t = t[2:-1]
    t = t.strip("'\"")
    if SHELL_VAR_RE.fullmatch(t):
        return "bash"  # $SHELL / $BASH / $0 run the user's shell
    if t.startswith("$") and os.path.basename(t[1:]) in CLAUDE_NAMES:
        return "claude"  # $'claude' survives shlex as $claude; a $claude variable is denied too
    if t.startswith("$"):
        m = re.match(r"\$\{?([A-Za-z_]\w*)", t)
        if m and m.group(1) in _ALIAS["vars"]:
            return "claude"  # X=claude; $X
    if _ALIAS["paths"] and (os.path.normpath(t) in _ALIAS["paths"]
                            or (t and os.path.basename(t) in _ALIAS["names"])):
        return "claude"  # ln -s <claude> /tmp/cc; /tmp/cc
    if CLAUDE_PKG_RE.search(t):
        return "claude"
    if "[" in t and "]" in t and os.path.basename(re.sub(r"[\[\]!]", "", t)) in CLAUDE_NAMES:
        return "claude"
    if "{" in t:
        for a in re.sub(r"[\{\}]", " ", t).split(","):
            if os.path.basename(a.strip()) in CLAUDE_NAMES:
                return os.path.basename(a.strip())
    return os.path.basename(t)


def _drop_redirects(tokens):
    """Drop redirection operators + their targets; `<<< text` pairs are KEPT (shell stdin data)."""
    out, skip = [], False
    for tok in tokens:
        if skip:
            skip = False
            continue
        m = REDIR_RE.match(tok)
        if m:
            if m.group(0).startswith("<<<"):
                out.append("<<<")  # keep the stdin text pair for the shell/interpreter judge
                if m.group(1):
                    out.append(m.group(1))
                continue
            skip = not m.group(1)
            continue
        out.append(tok)
    return out


def _split(text):
    """Simple commands of `text` -> ([(segment, background, piped)], [(body, kind, segment index)]).

    ;, newline, &&, ||, |, |& separate. `piped` = this segment receives the previous segment's
    stdout (| or |& before it, never ||). A lone `&` backgrounds the whole and-or list before it
    and any ( ) / { } group it closes. `&` inside >&, <&, &> or &>> is a redirection. Comments
    are already stripped; $(...), `...`, <(...) and >(...) become a placeholder word (or the
    statically-resolved output) and their bodies are returned for recursive analysis: kind
    "proc" for <(...) / >(...), "cmd" for $(...) / `...`, with the index of the segment holding
    them (a substitution in a backgrounded segment runs in the background too)."""
    segs, substs, groups, compound, buf = [], [], [], [], []
    state = {"pending": None, "list_start": 0, "piped": False}
    quote = None
    i, n = 0, len(text)

    def at_start():
        return not "".join(buf).strip()

    def flush(op):
        seg = "".join(buf).strip()
        buf.clear()
        pending = state["pending"]
        if pending is not None and (not seg or not _drop_redirects(_words(seg))):
            seg = ""  # redirections that belong to the group just closed
        first = seg.split(None, 1)[0] if seg else ""
        if first in COMPOUND_OPEN:
            compound.append(state["list_start"])
        if seg:
            segs.append([seg, False, state["piped"]])
        state["piped"] = False
        if first in COMPOUND_CLOSE and compound:
            # a while/for/if/case ... done/fi/esac is one command of the enclosing list
            state["list_start"] = min(state["list_start"], compound.pop())
        if op == "bg":
            start = state["list_start"]
            if pending is not None:
                start = min(start, pending[0])
            for k in range(start, len(segs)):
                segs[k][1] = True
        state["pending"] = None
        if op in ("seq", "bg"):
            state["list_start"] = len(segs)

    def substitution(i):
        """Handle $( <( >( and backticks at i; returns the next index or None."""
        c = text[i]
        if c == "`":
            j = text.find("`", i + 1)
            if j < 0:
                return None
            body = text[i + 1:j]
        else:
            j = _match_close(text, i + 1)
            if j < 0:
                return None
            body = text[i + 2:j]
        substs.append((body, "proc" if c in "<>" else "cmd", len(segs)))
        if DECODE_RE.search(body):
            buf.append(DECODED)
        else:
            buf.append("claude" if _subst_output(body) else "__SUBST__")
        return j + 1

    while i < n:
        c = text[i]
        if quote == "'":
            buf.append(c)
            if c == "'":
                quote = None
            i += 1
            continue
        if quote == '"':
            if c == "\\" and i + 1 < n:
                buf.append(text[i:i + 2])
                i += 2
                continue
            if c == '"':
                quote = None
                buf.append(c)
                i += 1
                continue
            if c == "`" or (c == "$" and text.startswith("(", i + 1)):
                nxt = substitution(i)
                if nxt is not None:
                    i = nxt
                    continue
            buf.append(c)
            i += 1
            continue
        if c == "\\":
            if text.startswith("\n", i + 1):
                i += 2
                continue
            buf.append(text[i:i + 2])
            i += 2
            continue
        if c in "'\"":
            quote = c
            buf.append(c)
            i += 1
            continue
        tail = "".join(buf[-2:])
        if c == "#" and (not tail or tail[-1] in " \t\n;&|()"
                         or (tail[-1] in "{}" and not tail.endswith("${"))):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "`" or (c in "$<>" and text.startswith("(", i + 1)):
            nxt = substitution(i)
            if nxt is not None:
                i = nxt
                continue
        if c in "\n;":
            flush("seq")
            i += 1
            continue
        if c == "&":
            nxt = text[i + 1:i + 2]
            if nxt == "&":
                flush("list")
                i += 2
                continue
            if nxt == ">" or (buf and buf[-1] in "<>"):
                buf.append(c)
                i += 1
                continue
            flush("bg")
            i += 1
            continue
        if c == "|":
            nxt = text[i + 1:i + 2]
            if nxt == "|":
                flush("list")
                i += 2
                continue
            if nxt == "&":
                flush("list")
                state["piped"] = True
                i += 2
                continue
            if buf and buf[-1] == ">":
                buf.append(c)
                i += 1
                continue
            flush("list")
            state["piped"] = True
            i += 1
            continue
        if c == "(" and at_start():
            flush("list")
            groups.append(len(segs))
            i += 1
            continue
        if c == ")" and groups:
            flush("list")
            state["pending"] = (groups.pop(), len(segs))
            i += 1
            continue
        if c == "{" and at_start() and text[i + 1:i + 2] in (" ", "\t", "\n"):
            flush("list")
            groups.append(len(segs))
            i += 1
            continue
        if (c == "}" and groups and at_start()
                and text[i + 1:i + 2] in ("", " ", "\t", "\n", ";", "&", "|", ")", "<", ">")):
            flush("list")
            state["pending"] = (groups.pop(), len(segs))
            i += 1
            continue
        buf.append(c)
        i += 1
    flush("seq")
    return [(s, bg, piped) for s, bg, piped in segs], substs


# ── command substitution resolution ──
def _subst_output(body):
    """`claude` when this substitution's static output is the claude binary name
    ($(which claude), $(command -v claude), `which claude`, $(echo claude), ...), else None."""
    toks = _words(body)
    if not toks:
        return None
    base, rest = os.path.basename(toks[0]), toks[1:]
    if base in LOOKUPS:
        for a in rest:
            a = a.strip("'\"")
            if a.startswith("-"):
                continue
            if os.path.basename(a) in CLAUDE_NAMES:
                return "claude"
        return None
    if base in ("echo", "printf"):
        args = [a for a in rest if not re.fullmatch(r"-[neE]+", a)]
        if base == "printf" and args and "%" in args[0]:
            args = args[1:]
        if args and os.path.basename(args[0].strip("'\"")) in CLAUDE_NAMES:
            return "claude"
        return None
    if base == "cat":
        args = [a.strip("'\"") for a in rest if not a.startswith("-")]
        if len(args) == 1 and os.path.basename(args[0]) in CLAUDE_NAMES:
            return "claude"
    return None


# ── option parsing ──
def _getopt(args, value_chars):
    """POSIX short-option cluster parsing -> ({flag: value or None}, operands)."""
    opts, i = {}, 0
    while i < len(args):
        a = args[i]
        if a == "--":
            i += 1
            break
        if not a.startswith("-") or a == "-":
            break
        j = 1
        while j < len(a):
            ch = a[j]
            if ch in value_chars:
                if j + 1 < len(a):
                    opts[ch] = a[j + 1:]
                else:
                    opts[ch] = args[i + 1] if i + 1 < len(args) else ""
                    i += 1
                break
            opts[ch] = None
            j += 1
        i += 1
    return opts, args[i:]


def _skip_long_short(args, short_values, long_values, flags=None):
    """Index of the first operand after GNU-style options (short_values / long_values take one)."""
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            return i + 1
        if flags is not None and a in flags:
            i += 1
            continue
        if a.startswith("--"):
            name = a.split("=", 1)[0]
            i += 2 if (name in long_values and "=" not in a) else 1
            continue
        if a.startswith("-") and len(a) > 1:
            step = 1
            for j in range(1, len(a)):
                if a[j] in short_values:
                    step = 2 if j + 1 == len(a) else 1
                    break
            i += step
            continue
        return i
    return i


def _skip_wrapper(toks, i, base):
    """Index of the wrapped command inside toks (cluster-aware option skipping)."""
    shorts, longs, flags = WRAP[base]
    i += 1
    i += _skip_long_short(toks[i:], shorts, longs, flags)
    if base == "env":
        while i < len(toks) and ASSIGN_RE.match(toks[i]):
            i += 1
    return i + WRAP_POSITIONAL.get(base, 0)


def _tmux(args):
    opts, rest = _getopt(args, TMUX_GLOBAL_VALUES)
    found = []
    if opts.get("c"):
        found.append(("shell", opts["c"], "tmux -c"))
    commands, cur = [], []
    for tok in rest:
        if tok in (";", "\\;"):
            commands.append(cur)
            cur = []
        elif tok.endswith(";") and not tok.endswith("\\;") and len(tok) > 1:
            cur.append(tok[:-1])
            commands.append(cur)
            cur = []
        else:
            cur.append(tok)
    commands.append(cur)
    for cmd in commands:
        if not cmd:
            continue
        name, cargs = cmd[0], cmd[1:]
        if name in TMUX_SPAWN:
            _o, operands = _getopt(cargs, TMUX_SPAWN[name])
            if len(operands) == 1:
                found.append(("shell", operands[0], "tmux " + name))
            elif operands:
                found.append(("argv", operands, "tmux " + name))
        elif name in TMUX_SEND:
            o, keys = _getopt(cargs, TMUX_SEND[name])
            found.append(("shell", _tmux_keys(keys, "l" in o), "tmux " + name))
        elif name in TMUX_SHELL_CMDS:
            _o, operands = _getopt(cargs, TMUX_SHELL_CMDS[name])
            if operands:
                found.append(("shell", " ".join(operands), "tmux " + name))
    return found


def _tmux_keys(keys, literal):
    parts = []
    for key in keys:
        if literal:
            parts.append(key)
        elif key in TMUX_ENTER:
            parts.append("\n")
        elif key == "Space":
            parts.append(" ")
        elif TMUX_KEYNAME_RE.match(key):
            parts.append("\n")
        else:
            parts.append(key)
    return "".join(parts)


def _stuff_text(text):
    """A screen `stuff` string with its Enter keystrokes rendered as newlines."""
    text = text.replace("__SUBST__", "\n")  # a command substitution counts as a keystroke
    text = re.sub(r"\$\(\s*(?:printf|echo)\b[^)]*\)?", "\n", text)
    for esc in ("\\n", "\\r", "^M", "^J", "\\015", "\\012"):
        text = text.replace(esc, "\n")
    return text


def _screen(args):
    i, launch, attach = 0, False, False
    while i < len(args):
        a = args[i]
        if a == "-X":
            sub = args[i + 1:]
            if sub and sub[0] == "stuff":
                return [("shell", _stuff_text(" ".join(sub[1:])), "screen -X stuff")]
            if sub and sub[0] == "eval":
                found = []
                for term in sub[1:]:
                    parts = term.split(None, 1)
                    if not parts:
                        continue
                    if parts[0] == "screen" and len(parts) > 1:
                        _o, argv = _getopt(_words(parts[1]), "tTh")
                        if argv:
                            found.append(("argv", argv, "screen -X eval screen"))
                    elif parts[0] == "stuff" and len(parts) > 1:
                        found.append(("shell", _stuff_text(parts[1]), "screen -X eval stuff"))
                return found
            if sub and sub[0] == "screen":
                _o, argv = _getopt(sub[1:], "tTh")
                return [("argv", argv, "screen -X screen")] if argv else []
            return []
        if a in ("-ls", "-list", "-wipe", "-v", "-version", "--version", "-help", "--help"):
            return []
        if a == "-Logfile":
            i += 2
            continue
        if a == "--":
            i += 1
            break
        if a.startswith("-") and len(a) > 1:
            step = 1
            for j in range(1, len(a)):
                ch = a[j]
                if ch == "m":
                    launch = True
                elif ch in "rRx" or (ch in "dD" and "m" not in a):
                    attach = True
                if ch in SCREEN_VALUES:
                    if ch == "X":
                        return _screen(["-X"] + ([a[j + 1:]] if j + 1 < len(a) else []) + args[i + 1:])
                    step = 2 if j + 1 == len(a) else 1
                    break
            i += step
            continue
        break
    if attach and not launch:
        return []
    rest = args[i:]
    return [("argv", rest, "screen")] if rest else []


def _script(args):
    for i, a in enumerate(args):
        if a in ("-c", "--command"):
            return [("shell", args[i + 1], "script -c")] if i + 1 < len(args) else []
        if a.startswith("--command="):
            return [("shell", a.split("=", 1)[1], "script -c")]
        if a.startswith("-") and not a.startswith("--") and "c" in a[1:]:
            tail = a[a.index("c", 1) + 1:]
            if tail:
                return [("shell", tail, "script -c")]
            return [("shell", args[i + 1], "script -c")] if i + 1 < len(args) else []
    return []


def _vehicle(base, args):
    """[(kind, payload, label)] commands a vehicle starts: kind 'argv' (tokens) or 'shell' (text)."""
    if base == "nohup":
        if args[:1] and args[0] in ("--help", "--version"):
            return []
        rest = args[1:] if args[:1] == ["--"] else args
        return [("argv", rest, "nohup")] if rest else []
    if base == "setsid":
        rest = args[_skip_long_short(args, "", set(), SETSID_FLAGS):]
        return [("argv", rest, "setsid")] if rest else []
    if base == "systemd-run":
        rest = args[_skip_long_short(args, SYSTEMD_RUN_VALUE_SHORT, SYSTEMD_RUN_VALUE_LONG):]
        return [("argv", rest, "systemd-run")] if rest else []
    if base == "tmux":
        return _tmux(args)
    if base == "screen":
        return _screen(args)
    if base == "script":
        return _script(args)
    return []


def _shell_stdin(args):
    """(script, reads_stdin, here_texts) for a shell invocation: -c string, whether it reads
    stdin (bare shell / -s, no script operand), and any `<<< text` pairs."""
    here, i, n = [], 0, len(args)
    while i < n:
        a = args[i]
        if a == "<<<":
            if i + 1 < n:
                here.append(args[i + 1])
            i += 2
            continue
        if a.startswith("<<<"):
            here.append(a[3:])
            i += 1
            continue
        if a in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
            i += 2
            continue
        if a == "--":
            return (None, False, here)  # `bash -- file`: a script operand follows
        m = REDIR_RE.match(a)
        if m and not m.group(0).startswith("<<<"):
            i += 1 if m.group(1) else 2
            continue
        if a == "-":
            return (None, True, here)
        if (a.startswith("-") or a.startswith("+")) and len(a) > 1:
            if "c" in a[1:]:
                return (args[i + 1] if i + 1 < n else None, False, here)
            i += 1
            continue
        return (None, False, here)  # a script operand: not stdin
    return (None, True, here)


def _su_like(base, args):
    for i, a in enumerate(args):
        if a in ("-c", "--command"):
            return [("shell", args[i + 1])] if i + 1 < len(args) else []
        if a.startswith("--command="):
            return [("shell", a.split("=", 1)[1])]
    if base == "runuser" and "--" in args:
        return [("argv", args[args.index("--") + 1:])]
    return []


def _here_texts(tokens):
    """The `<<< text` payloads among raw tokens."""
    out = []
    for k, t in enumerate(tokens):
        if t == "<<<" and k + 1 < len(tokens):
            out.append(tokens[k + 1])
        elif t.startswith("<<<") and len(t) > 3:
            out.append(t[3:])
    return out


# ── interpreter code (python -c / node -e / perl -e / ruby -e) ──
def _claude_word(s):
    return bool(re.search(r"(?:^|[^A-Za-z0-9_.-])claude(?:\.exe)?(?:$|[^A-Za-z0-9_.-])", s))


def _marker_vehicle(code, vehicle, what):
    """The launch vehicle for an inline payload: the outer one, else the payload's own background
    marker (& nohup setsid disown Popen spawn start_new_session detached fork child_process)."""
    if vehicle:
        return vehicle
    m = BG_MARKER_RE.search(code)
    return "%s with a background marker `%s`" % (what, m.group(0)) if m else None


def _judge_code(code, vehicle, depth, out, lang=None):
    """Deny interpreter / awk source that spawns claude in the background (outer vehicle or a
    background marker in the code, -p included) or interactively (no -p/--print). String literals
    are judged: shell-like ones as shell text, bare names as argv."""
    if depth > MAX_DEPTH or not code or not _claude_word(code):
        return
    if lang == "expect":
        _judge_expect(code, vehicle, depth, out)
        return
    if not (AWK_SPAWN_RE if lang == "awk" else CODE_SPAWN_RE).search(code):
        return
    veh = _marker_vehicle(code, vehicle, "%s code" % (lang or "interpreter"))
    lits = [(m.start(), m.group()) for m in _CODE_LIT_RE.finditer(code)]
    for idx, (pos, lit) in enumerate(lits):
        inner = lit[1:-1] if len(lit) >= 2 and lit[0] == lit[-1] and lit[0] in "'\"`" else lit
        if not _claude_word(inner):
            continue
        if re.search(r"[\s;&|<>()$]", inner) or lit[0] == "`" or "/" in inner:
            _scan(inner, veh, depth + 1, out)
            continue
        if veh:
            out.append("interpreter code spawning `claude` through %s" % veh)
            return
        nxt = [x[1] for x in lits[idx + 1:idx + 4]]
        if any(n.strip("'\"") in ("-p", "--print") for n in nxt):
            continue
        out.append("interpreter code spawning an interactive/background `claude` (no -p/--print)")
        return


def _tcl_commands(code):
    """Word lists of the Tcl commands in expect code ([...] / {...} bodies flattened)."""
    text = re.sub(r"[\[\]{}]", "\n", code)
    return [w for w in (_words(c) for c in re.split(r"[\n;]", text)) if w]


def _judge_expect(code, vehicle, depth, out):
    """expect -c code: `spawn` is a background marker (owner GAP-8), so any claude word in a
    payload with a marker or an outer vehicle is denied; exec/system are judged as commands."""
    if not EXPECT_SPAWN_RE.search(code):
        return
    veh = _marker_vehicle(code, vehicle, "expect code")
    for words in _tcl_commands(code):
        head, rest = words[0], words[1:]
        if veh:
            for w in words:
                if _name_of(w) in CLAUDE_NAMES:
                    out.append("expect code naming `claude` through %s" % veh)
                    return
                if _claude_word(w) and re.search(r"\s", w):
                    _scan(w.replace("\\r", "\n").replace("\\n", "\n"), veh, depth + 1, out)
            continue
        if head == "exec":
            bg = bool(rest) and rest[-1] == "&"
            args = [a for a in rest if a != "&" and a not in ("-keepnewline", "-ignorestderr", "--")]
            if args:
                _judge_tokens(args, BG_LABEL if bg else None, depth + 1, out)
        elif head == "system" and rest:
            _scan(" ".join(rest), None, depth + 1, out)


def _awk_program(args):
    """The program text of awk/gawk/mawk: -e/--source texts or the first operand; `-f progfile`
    is a script file (documented limit)."""
    progs, i, n = [], 0, len(args)
    while i < n:
        a = args[i]
        if a == "--":
            i += 1
            break
        if a in ("-f", "--file", "-E", "--exec"):
            return "\n".join(progs)
        if a in ("-e", "--source") and i + 1 < n:
            progs.append(args[i + 1])
            i += 2
            continue
        if a.startswith("--source="):
            progs.append(a.split("=", 1)[1])
            i += 1
            continue
        if a in ("-F", "-v", "--assign", "--field-separator", "-i", "--include", "-l", "--load"):
            i += 2
            continue
        if a.startswith("-") and len(a) > 1:
            i += 1
            continue
        break
    if not progs and i < n:
        progs.append(args[i])
    return "\n".join(progs)


def _expect_code(args):
    """The -c command strings of an expect invocation (plus here-strings when it reads stdin)."""
    codes, i, n = [], 0, len(args)
    while i < n:
        a = args[i]
        if a == "<<<":
            if i + 1 < n:
                codes.append(args[i + 1])
            i += 2
            continue
        if a.startswith("<<<"):
            codes.append(a[3:])
            i += 1
            continue
        if a == "-c" and i + 1 < n:
            codes.append(args[i + 1])
            i += 2
            continue
        if a.startswith("-c") and len(a) > 2:
            codes.append(a[2:])
            i += 1
            continue
        if a in ("-D", "-f", "-b") and i + 1 < n:
            i += 2
            continue
        i += 1
    return codes


def _interp_code(base, args):
    """(code, reads_stdin) for an interpreter invocation; code None + not stdin = script file."""
    fam = "python"
    for name in ("node", "perl", "ruby"):
        if base.startswith(name[:4]):
            fam = name
            break
    code_flags = INTERP_FAMILY.get(fam, {"-c", "-e", "--eval"})
    here = []
    j, n = 0, len(args)
    while j < n:
        a = args[j]
        if a == "<<<":
            if j + 1 < n:
                here.append(args[j + 1])
            j += 2
            continue
        if a.startswith("<<<"):
            here.append(a[3:])
            j += 1
            continue
        if a == "--":
            return None, here
        m = REDIR_RE.match(a)
        if m and not m.group(0).startswith("<<<"):
            j += 1 if m.group(1) else 2
            continue
        if a in code_flags:
            return (args[j + 1] if j + 1 < n else ""), here
        if a.startswith("--eval="):
            return a.split("=", 1)[1], here
        if a == "-":
            return None, here + [""]  # stdin script
        if a.startswith("-") and len(a) > 1:
            if a in ("-m", "-W", "-X", "-Q", "-r", "--require"):
                j += 2
                continue
            j += 1
            continue
        return None, here  # a script operand (documented limit)
    return None, here


def _eff_index(toks):
    """Index of the command a token list runs after wrappers/assignments/keywords, or None."""
    i = 0
    while i < len(toks):
        t = toks[i]
        if ASSIGN_RE.match(t) or t in KEYWORDS:
            i += 1
            continue
        b = _name_of(t)
        if b in WRAP:
            i = _skip_wrapper(toks, i, b)
            continue
        return i
    return None


def _eff_base(toks):
    """The command a token list runs after wrappers/assignments/keywords (`sudo bash` -> bash)."""
    i = _eff_index(toks)
    return None if i is None else _name_of(toks[i])


def _stdin_scripts(words, idx):
    """Candidate stdin scripts a piped consumer at words[idx] receives: echo/printf renderings,
    here-strings, and pass-through producers (cat/tee) chained through pipes."""
    texts, j, hops = [], idx - 1, 0
    while j >= 0 and hops <= 4:
        tokens, _bg, piped = words[j]
        toks = _drop_redirects(tokens)
        here = _here_texts(tokens)
        base = os.path.basename(toks[0]) if toks else ""
        new = list(here)
        if base in ("cat", "tee") and all(a.startswith("-") for a in toks[1:]):
            pass  # pass-through: keep walking for the real producer
        elif base == "echo":
            args = [a for a in toks[1:] if not re.fullmatch(r"-[neE]+", a)]
            if args:
                new.append(" ".join(args))
        elif base == "printf":
            args = toks[1:]
            if args:
                new.append(" ".join(args))
                if "%" in args[0] and len(args) > 1:
                    new.append(" ".join(args[1:]))
        else:
            break
        for t in list(new):
            if "\\n" in t or "\\t" in t:
                new.append(t.replace("\\n", " ").replace("\\t", " "))
        texts = new + texts
        if not piped or j == 0:
            break
        j -= 1
        hops += 1
    return [t for t in texts if t and t.strip()]


def _is_claude_target(word):
    w = word.strip("'\"")
    return os.path.basename(w) in CLAUDE_NAMES or bool(CLAUDE_PKG_RE.search(w))


def _pkg_exec_argv(base, args, vehicle, depth, out):
    """claude argv when npx/bunx/pnpx or `npm|pnpm|yarn|bun exec|dlx|x` runs the claude-code
    package (or a `claude` bin); `npx -c 'cmd'` strings are scanned. None otherwise."""
    i, n, need_sub = 0, len(args), base in PKG_RUNNERS
    while i < n:
        a = args[i]
        if a == "--":
            i += 1
            continue
        if a in ("-c", "--call") and i + 1 < n and (base in NPX_LIKE or not need_sub):
            _scan(args[i + 1], vehicle, depth + 1, out)
            return None
        if a.startswith("-"):
            name = a.split("=", 1)[0]
            i += 2 if (name in PKG_VALUE_OPTS and "=" not in a) else 1
            continue
        if need_sub:
            if a not in PKG_EXEC_SUBCMDS:
                return None
            need_sub = False
            i += 1
            continue
        return args[i + 1:] if _is_claude_target(a) else None
    return None


def _node_claude_argv(args):
    """claude argv when node/bun runs a claude-code package script, else None."""
    i, n = 0, len(args)
    while i < n:
        a = args[i]
        if a in ("-e", "-p", "--eval", "--print", "-c", "--check") or a.startswith("--eval="):
            return None
        if a.startswith("-"):
            i += 2 if (a in NODE_VALUE_OPTS and "=" not in a) else 1
            continue
        if a == "run" and i + 1 < n:  # `bun run <script>`
            i += 1
            continue
        return args[i + 1:] if CLAUDE_PKG_RE.search(a) else None
    return None


def _ipv4_value(h):
    """The 32-bit value of an inet_aton-style IPv4 literal (127.1, 0x7f.1, 2130706433, 0177.0.0.1,
    0), or None when `h` is not one."""
    parts = h.split(".")
    if not 1 <= len(parts) <= 4 or not all(_IPV4_PART_RE.fullmatch(p) for p in parts):
        return None
    vals = [int(p, 16) if p[:2] in ("0x", "0X") else int(p, 8) if len(p) > 1 and p[0] == "0"
            else int(p) for p in parts]
    last_bits = 32 - 8 * (len(vals) - 1)
    if any(v > 0xFF for v in vals[:-1]) or vals[-1] >= 1 << last_bits:
        return None
    value = vals[-1]
    for k, v in enumerate(vals[:-1]):
        value |= v << (24 - 8 * k)
    return value


def _ipv6_is_local(h):
    """True for an IPv6 loopback / unspecified address, also IPv4-mapped (::ffff:127.0.0.1)."""
    try:
        import ipaddress
        ip = ipaddress.IPv6Address(h)
    except (ImportError, ValueError):
        return False
    mapped = ip.ipv4_mapped
    if mapped is not None:
        return mapped.is_loopback or int(mapped) == 0
    return ip.is_loopback or ip.is_unspecified


def _host_is_local(dest):
    """True when an ssh destination is this host: 127.0.0.0/8 in any inet_aton form, 0 / 0.0.0.0,
    ::1 / :: (also IPv4-mapped), localhost, localhost.*, *.localhost, ip6-localhost, the host name."""
    h = (dest or "").strip()
    if h.lower().startswith("ssh://"):
        h = h[6:].split("/", 1)[0]
    h = h.rsplit("@", 1)[-1]
    if h.startswith("["):
        h = h[1:].split("]", 1)[0]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    h = h.split("%", 1)[0].lower().rstrip(".")
    if not h:
        return False
    if h in LOCAL_HOSTS or h.startswith("localhost.") or h.endswith(".localhost"):
        return True
    v4 = _ipv4_value(h)
    if v4 is not None:
        return v4 == 0 or v4 >> 24 == 127
    if ":" in h:
        return _ipv6_is_local(h)
    try:
        node = os.uname().nodename.lower()
    except Exception:
        return False
    return bool(node) and h in (node, node.split(".", 1)[0])


def _ssh_options(args, start, hostnames):
    """Parse OpenSSH options from args[start:] (collecting -o HostName values); returns
    (index of the first operand, `--` seen)."""
    i, n = start, len(args)
    while i < n:
        a = args[i]
        if a == "--":
            return i + 1, True
        if not a.startswith("-") or a == "-":
            return i, False
        j = 1
        while j < len(a):
            ch = a[j]
            if ch in SSH_VALUES:
                if j + 1 < len(a):
                    val = a[j + 1:]
                else:
                    val = args[i + 1] if i + 1 < n else ""
                    i += 1
                if ch == "o":
                    m = _SSH_HOSTNAME_RE.match(val)
                    if m:
                        hostnames.append(m.group(1))
                break
            j += 1
        i += 1
    return i, False


def _ssh_local(args):
    """(dest is this host, [remote command text + here-string payloads]). OpenSSH resumes option
    parsing after the destination, and -o HostName=<local> redirects any destination here."""
    hostnames = []
    i, ended = _ssh_options(args, 0, hostnames)
    if i >= len(args):
        return False, []
    dest = args[i]
    i += 1
    if not ended:
        i, _ended = _ssh_options(args, i, hostnames)
    operands = args[i:]
    here = _here_texts(operands)
    words, skip = [], False
    for w in operands:
        if skip:
            skip = False
            continue
        if w == "<<<":
            skip = True
            continue
        if w.startswith("<<<"):
            continue
        words.append(w)
    host = dest.rsplit("@", 1)[-1]
    local = _host_is_local(dest) or any(_host_is_local(h.replace("%h", host)) for h in hostnames)
    return local, [" ".join(words)] + here


def _raw_words(seg):
    """Split a segment at unquoted blanks, keeping quotes (word boundaries for assignments)."""
    words, buf, quote, i, n = [], [], None, 0, len(seg)
    while i < n:
        c = seg[i]
        if quote:
            buf.append(c)
            if c == "\\" and quote == '"' and i + 1 < n:
                buf.append(seg[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"":
            quote = c
        elif c == "\\" and i + 1 < n:
            buf.append(seg[i:i + 2])
            i += 2
            continue
        elif c == "$" and seg.startswith("${", i):
            j = seg.find("}", i)
            j = n if j < 0 else j + 1
            buf.append(seg[i:j])
            i = j
            continue
        elif c in " \t\n":
            if buf:
                words.append("".join(buf))
                buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    if buf:
        words.append("".join(buf))
    return words


def _quote_for(value, quote):
    """A variable value rendered for its expansion context (double quotes / unquoted + split)."""
    if quote == '"':
        return value.replace("\\", "\\\\").replace('"', '\\"')
    return " ".join(shlex.quote(w) for w in value.split())


def _var_alternatives(m, quote):
    """Rendered candidate texts for one $NAME / ${NAME...} match, or None to keep it literal."""
    env = _ALIAS["env"]
    bang, name, op, word, other, plain = m.groups()
    name = name or plain
    if bang:  # ${!R}: the value of the variable R names
        vals = [v for ref in env.get(name, ()) if re.fullmatch(r"[A-Za-z_]\w*", ref)
                for v in env.get(ref, ())]
        return [_quote_for(v, quote) for v in vals] or None
    vals = [_quote_for(v, quote) for v in env.get(name, ())]
    if op:
        if op.endswith("?"):
            return vals or None
        return [word, ""] if op.endswith("+") else vals + [word]
    if other:  # ${X%...} ${X/...} ${X:0:6}: not emulated; claude in reach stays a candidate
        if vals and any("claude" in v for v in env.get(name, ())) or "claude" in other:
            return vals + ["claude"]
        return vals or None
    return vals or None


def _expand_text(text, limit=MAX_EXPANSIONS):
    """Candidate texts of `text` with known same-command variables substituted (quote aware:
    none in single quotes, one word in double quotes, split words unquoted). [text] when none."""
    if "$" not in text:
        return [text]
    pieces, lit, quote, i, n = [], [], None, 0, len(text)
    while i < n:
        c = text[i]
        if quote == "'":
            lit.append(c)
            if c == "'":
                quote = None
            i += 1
            continue
        if c == "\\":
            lit.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and quote is None:
            quote = "'"
        elif c == '"':
            quote = None if quote == '"' else '"'
        elif c == "$":
            m = _VAR_RE.match(text, i)
            alts = _var_alternatives(m, quote) if m else None
            if alts is not None:
                pieces.append("".join(lit))
                pieces.append(alts)
                lit = []
                i = m.end()
                continue
        lit.append(c)
        i += 1
    pieces.append("".join(lit))
    out = [""]
    for p in pieces:
        if isinstance(p, str):
            out = [o + p for o in out]
        else:
            out = [o + a for o in out for a in p][:limit]
    return out or [text]


def _resolve_env():
    """Resolve the recorded assignments to a fixpoint (hops `Y=$X`, concatenation `${X}ude`,
    `"$X"ude`, `X+=ude`); then `vars` = names with a claude value."""
    raw, env = _ALIAS["raw"], _ALIAS["env"]
    for _ in range(MAX_ALIAS_HOPS):  # values update in place: a forward chain resolves in one pass
        changed = False
        for name, items in raw.items():
            vals, running = [], []
            for plus, value in items:
                cands = [" ".join(_words(t))[:MAX_VALUE_LEN] for t in _expand_text(value)]
                running = [(r + c)[:MAX_VALUE_LEN] for r in running for c in cands] if plus and running \
                    else cands
                vals.extend(running)
            vals = list(dict.fromkeys(vals))[:MAX_ALIAS_VALUES]
            if env.get(name) != vals:
                env[name] = vals
                changed = True
        if not changed:
            break
    _ALIAS["vars"] = {name for name, vals in _ALIAS["env"].items()
                      if any(v.split() and _is_claude_target(v.split()[0]) for v in vals)}


def _record(name, plus, value):
    items = _ALIAS["raw"].setdefault(name, [])
    if (plus, value) not in items:
        items.append((plus, value))


def _collect_aliases(segments):
    """Record same-command aliases from raw segment texts: assignments (`X=claude`, `Y=$X`,
    `X+=ude`, export/local/declare/readonly/typeset, `declare -n R=X`, `for X in claude`), then
    resolve them; and `ln [-s] <claude> DEST` link paths."""
    for seg in segments:
        rw = _raw_words(seg)
        i, declare, nameref = 0, False, False
        if rw and rw[0] in DECLARE_WORDS:
            declare, i = True, 1
        while i < len(rw):
            w = rw[i]
            if declare and w[:1] in "-+" and len(w) > 1:
                nameref = nameref or (w[0] == "-" and "n" in w[1:])
                i += 1
                continue
            m = _ASSIGN_RAW_RE.match(w)
            if not m:
                if declare and re.fullmatch(r"[A-Za-z_]\w*", w):
                    i += 1
                    continue
                break
            name, plus, value = m.group(1), m.group(2) == "+", m.group(3)
            if nameref:
                value = "${%s}" % "".join(_words(value))
            _record(name, plus, value)
            i += 1
        if len(rw) >= 3 and rw[0] in ("for", "select") and rw[2] == "in":
            for value in rw[3:]:
                _record(rw[1], False, value)
    if _ALIAS["raw"]:
        _resolve_env()
    for seg in segments:
        toks = _drop_redirects(_words(_expand_text(seg)[0]))
        i = 0
        while i < len(toks) and toks[i] in DECLARE_WORDS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
        while i < len(toks) and ASSIGN_RE.match(toks[i]):
            i += 1
        if i < len(toks) and os.path.basename(toks[i]) == "ln":
            pos, tdir, j, rest = [], None, 0, toks[i + 1:]
            while j < len(rest):
                a = rest[j]
                if a in ("-t", "--target-directory") and j + 1 < len(rest):
                    tdir, j = rest[j + 1], j + 2
                    continue
                if a.startswith("--target-directory="):
                    tdir = a.split("=", 1)[1]
                elif a in ("-S", "--suffix"):
                    j += 2
                    continue
                elif not (a.startswith("-") and a != "-"):
                    pos.append(a)
                j += 1
            if tdir is not None:
                srcs, dests = pos, [os.path.join(tdir, os.path.basename(s)) for s in pos]
            elif len(pos) >= 2:
                srcs, dests = pos[:-1], [pos[-1]] * (len(pos) - 1)
            else:
                srcs, dests = pos, [os.path.basename(s) for s in pos]
            for s, d in zip(srcs, dests):
                if _is_claude_target(s) and d:
                    for p in (d, os.path.join(d, os.path.basename(s))):
                        p = os.path.normpath(p)
                        if os.path.basename(p) in ("", ".", ".."):
                            continue
                        _ALIAS["paths"].add(p)
                        _ALIAS["names"].add(os.path.basename(p))


def _decoded_upstream(words, idx):
    """True when a stage piping into words[idx] decodes base64/encoded bytes."""
    j = idx - 1
    while j >= 0:
        if DECODE_RE.search(" " + " ".join(_drop_redirects(words[j][0])) + " "):
            return True
        if not words[j][2]:
            break
        j -= 1
    return False


def _judge_claude(args, vehicle):
    head = []
    for a in args:
        if a == "--":
            break
        head.append(a)
    for a in head:
        if a.split("=", 1)[0] in BG_FLAGS:
            return "`claude %s` (a background/cloud/teleport session)" % a
    if vehicle:
        return "`claude` started through %s" % vehicle  # every form, -p included
    if "-p" in head or "--print" in head:
        return None
    if any(a in READONLY_FLAGS for a in head):
        return None
    if head[:1] == ["mcp"] and head[1:2] and head[1] in ("list", "get"):
        return None
    if head[:2] == ["auth", "status"]:
        return None
    if head[:1] in (["config"], ["doctor"], ["agents"]):
        return None
    return "an interactive `claude` session (no -p/--print)"


def _judge_tokens(tokens, vehicle, depth, out):
    toks = _drop_redirects(tokens)
    i = 0
    while i < len(toks):
        tok = toks[i]
        if tok in KEYWORDS or ASSIGN_RE.match(tok):
            i += 1
            continue
        base = _name_of(tok)
        args = toks[i + 1:]
        if base in CLAUDE_NAMES:
            reason = _judge_claude(args, vehicle)
            if reason:
                out.append(reason)
            return
        if base in NPX_LIKE or base in PKG_RUNNERS:
            rest = _pkg_exec_argv(base, args, vehicle, depth, out)
            if rest is not None:
                reason = _judge_claude(rest, vehicle)
                if reason:
                    out.append(reason)
            return
        if base in NODE_FAMILY:
            rest = _node_claude_argv(args)
            if rest is not None:
                reason = _judge_claude(rest, vehicle)
                if reason:
                    out.append(reason)
                return
        if base in AT_LIKE:
            for t in _here_texts(args):
                _scan(t, base, depth + 1, out)
            return
        if base == "coproc":
            rest = list(args)
            if len(rest) > 1 and re.fullmatch(r"[A-Za-z_]\w*", rest[0]) and rest[1] in ("{", "("):
                rest = rest[1:]
            while rest and rest[0] in ("{", "("):
                rest = rest[1:]
            if rest:
                _judge_tokens(rest, "coproc", depth + 1, out)
            return
        if base == "ssh":
            local, texts = _ssh_local(args)
            if local:
                for t in texts:
                    _scan(t, "ssh to this host", depth + 1, out)
            return
        if base in VEHICLES:
            for kind, payload, label in _vehicle(base, args):
                if kind == "argv":
                    _judge_tokens(payload, label, depth + 1, out)
                else:
                    _scan(payload, label, depth + 1, out)
            return
        if base in SHELLS:
            script, reads, here = _shell_stdin(args)
            if script is not None:
                _scan(script, vehicle, depth + 1, out)
                return
            if reads or here:
                for t in here:
                    _scan(t, vehicle, depth + 1, out)
            return
        if _INTERP_RE.match(base):
            code, here = _interp_code(base, args)
            if code is not None:
                _judge_code(code, vehicle, depth + 1, out)
            else:
                for t in here:
                    _judge_code(t, vehicle, depth + 1, out)
            return
        if base in AWK_NAMES:
            _judge_code(_awk_program(args), vehicle, depth + 1, out, lang="awk")
            return
        if base == "expect":
            for code in _expect_code(args):
                _judge_code(code, vehicle, depth + 1, out, lang="expect")
            return
        if base == "eval":
            _scan(" ".join(args), vehicle, depth + 1, out)
            return
        if base in ("su", "runuser"):
            for kind, payload in _su_like(base, args):
                if kind == "argv":
                    _judge_tokens(payload, vehicle, depth + 1, out)
                else:
                    _scan(payload, vehicle, depth + 1, out)
            return
        if base == "flock":
            done = False
            for j, a in enumerate(args):
                if a in ("-c", "--command") and j + 1 < len(args):
                    _scan(args[j + 1], vehicle, depth + 1, out)
                    done = True
                    break
                if a.startswith("--command="):
                    _scan(a.split("=", 1)[1], vehicle, depth + 1, out)
                    done = True
                    break
            if done:
                return
            i = _skip_wrapper(toks, i, base)
            continue
        if base == "env" and any(a in ("-S", "--split-string") or a.startswith("--split-string=")
                                 for a in args[:1]):
            value = args[0].split("=", 1)[1] if "=" in args[0] else (args[1] if len(args) > 1 else "")
            _scan(value, vehicle, depth + 1, out)
            return
        if base == "command" and args[:1] and args[0] in ("-v", "-V"):
            return
        if base == "find":
            rest = args
            for j, a in enumerate(rest):
                if a in ("-exec", "-execdir", "-ok", "-okdir"):
                    cmd = []
                    for b in rest[j + 1:]:
                        if b in (";", "+"):
                            break
                        cmd.append(b)
                    if cmd:
                        _judge_tokens(cmd, vehicle, depth + 1, out)
            return
        if base == "start-stop-daemon":
            j, bg, rest_start = 0, False, len(args)
            while j < len(args):
                a = args[j]
                if a == "--":
                    rest_start = j + 1
                    break
                if a in ("-b", "--background"):
                    bg = True
                    j += 1
                    continue
                if a in ("-x", "--exec", "-s", "--startas") and j + 1 < len(args):
                    if os.path.basename(args[j + 1]) in CLAUDE_NAMES:
                        out.append("`claude` started through start-stop-daemon")
                        return
                    j += 2
                    continue
                if a.startswith("-"):
                    two = (a in ("-p", "--pidfile", "-u", "--user", "-d", "--chdir", "-c",
                                 "--chroot", "-s", "--signal", "-r", "--retry", "-t",
                                 "--stop-timeout", "-N", "--nicelevel", "--umask", "--name")
                           and "=" not in a)
                    j += 2 if two else 1
                    continue
                rest_start = j
                break
            rest = args[rest_start:]
            if rest:
                _judge_tokens(rest, "start-stop-daemon" + (" --background" if bg else ""),
                              depth + 1, out)
            return
        if base in WRAP:
            i = _skip_wrapper(toks, i, base)
            continue
        return


def _safe_collect(segments):
    try:
        _collect_aliases(segments)
    except Exception:
        pass  # alias tracking is best effort; the scan itself goes on


def _scan(text, vehicle, depth, out):
    if depth > MAX_DEPTH or not text:
        return
    try:  # aliases defined anywhere in this text count for every segment and nested body
        _safe_collect([s for s, _bg, _piped in _split(_strip_comments(text))[0]])
    except Exception:
        pass
    text = _strip_comments(text)
    text = _strip_functions(text, depth, out, vehicle)
    text = _strip_case(text)
    text, expansion_bodies = _heredocs(text)
    for body in expansion_bodies:
        _scan(body, vehicle, depth + 1, out)
    segments, substs = _split(text)
    _safe_collect([seg for seg, _bg, _piped in segments])
    for body, kind, sidx in substs:
        if kind == "proc":
            sub_vehicle = vehicle or PROCSUB_LABEL
        else:
            sub_vehicle = vehicle or (BG_LABEL if sidx < len(segments) and segments[sidx][1] else None)
        _scan(body, sub_vehicle, depth + 1, out)
    expanded = [_expand_text(seg) for seg, _bg, _piped in segments]
    words = [(_words(cands[0]), bg, piped) for cands, (_seg, bg, piped) in zip(expanded, segments)]
    for idx, (tokens, background, piped) in enumerate(words):
        toks = _drop_redirects(tokens)
        eff = _eff_base(toks)
        sink = eff in DECODE_SINKS or bool(eff and _INTERP_RE.match(eff))
        if sink and any(DECODED in t for t in toks):
            out.append(DECODED_LABEL)  # eval "$(... | base64 -d)", bash -c / <<< of a decode
            return
        # a piped bare shell / interpreter / at / local ssh executes its stdin (`echo claude | bash`)
        if piped and idx > 0:
            if sink and _decoded_upstream(words, idx):
                out.append(DECODED_LABEL)
                return
            consumer_vehicle = vehicle or (BG_LABEL if background else None)
            if eff in AT_LIKE:
                consumer_vehicle = eff
            elif eff == "ssh":
                local, _t = _ssh_local(toks[_eff_index(toks) + 1:])
                consumer_vehicle = "ssh to this host" if local else None
            if eff in SHELLS or eff in AT_LIKE or (eff == "ssh" and consumer_vehicle) or (
                    eff and _INTERP_RE.match(eff)):
                for script in _stdin_scripts(words, idx):
                    _scan(script, consumer_vehicle, depth + 1, out)
        seg_vehicle = vehicle or (BG_LABEL if background else None)
        _judge_tokens(tokens, seg_vehicle, depth, out)
        for alt in expanded[idx][1:]:  # other values a reassigned variable may hold
            _judge_tokens(_words(alt), seg_vehicle, depth, out)


RIB_LABEL = "the Bash tool's run_in_background"


def check(command, background=False):
    """Deny reason for a Bash command, or None to allow. `background` = the tool's run_in_background flag."""
    out = []
    for v in _ALIAS.values():
        v.clear()
    text = str(command or "")
    try:
        _scan(text, RIB_LABEL if background else None, 0, out)
    finally:
        for v in _ALIAS.values():
            v.clear()
    return REASON.format(what=out[0]) if out else None


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, RecursionError):  # bad or absurdly nested JSON: fail open
        return
    try:
        if not isinstance(data, dict) or data.get("tool_name") != "Bash":
            return
        tool_input = data.get("tool_input") or {}
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        if not isinstance(command, str) or not command.strip():
            return
        reason = check(command, background=tool_input.get("run_in_background") is True)
    except Exception:
        return  # fail open: a guard bug must never block the command
    if reason:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))


if __name__ == "__main__":
    main()
