"""Secret scrubbing for unified-memory write paths.

Every write (store / append / update) passes text through scrub() before it
reaches the database. Matches are replaced with [REDACTED:<kind>]; the return
value carries the list of kinds found (unique, in order of first occurrence)
so callers can record what was redacted without ever holding the secret.

Imported by other scripts (hooks, migration tools) — keep this module
dependency-free (stdlib re only) and never print matched values.
"""
import re

SOT_SUFFIX = " — SINGLE SOURCE OF TRUTH"

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)

# URI-style DSNs that carry a password component: scheme://user:pass@...
# (http(s) userinfo included; the password may itself contain '/')
_DSN_RE = re.compile(
    r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|mssql|redis|rediss|amqp|ftp|"
    r"https?|jdbc:[a-z0-9]+)://([^\s:@/\"]+):([^\s@\"]+)@"
)

# name=value / name:value assignments where the name marks a secret
# (names in any case: password, passwd, pwd, api_key, apikey, access_key,
# token, secret, auth, private_key — bare or with a prefix)
_ASSIGN_RE = re.compile(
    r"\b([A-Za-z0-9_.-]*?"
    r"(?:PASSWORD|PASSWD|PWD|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|AUTH|TOKEN|SECRET"
    r"|PRIVATE_KEY))"
    r"(\s*[=:]\s*)(['\"]?)([^\s'\"]+)\3",
    re.IGNORECASE,
)

# trailing punctuation stripped from an assignment value so sentence
# punctuation is never swallowed into (nor preserved by) the redaction
_VALUE_TRAIL = ".,;:!?)]}"

# standalone token shapes (value is the secret itself, never a placeholder)
_TOKEN_RES = [
    ("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("token", re.compile(r"\bghp_[A-Za-z0-9]{30,}")),
    ("token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}")),
    ("token", re.compile(r"\bxox[bp]-[A-Za-z0-9-]{10,}")),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
]

# Live shared pattern set: [(kind, compiled_regex), ...] for standalone token
# shapes. secret-write-guard.py loads this via its external_patterns() so the
# guard and the scrubber stay in lockstep without duplicating the shapes.
SECRET_PATTERNS = list(_TOKEN_RES)

_BEARER_RE = re.compile(r"\b(?i:Bearer)\s+[A-Za-z0-9._~+/=-]{8,}")

_PLACEHOLDER_VALUES = {
    "xxx", "xxxx", "xxxxx", "changeme", "change_me", "change-me", "placeholder",
    "secret", "password", "redacted", "dummy", "example", "sample", "test",
    "your-password", "your_password", "yourpassword", "your-token", "your-api-key",
    "notreal", "insert-password-here", "replace-me", "todo", "none", "null",
}


def _is_placeholder(value: str) -> bool:
    """True for template markers, env references and mask characters — values that
    carry no real secret and must survive scrubbing (config files stay readable)."""
    v = value.strip().strip("'\"").strip()
    if not v:
        return True
    if v.lower() in _PLACEHOLDER_VALUES:
        return True
    # ${VAR}, $(cmd), <placeholder>, %(var)s, {var}, {{var}}, $VAR
    if re.fullmatch(r"\$\{[^}]*\}", v) or re.fullmatch(r"\$\([^)]*\)", v):
        return True
    if re.fullmatch(r"<[^>]*>", v):
        return True
    if re.fullmatch(r"%\([A-Za-z0-9_]+\)s", v):
        return True
    if re.fullmatch(r"\{\{?[A-Za-z0-9_.-]+\}?\}", v):
        return True
    if re.fullmatch(r"\$[A-Za-z_][A-Za-z0-9_]*", v):
        return True
    # pure mask runs: .... or **** or ____
    if re.fullmatch(r"[.*_]{3,}", v):
        return True
    # already redacted by a previous scrub pass — keep idempotent
    if re.fullmatch(r"\[REDACTED:[a-z_]+\]", v, re.IGNORECASE):
        return True
    return False


def scrub(text):
    """Return (clean_text, kinds). Redacts secrets in text; kinds lists each
    redaction kind once, in order of first occurrence."""
    if not isinstance(text, str) or not text:
        return text, []

    kinds = []

    def _hit(kind):
        if kind not in kinds:
            kinds.append(kind)

    out = text

    def _dsn_repl(m):
        _hit("dsn")
        return f"{m.group(1)}:[REDACTED:dsn]@"

    out = _DSN_RE.sub(_dsn_repl, out)

    def _assign_repl(m):
        name, sep, quote, value = m.group(1), m.group(2), m.group(3), m.group(4)
        if _is_placeholder(value):
            return m.group(0)
        core = value.rstrip(_VALUE_TRAIL)
        if not core or _is_placeholder(core):
            return m.group(0)  # e.g. "xxx," — punctuation stays, value survives
        trail = value[len(core):]
        lowered = name.lower()
        if (lowered.endswith("api_key") or lowered.endswith("apikey")
                or lowered.endswith("access_key")):
            kind = "api_key"
        elif lowered.endswith("token") or lowered.endswith("auth"):
            kind = "token"
        elif lowered.endswith("secret") or lowered.endswith("private_key"):
            kind = "secret"
        else:
            kind = "password"
        _hit(kind)
        return f"{name}{sep}{quote}[REDACTED:{kind}]{quote}{trail}"

    out = _ASSIGN_RE.sub(_assign_repl, out)

    def _bearer_repl(m):
        matched = m.group(0)
        prefix, token = matched.split(None, 1)
        if _is_placeholder(token):
            return matched
        _hit("bearer")
        return f"{prefix} [REDACTED:bearer]"

    out = _BEARER_RE.sub(_bearer_repl, out)

    for kind, rx in _TOKEN_RES:
        def _tok_repl(m, kind=kind):
            _hit(kind)
            return f"[REDACTED:{kind}]"
        out = rx.sub(_tok_repl, out)

    def _pem_repl(m):
        _hit("private_key")
        return "[REDACTED:private_key]"

    out = _PEM_RE.sub(_pem_repl, out)

    return out, kinds


def normalize_topic(topic):
    """Strip any trailing (repeated) SOT suffix from a topic name so callers can
    pass either the bare topic or the full stored title."""
    if not isinstance(topic, str):
        return topic
    t = topic.strip()
    while t.endswith(SOT_SUFFIX):
        t = t[: -len(SOT_SUFFIX)].rstrip()
    return t


def sot_title(topic):
    """Canonical stored title for a topic (exactly one suffix)."""
    return f"{normalize_topic(topic)}{SOT_SUFFIX}"
