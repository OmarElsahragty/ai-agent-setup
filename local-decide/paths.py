"""Transcript path allowlist shared by policy.py (D6) and mcp.py (prune_preview).

Hook payloads and MCP arguments carry caller-supplied transcript paths; only JSONL files whose
realpath sits under a known transcript root may be opened (security review 2026-10-02, CRITICAL-1).
Extra roots: LOCAL_DECIDE_TRANSCRIPT_ROOTS (os.pathsep-separated).
"""
import os

_HOME = os.path.expanduser("~")
_ROOT = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ROOTS = (os.path.join(_HOME, ".claude", "projects"), "/var/tmp/claude",
                 os.path.join(_ROOT, "state", "local-decide"))


def _deep_enough(root, min_components=2):
    """A root must be at least /a/b: '/' or '/a' would allowlist too much."""
    parts = [p for p in os.path.normpath(root).split(os.sep) if p]
    return len(parts) >= min_components


def transcript_roots():
    """Allowlisted transcript roots. '/' and single-component roots are ignored
    (a caller-supplied LOCAL_DECIDE_TRANSCRIPT_ROOTS of '/' would otherwise
    turn the allowlist into 'every .jsonl on the machine')."""
    extra = [r for r in os.environ.get("LOCAL_DECIDE_TRANSCRIPT_ROOTS", "").split(os.pathsep) if r]
    return [os.path.realpath(r) for r in (*DEFAULT_ROOTS, *extra) if _deep_enough(r)]


def safe_transcript_path(path):
    """Return the resolved path when it is an allowed .jsonl transcript, else None."""
    if not isinstance(path, str) or not path.strip():
        return None
    resolved = os.path.realpath(os.path.expanduser(path))
    if not resolved.endswith(".jsonl"):
        return None
    for root in transcript_roots():
        try:
            if os.path.commonpath([resolved, root]) == root:
                return resolved
        except ValueError:
            continue
    return None
