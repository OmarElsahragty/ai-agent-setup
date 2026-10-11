#!/usr/bin/env python3
"""PermissionRequest hook: auto-approve `rm` only inside agent scratch space.

Owner ruling 2026-09-28 17:02: subagents stall on Claude Code's critical-path
"dangerous rm on possibly-empty variable" prompt. This hook answers that
prompt with "allow" ONLY when every rm target, after substituting the
command's own literal assignments (VAR=/literal, for v in a b c), resolves
under /var/tmp/claude/ and outside the protected trees below. Anything it
cannot prove safe gets no decision, so the normal prompt still appears.
"""
import itertools
import json
import os
import re
import shlex
import sys
import time

ROOT = "/var/tmp/claude/"
# Never auto-approve inside these trees (study sources / session state).
PROTECTED = ("/var/tmp/claude/eqstudy", "/var/tmp/claude/claude-0", "/var/tmp/claude/hooks")
# Session scratchpads under claude-0 are allowed (below .../scratchpad/<name>).
SCRATCHPAD_RE = re.compile(r"^/var/tmp/claude/claude-0/[^/]+/[^/]+/scratchpad/[^/]+")
LOG = "/var/tmp/claude/hooks/allow-scratch-rm.log"
MAX_EXPANSIONS = 256

ASSIGN_RE = re.compile(r"^(?:export\s+|local\s+|readonly\s+)?([A-Za-z_]\w*)=(\S*)$")
FOR_RE = re.compile(r"^for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*;?\s*(?:do\b.*)?$")
VAR_RE = re.compile(r"\$\{([A-Za-z_]\w*)(?::\?[^}]*)?\}|\$([A-Za-z_]\w*)")
REDIRECT_RE = re.compile(r"^\d*[<>]")


def segments(command):
    """Split into simple-command segments (heredoc bodies are included; any
    rm-looking text there must also prove safe, which only adds prompts)."""
    for line in command.splitlines():
        # `&` inside a redirection (2>&1, &>f) is not a command separator.
        for part in re.split(r"&&|\|\||[;|]|(?<![<>])&(?!>)", line):
            part = part.strip()
            if part.startswith("do "):
                part = part[3:].strip()
            if part.startswith("then "):
                part = part[5:].strip()
            if part:
                yield part


def expand(word, env):
    """Return every literal expansion of word, or None if not provable."""
    bare = VAR_RE.sub("", word)  # ${VAR} / ${VAR:?msg} are plain variables
    if any(c in bare for c in "`~{}") or "$(" in bare or "<(" in bare:
        return None
    names = [a or b for a, b in VAR_RE.findall(word)]
    if not names:
        return None if "$" in word else [word]
    choices = []
    for name in names:
        vals = env.get(name)
        if not vals:
            return None
        choices.append(sorted(vals))
    out = []
    for combo in itertools.product(*choices):
        it = iter(combo)
        s = VAR_RE.sub(lambda _m: next(it), word)
        if "$" in s:
            return None
        out.append(s)
        if len(out) > MAX_EXPANSIONS:
            return None
    return out


GLOB_RE = re.compile(r"[*?\[\]]")
# Anything besides a direct `rm`/`rmdir` segment that can delete files.
DELETE_WORD_RE = re.compile(r"(?<![\w.-])rm(dir)?(?![\w.-])")  # counts /bin/rm too
OTHER_DELETE_RE = re.compile(r"rmtree|unlink|shred|removedirs|os\.remove|-delete\b|truncate")


def _in_scratch(p):
    if not p.startswith(ROOT):
        return False
    first = p[len(ROOT):].split("/", 1)[0]
    if not re.match(r"^[\w.-]+$", first):
        return False
    if any(p == t or p.startswith(t + "/") for t in PROTECTED) and not SCRATCHPAD_RE.match(p):
        return False
    return True


def safe_path(path):
    """Decide from the path text plus the resolved parent/leaf only, never from
    what a glob currently matches (the command may create files first)."""
    if not path.startswith("/") or path.endswith("/") or any(c in path for c in "{}\x00"):
        return False
    parts = path.split("/")[1:]
    if any(x in ("", ".", "..") for x in parts):
        return False
    dirpart, last = "/" + "/".join(parts[:-1]), parts[-1]
    if GLOB_RE.search(dirpart):
        return False  # a wildcard may only pick direct children of a literal dir
    real_dir = os.path.realpath(dirpart)
    cands = [path, os.path.join(real_dir, last)]
    if GLOB_RE.search(last):
        cands += [real_dir + "/x"]
    else:
        cands.append(os.path.realpath(path))  # a symlinked leaf must point into scratch too
    return all(_in_scratch(c) for c in cands)


# Constructs that can change a variable after a literal assignment.
MUTATION_RE = re.compile(r"[A-Za-z_]\w*(\[[^]]*\])?\+=|\b(read|mapfile|readarray|declare|typeset|unset|eval|source|IFS=)\b|printf\s+-v|^\s*\.\s", re.M)
# Allowlist, not denylist (review 2026-09-28): every segment must start with one of
# these literal heads, so an interpreter, xargs, find, git, mv, ln or a computed
# command word can never ride along with a safe rm.
SAFE_HEADS = {"rm", "rmdir", "mkdir", "cd", "pwd", "echo", "true", "false", ":", "test", "[",
              "set", "ls", "du", "touch", "done", "fi", "if", "else", "then", "do"}
LITERAL_HEAD_RE = re.compile(r"[A-Za-z0-9_./:\[-]+")
REDIR_TOK_RE = re.compile(r"^(\d*|&)(>>?|<)(.*)$")


def split_redirects(toks, env):
    """Drop redirections from toks; return (words, ok). Output targets must be
    /dev/null, an fd dup, or a provably safe scratch path."""
    words, i = [], 0
    while i < len(toks):
        m = REDIR_TOK_RE.match(toks[i])
        if not m:
            words.append(toks[i])
            i += 1
            continue
        target = m.group(3)
        if not target:
            if i + 1 >= len(toks):
                return words, False
            target = toks[i + 1]
            i += 1
        i += 1
        if m.group(2) == "<" or target.startswith("&") or target == "/dev/null":
            continue
        vals = expand(target, env)
        if not vals or not all(safe_path(v) for v in vals):
            return words, False
    return words, True


def check_rm(words, env):
    targets = [t for t in words[1:] if not t.startswith("-")]
    if not targets:
        return "rm without targets"
    for t in targets:
        vals = expand(t, env)
        if not vals:
            return "unresolved target " + t
        for v in vals:
            if not safe_path(v):
                return "outside scratch: " + v
    return None


def decide(command):
    if "\x00" in command:
        return False, "NUL byte"
    if "`" in command or re.search(r"[$<>]\(", command):
        return False, "command/process substitution present"
    if MUTATION_RE.search(command):
        return False, "variable mutation construct present"
    if OTHER_DELETE_RE.search(command):
        return False, "non-rm delete construct present"
    env = {}
    direct_rm = 0
    for seg in segments(command):
        m = FOR_RE.match(seg)
        if m:
            words = m.group(2).split(";")[0].split()
            if any("$" in w or any(c in w for c in "*?[`(") for w in words):
                env[m.group(1)] = None
            else:
                env[m.group(1)] = set(words)
            continue
        m = ASSIGN_RE.match(seg)
        if m:
            name, raw = m.groups()
            try:
                val = shlex.split(raw)[0] if raw else ""
            except ValueError:
                env[name] = None
                continue
            vals = expand(val, env) if val else None
            if vals is None:
                env[name] = None
            else:
                env[name] = (env.get(name) or set()) | set(vals)
            continue
        try:
            toks = shlex.split(seg, comments=True)
        except ValueError:
            return False, "unparsable segment: " + seg[:80]
        words, ok = split_redirects(toks, env)
        if not ok:
            return False, "redirect outside scratch: " + seg[:80]
        while words and words[0] in ("then", "do", "else", "{", "("):
            words = words[1:]
        if not words:
            continue
        head = words[0]
        if not LITERAL_HEAD_RE.fullmatch(head) or os.path.basename(head) not in SAFE_HEADS:
            return False, "segment head not allowlisted: " + head[:40]
        if head != os.path.basename(head) and head not in ("/bin/rm", "/usr/bin/rm"):
            return False, "unexpected command path: " + head[:40]
        if os.path.basename(head) in ("rm", "rmdir"):
            direct_rm += 1
            why = check_rm(words, env)
            if why:
                return False, why
    if direct_rm and len(DELETE_WORD_RE.findall(command)) != direct_rm:
        return False, "rm outside a direct rm segment"
    return direct_rm > 0, "all rm targets under scratch" if direct_rm else "no rm"


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return  # non-dict JSON (list/string/number): fail open
    if data.get("tool_name") != "Bash":
        return
    command = (data.get("tool_input") or {}).get("command") or ""
    try:
        ok, why = decide(command)
    except (ValueError, OSError) as exc:  # fail closed: no decision, normal prompt
        ok, why = False, "error: %s" % exc
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%s %s %s | %s\n" % (time.strftime("%F %T %Z"), "ALLOW" if ok else "PASS",
                                          why, command.replace("\n", " \\n ")[:300]))
    except OSError:
        pass
    if ok:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                 "decision": {"behavior": "allow"}}}))


if __name__ == "__main__":
    main()
