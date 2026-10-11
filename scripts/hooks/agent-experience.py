#!/usr/bin/env python3
"""SubagentStop hook (WO-3): distill a finished subagent run into experience memory.

Parent: reads the hook JSON (session_id, transcript_path, cwd; agent name if the
payload carries it), spawns a detached worker, exits 0 (<200 ms).
Worker: uses the subagent transcript when the payload provides one
(agent_transcript_path / subagent_transcript_path); otherwise falls back to the
last Task/Agent tool_use + tool_result pair in the main transcript. Background-lane
LLM -> {lessons: [{statement, evidence, confidence}], mistakes_to_avoid: [string]};
scrubbed; lessons become instinct records (namespace 'experience', agent=<name>);
mistakes stored as a per-agent mistakes record. Agent/rule files are never touched.
Kill switch SESSION_MEMORY=off. All failures are silent (fail open).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memlib  # noqa: E402

TAIL_BYTES = 200 * 1024
MIN_RESULT_CHARS = 200
NAME_RE = r"^[a-z0-9][a-z0-9_-]{0,63}$"

SYSTEM = (
    "You extract durable engineering lessons from a software agent's completed task. "
    "Respond with ONE JSON object only — no markdown fences, no prose outside the JSON. "
    'Schema: {"lessons": [{"statement": string, "evidence": string, "confidence": number}], '
    '"mistakes_to_avoid": [string]}. lessons = generalizable statements this run supports '
    "(tools, paths, gotchas, owner preferences); every lesson must be a REUSABLE rule, "
    "never a one-off task fact (task-specific data details such as ticker-specific numbers "
    "are NOT lessons); evidence = what in the run backs each statement; never invent facts "
    "that are not in the run output — if nothing supports a lesson, omit it. Refer to the "
    "human as 'the owner' with they/them pronouns, never he/she. confidence between 0.3 "
    "and 0.9. mistakes_to_avoid = concrete actions that failed or must not be repeated. "
    "English only."
)


def resolve_agent(payload, tail_text):
    for key in ("agent_name", "agent", "subagent_type", "agent_type", "subagent"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    name, _ = memlib.extract_last_agent_result(tail_text)
    return name


def subagent_text(payload):
    """(agent_name, text) from the subagent transcript or the main-transcript fallback."""
    main_path = payload.get("transcript_path") or ""
    tail = ""
    if main_path and os.path.isfile(main_path):
        try:
            tail, _ = memlib.read_tail(main_path, TAIL_BYTES)
        except OSError:
            tail = ""
    for key in ("agent_transcript_path", "subagent_transcript_path"):
        path = payload.get(key) or ""
        if path and os.path.isfile(path):
            try:
                own_tail, _ = memlib.read_tail(path, TAIL_BYTES)
                conversation = memlib.parse_conversation(own_tail)
                if conversation:
                    name = resolve_agent(payload, tail)
                    text = "\n".join(f"[{m['role'].upper()}] {m['text'][:2000]}"
                                     for m in conversation[-80:])
                    return name, text
            except OSError:
                pass
    name, text = memlib.extract_last_agent_result(tail)
    return name, text


def normalize_llm(data):
    if not isinstance(data, dict):
        return None
    lessons = []
    raw = data.get("lessons")
    if isinstance(raw, list):
        for item in raw[:12]:
            if not isinstance(item, dict):
                continue
            statement = memlib.scrub_text(str(item.get("statement", "")))[0].strip()
            if not statement:
                continue
            lessons.append({
                "statement": statement[:400],
                "evidence": memlib.scrub_text(str(item.get("evidence", "")))[0].strip()[:300],
                "confidence": memlib._clamp(item.get("confidence", 0.5)),
            })
    mistakes = []
    raw = data.get("mistakes_to_avoid")
    if isinstance(raw, list):
        for item in raw[:12]:
            text = memlib.scrub_text(str(item))[0].strip()
            if text:
                mistakes.append(text[:300])
    return {"lessons": lessons, "mistakes_to_avoid": mistakes}


def worker(payload):
    if not memlib.enabled():
        return
    import re
    name, text = subagent_text(payload)
    if not name or not re.match(NAME_RE, str(name)):
        memlib.log("experience_skip", sid=memlib.sid8(payload.get("session_id")),
                   reason="no_agent_name")
        return
    if not text or len(text) < MIN_RESULT_CHARS:
        memlib.log("experience_skip", agent=name,
                   sid=memlib.sid8(payload.get("session_id")), reason="no_result_text")
        return
    distill({"name": name, "text": text[:60000], "session_id": payload.get("session_id") or ""})


def distill(rec, retry=False):
    """LLM-distill one resolved run. A failed call parks the (scrubbed) run for replay — the main-transcript
    fallback in subagent_text() moves on with later agents, so the replay must not re-resolve it."""
    name, text, session_id = rec.get("name"), rec.get("text") or "", rec.get("session_id") or ""
    if not name or not text:
        return None
    prompt = (f"AGENT: {name}\nSESSION: {memlib.sid8(session_id)}\n"
              f"RUN OUTPUT:\n{text}")
    data = normalize_llm(memlib.llm_json(prompt, SYSTEM))
    if data is None:
        memlib.log("experience_llm_unavailable", agent=name, result_chars=len(text))
        if not retry:
            scrubbed, _ = memlib.scrub_text(text)
            memlib.spool_retry("experience", {"name": name, "text": scrubbed, "session_id": session_id},
                               key=f"{session_id}|{name}|{text[:4000]}")
        return "unavailable"
    stored = 0
    for lesson in data["lessons"]:
        if memlib.upsert_instinct(lesson["statement"], lesson["evidence"],
                                  lesson["confidence"], agent=name,
                                  session_id=session_id) is not None:
            stored += 1
    if data["mistakes_to_avoid"]:
        memlib.record_mistakes(name, data["mistakes_to_avoid"], session_id)
    memlib.log("experience_written", agent=name, sid=memlib.sid8(session_id),
               result_chars=len(text), lessons=stored,
               mistakes=len(data["mistakes_to_avoid"]))
    if not retry:
        memlib.drain_retries("experience", lambda r: distill(r, retry=True))
    return "written"


def main():
    if not memlib.enabled():
        sys.exit(0)
    payload = {}
    if not sys.stdin.isatty():
        try:
            raw = sys.stdin.read()
            if raw.strip():
                payload = json.loads(raw)
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if not payload.get("transcript_path"):
        for arg in sys.argv[1:]:
            if arg != "--worker" and "/" in arg:
                payload["transcript_path"] = arg
    payload.update(memlib.load_worker_payload())
    if memlib.detach_self(payload):
        os._exit(0)
    try:
        worker(payload)
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
