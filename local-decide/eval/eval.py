#!/usr/bin/env python3
"""local-decide evaluation harness.

Measures every GLiNER head the policy actually consumes (per-head accuracy,
abstain rate, false-block rate at the deployed gate, p50/p95 latency), runs the
end-to-end policy cases through `policy.evaluate`, and (with --code-loc) ranks
five retrieval strategies for the fast-explore code search.

Promotion rule (`--promote`): a head goes from log/warn to `mode: block` only
when its false-block rate is <= 5%, its accuracy is >= 90% and it has at least
40 labelled cases. The D11 complexity head additionally needs
precision(trivial) >= 90%. Every rules file is backed up to `<name>.bak.<ts>`
before a single `mode:` value is rewritten; no other key is ever touched.

Run in-process by default (the systemd unit is intentionally stopped):

    HF_HOME=/opt/local-ai/models/hf HF_HUB_OFFLINE=1 \
      /opt/local-ai/decide-venv/bin/python eval/eval.py --all --code-loc

`--url http://127.0.0.1:11438` runs the same sweep against the daemon instead.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# setup root: AI_SETUP_ROOT, else one level above this component (repo root)
SETUP_ROOT = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(ROOT)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# I-14: fixture cases must not land in the production decisions.jsonl. In-process policy
# runs (and tune.py, which imports this module) log here unless LOCAL_DECIDE_LOG is set;
# --url runs evaluate inside the daemon, which keeps its own log.
EVAL_DECISIONS_LOG = os.path.join(SETUP_ROOT, "state", "local-decide", "decisions-eval.jsonl")
os.environ.setdefault("LOCAL_DECIDE_LOG", EVAL_DECISIONS_LOG)

CASES_DIR = os.path.join(HERE, "cases")
RULES_DIR = os.path.join(ROOT, "rules")
POLICY_CASES = os.path.join(HERE, "policy_cases.jsonl")
CODE_LOC = os.path.join(HERE, "code_loc.jsonl")
DEFAULT_REPORT = os.path.join(SETUP_ROOT, "state", "local-decide", "eval-report.md")
CORPUS_ROOT = SETUP_ROOT
CORPUS_DIRS = ("claude-router", "local-decide", "scripts", "unified-memory",
               "skills", "rules", "subagents", "reference")

# Promotion thresholds (owner contract, INTERFACES.md).
PROMOTE_FB_MAX = 0.05
PROMOTE_ACC_MIN = 0.90
PROMOTE_N_MIN = 40
COMPLEXITY_TRIVIAL_PRECISION_MIN = 0.90
LATENCY_P95_MAX_MS = 400.0
CHUNK_CHARS = 2048            # policy.CHUNK: above this production passes long=True

# M5 (code review, 2026-10-02): these heads are never promoted by eval.py, whatever
# their measured numbers. Each one is an owner decision, not an automated one:
#   pii_secret  - a promoted D7 PII head denies writes; a false positive blocks real work
#   injection   - D13 has no `mode:` at all; it is warn-only by contract
#   complexity  - D11 lives in the router, has no rules/*.yaml `mode:` key, and a wrong
#                 `trivial` verdict silently downgrades the CEO's effort for the turn
NEVER_PROMOTE = ("pii_secret", "injection", "complexity")
CALIBRATED_THRESHOLD = 0.50          # bench-engine.md: the correct operating point
CALIBRATED_MARGIN = 0.0

VALID_MODES = ("log", "warn", "block")


# ---------------------------------------------------------------------------
# head registry
# ---------------------------------------------------------------------------
class Head:
    """One evaluated head.

    kind:      decide | pii | injection
    rule:      (yaml file, key path) the deployed head spec comes from
    fallback:  literal head spec when no yaml key owns it
    benign:    labels that mean "take no escalatory action" (FB denominator)
    mode_key:  (yaml file, key path) whose `mode:` --promote may rewrite, or None
    """

    def __init__(self, name: str, kind: str, rule=None, fallback=None,
                 benign=(), mode_key=None, min_conf: float = 0.0,
                 dynamic_benign: bool = False):
        self.name = name
        self.kind = kind
        self.rule = rule
        self.fallback = fallback
        self.benign = set(benign)
        self.mode_key = mode_key
        self.min_conf = min_conf
        self.dynamic_benign = dynamic_benign


COMPLEXITY_LABELS = {
    "trivial": "A one-line question, a trivial edit or a single command: no reasoning, no files, no gate.",
    "substantial": "Multi-file work, money-path or engine work, audits, design, or anything needing a plan and a verification gate.",
}

HEADS = [
    Head("domain", "decide", rule=("domains.yaml", ["domain"]),
         mode_key=("domains.yaml", ["domain"]), benign=["general"]),
    Head("lane", "decide", rule=("lanes.yaml", ["lane"]),
         mode_key=("lanes.yaml", ["lane"]), benign=[]),
    Head("needs_research", "decide", rule=("lanes.yaml", ["needs_research"]),
         mode_key=("lanes.yaml", ["needs_research"]), benign=["no"]),
    Head("best_agent", "decide", rule=("guardrail.yaml", ["d3", "best_agent"]),
         mode_key=("guardrail.yaml", ["d3", "best_agent"]),
         benign=[], dynamic_benign=True),
    Head("finished", "decide", rule=("guardrail.yaml", ["d6", "finished"]),
         mode_key=("guardrail.yaml", ["d6", "finished"]), benign=["no"]),
    Head("failure_signal", "decide", rule=("guardrail.yaml", ["d6", "failure_signal"]),
         mode_key=("guardrail.yaml", ["d6", "failure_signal"]), benign=["complete"]),
    Head("risk_tier", "decide", rule=("bash.yaml", ["risk_tier"]),
         mode_key=("bash.yaml", ["risk_tier"]), benign=["none", "low"]),
    Head("policy_mock_data", "decide", rule=("guardrail.yaml", ["d7", "policy_heads"]),
         mode_key=("guardrail.yaml", ["d7", "policy_heads"]), benign=["no"]),
    Head("policy_secret_material", "decide", rule=("guardrail.yaml", ["d7", "policy_heads"]),
         mode_key=("guardrail.yaml", ["d7", "policy_heads"]), benign=["no"]),
    Head("policy_destructive_sql", "decide", rule=("guardrail.yaml", ["d7", "policy_heads"]),
         mode_key=("guardrail.yaml", ["d7", "policy_heads"]), benign=["no"]),
    Head("retention", "decide", fallback="retention", benign=["keep"]),
    Head("complexity", "decide", fallback="complexity", benign=["substantial"]),
    Head("injection", "injection", fallback="injection", benign=["benign"], min_conf=0.80),
    Head("pii_secret", "pii", fallback="pii", benign=["none"], min_conf=0.90),
]

HEAD_BY_NAME = {h.name: h for h in HEADS}


def load_head_spec(head: Head) -> Optional[dict]:
    """The deployed head dict for `head`, read from the rules it ships with."""
    if head.rule:
        import policy
        cfg = policy._rules(head.rule[0][:-5])
        node = cfg
        for key in head.rule[1]:
            node = (node or {}).get(key) or {}
        labels = node.get("labels") or {}
        if not labels:
            raise SystemExit("head %s: no labels at %s" % (head.name, head.rule))
        return {"labels": labels,
                "threshold": float(node.get("threshold", 0.80)),
                "margin": float(node.get("margin", 0.15)),
                "mode": node.get("mode", "log")}
    if head.fallback == "retention":
        import mcp
        return {"labels": dict(mcp.RETENTION_LABELS),
                "threshold": float(mcp.DEFAULT_THRESHOLD),
                "margin": float(mcp.DEFAULT_MARGIN), "mode": None}
    if head.fallback == "complexity":
        # No named-head registry exists on the daemon (the router posts
        # {task:"complexity"}, which /v1/decide does not serve), so the label
        # set is owned by this harness. See RISKS in the report.
        return {"labels": dict(COMPLEXITY_LABELS),
                "threshold": 0.80, "margin": 0.15, "mode": None}
    if head.fallback == "injection":
        # GLiGuard is a fixed binary classifier, not a decide head: its label
        # pair comes from the checkpoint's JAILBREAK_LABELS and the gate is
        # d13.min_conf (engine.op_injection maps prompt_injection -> injection).
        import policy
        cfg = policy._rules("guardrail").get("d13") or {}
        return {"labels": {"injection": "prompt_injection", "benign": "benign"},
                "threshold": float(cfg.get("min_conf", 0.80)), "margin": 0.0,
                "mode": None}
    if head.fallback == "pii":
        # The PII span decoder; the gate is d7.pii.min_conf over d7.pii.secret_types.
        import policy
        cfg = (policy._rules("guardrail").get("d7") or {}).get("pii") or {}
        from engine import PII_LABELS
        return {"labels": {name: name for name in PII_LABELS},
                "threshold": float(cfg.get("min_conf", 0.90)), "margin": 0.0,
                "mode": cfg.get("mode")}
    return None


def read_cases(name: str) -> list:
    path = os.path.join(CASES_DIR, name + ".jsonl")
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            for key in ("text", "head", "expected_label", "source", "note"):
                if key not in row:
                    raise SystemExit("%s:%d missing %r" % (path, lineno, key))
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# engines
# ---------------------------------------------------------------------------
class InProcessEngine:
    def __init__(self):
        from engine import Engine
        self.engine = Engine()

    def decide(self, text, heads, long=False):
        return self.engine.decide(text, heads, long=long)

    def pii(self, text):
        return self.engine.pii(text)

    def injection(self, text):
        return self.engine.injection(text)

    def policy(self, agent, event, payload):
        import policy
        return policy.evaluate(agent, event, payload, self.engine)

    def stop(self):
        try:
            self.engine.stop()
        except Exception:
            pass


class DaemonEngine:
    """Same surface, over the daemon HTTP API."""

    # client.py's 3 s default is tuned for hooks; the daemon's own budget for a
    # chunked long-text call is 2 s x chunks up to 30 s (engine.MAX_CALL_TIMEOUT_S),
    # so a 3 s client timeout would turn every multi-chunk case into a phantom
    # abstain. E2 (2026-10-02): give --url runs a budget that covers the server.
    DAEMON_TIMEOUT_S = 90.0

    def __init__(self, url):
        import client
        client.base_url = lambda: url.rstrip("/")   # type: ignore[assignment]
        self.client = client
        self.url = url

    def decide(self, text, heads, long=False):
        return self.client.decide(text, heads, long=long,
                                  timeout=self.DAEMON_TIMEOUT_S) or {}

    def pii(self, text):
        return self.client.pii(text, timeout=self.DAEMON_TIMEOUT_S)

    def injection(self, text):
        return self.client.injection(text, timeout=self.DAEMON_TIMEOUT_S) or \
            {"label": "benign", "conf": 0.0}

    def policy(self, agent, event, payload):
        return self.client.hook(agent, event, payload)

    def stop(self):
        pass


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def pct(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return float(ordered[low] + (ordered[high] - ordered[low]) * (pos - low))


def _pct(value):
    return "n/a" if value is None else ("%.1f%%" % (100.0 * value))


# ---------------------------------------------------------------------------
# head sweep
# ---------------------------------------------------------------------------
def run_head(engine, head: Head, calibrated: bool) -> dict:
    spec = load_head_spec(head)
    cases = read_cases(head.name)
    rows = []
    for case in cases:
        text = case["text"]
        row = {"case": case, "label": None, "conf": 0.0, "margin": 0.0,
               "abstain": True, "reason": "", "ms": 0.0}
        if head.kind == "decide":
            # Mirror production: policy.py calls decide with long=True once the text
            # passes its CHUNK size, because Engine._budget only scales with the
            # chunk count. A flat 2 s budget on a multi-kilobyte text times out,
            # kills the worker and pays a ~12 s respawn (measured; see the report).
            long_call = len(text) > CHUNK_CHARS
            row["long"] = long_call
            schema = {head.name: {"labels": spec["labels"],
                                  "threshold": spec["threshold"],
                                  "margin": spec["margin"]}}
            before = _timeouts(engine)
            # A timed-out call kills the worker; Engine._call respawns it (a ~12 s
            # model reload) at the START of the NEXT call. The reload is therefore
            # charged to the following call, not to the one that timed out.
            row["tainted"] = _PENDING_TAINT[0]
            _PENDING_TAINT[0] = False
            t0 = time.perf_counter()
            out = engine.decide(text, schema, long=long_call)
            row["ms"] = (time.perf_counter() - t0) * 1000.0
            if isinstance(engine, DaemonEngine):
                time.sleep(0.2)                  # E2: sequential calls only, 0.2 s apart
            after = _timeouts(engine)
            if before is not None and after is not None and after > before:
                _PENDING_TAINT[0] = True
            res = (out or {}).get(head.name) or {}
            row.update({"label": res.get("label"), "conf": res.get("conf") or 0.0,
                        "margin": res.get("margin") or 0.0,
                        "abstain": bool(res.get("abstain", True)),
                        "reason": res.get("reason") or ""})
            if calibrated:
                loose = {head.name: {"labels": spec["labels"],
                                     "threshold": CALIBRATED_THRESHOLD,
                                     "margin": CALIBRATED_MARGIN}}
                out2 = engine.decide(text, loose, long=long_call)
                res2 = (out2 or {}).get(head.name) or {}
                row["cal_label"] = res2.get("label")
                row["cal_conf"] = res2.get("conf") or 0.0
                row["cal_abstain"] = bool(res2.get("abstain", True))
        elif head.kind == "pii":
            t0 = time.perf_counter()
            spans = []
            for chunk in _chunks(text, 2048):
                spans.extend(engine.pii(chunk) or [])
            row["ms"] = (time.perf_counter() - t0) * 1000.0
            types = _secret_types()
            best, best_conf = None, 0.0
            for span in spans:
                kind = str(span.get("type") or "")
                conf = float(span.get("conf") or 0.0)
                if kind in types and conf > best_conf:
                    best, best_conf = kind, conf
            if best and best_conf >= head.min_conf:
                row.update({"label": best, "conf": best_conf, "margin": 0.0,
                            "abstain": False, "reason": "selected"})
            else:
                row.update({"label": "none", "conf": best_conf, "margin": 0.0,
                            "abstain": False, "reason": "below_gate"})
        else:  # injection
            t0 = time.perf_counter()
            res = engine.injection(text) or {}
            row["ms"] = (time.perf_counter() - t0) * 1000.0
            label = str(res.get("label") or "benign")
            conf = float(res.get("conf") or 0.0)
            fires = label == "injection" and conf >= head.min_conf
            row.update({"label": label, "conf": conf, "margin": 0.0,
                        "abstain": not fires,
                        "reason": "gate" if fires else "below_gate"})
        rows.append(row)

    return summarise(head, spec, rows)


_PENDING_TAINT = [False]


def _timeouts(engine) -> Optional[int]:
    """Worker timeout counter, when the engine exposes one (in-process only)."""
    inner = getattr(engine, "engine", None)
    value = getattr(inner, "timeouts", None)
    return value if isinstance(value, int) else None


def _chunks(text, size):
    text = text or ""
    return [text[i:i + size] for i in range(0, max(len(text), 1), size)] or [""]


def _secret_types():
    import policy
    cfg = ((policy._rules("guardrail").get("d7") or {}).get("pii") or {})
    return set(cfg.get("secret_types") or ["api_key", "secret", "password", "token"])


def summarise(head: Head, spec: dict, rows: list) -> dict:
    n = len(rows)
    correct = sum(1 for r in rows
                  if not r["abstain"] and r["label"] == r["case"]["expected_label"])
    abstains = sum(1 for r in rows if r["abstain"])
    latencies = [r["ms"] for r in rows if not r.get("long")]
    long_latencies = [r["ms"] for r in rows if r.get("long")]

    negatives = []
    for r in rows:
        expected = r["case"]["expected_label"]
        if head.dynamic_benign:
            negative = True          # best_agent: the dispatch in this case is correct
        else:
            negative = expected in head.benign
        if "negative" in r["case"]:
            negative = bool(r["case"]["negative"])
        if negative:
            negatives.append(r)
    fires = 0
    for r in negatives:
        benign = {r["case"]["expected_label"]} if head.dynamic_benign else head.benign
        if not r["abstain"] and r["label"] not in benign:
            fires += 1
    fb = (fires / len(negatives)) if negatives else None

    per_label = {}
    for r in rows:
        key = r["case"]["expected_label"]
        slot = per_label.setdefault(key, {"n": 0, "hit": 0})
        slot["n"] += 1
        if not r["abstain"] and r["label"] == key:
            slot["hit"] += 1
    precisions = {}
    for key, slot in per_label.items():
        got = sum(1 for r in rows
                  if not r["abstain"] and r["label"] == key and r["abstain"] is False)
        precisions[key] = (slot["hit"] / got) if got else 0.0

    out = {
        "head": head.name, "kind": head.kind, "n": n,
        "threshold": spec.get("threshold"), "margin": spec.get("margin"),
        "mode": spec.get("mode"),
        "accuracy": (correct / n) if n else 0.0,
        "abstain_rate": (abstains / n) if n else 0.0,
        "fb": fb, "fb_n": len(negatives),
        "p50_ms": pct(latencies, 0.50), "p95_ms": pct(latencies, 0.95),
        "max_ms": max(latencies) if latencies else 0.0,
        "long_n": len(long_latencies),
        "long_p50_ms": pct(long_latencies, 0.50),
        "long_p95_ms": pct(long_latencies, 0.95),
        "timeouts": sum(1 for r in rows if r.get("reason") == "timeout"),
        "tainted": sum(1 for r in rows if r.get("tainted")),
        "precision": precisions,
        "real": sum(1 for r in rows if r["case"].get("source") == "real"),
        "rows": rows,
    }
    if calibrated_keys(rows):
        cal_correct = sum(1 for r in rows
                          if not r["cal_abstain"] and r["cal_label"] == r["case"]["expected_label"])
        cal_fires = sum(1 for r in rows
                        if r["case"]["expected_label"] in head.benign
                        and not r["cal_abstain"] and r["cal_label"] not in head.benign)
        cal_neg = sum(1 for r in rows if r["case"]["expected_label"] in head.benign)
        out["cal_accuracy"] = cal_correct / n if n else 0.0
        out["cal_fb"] = (cal_fires / cal_neg) if cal_neg else None
    return out


def calibrated_keys(rows):
    return any("cal_label" in r for r in rows)


# ---------------------------------------------------------------------------
# policy cases
# ---------------------------------------------------------------------------
def classify(body: Any, agent: str, event: str) -> str:
    """Agent-native hook body -> allow|deny|ask|warn|context|block."""
    if not isinstance(body, dict) or not body:
        return "allow"
    if agent == "claude":
        if event in ("SubagentStop", "Stop"):
            return "block" if body.get("decision") == "block" else "allow"
        node = body.get("hookSpecificOutput") or {}
        if not node:
            return "allow"
        decision = node.get("permissionDecision")
        if decision in ("deny", "ask", "allow"):
            return decision
        reason = node.get("permissionDecisionReason")
        context = node.get("additionalContext")
        if decision == "warn" or reason or context:
            return "warn" if reason else "context"
        return "allow"
    if agent == "opencode":
        action = body.get("action")
        if action == "warn":
            return "warn"
        if action == "deny":
            return "deny"
        if body.get("context"):
            return "context"
        return "allow"
    # agy: context and warn both arrive as additionalContext
    if body.get("decision") == "deny":
        return "deny"
    if body.get("additionalContext"):
        return "context"
    return "allow"


def read_policy_cases():
    rows = []
    with open(POLICY_CASES, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def run_policy(engine, only_deterministic: bool = False) -> dict:
    results = []
    for case in read_policy_cases():
        if only_deterministic and not case.get("deterministic"):
            continue
        t0 = time.perf_counter()
        body = engine.policy(case["agent"], case["event"], case["payload"])
        got = classify(body, case["agent"], case["event"])
        results.append({
            "id": case["id"], "decision_id": case.get("decision_id", ""),
            "expected": case["expected_action"], "got": got,
            "pass": got == case["expected_action"],
            "deterministic": bool(case.get("deterministic")),
            "note": case.get("note", ""),
            "ms": (time.perf_counter() - t0) * 1000.0,
            "body": json.dumps(body)[:220],
        })
    det = [r for r in results if r["deterministic"]]
    return {"results": results,
            "total": len(results),
            "passed": sum(1 for r in results if r["pass"]),
            "det_total": len(det),
            "det_failed": [r for r in det if not r["pass"]]}


# ---------------------------------------------------------------------------
# promotion
# ---------------------------------------------------------------------------
def promotion_verdict(metric: dict) -> dict:
    head = HEAD_BY_NAME[metric["head"]]
    reasons = []
    ok = True
    if head.name in NEVER_PROMOTE:
        return {"promote": False, "owner_decision": True,
                "reasons": ["owner decision (M5): never promoted by eval.py"]}
    if metric["n"] < PROMOTE_N_MIN:
        ok = False
        reasons.append("n=%d < %d" % (metric["n"], PROMOTE_N_MIN))
    if metric["accuracy"] < PROMOTE_ACC_MIN:
        ok = False
        reasons.append("accuracy=%s < 90%%" % _pct(metric["accuracy"]))
    if metric["fb"] is None:
        ok = False
        reasons.append("false-block unmeasurable (no benign class)")
    elif metric["fb"] > PROMOTE_FB_MAX:
        ok = False
        reasons.append("FB=%s > 5%%" % _pct(metric["fb"]))
    if head.name == "complexity":
        prec = metric["precision"].get("trivial", 0.0)
        if prec < COMPLEXITY_TRIVIAL_PRECISION_MIN:
            ok = False
            reasons.append("precision(trivial)=%s < 90%%" % _pct(prec))
    if head.mode_key is None:
        ok = False
        reasons.append("no `mode:` key owned by eval.py (owner decides)")
    return {"promote": ok, "owner_decision": False,
            "reasons": reasons or ["meets FB<=5%, acc>=90%, n>=40"]}


def apply_promotions(metrics, dry_run: bool = False) -> list:
    """Rewrite only the `mode:` value of the qualifying heads, after a backup."""
    verdicts = {m["head"]: promotion_verdict(m) for m in metrics}
    by_key = {}
    for head in HEADS:
        if head.mode_key is None:
            continue
        # mode_key holds a list path, so key the grouping on a hashable form.
        key = (head.mode_key[0], tuple(head.mode_key[1]))
        by_key.setdefault(key, []).append(head.name)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    actions = []
    for key, names in by_key.items():
        path_keys = [key[0], list(key[1])]
        if any(n in NEVER_PROMOTE for n in names):
            actions.append({"key": path_keys, "names": names, "action": "owner-decision",
                            "why": "M5: %s must never be promoted by eval.py"
                                   % ", ".join(n for n in names if n in NEVER_PROMOTE)})
            continue
        winners = [n for n in names if verdicts[n]["promote"]]
        if not winners:
            continue
        losers = [n for n in names if n not in winners]
        if losers:
            # One shared `mode:` key governs several heads: promoting it would
            # promote every head behind it. Only promote when they all qualify.
            actions.append({"key": path_keys, "names": names, "action": "skipped",
                            "why": "shared mode key, %s did not qualify" % ", ".join(losers)})
            continue
        path = os.path.join(RULES_DIR, path_keys[0])
        current = _current_mode(path, path_keys[1])
        if current == "block":
            actions.append({"key": path_keys, "names": names, "action": "already-block"})
            continue
        if dry_run:
            actions.append({"key": path_keys, "names": names, "action": "would-set-block",
                            "why": "current=%s" % current})
            continue
        shutil.copy2(path, "%s.bak.%s" % (path, stamp))
        _set_mode(path, path_keys[1], "block")
        actions.append({"key": path_keys, "names": names, "action": "set-block",
                        "backup": "%s.bak.%s" % (path, stamp), "previous": current})
    return actions


def _find_section(lines, keys):
    stack = []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$", line)
        if not match:
            continue
        indent, key = len(match.group(1)), match.group(2)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        if [k for _, k in stack] == list(keys):
            return index, indent
    return None, None


def _current_mode(path, keys):
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start, indent = _find_section(lines, keys)
    if start is None:
        return None
    for line in lines[start + 1:]:
        match = re.match(r"^(\s*)mode\s*:\s*(\w+)", line)
        if match:
            if len(match.group(1)) > indent:
                return match.group(2)
            break
        top = re.match(r"^(\s*)[A-Za-z0-9_.\-]+\s*:", line)
        if top and len(top.group(1)) <= indent:
            break
    return None


def _set_mode(path, keys, new_mode):
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start, indent = _find_section(lines, keys)
    if start is None:
        raise SystemExit("promote: section %s not found in %s" % (keys, path))
    for offset, line in enumerate(lines[start + 1:], start + 1):
        match = re.match(r"^(\s*)mode\s*:\s*(\w+)\s*(#.*)?$", line)
        if match and len(match.group(1)) > indent:
            # Rewrite the value only; a trailing comment is the owner's, keep it.
            lines[offset] = "%smode: %s%s" % (
                match.group(1), new_mode,
                ("  " + match.group(3).strip()) if match.group(3) else "")
            break
        top = re.match(r"^(\s*)[A-Za-z0-9_.\-]+\s*:", line)
        if top and len(top.group(1)) <= indent:
            raise SystemExit("promote: no mode: under %s in %s" % (keys, path))
    else:
        raise SystemExit("promote: no mode: under %s in %s" % (keys, path))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# code localisation
# ---------------------------------------------------------------------------
def _post_json(url, payload, timeout=120.0):
    import urllib.request
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"null")


def _embed(texts, port=11437):
    out = []
    for index in range(0, len(texts), 32):
        batch = texts[index:index + 32]
        data = _post_json("http://127.0.0.1:%d/v1/embeddings" % port,
                          {"input": batch})
        out.extend([row["embedding"] for row in data.get("data", [])])
    return out


def _rank_cosine(query, matrix):
    import numpy as np
    mat = np.asarray(matrix, dtype=np.float32)
    q = np.asarray(query, dtype=np.float32)
    denom = np.linalg.norm(mat, axis=1) * float(np.linalg.norm(q))
    denom = np.where(denom > 0, denom, 1.0)
    sims = (mat @ q) / denom
    order = np.argsort(-sims)
    return [(float(sims[i]), int(i)) for i in order]


def _cosine(a, b):
    """Reference implementation of the ranking metric (numpy path is used)."""
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if not na or not nb:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def build_corpus(chunk_lines=40, overlap=15):
    """File -> chunk list over the four corpus roots. Cached in the tmpdir."""
    cache = os.path.join(os.environ.get("CLAUDE_CODE_TMPDIR", "/var/tmp/claude"),
                         "local-decide-code-loc-v2.json")
    if os.path.exists(cache):
        with open(cache, "r", encoding="utf-8") as fh:
            return json.load(fh)
    exts = (".py", ".md", ".yaml", ".yml", ".js", ".ts", ".sh", ".json", ".sql")
    skip = {"node_modules", "__pycache__", ".git", "dist", "build", ".pytest_cache"}
    files, chunks, owner = [], [], []
    for root_dir in CORPUS_DIRS:
        base = os.path.join(CORPUS_ROOT, root_dir)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for name in sorted(filenames):
                if not name.endswith(exts) or ".bak" in name:
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, CORPUS_ROOT)
                try:
                    if os.path.getsize(path) > 400_000:
                        continue
                    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                        lines = fh.read().splitlines()
                except OSError:
                    continue
                if len(lines) < 5:
                    continue
                files.append(rel)
                for start in range(0, max(len(lines) - overlap, 1),
                                   max(chunk_lines - overlap, 1)):
                    window = lines[start:start + chunk_lines]
                    if not window:
                        break
                    text = "\n".join(window).strip()
                    if len(text) < 80:
                        continue
                    chunks.append(text)
                    owner.append(len(files) - 1)
                    if start + chunk_lines >= len(lines):
                        break
    data = {"files": files, "chunks": chunks, "owner": owner}
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return data


def _embed_cache_path():
    return os.path.join(os.environ.get("CLAUDE_CODE_TMPDIR", "/var/tmp/claude"),
                        "local-decide-embeddings-v2.npz")


def _embed_signature(chunks):
    import hashlib
    digest = hashlib.sha256()
    digest.update(str(len(chunks)).encode())
    for chunk in chunks:
        digest.update(chunk[:200].encode("utf-8", "ignore"))
    return digest.hexdigest()


def _embed_cache_hit(chunks):
    try:
        import numpy as np
        path = _embed_cache_path()
        if not os.path.exists(path):
            return False
        with np.load(path, allow_pickle=False) as data:
            return str(data["signature"]) == _embed_signature(chunks) and len(data["matrix"]) == len(chunks)
    except Exception:
        return False


def _embeddings(chunks):
    """Embed every chunk once, then reuse the cached matrix on later runs."""
    import numpy as np
    path = _embed_cache_path()
    signature = _embed_signature(chunks)
    if _embed_cache_hit(chunks):
        with np.load(path, allow_pickle=False) as data:
            return data["matrix"].tolist()
    print("[code-loc] embedding %d chunks ..." % len(chunks))
    t0 = time.perf_counter()
    matrix = _embed(chunks)
    print("[code-loc] embedded in %.1fs" % (time.perf_counter() - t0))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp.npz"
    np.savez(tmp, matrix=np.asarray(matrix, dtype=np.float32), signature=signature)
    os.replace(tmp, path)
    return matrix


def _tokens(text):
    return [t for t in re.findall(r"[A-Za-z0-9_]+", text.lower()) if len(t) > 2]


def code_loc(limit_rerank=20) -> dict:
    tasks = []
    with open(CODE_LOC, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                tasks.append(json.loads(line))
    corpus = build_corpus()
    files, chunks, owner = corpus["files"], corpus["chunks"], corpus["owner"]
    print("[code-loc] corpus: %d files, %d chunks" % (len(files), len(chunks)))

    matrix = _embeddings(chunks)
    print("[code-loc] embedding matrix %dx%d (cache %s)" % (
        len(matrix), len(matrix[0]) if matrix else 0,
        "hit" if _embed_cache_hit(chunks) else "miss"))

    stats = {name: {"a5": 0, "a10": 0, "ms": []} for name in
             ("rg-keyword", "embed-only", "rrf", "rrf+rerank-0.6b", "rrf+rerank-4b")}
    for task in tasks:
        query = task["query"]
        targets = set(task["targets"])

        # -- rg-keyword: lexical overlap over chunk text (a stand-in for ripgrep
        t0 = time.perf_counter()
        qtok = set(_tokens(query))
        lexical = []
        for index, chunk in enumerate(chunks):
            ctok = set(_tokens(chunk))
            if not ctok:
                continue
            overlap = len(qtok & ctok)
            if overlap:
                lexical.append((overlap / float(len(qtok | ctok)), index))
        lexical.sort(reverse=True)
        rg_files = _files_from(chunks, owner, [i for _, i in lexical[:limit_rerank]], files)
        stats["rg-keyword"]["ms"].append((time.perf_counter() - t0) * 1000.0)
        _score(stats["rg-keyword"], rg_files, targets)

        # -- embed-only
        t0 = time.perf_counter()
        qvec = _embed([query])[0]
        scored = _rank_cosine(qvec, matrix)
        emb_files = _files_from(chunks, owner, [i for _, i in scored[:limit_rerank]], files)
        stats["embed-only"]["ms"].append((time.perf_counter() - t0) * 1000.0)
        _score(stats["embed-only"], emb_files, targets)

        # -- RRF over the two ranked lists
        rrf = {}
        for rank, (_, index) in enumerate(lexical[:limit_rerank]):
            rrf[index] = rrf.get(index, 0.0) + 1.0 / (60 + rank + 1)
        for rank, (_, index) in enumerate(scored[:limit_rerank]):
            rrf[index] = rrf.get(index, 0.0) + 1.0 / (60 + rank + 1)
        fused = sorted(rrf.items(), key=lambda kv: -kv[1])
        rrf_files = _files_from(chunks, owner, [i for i, _ in fused[:limit_rerank]], files)
        stats["rrf"]["ms"].append((time.perf_counter() - t0) * 1000.0)
        _score(stats["rrf"], rrf_files, targets)

        # -- RRF + rerank, both sizes
        for name, port in (("rrf+rerank-0.6b", 11435), ("rrf+rerank-4b", 11439)):
            t0 = time.perf_counter()
            picked = [i for i, _ in fused[:limit_rerank]]
            try:
                payload = _post_json("http://127.0.0.1:%d/v1/rerank" % port,
                                     {"query": query,
                                      "documents": [chunks[i] for i in picked]})
                ranked = payload.get("results") or []
                order = [picked[int(r["index"])] for r in ranked if "index" in r]
            except Exception:
                order = picked
            files_ranked = _files_from(chunks, owner, order, files)
            stats[name]["ms"].append((time.perf_counter() - t0) * 1000.0)
            _score(stats[name], files_ranked, targets)

    out = {"tasks": len(tasks), "files": len(files), "chunks": len(chunks), "methods": {}}
    for name, row in stats.items():
        out["methods"][name] = {
            "acc5": row["a5"] / float(len(tasks)),
            "acc10": row["a10"] / float(len(tasks)),
            "p50_ms": pct(row["ms"], 0.50),
            "p95_ms": pct(row["ms"], 0.95),
        }
    return out


def _files_from(chunks, owner, indices, files):
    """Chunk indices -> de-duplicated corpus-relative file paths, best chunk first."""
    out, seen = [], set()
    for index in indices:
        f = files[owner[index]]
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def _score(stats, ranked_files, targets):
    top10 = ranked_files[:10]
    if targets & set(ranked_files[:5]):
        stats["a5"] += 1
    if targets & set(top10):
        stats["a10"] += 1


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
def render_report(metrics, policy, verdicts, loc, args, engine_label):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    lines = ["# local-decide evaluation report", "",
             "Generated %s by `eval/eval.py` (engine: %s)." % (now, engine_label), ""]

    lines += ["## Head sweep", "",
              "| head | n | real | acc@gate | acc@0.50 | abstain | FB (n) | p50 ms | p95 ms | mode |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for m in metrics:
        lines.append("| %s | %d | %d | %s | %s | %s | %s (%d) | %.0f | %.0f | %s |" % (
            m["head"], m["n"], m["real"], _pct(m["accuracy"]),
            _pct(m.get("cal_accuracy")), _pct(m["abstain_rate"]),
            _pct(m["fb"]), m["fb_n"], m["p50_ms"], m["p95_ms"],
            m["mode"] if m["mode"] else "n/a"))

    lat = [r["ms"] for m in metrics for r in m["rows"] if not r.get("long")]
    longlat = [r["ms"] for m in metrics for r in m["rows"] if r.get("long")]
    lines += ["", "Single-text decide latency (<= %d chars, long=False): p50 %.0f ms, "
              "p95 %.0f ms, max %.0f ms over %d calls (gate: p95 <= %.0f ms)." % (
                  CHUNK_CHARS, pct(lat, 0.50), pct(lat, 0.95),
                  max(lat) if lat else 0.0, len(lat), LATENCY_P95_MAX_MS)]
    if longlat:
        lines += ["", "Chunked calls (> %d chars, long=True as production does): %d calls, "
                  "p50 %.0f ms, p95 %.0f ms. These are excluded from the single-text gate "
                  "by construction: they are multi-chunk, not single-text." % (
                      CHUNK_CHARS, len(longlat), pct(longlat, 0.50), pct(longlat, 0.95))]
    lines.append("")

    lines += ["## Promotion table", "",
              "Rule: promote to `mode: block` only when FB <= 5%%, accuracy >= 90%%, n >= %d "
              "(complexity also needs precision(trivial) >= 90%%)." % PROMOTE_N_MIN, "",
              "| head | verdict | reason |", "|---|---|---|"]
    for m in metrics:
        v = verdicts[m["head"]]
        label = "PROMOTE" if v["promote"] else (
            "owner decision" if v.get("owner_decision") else "hold")
        lines.append("| %s | %s | %s |" % (m["head"], label, "; ".join(v["reasons"])))
    lines.append("")

    lines += ["## Policy cases", ""]
    if policy:
        lines += ["%d/%d pass overall, %d deterministic cases, %d deterministic failures." % (
            policy["passed"], policy["total"], policy["det_total"],
            len(policy["det_failed"])), "",
            "| id | D | expected | got | det | ok | note |", "|---|---|---|---|---|---|---|"]
        for row in policy["results"]:
            lines.append("| %s | %s | %s | %s | %s | %s | %s |" % (
                row["id"], row["decision_id"], row["expected"], row["got"],
                "y" if row["deterministic"] else "n", "PASS" if row["pass"] else "FAIL",
                row["note"]))
        lines.append("")
    else:
        lines += ["(not run)", ""]

    if loc:
        lines += ["## Code localisation", "",
                  "%d tasks over a corpus of %d files / %d chunks "
                  "(random baseline: Acc@5 %.0f%%, Acc@10 %.0f%%)." % (
                      loc["tasks"], loc["files"], loc["chunks"],
                      100 * min(5.0 / loc["files"], 1.0),
                      100 * min(10.0 / loc["files"], 1.0)), "",
                  "| method | Acc@5 | Acc@10 | p50 ms | p95 ms |", "|---|---|---|---|---|"]
        for name, row in loc["methods"].items():
            lines.append("| %s | %s | %s | %.0f | %.0f |" % (
                name, _pct(row["acc5"]), _pct(row["acc10"]), row["p50_ms"], row["p95_ms"]))
        lines.append("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def parse_args(argv):
    p = argparse.ArgumentParser(description="local-decide evaluation harness")
    p.add_argument("--all", action="store_true", help="head sweep + policy cases")
    p.add_argument("--heads", action="store_true", help="head sweep only")
    p.add_argument("--policy", action="store_true", help="policy cases only")
    p.add_argument("--policy-deterministic", action="store_true",
                   help="policy cases, deterministic only")
    p.add_argument("--code-loc", action="store_true", help="code-search benchmark")
    p.add_argument("--promote", action="store_true",
                   help="apply qualifying mode: block after a .bak.<ts> backup")
    p.add_argument("--dry-run-promote", action="store_true",
                   help="show what --promote would change without writing")
    p.add_argument("--url", default=None, help="daemon URL instead of the in-process engine")
    p.add_argument("--head", action="append", default=None, help="limit to one head")
    p.add_argument("--report", default=DEFAULT_REPORT)
    p.add_argument("--no-calibrated", action="store_true",
                   help="skip the second sweep at the calibrated 0.50 operating point")
    return p.parse_args(argv)


def run(argv):
    args = parse_args(argv)
    want_heads = args.all or args.heads or args.promote or args.dry_run_promote
    want_policy = args.all or args.policy or args.policy_deterministic
    if not (want_heads or want_policy or args.code_loc):
        args.all = True
        want_heads = want_policy = True

    engine_label = args.url or "in-process"
    engine = DaemonEngine(args.url) if args.url else InProcessEngine()
    rc = 0
    metrics, verdicts, policy, loc = [], {}, None, None
    try:
        if want_heads:
            names = args.head or [h.name for h in HEADS]
            for name in names:
                if name not in HEAD_BY_NAME:
                    raise SystemExit("unknown head %r" % name)
                head = HEAD_BY_NAME[name]
                t0 = time.perf_counter()
                metric = run_head(engine, head, calibrated=not args.no_calibrated)
                metrics.append(metric)
                verdicts[name] = promotion_verdict(metric)
                print("[head] %-24s n=%-3d acc=%-6s abstain=%-6s fb=%-6s p50=%.0fms p95=%.0fms (%.1fs)" % (
                    name, metric["n"], _pct(metric["accuracy"]),
                    _pct(metric["abstain_rate"]), _pct(metric["fb"]),
                    metric["p50_ms"], metric["p95_ms"], time.perf_counter() - t0))
                for row in metric["rows"]:
                    if not row["abstain"] and row["label"] != row["case"]["expected_label"]:
                        print("        miss %-8s exp=%-14s got=%-14s conf=%.2f  %s" % (
                            row["case"]["source"], row["case"]["expected_label"],
                            row["label"], row["conf"], row["case"]["text"][:60].replace("\n", " ")))

        if want_policy:
            policy = run_policy(engine, only_deterministic=args.policy_deterministic)
            for row in policy["results"]:
                if not row["pass"]:
                    print("[policy] FAIL %-8s exp=%-8s got=%-8s %s" % (
                        row["id"], row["expected"], row["got"], row["note"]))
            print("[policy] %d/%d pass (%d deterministic, %d deterministic failures)" % (
                policy["passed"], policy["total"], policy["det_total"],
                len(policy["det_failed"])))

        if args.code_loc:
            loc = code_loc()

        if args.dry_run_promote or args.promote:
            actions = apply_promotions(metrics, dry_run=not args.promote)
            print("\n[promote]")
            for action in actions:
                print("  %-28s %-16s %s" % (
                    "/".join(action["key"]), action["action"],
                    action.get("why") or action.get("backup") or ""))

        if metrics:
            latencies = [r["ms"] for m in metrics for r in m["rows"] if not r.get("long")]
            long_latencies = [r["ms"] for m in metrics for r in m["rows"] if r.get("long")]
            p95 = pct(latencies, 0.95)
            clean = [r["ms"] for m in metrics for r in m["rows"]
                     if not r.get("long") and not r.get("tainted")]
            if len(clean) < len(latencies):
                print("[gate] note %d single-text call(s) followed a worker kill and are "
                      "charged the ~12 s model reload; clean p95 would be %.0f ms" % (
                          len(latencies) - len(clean), pct(clean, 0.95)))
            slowest = sorted(metrics, key=lambda m: -m["p95_ms"])[:3]
            print("[gate] slowest single-text heads: " + ", ".join(
                "%s p95=%.0fms" % (m["head"], m["p95_ms"]) for m in slowest))
            if long_latencies:
                print("[gate] note chunked (long=True) calls: %d, p50 %.0f ms, p95 %.0f ms "
                      "(excluded from the single-text gate)" % (
                          len(long_latencies), pct(long_latencies, 0.50),
                          pct(long_latencies, 0.95)))
            timeouts = sum(m.get("timeouts", 0) for m in metrics)
            if timeouts:
                print("[gate] note %d decide call(s) hit the worker timeout" % timeouts)
            if p95 > LATENCY_P95_MAX_MS:
                print("[gate] FAIL single-text decide p95 %.0f ms > %.0f ms"
                      % (p95, LATENCY_P95_MAX_MS))
                rc = 1
            else:
                print("[gate] OK   single-text decide p95 %.0f ms <= %.0f ms"
                      % (p95, LATENCY_P95_MAX_MS))
        if policy and policy["det_failed"]:
            print("[gate] FAIL %d deterministic policy case(s): %s" % (
                len(policy["det_failed"]),
                ", ".join(r["id"] for r in policy["det_failed"])))
            rc = 1
        elif policy:
            print("[gate] OK   every deterministic policy case passed")
    finally:
        engine.stop()

    if metrics or policy or loc:
        report = render_report(metrics, policy, verdicts, loc, args, engine_label)
        os.makedirs(os.path.dirname(args.report), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(report)
        print("[report] %s" % args.report)
        if args.code_loc and loc:
            _print_recommendation(loc)
    return rc


def _print_recommendation(loc):
    rows = loc["methods"]
    base = rows["rrf"]
    best = max(rows.items(), key=lambda kv: (kv[1]["acc10"], -kv[1]["p50_ms"]))
    print("\n[code-loc] best Acc@10: %s (%.0f%%, p50 %.0f ms); RRF baseline %.0f%%" % (
        best[0], 100 * best[1]["acc10"], best[1]["p50_ms"], 100 * base["acc10"]))
    print("[code-loc] recommendation for fast-explore: %s" % _recommend(rows))


def _recommend(rows):
    """Pick the method fast-explore should serve, from measured accuracy and tail cost."""
    rrf = rows.get("rrf") or {}
    emb = rows.get("embed-only") or {}
    cheap = rows.get("rrf+rerank-0.6b") or {}
    fat = rows.get("rrf+rerank-4b") or {}
    rg = rows.get("rg-keyword") or {}
    if not cheap:
        return "RRF (no reranker endpoint answered)"
    best_acc = max(r["acc10"] for r in rows.values())
    gain = cheap["acc10"] - rrf["acc10"]
    cost = cheap["p95_ms"] - rrf["p95_ms"]
    parts = []
    if abs(emb.get("acc10", 0.0) - rrf.get("acc10", 0.0)) < 1e-9 and emb:
        parts.append("embed-only ties RRF at Acc@10 %.0f%% with one model call instead of a "
                     "keyword pass" % (100 * emb["acc10"]))
    if gain <= 0.0:
        parts.append("RRF+rerank-0.6B added %.0f points of Acc@10 over RRF while adding %.0f ms "
                     "at p95, so no reranker is justified on this corpus"
                     % (100 * gain, cost))
    elif cost < 250:
        parts.append("RRF+rerank-0.6B is worth it: +%.0f points of Acc@10 for +%.0f ms at p95"
                     % (100 * gain, cost))
    else:
        parts.append("RRF+rerank-0.6B gains %.0f points of Acc@10 but costs %.0f ms at p95; "
                     "use it only on a narrowed candidate set" % (100 * gain, cost))
    if fat and fat["acc10"] > best_acc - 1e-9 and fat["acc10"] > cheap["acc10"]:
        parts.append("the 4B reranker is the accuracy winner but %.0f ms at p50 makes it "
                     "unusable on the fast path" % fat["p50_ms"])
    if rg and rg["p50_ms"] < 50:
        parts.append("rg-keyword stays the fallback for exact identifier lookups (%.0f ms, "
                     "Acc@5 %.0f%%)" % (rg["p50_ms"], 100 * rg["acc5"]))
    return "; ".join(parts)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))