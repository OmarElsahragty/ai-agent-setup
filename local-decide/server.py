"""local-decide FastAPI daemon.

Binds 127.0.0.1:11438 (the systemd unit owns the bind flags; this module only
exposes the ASGI app plus a ``__main__`` convenience runner).  Every route is
fail-open: a model error becomes an abstain or an empty list, a policy error
becomes the agent's own allow/no-op body, and the HTTP status stays 200 so a
hook never breaks the calling agent.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import threading
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

MAX_BATCH_ITEMS = 512  # mirrors mcp.MAX_DOCUMENTS (security review MEDIUM-3)

from engine import (
    MAX_HEADS,
    MAX_LABELS_PER_HEAD,
    MAX_TEXT_BYTES,
    Engine,
)

log = logging.getLogger("local-decide.server")

try:                                    # owned by the policy worker
    import policy
except Exception as _exc:               # pragma: no cover - policy not built yet
    policy = None
    _POLICY_IMPORT_ERROR = f"{type(_exc).__name__}: {_exc}"
else:
    _POLICY_IMPORT_ERROR = None

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class HeadIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    labels: Any
    threshold: float = 0.0
    margin: float = 0.0


class DecideIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str = ""
    heads: dict[str, HeadIn] = Field(default_factory=dict)
    long: bool = False


class MultiIn(DecideIn):
    texts: list[str] = Field(default_factory=list)


class RerankIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    query: str = ""
    docs: list[str] = Field(default_factory=list)
    model: str = "0.6b"
    top_n: Optional[int] = None


class TextIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str = ""


# ---------------------------------------------------------------------------
# Body-size middleware (pure ASGI so the receive stream is replayed, not lost)
# ---------------------------------------------------------------------------
class BodySizeLimit:
    """Reject any request body larger than ``max_bytes`` with 413."""

    def __init__(self, app, max_bytes: int = MAX_TEXT_BYTES):
        self.app = app
        self.max_bytes = int(max_bytes)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        chunks = bytearray()
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            chunks += message.get("body", b"") or b""
            if len(chunks) > self.max_bytes:
                response = JSONResponse(
                    {"error": "payload_too_large",
                     "max_bytes": self.max_bytes,
                     "received_bytes": len(chunks)},
                    status_code=413)
                await response(scope, receive, send)
                return
            if not message.get("more_body"):
                break
        body = bytes(chunks)
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)


# ---------------------------------------------------------------------------
# Loopback host guard (DNS-rebinding / cross-origin defense, security MEDIUM-4)
# ---------------------------------------------------------------------------
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _host_allowed(host_header: str) -> bool:
    """Host must be loopback on any port: `127.0.0.1:11438`, `localhost`, `[::1]:8021`."""
    if not host_header:
        return False
    host = host_header.strip().lower()
    if host.startswith("["):                      # [::1]:11438
        host = host.split("]", 1)[0].lstrip("[")
    elif ":" in host:                             # 127.0.0.1:11438
        host = host.rsplit(":", 1)[0]
    return host in ALLOWED_HOSTS


class LoopbackGuard:
    """403 unless the Host header is loopback and no Origin header is present.

    The agents' hook clients send neither a foreign Host nor an Origin header;
    a browser-born request (DNS rebinding, CSRF from a web page) always does.
    Runs before the body is read, so the reject is cheap.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            headers = {k.decode("latin-1").lower(): v.decode("latin-1")
                       for k, v in scope.get("headers") or []}
            if "origin" in headers or not _host_allowed(headers.get("host", "")):
                response = JSONResponse(
                    {"error": "forbidden_origin",
                     "detail": "local-decide answers loopback hook clients only"},
                    status_code=403)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="local-decide", version="1.0.0", docs_url=None, redoc_url=None)
app.add_middleware(BodySizeLimit, max_bytes=MAX_TEXT_BYTES)
app.add_middleware(LoopbackGuard)   # added last -> runs first (rejects before body read)

ENGINE: Engine = Engine(autostart=os.environ.get("LOCAL_DECIDE_EAGER_LOAD", "1") != "0")


def _cap_check(heads: "dict[str, Any]") -> "dict[str, Any]":
    if len(heads) > MAX_HEADS:
        raise HTTPException(422, f"too many heads: {len(heads)} > {MAX_HEADS}")
    for name, head in heads.items():
        labels = getattr(head, "labels", None)
        if not isinstance(labels, (dict, list)):
            raise HTTPException(422, f"head {name!r}: labels must be an object or list")
        if len(labels) > MAX_LABELS_PER_HEAD:
            raise HTTPException(
                422, f"head {name!r}: {len(labels)} labels > {MAX_LABELS_PER_HEAD}")
    return heads


def _heads_payload(heads: "dict[str, Any]") -> "dict[str, dict]":
    return {
        name: {
            "labels": head.labels,
            "threshold": float(getattr(head, "threshold", 0.0) or 0.0),
            "margin": float(getattr(head, "margin", 0.0) or 0.0),
        }
        for name, head in heads.items()
    }


KNOWN_AGENTS = ("claude", "opencode", "opencode-mac", "agy")


def noop_body(agent: str) -> "dict[str, Any]":
    """The agent-native body meaning 'do nothing'."""
    return {"action": "allow"} if agent in ("opencode", "opencode-mac") else {}


@app.post("/v1/decide")
def v1_decide(payload: DecideIn):
    heads = _cap_check(payload.heads)
    if not heads:
        raise HTTPException(422, "heads must not be empty")
    return ENGINE.decide(payload.text, _heads_payload(heads), long=payload.long)


@app.post("/v1/multi")
def v1_multi(payload: MultiIn):
    """Alias of /v1/decide over a list of texts."""
    heads = _cap_check(payload.heads)
    if not heads:
        raise HTTPException(422, "heads must not be empty")
    if len(payload.texts) > MAX_BATCH_ITEMS:
        raise HTTPException(413, "at most %d texts per call" % MAX_BATCH_ITEMS)
    schema = _heads_payload(heads)
    return [ENGINE.decide(text, schema, long=payload.long)
            for text in payload.texts]


@app.post("/v1/rerank")
def v1_rerank(payload: RerankIn):
    if not payload.docs:
        return []
    if len(payload.docs) > MAX_BATCH_ITEMS:
        raise HTTPException(413, "at most %d docs per call" % MAX_BATCH_ITEMS)
    return ENGINE.rerank(payload.query, payload.docs,
                         model=payload.model, top_n=payload.top_n)


@app.post("/v1/guard/pii")
def v1_guard_pii(payload: TextIn):
    return ENGINE.pii(payload.text)


@app.post("/v1/guard/injection")
def v1_guard_injection(payload: TextIn):
    return ENGINE.injection(payload.text)


# Hook model deadline (2026-10-02, live 10 s UserPromptSubmit timeout under eval load): a hook never waits on a
# busy worker. Past the budget — or when HOOK_MODEL_SLOTS evaluations are already in flight — the hook answers
# from the deterministic rules alone (engine=None); those are the only rules that block, so nothing is weakened.
# The over-budget model pass still finishes in the background and logs its (log/warn-only) result.
HOOK_MODEL_BUDGET_S = float(os.environ.get("LOCAL_DECIDE_HOOK_BUDGET_S", "4.0"))
HOOK_MODEL_SLOTS = threading.BoundedSemaphore(int(os.environ.get("LOCAL_DECIDE_HOOK_SLOTS", "2")))
# Own pool: the loop's default executor is joined on loop shutdown, which would make a hook wait for the very
# model pass it abandoned.
_HOOK_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="hook-model")


# Per-event model budget. PostToolUse only adds a D13 warning; it must not hold a tool result for 4 s.
HOOK_EVENT_BUDGET_S = {"PostToolUse": float(os.environ.get("LOCAL_DECIDE_POST_BUDGET_S", "2.0"))}
# Tool-call fast path (2026-10-02, a 5.4 s PreToolUse p95 under a long multi-session run): on a PreToolUse that is
# not a subagent dispatch, every model head is log-only (D7 policy/PII, D8 risk_tier), so the tool call never
# waits on the model. The hook answers from the deterministic rules; the model pass runs in the background only
# when a slot is free, and only when the deterministic rules returned nothing (so no decision row is doubled).
# A head promoted to warn/block on these tools must be taken off this path (drop it from _model_free_tool).
_DISPATCH_TOOLS = ("agent", "task")


def _model_free_tool(event, payload):
    if event != "PreToolUse":
        return False
    # Same tool-name lookup and dispatch test the policy uses (toolName/name keys, "task-2"-style names), so a
    # dispatch can never slip onto the fast path and lose its D3 warning.
    tool = policy._tool(payload)
    return not (policy._is_task(tool) or str(tool).strip().lower() in _DISPATCH_TOOLS)


def _evaluate_with_model(agent, event, payload):
    try:
        return policy.evaluate(agent, event, payload, ENGINE)
    finally:
        HOOK_MODEL_SLOTS.release()


# Background passes only collect log rows, so they yield to the synchronous model passes that feed the session
# (D1 memory, D3 routing): at most one in flight, and none while the host is busy (2026-10-02: under a long mesh
# run, background passes held both slots and the worker, and every prompt skipped its memory injection).
HOOK_BG_SLOT = threading.BoundedSemaphore(1)
BG_MAX_LOAD_PER_CPU = float(os.environ.get("LOCAL_DECIDE_BG_MAX_LOAD_PER_CPU", "0.5"))


def _host_busy():
    try:
        return os.getloadavg()[0] > BG_MAX_LOAD_PER_CPU * (os.cpu_count() or 1)
    except OSError:
        return True


def _log_only_model_pass(agent, event, payload):
    try:
        _evaluate_with_model(agent, event, payload)
    except Exception as exc:          # background logging only; never surfaces
        log.info("hook %s/%s: background model pass failed: %s", agent, event, type(exc).__name__)
    finally:
        HOOK_BG_SLOT.release()


def _start_background_pass(agent, event, payload):
    if _host_busy() or not HOOK_BG_SLOT.acquire(blocking=False):
        return
    if not HOOK_MODEL_SLOTS.acquire(blocking=False):
        HOOK_BG_SLOT.release()
        return
    try:
        _HOOK_POOL.submit(_log_only_model_pass, agent, event, payload)
    except RuntimeError:              # pool shut down: give both slots back
        HOOK_MODEL_SLOTS.release()
        HOOK_BG_SLOT.release()


async def _evaluate_hook(agent, event, payload):
    if _model_free_tool(event, payload):
        result = await run_in_threadpool(policy.evaluate, agent, event, payload, None)
        if not result:
            _start_background_pass(agent, event, payload)
        return result
    if not HOOK_MODEL_SLOTS.acquire(blocking=False):
        log.info("hook %s/%s: model slots busy, deterministic-only", agent, event)
        return await run_in_threadpool(policy.evaluate, agent, event, payload, None)
    try:
        future = asyncio.wrap_future(_HOOK_POOL.submit(_evaluate_with_model, agent, event, payload))
    except RuntimeError:                  # pool shut down: give the slot back, answer deterministically
        HOOK_MODEL_SLOTS.release()
        return await run_in_threadpool(policy.evaluate, agent, event, payload, None)
    try:
        budget = HOOK_EVENT_BUDGET_S.get(event, HOOK_MODEL_BUDGET_S)
        return await asyncio.wait_for(asyncio.shield(future), budget)
    except asyncio.TimeoutError:
        log.info("hook %s/%s: model over budget, deterministic-only", agent, event)
        return await run_in_threadpool(policy.evaluate, agent, event, payload, None)


@app.post("/hook/{agent}/{event}")
async def hook(agent: str, event: str, request: Request):
    """Native hook shim.  body = the raw hook JSON from the calling agent."""
    try:
        body = await request.body()
        try:
            payload = json.loads(body or b"{}")
        except Exception:
            payload = {"raw": body.decode("utf-8", "ignore")}
        if not isinstance(payload, dict):
            payload = {"value": payload}
        if agent not in KNOWN_AGENTS:     # an unknown client name never falls into another client's rules
            log.warning("hook %s/%s: unknown agent", agent[:32], event[:64])
            return noop_body(agent)
        if policy is None:
            log.warning("hook %s/%s: policy unavailable (%s)",
                        agent, event, _POLICY_IMPORT_ERROR)
            return noop_body(agent)
        # policy.evaluate blocks for the whole model call: keep the loop free so
        # /health still answers while a hook is in flight.
        result = await _evaluate_hook(agent, event, payload)
        if not isinstance(result, dict):
            log.error("hook %s/%s: policy returned %s, not a dict",
                      agent, event, type(result).__name__)
            return noop_body(agent)
        return result
    except Exception as exc:
        log.error("hook %s/%s failed: %s", agent, event, type(exc).__name__)  # no message: it may echo payload text
        return JSONResponse(noop_body(agent), status_code=200)


@app.get("/health")
def health():
    return ENGINE.health()


if __name__ == "__main__":            # pragma: no cover - manual runner
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("LOCAL_DECIDE_HOST", "127.0.0.1"),
        port=int(os.environ.get("LOCAL_DECIDE_PORT", "11438")),
        log_level=os.environ.get("LOCAL_DECIDE_LOG_LEVEL", "info"),
    )
