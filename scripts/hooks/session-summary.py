#!/usr/bin/env python3
"""Stop/SessionEnd hook (WO-3): summarize the session into memory, detached.

Parent: reads the hook JSON from stdin (session_id, transcript_path, cwd) — or
argv/env for the OpenCode adapter — skips the spawn entirely when the sidecar
says nothing new (cheap tail count), else spawns a detached worker, exits 0.
Worker: last <=200 KB of transcript; skips <3 user messages; re-summarises when
the event is SessionEnd OR user_msgs grew by >=5 since the last write (tracked
in the <summary>.meta.json sidecar); background-lane LLM -> {worked[],
did_not_work[], next_step, owner_preferences[]}; everything scrubbed; overwrites
state/sessions/<date>-<sid8>.md and REPLACES this session's unified-memory
record (namespace 'session', agent 'main', title "Session Log — <project> —
<date> <sid8>", deterministic id) instead of appending to one shared topic;
owner preferences become instinct records (agent 'main'). A processed transcript
under /var/tmp/claude/opencode-*.jsonl is unlinked afterwards (success or not).
Kill switch SESSION_MEMORY=off. All failures are silent (fail open).
"""
import fnmatch
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memlib  # noqa: E402

TAIL_BYTES = 200 * 1024
MIN_USER_MSGS = 3
MAX_MSGS_IN_PROMPT = 60
MAX_MSG_CHARS = 2000
RESUME_DELTA = 5
OPENCODE_EXPORT_GLOB = "/var/tmp/claude/opencode-*.jsonl"

SYSTEM = (
    "You summarize software agent work sessions. Respond with ONE JSON object only — "
    "no markdown fences, no prose outside the JSON. Schema: "
    '{"worked": [string], "did_not_work": [{"what": string, "why": string}], '
    '"next_step": string, "owner_preferences": [{"statement": string, "evidence": string, '
    '"confidence": number}]}. worked = concrete completed/verified items. did_not_work = '
    "approaches that failed or must not be retried, with the reason. next_step = the single "
    "next action. owner_preferences = durable owner rulings/preferences observed in THIS "
    "session only (never invent them; empty array if none); each must be a REUSABLE rule, "
    "never a one-off task fact (task-specific data details such as ticker-specific numbers "
    "are NOT preferences). Never invent facts that are not in the transcript — if the "
    "transcript does not support a field, leave it empty. Refer to the human as 'the "
    "owner' with they/them pronouns, never he/she. confidence is between 0.3 and 0.9. "
    "English only."
)


def collect_payload():
    """stdin hook JSON first; argv/env fallback for OpenCode."""
    payload = {}
    if not sys.stdin.isatty():
        try:
            data = sys.stdin.read()
            if data.strip():
                payload = json.loads(data)
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if not payload.get("transcript_path"):
        for arg in sys.argv[1:]:
            if arg != "--worker" and "/" in arg:
                payload["transcript_path"] = arg
    payload.setdefault("session_id",
                       os.environ.get("CLAUDE_SESSION_ID")
                       or os.environ.get("SESSION_ID") or "")
    payload.setdefault("cwd", os.environ.get("PWD") or os.getcwd())
    payload.update(memlib.load_worker_payload())
    return payload


def build_prompt(conversation, project, session_id, ledgers):
    lines = [f"PROJECT: {project}", f"SESSION: {memlib.sid8(session_id)}"]
    if ledgers:
        lines.append("TOUCHED STATE FILES: " + ", ".join(ledgers))
    lines.append("TRANSCRIPT TAIL (oldest to newest):")
    shown = conversation[-MAX_MSGS_IN_PROMPT:]
    for msg in shown:
        role = "USER" if msg["role"] == "user" else "AGENT"
        text = msg["text"][:MAX_MSG_CHARS]
        lines.append(f"[{role}] {text}")
    return "\n".join(lines)[:60000]


def render_markdown(sid, project, data):
    parts = [f"# Session {sid} — {project}",
             memlib._now_iso().split("T")[0]]
    parts.append("\n## Worked")
    if data["worked"]:
        parts.extend(f"- {w}" for w in data["worked"])
    else:
        parts.append("- (none recorded)")
    parts.append("\n## Did not work")
    if data["did_not_work"]:
        for item in data["did_not_work"]:
            parts.append(f"- {item.get('what', '?')} — {item.get('why', '?')}")
    else:
        parts.append("- (none recorded)")
    parts.append("\n## Next step")
    parts.append(data["next_step"] or "(none recorded)")
    if data["owner_preferences"]:
        parts.append("\n## Owner preferences")
        for pref in data["owner_preferences"]:
            parts.append(f"- {pref.get('statement', '')} "
                         f"(conf {pref.get('confidence', 0.5)}, evidence: {pref.get('evidence', '')[:200]})")
    return "\n".join(parts) + "\n"


def normalize_llm(data):
    """Validate + clamp the LLM object; every string is scrubbed."""
    def strings(value, cap):
        out = []
        if isinstance(value, list):
            for item in value[:cap]:
                text = memlib.scrub_text(str(item))[0].strip()
                if text:
                    out.append(text[:400])
        return out

    def pairs(value, cap):
        out = []
        if isinstance(value, list):
            for item in value[:cap]:
                if not isinstance(item, dict):
                    continue
                what = memlib.scrub_text(str(item.get("what", "")))[0].strip()
                why = memlib.scrub_text(str(item.get("why", "")))[0].strip()
                if what:
                    out.append({"what": what[:400], "why": why[:400]})
        return out

    def prefs(value, cap):
        out = []
        if isinstance(value, list):
            for item in value[:cap]:
                if not isinstance(item, dict):
                    continue
                statement = memlib.scrub_text(str(item.get("statement", "")))[0].strip()
                if not statement:
                    continue
                out.append({
                    "statement": statement[:400],
                    "evidence": memlib.scrub_text(str(item.get("evidence", "")))[0].strip()[:300],
                    "confidence": memlib._clamp(item.get("confidence", 0.5)),
                })
        return out

    if not isinstance(data, dict):
        return None
    result = {
        "worked": strings(data.get("worked"), 12),
        "did_not_work": pairs(data.get("did_not_work"), 12),
        "next_step": memlib.scrub_text(str(data.get("next_step", "")))[0].strip()[:600],
        "owner_preferences": prefs(data.get("owner_preferences"), 10),
    }
    return result


def summary_file(session_id):
    date = memlib._now_iso().split("T")[0]
    return os.path.join(memlib.sessions_dir(), f"{date}-{memlib.sid8(session_id)}.md")


def session_title(session_id, project):
    """Deterministic per-session memory title — store() upserts on its id, so a
    re-summarise REPLACES this session's record instead of appending."""
    date = memlib._now_iso().split("T")[0]
    return f"Session Log — {project} — {date} {memlib.sid8(session_id)}"


def meta_file(out_path):
    return out_path + ".meta.json"


def read_meta(out_path):
    """{user_msgs: int} from the sidecar, or None when absent/unreadable."""
    try:
        with open(meta_file(out_path), encoding="utf-8") as fh:
            meta = json.load(fh)
        return {"user_msgs": int(meta.get("user_msgs", 0))}
    except Exception:
        return None


def write_meta(out_path, user_msgs):
    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        tmp = meta_file(out_path) + ".tmp"
        memlib.write_private(tmp, json.dumps({"user_msgs": int(user_msgs)}))
        os.replace(tmp, meta_file(out_path))
    except Exception:
        pass


def needs_worker(payload):
    """Cheap PARENT-side check: skip spawning when the sidecar says nothing new.

    True (spawn) on SessionEnd, on a missing/unreadable sidecar or transcript,
    and whenever the tail user-message count grew by >= RESUME_DELTA.
    """
    try:
        if str(payload.get("hook_event_name") or "") == "SessionEnd":
            return True
        transcript = payload.get("transcript_path") or ""
        if not transcript or not os.path.isfile(transcript):
            return True  # let the worker log the skip
        meta = read_meta(summary_file(payload.get("session_id") or ""))
        if meta is None:
            return True  # never summarised (or unreadable sidecar) -> worker decides
        users = memlib.user_msg_count(transcript, TAIL_BYTES)
        if users is None:
            return True
        return users >= meta["user_msgs"] + RESUME_DELTA
    except Exception:
        return True


def _unlink_opencode_export(transcript):
    """Processed OpenCode transcript exports are temp files — remove them."""
    try:
        if fnmatch.fnmatch(transcript, OPENCODE_EXPORT_GLOB):
            os.unlink(transcript)
    except OSError:
        pass


def _summarize(payload, out_path, event, transcript, tail, size, session_id, cwd):
    conversation = memlib.parse_conversation(tail)
    users = memlib.count_user_messages(conversation)
    if users < MIN_USER_MSGS:
        memlib.log("summary_skip", sid=memlib.sid8(session_id), user_msgs=users,
                   transcript_bytes=size, reason="too_few_user_msgs")
        return
    meta = read_meta(out_path)
    if meta is None and os.path.isfile(out_path):
        # legacy summary from before sidecars: adopt the current count and skip
        write_meta(out_path, users)
        memlib.log("summary_skip", sid=memlib.sid8(session_id), user_msgs=users,
                   reason="legacy_summary_adopted")
        return
    if meta is not None and event != "SessionEnd" \
            and users < meta["user_msgs"] + RESUME_DELTA:
        # already summarised and <5 new user messages: keep the existing summary
        memlib.log("summary_skip", sid=memlib.sid8(session_id), user_msgs=users,
                   last_user_msgs=meta["user_msgs"], reason="no_new_msgs")
        return
    ledgers = []
    try:
        anchor = memlib.load_sibling("postcompact-anchor.py")
        ledgers = anchor.touched_ledgers(transcript)
    except Exception:
        pass
    project = memlib.project_of(cwd)
    prompt = build_prompt(conversation, project, session_id, ledgers)
    data = normalize_llm(memlib.llm_json(prompt, SYSTEM))
    if data is None:
        memlib.log("summary_llm_unavailable", sid=memlib.sid8(session_id),
                   transcript_bytes=size, prompt_chars=len(prompt))
        return "unavailable"
    markdown = render_markdown(memlib.sid8(session_id), project, data)
    try:
        os.makedirs(memlib.sessions_dir(), exist_ok=True)
        tmp = out_path + ".tmp"
        memlib.write_private(tmp, markdown)
        os.replace(tmp, out_path)  # overwrite the previous version of this session
    except Exception:
        memlib.log("summary_write_failed", sid=memlib.sid8(session_id))
        return
    write_meta(out_path, users)
    memlib.store_memory("session", "main", session_title(session_id, project),
                        markdown, tags=["session-log"], importance=5,
                        source="session-memory")
    for pref in data["owner_preferences"]:
        memlib.upsert_instinct(pref["statement"], pref["evidence"],
                               pref["confidence"], agent="main",
                               session_id=session_id)
    memlib.log("summary_written", sid=memlib.sid8(session_id), project=project,
               transcript_bytes=size, file_bytes=len(markdown.encode("utf-8")),
               user_msgs=users,
               last_user_msgs=(meta or {}).get("user_msgs", 0),
               prefs=len(data["owner_preferences"]))
    return "written"


RETRY_KEYS = ("session_id", "transcript_path", "hook_event_name", "cwd")


def worker(payload, retry=False):
    """Summarise one session. A failed LLM call is parked for replay (retry=False) and kept as
    'unavailable' for the drain (retry=True); a real write drains up to two parked sessions."""
    if not memlib.enabled():
        return None
    session_id = payload.get("session_id") or ""
    transcript = payload.get("transcript_path") or ""
    event = str(payload.get("hook_event_name") or "")
    if not transcript or not os.path.isfile(transcript):
        memlib.log("summary_skip", sid=memlib.sid8(session_id), reason="no_transcript")
        return None
    out_path = summary_file(session_id)
    result = None
    try:
        try:
            tail, size = memlib.conversation_tail(transcript, TAIL_BYTES)
        except OSError:
            memlib.log("summary_skip", sid=memlib.sid8(session_id), reason="unreadable")
            return None
        result = _summarize(payload, out_path, event, transcript, tail, size,
                            session_id, payload.get("cwd") or "")
    finally:
        if result == "unavailable":  # the OpenCode export stays on disk for the replay
            if not retry:
                memlib.spool_retry("summary", {k: payload.get(k) for k in RETRY_KEYS}, key=session_id)
        else:
            _unlink_opencode_export(transcript)
    if result == "written" and not retry:
        memlib.drain_retries("summary", lambda rec: worker(rec, retry=True))
    return result


def main():
    if not memlib.enabled():
        sys.exit(0)
    payload = collect_payload()
    if not needs_worker(payload):
        sys.exit(0)  # sidecar says nothing new — do not even spawn
    if memlib.detach_self(payload):
        os._exit(0)
    try:
        worker(payload)
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
