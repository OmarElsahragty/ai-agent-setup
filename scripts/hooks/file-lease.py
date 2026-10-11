#!/usr/bin/env python3
"""Cross-agent file-lease guard (Claude Code hook; OpenCode via parity-hooks.ts).

Owner rulings 2026-10-10 (issue sweep lane G, Option A): BLOCK immediately (no
warn phase); scope = ALL live files; lease per AGENT (actor = session_id +
agent_id, main thread = "main"), so siblings of one session are serialized
too; a dead agent's files are flagged at the next session start (no revert).

Events
  PreToolUse  Edit|Write|MultiEdit|NotebookEdit|Bash: deny, or take the lease.
  PostToolUse Read|Edit|Write|MultiEdit|NotebookEdit|Bash: record the sha256
              this actor saw / wrote and the file's last writer.
  SubagentStop / SessionEnd: clean release of the finished actor's leases
              (a finished agent is never reported as half-applied).
  SessionStart: sweep dead holders, print up to 20 "possibly half-applied"
              lines once (additionalContext), prune old rows.

Deny when
  (a) another live actor holds an unexpired lease (TTL 10 min since its last
      write). Exception: the MAIN thread of the same session may take over a
      lease from its own subagent (allowed with a warning; lease transferred).
  (b) the last writer of the file was another actor AND the file's current
      sha256 differs from what this actor last saw (Read or own write), also
      for Bash targets and also after pure appends by others.

Dead holder = its process is gone (pid + start time), or (subagent, or pid
unknown) its lease expired AND it has had no Read/write activity for a full
TTL without a SubagentStop/SessionEnd release. Dead holders lose the lease and
their file is recorded as possibly half-applied.

Exempt (never leased): /tmp, /var/tmp, /run, /dev, /proc, ~/.claude/projects,
*/.claude/worktrees/*, pure appends (only >> / tee -a) to *.md/*.jsonl/*.log
ledgers (recorded as last writer, never denied), read-only Bash, unresolvable
Bash tokens ($VAR, globs, relative paths after cd), directories. Bash targets
come from secret-write-guard.bash_write_targets(quoted=False) (reused, not
copied; quote-aware, so `>=`, `2>&1`, `>&2` and `>` inside quoted jq/awk/python
code are never targets); the holder PID from single-writer-guard.claude_ancestor().

Parent -> child (orchestrator ruling 2026-10-10): a subagent may write a file
leased by the MAIN thread of its own session (silent hand-over; check (b) still
applies); siblings stay serialized.
Pending leases: a lease that no PostToolUse confirmed (the call was denied by
another hook, cancelled or failed) blocks other actors for 60 s, not the TTL,
unless the holder's own last write is younger than the TTL. Taking the lease
only after the call is allowed is not possible: PreToolUse hooks run in
parallel and no hook event fires between permission and execution.

Owner-only kill switch: agents never create, change or delete it or the lease
store; such Edit/Write/MultiEdit/NotebookEdit/Bash calls (redirects, touch/cp/
mv/ln/rm/..., sqlite3 writes) are denied. Interpreter code (inline, or a
heredoc/herestring fed to the interpreter) that mentions the store is denied
only when it can write it: a write-shaped FS call or a mutator taken as a
value (also through an alias, getattr or a computed [] key), open() with a
write or unknown mode, a DB connect without a read-only flag or its own
read-only file: URI opened with uri=True, an in-place flag (perl/ruby -i),
dynamic code (exec/eval/Function of a non-literal, run_path, dofile, send,
call_user_func), a process spawn whose command is not a literal or is itself
tamper, or (the pre-D2 word rule kept as a backstop) a write-API name reached
other than by a judged call: a plain string or symbol ('unlinkSync',
:unlink), a destructuring/object key or a bare value; a read-only mention
(open(..., 'r'), readFileSync, stat, print, cat/grep/ls) passes. Denials also fire when the
guard is otherwise off for the calling process, and every kill-switch use is
logged to the lease log. Static-parser limits: variable indirection, script
files and encoded (base64 etc.) commands are not followed.
Fails OPEN on any internal error (logged to the lease log).
Test seams (env): FILE_LEASE_DB, FILE_LEASE_LOG, FILE_LEASE_TTL,
FILE_LEASE_EXEMPT, FILE_LEASE_SWITCH. Stdlib only.
"""
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

# sqlite3 / hashlib / importlib.util are imported lazily (latency budget: the
# most frequent call, a read-only Bash command, never needs them).

# Resolved from the file location only, so an env var cannot redirect this guard.
ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT  # this repo holds the agent trees at its own root
HERE = os.path.dirname(os.path.abspath(__file__))
DB_DEFAULT = "/var/tmp/claude/leases/leases.db"
LOG_DEFAULT = "/var/tmp/claude/hooks/file-lease.log"
SWITCH_NAME = "FILE_LEASE_DISABLED"
SWITCH_LIVE = str(AGENTS / "scripts" / "hooks" / SWITCH_NAME)
TTL_DEFAULT = 600.0
PENDING_TTL = 60.0  # a lease no PostToolUse confirmed
HASH_MAX_BYTES = 16 << 20  # larger files use a size:mtime fingerprint
PRUNE_AFTER = 30 * 86400
REPORT_LIMIT = 20
SCHEMA_VERSION = 1
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
LEDGER_EXT = (".md", ".jsonl", ".log")
EXEMPT_DEFAULT = ("/tmp", "/var/tmp", "/run", "/dev", "/proc", "~/.claude/projects")

SCHEMA = """
CREATE TABLE IF NOT EXISTS lease (
    path TEXT PRIMARY KEY,
    holder_session TEXT, holder_agent TEXT, holder_pid INTEGER,
    holder_pid_start INTEGER, holder_ts REAL,
    writer_session TEXT, writer_agent TEXT, writer_ts REAL, writer_sha TEXT);
CREATE INDEX IF NOT EXISTS lease_holder ON lease(holder_session, holder_agent);
CREATE TABLE IF NOT EXISTS seen (
    session_id TEXT NOT NULL, agent_id TEXT NOT NULL, path TEXT NOT NULL,
    sha256 TEXT, at REAL NOT NULL,
    PRIMARY KEY (session_id, agent_id, path));
CREATE INDEX IF NOT EXISTS seen_actor_at ON seen(session_id, agent_id, at);
CREATE TABLE IF NOT EXISTS half_applied (
    path TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    at REAL NOT NULL, reported INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (path, session_id, agent_id));
PRAGMA user_version = 1;
"""

# --- Bash append classification (targets themselves come from secret-write-guard)
SINGLE_GT_RE = re.compile(r"(?:^|[\s;|&])(?:\d*|&)>(?![>&])\s*([^\s;&<>]+)")
TEE_RE = re.compile(r"(?:^|[\s;|&])tee\s+([^;|&<>]+)")
CD_RE = re.compile(r"(?:^|[\s;&|(])(?:cd|pushd)(?:\s|$)")
OTHER_WRITER_RES = [re.compile(p) for p in (
    r"\bsed\b[^;|&]*\s-i", r"(?:^|[\s;|&])cp\s", r"(?:^|[\s;|&])mv\s",
    r"(?:^|[\s;|&])install\s", r"(?:^|\s)dd\s[^;|&]*of=",
    r"\bopen\s*\(\s*(['\"])[^'\"]*\1\s*,\s*['\"][wa]", r"\.write_(?:text|bytes)\s*\(")]

_MODULES = {}


def log(msg):
    try:
        path = os.environ.get("FILE_LEASE_LOG") or LOG_DEFAULT
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%F %T %Z"), msg))
    except Exception:
        pass


def ttl():
    try:
        return float(os.environ.get("FILE_LEASE_TTL") or TTL_DEFAULT)
    except ValueError:
        return TTL_DEFAULT


def env_off():
    return os.environ.get("FILE_LEASE", "").strip().lower() == "off"


def switch_paths():
    """FILE_LEASE_SWITCH (os.pathsep list) replaces the default switch files - a test seam so
    tests never touch the real hooks dir; the defaults stay tamper-protected either way."""
    raw = os.environ.get("FILE_LEASE_SWITCH")
    if raw is not None:
        return tuple(p for p in raw.split(os.pathsep) if p)
    return (os.path.join(HERE, SWITCH_NAME), SWITCH_LIVE)


def switch_on():
    return any(os.path.exists(p) for p in switch_paths())


def disabled():
    return env_off() or switch_on()


def db_path():
    return os.path.realpath(os.environ.get("FILE_LEASE_DB") or DB_DEFAULT)


def neighbor(file_name):
    """Load a sibling hook module by path (hyphenated names are not importable)."""
    if file_name not in _MODULES:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "fl_" + file_name.replace("-", "_").replace(".py", ""), os.path.join(HERE, file_name))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _MODULES[file_name] = module
    return _MODULES[file_name]


def pid_start(pid):
    """Process start time (clock ticks since boot) — guards against PID reuse."""
    try:
        with open("/proc/%d/stat" % pid, encoding="utf-8") as fh:
            data = fh.read()
        return int(data[data.rindex(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError, TypeError):
        return None


def pid_alive(pid, start):
    if not pid or pid <= 1:
        return False
    now_start = pid_start(pid)
    if now_start is None:
        return False
    return start is None or now_start == start


def holder_pid(data):
    """OpenCode passes lease_pid (its own process); Claude Code hooks find the
    claude.exe ancestor via single-writer-guard.claude_ancestor()."""
    pid = data.get("lease_pid")
    if isinstance(pid, int) and pid > 1:
        return pid
    try:
        pid = neighbor("single-writer-guard.py").claude_ancestor()
        return int(pid) if pid else None
    except Exception:
        return None


def fingerprint(path):
    try:
        st = os.stat(path)
        if not stat.S_ISREG(st.st_mode):
            return None
        if st.st_size > HASH_MAX_BYTES:
            return "fp:%d:%d" % (st.st_size, st.st_mtime_ns)
        import hashlib
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def exempt_prefixes():
    """FILE_LEASE_EXEMPT (os.pathsep list) replaces the default prefixes — a
    test seam (pytest tmp dirs live under /var/tmp); production never sets it."""
    raw = os.environ.get("FILE_LEASE_EXEMPT")
    items = [p for p in raw.split(os.pathsep) if p] if raw is not None else EXEMPT_DEFAULT
    return tuple(os.path.realpath(os.path.expanduser(p)) + os.sep for p in items)


def is_exempt(path, db):
    if path == db or path.startswith(db + "-"):
        return True
    if "/.claude/worktrees/" in path:
        return True
    return path.startswith(exempt_prefixes())


def resolve(token, cwd, literal, has_cd=False):
    """Absolute realpath of a target, or None when it cannot be resolved to a
    literal file (Bash $VARS/globs/braces, relative after cd, directories)."""
    tok = (token or "").strip()
    if not literal:
        tok = tok.strip("'\"")
        if not tok or any(c in tok for c in "$`*?[{"):
            return None
    if not tok:
        return None
    if tok.startswith("~"):
        tok = os.path.expanduser(tok)
        if tok.startswith("~"):
            return None
    if not os.path.isabs(tok):
        if has_cd or not cwd:
            return None
        tok = os.path.join(cwd, tok)
    real = os.path.realpath(tok)
    return None if os.path.isdir(real) else real


def _tee_appends(args):
    return any(a in ("-a", "--append") or (a.startswith("-") and not a.startswith("--") and "a" in a[1:])
               for a in args)


def bash_targets(command, cwd):
    """[(path, pure_append)] for a Bash command; pure_append = written only via
    >> / tee -a, no other write mechanism in the command, ledger extension."""
    swg = neighbor("secret-write-guard.py")
    writes, raw = swg.bash_write_targets(command, quoted=False)
    if not writes or not raw:
        return []
    masked = swg.scan_shell(command)[0]  # same offsets; quoted text and comments neutralised
    other = any(rx.search(masked) for rx in OTHER_WRITER_RES)
    overwrite = {command[m.start(1):m.end(1)].strip("'\"") for m in SINGLE_GT_RE.finditer(masked)}
    for m in TEE_RE.finditer(masked):
        args = command[m.start(1):m.end(1)].split()
        if not _tee_appends(args):
            overwrite.update(a.strip("'\"") for a in args if not a.startswith("-"))
    has_cd = bool(CD_RE.search(command))
    found = {}
    for tok in raw:
        tok = tok.strip("'\"")
        path = resolve(tok, cwd, literal=False, has_cd=has_cd)
        if not path:
            continue
        pure = (not other) and tok not in overwrite and os.path.splitext(path)[1] in LEDGER_EXT
        found[path] = found.get(path, True) and pure
    return list(found.items())


def targets(data):
    tool = data.get("tool_name")
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return []
    cwd = str(data.get("cwd") or "")
    if tool == "Bash":
        found = bash_targets(str(ti.get("command") or ""), cwd)
    else:
        toks = [ti.get("file_path") or ti.get("notebook_path") or ""]
        if isinstance(ti.get("file_paths"), list):  # OpenCode multi-file patches
            toks += ti["file_paths"]
        found, dedup = [], set()
        for tok in toks:
            path = resolve(tok, cwd, literal=True) if isinstance(tok, str) and tok else None
            if path and path not in dedup:
                dedup.add(path)
                found.append((path, False))
    db = db_path()
    return [(p, pure) for p, pure in found if not is_exempt(p, db)]


# --- tamper guard: the kill switch and the lease store are owner-only
TAMPER_REASON = ("file-lease: BLOCKED - the file-lease kill switch and the lease store are owner-only; "
                 "agents never create, change or delete them. If the lease guard is in your way, stop "
                 "and ask the owner (the command is intentionally not echoed).")
ALL_OPERANDS = frozenset(("touch", "mkdir", "rm", "rmdir", "unlink", "shred", "truncate", "mv",
                          "chmod", "chown", "chgrp", "chattr", "setfacl", "mkfifo", "mknod"))
LAST_OPERAND = frozenset(("cp", "rsync", "scp", "install", "ln"))
RECURSIVE_OPS = frozenset(("rm", "chmod", "chown", "chgrp", "chattr", "setfacl"))
MUTATING = ALL_OPERANDS | LAST_OPERAND | {"sqlite3", "tee", "dd", "sed"}
INTERP_RE = re.compile(r"^(?:python[\d.]*|pypy[\d.]*|node(?:js)?|deno|bun|perl[\d.]*|ruby[\d.]*"
                       r"|php[\d.]*|lua[\d.]*|awk|gawk|mawk|nawk|tclsh[\d.]*|Rscript|osascript)$")
INTERP_WORD_RE = re.compile(r"(?:^|[\s;&|(`/=])(?:python[\d.]*|pypy[\d.]*|node(?:js)?|deno|bun"
                            r"|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|awk|gawk|mawk|nawk|tclsh[\d.]*"
                            r"|Rscript|osascript)(?=$|[\s;&|)<>`'\"])")
# pre-D2 rule, kept for the interpreters D2 does not model (tclsh, Rscript, osascript)
LEGACY_API_RE = re.compile(
    r"\b(?:open|touch|write\w*|mkdir|makedirs|mkfifo|mknod|symlink\w*|link\w*|rename\w*|replace"
    r"|unlink\w*|remove|rmtree|rmdir|truncate\w*|chmod|chown|copy\w*|move|system|popen|Popen"
    r"|spawn\w*|exec(?:Sync|File\w*|v\w*|l\w*)?|utime\w*|sysopen|run|call|check_call"
    r"|check_output|getoutput|executescript)\b|`|\bqx\b|print\s*>")
# D2 2026-10-10: interpreter code that only MENTIONS the store (prints, stats, reads it or
# opens it read-only) is not tamper; code that can WRITE it is. Judged on the interpreter's
# OWN code (argv, heredoc/herestring bodies on an interpreter line, and every heredoc body
# when it runs a script file) with call-shaped write APIs. A call whose every argument is an
# inert literal that does not name the store (os.remove('/tmp/x')) cannot reach it.
_FS_RECV = (r"os|posix|nt|shutil|fs|fsp|promises|Deno|Bun|File|FileUtils|Dir|IO|io|pathlib"
            r"|require\s*\(\s*['\"](?:node:)?fs(?:/promises)?['\"]\s*\)"
            r"|(?:__import__|import_module)\s*\(\s*['\"](?:os|posix|nt|shutil)['\"]\s*\)")
_FS_NAMES = (r"remove\w*|unlink\w*|rmtree|rmdir\w*|removedirs|rename\w*|replace|truncate\w*"
             r"|ftruncate\w*|chmod\w*|lchmod\w*|chown\w*|lchown\w*|chflags\w*|lchflags\w*|utimes?\w*"
             r"|futimes\w*|lutimes\w*|symlink\w*|link\w*|mkfifo\w*|mknod\w*|makedirs|mkdir\w*|mkpath"
             r"|touch|copy\w*|move|mv|cp\w*|rm\w*|delete|write\w*|binwrite|append\w*"
             r"|create(?:Sync|WriteStream)?|install|ln\w*|setxattr|lsetxattr|removexattr|lremovexattr"
             r"|unpack_archive|make_archive")
FS_CALL_RE = re.compile(r"(?<![\w$])(?P<recv>%s)\s*(?:\.|::)\s*(?P<name>%s)\s*\(" % (_FS_RECV, _FS_NAMES))
FS_NAME_RE = re.compile(r"^(?:%s)$" % _FS_NAMES)
ANY_FS_CALL_RE = re.compile(r"\.\s*(?P<name>%s)\s*\(" % _FS_NAMES)


class _Lazy:
    """A regex compiled on first use: only interpreter code that names the store reaches the
    checks that use it, so most hook calls never pay for the compile."""
    __slots__ = ("args", "rx")

    def __init__(self, *args):
        self.args, self.rx = args, None

    def __getattr__(self, name):
        if self.rx is None:
            self.rx = re.compile(*self.args)
        return getattr(self.rx, name)


# a mutator taken as a value (f = os.remove; getattr(x, ...); Reflect.get(fs, ...)): its later
# call is not visible (aliases and [] subscripts are judged in _fs_refs)
FS_REF_RE = _Lazy(r"(?<![\w$])(?P<recv>%s)\s*\.\s*(?P<name>%s)\b(?!\s*\()"
                  r"|\bgetattr\s*\(\s*(?![\s'\"\d)])|\bReflect\s*\.\s*get\s*\(" % (_FS_RECV, _FS_NAMES))
FD_WRITE_NAMES = frozenset(("write", "writeSync", "writev", "writevSync", "pwrite", "pwritev"))
FD_RECV = frozenset(("os", "posix", "nt", "fs", "fsp", "promises", "io", "Deno"))
HANDLE_WRITE_NAMES = FD_WRITE_NAMES | {"writelines", "writer", "writerow", "writerows"}
ALIAS_RE = re.compile(
    r"\b(?P<mod>os|posix|nt|shutil|pathlib|io|subprocess)\s+as\s+(?P<a>\w+)"
    r"|(?:const|let|var)\s+(?P<b>[\w$]+)\s*=\s*(?:require|(?:await\s+)?import)\s*\(\s*['\"](?:node:)?"
    r"(?P<mod2>fs|child_process)(?:/promises)?['\"]\s*\)"
    r"|\bimport\s+(?:\*\s+as\s+)?(?P<c>[\w$]+)\s+from\s+['\"](?:node:)?(?P<mod3>fs|child_process)"
    r"(?:/promises)?['\"]")
FROM_IMPORT_RE = re.compile(r"\bfrom\s+(?P<mod>os|posix|nt|shutil|subprocess|io|builtins|codecs)\s+import\s+"
                            r"(?:\((?P<pnames>[^)]*)\)|(?P<names>[\w \t,]+))")
# JS destructuring / named imports: const {unlinkSync: u, rm} = ...; import {rm as r} from 'fs'
DESTRUCT_RE = _Lazy(r"(?:\b(?:const|let|var)\s*|\bimport\b[^;{}'\"\n]*?)\{(?P<body>[^{}]*)\}")
DESTRUCT_ITEM_RE = _Lazy(r"^\s*(?:\.\.\.)?\s*(?P<key>[\w$]+)\s*(?:(?::|\bas\b)\s*(?P<alias>[\w$]+))?")
SUBSCRIPT_RE = re.compile(r"[\w$)\]]\[")
NUM_KEY_RE = re.compile(r"^-?\d*\s*(?::\s*-?\d*\s*){0,2}$")
SPAWN_NAME_RE = re.compile(r"^(?:run|call|Popen|system|popen|check_call|check_output|getoutput"
                           r"|getstatusoutput|spawn\w*|exec\w*|posix_spawn\w*)$")
METHOD_CALL_RE = re.compile(
    r"\.\s*(?P<name>unlink|rmdir|rename|replace|touch|mkdir|chmod|lchmod|chown|lchown|write_text"
    r"|write_bytes|symlink_to|hardlink_to|link_to|unlinkSync|rmdirSync|renameSync|mkdirSync"
    r"|chmodSync|chownSync|writeFile\w*|appendFile\w*|createWriteStream|copyfile|copytree"
    r"|copyFile\w*|rmSync|cpSync|extractall|unpack_archive|truncateSync|utimesSync|symlinkSync"
    r"|linkSync|rmtree|copy|move)\s*\(")
# Path-style methods: the receiver is the (first) target
RECEIVER_TARGET_METHODS = frozenset(("unlink", "rmdir", "rename", "replace", "touch", "mkdir", "chmod",
                                     "lchmod", "chown", "lchown", "write_text", "write_bytes",
                                     "symlink_to", "hardlink_to", "link_to"))
PATH_METHODS_NO_PATH_ARG = frozenset(("write_text", "write_bytes", "touch", "mkdir", "chmod", "lchmod",
                                      "chown", "lchown", "unlink", "rmdir"))
CONTENT_WRITERS = ("write", "append", "binwrite", "createWriteStream", "file_put_contents")
BARE_CALL_RE = re.compile(
    r"(?<![\w$.>:@%&])(?<!def\s)(?<!function\s)(?P<name>unlink\w*|rmtree|remove_tree|rmdir\w*"
    r"|removedirs|rename\w*|truncate\w*|chmod\w*|chown\w*|lchmod\w*|lchown\w*|symlink\w*"
    r"|link(?:Sync)?|utime\w*|mkfifo|mknod|makedirs|make_path|mkpath|mkdir\w*|touch|copyfile"
    r"|copytree|copy2|copyFile\w*|cpSync|rmSync|rm|writeFile\w*|writeTextFile\w*|appendFile\w*"
    r"|createWriteStream|file_put_contents|sysopen|unpack_archive|make_archive|remove|copy|move)\s*\(")
TWO_PATH_NAMES = frozenset(("copy", "move"))
PATH_RECV_RE = re.compile(r"\b(?:Path|PurePath|PosixPath)\s*\(\s*(?P<lit>[^()]*?)\s*\)\s*\.$")
FS_REQUIRE_RECV_RE = re.compile(r"require\s*\(\s*['\"](?:node:)?fs(?:/promises)?['\"]\s*\)\s*\.$")
OPEN_CALL_RE = re.compile(r"\b(?P<name>f?open(?:Sync)?|FileIO|ZipFile|TarFile|GzipFile|BZ2File"
                          r"|LZMAFile|new)\s*\(")
OPEN_MODULES = frozenset(("os", "io", "codecs", "gzip", "bz2", "lzma", "tarfile", "zipfile", "fs",
                          "fsp", "promises", "Deno", "File", "IO", "webbrowser", "Image", "wave",
                          "tokenize", "aiofiles", "builtins", "posix", "nt"))
WRITE_DEFAULT_OPENERS = frozenset(("shelve", "dbm", "gdbm", "ndbm", "dumbdbm", "anydbm"))
MODE_CHARS_RE = re.compile(r"^[rwaxbtU+<>]{1,4}$")
OFLAG_RE = re.compile(r"\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b")
OFLAGS_ONLY_RE = re.compile(r"^(?:[\w.$]*O_[A-Z]+|[\s|+])+$")
DB_OPEN_RE = re.compile(r"\b(?:connect|Connection|Database\w*|SQLite3|PDO|create_engine)\s*"
                        r"(?:\.\s*new\s*)?\(")
# read-only flags of a DB open (judged with string literals blanked: a flag inside a path or URI
# string is not a flag); mode=ro / immutable=1 count only in the open's own file: URI (_ro_uri)
RO_DB_RE = re.compile(r"(?i:\bread_?only\b\s*(?:=>|[:=])\s*(?:true|1)\b)|OPEN_READONLY|-readonly\b")
STR_LIT_RE = _Lazy(r"(['\"`])(?:\\.|(?!\1).)*\1", re.S)
DB_TARGET_KWS = ("database", "filename", "path", "file", "db")
INTERP_SPAWN_RE = re.compile(
    r"(?:\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|execute)"
    r"|\b(?:subprocess|commands|pty|Open3|child_process)(?:['\"]\s*\))?\s*\.\s*\w+"
    r"|\b(?:execSync|execFile\w*|spawnSync|spawn|exec|system|popen|Popen|shell_exec|passthru"
    r"|proc_open|check_call|check_output|getoutput|getstatusoutput|Command|capture[23]\w*)"
    r"|(?<![\w.])(?:run|call))\s*[.(]")
BACKTICK_SPAWN_RE = re.compile(r"`|\bqx\b|%x[({\[]")
INTERP_SHELL_WRITE_RE = re.compile(
    r"(?<![\w.$-])(?:rm|rmdir|unlink|mv|cp|ln|install|rsync|scp|tee|dd|truncate|shred|chmod|chown"
    r"|chgrp|chattr|setfacl|touch|mkdir|mkfifo|mknod|sqlite3|find|xargs|sed|sh|bash|dash|zsh|ksh"
    r"|python[\d.]*|pypy[\d.]*|perl|ruby|node|php|awk|gawk)\b|(?<![=\-<>])>")
# exec/eval/Function calls are dynamic unless every argument is a plain literal (its text is
# judged as code); a paren-less string eval (perl/ruby) and *_eval always are
DYNAMIC_RE = re.compile(r"(?P<call>\b(?:exec|execfile|eval|Function)\s*\()"
                        r"|(?<![\w$.-])eval\b(?!\s*[({])|\b(?:instance|class|module)_eval\b"
                        r"|\b(?:run_path|run_module|dofile|loadfile|loadstring)\s*\(")
PERL_VERB_RE = re.compile(r"(?:(?<![\w$@%&>:.-])|(?<=CORE::)|(?<=GLOBAL::))"
                          r"(?:unlink|rename|truncate|chmod|chown|symlink|link|utime"
                          r"|rmdir|mkdir|rmtree|remove_tree|make_path|copy|move|sysopen|syswrite)\b"
                          r"(?!\s*=>)")
PERL_OPEN_RE = re.compile(r"\bopen\b([^;\n]*)")
PERL_OPEN_WRITE_RE = re.compile(r">|\+<|\||\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b")
# Backstop (gate-wave2): the pre-D2 word rule for the forms the call-shaped checks cannot see.
# A write-API name used as a plain string or symbol ('unlinkSync', "unlink", :unlink), as a
# destructuring/object key or as a bare value ({unlinkSync: u}, f = open) can be called later
# through a computed key, send/call_user_func or an alias. A direct call name(...) stays with
# the call-shaped checks; a word inside prose (a string with spaces, a comment) is no value.
_API_NAMES = (r"open(?:Sync)?|fopen|sysopen|touch|write|write(?:File|TextFile)\w*|write_(?:text|bytes)"
              r"|binwrite|syswrite|mkdir\w*|makedirs|mkfifo\w*|mknod\w*|symlink\w*|link(?:Sync)?"
              r"|hardlink_to|link_to|rename\w*|replace|unlink\w*|remove|removedirs|rmtree|rmdir\w*"
              r"|truncate\w*|ftruncate\w*|chmod\w*|lchmod|chown\w*|lchown|copy\w*|move|delete|utime\w*"
              r"|system|popen|Popen|spawn\w*|exec(?:Sync|File\w*|v\w*|l\w*)?|run|call|check_call"
              r"|check_output|getoutput|executescript|file_put_contents|shell_exec|passthru|proc_open")
# (errors='replace' is a codec handler, so a plain 'replace' string is not counted)
API_STR_RE = _Lazy(r"(?P<q>['\"`])(?:[\w$]+(?:\.|::|->))*(?!replace(?P=q))(?:%s)(?P=q)"
                   r"|(?<![\w:]):(?:%s)\b(?![ \t]*\()" % (_API_NAMES, _API_NAMES))
API_VALUE_RE = _Lazy(
    r"(?:[{(\[,=:?|&!]|=>|\breturn\b|\byield\b)\s*(?:[\w$]+\s*(?:\.|::|->)\s*)*(?<![\w$])(?:%s)(?![\w$])"
    r"[ \t]*(?:[,;})\]]|:(?!:)|=(?![=>])|$)" % _API_NAMES, re.M)
# perl/ruby run a program without parentheses: system "rm ...", exec @cmd, IO.popen "..."
PARENLESS_SPAWN_RE = _Lazy(
    r"(?:(?<![\w$@%&>:.-])|(?<=CORE::)|(?<=GLOBAL::))(?:(?:Kernel|IO|Open3|Process)\s*(?:\.|::)\s*)?"
    r"(?:system|exec|spawn|popen\w*|capture[23]\w*|pipeline\w*)\b(?![ \t]*(?:[(=,;)\]}:]|$))", re.M)
# dynamic dispatch by a computed name (a literal symbol/string name is judged by API_STR_RE)
RUBY_SEND_RE = _Lazy(r"\.\s*(?:send|public_send|__send__|method|public_method|instance_method)\b"
                     r"(?![ \t]*\(?[ \t]*(?::[A-Za-z_]\w*[?!=]?|(['\"])[A-Za-z_]\w*[?!=]?\1))")
PHP_DYNAMIC_RE = _Lazy(r"\bcall_user_func(?:_array)?\s*\(\s*(?!(['\"])[\w\\:]*\1\s*[,)])"
                       r"|(?<![\w$>:\\])\$[A-Za-z_]\w*\s*\(|(?:->|::)\s*\$\w+\s*\(")
KEY_NAME_RE = _Lazy(r"^(?:[\w$]+(?:\.|::|->))*(?:%s|rm(?:Sync|_\w+)?|cp(?:Sync)?|mv|appendFile\w*"
                    r"|createWriteStream)$|^(?:node:)?(?:os|posix|nt|shutil|pathlib|io|subprocess"
                    r"|builtins|__builtins__|fs|fs/promises|child_process|importlib|ctypes)$" % _API_NAMES)
INPLACE_RE = re.compile(r"^-[0-9lanpswWtTuUcC]*i")
INLINE_FLAG_RE = re.compile(r"^-[A-Za-z0-9]*[ceEpr]$")
INLINE_WORDS = frozenset(("--eval", "--print", "eval", "--command"))
AWKS = frozenset(("awk", "gawk", "mawk", "nawk"))
AWK_WRITE_RE = re.compile(r"[>|]|\bsystem\b|\binplace\b")
PLAIN_LIT_RE = re.compile(r"^(?:[bBuU]|[rR][bB]?|[bB][rR])?(?P<q>['\"])(?P<s>[^'\"\\$`{}]*)(?P=q)$")
INERT_RE = re.compile(r"^(?:True|False|None|true|false|null|nil|undefined|-?\d[\w.]*)$")
INERT_OBJ_RE = re.compile(r"^\{\s*(?:[\w$]+\s*:\s*(?:true|false|null|-?\d[\w.]*|'[^'\\$`{}]*'"
                          r"|\"[^\"\\$`{}]*\")\s*,?\s*)*\}$")
KW_ARG_RE = re.compile(r"^(?:(?P<k>[A-Za-z_]\w*)\s*=(?!=)|:?(?P<k2>[A-Za-z_]\w*)\s*(?:=>|:(?!:)))\s*"
                       r"(?P<v>.*)$", re.S)
CONNECT_RE = re.compile(r"\bconnect\b")
RO_URI_RE = re.compile(r"mode=ro\b|immutable=1")
SQLITE_VALUE_OPTS = frozenset(("separator", "newline", "nullvalue", "vfs", "mmap", "lookaside",
                               "pagecache", "heap", "maxsize", "escape", "cmd"))
SQLITE_WRITE_OPTS = frozenset(("init", "A", "archive", "append", "deserialize", "zip"))
READ_SQL_RE = re.compile(
    r"^\s*(?:select\b|explain\b|values\b"
    r"|with\b(?![\s\S]*\b(?:insert|update|delete|replace|create|drop|alter)\b)"
    r"|pragma\s+(?:table_x?info|index_x?(?:list|info)|foreign_key_list|integrity_check|quick_check"
    r"|user_version|schema_version|journal_mode|page_count|page_size|freelist_count|database_list"
    r"|compile_options|encoding|application_id)\s*(?:\(\s*[\w\"'.]*\s*\))?\s*$"
    r"|\.(?:tables|schema|fullschema|indexes|indices|dump|headers|mode|width|help|show|databases"
    r"|dbinfo)\b[^\n]*$)", re.I)
SHELL_PUNCT = ";&|()<>"


def protected_sets():
    """(switch paths, lease db paths): defaults plus the test seams, all realpath'ed."""
    switches = tuple(dict.fromkeys(os.path.realpath(p) for p in
                                   switch_paths() + (os.path.join(HERE, SWITCH_NAME), SWITCH_LIVE)))
    return switches, tuple(dict.fromkeys((db_path(), os.path.realpath(DB_DEFAULT))))


def is_protected(path, prot, recursive=False):
    switches, dbs = prot
    if os.path.basename(path) == SWITCH_NAME or path in switches:
        return True
    for db in dbs:
        if path.startswith(db) or path == os.path.dirname(db):
            return True
        if recursive and db.startswith(path.rstrip("/") + "/"):
            return True  # an ancestor directory of the lease store
    return False


def _word_hits(word, cwd, has_cd, prot, recursive=False):
    """True when a Bash operand names the switch or the lease store."""
    w = (word or "").strip()
    if not w:
        return False
    switches, dbs = prot
    base = os.path.basename(w.rstrip("/"))
    if base == SWITCH_NAME:
        return True
    if re.search(r"[$`]", w) or (has_cd and not w.startswith(("/", "~"))):
        return (any(base.startswith(os.path.basename(d)) for d in dbs)
                or any(base == os.path.basename(s) for s in switches))
    w = os.path.expanduser(w)
    full = os.path.normpath(w if os.path.isabs(w) else os.path.join(cwd or "/", w))
    if re.search(r"[*?\[]", w):
        import fnmatch
        cands = list(switches)
        for d in dbs:
            cands += [d, d + "-wal", d + "-shm", d + "-journal", os.path.dirname(d)]
            parent = os.path.dirname(os.path.dirname(d))
            while recursive and parent:
                cands.append(parent)
                parent = "" if parent == "/" else os.path.dirname(parent)
        return any(fnmatch.fnmatchcase(c, full) for c in cands)
    return is_protected(os.path.realpath(full), prot, recursive)


def _mentions(text, prot):
    switches, dbs = prot
    return (SWITCH_NAME in text or any(os.path.basename(s) in text for s in switches)
            or any(os.path.basename(d) in text or os.path.dirname(d) in text for d in dbs))


def _simple_commands(text):
    """Word lists per simple command (shlex; redirect operators and their word dropped)."""
    import shlex
    lex = shlex.shlex(text, posix=True, punctuation_chars=SHELL_PUNCT)
    lex.whitespace_split = True
    lex.commenters = ""
    out, cur, skip = [], [], False
    for tok in lex:
        if tok and not tok.strip(SHELL_PUNCT):
            if "<" in tok or ">" in tok:
                skip = True
                continue
            skip = False
            if cur:
                out.append(cur)
            cur = []
            continue
        if skip:
            skip = False
            continue
        cur.append(tok)
    if cur:
        out.append(cur)
    return out


def _substitutions(command):
    """Bodies of $(...) and `...` (also inside double quotes; never inside single quotes)."""
    out, i, n, dq = [], 0, len(command), False
    while i < n:
        c = command[i]
        if c == "\\":
            i += 2
        elif c == "'" and not dq:
            j = command.find("'", i + 1)
            i = n if j < 0 else j + 1
        elif c == '"':
            dq, i = not dq, i + 1
        elif c == "`":
            j = command.find("`", i + 1)
            if j < 0:
                break
            out.append(command[i + 1:j])
            i = j + 1
        elif command.startswith("$(", i) and not command.startswith("$((", i):
            depth, j = 1, i + 2
            while j < n and depth:
                depth += {"(": 1, ")": -1}.get(command[j], 0)
                j += 1
            out.append(command[i + 2:j - 1])
            i = j
        else:
            i += 1
    return out


def _sqlite_tamper(args, raw, cwd, has_cd, prot):
    readonly, writes, opers, sql, i = False, False, [], [], 0
    while i < len(args):
        a = args[i]
        if a.startswith("-") and len(a) > 1:
            opt = a.lstrip("-").split("=", 1)[0]
            if opt == "readonly":
                readonly = True
            elif opt in SQLITE_WRITE_OPTS or opt.startswith("A"):
                writes = True
            elif opt in SQLITE_VALUE_OPTS and "=" not in a:
                if opt == "cmd" and i + 1 < len(args):
                    sql.append(args[i + 1])
                i += 1
        else:
            opers.append(a)
        i += 1
    if opers:
        db = opers[0]
        target = db[5:].split("?", 1)[0] if db.startswith("file:") else db
        if not _word_hits(target, cwd, has_cd, prot):
            return False
        if _ro_uri(db):
            readonly = True
        sql += opers[1:]
    elif not _mentions(raw, prot):
        return False  # in-memory / unrelated database
    if readonly and not writes:
        return False
    stmts = [s for chunk in sql for s in chunk.split(";") if s.strip()]
    return writes or not stmts or not all(READ_SQL_RE.match(s) for s in stmts)


def _call_args(code, start):
    """Top-level comma-separated arguments of the call whose '(' ends at code[start - 1]
    (quote and bracket aware; an unterminated call keeps the rest of the code)."""
    parts, cur, depth, q, j, n = [], [], 1, None, start, len(code)
    while j < n:
        c = code[j]
        if q:
            if c == "\\":
                cur.append(code[j:j + 2])
                j += 2
                continue
            if c == q:
                q = None
        elif c in "'\"`":
            q = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                break
        elif c == "," and depth == 1:
            parts.append("".join(cur).strip())
            cur = []
            j += 1
            continue
        cur.append(c)
        j += 1
    tail = "".join(cur).strip()
    if tail or parts:
        parts.append(tail)
    return parts


def _kw(part):
    m = KW_ARG_RE.match(part.strip())
    return (m.group("k") or m.group("k2"), m.group("v").strip()) if m else (None, part.strip())


def _plain(part):
    """The text of a plain string literal (no escapes or interpolation), else None."""
    m = PLAIN_LIT_RE.match(part.strip())
    return m.group("s") if m else None


def _inert(part, prot):
    """True when a call argument cannot name the store: a plain literal that does not mention
    it, a number/boolean/null, or an object literal of such values."""
    value = _kw(part)[1]
    lit = _plain(value)
    if lit is not None:
        return not _mentions(lit, prot)
    if INERT_OBJ_RE.match(value):
        return not _mentions(value, prot)
    return bool(INERT_RE.match(value))


def _targets(name, parts):
    """The path arguments of a write call: content writers take the path first only."""
    if name.startswith(CONTENT_WRITERS):
        pos = [p for p in parts if not _kw(p)[0]]
        return pos[:1]
    return parts


def _aliases(code):
    """(fs-module aliases, spawn-module aliases, bare fs names, bare spawn names) bound in code:
    import ... as, require()/import() bindings, from-imports and JS destructuring."""
    fs, spawn, bare, bare_spawn = set(), set(), set(), set()
    for m in ALIAS_RE.finditer(code):
        mod = m.group("mod") or m.group("mod2") or m.group("mod3")
        (spawn if mod in ("subprocess", "child_process") else fs).add(m.group("a") or m.group("b")
                                                                     or m.group("c"))
    for m in FROM_IMPORT_RE.finditer(code):
        for item in (m.group("pnames") or m.group("names") or "").split(","):
            words = item.split()
            if not words:
                continue
            name, bound = words[0], words[-1] if len(words) == 3 and words[1] == "as" else words[0]
            if SPAWN_NAME_RE.match(name):
                bare_spawn.add(bound)
            elif (FS_NAME_RE.match(name) or name in ("open", "fdopen")) and bound != name:
                bare.add(bound)
    for m in DESTRUCT_RE.finditer(code):  # every destructured mutator, aliased or not
        for item in m.group("body").split(","):
            im = DESTRUCT_ITEM_RE.match(item)
            if not im:
                continue
            name, bound = im.group("key"), im.group("alias") or im.group("key")
            if SPAWN_NAME_RE.match(name):
                bare_spawn.add(bound)
            elif (FS_NAME_RE.match(name) and name not in FD_WRITE_NAMES) or name in ("open", "openSync"):
                bare.add(bound)
    return fs, spawn, bare, bare_spawn


def _names_rx(names):
    return "|".join(re.escape(n) for n in sorted(names))


def _literal_key(part):
    """A subscript key that cannot select a mutator: a number, a numeric slice, or a plain
    string that is not an API or module name."""
    part = part.strip()
    if NUM_KEY_RE.match(part):
        return True
    lit = _plain(part)
    return lit is not None and not KEY_NAME_RE.match(lit)


def _fs_refs(code, aliases):
    """A mutator taken as a value, so its later call is not visible: module.name without a call
    (also through an import/require alias), getattr or Reflect.get on any receiver, a [] subscript
    with a computed key or an API/module-name key, or a from-import/destructuring alias used
    other than by a direct call."""
    fs_alias, _spawn, bare_alias, _bare_spawn = aliases
    rxs = [FS_REF_RE]
    if fs_alias:
        rxs.append(re.compile(r"(?<![\w$])(?P<recv>%s)\s*\.\s*(?P<name>%s)\b(?!\s*\()"
                              % (_names_rx(fs_alias), _FS_NAMES)))
    for rx in rxs:
        for m in rx.finditer(code):
            recv, name = m.groupdict().get("recv"), m.groupdict().get("name")
            if name in FD_WRITE_NAMES and (rx is not FS_REF_RE or recv in FD_RECV
                                           or recv.startswith(("require", "__import__", "import_module"))):
                continue  # os.write / fs.writeSync: an fd write; the open() that made the fd counts
            return True
    if bare_alias:
        rest = DESTRUCT_RE.sub(" ", FROM_IMPORT_RE.sub(" ", code))  # the binding itself is no use
        if re.search(r"(?<![\w$.])(?:%s)(?![\w$])(?!\s*\()" % _names_rx(bare_alias), rest):
            return True
    for m in SUBSCRIPT_RE.finditer(code):
        if not all(_literal_key(p) for p in _call_args(code, m.end())):
            return True
    return False


def _fs_writes(code, prot, aliases):
    """A write-shaped file-system call (module, bare or method form) that can reach the store:
    a path argument that is not an inert literal, or a Path receiver that is not one."""
    if _fs_refs(code, aliases):
        return True
    fs_alias, _spawn, bare_alias, _bare_spawn = aliases
    module_rx = [FS_CALL_RE]
    if fs_alias:
        module_rx.append(re.compile(r"(?<![\w$])(?P<recv>%s)\s*(?:\.|::)\s*(?P<name>%s)\s*\("
                                    % (_names_rx(fs_alias), _FS_NAMES)))
    module_hits = set()
    for rx in module_rx:
        for m in rx.finditer(code):
            module_hits.add(m.start("name"))
            recv, name = m.group("recv"), m.group("name")
            if (recv in ("os", "posix", "nt", "fs", "io") or recv in fs_alias) and name in FD_WRITE_NAMES:
                continue  # fd / stdout writes: the open() that made the fd is what counts
            if not all(_inert(p, prot) for p in _targets(name, _call_args(code, m.end()))):
                return True
    bare_rx = [BARE_CALL_RE]
    if bare_alias:
        bare_rx.append(re.compile(r"(?<![\w$.>:@%%&])(?P<name>%s)\s*\(" % _names_rx(bare_alias)))
    for rx in bare_rx:
        for m in rx.finditer(code):
            name, parts = m.group("name"), _call_args(code, m.end())
            if name in TWO_PATH_NAMES and len([p for p in parts if not _kw(p)[0]]) < 2:
                continue  # a one-argument copy()/move() is not a file copy
            if not all(_inert(p, prot) for p in _targets(name, parts)):
                return True
    for m in ANY_FS_CALL_RE.finditer(code):  # any receiver (an alias, __import__(...)): store args
        name, parts = m.group("name"), _call_args(code, m.end())
        pos = [p for p in parts if not _kw(p)[0]]
        if (name in HANDLE_WRITE_NAMES or name in PATH_METHODS_NO_PATH_ARG
                or (name == "replace" and len(pos) > 1) or (name in TWO_PATH_NAMES and len(pos) < 2)):
            continue
        if any(_mentions(_kw(p)[1], prot) for p in _targets(name, parts)):
            return True
    for m in METHOD_CALL_RE.finditer(code):
        if m.start("name") in module_hits:
            continue
        name, parts = m.group("name"), _call_args(code, m.end())
        pos = [p for p in parts if not _kw(p)[0]]
        if name == "replace" and not (len(pos) == 1 or any(_kw(p)[0] == "target" for p in parts)):
            continue  # str.replace(old, new): Path.replace takes one target
        if name in TWO_PATH_NAMES and len(pos) < 2:
            continue  # copy.copy(obj) / dict.copy()
        if name in RECEIVER_TARGET_METHODS:
            recv = PATH_RECV_RE.search(code, 0, m.start() + 1)
            lit = _plain(recv.group("lit")) if recv else None
            if lit is not None and not _mentions(lit, prot) and (
                    name in PATH_METHODS_NO_PATH_ARG or all(_inert(p, prot) for p in parts)):
                continue  # Path('/tmp/x').write_text(...): a literal receiver away from the store
            return True
        targets = _targets(name, parts)
        if not targets or not all(_inert(p, prot) for p in targets):
            return True
    return False


def _mode_writes(mode):
    """True unless an open mode/flags value is provably read-only."""
    mode = mode.strip()
    if OFLAG_RE.search(mode):
        return True
    lit = _plain(mode)
    if lit is not None:
        return "|" in lit or any(c in lit.split(":", 1)[0] for c in "wax+>")
    return not OFLAGS_ONLY_RE.match(mode)  # O_RDONLY & co read; a mode in a variable is unknown


def _open_writes(code, prot):
    """True when an open-like call can write the store: a write mode ('w', 'a', 'x', '+', '>'),
    O_ write flags or a mode that is not a literal, unless its target is an inert literal path.
    open(path) and r/rb/'<' modes read."""
    for m in OPEN_CALL_RE.finditer(code):
        name, before = m.group("name"), code[:m.start()].rstrip()
        method = before.endswith((".", "::"))
        rm = re.search(r"([\w$]+)\s*(?:\.|::)$", before) if method else None
        recv = rm.group(1) if rm else ""
        if name == "new" and recv not in ("File", "IO"):
            continue
        parts = _call_args(code, m.end())
        pos = [p.strip() for p in parts if not _kw(p)[0]]
        kws = dict(_kw(p) for p in parts if _kw(p)[0])
        mode = kws.get("mode", kws.get("flags", kws.get("flag")))
        known = not method or recv in OPEN_MODULES or bool(FS_REQUIRE_RECV_RE.search(before))
        if known:
            target = pos[0] if pos else None
            if mode is None and len(pos) > 1:
                mode = pos[1]
        else:  # Path(...).open(mode), handle.open(...): the receiver is the target
            lit = _plain(PATH_RECV_RE.search(before).group("lit")) if PATH_RECV_RE.search(before) else None
            target = "'%s'" % lit if lit is not None else None
            if mode is None and pos:
                first = _plain(pos[0])
                if first is None or MODE_CHARS_RE.match(first):
                    mode = pos[0]
                elif len(pos) > 1:
                    mode = pos[1]
            if mode is None and recv in WRITE_DEFAULT_OPENERS:
                mode = "?"
        if mode is None or not _mode_writes(mode):
            continue
        if target is not None and (_inert(target, prot) and _plain(target) is not None
                                   or re.fullmatch(r"[0-2]", target)):
            continue  # an inert literal target or a std fd
        return True
    return False


def _ro_uri(uri):
    """True for a sqlite file: URI that opens read-only: mode=ro (or immutable=1) and no other
    mode= (the last one wins), nothing percent-encoded (%6Fde decodes to a key)."""
    if not uri.startswith("file:") or "?" not in uri:
        return False
    query = uri.split("?", 1)[1].split("#", 1)[0]
    if "%" in query:
        return False
    pairs = [kv.partition("=") for kv in query.split("&")]
    modes = [v for k, _, v in pairs if k == "mode"]
    if any(v != "ro" for v in modes):
        return False
    return bool(modes) or any(k == "immutable" and v.lower() in ("1", "true", "yes", "on") for k, _, v in pairs)


def _db_writes(code, prot):
    """A database handle opened read-write on the store (or on a path that is not a literal).
    Read-only only by the open's OWN arguments: a read-only flag (outside any string literal), or
    its own literal file: URI with mode=ro/immutable=1 opened with uri=True; database=db counts
    like a positional target."""
    for m in DB_OPEN_RE.finditer(code):
        parts = _call_args(code, m.end())
        if RO_DB_RE.search(STR_LIT_RE.sub("''", ",".join(parts))):
            continue
        pos = [p for p in parts if not _kw(p)[0]]
        kws = dict(_kw(p) for p in parts if _kw(p)[0])
        target = pos[0] if pos else next((kws[k] for k in DB_TARGET_KWS if k in kws), None)
        if target is None:
            continue  # connect() with no target: a socket / env DSN
        lit = _plain(target)
        if lit is not None and _ro_uri(lit) and kws.get("uri") in ("True", "true", "1"):
            continue  # its own read-only file: URI, opened as a URI
        if lit is None or _mentions(lit, prot):
            return True
    return False


def _heredoc_bodies(command, masked, depth=0):
    """[(opener line, body)] for each heredoc of a command (operators found on the
    scan_shell mask, so quoted '<<' is not one); bodies holding heredocs are expanded."""
    swg = neighbor("secret-write-guard.py")
    out, pos, n = [], 0, len(command)
    while pos < n:
        eol = command.find("\n", pos)
        eol = n if eol < 0 else eol
        pending = []
        for m in re.finditer(r"(?<!<)<<(?!<)", masked[pos:eol]):
            hm = swg._HEREDOC_OP_RE.match(command, pos + m.start())
            if hm:
                pending.append((hm.group(1) == "-", next(g for g in hm.group(2, 3, 4) if g is not None)))
        opener, pos = command[pos:eol], eol + 1
        for strip_tabs, delim in pending:
            start, end = pos, n
            while pos < n:
                e = command.find("\n", pos)
                e = n if e < 0 else e
                line = command[pos:e]
                if (line.lstrip("\t") if strip_tabs else line).strip() == delim:
                    end, pos = pos, e + 1
                    break
                pos = e + 1
            body = command[start:end]
            out.append((opener, body))
            if depth < 2 and "<<" in body:
                out += _heredoc_bodies(body, swg.scan_shell(body)[0], depth + 1)
    return out


def _herestrings(command, masked):
    """[(line, word)] for each `<<< word` (the word unquoted)."""
    swg = neighbor("secret-write-guard.py")
    out = []
    for m in re.finditer(r"<<<", masked):
        k = m.end()
        while k < len(command) and command[k] in " \t":
            k += 1
        wm = swg._WORD_RE.match(command, k)
        if wm:
            ls = command.rfind("\n", 0, m.start()) + 1
            le = command.find("\n", m.end())
            out.append((command[ls:len(command) if le < 0 else le], swg._unquote(wm.group())))
    return out


def _spawn_text(parts):
    """Shell text of a spawn call whose arguments are all literals (a command string or an
    argv list of plain strings; inert keywords/options allowed), else None."""
    import shlex
    out = []
    for p in parts:
        k, v = _kw(p)
        lit = _plain(v)
        if k:
            if lit is None and not (INERT_RE.match(v) or INERT_OBJ_RE.match(v)
                                    or re.match(r"^(?:subprocess\s*\.\s*)?(?:PIPE|DEVNULL|STDOUT)$", v)):
                return None
            continue  # shell=True, check=True, text=True, timeout=5, stdout=PIPE
        if lit is not None:
            out.append(lit)
        elif v[:1] in "[(" and v[-1:] in "])":
            items = [x for x in _call_args(v[1:-1] + ")", 0) if x]
            lits = [_plain(x) for x in items]
            if any(x is None for x in lits):
                return None
            out.append(shlex.join(lits))
        elif INERT_OBJ_RE.match(v):
            continue  # node options object
        else:
            return None
    return " ".join(out)


def _spawn_writes(code, lang, prot, cwd, depth, aliases):
    """A process spawn whose command is not a literal, or whose literal command is itself
    tamper when judged like a Bash command (relative operands judged as after a cd)."""
    _fs, spawn_alias, _bare, bare_spawn = aliases
    rxs = [INTERP_SPAWN_RE]
    if spawn_alias:
        rxs.append(re.compile(r"(?<![\w$])(?:%s)\s*\.\s*\w+\s*[.(]" % _names_rx(spawn_alias)))
    if bare_spawn:
        rxs.append(re.compile(r"(?<![\w$.])(?:%s)\s*\(" % _names_rx(bare_spawn)))
    texts = []
    for rx in rxs:
        for m in rx.finditer(code):
            text = _spawn_text(_call_args(code, m.end())) if code[m.end() - 1] == "(" else None
            if text is None:
                return True
            texts.append(text)
    if lang in ("perl", "ruby", "php"):
        if re.search(r"\bqx\b|%x[({\[]", code):
            return True
        for m in re.finditer(r"`([^`]*)`", code):
            if re.search(r"[$@]|#\{", m.group(1)):
                return True
            texts.append(m.group(1))
    for text in texts:
        if depth >= 3:
            if INTERP_SHELL_WRITE_RE.search(text):
                return True
        elif bash_tamper("cd . ; " + text, cwd, prot, depth + 1):
            return True
    return False


def _dynamic(code):
    """Code the guard cannot see: exec/eval/Function of anything but plain literals (a literal's
    text is judged as code already), run_path/dofile, a paren-less or *_eval string eval."""
    for m in DYNAMIC_RE.finditer(code):
        if m.group("call") and all(_plain(p) is not None for p in _call_args(code, m.end()) if p):
            continue
        return True
    return False


def _backstop(code, lang):
    """The pre-D2 word rule for what the call-shaped checks cannot see: a write-API name as a
    plain string or symbol, a destructuring/object key or a bare value (not a direct call), a
    paren-less perl/ruby spawn, and ruby/php dispatch by a computed name."""
    if API_STR_RE.search(code) or API_VALUE_RE.search(FROM_IMPORT_RE.sub(" ", code)):
        return True
    if lang in ("perl", "ruby") and PARENLESS_SPAWN_RE.search(code):
        return True
    return bool((lang == "ruby" and RUBY_SEND_RE.search(code)) or (lang == "php" and PHP_DYNAMIC_RE.search(code)))


def _code_writes(code, lang, argv, prot, cwd="", depth=0):
    if lang in AWKS:
        return bool(AWK_WRITE_RE.search(code))
    if lang in ("perl", "ruby") and any(INPLACE_RE.match(a) for a in argv):
        return True  # -i: in-place edit of the operand files
    if _backstop(code, lang):
        return True  # a write-API name reached by string, symbol, key or value
    aliases = _aliases(code)
    if _fs_writes(code, prot, aliases) or _open_writes(code, prot) or _db_writes(code, prot):
        return True
    if lang == "perl" and (PERL_VERB_RE.search(code) or any(
            PERL_OPEN_WRITE_RE.search(m.group(1)) for m in PERL_OPEN_RE.finditer(code))):
        return True
    if _dynamic(code):
        return True  # exec/eval/Function(<not a literal>) / run_path(): code the guard cannot see
    return _spawn_writes(code, lang, prot, cwd, depth, aliases)


def _interp_tamper(name, argv, raw, masked, prot, cwd="", depth=0):
    """Interpreter code that can write the store (D2 2026-10-10: a read-only mention passes)."""
    head = " ".join(argv)
    pre_d2 = head + ("\n" + raw if "<<" in raw else "")
    if not _mentions(pre_d2, prot):
        return False  # the pre-D2 precondition, unchanged
    lang = re.sub(r"[\d.]+$", "", name)
    if lang in ("tclsh", "Rscript", "osascript"):
        return bool(LEGACY_API_RE.search(pre_d2)
                    or (CONNECT_RE.search(pre_d2) and not RO_URI_RE.search(pre_d2)))
    inline = (lang in AWKS and "-f" not in argv) or any(
        INLINE_FLAG_RE.match(a) or a in INLINE_WORDS for a in argv)
    if masked is None:
        masked = neighbor("secret-write-guard.py").scan_shell(raw)[0]
    docs = (_heredoc_bodies(raw, masked) if "<<" in raw else []) + (
        _herestrings(raw, masked) if "<<<" in raw else [])
    # inline code (-c/-e) owns only the bodies on an interpreter line; a script file, module
    # or stdin run may execute any body this command writes, so it owns them all
    code = "\n".join([head] + [b for line, b in docs if not inline or INTERP_WORD_RE.search(line)])
    if lang in ("perl", "ruby", "php") and "`" in raw:  # the word split turned ` into ;
        code += "\n" + "\n".join(re.findall(r"`[^`]*`", raw))
    return _code_writes(code, lang, argv, prot, cwd, depth)


def _command_tamper(words, raw, cwd, has_cd, prot, masked=None, depth=0):
    for k, w in enumerate(words):
        name = os.path.basename(w)
        if INTERP_RE.match(name):
            return _interp_tamper(name, words[k + 1:], raw, masked, prot, cwd, depth)
        if name == "sqlite3":
            return _sqlite_tamper(words[k + 1:], raw, cwd, has_cd, prot)
        if name == "find":
            rest = words[k + 1:]
            starts = []
            for a in rest:
                if a.startswith(("-", "(", "!")):
                    break
                starts.append(a)
            execs = any(r in ("-exec", "-execdir", "-ok", "-okdir") for r in rest) and any(
                os.path.basename(r) in MUTATING for r in rest)
            if ("-delete" in rest or execs) and any(
                    _word_hits(s, cwd, has_cd, prot, True) for s in starts or ["."]):
                return True
            continue
        if name == "xargs":
            if any(os.path.basename(r) in MUTATING for r in words[k + 1:]):
                return _mentions(raw, prot)  # operands arrive on stdin: any protected mention
            continue
        if name in ALL_OPERANDS or name in LAST_OPERAND:
            args = words[k + 1:]
            opers = [a for a in args if not a.startswith("-") or a == "-"]
            if any(os.path.basename(o.rstrip("/")) == SWITCH_NAME for o in opers):
                return True
            flags = "".join(a for a in args if a.startswith("-"))
            recursive = name in RECURSIVE_OPS and ("r" in flags.lower() or "--recursive" in args)
            if name in LAST_OPERAND:
                return bool(opers) and _word_hits(opers[-1], cwd, has_cd, prot)
            if name == "mv":  # moving an ancestor moves the store; the destination is exact
                return any(_word_hits(o, cwd, has_cd, prot, i < len(opers) - 1)
                           for i, o in enumerate(opers))
            return any(_word_hits(o, cwd, has_cd, prot, recursive) for o in opers)
    return False


def bash_tamper(command, cwd, prot, depth=0):
    swg = neighbor("secret-write-guard.py")
    has_cd = bool(CD_RE.search(command))
    for tok in swg.bash_write_targets(command)[1]:  # redirect/tee/dd/cp/python-open sinks
        if _word_hits(tok.strip("'\""), cwd, has_cd, prot):
            return True
    masked = swg.scan_shell(command)[0]
    text = "".join(";" if (m == ";" and c == "\n") else (" " if (m == " " and c not in " \t") else c)
                   for c, m in zip(command, masked))  # unquoted newlines split, comments blanked
    try:
        cmds = _simple_commands(text.replace("`", " ; "))
    except ValueError:
        return _mentions(command, prot)  # unbalanced quoting near a protected name
    if any(_command_tamper(words, command, cwd, has_cd, prot, masked, depth) for words in cmds):
        return True
    if depth < 3:
        for body in swg._nested_scripts(command, masked) + _substitutions(command):
            if bash_tamper(body, cwd, prot, depth + 1):
                return True
    return False


def tamper(data):
    """Deny reason when a PreToolUse call would create/change/delete the switch or lease store."""
    if data.get("hook_event_name") != "PreToolUse":
        return None
    tool, ti = data.get("tool_name"), data.get("tool_input")
    if tool not in EDIT_TOOLS + ("Bash",) or not isinstance(ti, dict):
        return None
    prot, cwd = protected_sets(), str(data.get("cwd") or "")
    if tool == "Bash":
        return TAMPER_REASON if bash_tamper(str(ti.get("command") or ""), cwd, prot) else None
    toks = [ti.get("file_path"), ti.get("notebook_path")]
    if isinstance(ti.get("file_paths"), list):
        toks += ti["file_paths"]
    for tok in toks:
        if isinstance(tok, str) and tok.strip():
            full = os.path.expanduser(tok.strip())
            full = os.path.realpath(full if os.path.isabs(full) else os.path.join(cwd or "/", full))
            if is_protected(full, prot):
                return TAMPER_REASON
    return None


def actor_of(data):
    return str(data.get("session_id") or ""), (str(data.get("agent_id") or "") or "main")


def connect():
    import sqlite3
    path = db_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    if not os.path.exists(path):
        os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
    conn = sqlite3.connect(path, timeout=2.0, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=2000")
    if conn.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def holder_dead(conn, session, agent, pid, start, ts, now, lease_ttl):
    if pid:
        if not pid_alive(pid, start):
            return True
        if agent == "main":
            return False
    if ts is None or now - ts < lease_ttl:
        return False
    last = conn.execute("SELECT MAX(at) FROM seen WHERE session_id=? AND agent_id=?",
                        (session, agent)).fetchone()[0]
    return last is None or now - last >= lease_ttl


def lease_expiry(conn, path, hs, ha, hts, ws, wa, wts, lease_ttl):
    """When a foreign lease stops blocking. post() stamps seen.at and holder_ts with the same
    time, so seen.at >= holder_ts means a PostToolUse confirmed the latest PreToolUse: full TTL.
    Unconfirmed: 60 s, or the TTL after the holder's own last write when that is later."""
    row = conn.execute("SELECT at FROM seen WHERE session_id=? AND agent_id=? AND path=?",
                       (hs, ha, path)).fetchone()
    if row and row[0] is not None and row[0] >= hts:
        return hts + lease_ttl
    own_write = wts + lease_ttl if (ws, wa) == (hs, ha) and wts is not None else 0.0
    return max(hts + min(PENDING_TTL, lease_ttl), own_write)


def record_half_applied(conn, path, session, agent, at):
    conn.execute(
        "INSERT INTO half_applied(path, session_id, agent_id, at, reported) VALUES(?,?,?,?,0) "
        "ON CONFLICT(path, session_id, agent_id) DO UPDATE SET at=excluded.at, reported=0 "
        "WHERE excluded.at > half_applied.at", (path, session, agent, at or time.time()))


def utc(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts or 0))


def deny(reason):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                   "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def pre(conn, data, tgts):
    session, agent = actor_of(data)
    pid = holder_pid(data)
    start = pid_start(pid) if pid else None
    now, lease_ttl = time.time(), ttl()
    notes = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        for path, pure in tgts:
            if pure:
                continue
            row = conn.execute(
                "SELECT holder_session, holder_agent, holder_pid, holder_pid_start, holder_ts, "
                "writer_session, writer_agent, writer_ts FROM lease WHERE path=?", (path,)).fetchone()
            if row:
                hs, ha, hp, hps, hts, ws, wa, wts = row
                if hs is not None and (hs, ha) != (session, agent):
                    expires = lease_expiry(conn, path, hs, ha, hts, ws, wa, wts, lease_ttl)
                    if holder_dead(conn, hs, ha, hp, hps, hts, now, lease_ttl):
                        record_half_applied(conn, path, hs, ha, hts)
                        notes.append("the previous lease holder %s/%s of %s looks dead (killed or "
                                     "crashed mid-run): the file may be half-applied - Read it and "
                                     "check it before building on it" % (hs, ha, path))
                    elif now >= expires:
                        pass  # expired (or an unconfirmed lease older than 60 s): free to take
                    elif agent == "main" and hs == session:
                        notes.append("took over the lease on %s from subagent %s of this session "
                                     "(last write %d s ago); make sure that subagent has stopped "
                                     "and Read the file before relying on it"
                                     % (path, ha, int(now - hts)))
                    elif hs == session and ha == "main":
                        pass  # parent -> child: a subagent of the holder's own main thread
                    else:
                        conn.execute("ROLLBACK")
                        return deny(
                            "file-lease: BLOCKED writing %s - another agent holds its lease: "
                            "session %s, agent %s (pid %s), last write %d s ago, lease expires in "
                            "%d s. Do not work around this lock: wait until that agent has "
                            "finished, then Read the file again and retry your change on the "
                            "current content." % (path, hs, ha, hp or "?", int(now - hts),
                                                  max(0, int(expires - now))))
                if ws is not None and (ws, wa) != (session, agent):
                    seen = conn.execute(
                        "SELECT sha256 FROM seen WHERE session_id=? AND agent_id=? AND path=?",
                        (session, agent, path)).fetchone()
                    cur = fingerprint(path) if seen and seen[0] else None
                    if cur is not None and cur != seen[0]:
                        conn.execute("ROLLBACK")
                        return deny(
                            "file-lease: BLOCKED writing %s - it changed since you last saw it "
                            "(last written by session %s, agent %s at %s). Read the file again "
                            "and re-apply your change on the current content."
                            % (path, ws, wa, utc(wts)))
            conn.execute(
                "INSERT INTO lease(path, holder_session, holder_agent, holder_pid, holder_pid_start, "
                "holder_ts) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
                "holder_session=excluded.holder_session, holder_agent=excluded.holder_agent, "
                "holder_pid=excluded.holder_pid, holder_pid_start=excluded.holder_pid_start, "
                "holder_ts=excluded.holder_ts", (path, session, agent, pid, start, now))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    if notes:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                       "additionalContext": "file-lease WARNING: " + "; ".join(notes)}}
    return None


def post(conn, data, tgts):
    session, agent = actor_of(data)
    is_read = data.get("tool_name") == "Read"
    pid = None if is_read else holder_pid(data)
    start = pid_start(pid) if pid else None
    now = time.time()
    conn.execute("BEGIN IMMEDIATE")
    try:
        for path, pure in tgts:
            sha = fingerprint(path)
            conn.execute(
                "INSERT INTO seen(session_id, agent_id, path, sha256, at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(session_id, agent_id, path) DO UPDATE SET sha256=excluded.sha256, "
                "at=excluded.at", (session, agent, path, sha, now))
            if is_read:
                continue  # a Read records what the actor saw; it never holds a lease
            conn.execute(
                "INSERT INTO lease(path, writer_session, writer_agent, writer_ts, writer_sha) "
                "VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
                "writer_session=excluded.writer_session, writer_agent=excluded.writer_agent, "
                "writer_ts=excluded.writer_ts, writer_sha=excluded.writer_sha",
                (path, session, agent, now, sha))
            if not pure:
                conn.execute(
                    "UPDATE lease SET holder_session=?, holder_agent=?, holder_pid=?, "
                    "holder_pid_start=?, holder_ts=? WHERE path=?",
                    (session, agent, pid, start, now, path))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return None


RELEASE_SQL = ("UPDATE lease SET holder_session=NULL, holder_agent=NULL, holder_pid=NULL, "
               "holder_pid_start=NULL, holder_ts=NULL WHERE holder_session=? AND holder_agent=?")


def release(conn, data, event):
    session, agent = actor_of(data)
    if not session or (event == "SubagentStop" and agent == "main"):
        return None
    with conn:
        conn.execute(RELEASE_SQL, (session, agent))
    return None


def session_start(conn, data):
    now, lease_ttl = time.time(), ttl()
    conn.execute("BEGIN IMMEDIATE")
    try:
        held = conn.execute(
            "SELECT path, holder_session, holder_agent, holder_pid, holder_pid_start, holder_ts "
            "FROM lease WHERE holder_session IS NOT NULL").fetchall()
        for path, hs, ha, hp, hps, hts in held:
            if holder_dead(conn, hs, ha, hp, hps, hts, now, lease_ttl):
                record_half_applied(conn, path, hs, ha, hts)
                conn.execute("UPDATE lease SET holder_session=NULL, holder_agent=NULL, "
                             "holder_pid=NULL, holder_pid_start=NULL, holder_ts=NULL "
                             "WHERE path=?", (path,))
        rows = conn.execute("SELECT rowid, path, session_id, agent_id, at FROM half_applied "
                            "WHERE reported=0 ORDER BY at LIMIT ?", (REPORT_LIMIT,)).fetchall()
        conn.executemany("UPDATE half_applied SET reported=1 WHERE rowid=?", [(r[0],) for r in rows])
        left = conn.execute("SELECT COUNT(*) FROM half_applied WHERE reported=0").fetchone()[0]
        cutoff = now - PRUNE_AFTER
        conn.execute("DELETE FROM seen WHERE at < ?", (cutoff,))
        conn.execute("DELETE FROM half_applied WHERE reported=1 AND at < ?", (cutoff,))
        conn.execute("DELETE FROM lease WHERE holder_session IS NULL AND "
                     "(writer_ts IS NULL OR writer_ts < ?)", (cutoff,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    if not rows:
        return None
    lines = ["file-lease: files possibly left half-applied by agents that died mid-run "
             "(flagged only, nothing was reverted; Read and verify before relying on them):"]
    lines += ["possibly half-applied by %s/%s at %s: %s" % (s, a, utc(t), p) for _, p, s, a, t in rows]
    if left:
        lines.append("... and %d more (shown at the next session start)" % left)
    return {"hookSpecificOutput": {"hookEventName": "SessionStart",
                                   "additionalContext": "\n".join(lines)}}


def dispatch(data):
    event = data.get("hook_event_name")
    tool = data.get("tool_name")
    if event in ("PreToolUse", "PostToolUse"):
        allowed = EDIT_TOOLS + ("Bash",) + (("Read",) if event == "PostToolUse" else ())
        if tool not in allowed or not actor_of(data)[0]:
            return None
        tgts = targets(data)
        if not tgts or (event == "PreToolUse" and all(pure for _, pure in tgts)):
            return None
        conn = connect()
        try:
            return (pre if event == "PreToolUse" else post)(conn, data, tgts)
        finally:
            conn.close()
    if event in ("SessionStart", "SubagentStop", "SessionEnd"):
        conn = connect()
        try:
            if event == "SessionStart":
                return session_start(conn, data)
            return release(conn, data, event)
        finally:
            conn.close()
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, RecursionError):  # bad or absurdly nested JSON: fail open
        return
    if not isinstance(data, dict):
        return
    who = "event=%s tool=%s session=%s agent=%s" % (
        data.get("hook_event_name"), data.get("tool_name"), data.get("session_id"),
        data.get("agent_id") or "main")
    if switch_on():
        log("KILL-SWITCH file " + who)
        return
    try:
        reason = tamper(data)
    except Exception as exc:  # fail OPEN, but keep leasing
        reason = None
        log("FAIL-OPEN tamper-check %s error=%r" % (who, exc))
    if reason:
        log("TAMPER-DENY " + who)
        print(json.dumps(deny(reason)))
        return
    if env_off():
        ti = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
        path = ti.get("file_path") or ti.get("notebook_path") if data.get("tool_name") in EDIT_TOOLS else None
        log("KILL-SWITCH env FILE_LEASE=off %s%s" % (who, " path=%s" % path if path else ""))
        return
    try:
        out = dispatch(data)
    except Exception as exc:  # fail OPEN: a guard bug must never block work
        log("FAIL-OPEN event=%s tool=%s error=%r" % (data.get("hook_event_name"),
                                                     data.get("tool_name"), exc))
        return
    if out:
        print(json.dumps(out))


if __name__ == "__main__":
    main()
