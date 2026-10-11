"""stdlib-only HTTP client for the local-decide daemon.

No third-party imports on purpose: this module is loaded from Claude Code /
OpenCode / agy hook contexts (which run before any project venv exists) and must
stay dependency-free.

Fail-open rule: every function returns ``None`` (or ``[]`` for list-returning
endpoints) when the daemon is unreachable.  A hook that cannot reach the daemon
must never break the calling agent.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

DEFAULT_URL = "http://127.0.0.1:11438"
DEFAULT_TIMEOUT = 3.0


LOOPBACK_PREFIXES = ("http://127.0.0.1", "http://localhost", "http://[::1]")


def base_url() -> str:
    """Loopback only: hook payloads carry prompts and tool inputs, never send them off-box."""
    url = os.environ.get("LOCAL_DECIDE_URL", DEFAULT_URL).rstrip("/")
    return url if url.startswith(LOOPBACK_PREFIXES) else DEFAULT_URL


def _post(path: str, body: Any, timeout: float) -> Optional[Any]:
    url = f"{base_url()}{path}"
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except (urllib.error.URLError, OSError, ValueError):
        return None
    try:
        return json.loads(payload or b"null")
    except ValueError:
        return None


def _get(path: str, timeout: float) -> Optional[Any]:
    url = f"{base_url()}{path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = response.read()
    except (urllib.error.URLError, OSError, ValueError):
        return None
    try:
        return json.loads(payload or b"null")
    except ValueError:
        return None


def decide(text: str, heads: "dict[str, Any]", long: bool = False,
           timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
    return _post("/v1/decide",
                 {"text": text, "heads": heads, "long": bool(long)}, timeout)


def multi(texts: "list[str]", heads: "dict[str, Any]", long: bool = False,
          timeout: float = DEFAULT_TIMEOUT) -> Optional[list]:
    return _post("/v1/multi",
                 {"texts": list(texts), "heads": heads, "long": bool(long)},
                 timeout)


def rerank(query: str, docs: "list[str]", model: str = "0.6b",
           top_n: Optional[int] = None, timeout: float = DEFAULT_TIMEOUT) -> list:
    result = _post("/v1/rerank", {"query": query, "docs": list(docs),
                                  "model": model, "top_n": top_n}, timeout)
    return result if isinstance(result, list) else []


def pii(text: str, timeout: float = DEFAULT_TIMEOUT) -> list:
    result = _post("/v1/guard/pii", {"text": text}, timeout)
    return result if isinstance(result, list) else []


def injection(text: str, timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
    result = _post("/v1/guard/injection", {"text": text}, timeout)
    return result if isinstance(result, dict) else None


def hook(agent: str, event: str, payload: Any,
         timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
    """Forward a raw hook body.  Returns None when the daemon is unreachable."""
    return _post(f"/hook/{agent}/{event}", payload, timeout)


def health(timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
    result = _get("/health", timeout)
    return result if isinstance(result, dict) else None


if __name__ == "__main__":            # pragma: no cover - manual probe
    print(json.dumps(health(timeout=2.0), indent=2))
