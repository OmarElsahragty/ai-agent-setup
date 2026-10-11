#!/usr/bin/env python3
"""PreToolUse hook (Edit|Write|MultiEdit|Bash): deny writing secret LITERALS into non-env files.

Edit/Write/MultiEdit: scans only the NEW content (Write.content, Edit.new_string,
MultiEdit edits[].new_string).
Bash: when the command WRITES to a file (>, >>, tee, sed -i, cp/mv/install, dd of=,
cat <<, python -c with open(...,'w') or Path(...).write_text/write_bytes) and contains a
secret literal, deny — pure reads and $VAR references pass.
Assignments are matched UNanchored on the Bash path (echo 'KEY=literal' > f) in both the
`=` and YAML-style `NAME: value` colon form, and printf "KEY=%s" arguments are paired with
the secret name in the format string. Copying env-file CONTENT (cat/cp/mv/install/< redirect
of an env_target file) into a non-env destination is denied.
Deny kinds: DSN with embedded password, *_API_KEY/TOKEN/SECRET/PASSWORD style assignments
(including BARE names: PASSWORD=/TOKEN=/API_KEY=/SECRET=/PASSWD=) with non-placeholder
values, known token shapes (sk-/ghp_/github_pat_/xox/AKIA), PEM private
key blocks. The value is NEVER echoed back — the reason names the kind and the variable name.
Targets named .env / *.env / .env.* are always allowed (secrets belong there). Placeholders
(YOUR_*, <...>, ${VAR}, {env:VAR}, changeme, xxx, ***) and non-literal values (os.environ,
getenv, process.env, ${...}) pass. Fails open on any internal error. Stdlib only.
Owner ruling Q4 (2026-10-10, M-041): obvious test fixtures pass. In a file under a */tests/*
directory (plural only; a singular */test/* directory does not qualify), a quoted string literal
whose text starts with test-/test_/fake-/fake_/dummy-/dummy_ (case-sensitive) is not a secret, and
neither is an assignment value that starts that way.
A Bash write gets this only when every named non-env target is such a file. Everything else is
unchanged, and there is no override mechanism.
Bash write targets come from scan_shell(): quotes, escapes, comments, data heredoc bodies and
(( )) / [[ ]] comparisons are honoured, so `>` / `>=` inside quoted jq/awk/python code, `2>&1`,
`>&2` and `>(...)` are never file targets (file-lease.py reuses the same parser).
"""
import importlib.util
import json
import os
import re
import shlex
import sys
from pathlib import Path

# Resolved from the file location only, so an env var cannot redirect this guard.
ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT  # this repo holds the agent trees at its own root

SCRUB_PATH = str(AGENTS / "unified-memory" / "scrub.py")

TOKEN_RES = [
    ("OpenAI-style API token (sk-...)", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("GitHub token (ghp_...)", re.compile(r"\bghp_[A-Za-z0-9]{30,}\b")),
    ("GitHub fine-grained token (github_pat_...)", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("Slack token (xox...)", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("AWS access key id (AKIA...)", re.compile(r"\bAKIA[0-9A-Z]{16,}\b")),
]
PEM_RE = re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
DSN_RE = re.compile(
    r"(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|ftp|https?)"
    r"://([^\s:@/\"'<>]+):([^\s@/\"'<>]+)@[^\s\"'<>]+")
# Optional bounded prefix: BARE names (PASSWORD=, TOKEN=, API_KEY=, SECRET=,
# PASSWD=) match too, in every pass. Uppercase-only on purpose: lowercase code
# like `password = getpass()` / `api_key = args.api_key` never matches.
SECRET_NAME = (r"(?:[A-Z][A-Z0-9_]{0,63})?(?:API_KEY|APIKEY|API_TOKEN|ACCESS_TOKEN"
               r"|REFRESH_TOKEN|AUTH_TOKEN|TOKEN|SECRET_KEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)")
SECRET_ASSIGN_RE = re.compile(
    r"(?m)^[ \t]*(?:export[ \t]+)?(" + SECRET_NAME + r")"
    r"[ \t]*(?:=|:[ \t])[ \t]*(.+?)[ \t]*$")
# Bash pass: assignments appear mid-line inside echo/printf strings, so the same
# name/value shape is matched WITHOUT the line anchor there; the colon form
# mirrors the file pass so heredoc/echo YAML writes are caught identically.
SECRET_ASSIGN_BASH_RE = re.compile(
    r"\b(?:export[ \t]+)?(" + SECRET_NAME + r")[ \t]*(?:=|:[ \t])[ \t]*"
    r"(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|[^\s;&|<>'\"]+)")
PLACEHOLDER_RE = re.compile(
    r"^(?:<[^>]*>|\$\{[^}]*\}|\{env:[^}]*\}|\$[A-Za-z_]\w*|yours?[_-].*|change-?me|x+|\*+"
    r"|\.{3,}|…|n/?a|null|none|nil|~|tbd|todo|placeholder|example.*|insert.*|replace.*"
    r"|dummy.*)$", re.I)
NON_LITERAL_RE = re.compile(
    r"os\.environ|getenv|environ\.get|process\.env|import\.meta\.env|SecretStr|settings\."
    r"|config\.|from_env|load_dotenv|getpass|\bargs\.|\$\{|\{env:")
# Q4 (2026-10-10): fixture literals in test files. Single-line '...' / "..." literals with escapes.
FIXTURE_RE = re.compile(r"^(?:test|fake|dummy)[-_]")
QUOTED_LITERAL_RE = re.compile(r"(['\"])((?:\\.|(?!\1)[^\\\n])*)\1")
TEST_DIRS = ("tests",)  # owner ruling Q4: the plural tests/ directory only


def external_patterns():
    """Live shared token shapes from scrub.py SECRET_PATTERNS [(kind, regex), ...].
    Entries arrive pre-compiled; strings are compiled for robustness."""
    try:
        if os.path.isfile(SCRUB_PATH):
            spec = importlib.util.spec_from_file_location("wo_scrub", SCRUB_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            raw = getattr(module, "SECRET_PATTERNS", None)
            if isinstance(raw, list) and raw:
                return [(kind, p if hasattr(p, "search") else re.compile(p))
                        for kind, p in raw]
    except Exception:
        pass
    return []


def env_target(path):
    base = os.path.basename(path or "")
    return base == ".env" or base.endswith(".env") or base.startswith(".env.")


def in_test_dir(path, cwd=""):
    """Q4: True when `path` (relative ones resolved against cwd) sits in a tests/ dir."""
    if not path:
        return False
    full = path if os.path.isabs(path) else os.path.join(cwd or "/", path)
    parts = os.path.normpath("/" + full.lstrip("/")).split("/")[:-1]
    return any(part in TEST_DIRS for part in parts)


def strip_fixture_literals(content):
    """Q4: a quoted literal opening with test-/fake-/dummy- (or _) becomes the word
    "placeholder" (a PLACEHOLDER_RE value with no shell metacharacters, so printf/redirect
    parsing is unchanged), so neither its token shapes nor its DSN text count as secrets."""
    return QUOTED_LITERAL_RE.sub(
        lambda m: m.group(1) + "placeholder" + m.group(1) if FIXTURE_RE.match(m.group(2)) else m.group(0),
        content)


def fixture_value(value, fixtures):
    return bool(fixtures) and bool(FIXTURE_RE.match(value))


def strip_quotes(value):
    value = value.strip().rstrip(";").rstrip(",").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def placeholder(value):
    return not value or bool(PLACEHOLDER_RE.match(value)) or bool(NON_LITERAL_RE.search(value))


def dsn_password_placeholder(pw):
    return pw.startswith("$") or pw.startswith("<") or bool(
        re.match(r"^(yours?[_-]|change-?me|x+|\*+)", pw, re.I))


def _shared_hits(content, extra_patterns):
    """DSN / token-shape / PEM hits — identical for the file and Bash passes."""
    hits = []
    for m in DSN_RE.finditer(content):
        if not dsn_password_placeholder(m.group(2)):
            line = content.count("\n", 0, m.start()) + 1
            hits.append("line %d contains a DSN/URL with an embedded password" % line)
    for kind, rx in list(TOKEN_RES) + list(extra_patterns):
        if rx.search(content):
            hits.append("contains an apparent %s" % kind)
    if PEM_RE.search(content):
        hits.append("contains a PEM private key block")
    return hits


def violations(content, extra_patterns, fixtures=False):
    """Human descriptions of secret literals found in NEW content (file pass,
    line-anchored assignments). fixtures=True: the target is a test file (Q4)."""
    if fixtures:
        content = strip_fixture_literals(content)
    hits = []
    for m in SECRET_ASSIGN_RE.finditer(content):
        value = strip_quotes(m.group(2))
        if not placeholder(value) and not fixture_value(value, fixtures):
            line = content.count("\n", 0, m.start()) + 1
            hits.append("line %d sets a secret assignment (%s) to a literal value"
                        % (line, m.group(1)))
    return hits + _shared_hits(content, extra_patterns)


def bash_violations(command, extra_patterns, fixtures=False):
    """Bash pass variant: assignments matched UNanchored (echo 'KEY=literal' > f)
    plus printf format/argument pairing; values that are format specs or $VAR /
    ${VAR} references stay allowed via the same placeholder() rules.
    fixtures=True: every named target is a test file (Q4)."""
    if fixtures:
        command = strip_fixture_literals(command)
    hits = []
    for m in SECRET_ASSIGN_BASH_RE.finditer(command):
        value = strip_quotes(m.group(2))
        if value[:1] in ("%", "$") or placeholder(value) or fixture_value(value, fixtures):
            continue
        hits.append("sets a secret assignment (%s) to a literal value" % m.group(1))
    for name, value in _printf_secret_args(command):
        if fixture_value(value, fixtures):
            continue
        hits.append("passes a literal value to printf for %s" % name)
    return hits + _shared_hits(command, extra_patterns)


def new_contents(tool_name, tool_input):
    if tool_name == "Write":
        return [tool_input.get("content") or ""]
    if tool_name == "Edit":
        return [tool_input.get("new_string") or ""]
    if tool_name == "MultiEdit":
        return [e.get("new_string") or "" for e in tool_input.get("edits") or []
                if isinstance(e, dict)]
    return []


# ------------------------------------------------------------------ Bash pass
# scan_shell(): quoted spans, escapes, comments, data heredoc bodies and (( )) / [[ ]] are
# neutralised (same length, so match offsets map back to the original command).
_PLAIN_RE = re.compile(r"[^'\"\\#\n<>(\[]+")
_SQ_RE = re.compile(r"'[^']*'?")
_DQ_RE = re.compile(r'"(?:[^"\\]|\\.)*"?', re.S)
_WORD_RE = re.compile(r"(?:[^\s;&|<>()'\"\\]+|'[^']*'|\"(?:[^\"\\]|\\.)*\"|\\.)+", re.S)
_UNQUOTE_RE = re.compile(r"'([^']*)'|\"((?:[^\"\\]|\\.)*)\"|\\(.)", re.S)
_HEREDOC_OP_RE = re.compile(r"<<(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([^\s;&|<>()'\"]+))")
_SHELL_FEED_RE = re.compile(r"(?:^|[\s;&|(])(?:[^\s;&|()<>]*/)?(?:bash|sh|dash|zsh|ksh)"
                            r"(?:\s+-[A-Za-bd-z]+)*\s*$")
_SHELL_PIPE_RE = re.compile(r"^[^|\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:[^\s;&|()<>]*/)?"
                            r"(?:bash|sh|dash|zsh|ksh)\b")
_MASK = str.maketrans({c: "_" for c in "<>|;&"})
_WORD_START = " \t\n;&|()"


def _unquote(word):
    return _UNQUOTE_RE.sub(lambda m: m.group(1) if m.group(1) is not None else (
        re.sub(r"\\(.)", r"\1", m.group(2)) if m.group(2) is not None else m.group(3)), word)


def _skip_heredoc_bodies(command, i, pending, pieces):
    """Consume the bodies of `pending` heredocs starting at i; data bodies are blanked.
    A body fed to a shell (bash <<EOF, cat <<EOF | sh) stays: the scan reads it as script."""
    n = len(command)
    for strip_tabs, delim, script in pending:
        if script:
            return i
        start = i
        while i < n:
            eol = command.find("\n", i)
            eol = n if eol < 0 else eol
            line = command[i:eol]
            i = min(eol + 1, n)
            if (line.lstrip("\t") if strip_tabs else line).strip() == delim:
                break
        pieces.append(re.sub(r"[^\n]", " ", command[start:i]).replace("\n", ";"))
    return i


def scan_shell(command):
    """(masked, redirects) for a Bash command (static, nothing executed).

    masked: same length as command; metacharacters inside quotes / escapes and (( )) / [[ ]]
    comparisons become `_`, comments and data heredoc bodies become blanks and unquoted newlines
    become `;`, so the write-target regexes only see real shell syntax.
    redirects: [(append, target)] for > >> >| &> &>> N> N>> file redirections; `>=`, `>&N`,
    `N>&M`, `>&-`, `>(...)` and `<>` are not file targets."""
    pieces, redirects, pending = [], [], []
    i, n, line_start = 0, len(command), 0
    while i < n:
        m = _PLAIN_RE.match(command, i)
        if m:
            pieces.append(m.group())
            i = m.end()
            continue
        c = command[i]
        if c in "'\"":
            m = (_SQ_RE if c == "'" else _DQ_RE).match(command, i)
            pieces.append(m.group().translate(_MASK))
            i = m.end()
            continue
        if c == "\\":
            pair = command[i:i + 2]
            pieces.append(" ;" if pair == "\\;" else pair[:1] + pair[1:].translate(_MASK))
            i += len(pair)
            continue
        if c == "\n":
            pieces.append(";")
            i += 1
            if pending:
                i = _skip_heredoc_bodies(command, i, pending, pieces)
                pending = []
            line_start = i
            continue
        if c == "#":
            if i == 0 or command[i - 1] in _WORD_START:
                j = command.find("\n", i)
                j = n if j < 0 else j
                pieces.append(" " * (j - i))
                i = j
            else:
                pieces.append(c)
                i += 1
            continue
        if (c == "(" and command.startswith("((", i)) or (
                c == "[" and command.startswith("[[", i) and (i == 0 or command[i - 1] in _WORD_START)):
            j = command.find("))" if c == "(" else "]]", i + 2)
            j = n if j < 0 else j + 2
            pieces.append(command[i:j].replace("<", "_").replace(">", "_"))
            i = j
            continue
        if c == "<":
            if command.startswith("<<<", i):
                step = 3
            elif command.startswith("<<", i):
                m = _HEREDOC_OP_RE.match(command, i)
                if m:
                    delim = next(g for g in (m.group(2), m.group(3), m.group(4)) if g is not None)
                    eol = command.find("\n", m.end())
                    after = command[m.end():n if eol < 0 else eol]
                    script = bool(_SHELL_FEED_RE.search(command[line_start:i])
                                  or _SHELL_PIPE_RE.match(after))
                    pending.append((m.group(1) == "-", delim, script))
                    pieces.append(m.group())
                    i = m.end()
                    continue
                step = 2
            elif command.startswith("<>", i):
                step = 2
            else:
                step = 1
            pieces.append(command[i:i + step])
            i += step
            continue
        if c == ">":
            j = i + 1
            append = command.startswith(">", j)
            if j < n and command[j] in ">|":
                j += 1
            if command[j:j + 1] in ("&", "=", "("):
                pieces.append(command[i:j + 1])
                i = j + 1
                continue
            k = j
            while k < n and command[k] in " \t":
                k += 1
            m = _WORD_RE.match(command, k)
            end = m.end() if m else k
            if m:
                redirects.append((append, _unquote(m.group())))
            pieces.append(command[i:k] + command[k:end].translate(_MASK))
            i = end
            continue
        pieces.append(c)
        i += 1
    return "".join(pieces), redirects


def _span(command, m, group=1):
    """The ORIGINAL text of a regex group matched on scan_shell()'s masked string."""
    return command[m.start(group):m.end(group)]


LEGACY_REDIRECT_RE = re.compile(r"(?:^|[\s;|&])(?:\d*)>{1,2}\s*([^\s;|&<>]+)")
NESTED_SCRIPT_RE = re.compile(
    r"(?:(?:^|[\s;&|(])(?:[^\s;&|()<>'\"]*/)?(?:bash|sh|dash|zsh|ksh|ash)(?:[ \t]+[-+][A-Za-z]+)*"
    r"[ \t]+-[A-Za-z]*c[A-Za-z]*|(?:^|[\s;&|(])(?:su|runuser|flock|script)\b[^;&|\n]*?[ \t]"
    r"(?:-[A-Za-z]*c|--command)|(?:^|[\s;&|(])eval)(?:[ \t]+|=)(?=['\"])")
CHDIR_RE = re.compile(r"(?:^|[\s;&|(){}'\"`])(cd|pushd|popd)(?=$|[\s;&|)}'\"`])")
TEE_RE = re.compile(r"(?:^|[\s;|&])tee\s+([^;|&<>]+)")
SED_RE = re.compile(r"(?:^|[\s;|&])sed\s+([^;|&]+)")
CP_RE = re.compile(r"(?:^|[\s;|&])cp\s+([^;|&<>]+)")
CAT_RE = re.compile(r"(?:^|[\s;|&])cat\s+([^;|&<>]*)")
HEREDOC_RE = re.compile(r"<<-?\s*\S+")
PY_OPEN_WRITE_RE = re.compile(r"\bopen\s*\(\s*(['\"])([^'\"]+)\1\s*,\s*['\"][wa+]")
STDIN_REDIR_RE = re.compile(r"(?:^|[\s;|&])(?:\d*)<(?![<=>])\s*([^\s;|&<>]+)")
PRINTF_RE = re.compile(r"(?:^|[\s;|&])printf\s+([^;|&<>]+)")
SECRET_NAME_EQ_RE = re.compile(r"\b(" + SECRET_NAME + r")[ \t]*=")
SHELL_TOKEN_RE = re.compile(r"\"[^\"]*\"|'[^']*'|\S+")
MV_RE = re.compile(r"(?:^|[\s;|&])mv\s+([^;|&<>]+)")
INSTALL_RE = re.compile(r"(?:^|[\s;|&])install\s+([^;|&<>]+)")
DD_RE = re.compile(r"(?:^|[\s;|&])dd\s+([^;|&<>]+)")
DD_OF_RE = re.compile(r"(?:^|\s)of=([^\s;|&<>]+)")
PY_PATH_WRITE_RE = re.compile(
    r"\bPath\s*\(\s*(['\"])([^'\"]{1,255})\1\s*\)\s*\.write_(?:text|bytes)\s*\(")


def _bash_writable_target(token):
    """False for fd dups (&1), process substitution and /dev/* sinks."""
    return not (token.startswith("&") or token.startswith("(") or token.startswith("/dev/"))


def _tool_targets(command, text):
    """tee / sed -i / cp / mv / install / dd of= destinations; `text` is the command itself or
    its scan_shell() mask (same offsets), operands are always sliced from the original."""
    targets = []
    for m in TEE_RE.finditer(text):
        for tok in _span(command, m).split():
            tok = tok.strip("'\"")
            if not tok.startswith("-") and _bash_writable_target(tok):
                targets.append(tok)
    for m in SED_RE.finditer(text):
        args = _span(command, m).split()
        in_place = any(a.startswith("-i") for a in args)
        if not in_place:
            continue
        non_opts = [a.strip("'\"") for a in args if not a.startswith("-")]
        targets.extend(non_opts[1:])  # first non-option token is the sed script
    # cp/mv/install: the last non-option operand is the destination
    for rx in (CP_RE, MV_RE, INSTALL_RE):
        for m in rx.finditer(text):
            toks = [t.strip("'\"") for t in _span(command, m).split() if not t.startswith("-")]
            if len(toks) > 1 and _bash_writable_target(toks[-1]):
                targets.append(toks[-1])
    for m in DD_RE.finditer(text):
        of_m = DD_OF_RE.search(_span(command, m))
        if of_m:
            tok = of_m.group(1).strip("'\"")
            if _bash_writable_target(tok):
                targets.append(tok)
    return targets


def _nested_scripts(command, masked):
    """Unquoted bodies of quoted scripts run by a shell -c / eval / su|runuser|flock|script -c."""
    bodies = []
    for m in NESTED_SCRIPT_RE.finditer(masked):
        q = (_SQ_RE if command[m.end()] == "'" else _DQ_RE).match(command, m.end())
        if q:
            bodies.append(_unquote(q.group()))
    return bodies


def bash_write_targets(command, quoted=True, _depth=0):
    """(writes, targets) for a Bash command.

    writes: the command materializes bytes into SOME file (redirect, tee,
    sed -i, cp/mv/install, dd of=, heredoc, python open(...,'w') or
    Path(...).write_text/write_bytes). targets: the written file paths we
    can extract — an empty list with writes=True means a heredoc whose sink we
    could not name (denied unless a secret literal is absent anyway).
    Targets come from scan_shell() plus the scripts of `sh -c '...'` / `eval '...'` style
    wrappers. quoted=True (this guard) also keeps every legacy unquoted-regex match, so `>` text
    inside quotes still counts as a write here (over-inclusive on purpose: nothing written by
    the previous parser is missed); file-lease.py passes quoted=False for exact targets.

    Seatbelt stance (documented gaps, intentional): base64-encoded literals
    (this guard never decodes base64) and $VAR/${VAR} indirection such as
    `echo "$PW" > f` stay ACCEPTED — the guard stops plain-literal writes and
    env-file-content copies, not every indirection channel.
    """
    masked, redirects = scan_shell(command)
    targets = [tok for _append, tok in redirects if tok and _bash_writable_target(tok)]
    targets += _tool_targets(command, masked)
    for m in PY_OPEN_WRITE_RE.finditer(command):
        targets.append(m.group(2))
    for m in PY_PATH_WRITE_RE.finditer(command):
        targets.append(m.group(2))
    if _depth < 3:
        for body in _nested_scripts(command, masked):
            targets += bash_write_targets(body, quoted, _depth + 1)[1]
    if quoted:
        legacy = [m.group(1).strip("'\"") for m in LEGACY_REDIRECT_RE.finditer(command)]
        targets += [t for t in legacy if _bash_writable_target(t)] + _tool_targets(command, command)
    targets = list(dict.fromkeys(targets))
    writes = bool(targets) or bool(HEREDOC_RE.search(command))
    return writes, targets


def _printf_secret_args(command):
    """(name, literal) pairs for printf FORMAT strings that assign a secret name
    (NAME=%s): a following argument supplies the value. $VAR / ${VAR} / placeholder
    arguments pass."""
    out = []
    for m in PRINTF_RE.finditer(command):
        toks = SHELL_TOKEN_RE.findall(m.group(1))
        if len(toks) < 2:
            continue
        name_m = SECRET_NAME_EQ_RE.search(toks[0])
        if not name_m:
            continue
        for tok in toks[1:]:
            tok = strip_quotes(tok)
            if tok.startswith("-"):
                continue  # printf flags
            if not placeholder(tok) and tok[:1] not in ("%", "$"):
                out.append((name_m.group(1), tok))
                break
    return out


def env_read_sources(command):
    """Env-classified files this command READS: cat operands, cp/mv/install
    sources and < stdin redirects. env_target() stays the single source of
    env-ness."""
    srcs = []
    for m in CAT_RE.finditer(command):
        for tok in m.group(1).split():
            tok = tok.strip("'\"")
            if not tok.startswith("-") and env_target(tok):
                srcs.append(tok)
    for rx in (CP_RE, MV_RE, INSTALL_RE):
        for m in rx.finditer(command):
            toks = [t.strip("'\"") for t in m.group(1).split() if not t.startswith("-")]
            srcs.extend(t for t in toks[:-1] if env_target(t))
    for m in STDIN_REDIR_RE.finditer(command):
        tok = m.group(1).strip("'\"")
        if env_target(tok):
            srcs.append(tok)
    return srcs


def bash_cwds(command, cwd=""):
    """Q4: every directory a relative Bash target may resolve against: the payload cwd plus each
    cd / pushd / popd destination in order (quoted mentions count too: conservative). None when
    a destination is not static ($VAR, ~, -, bare cd/pushd, +N, unbalanced quoting)."""
    cur = cwd or "/"
    seen, stack, masked = [cur], [], scan_shell(command)[0]
    for m in CHDIR_RE.finditer(masked):
        end = m.end()
        while end < len(masked) and masked[end] not in ";&|)}":
            end += 1
        try:
            args = shlex.split(command[m.end():end])
        except ValueError:
            return None
        opers, done = [], False
        for a in args:
            if not done and a == "--":
                done = True
            elif done or not re.match(r"^-[LPe@n]+$", a):
                opers.append(a)
        if m.group(1) == "popd":
            if opers or not stack:
                return None
            cur = stack.pop()
            continue
        if not opers or re.search(r"[$`~*?\[]|^-|^\+", opers[0]):
            return None
        if m.group(1) == "pushd":
            stack.append(cur)
        cur = os.path.normpath(os.path.join(cur, opers[0]))
        seen.append(cur)
    return seen


def fixture_targets(command, targets, cwd=""):
    """Q4 for Bash: True only when every named non-env target is provably inside a tests/ dir,
    for every directory the command may cd/pushd/popd into; $VAR, ~ and glob targets never are."""
    named = [t for t in targets if not env_target(t)]
    if not named:
        return False
    cwds = None
    for t in named:
        if re.search(r"[$`*?\[]|^~", t):
            return False
        if os.path.isabs(t):
            if not in_test_dir(t):
                return False
            continue
        cwds = cwds if cwds is not None else bash_cwds(command, cwd)
        if cwds is None or not all(in_test_dir(t, c) for c in cwds):
            return False
    return True


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return  # non-dict JSON (list/string/number): fail open
    if data.get("tool_name") not in ("Edit", "Write", "MultiEdit", "Bash"):
        return
    tool_input = data.get("tool_input") or {}
    if data.get("tool_name") == "Bash":
        _check_bash(tool_input, str(data.get("cwd") or ""))
        return
    target = tool_input.get("file_path") or ""
    if env_target(target):
        return
    try:
        fixtures = in_test_dir(target)
        hits = []
        for content in new_contents(data.get("tool_name"), tool_input):
            hits.extend(violations(content, external_patterns(), fixtures))
    except Exception:
        return  # fail open: a guard bug must never block the edit
    if not hits:
        return
    deny("secret-write-guard: BLOCKED writing a secret literal into %s (%s). Secrets live in "
         ".env only (referenced by name, never committed); tracked files keep placeholders. "
         "The value is intentionally not echoed." % (target or "<unnamed target>", "; ".join(hits[:3])))


def _check_bash(tool_input, cwd=""):
    """Bash pass: deny secret literals (and .env content copies) in commands that
    WRITE to a non-env file."""
    try:
        command = str(tool_input.get("command") or "")
        writes, targets = bash_write_targets(command)
        if not writes:
            return
        if targets and all(env_target(t) for t in targets):
            return  # every named sink is an env file — secrets belong there
        env_srcs = sorted(set(env_read_sources(command)))
        if targets and env_srcs:
            non_env = [t for t in targets if not env_target(t)]
            deny("secret-write-guard: BLOCKED copying env-file content (%s) into non-env "
                 "file(s) (%s). Secrets live in .env only and never move into tracked "
                 "files; copy to an env-named target instead."
                 % (", ".join(env_srcs), ", ".join(non_env)))
            return
        fixtures = fixture_targets(command, targets, cwd)
        hits = list(bash_violations(command, external_patterns(), fixtures))
        if hits:
            deny("secret-write-guard: BLOCKED writing a secret literal via Bash into %s "
                 "(%s). Secrets live in .env only (referenced by name, never committed). "
                 "The value is intentionally not echoed."
                 % (", ".join(targets) if targets else "<heredoc/stdout sink>",
                    "; ".join(hits[:3])))
    except Exception:
        return  # fail open: a guard bug must never block the command


if __name__ == "__main__":
    main()
