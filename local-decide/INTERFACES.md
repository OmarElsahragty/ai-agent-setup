# local-decide module contracts (Batch B, 2026-10-02)

Plan: `${AI_SETUP_ROOT}/state/local-decide/LEDGER.md` (+ research facts in `RESEARCH.md` beside it).
Python 3.12 venv: `/opt/local-ai/decide-venv` (gliner2[local]==2.0.0, torch CPU, fastapi, uvicorn, pyyaml, httpx).
Models (HF_HOME=/opt/local-ai/models/hf, offline): `fastino/GLiNER2.5-Decide`, `fastino/GLiNER2-Guardrails-PII-Multi`,
`fastino/gliguard-LLMGuardrails-300M`; revisions in `/opt/local-ai/models/REVISIONS.txt`.
Rerankers: llama.cpp `POST http://127.0.0.1:11435/v1/rerank` (0.6B) and `:11439` (4B); embeddings `:11437/v1/embeddings`.

## Files and owners
| file | owner | purpose |
|---|---|---|
| `engine.py` | server | `Engine` (below): model loading, killable worker process, timeouts, input caps, #178 pre-filter |
| `server.py` | server | FastAPI app on 127.0.0.1:11438; routes call `Engine` and `policy` |
| `client.py` | server | stdlib-only HTTP client (`decide`, `multi`, `rerank`, `hook`) — used by mcp.py, scripts, hooks |
| `policy.py` + `rules/*.yaml` + `decisions.py` | policy | hook decision logic D1–D9, D13; per-agent response shaping; JSONL logger |
| `mcp.py`, skills, `scripts/review-triage.py` | mcp | stdio MCP server + skills; talks to the daemon only through `client.py` |

## Engine API (engine.py) — synchronous, never raises on model errors (returns abstain/empty)
```python
Head = dict  # {"labels": {label: description}, "threshold": 0.80, "margin": 0.15}
Result = dict  # {"label": str|None, "conf": float, "margin": float, "abstain": bool, "reason": str}
class Engine:
    def decide(self, text: str, heads: dict[str, Head], long: bool = False) -> dict[str, Result]
        # ONE multi-head call; single-label per head; long=True → chunk 384 tok / overlap 64, aggregate max.
        # abstain when conf < threshold or margin < margin or negation pre-check fires on the head's labels.
    def pii(self, text: str) -> list[dict]          # [{"type": "api_key|secret|password|token|...", "conf": float, "start": int, "end": int}]
    def injection(self, text: str) -> dict          # {"label": "injection|benign", "conf": float}
    def rerank(self, query: str, docs: list[str], model: str = "0.6b", top_n: int | None = None) -> list[dict]  # [{"index": i, "score": s}] desc
    def health(self) -> dict
```
Caps: text ≤ 64 KB, ≤ 32 labels/head, ≤ 16 heads/call, 2 s timeout per call (worker killed + respawned on timeout → abstain).

## Policy API (policy.py)
```python
def evaluate(agent: str, event: str, payload: dict, engine: Engine) -> dict
    # agent ∈ {"claude","opencode","agy"}; event = native event name (Claude: UserPromptSubmit, PreToolUse,
    # PostToolUse, SubagentStart, SubagentStop, PreCompact; OpenCode: chat.message, tool.execute.before,
    # tool.execute.after, session.idle; agy: PreInvocation, PreToolUse, PostToolUse, Stop).
    # Returns the agent-native JSON body. Must never raise: on any internal error return the agent's
    # allow/no-op body ({} for Claude/agy, {"action":"allow"} for OpenCode) and log the error.
```
Every head has `mode: log|warn|block` in `rules/*.yaml`; deterministic rules always block; GLiNER heads block only
when mode=block (promoted by `eval/eval.py` when false-block ≤ 5%). Abstain = no action.

## Decision log
`${AI_SETUP_ROOT}/state/local-decide/decisions.jsonl`, one line per decision:
`{ts, agent, event, decision_id (D1..D15), head, label, conf, margin, mode, action, latency_ms, text_sha1, text_head (≤200 chars, secrets redacted)}`.
