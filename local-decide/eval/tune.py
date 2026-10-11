#!/usr/bin/env python3
"""Retune the 14 GLiNER heads on a dev / held-out split (E2, 2026-10-02).

Split contract (deterministic, per head):
    sha256(head + "\\x00" + text) % 100 < 60  ->  dev    (tuning allowed)
    otherwise                                 ->  held-out (measured once)

Tuning touches ONLY dev: label wording variants are scored on dev, and the
threshold x margin grid (0.30..0.90 step 0.05 x 0.00..0.20 step 0.05) is swept
client-side over raw scores, maximising accuracy subject to false-block <= 5%.
Held-out cases are measured ONCE, after the spec is frozen, at the deployed
gate -- never used for a choice.

RAM contract: every inference goes to the daemon at --url (default
http://127.0.0.1:11438); models (~5 GB) live there, never in this process.
Request concurrency is 1. Raw-score passes run at threshold=0, margin=0, which
makes the daemon return the top-1 label with its conf and top1-top2 margin for
every case; the deployed gate (conf >= threshold AND margin >= min_margin) is
then a pure client-side function, exactly as engine._Worker._ranked applies it.

Promotion (unchanged in spirit, evaluated on HELD-OUT):
    block: held-out FB <= 5% AND acc >= 90% AND n_total >= 40 AND head not in
           eval.NEVER_PROMOTE AND the mode key qualifies (shared keys need every
           head behind them to qualify).
    warn:  held-out FB <= 5% AND acc >= 85%.
    else:  stay log.

Stages: --stages tune,apply,heldout,report (default all). Raw scores are cached
under the state dir so re-runs do not re-hit the daemon.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import eval as evalmod                      # eval/eval.py: HEADS, specs, metrics

SETUP_ROOT = os.environ.get("AI_SETUP_ROOT") or os.path.dirname(ROOT)
STATE = os.path.join(SETUP_ROOT, "state", "local-decide")
CACHE_PATH = os.path.join(STATE, "tune-e2-cache.json")
RESULT_PATH = os.path.join(STATE, "tune-e2.json")
BASELINE_REPORT = os.path.join(STATE, "eval-report.md")
BACKUP_STAMP = "20261002-e2"

THRESHOLDS = [round(0.30 + 0.05 * i, 2) for i in range(13)]   # 0.30 .. 0.90
MARGINS = [0.00, 0.05, 0.10, 0.15, 0.20]
FB_MAX = 0.05
WARN_ACC_MIN = 0.85

TIMEOUT_S = 180.0
RETRIES = 4


# ---------------------------------------------------------------------------
# label wording variants (routing-card style: concise, discriminative)
# ---------------------------------------------------------------------------
DOMAIN_B = {
    "quant-trading": "Trading strategy work: broker orders, fees, backtests, engine, parity, oracles.",
    "homelab-infra": "Host and service ops: Docker, systemd, nginx, tunnels, backups, monitoring.",
    "agents-config": "Agent tooling: subagents, model routing, hooks, MCP, skills, rules files.",
    "jobs-hunter": "Job hunting: CVs, applications, interviews, postings, offers.",
    "portfolio": "Personal portfolio site: pages, design, content, deployment.",
    "general": "Anything else: generic coding, questions, small edits, conversation.",
}
LANE_B = {
    "DIRECT": "One tiny change: at most 3 files, one test command, no parallel work.",
    "MEDIUM": "Bigger change: over 3 files, or several independent edits run in parallel.",
    "HEAVY": "Deep engineering: C++ engine, quant math, money paths, parity or oracle work.",
}
NEEDS_RESEARCH_B = {
    "yes": "Cannot be answered locally: needs web pages, external docs, vendor or API facts.",
    "no": "Answerable from the local repo, files and memory; no internet needed.",
}
BEST_AGENT_B = {
    "implementer": "Small-to-medium code changes: create, fix, refactor, scaffold.",
    "quant-engineer": "Heavy quant work: C++ engine, quant math, money paths, parity oracles.",
    "code-reviewer": "Review code for correctness, security, regressions and clean structure.",
    "tester": "Find, run and reproduce tests, including negative controls.",
    "qa": "Verify acceptance: probe live APIs and gather browser evidence.",
    "security-reviewer": "Audit security only: exposure, auth, secrets, network.",
    "database-analyst": "Read-only database work: schema, queries, migrations, performance.",
    "research": "Internet research from external sources; the only web-access lane.",
    "homelab-operator": "Operate the host: Docker, systemd, network, backups.",
    "ui-designer": "UI/UX design: screens, design systems, tokens, handoff specs.",
    "android-engineer": "Native Android apps in Compose, verified on an emulator.",
    "Explore": "Fast read-only code discovery: find files, symbols, call paths.",
    "Plan": "Design-only planning: produce a plan, write no code.",
}
FINISHED_B = {
    "yes": "The report is complete: it states status, files changed, and gate evidence with exit codes.",
    "no": "The report is incomplete: missing status, files, or test evidence.",
}
FAILURE_B = {
    "failed": "Something failed: a non-zero exit, a failing test, or an error message.",
    "blocked": "Work stopped early: waiting on a dependency, a permission, or an answer.",
    "complete": "Everything succeeded: the deliverable is done and verified.",
}
POLICY_B = {
    "yes": "The content clearly breaks the specific rule it is being checked against.",
    "no": "The content is innocent: it complies with the rule being checked.",
}
RETENTION_B = {
    "keep": "Must survive compaction: user requests, owner rulings, decisions and reasons, file paths, commands, test results, recent turns.",
    "drop": "Safe to drop after compaction: repeated tool output, restated context, progress chatter, superseded drafts.",
}
COMPLEXITY_B = {
    "trivial": "A small ask: one question, one command, or a one-line edit with no verification gate.",
    "substantial": "Real work: multiple files, money or engine code, audits, plans, or anything needing a verification gate.",
}


def name_only(labels) -> list:
    if isinstance(labels, dict):
        return list(labels.keys())
    return list(labels)


def variants_for(head_name: str, deployed) -> list:
    """[(variant_id, labels)] -- variant A is the deployed wording."""
    out = [("A", deployed)]
    table = {
        "domain": [("B", DOMAIN_B), ("C", name_only(DOMAIN_B))],
        "lane": [("B", LANE_B), ("C", name_only(LANE_B))],
        "needs_research": [("B", NEEDS_RESEARCH_B)],
        "best_agent": [("B", BEST_AGENT_B), ("C", name_only(BEST_AGENT_B))],
        "finished": [("B", FINISHED_B)],
        "failure_signal": [("B", FAILURE_B), ("C", name_only(FAILURE_B))],
        "risk_tier": [],
        "policy_mock_data": [("B", POLICY_B)],
        "policy_secret_material": [("B", POLICY_B)],
        "policy_destructive_sql": [("B", POLICY_B)],
        "retention": [("B", RETENTION_B)],
        "complexity": [("B", COMPLEXITY_B), ("C", name_only(COMPLEXITY_B))],
        "injection": [],
        "pii_secret": [],
    }
    for vid, labels in table.get(head_name, []):
        out.append((vid, labels))
    return out


# joint heads: one yaml section drives several heads (labels + gate shared)
JOINT_GROUPS = {"policy_mock_data", "policy_secret_material", "policy_destructive_sql"}

EDITABLE = {          # head -> (yaml file, key path); None = no deployable home here
    "domain": ("rules/domains.yaml", ["domain"]),
    "lane": ("rules/lanes.yaml", ["lane"]),
    "needs_research": ("rules/lanes.yaml", ["needs_research"]),
    "best_agent": ("rules/guardrail.yaml", ["d3", "best_agent"]),
    "finished": ("rules/guardrail.yaml", ["d6", "finished"]),
    "failure_signal": ("rules/guardrail.yaml", ["d6", "failure_signal"]),
    "risk_tier": None,                                  # bash.yaml owned by another worker
    "policy_mock_data": ("rules/guardrail.yaml", ["d7", "policy_heads"]),
    "policy_secret_material": ("rules/guardrail.yaml", ["d7", "policy_heads"]),
    "policy_destructive_sql": ("rules/guardrail.yaml", ["d7", "policy_heads"]),
    "retention": None,                                  # mcp.py owned elsewhere
    "complexity": ("eval/eval.py", ["COMPLEXITY_LABELS"]),
    "injection": ("rules/guardrail.yaml", ["d13"]),     # min_conf only, labels fixed
    "pii_secret": ("rules/guardrail.yaml", ["d7", "pii"]),  # min_conf only, labels fixed
}

# The d7.policy_heads section carries the owner comment "log only, never
# block" -- mode is never rewritten there. policy.py also hardcodes the action
# to log for these heads.
MODE_LOCKED_LOG = {"policy_mock_data", "policy_secret_material", "policy_destructive_sql"}


# ---------------------------------------------------------------------------
# split
# ---------------------------------------------------------------------------
def split_of(head_name: str, text: str) -> str:
    digest = hashlib.sha256((head_name + "\x00" + text).encode("utf-8")).hexdigest()
    return "dev" if (int(digest[:16], 16) % 100) < 60 else "heldout"


# ---------------------------------------------------------------------------
# daemon client (concurrency 1, retries)
# ---------------------------------------------------------------------------
def post_json(url: str, payload: dict, timeout: float = TIMEOUT_S) -> Optional[dict]:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"null")


def wait_healthy(url: str, deadline_s: float = 900.0) -> None:
    t0 = time.time()
    while time.time() - t0 < deadline_s:
        try:
            health = _get_health(url)
            if health and health.get("models_loaded"):
                return
        except Exception:
            pass
        time.sleep(5.0)
    raise SystemExit("daemon at %s never reported models_loaded" % url)


def _get_health(url: str) -> Optional[dict]:
    base = url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    with urllib.request.urlopen(base + "/health", timeout=5.0) as response:
        return json.loads(response.read() or b"null")


class HealthChanged(RuntimeError):
    """The daemon worker restarted (or timed out) mid-stage: the stage's fresh
    measurements are INVALID and must be discarded, not counted as abstains."""


def health_snapshot(url: str) -> dict:
    try:
        h = _get_health(url) or {}
    except Exception:                       # daemon mid-restart: connection refused etc.
        return {"restarts": None, "timeouts": None, "worker_pid": None,
                "models_loaded": False}
    return {"restarts": h.get("restarts"), "timeouts": h.get("timeouts"),
            "worker_pid": h.get("worker_pid"),
            "models_loaded": bool(h.get("models_loaded"))}


# set at each stage start: the daemon state this stage's measurements belong to.
# A mid-stage SERVICE restart (counters reset -> restarts < stage baseline) may
# change engine config (E2: the 08:19 restart flipped the 8 s budget + 4096-char
# cap live), so the stage aborts and must be rerun; a plain worker respawn
# (counters only grow) keeps the config and only the provenance record changes.
STAGE_BASE = {"restarts": None, "worker_pid": None}


def stage_begin(url: str) -> dict:
    snap = wait_for_load(url)
    STAGE_BASE["restarts"] = snap.get("restarts")
    STAGE_BASE["worker_pid"] = snap.get("worker_pid")
    return snap


def check_service_restart(snap: dict) -> None:
    base_r = STAGE_BASE.get("restarts")
    if base_r is not None and snap.get("restarts") is not None \
            and snap["restarts"] < base_r:
        raise SystemExit(
            "SERVICE-RESTART mid-run: daemon counters reset (%s -> %s); the stage "
            "spans an engine-config boundary and is INVALID -- rerun it."
            % (base_r, snap["restarts"]))


def health_key(snap: dict):
    return (snap.get("restarts"), snap.get("timeouts"))


def wait_for_load(url: str, deadline_s: float = 900.0) -> dict:
    """Block until the daemon reports models_loaded; return the health snapshot."""
    t0 = time.time()
    while time.time() - t0 < deadline_s:
        snap = health_snapshot(url)
        if snap.get("models_loaded"):
            check_service_restart(snap)
            return snap
        time.sleep(5.0)
    raise RuntimeError("daemon worker never finished loading (waited %ds)" % deadline_s)


def raw_decide(url: str, text: str, head_name: str, labels, long_call: bool) -> dict:
    """One raw-score pass: threshold=0, margin=0 -> always returns label/conf/margin.

    E2 data-integrity contract: an empty or failed response is NEVER accepted as
    a score (phantom abstains). The worker must be loaded before the request; a
    failed call is retried, and persistent failure raises. Calls are strictly
    sequential with a 0.2 s pause (live hooks share this worker). Every entry
    records the daemon counters + worker pid it was collected at."""
    snap = health_snapshot(url)
    if not snap.get("models_loaded"):
        snap = wait_for_load(url)
    check_service_restart(snap)
    payload = {"text": text,
               "heads": {head_name: {"labels": labels, "threshold": 0.0, "margin": 0.0}},
               "long": bool(long_call)}
    last = None
    for attempt in range(RETRIES):
        try:
            out = post_json(url + "/v1/decide", payload) or {}
            res = (out.get(head_name) or {})
            if res:
                return {"label": res.get("label"), "conf": float(res.get("conf") or 0.0),
                        "margin": float(res.get("margin") or 0.0),
                        "hkey": [snap.get("restarts"), snap.get("timeouts"),
                                 snap.get("worker_pid")]}
            last = "empty"
        except Exception as exc:                        # noqa: BLE001 - retry any transport error
            last = "%s: %s" % (type(exc).__name__, exc)
        time.sleep(0.2)
        snap = health_snapshot(url)
        if not snap.get("models_loaded"):
            snap = wait_for_load(url)
        check_service_restart(snap)
        time.sleep(2.0 * (attempt + 1))
    raise RuntimeError("daemon call failed after %d tries: %s" % (RETRIES, last))


def cache_key(head_name: str, labels, text: str) -> str:
    canon = json.dumps(labels, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256((head_name + "\x00" + canon + "\x00" + text)
                          .encode("utf-8")).hexdigest()


class RawCache:
    def __init__(self, path: str):
        self.path = path
        self.data = {}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                self.data = json.load(fh)

    def get(self, key):
        return self.data.get("v1", {}).get(key)

    def put(self, key, value):
        self.data.setdefault("v1", {})[key] = value

    def save(self):
        tmp = self.path + ".tmp"
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh)
        os.replace(tmp, self.path)


# ---------------------------------------------------------------------------
# metrics -- mirrors eval.summarise exactly, but gated client-side
# ---------------------------------------------------------------------------
def is_negative(head, case) -> bool:
    if head.dynamic_benign:
        return True
    if "negative" in case:
        return bool(case["negative"])
    return case["expected_label"] in head.benign


def benign_set(head, case) -> set:
    return {case["expected_label"]} if head.dynamic_benign else set(head.benign)


def gate_metrics(head, raw_rows, threshold: float, margin_gate: float) -> dict:
    """raw_rows: [{case, label, conf, margin}] for decide heads."""
    n = len(raw_rows)
    correct = abstain = 0
    negatives = [r for r in raw_rows if is_negative(head, r["case"])]
    fires = 0
    per_label = {}
    for r in raw_rows:
        hit = (r["conf"] >= threshold) and (r["margin"] >= margin_gate)
        if not hit:
            abstain += 1
        else:
            if r["label"] == r["case"]["expected_label"]:
                correct += 1
            if is_negative(head, r["case"]) and r["label"] not in benign_set(head, r["case"]):
                fires += 1
        key = r["case"]["expected_label"]
        slot = per_label.setdefault(key, {"n": 0, "hit": 0, "got": 0})
        slot["n"] += 1
        if hit and r["label"] == key:
            slot["hit"] += 1
            slot["got"] += 1
    fb = (fires / len(negatives)) if negatives else None
    return {"n": n, "accuracy": correct / n if n else 0.0,
            "abstain_rate": abstain / n if n else 0.0, "fb": fb,
            "fb_n": len(negatives), "fb_fires": fires,
            "precision": {k: (v["hit"] / v["got"]) if v["got"] else 0.0
                          for k, v in per_label.items()}}


def select_point(head, raw_rows):
    """max accuracy s.t. FB <= 5%; ties -> lower FB, then higher threshold, then higher margin."""
    best = None
    for threshold in THRESHOLDS:
        for margin_gate in MARGINS:
            m = gate_metrics(head, raw_rows, threshold, margin_gate)
            feasible = (m["fb"] is not None and m["fb"] <= FB_MAX) or m["fb"] is None
            if m["fb"] is None:
                feasible = True                     # lane: FB unmeasurable
            rank = (1 if feasible else 0, m["accuracy"],
                    -(m["fb"] if m["fb"] is not None else 1.0),
                    threshold, margin_gate)
            if best is None or rank > best[0]:
                best = (rank, threshold, margin_gate, m)
    return best[1], best[2], best[3]


# ---------------------------------------------------------------------------
# special heads: injection / pii (fixed checkpoint labels, conf gate only)
# ---------------------------------------------------------------------------
def raw_injection(url: str, cases, baseline=None):
    out = []
    for index, case in enumerate(cases):
        snap = health_snapshot(url)
        if not snap.get("models_loaded"):
            snap = wait_for_load(url)
        t0 = time.perf_counter()
        res = None
        for attempt in range(RETRIES):
            try:
                res = post_json(url + "/v1/guard/injection", {"text": case["text"]}) or {}
                if res:
                    break
                res = None
            except Exception:
                res = None
            snap = health_snapshot(url)
            if not snap.get("models_loaded"):
                snap = wait_for_load(url)
            time.sleep(2.0 * (attempt + 1))
        if res is None:
            raise RuntimeError("injection call failed for %r" % case["text"][:40])
        out.append({"case": case, "label": str(res.get("label") or "benign"),
                    "conf": float(res.get("conf") or 0.0),
                    "ms": (time.perf_counter() - t0) * 1000.0,
                    "hkey": [snap.get("restarts"), snap.get("timeouts"),
                             snap.get("worker_pid")]})
        time.sleep(0.2)
    return out


def raw_pii(url: str, cases, baseline=None):
    import eval as ev
    types = ev._secret_types()
    out = []
    for index, case in enumerate(cases):
        snap = health_snapshot(url)
        if not snap.get("models_loaded"):
            snap = wait_for_load(url)
        spans = []
        ms0 = time.perf_counter()
        for chunk in ev._chunks(case["text"], 2048):
            got = None
            for attempt in range(RETRIES):
                try:
                    got = post_json(url + "/v1/guard/pii", {"text": chunk}) or []
                    break
                except Exception:
                    time.sleep(2.0 * (attempt + 1))
            if got is None:
                raise RuntimeError("pii call failed for %r" % case["text"][:40])
            spans.extend(got)
        best, best_conf = None, 0.0
        for span in spans:
            kind = str(span.get("type") or "")
            conf = float(span.get("conf") or 0.0)
            if kind in types and conf > best_conf:
                best, best_conf = kind, conf
        out.append({"case": case, "best": best, "conf": best_conf,
                    "ms": (time.perf_counter() - ms0) * 1000.0,
                    "hkey": [snap.get("restarts"), snap.get("timeouts"),
                             snap.get("worker_pid")]})
        time.sleep(0.2)
    return out


def injection_metrics(raw_rows, min_conf: float) -> dict:
    """Mirrors eval.summarise for the injection kind: the head 'fires' only when
    the top label is injection at conf >= min_conf; a benign top-1 is an abstain
    (a miss), exactly as eval.py counts it."""
    n = len(raw_rows)
    correct = fires = 0
    negatives = [r for r in raw_rows if r["case"]["expected_label"] == "benign"]

    def fired(r):
        return r["label"] == "injection" and r["conf"] >= min_conf

    for r in raw_rows:
        if fired(r):
            fires += 1
            if r["label"] == r["case"]["expected_label"]:
                correct += 1
    fb = (sum(1 for r in negatives if fired(r)) / len(negatives)) if negatives else None
    got = fires
    prec = (sum(1 for r in raw_rows
                if fired(r) and r["case"]["expected_label"] == "injection") / got) if got else 0.0
    return {"n": n, "accuracy": correct / n if n else 0.0,
            "abstain_rate": 1.0 - fires / n if n else 0.0, "fb": fb,
            "fb_n": len(negatives), "fb_fires": sum(1 for r in negatives if fired(r)),
            "precision": {"injection": prec}}


def pii_metrics(raw_rows, min_conf: float) -> dict:
    n = len(raw_rows)
    correct = 0
    negatives = [r for r in raw_rows if r["case"]["expected_label"] == "none"]
    fires = 0
    for r in raw_rows:
        fired = r["best"] is not None and r["conf"] >= min_conf
        label = r["best"] if fired else "none"
        if label == r["case"]["expected_label"]:
            correct += 1
        if fired:
            fires += 1
    fb = (sum(1 for r in negatives if r["best"] is not None and r["conf"] >= min_conf)
          / len(negatives)) if negatives else None
    got = sum(1 for r in raw_rows if r["best"] is not None and r["conf"] >= min_conf)
    prec = {}
    for key in {r["best"] for r in raw_rows if r["best"] is not None and r["conf"] >= min_conf}:
        hits = sum(1 for r in raw_rows
                   if r["best"] == key and r["conf"] >= min_conf
                   and r["case"]["expected_label"] == key)
        prec[key] = hits / got if got else 0.0
    return {"n": n, "accuracy": correct / n if n else 0.0,
            "abstain_rate": 0.0, "fb": fb, "fb_n": len(negatives),
            "fb_fires": sum(1 for r in negatives
                            if r["best"] is not None and r["conf"] >= min_conf),
            "precision": prec}


# ---------------------------------------------------------------------------
# yaml / code writers (backup once, then surgical edit)
# ---------------------------------------------------------------------------
def backup(path: str) -> str:
    bak = "%s.bak.%s" % (path, BACKUP_STAMP)
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    return bak


def find_section(lines, keys):
    return evalmod._find_section(lines, keys)


def get_scalar(path, keys, key):
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start, indent = find_section(lines, keys)
    if start is None:
        raise SystemExit("section %s not found in %s" % (keys, path))
    for line in lines[start + 1:]:
        m = re.match(r"^(\s*)%s\s*:\s*(.*?)\s*(#.*)?$" % re.escape(key), line)
        if m and len(m.group(1)) > indent:
            return m.group(2)
        top = re.match(r"^(\s*)[A-Za-z0-9_.\-]+\s*:", line)
        if top and len(top.group(1)) <= indent:
            break
    return None


def set_scalar(path, keys, key, value):
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start, indent = find_section(lines, keys)
    if start is None:
        raise SystemExit("section %s not found in %s" % (keys, path))
    for offset, line in enumerate(lines[start + 1:], start + 1):
        m = re.match(r"^(\s*)%s\s*:\s*(.*?)\s*(#.*)?$" % re.escape(key), line)
        if m and len(m.group(1)) > indent:
            lines[offset] = "%s%s: %s%s" % (
                m.group(1), key, value,
                ("  " + m.group(3).strip()) if m.group(3) else "")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
            os.replace(tmp, path)
            return
        top = re.match(r"^(\s*)[A-Za-z0-9_.\-]+\s*:", line)
        if top and len(top.group(1)) <= indent:
            break
    raise SystemExit("key %s not found under %s in %s" % (key, keys, path))


def yaml_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def set_labels(path, keys, labels) -> None:
    """Replace the `labels:` mapping under `keys` with a new one (dict only)."""
    if not isinstance(labels, dict):
        raise SystemExit("set_labels supports dict label sets only (got %s)"
                         % type(labels).__name__)
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start, indent = find_section(lines, keys)
    if start is None:
        raise SystemExit("section %s not found in %s" % (keys, path))
    begin = end = None
    child = " " * (indent + 2)
    for offset in range(start + 1, len(lines)):
        line = lines[offset]
        m = re.match(r"^(\s*)labels\s*:\s*(#.*)?$", line)
        if m and len(m.group(1)) > indent:
            begin = offset
            continue
        if begin is not None:
            top = re.match(r"^(\s*)[A-Za-z0-9_.\-]+\s*:", line)
            if top and len(top.group(1)) <= indent:
                end = offset
                break
    if begin is None:
        raise SystemExit("labels block not found under %s in %s" % (keys, path))
    if end is None:
        end = len(lines)
    block = ["%slabels:" % child] + [
        "%s%s: %s" % (" " * (indent + 4), yaml_quote(k), yaml_quote(v))
        for k, v in labels.items()]
    lines[begin:end] = block
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp, path)


def set_complexity_labels(labels) -> None:
    """Rewrite eval.COMPLEXITY_LABELS in eval/eval.py (the head's only home)."""
    path = os.path.join(ROOT, "eval", "eval.py")
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    block = 'COMPLEXITY_LABELS = {\n' + "".join(
        '    "%s": "%s",\n' % (k, v.replace('"', '\\"')) for k, v in labels.items()) + '}\n'
    new_text, count = re.subn(r'COMPLEXITY_LABELS = \{.*?\}\n', block, text,
                              count=1, flags=re.S)
    if count != 1:
        raise SystemExit("COMPLEXITY_LABELS block not found in eval.py")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(new_text)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# stages
# ---------------------------------------------------------------------------
def collect_raw(args, head, variant_id, labels, cases, cache, force=False,
                baseline=None):
    """baseline is recorded per stage for the report; entries carry their own
    per-request provenance (hkey), so a mid-stage worker reload never turns an
    empty response into a score -- raw_decide retries/waits and tags the entry
    with the counters it was actually collected at."""
    rows = []
    for index, case in enumerate(cases):
        key = cache_key(head.name, labels, case["text"])
        cached = cache.get(key)
        if cached is None or force:
            long_call = len(case["text"]) > evalmod.CHUNK_CHARS
            t0 = time.perf_counter()
            res = raw_decide(args.url, case["text"], head.name, labels, long_call)
            res["ms"] = (time.perf_counter() - t0) * 1000.0
            cache.put(key, res)
            cached = res
            time.sleep(0.2)                     # CEO E2: pause between sequential calls
        rows.append({"case": case, "label": cached["label"],
                     "conf": cached["conf"], "margin": cached["margin"],
                     "ms": cached.get("ms", 0.0),
                     "hkey": cached.get("hkey")})
        if (index + 1) % 10 == 0:
            cache.save()
            print("    [%s/%s] %d/%d" % (head.name, variant_id, index + 1, len(cases)),
                  flush=True)
    cache.save()
    return rows


def run(args):
    evalmod_chosen = {}
    cache = RawCache(CACHE_PATH)
    specs = {h.name: evalmod.load_head_spec(h) for h in evalmod.HEADS}
    cases_by_head = {h.name: evalmod.read_cases(h.name) for h in evalmod.HEADS}
    split_by_head = {name: [split_of(name, c["text"]) for c in cases]
                     for name, cases in cases_by_head.items()}

    # stash the baseline (pre-retune) report table before anything regenerates it
    baseline_table = None
    if os.path.exists(BASELINE_REPORT):
        with open(BASELINE_REPORT, "r", encoding="utf-8") as fh:
            text = fh.read()
        m = re.search(r"## Head sweep\n\n(\|.*?\n)\n", text, re.S)
        if m:
            baseline_table = m.group(1)

    # ---------------- tune (dev only) ----------------
    tune_snap = stage_begin(args.url)
    tune_base = health_key(tune_snap)
    choices = {}
    for head in evalmod.HEADS:
        name = head.name
        spec = specs[name]
        cases = cases_by_head[name]
        dev_cases = [c for c, s in zip(cases, split_by_head[name]) if s == "dev"]
        if head.kind == "decide":
            variants = variants_for(name, spec["labels"])
            scored = []
            for vid, labels in variants:
                print("[tune] %s variant %s (%d dev cases)" % (name, vid, len(dev_cases)),
                      flush=True)
                raw = collect_raw(args, head, vid, labels, dev_cases, cache,
                                  baseline=tune_base)
                threshold, margin_gate, metrics = select_point(head, raw)
                print("      -> th=%.2f mg=%.2f acc=%.1f%% fb=%s" % (
                    threshold, margin_gate, 100 * metrics["accuracy"],
                    "n/a" if metrics["fb"] is None else "%.1f%%" % (100 * metrics["fb"])))
                scored.append({"variant": vid, "labels": labels, "threshold": threshold,
                               "margin": margin_gate, "dev": metrics})

            def rank_key(s):
                return (s["dev"]["accuracy"],
                        -(s["dev"]["fb"] if s["dev"]["fb"] is not None else 1.0))

            # Deployment homes carry dict labels; name-only variants are reported
            # for comparison but never deployed.
            dict_scored = [s for s in scored if isinstance(s["labels"], dict)]
            best = max(dict_scored, key=rank_key)
            for s in dict_scored:                    # prefer deployed wording on exact ties
                if s["variant"] == "A":
                    if rank_key(s) == rank_key(best):
                        best = s
                    break
            name_only_best = max(scored, key=rank_key)
            if not isinstance(name_only_best["labels"], dict):
                best["name_only_note"] = {
                    "variant": name_only_best["variant"],
                    "dev_accuracy": name_only_best["dev"]["accuracy"]}
            choices[name] = best
        elif head.kind == "injection":
            raw = raw_injection(args.url, dev_cases, baseline=tune_base)
            best_pt = None
            for mc in THRESHOLDS:
                m = injection_metrics(raw, mc)
                feasible = m["fb"] is None or m["fb"] <= FB_MAX
                rank = (1 if feasible else 0, m["accuracy"],
                        -(m["fb"] if m["fb"] is not None else 1.0), mc)
                if best_pt is None or rank > best_pt[0]:
                    best_pt = (rank, mc, m)
            print("[tune] injection min_conf=%.2f acc=%.1f%% fb=%s" % (
                best_pt[1], 100 * best_pt[2]["accuracy"],
                "n/a" if best_pt[2]["fb"] is None else "%.1f%%" % (100 * best_pt[2]["fb"])))
            choices[name] = {"variant": "A", "labels": spec["labels"],
                             "threshold": best_pt[1], "margin": 0.0, "dev": best_pt[2]}
        elif head.kind == "pii":
            raw = raw_pii(args.url, dev_cases, baseline=tune_base)
            best_pt = None
            for mc in THRESHOLDS:
                m = pii_metrics(raw, mc)
                feasible = m["fb"] is None or m["fb"] <= FB_MAX
                rank = (1 if feasible else 0, m["accuracy"],
                        -(m["fb"] if m["fb"] is not None else 1.0), mc)
                if best_pt is None or rank > best_pt[0]:
                    best_pt = (rank, mc, m)
            print("[tune] pii_secret min_conf=%.2f acc=%.1f%% fb=%s" % (
                best_pt[1], 100 * best_pt[2]["accuracy"],
                "n/a" if best_pt[2]["fb"] is None else "%.1f%%" % (100 * best_pt[2]["fb"])))
            choices[name] = {"variant": "A", "labels": spec["labels"],
                             "threshold": best_pt[1], "margin": 0.0, "dev": best_pt[2]}

    # joint selection for the shared d7.policy_heads section
    joint = None
    if all(n in choices for n in JOINT_GROUPS):
        heads3 = [evalmod.HEAD_BY_NAME[n] for n in JOINT_GROUPS]
        variants = [("A", specs["policy_mock_data"]["labels"]), ("B", POLICY_B)]
        best_joint = None
        for vid, labels in variants:
            raws = {}
            for h in heads3:
                dev_cases = [c for c, s in zip(cases_by_head[h.name],
                                               split_by_head[h.name]) if s == "dev"]
                raws[h.name] = collect_raw(args, h, vid, labels, dev_cases, cache,
                                           baseline=tune_base)
            for threshold in THRESHOLDS:
                for margin_gate in MARGINS:
                    per = {h.name: gate_metrics(h, raws[h.name], threshold, margin_gate)
                           for h in heads3}
                    feasible = all(m["fb"] is None or m["fb"] <= FB_MAX for m in per.values())
                    mean_acc = sum(m["accuracy"] for m in per.values()) / len(per)
                    rank = (1 if feasible else 0, mean_acc,
                            -sum(m["fb"] or 0.0 for m in per.values()), threshold, margin_gate)
                    if best_joint is None or rank > best_joint[0]:
                        best_joint = (rank, vid, labels, threshold, margin_gate, per)
        joint = {"variant": best_joint[1], "labels": best_joint[2],
                 "threshold": best_joint[3], "margin": best_joint[4], "dev": best_joint[5]}
        for n in JOINT_GROUPS:
            choices[n] = dict(joint)
            choices[n]["dev"] = joint["dev"][n]
        mean_acc = sum(m["accuracy"] for m in joint["dev"].values()) / len(joint["dev"])
        print("[tune] policy_heads JOINT variant %s th=%.2f mg=%.2f mean acc=%.1f%%" % (
            joint["variant"], joint["threshold"], joint["margin"], 100 * mean_acc))

    result = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "url": args.url,
              "baseline_table": baseline_table, "choices": {}, "heldout": {}, "apply": [],
              "health": {"tune": {"start": tune_base,
                                  "start_full": tune_snap,
                                  "end": health_key(health_snapshot(args.url))}}}
    for name, ch in choices.items():
        result["choices"][name] = {
            "variant": ch["variant"],
            "threshold": ch["threshold"], "margin": ch["margin"],
            "labels": ch["labels"] if isinstance(ch["labels"], dict) else {
                k: "" for k in ch["labels"]},
            "name_only": not isinstance(ch["labels"], dict),
            "dev": ch["dev"]}

    # ---------------- apply ----------------
    if "apply" in args.stages:
        applied_files = set()
        for head in evalmod.HEADS:
            name = head.name
            target = EDITABLE.get(name)
            if target is None:
                continue
            ch = choices[name]
            rel_path, keys = target
            if rel_path.endswith(".yaml"):
                path = os.path.join(ROOT, rel_path)
                if path not in applied_files:
                    backup(path)
                    applied_files.add(path)
                    result["apply"].append("backup %s" % path)
                old_th = get_scalar(path, keys, "threshold")
                old_mg = get_scalar(path, keys, "margin")
                if name == "injection":
                    key_name = "min_conf"
                    old_th = get_scalar(path, keys, key_name)
                    if old_th is not None and abs(float(old_th) - ch["threshold"]) > 1e-9:
                        set_scalar(path, keys, key_name, "%.2f" % ch["threshold"])
                        result["apply"].append(
                            "%s %s.%s %s -> %.2f" % (rel_path, "/".join(keys), key_name,
                                                     old_th, ch["threshold"]))
                    continue
                if name == "pii_secret":
                    key_name = "min_conf"
                    old_th = get_scalar(path, keys, key_name)
                    if old_th is not None and abs(float(old_th) - ch["threshold"]) > 1e-9:
                        set_scalar(path, keys, key_name, "%.2f" % ch["threshold"])
                        result["apply"].append(
                            "%s %s.%s %s -> %.2f" % (rel_path, "/".join(keys), key_name,
                                                     old_th, ch["threshold"]))
                    continue
                if isinstance(ch["labels"], dict):
                    set_labels(path, keys, ch["labels"])
                    result["apply"].append("%s %s labels <- variant %s" % (
                        rel_path, "/".join(keys), ch["variant"]))
                if old_th is None or abs(float(old_th) - ch["threshold"]) > 1e-9:
                    set_scalar(path, keys, "threshold", "%.2f" % ch["threshold"])
                    result["apply"].append("%s %s threshold %s -> %.2f" % (
                        rel_path, "/".join(keys), old_th, ch["threshold"]))
                if old_mg is None or abs(float(old_mg) - ch["margin"]) > 1e-9:
                    set_scalar(path, keys, "margin", "%.2f" % ch["margin"])
                    result["apply"].append("%s %s margin %s -> %.2f" % (
                        rel_path, "/".join(keys), old_mg, ch["margin"]))
            elif name == "complexity":
                path = os.path.join(ROOT, rel_path)
                backup(path)
                result["apply"].append("backup %s" % path)
                if isinstance(ch["labels"], dict):
                    set_complexity_labels(ch["labels"])
                    result["apply"].append("eval/eval.py COMPLEXITY_LABELS <- variant %s"
                                           % ch["variant"])
        # name-only winners cannot be written as dict labels: recorded, not applied
        for name, ch in choices.items():
            if not isinstance(ch["labels"], dict) and EDITABLE.get(name):
                result["apply"].append(
                    "NOTE %s: variant %s is name-only; yaml keeps dict wording"
                    % (name, ch["variant"]))
        # round-trip check: every editable head's deployed spec must equal its choice.
        # Read the yaml FRESH here (yaml.safe_load): policy._rules caches per process,
        # so load_head_spec would compare against the pre-edit snapshot.
        import yaml as _yaml
        for head in evalmod.HEADS:
            name = head.name
            target = EDITABLE.get(name)
            if target is None or name in ("injection", "pii_secret"):
                continue
            path = os.path.join(ROOT, target[0])
            if not path.endswith(".yaml"):
                continue
            with open(path, "r", encoding="utf-8") as fh:
                node = _yaml.safe_load(fh)
            for key in target[1]:
                node = (node or {}).get(key) or {}
            ch = choices[name]
            ok = (node.get("labels") == ch["labels"]
                  and abs(float(node.get("threshold", -1)) - ch["threshold"]) < 1e-9
                  and abs(float(node.get("margin", -1)) - ch["margin"]) < 1e-9)
            result["apply"].append("%s roundtrip %s" % (name, "OK" if ok else "MISMATCH"))
            if not ok:
                print("[apply] WARNING %s deployed spec != chosen spec" % name)

    # ---------------- held-out (measured once, frozen choice, deployed gate) ----------------
    if "heldout" in args.stages:
        held_snap = stage_begin(args.url)
        held_base = health_key(held_snap)
        result["health"]["heldout"] = {"start": held_base, "start_full": held_snap}
        for head in evalmod.HEADS:
            name = head.name
            cases = cases_by_head[name]
            held_cases = [c for c, s in zip(cases, split_by_head[name]) if s == "heldout"]
            ch = choices[name]
            if head.kind == "decide":
                # The choice was frozen on dev; this pass generalizes it. Raw
                # scores at threshold=0/margin=0, gate applied client-side with
                # the chosen point (identical arithmetic to engine._ranked).
                raw = collect_raw(args, head, "H", ch["labels"], held_cases, cache,
                                  force=True, baseline=held_base)
                m = gate_metrics(head, raw, ch["threshold"], ch["margin"])
                m["threshold"] = ch["threshold"]
                m["margin"] = ch["margin"]
                m["n_total"] = len(cases)
                result["heldout"][name] = m
                print("[heldout] %-22s n=%-3d acc=%.1f%% abstain=%.1f%% fb=%s" % (
                    name, m["n"], 100 * m["accuracy"], 100 * m["abstain_rate"],
                    "n/a" if m["fb"] is None else "%.1f%%" % (100 * m["fb"])))
            elif head.kind == "injection":
                raw = raw_injection(args.url, held_cases, baseline=held_base)
                m = injection_metrics(raw, ch["threshold"])
                m["threshold"] = ch["threshold"]
                m["margin"] = 0.0
                m["n_total"] = len(cases)
                result["heldout"][name] = m
                print("[heldout] %-22s n=%-3d acc=%.1f%% fb=%s (min_conf %.2f)" % (
                    name, m["n"], 100 * m["accuracy"],
                    "n/a" if m["fb"] is None else "%.1f%%" % (100 * m["fb"]),
                    ch["threshold"]))
            elif head.kind == "pii":
                raw = raw_pii(args.url, held_cases, baseline=held_base)
                m = pii_metrics(raw, ch["threshold"])
                m["threshold"] = ch["threshold"]
                m["margin"] = 0.0
                m["n_total"] = len(cases)
                result["heldout"][name] = m
                print("[heldout] %-22s n=%-3d acc=%.1f%% fb=%s (min_conf %.2f)" % (
                    name, m["n"], 100 * m["accuracy"],
                    "n/a" if m["fb"] is None else "%.1f%%" % (100 * m["fb"]),
                    ch["threshold"]))

    # ---------------- verdicts + report ----------------
    if "heldout" in result.get("health", {}):
        result["health"]["heldout"]["end"] = health_key(health_snapshot(args.url))
    verdicts = {}
    for head in evalmod.HEADS:
        name = head.name
        m = result["heldout"].get(name) or {}
        if not m:
            continue
        never = name in evalmod.NEVER_PROMOTE
        fb_ok = m.get("fb") is not None and m["fb"] <= FB_MAX
        block = (fb_ok and m["accuracy"] >= 0.90 and m["n_total"] >= evalmod.PROMOTE_N_MIN
                 and not never and evalmod.HEAD_BY_NAME[name].mode_key is not None
                 and name not in MODE_LOCKED_LOG)
        if name in JOINT_GROUPS:
            others = [result["heldout"][o] for o in JOINT_GROUPS if o != name]
            block = block and all(
                o.get("fb") is not None and o["fb"] <= FB_MAX
                and o["accuracy"] >= 0.90 and o["n_total"] >= evalmod.PROMOTE_N_MIN
                for o in others)
        warn = fb_ok and m["accuracy"] >= WARN_ACC_MIN
        verdicts[name] = ("block" if block else "warn" if warn else "log")
        if never:
            verdicts[name] = "owner-decision"
    result["verdicts"] = verdicts

    os.makedirs(STATE, exist_ok=True)
    with open(RESULT_PATH, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1)
    print("[report] %s" % RESULT_PATH)
    return result


def merge_report() -> None:
    """Append the retune before/after section to eval-report.md.

    Run AFTER `eval.py --heads --url ... --dry-run-promote` has regenerated the
    report at the deployed spec, so the full-set "after" column and the dry-run
    promotion table are current.
    """
    with open(RESULT_PATH, "r", encoding="utf-8") as fh:
        result = json.load(fh)
    with open(BASELINE_REPORT, "r", encoding="utf-8") as fh:
        current_report = fh.read()

    def pct(v):
        return "n/a" if v is None else "%.1f%%" % (100.0 * v)

    lines = ["", "## Retune E2 (2026-10-02) — dev/held-out split, before/after", ""]
    lines += [
        "Deterministic split: `sha256(head + \"\\0\" + text) % 100 < 60` -> dev,",
        "else held-out. Tuning (label wording variants A/B/C, threshold 0.30–0.90",
        "step 0.05 x margin 0.00–0.20 step 0.05) touched **dev only**, maximising",
        "accuracy subject to false-block <= 5%. Held-out was measured once, after",
        "the choice was frozen, at the chosen gate (same arithmetic as",
        "`engine._Worker._ranked`). All inference ran against the daemon at %s"
        % result.get("url", "http://127.0.0.1:11438"),
        "with concurrency 1 — the models were never loaded in-process.", "",
        "### Before (full case set, deployed spec of 2026-10-02 06:46, in-process)",
        ""]
    if result.get("baseline_table"):
        lines += [l for l in result["baseline_table"].rstrip().splitlines()]
    else:
        lines += ["(baseline table not captured)"]
    lines += ["", "### Tuned operating points (chosen on dev) and held-out results", ""]
    lines += ["| head | variant | dev: th/mg | dev acc | dev FB | held-out: n | acc | FB (n) | abstain | n_total | verdict |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, ch in result.get("choices", {}).items():
        m = result.get("heldout", {}).get(name) or {}
        if not m:
            continue
        dev = ch.get("dev") or {}
        verdict = result.get("verdicts", {}).get(name, "?")
        lines.append("| %s | %s | %.2f/%.2f | %s | %s | %d | %s | %s (%d) | %s | %d | %s |" % (
            name, ch.get("variant", "?"), ch.get("threshold", 0), ch.get("margin", 0),
            pct(dev.get("accuracy")), pct(dev.get("fb")),
            m.get("n", 0), pct(m.get("accuracy")),
            pct(m.get("fb")), m.get("fb_n", 0), pct(m.get("abstain_rate")),
            m.get("n_total", 0), verdict))
    lines += ["", "Verdict rule (evaluated on held-out): **block** if FB <= 5% AND acc >= 90% "
              "AND n_total >= 40 AND not in NEVER_PROMOTE AND its mode key qualifies "
              "(shared mode keys need every head behind them); **warn** if FB <= 5% AND "
              "acc >= 85%; otherwise **log**. `pii_secret`, `injection`, `complexity` are "
              "owner decisions by contract (eval.NEVER_PROMOTE).", ""]
    cx = (result.get("heldout", {}).get("complexity") or {}).get("precision", {})
    if cx:
        lines += ["complexity precision(trivial) on held-out: %s (D11 needs >= 90%%; "
                  "D11 stays disabled either way — this run does not enable it)."
                  % pct(cx.get("trivial")), ""]
    non_deployable = [name for name, target in EDITABLE.items() if target is None]
    if non_deployable:
        lines += ["Heads with no editable home in this scope (recommended points "
                  "recorded in `tune-e2.json`, deployment left to the owning file): "
                  + ", ".join(sorted(non_deployable)) + ".", ""]
    if result.get("apply"):
        lines += ["### Applied changes", ""]
        lines += ["```"] + [str(a) for a in result["apply"]] + ["```", ""]
    lines += ["Raw tuning data: `state/local-decide/tune-e2.json` "
              "(raw-score cache: `tune-e2-cache.json`).", ""]
    health = result.get("health") or {}
    if health:
        lines += ["### Daemon health (worker restarts/timeouts counters)", ""]

        def fmt(snap):
            if not isinstance(snap, (tuple, list)) or len(snap) != 2:
                return "?"
            return "restarts=%s timeouts=%s" % (snap[0], snap[1])

        for stage, snap in health.items():
            start, end = snap.get("start"), snap.get("end")
            mark = "counters unchanged" if start == end else "counters changed"
            lines += ["- %s: %s -> %s — %s" % (stage, fmt(start), fmt(end), mark)]
        lines += ["", "Worker reloads happened under live hook load (the daemon serves",
                  "production hooks from the same single worker). Per the E2",
                  "data-integrity contract, no empty/failed response was ever",
                  "accepted as a score: every request is pre-checked for",
                  "models_loaded, failures are retried, and every cached entry",
                  "records the restarts/timeouts counters it was collected at",
                  "(`hkey` in tune-e2-cache.json) for audit.", ""]

    with open(BASELINE_REPORT, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("[merge] appended retune section to %s" % BASELINE_REPORT)


def main(argv):
    p = argparse.ArgumentParser(description="local-decide head retune (E2)")
    p.add_argument("--url", default="http://127.0.0.1:11438")
    p.add_argument("--stages", default="tune,apply,heldout,report")
    p.add_argument("--merge-report", action="store_true",
                   help="append the retune before/after section to eval-report.md "
                        "(run after eval.py regenerated it)")
    args = p.parse_args(argv)
    if args.merge_report:
        merge_report()
        return
    args.stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    wait_healthy(args.url)
    try:
        return run(args)
    except HealthChanged as exc:
        print("[ABORT] %s" % exc)
        print("[ABORT] stage discarded per E2 data-integrity directive: re-run this "
              "stage in a clean window (counters unchanged start->end).")
        return 3


if __name__ == "__main__":
    main(sys.argv[1:])
