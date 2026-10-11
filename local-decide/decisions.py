"""Append-only JSONL decision log for the local-decide policy layer.

One line per decision, schema per INTERFACES.md:
    {ts, agent, event, decision_id, head, label, conf, margin, mode, action,
     latency_ms, text_sha1, text_head}

Hard rules (a log write must never break a tool call):
  * `log()` never raises — every failure path returns False.
  * `text_head` (<= 200 chars) is redacted with the D7 secret patterns before
    it ever touches disk, so no credential can land in the JSONL.
  * Only `sha1` of the full text is stored, never the full text.
  * Writes are serialised with an flock on the file itself plus a process
    thread lock; rotation is driven by rules/retention.yaml.
"""
import fcntl
import hashlib
import json
import os
import re
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
RETENTION_YAML = os.path.join(_HERE, "rules", "retention.yaml")

DEFAULT_RETENTION = {
    "path": os.path.join(
        os.environ.get("AI_SETUP_ROOT") or os.path.dirname(_HERE),
        "state", "local-decide", "decisions.jsonl"),
    "text_head_chars": 200,
    "max_bytes": 33554432,
    "keep_last_lines": 200000,
    "max_rotations": 2,
    "min_interval_s": 0.0,
}

# --- secret patterns (shared with policy.py D7) -----------------------------
# Order matters: the PEM block must be redacted before the generic api-key rule.
SECRET_PATTERNS = (
    ("private_key", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"
                    r"[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
    ("aws_access_key", r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"),
    ("openai_key", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}"),
    ("anthropic_key", r"\bsk-ant-[A-Za-z0-9_-]{16,}"),
    ("github_token", r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    ("github_pat", r"\bgithub_pat_[A-Za-z0-9_]{22,}"),
    ("huggingface_token", r"\bhf_[A-Za-z0-9]{30,}"),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ("url_credentials", r"\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@'\"]{1,64}:[^\s@/'\"]{6,}@[^\s'\"]+"),
    ("gitlab_token", r"\bglpat-[A-Za-z0-9_-]{16,}"),
    ("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("google_api_key", r"\bAIza[0-9A-Za-z_-]{30,}"),
    ("stripe_key", r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}"),
    ("api_key_assignment", r"""(?i:api[_-]?key)\s*[:=]\s*["'][^"']{16,}["']"""),
    ("password_assignment", r"""(?i:password|passwd|secret|token)\s*[:=]\s*["'][^"']{12,}["']"""),
)
COMPILED_SECRETS = tuple((name, re.compile(pat)) for name, pat in SECRET_PATTERNS)
REDACTION = "[REDACTED]"

# --- structural secret forms (shell/HTTP shaped) -----------------------------
# Redacted in text_head so `PASSWORD=hunter2`, `--password hunter2` and
# `Authorization: Bearer x` never land in the JSONL. Group 1 (the key, flag or
# header prefix) is kept for readability; only the value becomes <redacted>.
_VALUE_REDACTION = "<redacted>"
STRUCTURAL_SECRET_PATTERNS = (
    # KEY=value (PASSWORD, PASSWD, SECRET, TOKEN, API_KEY, *_KEY), quoted or not
    ("kv_assignment",
     r"(?i)\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|KEY)[A-Za-z0-9_]*\s*=\s*)"
     r"(?:\"[^\"]*\"|'[^']*'|[^\s'\"&|;<>]+)"),
    # --password value / --password=value (long flags only: `-p 5432` stays)
    ("cli_flag",
     r"(?i)(?<![\w.-])(--(?:password|passwd|secret|token|api[_-]key)(?:\s*=\s*|\s+))"
     r"(?:\"[^\"]*\"|'[^']*'|[^\s'\"&|;<>]+)"),
    # Authorization: Bearer/basic/token <credential>
    ("auth_header",
     r"(?i)\b((?:authorization\s*:\s*)(?:bearer|basic|token|api[_-]key)\s+)[^\s'\"&,]+"),
)
COMPILED_STRUCTURAL = tuple((name, re.compile(pat)) for name, pat in STRUCTURAL_SECRET_PATTERNS)

_lock = threading.Lock()
_cfg_cache = None


def secret_hits(text):
    """[(name, match)] for every secret pattern firing in `text`."""
    if not text:
        return []
    out = []
    for name, rx in COMPILED_SECRETS:
        for m in rx.finditer(text):
            out.append((name, m))
    return out


def redact(text, limit=None):
    """Replace every secret match with REDACTION. Never raises.

    SECRET_PATTERNS matches are replaced wholesale; the structural shell/HTTP
    forms keep their key/flag/header prefix and redact only the value.
    """
    try:
        if not text:
            return ""
        for _name, rx in COMPILED_SECRETS:
            text = rx.sub(REDACTION, text)
        for _name, rx in COMPILED_STRUCTURAL:
            text = rx.sub(lambda m: (m.group(1) or "") + _VALUE_REDACTION, text)
        if limit is not None and len(text) > limit:
            text = text[:limit]
        return text
    except Exception:
        return ""


def retention_config(path=None):
    """rules/retention.yaml merged over the defaults. Never raises."""
    global _cfg_cache
    try:
        if _cfg_cache is None:
            cfg = dict(DEFAULT_RETENTION)
            env_path = os.environ.get("LOCAL_DECIDE_LOG")
            if env_path:
                cfg["path"] = env_path
            try:
                import yaml  # noqa: WPS433 - optional dependency
                with open(RETENTION_YAML, "r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh) or {}
                section = data.get("retention") if isinstance(data, dict) else None
                if isinstance(section, dict):
                    for key, val in section.items():
                        if key in DEFAULT_RETENTION and val is not None:
                            cfg[key] = val
            except Exception:
                pass  # defaults stand
            if os.environ.get("LOCAL_DECIDE_LOG"):
                cfg["path"] = os.environ["LOCAL_DECIDE_LOG"]
            _cfg_cache = cfg
        out = dict(_cfg_cache)
        if path:
            out["path"] = path
        return out
    except Exception:
        return dict(DEFAULT_RETENTION)


def _rotate(path, cfg):
    """Trim the log to keep_last_lines. Called with the file lock held."""
    try:
        keep = int(cfg.get("keep_last_lines") or 0)
        if keep <= 0:
            return
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
        if len(lines) <= keep:
            return
        tail = lines[-keep:]
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(tail)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _prune_rotations(path, cfg)
    except Exception:
        pass


def _prune_rotations(path, cfg):
    try:
        keep = max(0, int(cfg.get("max_rotations") or 0))
        if keep <= 0:
            return
        base, ext = path, ""
        while True:
            cand = base + ".1" + ext if ext else base + ".1"
            if os.path.exists(cand):
                base, ext = cand, ".1"
            else:
                break
        # base is now the newest rotation slot; walk back and drop the oldest.
        while True:
            prev = base + ".1"
            if not os.path.exists(prev):
                break
            base = prev
        idx = 0
        while True:
            cand = "%s.%d" % (path, idx)
            if not os.path.exists(cand):
                break
            idx += 1
        for i in range(idx - keep, idx):
            if i < 0:
                continue
            try:
                os.remove("%s.%d" % (path, i))
            except OSError:
                pass
    except Exception:
        pass


def log(agent="", event="", decision_id="", head="", label=None, conf=0.0,
        margin=0.0, mode="log", action="none", latency_ms=0.0, text="",
        path=None, reason=None):
    """Append one decision line. Never raises; returns True on success."""
    try:
        cfg = retention_config(path)
        target = cfg["path"]
        head_chars = int(cfg.get("text_head_chars") or 200)
        raw = text if isinstance(text, str) else ""
        digest = hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest() if raw else ""
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "agent": str(agent)[:16],
            "event": str(event)[:32],
            "decision_id": str(decision_id)[:8],
            "head": str(head)[:48],
            "label": (str(label)[:48] if label else None),
            "conf": round(float(conf or 0.0), 4),
            "margin": round(float(margin or 0.0), 4),
            "mode": str(mode)[:8],
            "action": str(action)[:12],
            "latency_ms": round(float(latency_ms or 0.0), 2),
            "text_sha1": digest,
            "text_head": redact(raw, limit=head_chars),
        }
        if reason:
            # Why a model head did or did not fire (selected / below_threshold / below_margin /
            # negation / timeout / no_result ...): makes "why didn't D1 inject" one query.
            record["reason"] = str(reason)[:24]
        line = json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
        directory = os.path.dirname(target)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory, exist_ok=True)
        with _lock:
            flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
            fd = os.open(target, flags, 0o600)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                except (OSError, AttributeError):
                    pass
                try:
                    if (int(cfg.get("max_bytes") or 0)
                            and os.path.getsize(target) >= int(cfg["max_bytes"])):
                        _rotate(target, cfg)
                    os.write(fd, line.encode("utf-8"))
                finally:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    except (OSError, AttributeError):
                        pass
            finally:
                os.close(fd)
        return True
    except Exception:
        return False


def log_error(agent="", event="", exc=None):
    """Internal-error breadcrumb. Goes to stderr, never to the JSONL payload
    bodies (which must stay free of exception text that may echo user data)."""
    try:
        sys_err = "%s policy internal error: %s: %s" % (
            time.strftime("%F %T"), event, type(exc).__name__ if exc else "unknown")
        os.write(2, (sys_err + "\n").encode("utf-8"))
    except Exception:
        pass
    return False