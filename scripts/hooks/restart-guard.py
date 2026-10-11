#!/usr/bin/env python3
"""PreToolUse hook (Bash): deny raw restarts/kills of cloudcli and Claude session processes.

Every ${AI_SETUP_DOMAIN} session (and all its subagents) runs as a claude.exe child inside
cloudcli.service's control group, so `systemctl restart|stop cloudcli` kills every running
session mid-work, including the caller's own (root cause of the 2026-10-07 22:59/23:03 mid-task
subagent deaths). Restarts must go through ${AI_SETUP_ROOT}/scripts/safe-restart.sh, which waits
outside the cgroup until no session is mid-turn. `safe-restart.sh --now` (skips the wait) asks
the owner. Checks run per command segment; deterministic, fails open on any error.
Known accepted limit: variable indirection (`u=cloudcli; systemctl restart $u`) is not caught.

2026-10-09 (WO-5, audit B-F6: an agent SIGTERM'd two sibling claude.exe processes): signals to a
PROTECTED process are denied too. Protected = a live process named claude / claude.exe (comm or
argv[0]) or the CloudCLI server (cloudcli.service MainPID, or node running the live install).
Covered: literal PIDs and process groups (`kill -9 123`, `kill -- -PGID`, `kill -1`); variables
set in the same command (`P=123; kill "$P"`, `for p in $(...)`, `... | while read p`); `$PPID`;
command substitutions (`kill $(pgrep -f claude)`, `kill $(cat pidfile)`); `xargs kill` fed by a
lookup or by `echo PID`; pkill/killall/pgrep/pidof patterns and filters that match a protected
process (`pkill -f stream-json`, `pkill -P <server pid>`); `killall5`; `fuser -k` on the CloudCLI
port or paths; nested `bash -c` / `su -c` / `eval` and kills inside `$(...)`; `(kill PID)` subshells;
`xargs kill` fed by `< pidfile`, `-a pidfile`, `<<< PID` or `< <(lookup)`. Allowed: signal-0 probes
(`kill -0`, also `kill -0 $(pgrep claude)` / `pkill -0 claude`), `kill $!`, `kill %1`, `kill 0`, and
PIDs/patterns that only reach unprotected processes.
Static analysis only: nothing in the command is executed (PID files are read, never run).
Accepted limits: PIDs selected without naming claude/cloudcli (e.g. by process age) are not seen;
shell state from earlier tool calls does not persist, so an unset `$VAR` is allowed unless the
command itself looks up claude/cloudcli; heredoc bodies are analysed like commands.

2026-10-10 (audit H GAP-5 + review B): sending into the LIVE CloudCLI install or a live session is
denied too. Sessions: `claude --resume/-r <sid>` and `--session-id <sid>` where <sid> is live (runtime
state file or ~/.claude/sessions); with claude as the command also a bare `--resume`, `--from-pr`, and
`-c/--continue` when a live holder runs in the command's cwd (`cd` is tracked). --fork-session exempts
the resume/continue forms, never a live `--session-id`. Port 3011: any curl/wget/HTTPie/websocat/
wscat/nc/socat invocation, inline python/node/perl/ruby/php code (also heredoc/stdin programs) or
/dev/tcp redirection reaching :3011 that is not a plain GET/HEAD read. GETs/HEADs and every other
port (the scratch rig :3099) stay allowed; there is no override for :3011 writes. The session forms
are exempt only when the same segment STARTS with the env assignments CLOUDCLI_QA_SCRATCH=1 and
HOME=<the scratch root or a path under it> (the QA rig's own session store).
Accepted limits: ports built at run time (arithmetic, brace/glob expansion, variables from earlier
tool calls), script/config files read by a client, and `cd` targets that are not literal.
D1 2026-10-11: the session forms also follow `ln [-s] <claude> DEST` links executed in the same
command (`ln -sf $(which claude) /tmp/cc; /tmp/cc --resume <live sid>`), and statically decodable
base64 literals piped/substituted into a shell, interpreter, at/batch, ssh, eval or source
(`echo <b64> | base64 -d | bash`) are judged as commands (every check of this hook; opaque decoded
payloads are refused by agent-claude-launch-guard). Variable indirection, npx/node of the
claude-code package, at, coproc and ssh-to-localhost already reach the live-sid check.
GAP-7 attribution: every ALLOWED `systemctl ... cloudcli ...` segment writes one line (session id,
cwd, tool call id, the segment) to /var/tmp/claude/cloudcli-ops.log (RESTART_GUARD_ATTR_LOG
overrides) once the whole command is allowed — no secrets, reads only.
Gate-wave2 2026-10-11: safe-restart honours env test hooks (SAFE_RESTART_PROC_ROOT,
CLOUDCLI_RUNTIME_STATE, SAFE_RESTART_CGROUP_ROOT, SAFE_RESTART_TEST) that point its idle check at fake
state; a command that runs safe-restart(.sh) with one of them set (prefix, `env VAR=...`, export or an
assignment earlier in the same command) is denied.
"""
import codecs
import json
import os
import pwd
import re
import shlex
import signal
import stat
import subprocess
import sys
from collections import namedtuple
from pathlib import Path

# Resolved from the file location only, so an env var cannot redirect this guard.
ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT  # this repo holds the agent trees at its own root
DOMAIN = os.environ.get("AI_SETUP_DOMAIN", "localhost")

SAFE = "safe-restart.sh"
SEG = r"[^\n]*"
UNIT = r"(?<![\w.-])cloudcli(?:\.service)?(?![\w.-])"
PROC = r"(?<![\w.-])(?:cloudcli|claude(?:\.exe)?)(?![\w.-])"
PATTERNS = [
    re.compile(r"\bsystemctl\b" + SEG + r"\b(?:restart|stop|kill|try-restart|reload-or-restart|"
               r"try-reload-or-restart|condrestart|disable\s+--now|mask\s+--now)\b" + SEG + UNIT),
    re.compile(r"\bservice\s+" + UNIT + r"\s+(?:restart|stop|force-reload|try-restart|condrestart)\b"),
    re.compile(r"\b(?:pkill|killall)\b" + SEG + PROC),
    re.compile(r"\bkill\b" + SEG + r"(?:\$\(|`)\s*(?:pgrep|pidof)\b" + SEG + PROC),
]
PROBE_EXEMPT = (PATTERNS[2], PATTERNS[3])  # pkill/killall, kill $(pgrep ...): not denied for signal 0
SPLIT_RE = re.compile(r"\|\||&&|[;&|\n]")
WRAPPERS = {"sudo", "nohup", "env", "bash", "sh", "exec", "command", "time"}
REASON = ("restart-guard: cloudcli runs every Claude session and its subagents in its own cgroup, so "
          "restarting/killing it kills all running work (including this session). Use "
          f"`{AGENTS}/scripts/safe-restart.sh cloudcli` — it defers the restart until no session "
          "is mid-turn. `--now` only on an explicit owner order.")
ASK_REASON = ("restart-guard: `safe-restart.sh --now` skips the idle wait and kills every running Claude "
              "session and subagent. Run it only on an explicit owner order — confirm with the owner.")
SAFE_TEST_VARS = ("SAFE_RESTART_PROC_ROOT", "CLOUDCLI_RUNTIME_STATE", "SAFE_RESTART_CGROUP_ROOT", "SAFE_RESTART_TEST")
SAFE_TEST_SET_RE = re.compile(  # VAR=... (prefix, env, export/declare, plain) or `export ... VAR`
    r"(?<![\w$])(?:%s)\+?=|(?<![\w.-])(?:export|declare|typeset|readonly|local)(?![\w.-])[^;&|\n]*?"
    r"(?<![\w$-])(?:%s)(?!\w)" % ("|".join(SAFE_TEST_VARS), "|".join(SAFE_TEST_VARS)))
SAFE_TOKEN_RE = re.compile(r"(?<![\w.-])safe-restart(?:\.sh)?(?![\w.-])")
SAFE_TEST_REASON = ("restart-guard: safe-restart test hooks are test-only. SAFE_RESTART_PROC_ROOT, "
                    "CLOUDCLI_RUNTIME_STATE, SAFE_RESTART_CGROUP_ROOT and SAFE_RESTART_TEST point its idle check "
                    "at fake state, so it could restart cloudcli mid-turn. Run "
                    f"`{AGENTS}/scripts/safe-restart.sh cloudcli` without them; only its test suite sets them.")

# ── WO-5: signals to protected processes ──
CLOUDCLI_UNIT = "cloudcli.service"
CLOUDCLI_PORT = "3011"
LIVE_SERVER_MARKER = f"{AGENTS}/cloudcli/node_modules/@cloudcli-ai/cloudcli/"
CLAUDE_NAMES = {"claude", "claude.exe"}
AGENT_TMP = "/var/tmp/claude/"  # the agents' scratch dir: a path component, not a process name

# ── 2026-10-10, audit H GAP-5: the live install / live session ids ──
QA_SCRATCH_ENV = "CLOUDCLI_QA_SCRATCH"
QA_SCRATCH_HOME = "/var/tmp/claude/cc-scratch"
STATE_FILE = os.environ.get("CLOUDCLI_RUNTIME_STATE", "/run/cloudcli/runtime-state.json")
SESSIONS_DIR = os.path.expanduser("~/.claude/sessions")
LIVE_SEND_REASON = ("restart-guard: {what}. That writes into the LIVE CloudCLI install (every "
                    f"agent.{DOMAIN} session) or into a session another process holds; probes "
                    "must use the scratch rig on :3099.")
KILL_REASON = ("restart-guard: {what}. Signalling it kills a live Claude session and its subagents "
               "(2026-10-09 incident: an agent SIGTERM'd two sibling Claude processes). Agents never signal "
               f"Claude/CloudCLI processes: restart cloudcli only via `{AGENTS}/scripts/safe-restart.sh "
               "cloudcli`; a stuck or duplicate session is ended by the owner (Stop in the UI, or a terminal "
               "outside the agent). `kill -0 <pid>` liveness probes are allowed.")

KILL_HINT = re.compile(r"(?<![\w.-])(?:kill|pkill|killall5?|fuser)(?![\w.-])")
LIST_SPLIT = re.compile(r"\|\||&&|[;&\n]")
PIPE_SPLIT = re.compile(r"\|")
SUBST_RE = re.compile(r"\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)")  # $(...), `...`, <(...)
PH_RE = re.compile(r"__WO5S\d+__")
VAR_RE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*|[!$])\}?")
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
INT_RE = re.compile(r"-?\d+")
TAINT_PROC = re.compile(PROC)
TAINT_PKG = re.compile(r"@cloudcli-ai|@anthropic-ai/claude-code")
TAINT_PORT = re.compile(r"(?<!\d)" + CLOUDCLI_PORT + r"(?!\d)")
TAINT_SESSIONS = re.compile(r"\.claude/sessions\b")
TAINT_PPID = re.compile(r"(?i)\bppid\b")
SHELLS = {"bash", "sh", "dash", "zsh", "ksh"}
KEYWORDS = {"!", "{", "}", "(", ")", "do", "then", "else", "elif", "if", "while", "until", "time"}
WRAP_OPTS = {
    "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group", "--host",
             "--prompt", "--role", "--type", "--other-user", "--chdir", "--close-from", "--command-timeout"},
    "doas": {"-u", "-C"},
    "env": {"-u", "--unset", "-C", "--chdir"},
    "nice": {"-n", "--adjustment"},
    "ionice": {"-c", "-n", "-p", "-P", "-u", "--class", "--classdata"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "exec": {"-a"},
    "nohup": set(), "setsid": set(), "command": set(), "builtin": set(), "time": set(),
    "chrt": set(), "taskset": set(),
}
WRAP_POSITIONAL = {"timeout": 1, "chrt": 1, "taskset": 1}
SIGNAMES = {s.name[3:] for s in signal.Signals if s.name.startswith("SIG") and not s.name.startswith("SIG_")}
SIGNAMES |= {"IOT", "CLD", "POLL", "IO", "PWR", "STKFLT", "RTMIN", "RTMAX"}
PG_VALUE_SHORT = set("dgGPstuUFrOq")
PG_LONG_VALUE = {"--delimiter": "d", "--pgroup": "g", "--group": "G", "--parent": "P", "--session": "s",
                 "--terminal": "t", "--euid": "u", "--uid": "U", "--pidfile": "F", "--runstates": "r",
                 "--older": "O", "--queue": "q", "--signal": "signal", "--ns": "ns", "--nslist": "nslist",
                 "--cgroup": "cgroup", "--env": "env"}
PG_LONG_FLAG = {"--full": "f", "--ignore-case": "i", "--exact": "x", "--inverse": "v"}
PG_FILTERS = ("g", "G", "P", "s", "t", "u", "U", "F", "r", "O", "ns", "nslist", "cgroup", "env")
KA_VALUE_SHORT = set("suonyZ")
KA_LONG_VALUE = {"--signal": "s", "--user": "u", "--older-than": "o", "--younger-than": "y",
                 "--ns": "n", "--context": "Z"}
KA_LONG_FLAG = {"--exact": "e", "--ignore-case": "I", "--regexp": "r", "--list": "l", "--version": "V"}
XARGS_VALUE = {"--arg-file", "--delimiter", "--max-args", "--max-lines", "--max-procs", "--max-chars",
               "--process-slot-var"}
XARGS_SHORT_VALUE = set("aEdILnPs")
DYNAMIC = object()

Proc = namedtuple("Proc", "pid comm argv ppid pgid sid uid exe")


def _program(segment):
    """First real program token of a segment (skips sudo/env/VAR=x wrappers), basename only."""
    try:
        tokens = shlex.split(segment, comments=True)
    except ValueError:
        tokens = segment.split()
    for tok in tokens:
        if tok in WRAPPERS or tok.startswith("-") or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            continue
        return os.path.basename(tok)
    return ""


def _safe_restart_test_env(text):
    """True when the command runs safe-restart(.sh) with a test-hook variable (SAFE_TEST_VARS) set
    earlier in the same command or in the segment that runs it. Segments are split crudely (quotes
    ignored), so `bash -c '...'` / `env -S '...'` forms count; a data tool that only reads the
    script (grep, cat, git, ...) does not run it."""
    armed = False
    for segment in SPLIT_RE.split(text):
        if SAFE_TEST_SET_RE.search(segment):
            armed = True
        if armed and SAFE_TOKEN_RE.search(segment) and _program(segment) not in DATA_TOOLS:
            return True
    return False


def check(command, procs=None, cwd=None, _depth=0):
    """Return (decision, reason) — decision 'deny' | 'ask' — or None to allow.

    procs: optional ProcTable (tests inject one); cwd: the tool's working dir (relative PID files).
    _depth: internal (decoded-payload recursion; nested calls never write attribution lines).
    """
    if not isinstance(command, str):
        return None
    text = command.replace("\\\n", " ")
    try:  # gate-wave2: safe-restart's env test hooks never run outside its test suite
        if _safe_restart_test_env(text):
            return ("deny", SAFE_TEST_REASON)
    except Exception:
        pass
    if _depth == 0:
        _CLAUDE_ALIASES.clear()
    try:  # D1: claude symlinks created in this command count as claude
        _CLAUDE_ALIASES.update(_collect_link_aliases(text))
    except Exception:
        pass
    try:  # GAP-5 runs on the whole command (quote-aware); it fails open on its own
        live = _live_send_verdict(text, cwd=cwd)
    except Exception:
        live = None
    finally:
        if _depth == 0:
            _CLAUDE_ALIASES.clear()
    if live:
        return ("deny", LIVE_SEND_REASON.format(what=live))
    if _depth < 2:
        try:  # D1: a statically decodable base64 payload run by a shell is judged as the command
            payloads = _decoded_payloads(text)
        except Exception:
            payloads = []
        for payload in payloads:
            try:
                v = check(payload, procs, cwd, _depth + 1)
            except Exception:
                v = None
            if v and v[0] == "deny":
                return v
    ask = None
    attributions = []  # GAP-7: written only once the final decision is allow
    for segment in SPLIT_RE.split(text):
        if _program(segment) == SAFE:
            if re.search(r"(?<![\w-])--now\b", segment):
                ask = ("ask", ASK_REASON)
            continue
        code = re.split(r"(?:^|\s)#", segment, maxsplit=1)[0]  # drop a trailing shell comment
        for pat in PATTERNS:
            if pat.search(code):
                if pat in PROBE_EXEMPT and _signal_zero(code):
                    continue  # `kill -0 $(pgrep claude)` / `pkill -0 claude` deliver nothing
                return ("deny", REASON)
        if re.search(r"(?<![\w.-])systemctl(?![\w.-])", code) and re.search(UNIT, code):
            attributions.append(code)
    try:
        dev = _devnode_verdict(text)
    except Exception:
        dev = None
    if dev:
        return ("deny", DEVNODE_REASON.format(what=dev))
    try:  # the signal analysis fails open on its own; the patterns above already ran
        why = _kill_verdict(text, procs if procs is not None else ProcTable(), cwd)
    except Exception:
        why = None
    if why:
        return ("deny", KILL_REASON.format(what=why))
    if ask:
        return ask
    if _depth:
        return None
    for code in attributions:
        _attribute(code)  # GAP-7: each ALLOWED systemctl-mention of cloudcli gets one log line
    return None


# ── 2026-10-10: shared device nodes ──
# `cp -p <file> /dev/null` as root (2026-10-08 18:54) copied the source's 0644 mode onto /dev/null:
# every non-root service that opened it for writing died for two days. Redirections are fine;
# commands that change a device node's metadata or replace the node are not.
DEVNODE_RE = re.compile(r"^/dev/(?:null|zero|full|random|urandom|tty)$")
DEVNODE_REASON = ("restart-guard: {what}. That changes the mode/owner of, or replaces, a shared device node "
                  "and breaks every non-root service on the host (2026-10-08: `cp -p x /dev/null` made it "
                  "0644). Redirect to it (`>/dev/null`) instead; never chmod/chown/replace it.")
DEV_META_CMDS = {"chmod", "chown", "chgrp", "setfacl", "chattr", "mknod", "rm", "unlink", "mv", "ln",
                 "install", "rsync", "cp"}
CP_PRESERVE_SHORT = set("pa")  # -p (mode/owner/times), -a (archive = -dR --preserve=all)
CP_LONG = ("--preserve", "--archive", "--remove-destination", "--attributes-only")
DEV_OPT_VALUE = {  # short options that take a separate value word
    "install": {"-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"},
    "cp": {"-S", "--suffix"}, "ln": {"-S", "--suffix"}, "mv": {"-S", "--suffix"},
    "rsync": {"-e", "--rsh", "-f", "--filter", "--exclude", "--include", "-T", "--temp-dir"},
    "chown": {"--from", "--reference"}, "chmod": {"--reference"}, "mknod": {"-m", "--mode", "-Z"},
}
REDIR_TOK = re.compile(r"^[<>&|]+$")


def _devnode_words(segment):
    lex = shlex.shlex(segment, posix=True, punctuation_chars="<>&|")
    lex.whitespace_split = True
    lex.commenters = "#"
    tokens = list(lex)
    words, i = [], 0
    while i < len(tokens):
        tok = tokens[i]
        if REDIR_TOK.match(tok):
            i += 2  # the operator and its target
            continue
        if tok.isdigit() and i + 1 < len(tokens) and REDIR_TOK.match(tokens[i + 1]):
            i += 1  # the fd number of `2>/dev/null`
            continue
        words.append(tok)
        i += 1
    while words and (words[0] in WRAPPERS or words[0] in ("doas", "nice", "ionice", "setsid")
                     or ASSIGN_RE.match(words[0]) or (words[0].startswith("-") and len(words) > 1)):
        words = words[1:]
    return words


def _devnode_verdict(text):
    for segment in LIST_SPLIT.split(text):
        for part in PIPE_SPLIT.split(segment):
            words = _devnode_words(part)
            if not words:
                continue
            prog = os.path.basename(words[0])
            if prog not in DEV_META_CMDS:
                continue
            args, opts, pos, target_dir = words[1:], [], [], None
            i = 0
            while i < len(args):
                a = args[i]
                if a in ("-t", "--target-directory") and i + 1 < len(args):
                    target_dir = args[i + 1]
                    i += 2
                    continue
                if a.startswith("--target-directory="):
                    target_dir = a.split("=", 1)[1]
                elif a in DEV_OPT_VALUE.get(prog, ()) and i + 1 < len(args):
                    opts.append(a)
                    i += 2  # the option's value is not an operand
                    continue
                elif a.startswith("-") and a != "-":
                    opts.append(a)
                else:
                    pos.append(a)
                i += 1
            is_dev = lambda p: bool(DEVNODE_RE.match(os.path.normpath(p)))
            short = {c for o in opts if not o.startswith("--") for c in o[1:]}
            if prog in ("cp", "install", "ln", "rsync"):
                # a device as the SOURCE is harmless (`install -m 600 /dev/null key` makes an empty file)
                dests = [target_dir] if target_dir is not None else pos[-1:] if len(pos) > 1 else []
                if prog == "install" and ("d" in short or "--directory" in opts):
                    dests = pos
                devs = [d for d in dests if is_dev(d)]
                # cp without metadata flags only writes bytes into the device
                if prog == "cp" and not (short & CP_PRESERVE_SHORT or any(o.startswith(CP_LONG) for o in opts)):
                    devs = []
            else:
                devs = [p for p in pos + ([target_dir] if target_dir else []) if is_dev(p)]
            if devs:
                return f"`{prog}` targets {devs[0]}"
    return None


# ── process view ──
class ProcTable:
    """Process view: live /proc by default; tests inject `table` ({pid: Proc}) and `main_pid`."""
    _UNSET = object()

    def __init__(self, table=None, main_pid=_UNSET):
        self._table = table
        self._main = main_pid
        self._all = None
        self._prot = None

    def get(self, pid):
        if self._table is not None:
            return self._table.get(pid)
        return _read_proc(pid)

    def all(self):
        if self._table is not None:
            return list(self._table.values())
        if self._all is None:
            found = []
            for name in os.listdir("/proc"):
                if name.isdigit():
                    p = _read_proc(int(name))
                    if p is not None:
                        found.append(p)
            self._all = found
        return self._all

    def main_pid(self):
        if self._main is ProcTable._UNSET:
            self._main = _cloudcli_main_pid()
        return self._main

    def is_protected(self, p):
        if p is None:
            return False
        argv0 = os.path.basename(p.argv[0]) if p.argv else ""
        if p.comm in CLAUDE_NAMES or argv0 in CLAUDE_NAMES:
            return True
        if argv0.startswith("node") and any(LIVE_SERVER_MARKER in a for a in p.argv[1:3]):
            return True
        main = self.main_pid()
        return bool(main) and p.pid == main

    def protected(self):
        if self._prot is None:
            self._prot = [p for p in self.all() if self.is_protected(p)]
        return self._prot


def _read_proc(pid):
    base = "/proc/%d" % pid
    try:
        with open(base + "/stat", "rb") as fh:
            st = fh.read().decode("utf-8", "replace")
        with open(base + "/cmdline", "rb") as fh:
            raw = fh.read()
        uid = os.stat(base).st_uid
        comm = st[st.index("(") + 1:st.rindex(")")]
        rest = st[st.rindex(")") + 2:].split()
        ppid, pgid, sid = int(rest[1]), int(rest[2]), int(rest[3])
    except (OSError, ValueError, IndexError):
        return None
    try:
        exe = os.readlink(base + "/exe")
    except OSError:
        exe = ""
    argv = tuple(a.decode("utf-8", "replace") for a in raw.split(b"\0") if a)
    return Proc(pid, comm, argv, ppid, pgid, sid, uid, exe)


def _cloudcli_main_pid():
    try:
        out = subprocess.run(["systemctl", "show", "-p", "MainPID", "--value", CLOUDCLI_UNIT],
                             capture_output=True, text=True, timeout=2)
        return int(out.stdout.strip() or 0) or None
    except Exception:
        return None


# ── audit H GAP-5: live session ids (runtime state file + ~/.claude/sessions) ──
def _live_session_ids(state_file=None, sessions_dir=None):
    """Set of session ids currently held by a live CloudCLI process: providerSessionId /
    appSessionId entries in the runtime state file, plus sessionId of every ~/.claude/sessions/
    <pid>.json whose pid is alive and runs claude. Never raises."""
    ids = set()
    try:
        path = state_file or STATE_FILE
        with open(path, "r", encoding="utf-8") as fh:
            entries = json.load(fh)
        if isinstance(entries, list):
            for e in entries:
                if isinstance(e, dict):
                    for key in ("providerSessionId", "appSessionId"):
                        v = e.get(key)
                        if isinstance(v, str) and v:
                            ids.add(v)
    except Exception:
        pass
    try:
        sdir = sessions_dir or SESSIONS_DIR
        for name in os.listdir(sdir):
            base, dot, ext = name.rpartition(".")
            if ext != "json" or not dot or not base.isdigit():
                continue
            pid = int(base)
            if not os.path.exists("/proc/%d" % pid):
                continue  # dead pid: not live, cannot block
            try:
                with open(os.path.join(sdir, name), "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:
                continue  # malformed: does not block
            v = data.get("sessionId") if isinstance(data, dict) else None
            if isinstance(v, str) and v:
                ids.add(v)
    except Exception:
        pass
    return ids


def _live_holder_cwds(state_file=None, sessions_dir=None):
    """Working dirs of every live session holder: runtime state entries (an explicit cwd /
    projectPath field, else /proc/<pid>/cwd; an entry whose pid is gone is skipped) plus the cwd
    of every ~/.claude/sessions/<pid>.json whose pid is alive. Never raises."""
    cwds = []
    try:
        with open(state_file or STATE_FILE, "r", encoding="utf-8") as fh:
            entries = json.load(fh)
        for e in entries if isinstance(entries, list) else []:
            if not isinstance(e, dict):
                continue
            c, pid = e.get("cwd") or e.get("projectPath"), e.get("pid")
            if pid is not None:
                pid = str(pid)
                if not pid.isdigit() or not os.path.exists("/proc/" + pid):
                    continue  # the holder process is gone
                if not isinstance(c, str) or not c:
                    try:
                        c = os.readlink("/proc/%s/cwd" % pid)
                    except OSError:
                        c = None
            if isinstance(c, str) and c:
                cwds.append(c)
    except Exception:
        pass
    try:
        sdir = sessions_dir or SESSIONS_DIR
        for name in os.listdir(sdir):
            base, dot, ext = name.rpartition(".")
            if ext != "json" or not dot or not base.isdigit() or not os.path.exists("/proc/" + base):
                continue
            try:
                with open(os.path.join(sdir, name), "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:
                continue
            c = data.get("cwd") if isinstance(data, dict) else None
            if isinstance(c, str) and c:
                cwds.append(c)
    except Exception:
        pass
    return cwds


# ── GAP-5 send analysis (static: nothing is executed) ──
LIVE_PORT_RE = re.compile(r"(?<!\d)0*" + CLOUDCLI_PORT + r"(?!\d)")  # :3011, also :03011
CURL_WRITE_SHORT = set("dFTK")  # -d data, -F form, -T upload, -K config file (may set any of them)
CURL_VALUE_SHORT = set("AbcCDeEhHmoPQrtuUwxyYz")  # short options whose value ends the word
CURL_WRITE_LONG = ("data", "json", "form", "upload-file", "config")  # + --data-*, --form-*, abbreviations
WGET_VALUE_SHORT = set("aABDiIlnOoPQRtTUwX")
WGET_WRITE_LONG = ("post-data", "post-file", "body-data", "body-file", "execute", "config")
HTTPIE = {"http", "https", "xh", "xhs"}
NC_FAMILY = {"nc", "ncat", "netcat"}
RAW_CLIENTS = {"websocat", "wscat", "socat", "telnet"} | NC_FAMILY
HTTP_CLIENTS = {"curl", "wget"} | HTTPIE | RAW_CLIENTS
INTERP = (  # (interpreter name, the option that takes inline code)
    (re.compile(r"^(?:python|pypy)[\d.]*$"), re.compile(r"^-[A-Za-z]*c")),
    (re.compile(r"^(?:node|nodejs|bun)$"), re.compile(r"^(?:-[A-Za-z]*[ep]|--(?:eval|print)(?:=|$))")),
    (re.compile(r"^deno$"), re.compile(r"^eval$")),
    (re.compile(r"^perl[\d.]*$"), re.compile(r"^-[A-Za-z]*[eE]")),
    (re.compile(r"^ruby[\d.]*$"), re.compile(r"^-[A-Za-z]*e")),
    (re.compile(r"^php[\d.]*$"), re.compile(r"^-[A-Za-z]*[rBRE]")),
)
LAUNCHERS = {"npx", "bunx", "pnpx", "node", "nodejs", "bun", "pnpm", "yarn", "npm"}
CLAUDE_PKG_RE = re.compile(r"@anthropic-ai/claude-code(?:@[\w.^~-]+)?$|claude-code/cli\.m?js$")
WS_RAW_RE = re.compile(r"\bwss?://|/dev/(?:tcp|udp)/|/inet[46]?/(?:tcp|udp)/", re.I)
DATA_TOOLS = {"echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "yq", "journalctl", "git",
              "ss", "netstat", "lsof", "ps", "cat", "head", "tail", "less", "wc", "sort", "uniq", "cut", "diff",
              "ls", "test", "["}  # their text is data: no generic verb rule (sockets/clients still count)
GENERIC_WRITE_RE = re.compile(  # script lines / unknown tools reaching :3011 (heredoc bodies, echo | python)
    r"(?<![\w-])(?:POST|PUT|PATCH|DELETE)\b"
    r"|(?i:new\s+WebSocket\b|\bWebSocket\s*\(|\.(?:post|put|patch|delete)\s*\("
    r"|\bmethod\s*[:=]\s*['\"]?\s*(?:post|put|patch|delete)\b)")
SCRIPT_GET_RE = re.compile(r"\b(?:urlopen|urlretrieve|fetch|get|head|getresponse|request|file_get_contents)"
                           r"\s*\(", re.I)
SCRIPT_WRITE_RE = re.compile(  # anything in inline code beyond a plain GET/HEAD read
    r"(?<![a-z])(?:post\w*|put|patch|delete)\b"
    r"|\bmethod\b(?!\s*[:=]\s*['\"]?\s*(?:get|head)\b)"
    r"|\bbody\s*:|[(,]\s*(?:data|json|files)\s*="
    r"|websocket|\bwss?://|\bsocket\b|create_connection|\bconnect\s*\(|\bsend\w*\s*\("
    r"|subprocess|os\.system|popen|child_process|shell_exec|\bexec\w*\s*\(|\beval\s*\(|\bspawn\w*\s*\("
    r"|\bsystem\s*\(|base64|b64decode|\batob\b|fromcharcode|\bchr\s*\(|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}"
    r"|(?-i:\b(?:urlopen|Request))\s*\((?:[^,()]|\([^()]*\))*,(?!\s*[A-Za-z_]\w*\s*=)", re.I)
QA_LEAD_RE = re.compile(r"""\s*([A-Za-z_][A-Za-z0-9_]*)=((?:[^\s'"\\;&|<>()`$]|\\[^\n]|'[^']*'"""
                        r"""|"(?:[^"\\$`]|\\[^\n])*")*)(?=\s|$)""")
ANSI_C_RE = re.compile(r"\$'((?:[^'\\]|\\.)*)'", re.S)
HEREDOC_RE = re.compile(r"<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([^\s;&|<>()'\"`]+))")
BODY_EXEC = SHELLS | {"su", "runuser", "source"}  # a heredoc fed to these is run as commands
W_HTTP = ("a request that writes into the live CloudCLI API on port 3011 (only plain GET/HEAD reads "
          "are allowed there)")
W_SOCK = "a WebSocket/raw-socket connection into the live CloudCLI on port 3011"
W_SCRIPT = ("an inline script that sends into the live CloudCLI on port 3011 (only plain GET/HEAD "
            "reads are allowed there)")


def _ansi_c(text):
    """Decode bash $'...' (ANSI-C) quoting and drop the `$` of $"..." so escaped words are seen."""
    def dec(m):
        try:
            s = codecs.decode(m.group(1).encode("latin-1", "backslashreplace"), "unicode_escape")
        except Exception:
            s = m.group(1)
        return "'" + s.replace("'", "'\\''") + "'"
    return ANSI_C_RE.sub(dec, re.sub(r"(?<![\w$\\])\$\"", '"', text))


def _split_commands(text):
    """Quote-aware split into (simple-command text, body) pairs at unquoted ; & | and newlines (so
    && || |& split too); unquoted `#` comments are dropped. Heredoc body lines come one pair each,
    verbatim, so their quotes never leak into later commands: body = "shell" when the heredoc feeds
    a shell, "data" otherwise, None for command text. Nothing is expanded."""
    out, buf, quote, pending, line_start, i, n = [], [], None, [], 0, 0, len(text)
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                buf.append(text[i + 1])
                i += 1
            elif ch == quote:
                quote = None
        elif ch == "\\" and i + 1 < n:
            buf.append(text[i:i + 2])
            i += 1
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch == "#" and (not buf or buf[-1][-1] in " \t"):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        elif text.startswith("<<<", i):
            buf.append("<<<")
            i += 3
            continue
        elif text.startswith("<<", i) and HEREDOC_RE.match(text, i):
            m = HEREDOC_RE.match(text, i)
            pending.append((next(g for g in m.groups()[1:] if g is not None), m.group(1) == "-"))
            buf.append(m.group(0))
            i = m.end()
            continue
        elif ch in ";&|\n":
            out.append(("".join(buf), None))
            buf = []
            if ch == "\n":
                if pending:
                    opener = " ".join(s for s, _ in out[line_start:])
                    kind = "shell" if any(_word_name(w) in BODY_EXEC for w in _tokens(opener)) else "data"
                    i += 1
                    for delim, tabs in pending:
                        while i < n:
                            j = text.find("\n", i)
                            line = text[i:] if j < 0 else text[i:j]
                            i = n if j < 0 else j + 1
                            if (line.lstrip("\t") if tabs else line) == delim:
                                break
                            out.append((line, kind))
                    pending = []
                    line_start = len(out)
                    continue
                line_start = len(out)
        else:
            buf.append(ch)
        i += 1
    out.append(("".join(buf), None))
    return [(s, b) for s, b in out if s.strip()]


def _word_name(word):
    return os.path.basename(word.lstrip("`$({<!"))


def _expand_vars(word, assigns):
    """$NAME / ${NAME} from same-command assignments, else from the hook's environment."""
    def sub(m):
        val = assigns.get(m.group(1))
        return val if isinstance(val, str) else os.environ.get(m.group(1), m.group(0))
    for _ in range(2):
        if "$" not in word:
            break
        word = VAR_RE.sub(sub, word)
    return word


def _command_words(words):
    """The command and its args behind keywords, VAR=x prefixes and wrappers; unwraps xargs."""
    cmd = _strip(words)
    if cmd and _word_name(cmd[0]) == "xargs":
        cmd = _strip(_xargs_parse(cmd[1:])[0])
    return cmd


def _method_ok(method):
    return method.strip().upper() in ("GET", "HEAD")


def _long_hit(name, families):
    """A long option that is one of the families, extends one (--data-raw) or abbreviates one."""
    return any(name.startswith(f) or (len(name) >= 2 and f.startswith(name)) for f in families)


def _curl_writes(args):
    """False only for a plain GET/HEAD: any body/form/upload/config option, or a -X/--request
    method other than GET/HEAD (any case), makes the curl a write."""
    i, n = 0, len(args)
    while i < n:
        a = args[i]
        if a.startswith("--") and len(a) > 2:
            name, eq, val = a[2:].partition("=")
            name = name[7:] if name.startswith("expand-") else name
            if name == "request" or (len(name) >= 4 and "request".startswith(name)):
                if not eq:
                    i += 1
                    val = args[i] if i < n else ""
                if not _method_ok(val):
                    return True
            elif _long_hit(name, CURL_WRITE_LONG):
                return True
        elif a.startswith("-") and len(a) > 1 and a[1] != "-":
            body = a[1:]
            for j, c in enumerate(body):
                if c in CURL_WRITE_SHORT:
                    return True
                if c == "X":
                    val = body[j + 1:]
                    if not val:
                        i += 1
                        val = args[i] if i < n else ""
                    if not _method_ok(val):
                        return True
                    break
                if c in CURL_VALUE_SHORT:
                    break
        i += 1
    return False


def _wget_writes(args):
    """False only for a plain GET/HEAD: --post-*/--body-*/-e/--execute/--config, or a --method
    other than GET/HEAD, makes the wget a write."""
    i, n = 0, len(args)
    while i < n:
        a = args[i]
        if a.startswith("--") and len(a) > 2:
            name, eq, val = a[2:].partition("=")
            if name == "method" or (len(name) >= 2 and "method".startswith(name)):
                if not eq:
                    i += 1
                    val = args[i] if i < n else ""
                if not _method_ok(val):
                    return True
            elif _long_hit(name, WGET_WRITE_LONG):
                return True
        elif a.startswith("-") and len(a) > 1 and a[1] != "-":
            for c in a[1:]:
                if c == "e":
                    return True
                if c in WGET_VALUE_SHORT:
                    break
        i += 1
    return False


def _httpie_writes(args):
    """HTTPie/xh: a write unless the method is GET/HEAD (explicit or implied) with no data items."""
    pos = []
    for a in args:
        if a.startswith("-"):
            if a.split("=", 1)[0] in ("-f", "--form", "--multipart", "--raw"):
                return True
            continue
        pos.append(a)
    method = pos[0] if len(pos) >= 2 and re.fullmatch(r"[A-Za-z]+", pos[0]) else None
    items = pos[2:] if method else pos[1:]
    return (method is not None and not _method_ok(method)) or any(
        re.match(r"^[^=:@]*(?:=(?!=)|:=|@)", p) for p in items)


def _interp_kind(words):
    """'inline' when the words run an interpreter on inline code (python -c, node -e/-p, perl/ruby
    -e, php -r, deno eval, a here-string); 'stdin' when the command itself is an interpreter that
    reads its program from stdin (heredoc, pipe, `-`); else None."""
    for i, w in enumerate(words):
        name = _word_name(w)
        for name_re, flag_re in INTERP:
            if name_re.match(name) and any(flag_re.match(a) or a.startswith("<<<") for a in words[i + 1:]):
                return "inline"
    cmd = _command_words(words)
    if cmd and any(name_re.match(_word_name(cmd[0])) for name_re, _ in INTERP):
        pos = [a for a in cmd[1:] if a == "-" or not re.match(r"^(?:-|\d*[<>&])", a)]
        if not pos or pos[0] == "-":
            return "stdin"
    return None


def _script_writes(code):
    """Inline code is a write unless it makes a recognisable GET/HEAD call and nothing more."""
    return not SCRIPT_GET_RE.search(code) or bool(SCRIPT_WRITE_RE.search(code))


def _segment_write(raw, words, assign_reach=False, generic=True):
    """'what' when one simple command writes into :3011 (not a plain GET/HEAD read), else None.
    generic=False (an argument string judged as data): only real clients, sockets and inline code."""
    joined = " ".join(words)
    reach = bool(LIVE_PORT_RE.search(joined))
    names = [_word_name(w) for w in words]
    if reach:
        for i, name in enumerate(names):
            args = words[i + 1:]
            if (name == "curl" and _curl_writes(args) or name == "wget" and _wget_writes(args)
                    or name in HTTPIE and _httpie_writes(args)):
                return W_HTTP
            if name in RAW_CLIENTS and not (name in NC_FAMILY
                                            and any(re.match(r"^-[A-Za-z]*z", a) for a in args)):
                return W_SOCK  # `nc -z` is a port probe: it sends nothing
        if WS_RAW_RE.search(joined):
            return W_SOCK
    if (reach or assign_reach) and _interp_kind(words) == "inline" and _script_writes(raw + "\n" + joined):
        return W_SCRIPT
    cmd = _command_words(words) if reach and generic else []
    if reach and generic and not HTTP_CLIENTS.intersection(names) and not (cmd and _word_name(cmd[0]) in DATA_TOOLS) and (
            GENERIC_WRITE_RE.search(joined) or GENERIC_WRITE_RE.search(raw)):
        return W_HTTP
    return None


def _is_claude_word(word):
    if _CLAUDE_ALIASES and (os.path.normpath(word) in _CLAUDE_ALIASES
                            or _word_name(word) in _CLAUDE_ALIASES):
        return True  # D1: `ln -s <claude> /tmp/cc; /tmp/cc --resume <sid>`
    return _word_name(word) in CLAUDE_NAMES or bool(CLAUDE_PKG_RE.search(word))


# ── D1 2026-10-11: renamed symlinks + decoded payloads (same shapes the launch guard denies) ──
_CLAUDE_ALIASES = set()
DECODE_RE = re.compile(
    r"(?:^|[\s/(])(?:base64|base32|basenc|gbase64)(?=\s)[^|;&]*\s(?:-[A-Za-z]*[dD][A-Za-z]*|--decode)(?:\s|$|\))"
    r"|(?:^|[\s/(])openssl(?=\s)[^|;&]*\s-d(?:\s|$|\))")
DECODE_SINKS = SHELLS | {"at", "batch", "ssh", "eval", "source", ".", "coproc"}
B64_TOKEN_RE = re.compile(r"^[A-Za-z0-9+/_-]{8,}={0,2}$")


def _collect_link_aliases(text):
    """Paths (and basenames) of `ln [-s] <claude> DEST` links created in this command."""
    found = set()
    for raw, body in _split_commands(text):
        if body == "data":
            continue
        cmd = _strip(_tokens(raw))
        if not cmd or _word_name(cmd[0]) != "ln":
            continue
        pos, tdir, j, rest = [], None, 0, cmd[1:]
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
            pairs = [(s, os.path.join(tdir, os.path.basename(s))) for s in pos]
        elif len(pos) >= 2:
            pairs = [(s, pos[-1]) for s in pos[:-1]]
        else:
            pairs = [(s, os.path.basename(s)) for s in pos]
        for s, d in pairs:
            if not d or not (_word_name(s) in CLAUDE_NAMES or CLAUDE_PKG_RE.search(s)
                             or re.search(r"\$\((?:which|command\s+-v|type\s+-P)\s+claude", s)):
                continue
            for p in (d, os.path.join(d, os.path.basename(s))):
                p = os.path.normpath(p)
                if os.path.basename(p) not in ("", ".", ".."):
                    found.add(p)
                    found.add(os.path.basename(p))
    return found


def _decoded_payloads(text):
    """Statically decodable base64 literals of a decode-into-sink shape (`echo X | base64 -d | bash`,
    `eval "$(echo X | base64 -d)"`, `bash <<< ...`): the decoded command texts."""
    out = []
    if not DECODE_RE.search(text):
        return out
    for item in LIST_SPLIT.split(text):
        if not DECODE_RE.search(item):
            continue
        names = [os.path.basename(w) for w in re.findall(r"[\w./-]+", item)]
        if not any(nm in DECODE_SINKS or any(rx.match(nm) for rx, _o in INTERP) for nm in names):
            continue
        for w in re.findall(r"(?<![\w+/=-])[A-Za-z0-9+/_-]{8,}={0,2}(?![\w+/=-])", item):
            if not B64_TOKEN_RE.match(w):
                continue
            try:
                raw = __import__("base64").b64decode(w + "=" * (-len(w) % 4), altchars=b"-_"
                                                     if ("-" in w or "_" in w) else None, validate=True)
                s = raw.decode("utf-8")
            except Exception:
                continue
            if s.strip() and s.replace("\n", " ").replace("\t", " ").isprintable():
                out.append(s)
    return out


def _claude_argv(words):
    """argv after the claude program when claude IS the segment's command (behind wrappers, xargs,
    eval, npx/bunx/pnpm dlx, node <claude-code cli>), else None."""
    cmd = _command_words(words)
    for _ in range(3):
        if not cmd:
            return None
        if _is_claude_word(cmd[0]):
            return cmd[1:]
        prog = _word_name(cmd[0])
        if prog == "eval":
            cmd = _command_words(_tokens(" ".join(cmd[1:])))
            continue
        if prog in LAUNCHERS:
            for k in range(1, len(cmd)):
                if cmd[k].startswith("-") or cmd[k] in ("x", "dlx", "exec"):
                    continue
                return cmd[k + 1:] if _is_claude_word(cmd[k]) else None
        return None
    return None


def _claude_opts(argv):
    """Session-targeting options of a claude argv: resume values (None = a bare --resume/-r),
    --session-id values, -c/--continue, --fork-session, --from-pr. Clustered short flags parse."""
    o = {"resume": [], "sids": [], "cont": False, "fork": False, "from_pr": False}
    i, n = 0, len(argv)
    while i < n:
        a = argv[i]
        nxt = argv[i + 1] if i + 1 < n else None
        if a == "--":
            break
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name == "--resume":
                if not eq and nxt is not None and not nxt.startswith("-"):
                    val, i = nxt, i + 1
                o["resume"].append(val or None)
            elif name == "--session-id":
                if not eq:
                    val, i = nxt or "", i + 1
                o["sids"].append(val)
            elif name in ("--continue", "--fork-session", "--from-pr"):
                o[{"--continue": "cont", "--fork-session": "fork", "--from-pr": "from_pr"}[name]] = True
        elif a.startswith("-") and len(a) > 1:
            body = a[1:]
            for j, c in enumerate(body):
                if c == "c":
                    o["cont"] = True
                elif c == "r":
                    val = body[j + 1:]
                    if not val and nxt is not None and not nxt.startswith("-"):
                        val, i = nxt, i + 1
                    o["resume"].append(val or None)
                    break
                elif c in "dnw":  # -d [filter], -n <name>, -w [name]: the rest of the word is a value
                    break
        i += 1
    return o


def _qa_scratch_ok(segment):
    """QA-rig exemption for the session forms only (never for :3011 writes): the segment itself
    STARTS with plain env assignments (optionally after `env`) setting CLOUDCLI_QA_SCRATCH=1 and
    HOME=<the scratch root or a path strictly under it>. Quoted or commented text, other segments,
    dynamic values and the tool cwd never count."""
    pos, env = 0, {}
    m = re.match(r"\s*env(?=\s)", segment)
    if m:
        pos = m.end()
    while True:
        m = QA_LEAD_RE.match(segment, pos)
        if not m:
            break
        try:
            words = shlex.split(m.group(2)) if m.group(2) else [""]
        except ValueError:
            return False
        if len(words) != 1:
            return False
        env[m.group(1)] = words[0]
        pos = m.end()
    home = env.get("HOME", "")
    if env.get(QA_SCRATCH_ENV) != "1" or not home.startswith("/"):
        return False
    root, real = os.path.realpath(QA_SCRATCH_HOME), os.path.realpath(home)
    return real == root or real.startswith(root + os.sep)


def _cd_target(words, cwd):
    """The cwd after one segment: `cd`/`pushd DIR` moves it; None = not statically known."""
    cmd = _strip(words)
    if not cmd or cmd[0] not in ("cd", "pushd", "popd"):
        return cwd
    args = [a for a in cmd[1:] if a not in ("(", ")", "--") and not (a.startswith("-") and a != "-")]
    if cmd[0] == "popd" or (args and (args[0] == "-" or args[0].startswith("+")
                                       or any(c in args[0] for c in "$`*?["))):
        return None
    target = os.path.expanduser(args[0] if args else "~")
    if not os.path.isabs(target):
        if cwd is None:
            return None
        target = os.path.join(cwd, target)
    return os.path.normpath(target)


def _continue_conflict(cwd):
    """True when a live holder runs in cwd (or cwd is unknown while any live holder exists)."""
    holders = _live_holder_cwds()
    if not holders:
        return False
    if cwd is None:
        return True
    target = os.path.realpath(cwd)
    return any(os.path.realpath(h) == target for h in holders)


def _session_verdict(raw, words, cwd, data_ctx=False):
    """'what' when a claude invocation targets a session a live process holds: --resume/-r and
    --session-id with a live id anywhere; with claude as the command (not in data strings) also a
    bare --resume, --from-pr and -c/--continue where a live holder runs. --fork-session exempts all
    but a live --session-id (a fork named with a live id still collides)."""
    if ("claude" not in raw and not any("claude" in w for w in words)
            and not (_CLAUDE_ALIASES and any(_is_claude_word(w) for w in words))):
        return None
    argv = None if data_ctx else _claude_argv(words)
    loose = argv is None
    if loose:
        argv = next((words[i + 1:] for i, w in enumerate(words) if _is_claude_word(w)), None)
        if argv is None:
            return None
    o = _claude_opts(argv)
    if not (o["resume"] or o["sids"] or o["cont"] or o["from_pr"]) or _qa_scratch_ok(raw):
        return None
    live = _live_session_ids() if (o["sids"] or any(o["resume"])) else set()
    for sid in o["sids"]:
        if sid in live:
            return "`claude --session-id %s` reuses the id of a session a live Claude process holds" % _short(sid)
    if o["fork"]:
        return None
    for val in o["resume"]:
        if val and val in live:
            return ("`claude --resume %s` (no --fork-session) targets a session a live Claude process holds"
                    % _short(val))
    if loose:
        return None
    if None in o["resume"]:
        return ("`claude --resume` without a session id (no --fork-session) can reopen a session a live "
                "Claude process holds")
    if o["from_pr"]:
        return "`claude --from-pr` (no --fork-session) resumes a linked session a live Claude process may hold"
    if o["cont"] and _continue_conflict(cwd):
        return ("`claude --continue` (no --fork-session) in %s continues the session a live Claude process "
                "holds there" % _short(cwd or "an unresolved directory"))
    return None


def _exec_arg(words):
    """The command string run by `eval S`, or by `bash -c S` / `su -c S` / `script -c S` anywhere
    in the words (find -exec sh -c, screen, systemd-run ...); None when there is none."""
    cmd = _command_words(words)
    if cmd and _word_name(cmd[0]) == "eval":
        return " ".join(cmd[1:])
    for i, w in enumerate(words):
        name = _word_name(w)
        if name in SHELLS:
            arg = _shell_c_arg(words[i:])
            if arg is not None:
                return arg
        elif name in ("su", "runuser"):
            arg = _su_c_arg(words[i + 1:])
            if arg is not None:
                return arg
        elif name == "script":
            for j in range(i + 1, len(words) - 1):
                if re.match(r"^(?:-[A-Za-z]*c|--command)$", words[j]):
                    return words[j + 1]
    return None


def _live_send_verdict(text, cwd=None, depth=0, assigns=None, data_ctx=False):
    """GAP-5: 'what' when the command sends into the live install (:3011) or targets a session a
    live process holds, else None. Static and quote-aware; every check fails open on its own.
    data_ctx: `text` is an argument string that may be plain data (a message, a grep pattern):
    :3011 writes are still judged, session forms that need claude as the command are not."""
    if depth > 3 or not text:
        return None
    if depth == 0 and cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = None
    text = _ansi_c(text)
    if assigns is None:
        try:
            assigns = {k: v for k, v in _assignments(text).items() if isinstance(v, str)}
        except Exception:
            assigns = {}
    assign_reach = any(LIVE_PORT_RE.search(v) for v in assigns.values())
    stack, stdin_interp, parts, parts_reach, prev_body, saved = [], False, [], False, None, (cwd, 0)
    for raw, body in _split_commands(text):
        if body and not prev_body:
            saved = (cwd, len(stack))
        elif prev_body and not body:  # a heredoc body runs in another process: its cd does not outlive it
            cwd, stack[saved[1]:] = saved[0], []
        prev_body = body
        dctx = data_ctx or body == "data"
        toks = _tokens(raw)
        stack.extend([cwd] * toks.count("("))  # a subshell's cd does not outlive its `)`
        words = [_expand_vars(t, assigns) for t in toks]
        try:
            what = _session_verdict(raw, words, cwd, dctx)
        except Exception:
            what = None
        if not what:
            try:
                what = _segment_write(raw, words, assign_reach, generic=not data_ctx)
            except Exception:
                what = None
        if what:
            return what
        try:
            nested = _exec_arg(words)
        except Exception:
            nested = None
        subs = [(nested, dctx)] if nested else []
        subs += [(w, True) for w in words if w != nested and re.search(r"\s", w)]
        for sub, data in subs:
            what = _live_send_verdict(sub, cwd, depth + 1, assigns, data)
            if what:
                return what
        try:
            stdin_interp = stdin_interp or _interp_kind(words) == "stdin"
            if not HTTP_CLIENTS.intersection(_word_name(w) for w in words):
                parts.append(raw + "\n" + " ".join(words))
                parts_reach = parts_reach or bool(LIVE_PORT_RE.search(" ".join(words)))
            cwd = _cd_target(words, cwd)
        except Exception:
            cwd = None
        for _ in range(toks.count(")")):
            if stack:
                cwd = stack.pop()
    if stdin_interp and (parts_reach or assign_reach) and _script_writes("\n".join(parts)):
        return W_SCRIPT  # a heredoc/stdin program judged as one body
    return None


ATTR_LOG = os.environ.get("RESTART_GUARD_ATTR_LOG") or "/var/tmp/claude/cloudcli-ops.log"
_HOOK_CTX = {}  # main() fills session_id / cwd / tool_use_id / agent_type from the hook payload


def _attribute(code):
    """GAP-7: append one attribution line for an ALLOWED `systemctl ... cloudcli ...` segment:
    session id + cwd + tool call id (hook payload first, env fallback) and the segment itself.
    Never raises, never prints; ids and the command only, no environment values."""
    try:
        entry = {"ts": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
                 "session": _HOOK_CTX.get("session_id")
                 or os.environ.get("CLAUDE_CODE_SESSION_ID", "unknown"),
                 "agent": _HOOK_CTX.get("agent_type") or os.environ.get("CLAUDE_CODE_AGENT", ""),
                 "tool_use_id": _HOOK_CTX.get("tool_use_id", ""),
                 "cwd": _HOOK_CTX.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR", ""),
                 "cmd": _short(code)}
        with open(ATTR_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _describe(p):
    argv0 = os.path.basename(p.argv[0]) if p.argv else ""
    if p.comm in CLAUDE_NAMES or argv0 in CLAUDE_NAMES:
        return "PID %d is a Claude session process (%s)" % (p.pid, p.comm)
    return "PID %d is the CloudCLI server" % p.pid


def _short(text):
    text = " ".join(str(text).split())
    return text if len(text) <= 70 else text[:67] + "..."


# ── shell text helpers (static: nothing is executed) ──
def _mask(text):
    """Replace $(...) and `...` (innermost first) by placeholders -> (masked, {placeholder: inner})."""
    substs = {}

    def repl(m):
        inner = next(g for g in m.groups() if g is not None)
        ph = "__WO5S%d__" % len(substs)
        substs[ph] = _unmask(inner, substs)
        return ph

    for _ in range(16):
        new = SUBST_RE.sub(repl, text)
        if new == text:
            break
        text = new
    return text, substs


def _unmask(text, substs):
    return PH_RE.sub(lambda m: "$(" + substs[m.group(0)] + ")" if m.group(0) in substs else m.group(0), text)


def _tokens(segment):
    """shlex words; `(` / `)` are split off so subshells (`(kill 1)`) parse; quoted text stays intact."""
    try:
        lex = shlex.shlex(segment, posix=True, punctuation_chars="()")
        lex.whitespace_split = True
        lex.commenters = "#"
        return list(lex)
    except ValueError:
        return segment.split()


def _stdin_sources(toks):
    """A stage's stdin redirections -> (files read via `<`, words fed via `<<<`)."""
    files, words = [], []
    for i, t in enumerate(toks):
        nxt = toks[i + 1] if i + 1 < len(toks) else ""
        op = t[1:] if t.startswith("0<") else t  # `0<file` == `<file`
        if op == "<":
            files.append(nxt)
        elif op == "<<<":
            words.extend(nxt.split())
        elif op.startswith("<<<"):
            words.extend(op[3:].split())
        elif op.startswith("<") and len(op) > 1 and op[1] not in "<(&>":
            files.append(op[1:])
    return files, words


def _strip(tokens):
    """Drop keywords, VAR=x prefixes and wrapper programs (with their options) -> program + args."""
    i, n = 0, len(tokens)
    while i < n:
        tok = tokens[i]
        if tok in KEYWORDS or ASSIGN_RE.match(tok):
            i += 1
            continue
        base = os.path.basename(tok)
        if base in WRAP_OPTS:
            i += 1
            opts = WRAP_OPTS[base]
            while i < n and tokens[i].startswith("-") and tokens[i] != "-":
                opt = tokens[i]
                i += 1
                if opt == "--":
                    break
                if opt in opts:
                    i += 1
            if base == "env":
                while i < n and ASSIGN_RE.match(tokens[i]):
                    i += 1
            i += WRAP_POSITIONAL.get(base, 0)
            continue
        return tokens[i:]
    return []


def _is_signame(body):
    if not body:
        return False
    if body.isdigit():
        return True
    b = body.upper()
    if b.startswith("SIG"):
        b = b[3:]
    return b in SIGNAMES or bool(re.fullmatch(r"RTM(?:IN|AX)[+-]\d+", b))


def _assignments(masked):
    assigns = {}
    for item in LIST_SPLIT.split(masked):
        for stage in PIPE_SPLIT.split(item):
            toks = _tokens(stage)
            i = 0
            while i < len(toks) and toks[i] in KEYWORDS:
                i += 1
            if i < len(toks) and toks[i] in ("export", "local", "declare", "readonly", "typeset"):
                i += 1
                while i < len(toks) and toks[i].startswith("-"):
                    i += 1
            while i < len(toks):
                m = ASSIGN_RE.match(toks[i])
                if not m:
                    break
                assigns[m.group(1)] = m.group(2)
                i += 1
            rest = toks[i:]
            if len(rest) >= 3 and rest[0] == "for" and NAME_RE.fullmatch(rest[1]) and rest[2] == "in":
                assigns[rest[1]] = " ".join(rest[3:])
            elif rest and rest[0] in ("read", "mapfile", "readarray"):
                for t in rest[1:]:
                    if NAME_RE.fullmatch(t):
                        assigns[t] = DYNAMIC
    return assigns


class _Ctx:
    def __init__(self, text, procs, cwd):
        self.text = text
        self.masked, self.substs = _mask(text)
        self.assigns = _assignments(self.masked)
        self.procs = procs
        self.cwd = cwd


def _expand(tok, ctx, depth=0):
    """A kill target token -> atoms: ('int', n) | ('subst', text) | ('ppid', _) | ('unknown', text)."""
    tok = tok.strip()
    neg = ""
    if tok.startswith("-") and not INT_RE.fullmatch(tok):
        neg, tok = "-", tok[1:]
    if INT_RE.fullmatch(tok):
        return [("int", int(neg + tok))]
    phs = PH_RE.findall(tok)
    if phs:
        return [("subst", ctx.substs.get(ph, "")) for ph in phs]
    m = VAR_RE.fullmatch(tok)
    if m:
        name = m.group(1)
        if name == "PPID":
            return [("ppid", "$PPID")]
        if name in ("!", "$", "BASHPID"):
            return []  # the agent's own shell / last background job
        val = ctx.assigns.get(name)
        if val is None or val is DYNAMIC or depth >= 3:
            return [("unknown", "$" + name)]
        out = []
        for word in val.split():
            out.extend(_expand(neg + word, ctx, depth + 1))
        return out
    if "$" in tok:
        return [("unknown", tok)]
    return []


def _judge(atom, ctx):
    kind, val = atom
    procs = ctx.procs
    if kind == "int":
        if val > 0:
            p = procs.get(val)
            return _describe(p) if procs.is_protected(p) else None
        if val == -1:
            prot = procs.protected()
            return ("`kill -1` signals every process, including %s" % _describe(prot[0])) if prot else None
        if val < -1:
            hits = [p for p in procs.protected() if p.pgid == -val]
            return ("process group %d contains %s" % (-val, _describe(hits[0]))) if hits else None
        return None  # 0 = the tool shell's own process group (a separate session)
    if kind == "subst":
        why = _tainted(val, ctx)
        return ("the PIDs come from `$(%s)`, which %s" % (_short(val), why)) if why else None
    if kind == "ppid":
        return "`$PPID` is the Claude process that runs this shell"
    if kind == "unknown":
        why = _tainted(ctx.text, ctx)
        return ("`%s` is filled by a lookup in this command that %s" % (val, why)) if why else None
    return None


def _tainted(text, ctx):
    """Why `text` (a substitution, pipeline upstream or command) selects protected PIDs, else None."""
    norm = _unmask(text, ctx.substs).replace(AGENT_TMP, "/var/tmp/_agent_scratch_/")
    if TAINT_SESSIONS.search(norm):
        return "reads the Claude session registry (~/.claude/sessions)"
    if TAINT_PPID.search(norm):
        return "derives a parent PID"
    if TAINT_PROC.search(norm) or TAINT_PKG.search(norm):
        return "names claude/cloudcli"
    if TAINT_PORT.search(norm):
        return "targets the CloudCLI port %s" % CLOUDCLI_PORT
    return _lookup_hits(norm, ctx)


def _lookup_hits(text, ctx):
    masked, _ = _mask(text)
    for item in LIST_SPLIT.split(masked):
        for stage in PIPE_SPLIT.split(item):
            toks = _tokens(stage)
            redirects = _stdin_sources(toks)[0]
            words = _strip(toks)
            prog = os.path.basename(words[0]) if words else ""
            hits = []
            if prog in ("pgrep", "pkill"):
                hits = _pattern_hits(words[1:], ctx)
            elif prog == "pidof":
                names = {w for w in words[1:] if not w.startswith("-")}
                hits = [p for p in ctx.procs.protected()
                        if p.comm in names or (p.argv and os.path.basename(p.argv[0]) in names)]
            else:
                files = [w for w in words[1:] if not w.startswith("-")] if prog in ("cat", "head", "tail") else []
                hits = _pidfile_hits(files + redirects, ctx)
            if hits:
                return "selects %s" % _describe(hits[0])
    return None


def _read_small(path, ctx):
    """Bytes of a small regular file (never a FIFO/device), or None."""
    path = os.path.expanduser(path)
    if not path or "$" in path or "*" in path or "__WO5S" in path:
        return None
    if not os.path.isabs(path) and ctx.cwd:
        path = os.path.join(ctx.cwd, path)
    try:
        st = os.stat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 65536:
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            return os.read(fd, 65536)
        finally:
            os.close(fd)
    except OSError:
        return None


def _pids_in(data):
    return [int(n) for n in re.findall(rb"(?<![\d-])\d{1,9}(?!\d)", data)[:256]]


def _pidfile_hits(paths, ctx):
    for path in paths[:8]:
        data = _read_small(path, ctx)
        if data:
            for pid in _pids_in(data):
                p = ctx.procs.get(pid)
                if ctx.procs.is_protected(p):
                    return [p]
    return []


# ── pkill / pgrep / killall / fuser emulation ──
def _parse_pgrep(args):
    opts, pos = {}, []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos.extend(args[i + 1:])
            break
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in PG_LONG_VALUE:
                if not eq:
                    i += 1
                    val = args[i] if i < len(args) else ""
                opts[PG_LONG_VALUE[name]] = val
            else:
                opts[PG_LONG_FLAG.get(name, name)] = True
        elif a.startswith("-") and len(a) > 1:
            body = a[1:]
            if i == 0 and _is_signame(body):
                opts["signal"] = body
            else:
                for j, c in enumerate(body):
                    if c in PG_VALUE_SHORT:
                        val = body[j + 1:]
                        if not val:
                            i += 1
                            val = args[i] if i < len(args) else ""
                        opts[c] = val
                        break
                    opts[c] = True
        else:
            pos.append(a)
        i += 1
    return opts, pos


def _ids(spec):
    out, unknown = set(), False
    for v in str(spec).split(","):
        v = v.strip()
        if not v or v in ("$$", "$BASHPID", "${BASHPID}", "$!"):
            continue  # the agent's own shell / job
        if v.isdigit():
            out.add(int(v))
        else:
            unknown = True
    return out, unknown


def _uids(spec):
    out = set()
    for v in str(spec).split(","):
        v = v.strip()
        if not v:
            continue
        if v.isdigit():
            out.add(int(v))
            continue
        try:
            out.add(pwd.getpwnam(v).pw_uid)
        except KeyError:
            return None  # unknown user: assume it matches (conservative)
    return out


def _filters_match(p, filters, ctx):
    for key, val in filters.items():
        if key in ("P", "g", "s"):
            ids, unknown = _ids(val)
            if key in ("g", "s"):
                ids.discard(0)  # 0 = pkill's own group/session (the tool shell's, never protected)
            attr = {"P": p.ppid, "g": p.pgid, "s": p.sid}[key]
            if not unknown and attr not in ids:
                return False
        elif key in ("u", "U"):
            uids = _uids(val)
            if uids is not None and p.uid not in uids:
                return False
        elif key == "F":
            data = _read_small(str(val), ctx)
            if data is not None and p.pid not in _pids_in(data):
                return False
        # t, G, r, O, ns, nslist, cgroup, env: not evaluated -> assume they match (conservative)
    return True


def _pattern_hits(args, ctx):
    """Protected processes a pkill/pgrep invocation would select (procps semantics, statically)."""
    opts, pos = _parse_pgrep(args)
    if str(opts.get("signal", "")) == "0":
        return []
    filters = {k: opts[k] for k in PG_FILTERS if k in opts}
    pattern = pos[0] if pos else None
    if pattern is None and not filters:
        return []
    rx = None
    if pattern is not None:
        try:
            rx = re.compile(pattern, re.I if opts.get("i") else 0)
        except re.error:
            return []
    hits = []
    for p in ctx.procs.protected():
        if rx is not None:
            subject = " ".join(p.argv) if opts.get("f") and p.argv else p.comm[:15]
            matched = bool(rx.fullmatch(subject) if opts.get("x") else rx.search(subject))
            if opts.get("v"):
                matched = not matched
            if not matched:
                continue
        if _filters_match(p, filters, ctx):
            hits.append(p)
    return hits


def _killall_opts(args):
    """killall args -> (options, process names)."""
    opts, names = {}, []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            names.extend(args[i + 1:])
            break
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in KA_LONG_VALUE:
                if not eq:
                    i += 1
                    val = args[i] if i < len(args) else ""
                opts[KA_LONG_VALUE[name]] = val
            else:
                opts[KA_LONG_FLAG.get(name, name)] = True
        elif a.startswith("-") and len(a) > 1:
            body = a[1:]
            if _is_signame(body):
                opts["s"] = body
            else:
                for j, c in enumerate(body):
                    if c in KA_VALUE_SHORT:
                        val = body[j + 1:]
                        if not val:
                            i += 1
                            val = args[i] if i < len(args) else ""
                        opts[c] = val
                        break
                    opts[c] = True
        else:
            names.append(a)
        i += 1
    return opts, names


def _killall_hits(args, ctx):
    opts, names = _killall_opts(args)
    if opts.get("l") or opts.get("V") or str(opts.get("s", "")) == "0":
        return []
    if not names and "u" not in opts:
        return []
    uids = _uids(opts["u"]) if "u" in opts else None
    hits = []
    for p in ctx.procs.protected():
        if uids is not None and p.uid not in uids:
            continue
        if names and not any(_killall_name_match(n, p, opts) for n in names):
            continue
        hits.append(p)
    return hits


def _killall_name_match(name, p, opts):
    if "/" in name:
        try:
            return bool(p.exe) and os.path.realpath(name) == os.path.realpath(p.exe)
        except OSError:
            return False
    flags = re.I if opts.get("I") else 0
    if opts.get("r"):
        try:
            return bool(re.search(name, p.comm, flags))
        except re.error:
            return False
    argv0 = os.path.basename(p.argv[0]) if p.argv else ""
    eq = (lambda a, b: a.lower() == b.lower()) if flags else (lambda a, b: a == b)
    if eq(name, p.comm) or eq(name, argv0):
        return True
    return len(name) > 15 and not opts.get("e") and eq(name[:15], p.comm)


def _fuser_verdict(args, ctx):
    flags, names = set(), []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-n", "--namespace"):
            i += 2
            continue
        if a.startswith("--"):
            flags.add({"--kill": "k", "--mount": "m", "--ismountpoint": "M"}.get(a, a))
        elif a.startswith("-") and len(a) > 1:
            if not _is_signame(a[1:]):
                flags.update(a[1:])
        else:
            names.append(a)
        i += 1
    if "k" not in flags:
        return None
    if flags & {"m", "M"}:
        prot = ctx.procs.protected()
        return ("`fuser -k -m` kills every process on that filesystem, including %s" % _describe(prot[0])
                if prot else None)
    why = _tainted(" ".join(names), ctx)
    return ("`fuser -k %s` %s" % (_short(" ".join(names)), why)) if why else None


def _parse_kill(args):
    """kill args -> (signal or None, targets, mode) — mode 'list'/'print' means no signal is sent."""
    sig, targets, i = None, [], 0
    while i < len(args):
        a = args[i]
        if targets or not a.startswith("-") or a == "-":
            targets.append(a)
            i += 1
            continue
        if a == "--":
            targets.extend(args[i + 1:])
            break
        if a in ("-l", "-L", "--list", "--table") or a.startswith("--list="):
            return None, [], "list"
        if a in ("-p", "--pid"):
            return None, [], "print"
        if a in ("-s", "-n", "--signal"):
            sig = args[i + 1] if i + 1 < len(args) else None
            i += 2
            continue
        if a.startswith("--signal="):
            sig = a.split("=", 1)[1]
            i += 1
            continue
        if a in ("-q", "--queue"):
            i += 2
            continue
        if a == "--timeout":
            i += 3
            continue
        if a in ("-a", "--all", "--verbose", "-r", "--require-handler"):
            i += 1
            continue
        body = a[1:]
        if sig is None and _is_signame(body):
            sig = body
        elif sig is None and body[:1] in ("s", "n") and _is_signame(body[1:]):
            sig = body[1:]
        else:
            targets.append(a)  # e.g. -123 = a process group once the signal is known
        i += 1
    return sig, targets, None


def _kill_cmd(args, ctx):
    sig, targets, mode = _parse_kill(args)
    if mode or str(sig) == "0":
        return None
    for tok in targets:
        for atom in _expand(tok, ctx):
            why = _judge(atom, ctx)
            if why:
                return why
    return None


def _xargs_parse(args):
    """xargs args -> (command words, files named by -a/--arg-file); clustered short options parse."""
    files, i = [], 0
    while i < len(args):
        a = args[i]
        if a == "--":
            return args[i + 1:], files
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in XARGS_VALUE and not eq:
                i += 1
                val = args[i] if i < len(args) else ""
            if name == "--arg-file":
                files.append(val)
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            body = a[1:]
            for j, c in enumerate(body):
                if c in XARGS_SHORT_VALUE:
                    val = body[j + 1:]
                    if not val:
                        i += 1
                        val = args[i] if i < len(args) else ""
                    if c == "a":
                        files.append(val)
                    break
            i += 1
            continue
        return args[i:], files
    return [], files


def _xargs_cmd(args):
    return _xargs_parse(args)[0]


def _xargs_verdict(sub, upstream, ctx, files=(), words=()):
    """files: xargs input from `-a FILE` / `< FILE` / `< <(...)`; words: `<<< "PID ..."` text."""
    prog = os.path.basename(sub[0])
    if prog == "kill":
        sig, _targets, mode = _parse_kill(sub[1:])
        if mode or str(sig) == "0":
            return None
    elif prog not in ("pkill", "killall", "killall5", "fuser"):
        return None
    for path in files:
        phs = PH_RE.findall(path)
        why = None
        for ph in phs:  # process substitution: judge the command that produces the input
            why = why or _tainted(ctx.substs.get(ph, ""), ctx)
        if not phs and prog == "kill":
            hits = _pidfile_hits([path], ctx)
            why = ("selects %s" % _describe(hits[0])) if hits else None
        if why:
            return "`xargs %s` reads its targets from `%s`, which %s" % (
                prog, _short(_unmask(path, ctx.substs)), why)
    if prog == "kill":
        for word in words:
            for atom in _expand(word, ctx):
                why = _judge(atom, ctx)
                if why:
                    return why
    if not upstream.strip():
        return None
    why = _tainted(upstream, ctx)
    if why:
        return "`xargs %s` takes its targets from `%s`, which %s" % (
            prog, _short(_unmask(upstream, ctx.substs)), why)
    for stage in PIPE_SPLIT.split(upstream):
        words = _strip(_tokens(stage))
        if words and os.path.basename(words[0]) in ("echo", "printf"):
            for word in words[1:]:
                for atom in _expand(word, ctx):
                    why = _judge(atom, ctx)
                    if why:
                        return why
    return None


def _signal_zero(segment):
    """True when the segment's kill/pkill/killall only probes: signal 0 delivers nothing."""
    try:
        words = _strip(_tokens(segment))
        prog = os.path.basename(words[0]) if words else ""
        if prog == "kill":
            sig, _targets, mode = _parse_kill(words[1:])
            return mode is None and str(sig) == "0"
        if prog == "pkill":
            return str(_parse_pgrep(words[1:])[0].get("signal", "")) == "0"
        if prog == "killall":
            return str(_killall_opts(words[1:])[0].get("s", "")) == "0"
    except Exception:
        pass
    return False


def _shell_c_arg(words):
    has_c, i = False, 1
    while i < len(words):
        w = words[i]
        if w in ("-o", "+o", "-O", "+O"):
            i += 2
            continue
        if w.startswith("-") and not w.startswith("--") and "c" in w[1:]:
            has_c = True
        elif not w.startswith(("-", "+")):
            return w if has_c else None
        i += 1
    return None


def _su_c_arg(words):
    for i, w in enumerate(words):
        if w in ("-c", "--command") and i + 1 < len(words):
            return words[i + 1]
        if w.startswith("--command="):
            return w.split("=", 1)[1]
    return None


def _kill_verdict(text, procs, cwd=None, depth=0):
    """Why the command signals a protected process (deny), or None."""
    if depth > 3 or not KILL_HINT.search(text):
        return None
    ctx = _Ctx(text, procs, cwd)
    for inner in list(ctx.substs.values()):  # a kill inside $(...) runs too
        why = _kill_verdict(inner, procs, cwd, depth + 1)
        if why:
            return why
    for item in LIST_SPLIT.split(ctx.masked):
        stages = PIPE_SPLIT.split(item)
        for idx, stage in enumerate(stages):
            words = _strip(_tokens(stage))
            if not words:
                continue
            prog = os.path.basename(words[0])
            nested = None
            if prog in SHELLS:
                nested = _shell_c_arg(words)
            elif prog in ("su", "runuser"):
                nested = _su_c_arg(words)
            elif prog == "eval":
                nested = " ".join(words[1:])
            if nested is not None:
                why = _kill_verdict(_unmask(nested, ctx.substs), procs, cwd, depth + 1)
                if why:
                    return why
                continue
            if prog == "xargs":
                cmd, files = _xargs_parse(words[1:])
                sub = _strip(cmd)
                if not sub:
                    continue
                rfiles, hwords = _stdin_sources(_tokens(stage))
                why = _xargs_verdict(sub, "|".join(stages[:idx]), ctx, files + rfiles, hwords)
                if why:
                    return why
                words, prog = sub, os.path.basename(sub[0])
            why = None
            if prog == "kill":
                why = _kill_cmd(words[1:], ctx)
            elif prog == "pkill":
                hits = _pattern_hits(words[1:], ctx)
                if hits:
                    why = "`%s` would match %s" % (_short(_unmask(stage, ctx.substs)), _describe(hits[0]))
            elif prog == "killall":
                hits = _killall_hits(words[1:], ctx)
                if hits:
                    why = "`%s` would match %s" % (_short(_unmask(stage, ctx.substs)), _describe(hits[0]))
            elif prog == "killall5":
                prot = procs.protected()
                if prot:
                    why = "`killall5` signals every process outside this session, including %s" % _describe(prot[0])
            elif prog == "fuser":
                why = _fuser_verdict(words[1:], ctx)
            if why:
                return why
    return None


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or data.get("tool_name") != "Bash":
            return
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, dict):
            return
        cwd = data.get("cwd") if isinstance(data.get("cwd"), str) else None
        for key in ("session_id", "cwd", "tool_use_id", "agent_type"):
            if isinstance(data.get(key), str):
                _HOOK_CTX[key] = data[key]
        verdict = check(tool_input.get("command"), cwd=cwd)
        if verdict:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": verdict[0],
                "permissionDecisionReason": verdict[1]}}))
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
