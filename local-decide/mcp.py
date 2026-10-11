#!/usr/bin/env python3
"""local-decide — stdio MCP server exposing the local GLiNER2.5 decision layer.

Transport : newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio, one
            JSON message per physical line, no embedded newlines).
Runtime   : CPython >= 3.11, standard library only — zero pip installs, runs
            under /usr/bin/python3.
Backend   : the local-decide daemon on 127.0.0.1:11438, reached ONLY through
            the four client.py functions `decide`, `multi`, `rerank`, `hook`
            named in INTERFACES.md. client.py is owned by another worker; this
            module imports it when it exists and otherwise falls back to the
            equivalent stdlib shim `_StdlibClient` (same four names/signatures).

            The adapter below does NOT hardcode a positional signature: it binds
            by parameter name (see `_bind` + `_CLIENT_ALIASES`), so `decide(text,
            heads, ...)`, `multi(texts, heads, ...)` and `rerank(query, docs, ...)`
            all resolve from one call site. If a parameter is ever renamed, that
            single dict is the only edit needed.

            client.py reports an unreachable daemon by RETURNING None (`decide`)
            or [] (`rerank`) instead of raising, so this module treats those two
            answers as an outage — never as a model abstain. A silent abstain
            would hide a dead daemon behind a plausible answer.

Fail-open : no tool ever raises across the JSON-RPC boundary. When the daemon is
            unreachable a tool returns {"error": "local-decide unavailable",
            "fail_open": true} so the caller proceeds unchanged.

Loopback  : the daemon base URL is a constant 127.0.0.1; no host is ever taken
            from tool input, so no MCP caller can redirect the request.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from decisions import redact  # noqa: E402  (same single redactor as decisions.text_head)
from paths import safe_transcript_path, transcript_roots  # noqa: E402

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "local-decide"
SERVER_VERSION = "0.1.0"

DAEMON_HOST = "127.0.0.1"
DAEMON_PORT = 11438
DAEMON_BASE = "http://%s:%d" % (DAEMON_HOST, DAEMON_PORT)
TIMEOUT_S = 2.0

# Caps mirrored from INTERFACES.md (engine input caps).
MAX_TEXT_BYTES = 64 * 1024
MAX_LABELS_PER_HEAD = 32
MAX_HEADS = 16
MAX_ACTIONS = 32
MAX_DOCUMENTS = 512

DEFAULT_THRESHOLD = 0.80
DEFAULT_MARGIN = 0.15
DEFAULT_TOP_N = 10
MAX_PRUNE_MESSAGES = 120

# Per-call budgets handed to client.py when it accepts a `timeout` parameter.
DECIDE_TIMEOUT_S = 3.0
RERANK_TIMEOUT_S = 8.0

UNAVAILABLE = "local-decide unavailable"

# Retention head defaults. policy/ owns rules/retention.yaml; these descriptions
# are the MCP-side fallback used when the daemon does not return head metadata.
RETENTION_HEAD = "retention"
RETENTION_LABELS = {
    "keep": (
        "a message that must survive compaction: the user request, an owner "
        "ruling or invariant, a decision and its reason, file paths, commands, "
        "test output, gate verdicts, and the most recent turns"
    ),
    "drop": (
        "a message that can be dropped after compaction: repeated tool output, "
        "context restated from elsewhere in the transcript, redundant progress "
        "chatter, stale intermediate reasoning, and superseded drafts"
    ),
}

_CLIENT_ALIASES = {
    "text": ("text", "prompt", "content"),
    "texts": ("texts",),
    "heads": ("heads", "head", "labels", "specs"),
    "long": ("long", "chunk"),
    "query": ("query", "q"),
    "documents": ("documents", "docs", "passages"),
    "model": ("model", "model_name"),
    "top_n": ("top_n", "top", "limit", "k"),
    "timeout": ("timeout",),
}


class DaemonUnavailable(RuntimeError):
    """client.py reports an unreachable daemon with None / [] instead of raising."""


# --------------------------------------------------------------------------
# client.py adapter
# --------------------------------------------------------------------------
def _bind(fn, values):
    """Call `fn` with only the entries of `values` whose alias it accepts.

    Lets this module speak to client.py without pinning a positional order:
    `decide(text, heads, ...)` and `multi(texts, heads, ...)` both resolve.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):  # builtins / C callables
        return fn(**values)
    takes_var_kw = any(p.kind is p.VAR_KEYWORD for p in params.values())
    kwargs = {}
    for canonical, value in values.items():
        for name in _CLIENT_ALIASES.get(canonical, (canonical,)):
            if takes_var_kw or name in params:
                kwargs[name] = value
                break
    return fn(**kwargs)


class _StdlibClient:
    """Loopback-only stdlib replacement for client.py (same four functions)."""

    def __init__(self, base=DAEMON_BASE, timeout=TIMEOUT_S):
        self.base = base
        self.timeout = timeout

    def _post(self, path, payload, timeout=None):
        url = self.base + path
        if not url.startswith("http://127.0.0.1:"):  # loopback invariant
            raise RuntimeError("refusing non-loopback daemon url")
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:  # 4xx/5xx still carry a JSON body
            body = exc.read().decode("utf-8", "replace")
            raise RuntimeError("daemon http %d: %s" % (exc.code, body[:200]))
        return json.loads(body) if body else {}

    def decide(self, text, heads, long=False):
        return self._post("/v1/decide", {"text": text, "heads": heads, "long": bool(long)})

    def multi(self, text, heads, long=False):
        try:
            return self._post("/v1/multi", {"text": text, "heads": heads, "long": bool(long)})
        except RuntimeError as exc:
            if "http 404" in str(exc) or "http 422" in str(exc):
                return self.decide(text, heads, long)
            raise

    def rerank(self, query, documents, model="0.6b", top_n=None):
        payload = {"query": query, "documents": documents, "model": model}
        if top_n is not None:
            payload["top_n"] = int(top_n)
        try:
            return self._post("/v1/rerank", payload, timeout=10.0)
        except RuntimeError as exc:
            if "http 404" in str(exc) or "http 422" in str(exc):
                return self._post("/rerank", payload, timeout=10.0)
            raise

    def hook(self, agent, event, payload):
        return self._post("/hook/%s/%s" % (agent, event), payload)


def _load_client():
    """Prefer the sibling client.py; fall back to the stdlib shim."""
    override = os.environ.get("LOCAL_DECIDE_URL", "")
    if override and not override.startswith(("http://127.0.0.1", "http://localhost", "http://[::1]")):
        return _StdlibClient()  # loopback invariant beats the env var
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import client as real_client  # type: ignore
    except Exception:
        return _StdlibClient()
    if not all(callable(getattr(real_client, n, None)) for n in ("decide", "multi", "rerank", "hook")):
        return _StdlibClient()
    return real_client


# Mutable module state so tests can swap the backend for a fake daemon.
_CLIENT = _load_client()


def reset_client():
    """Re-bind the real client (used by tests after monkeypatching _CLIENT)."""
    global _CLIENT
    _CLIENT = _load_client()
    return _CLIENT


# --------------------------------------------------------------------------
# normalizers
# --------------------------------------------------------------------------
def _as_result(obj):
    if not isinstance(obj, dict):
        return None
    if not any(k in obj for k in ("label", "conf", "margin", "abstain")):
        return None
    try:
        conf = float(obj.get("conf") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    try:
        margin = float(obj.get("margin") or 0.0)
    except (TypeError, ValueError):
        margin = 0.0
    return {
        "label": obj.get("label"),
        "conf": conf,
        "margin": margin,
        "abstain": bool(obj.get("abstain", False)),
        "reason": str(obj.get("reason") or ""),
    }


ABSTAINED = {"label": None, "conf": 0.0, "margin": 0.0, "abstain": True, "reason": "no result"}


def norm_results(raw, head_names):
    """Map any daemon `/v1/decide` response shape to {head: normalised result}."""
    out = {}
    if isinstance(raw, dict):
        for key in ("results", "heads", "decisions"):
            inner = raw.get(key)
            if isinstance(inner, list):
                raw = inner
                break
    if isinstance(raw, list):
        default = head_names[0] if head_names else "default"
        for item in raw:
            res = _as_result(item)
            if res is None:
                continue
            head = item.get("head") or item.get("name") or default
            out[str(head)] = res
        return out
    if isinstance(raw, dict):
        heads = raw.get("heads")
        if isinstance(heads, dict):
            for name, item in heads.items():
                res = _as_result(item)
                if res is not None:
                    out[str(name)] = res
            return out
        flat = _as_result(raw)
        if flat is not None:
            out[str(head_names[0] if head_names else "default")] = flat
            return out
        for name, item in raw.items():
            res = _as_result(item)
            if res is not None:
                out[str(name)] = res
    return out


def norm_rerank(raw, n_docs):
    """Map any `/v1/rerank` shape to [{index, score}] sorted desc, de-duplicated."""
    rows = []
    if isinstance(raw, dict):
        for key in ("results", "data", "ranks", "rerank"):
            if isinstance(raw.get(key), list):
                rows = raw[key]
                break
        else:
            rows = []
    elif isinstance(raw, list):
        rows = raw
    out = []
    seen = set()
    for pos, row in enumerate(rows):
        if isinstance(row, dict):
            idx = row.get("index", row.get("doc", pos))
            score = row.get("score", row.get("relevance_score", 0.0))
        else:
            idx, score = pos, row
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= n_docs or idx in seen:
            continue
        try:
            score = float(score)
        except (TypeError, ValueError):
            score = 0.0
        seen.add(idx)
        out.append({"index": idx, "score": score})
    out.sort(key=lambda r: r["score"], reverse=True)
    return out


def _clip(text):
    """Truncate to the engine's 64 KB input cap; report whether it clipped."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    raw = text.encode("utf-8", "replace")
    if len(raw) <= MAX_TEXT_BYTES:
        return text, False
    return raw[:MAX_TEXT_BYTES].decode("utf-8", "ignore"), True


def _norm_labels(labels):
    if not isinstance(labels, dict) or not labels:
        raise ValueError("labels must be a non-empty object of label -> description")
    items = [(str(k), str(v or "")) for k, v in labels.items()]
    truncated = len(items) - len(items[:MAX_LABELS_PER_HEAD])
    return dict(items[:MAX_LABELS_PER_HEAD]), max(0, truncated)


def _unavailable(reason=None):
    payload = {"error": UNAVAILABLE, "fail_open": True}
    if reason:
        payload["detail"] = str(reason)[:200]
    return payload


def _call_decide(text, heads, long=False):
    """One multi-head daemon call through client.py.

    client.decide returns None when the daemon is unreachable, so None is an
    outage, not an abstain. client.multi is deliberately not used: it takes a
    LIST of texts and returns one head-map per text, a different shape.
    """
    values = {"text": text, "texts": [text], "heads": heads, "labels": heads,
              "long": long, "timeout": DECIDE_TIMEOUT_S}
    raw = _bind(_CLIENT.decide, values)
    if raw is None:
        raise DaemonUnavailable("decide returned no answer")
    return raw


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------
def tool_decide(text, labels, threshold=DEFAULT_THRESHOLD, margin=DEFAULT_MARGIN):
    try:
        labels, dropped = _norm_labels(labels)
    except ValueError as exc:
        return {"error": str(exc), "fail_open": True}
    body, clipped = _clip(text)
    heads = {"default": {"labels": labels, "threshold": float(threshold), "margin": float(margin)}}
    try:
        results = norm_results(_call_decide(body, heads, long=clipped), ["default"])
    except Exception as exc:  # daemon down, timeout, malformed answer
        return _unavailable(exc)
    result = results.get("default", dict(ABSTAINED))
    out = {
        "label": result["label"],
        "conf": result["conf"],
        "margin": result["margin"],
        "abstain": result["abstain"],
        "reason": result["reason"],
    }
    if clipped:
        out["truncated"] = True
    if dropped:
        out["labels_dropped"] = dropped
    return out


def tool_multi_check(text, checks, threshold=DEFAULT_THRESHOLD, margin=DEFAULT_MARGIN):
    if not isinstance(checks, dict) or not checks:
        return {"error": "checks must be a non-empty object", "fail_open": True}
    names = [str(k) for k in checks.keys()][:MAX_HEADS]
    dropped_checks = len(checks) - len(names)
    heads = {}
    for name in names:
        spec = checks.get(name)
        if not isinstance(spec, dict):
            return {"error": "check %r must be an object with yes_desc/no_desc" % name, "fail_open": True}
        labels = {}
        for key, field in (("yes", "yes_desc"), ("no", "no_desc")):
            desc = str(spec.get(field) or "").strip()
            if desc:
                labels[key] = desc
        if len(labels) < 2:
            return {"error": "check %r needs both yes_desc and no_desc" % name, "fail_open": True}
        heads[name] = {"labels": labels, "threshold": float(threshold), "margin": float(margin)}
    body, clipped = _clip(text)
    try:
        results = norm_results(_call_decide(body, heads, long=clipped), names)
    except Exception as exc:
        return _unavailable(exc)
    out = {}
    for name in names:
        res = results.get(name, dict(ABSTAINED))
        out[name] = {
            "answer": None if res["abstain"] else res["label"],
            "conf": res["conf"],
            "margin": res["margin"],
            "abstain": res["abstain"],
            "reason": res["reason"],
        }
    if clipped:
        out["truncated"] = True
    if dropped_checks:
        out["checks_dropped"] = dropped_checks
    return out


def tool_rerank(query, documents, model="0.6b", top_n=DEFAULT_TOP_N):
    if model not in ("0.6b", "4b"):
        return {"error": "model must be '0.6b' or '4b'", "fail_open": True}
    if not isinstance(documents, list) or not documents:
        return {"error": "documents must be a non-empty array of strings", "fail_open": True}
    docs = [str(d or "") for d in documents][:MAX_DOCUMENTS]
    dropped = len(documents) - len(docs)
    try:
        limit = int(top_n)
    except (TypeError, ValueError):
        limit = DEFAULT_TOP_N
    limit = max(1, min(limit, len(docs)))
    values = {"query": str(query or ""), "documents": docs, "model": model, "top_n": limit,
              "timeout": RERANK_TIMEOUT_S}
    try:
        raw = _bind(_CLIENT.rerank, values)
    except Exception as exc:
        return _unavailable(exc)
    rows = norm_rerank(raw, len(docs))
    if not rows:
        # client.rerank returns [] for an unreachable daemon; a live reranker
        # always ranks at least one of the (non-empty) documents it was given.
        return _unavailable("rerank returned no ranking")
    ranked = [
        {"index": r["index"], "score": round(r["score"], 6), "document": docs[r["index"]]}
        for r in rows[:limit]
    ]
    scores = [r["score"] for r in rows]
    out = {"model": model, "query": str(query or ""), "results": ranked}
    if scores and (max(scores) - min(scores)) <= 1e-6:
        # A flat ranking has plausible shape but no signal — a broken model
        # conversion looks exactly like this. Report it, do not hide it.
        out["degenerate_ranking"] = True
    if dropped:
        out["documents_dropped"] = dropped
    return out


def tool_select_browser_action(goal, actions, threshold=0.6, margin=0.10):
    if not isinstance(actions, list) or not actions:
        return {"error": "actions must be a non-empty array", "fail_open": True}
    if len(actions) > MAX_ACTIONS:
        return {
            "error": "at most %d actions per call (got %d)" % (MAX_ACTIONS, len(actions)),
            "fail_open": True,
        }
    labels = {}
    ids = []
    for item in actions:
        if not isinstance(item, dict) or not item.get("id"):
            return {"error": "each action needs an id and a label", "fail_open": True}
        aid = str(item["id"])
        if aid in labels:
            continue
        ids.append(aid)
        labels[aid] = str(item.get("label") or aid)
    decided = tool_decide(str(goal or ""), labels, threshold=threshold, margin=margin)
    if "error" in decided:
        return decided
    if decided["abstain"] or not decided["label"]:
        return {
            "action_id": None,
            "abstain": True,
            "conf": decided["conf"],
            "margin": decided["margin"],
            "reason": decided["reason"] or "no action cleared the threshold",
            "considered": ids,
        }
    return {
        "action_id": decided["label"],
        "abstain": False,
        "conf": decided["conf"],
        "margin": decided["margin"],
        "reason": decided["reason"],
        "considered": ids,
    }


def _read_transcript(path, max_messages):
    """Read a JSONL transcript read-only. Returns (messages, notes)."""
    notes = []
    if not isinstance(path, str) or not path:
        return [], ["transcript_path is required"]
    resolved = safe_transcript_path(path)
    if resolved is None:
        return [], ["transcript_path must be a .jsonl file under: %s" % ", ".join(transcript_roots())]
    if not os.path.isfile(resolved):
        return [], ["no such transcript: %s" % resolved]
    if not os.access(resolved, os.R_OK):
        return [], ["transcript not readable: %s" % resolved]
    rows = []
    with open(resolved, "r", encoding="utf-8", errors="replace") as handle:  # read-only, never 'w'
        for lineno, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                rows.append({"line": lineno, "type": "raw", "text": line[:400]})
                continue
            if not isinstance(obj, dict):
                continue
            message = obj.get("message") if isinstance(obj.get("message"), dict) else obj
            content = message.get("content")
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, dict):
                        parts.append(str(item.get("text") or item.get("content") or item.get("type") or ""))
                    else:
                        parts.append(str(item))
                text = " ".join(p for p in parts if p)
            else:
                text = str(content or message.get("text") or "")
            rows.append({
                "line": lineno,
                "type": str(obj.get("type") or message.get("role") or "unknown"),
                "text": text,
                "ts": str(obj.get("timestamp") or obj.get("ts") or ""),
            })
    total = len(rows)
    if total > max_messages:
        rows = rows[-max_messages:]
        notes.append("scanned the last %d of %d messages" % (max_messages, total))
    return rows, notes


def tool_prune_preview(transcript_path, max_messages=MAX_PRUNE_MESSAGES):
    try:
        limit = max(1, min(int(max_messages), MAX_PRUNE_MESSAGES))
    except (TypeError, ValueError):
        limit = MAX_PRUNE_MESSAGES
    messages, notes = _read_transcript(transcript_path, limit)
    if not messages:
        return {"transcript": os.path.abspath(os.path.expanduser(str(transcript_path or ""))),
                "kept": [], "dropped": [], "notes": notes, "modified": False}
    heads = {RETENTION_HEAD: {"labels": dict(RETENTION_LABELS),
                              "threshold": DEFAULT_THRESHOLD, "margin": DEFAULT_MARGIN}}
    kept, dropped, abstained = [], [], []
    for row in messages:
        body = "%s: %s" % (row["type"], row["text"])
        body, _ = _clip(body)
        try:
            results = norm_results(_call_decide(body, heads), [RETENTION_HEAD])
        except Exception as exc:
            return _unavailable(exc)
        res = results.get(RETENTION_HEAD, dict(ABSTAINED))
        item = {"line": row["line"], "type": row["type"],
                "sha1": hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()[:12],
                "head": redact(row["text"] or "").strip()[:120]}
        if res["abstain"] or res["label"] not in ("keep", "drop"):
            abstained.append(item)
        elif res["label"] == "drop":
            dropped.append(item)
        else:
            kept.append(item)
    return {
        "transcript": os.path.abspath(os.path.expanduser(str(transcript_path))),
        "scanned": len(messages),
        "kept": kept,
        "dropped": dropped,
        "abstained": abstained,
        "notes": notes,
        "modified": False,
    }


TOOLS = [
    {
        "name": "decide",
        "description": (
            "Classify one text against a caller-supplied label set with the local GLiNER2.5 "
            "model. Returns the winning label plus confidence, margin and an abstain flag. "
            "Abstain means no label cleared the threshold — the caller keeps its default."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to classify (capped at 64 KB)."},
                "labels": {
                    "type": "object",
                    "description": "label -> what that label means (max 32 labels).",
                    "additionalProperties": {"type": "string"},
                },
                "threshold": {"type": "number", "default": DEFAULT_THRESHOLD},
                "margin": {"type": "number", "default": DEFAULT_MARGIN},
            },
            "required": ["text", "labels"],
        },
    },
    {
        "name": "multi_check",
        "description": (
            "Answer several independent yes/no questions about one text in a single multi-head "
            "call (max 16 checks). Returns one entry per check: yes, no, or abstain."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text under test (capped at 64 KB)."},
                "checks": {
                    "type": "object",
                    "description": "check name -> {yes_desc, no_desc}.",
                    "additionalProperties": {
                        "type": "object",
                        "properties": {
                            "yes_desc": {"type": "string"},
                            "no_desc": {"type": "string"},
                        },
                        "required": ["yes_desc", "no_desc"],
                    },
                },
                "threshold": {"type": "number", "default": DEFAULT_THRESHOLD},
                "margin": {"type": "number", "default": DEFAULT_MARGIN},
            },
            "required": ["text", "checks"],
        },
    },
    {
        "name": "rerank",
        "description": (
            "Rerank candidate passages against a query with the local llama.cpp cross-encoder "
            "(0.6b or 4b). Returns the top_n passages with their scores, most relevant first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "documents": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_DOCUMENTS},
                "model": {"type": "string", "enum": ["0.6b", "4b"], "default": "0.6b"},
                "top_n": {"type": "integer", "default": DEFAULT_TOP_N},
            },
            "required": ["query", "documents"],
        },
    },
    {
        "name": "select_browser_action",
        "description": (
            "Pick the single browser/UI action that best satisfies a goal from at most 32 "
            "candidate actions ({id, label}). Abstains when nothing clears the threshold."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {"type": "string", "description": "What the user wants to achieve."},
                "actions": {
                    "type": "array",
                    "maxItems": MAX_ACTIONS,
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, "label": {"type": "string"}},
                        "required": ["id"],
                    },
                },
                "threshold": {"type": "number", "default": 0.6},
                "margin": {"type": "number", "default": 0.1},
            },
            "required": ["goal", "actions"],
        },
    },
    {
        "name": "prune_preview",
        "description": (
            "Preview which messages the D10 retention head would drop from a JSONL transcript "
            "before compaction. Read-only: the file is never modified. Returns kept, dropped "
            "and abstained messages with line numbers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "transcript_path": {"type": "string"},
                "max_messages": {"type": "integer", "default": MAX_PRUNE_MESSAGES},
            },
            "required": ["transcript_path"],
        },
    },
]

_DISPATCH = {
    "decide": tool_decide,
    "multi_check": tool_multi_check,
    "rerank": tool_rerank,
    "select_browser_action": tool_select_browser_action,
    "prune_preview": tool_prune_preview,
}


def call_tool(name, arguments):
    handler = _DISPATCH.get(name)
    if handler is None:
        return {"error": "unknown tool: %s" % name, "fail_open": True}
    args = arguments if isinstance(arguments, dict) else {}
    try:
        result = handler(**args)
    except TypeError as exc:
        return {"error": "bad arguments for %s: %s" % (name, exc), "fail_open": True}
    except Exception as exc:  # invariant: a tool never breaks the server
        return {"error": "%s: %s" % (type(exc).__name__, exc), "fail_open": True}
    return result if isinstance(result, dict) else {"result": result}


# --------------------------------------------------------------------------
# JSON-RPC / MCP stdio
# --------------------------------------------------------------------------
def _result(request_id, payload):
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def _error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_request(request):
    """Return a JSON-RPC response dict, or None for notifications."""
    if not isinstance(request, dict):
        return None
    method = request.get("method")
    request_id = request.get("id")
    is_notification = "id" not in request
    params = request.get("params") if isinstance(request.get("params"), dict) else {}

    if method == "initialize":
        response = _result(request_id, {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": (
                "Local, offline decisions (GLiNER2.5 decide/rerank) on 127.0.0.1. Every tool "
                "fails open: on daemon-down or ambiguity it abstains and the caller proceeds."
            ),
        })
    elif method in ("notifications/initialized", "notifications/cancelled"):
        return None
    elif method == "ping":
        response = _result(request_id, {})
    elif method == "tools/list":
        response = _result(request_id, {"tools": TOOLS})
    elif method == "tools/call":
        name = params.get("name")
        payload = call_tool(name, params.get("arguments"))
        response = _result(request_id, {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, default=str)}],
            "isError": "error" in payload,
        })
    elif method == "shutdown":
        response = _result(request_id, {})
    elif is_notification:
        return None
    else:
        if is_notification:
            return None
        return _error(request_id, -32601, "method not found: %s" % method)
    return None if is_notification else response


def serve(stdin=None, stdout=None):
    """Read NDJSON requests until EOF. Always exits 0."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            stdout.write(json.dumps(_error(None, -32700, "parse error")) + "\n")
            stdout.flush()
            continue
        if isinstance(request, list):  # JSON-RPC batch
            responses = [r for r in (handle_request(item) for item in request) if r is not None]
            if responses:
                stdout.write(json.dumps(responses, separators=(",", ":")) + "\n")
                stdout.flush()
            continue
        try:
            response = handle_request(request)
        except Exception as exc:  # last-resort guard: keep the session alive
            response = _error(request.get("id") if isinstance(request, dict) else None,
                              -32603, "internal error: %s" % exc)
        if response is None:
            continue
        stdout.write(json.dumps(response, separators=(",", ":"), default=str) + "\n")
        stdout.flush()
    return 0


def _list_tools_stdout():
    for tool in TOOLS:
        print("%s\t%s" % (tool["name"], tool["description"].split(".")[0]))


def main(argv):
    args = list(argv[1:])
    if "--version" in args:
        print("%s %s" % (SERVER_NAME, SERVER_VERSION))
        return 0
    if "--list-tools" in args:
        _list_tools_stdout()
        return 0
    if args:
        sys.stderr.write("mcp.py speaks JSON-RPC on stdio; unexpected args: %s\n" % " ".join(args))
        return 2
    return serve()


if __name__ == "__main__":
    sys.exit(main(sys.argv))