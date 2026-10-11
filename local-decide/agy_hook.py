#!/usr/bin/env python3
"""agy lifecycle-hook bridge: stdin JSON -> local-decide daemon -> stdout JSON.

Contract (see ${AI_SETUP_ROOT}/local-decide/INTERFACES.md):

    POST http://127.0.0.1:11438/hook/agy/<Event>   body = raw agy hook payload
    stdout                                        = the daemon's agent-native body

agy FAILS CLOSED on a PreToolUse handler that produces no usable output, so this
bridge is deliberately fail-OPEN: on ANY problem (bad stdin, non-loopback URL,
connection refused, non-2xx, timeout, unparseable body) it prints `{}` and exits
0, which agy reads as "no decision" and therefore allows the tool call.

It also records the tool names agy actually sends for the first N events, so the
`matcher` regexes in ~/.gemini/config/hooks.json can be tightened from observed
data instead of from the UNSOURCED field reports.

Usage:  agy_hook.py <Event>       (stdin = the agy hook JSON payload)
"""

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:11438"
TIMEOUT_S = 1.5
_ROOT = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL_NAME_LOG = os.path.join(_ROOT, "state", "local-decide", "agy-tool-names.log")
TOOL_NAME_LOG_LIMIT = 50

# agy handler `timeout` is in seconds and a kill there would leave stdout empty.
# Our own HTTP budget is 1.5s, so 10s is pure headroom.
LOG_DIR = os.path.dirname(TOOL_NAME_LOG)


def emit(obj) -> int:
    """Print the agy-native body and exit 0. Never raises."""
    try:
        sys.stdout.write(json.dumps(obj if obj is not None else {}))
        sys.stdout.write("\n")
        sys.stdout.flush()
    except Exception:
        pass
    return 0


def read_stdin() -> dict:
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        payload = json.loads(raw)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def tool_name(payload: dict) -> str:
    """Best-effort tool name across the shapes agy has been observed to send."""
    seen = []
    for key in ("toolCall", "tool_call"):
        node = payload.get(key)
        if isinstance(node, dict):
            seen.append(node.get("name"))
            inner = node.get("toolCall")
            if isinstance(inner, dict):
                seen.append(inner.get("name"))
    seen.extend([payload.get("tool_name"), payload.get("name")])
    for value in seen:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def record_tool_name(event: str, name: str) -> None:
    """Append one observed tool name until TOOL_NAME_LOG_LIMIT lines exist.

    Only tool events consume the budget: a tool event with no name is itself the
    diagnostic signal that a matcher is missing, but PreInvocation/Stop carry no
    name and would otherwise burn all 50 lines before a single tool is seen.
    """
    if not name and event not in ("PreToolUse", "PostToolUse"):
        return
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        try:
            with open(TOOL_NAME_LOG, encoding="utf-8") as fh:
                used = sum(1 for _ in fh)
        except OSError:
            used = 0
        if used >= TOOL_NAME_LOG_LIMIT:
            return
        with open(TOOL_NAME_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"event": event, "tool": name or "<none>"}) + "\n")
    except Exception:
        pass


def post(event: str, payload: dict):
    base = os.environ.get("LOCAL_DECIDE_URL", DEFAULT_BASE).rstrip("/")
    if not base.startswith("http://127.0.0.1:"):
        raise RuntimeError("refusing non-loopback daemon url")
    req = urllib.request.Request(
        "%s/hook/agy/%s" % (base, event),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip() else {}


# agy reads a FIXED field set per event and ignores everything else. policy.py renders a
# single agy-shaped body across all events, so it has to be narrowed here:
#   PreToolUse      {decision: allow|deny|ask, reason, permissionOverrides, overwrite}
#   PostToolUse     {}  (documented: "expects an empty JSON object")
#   PreInvocation   {injectSteps: [{ephemeralMessage|userMessage|toolCall}]}
#   PostInvocation  {injectSteps, terminationBehavior}
#   Stop            {decision: "continue", reason}  -- only "continue" blocks the stop
# "additionalContext" (what policy.py emits for context/warn) occurs ZERO times in the agy
# binary, so passing it straight through would silently drop every D1/D2 and D13 decision.
AGY_ALLOWED_FIELDS = {
    "PreToolUse": ("decision", "reason", "permissionOverrides", "overwrite"),
    "PostToolUse": (),
    "PreInvocation": ("injectSteps",),
    "PostInvocation": ("injectSteps", "terminationBehavior"),
    "Stop": ("decision", "reason"),
}
CONTEXT_EVENTS = ("PreInvocation", "PostInvocation")


def to_agy_body(event: str, body: dict) -> dict:
    """Narrow a daemon body to the fields agy actually parses for this event."""
    out = {k: body[k] for k in AGY_ALLOWED_FIELDS.get(event, ()) if k in body}
    context = body.get("additionalContext")
    if context and event in CONTEXT_EVENTS and "injectSteps" not in out:
        out["injectSteps"] = [{"ephemeralMessage": context}]
    if event == "PreToolUse" and "decision" not in out:
        out["decision"] = "allow"
    if event == "Stop":
        # Claude's Stop "deny" (block the stop) is agy's "continue"; every other value,
        # including "deny" and "block", lets agy stop.
        if out.get("decision") in ("deny", "block"):
            out["decision"] = "continue"
        elif out.get("decision") != "continue":
            out.pop("decision", None)
    return out


def is_turn_invocation(payload: dict) -> bool:
    """PreInvocation fires per MODEL call, not per turn; only 0 is turn-scoped.

    Coerces the way policy.py's _agy_turn does: protojson may hand back a string for an
    int64, and a value we cannot read must be treated as the turn, never silently skipped.
    """
    try:
        return int(payload.get("invocationNum", 0) or 0) == 0
    except (TypeError, ValueError):
        return True


def main(argv) -> int:
    event = argv[1] if len(argv) > 1 else ""
    payload = read_stdin()
    if not event:
        event = str(payload.get("hookEventName") or "")
    if event:
        record_tool_name(event, tool_name(payload))
    if not event:
        return emit({})
    if event == "PreInvocation" and not is_turn_invocation(payload):
        # Skipping also keeps a 1.5s-budget HTTP call off the hot path of every step.
        return emit({})
    fail_open = {"decision": "allow"} if event == "PreToolUse" else {}
    try:
        body = post(event, payload)
    except urllib.error.HTTPError:
        # The daemon answered with a JSON error body; it is still an agy-native body.
        return emit(fail_open)
    except Exception:
        return emit(fail_open)
    if not isinstance(body, dict):
        return emit(fail_open)
    return emit(to_agy_body(event, body))


if __name__ == "__main__":
    # NOTE: catch Exception, never BaseException -- SystemExit derives from
    # BaseException, so a BaseException handler here would re-emit after
    # main() already printed, putting two JSON objects on stdout and breaking
    # agy's parse (and, on PreToolUse, its fail-closed default).
    try:
        code = main(sys.argv)
    except Exception:
        # Absolute last resort: agy PreToolUse fails closed on a missing body.
        emit({"decision": "allow"} if len(sys.argv) > 1 and sys.argv[1] == "PreToolUse" else {})
        code = 0
    sys.exit(code)