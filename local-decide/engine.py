"""local-decide inference engine.

Owns the three GLiNER checkpoints (Decide / PII-Multi / GLiGuard), the
killable worker process that hosts them, the input caps and the #178
pre-filter.  Every public method is synchronous and never raises on a model
error: a failure degrades to an abstain result or an empty list so callers
(the hook path, the MCP server) always fail open.

Contract: ${AI_SETUP_ROOT}/local-decide/INTERFACES.md
"""

from __future__ import annotations

import contextlib
import math
import multiprocessing as mp
import os
import re
import threading
import time
from typing import Any, Callable, Optional

import httpx

# --------------------------------------------------------------------------
# Caps and budgets (INTERFACES.md "Caps")
# --------------------------------------------------------------------------
MAX_TEXT_BYTES = 64 * 1024          # 64 KB hard input ceiling
MAX_LABELS_PER_HEAD = 32
MAX_HEADS = 16
# Per inference unit. Was 2.0: under CPU contention (4B rerank, eval traffic) normal single-chunk calls crossed it,
# and each breach killed + reloaded the worker (~20 s of abstains). The hook clients give up at 5 s and fail open,
# so a slow answer is cheap and a respawn is not; the #178 pre-filter still bounds pathological inputs.
SINGLE_SHOT_MAX_CHARS = 4096
CALL_TIMEOUT_S = float(os.environ.get("LOCAL_DECIDE_CALL_TIMEOUT_S", "8.0"))
MAX_CALL_TIMEOUT_S = 30.0           # ceiling for a chunked long-text call
CHUNK_SIZE = 384                    # word tokens per chunk (long=True)
CHUNK_OVERLAP = 64
CHUNK_STEP = CHUNK_SIZE - CHUNK_OVERLAP

# --------------------------------------------------------------------------
# Model identity -- HF ids resolved from the local cache (HF_HUB_OFFLINE=1)
# --------------------------------------------------------------------------
DECIDE_MODEL = os.environ.get("LOCAL_DECIDE_DECIDE_MODEL", "fastino/GLiNER2.5-Decide")
PII_MODEL = os.environ.get("LOCAL_DECIDE_PII_MODEL", "fastino/GLiNER2-Guardrails-PII-Multi")
GUARD_MODEL = os.environ.get("LOCAL_DECIDE_GUARD_MODEL", "fastino/gliguard-LLMGuardrails-300M")

# PII label vocabulary for the guard checkpoint.  Kept explicit so the contract
# in INTERFACES.md ({"type": "api_key|secret|password|token|..."}) holds even if
# the checkpoint ever drops a class.
PII_LABELS = (
    # Secrets / credentials -- the ones a hook actually must redact.
    "password",
    "secret",
    "api_key",
    "access_token",
    "recovery_code",
    # Banking / payment.
    "payment_card",
    "card_number",
    "card_cvv",
    "card_expiry",
    "bank_account",
    "account_number",
    "iban",
    # Government / tax IDs.
    "government_id",
    "national_id_number",
    "passport_number",
    "tax_id",
    # Digital identity.
    "username",
    "ip_address",
    "sensitive_account_id",
    # Contact.
    "email",
    "phone_number",
    # Sensitive dates.
    "date_of_birth",
)
PII_THRESHOLD = float(os.environ.get("LOCAL_DECIDE_PII_THRESHOLD", "0.50"))

# --------------------------------------------------------------------------
# Rerank endpoints (llama.cpp)
# --------------------------------------------------------------------------
RERANK_PORTS = {"0.6b": 11435, "4b": 11439}
RERANK_BASE_TEMPLATE = "http://127.0.0.1:{port}"
RERANK_TIMEOUT_S = 3.0

# Classification precision.  Measured on this host (20 calls, 3 heads, 204-word
# input, 16 vCPU): fp32 p50 1002 ms / p95 1011 ms, autocast bf16 p50 586 ms /
# p95 593 ms, top-1 labels identical on every head.  bf16 is kept because it is
# 1.71x faster with no label change; set LOCAL_DECIDE_AUTOCAST=fp32 to revert.
# Full numbers: ${AI_SETUP_ROOT}/state/local-decide/bench-engine.md
AUTOCAST_MODE = os.environ.get("LOCAL_DECIDE_AUTOCAST", "bf16").strip().lower()

REVISIONS_FILE = os.environ.get(
    "LOCAL_DECIDE_REVISIONS", "/opt/local-ai/models/REVISIONS.txt")


def _hub_root() -> str:
    """Where huggingface_hub keeps the model cache on this host."""
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit:
        return explicit
    home = os.environ.get("HF_HOME") or os.path.expanduser(
        "~/.cache/huggingface")
    return os.path.join(home, "hub")


def pinned_revisions(path: str = REVISIONS_FILE) -> "dict[str, str]":
    """Parse ``repo id`` / ``rev: <hash>`` pairs out of REVISIONS.txt.

    The offline cache installed on this host ships snapshot directories but no
    ``refs/<branch>`` file, so ``hf_hub_download(repo_id)`` cannot resolve
    ``main`` with ``local_files_only=True``.  The pinned revisions make the
    snapshot choice deterministic when more than one is present.
    """
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return out
    current: Optional[str] = None
    for line in lines:
        stripped = line.strip()
        if stripped.endswith("/") or " " not in stripped:
            if "/" in stripped and not stripped.startswith(("#", "-")):
                current = stripped
            continue
        key, _, value = stripped.partition(":")
        key = key.strip().lower()
        if current and key == "rev" and value.strip():
            out[current] = value.strip()
            current = None
    return out


def resolve_model_path(repo_id: str,
                       revisions: "Optional[dict[str, str]]" = None) -> str:
    """Turn a Hub repo id into a local snapshot directory when one exists.

    ``AutoExtractor``/``Classifier`` accept either a repo id or a directory, and
    a directory short-circuits the Hub lookup entirely -- which is what makes
    this daemon startable under ``HF_HUB_OFFLINE=1``.
    """
    if os.path.isdir(repo_id):
        return repo_id
    revs = pinned_revisions() if revisions is None else revisions
    snapshot_root = os.path.join(
        _hub_root(), "models--" + repo_id.replace("/", "--"), "snapshots")
    if not os.path.isdir(snapshot_root):
        return repo_id
    pinned = revs.get(repo_id)
    if pinned and os.path.isdir(os.path.join(snapshot_root, pinned)):
        return os.path.join(snapshot_root, pinned)
    entries = sorted(name for name in os.listdir(snapshot_root)
                     if os.path.isdir(os.path.join(snapshot_root, name)))
    if not entries:
        return repo_id
    return os.path.join(snapshot_root, entries[-1])


# --------------------------------------------------------------------------
# Abstain reasons
# --------------------------------------------------------------------------
R_SELECTED = "selected"
R_BELOW_THRESHOLD = "below_threshold"
R_BELOW_MARGIN = "below_margin"
R_NEGATION = "negation"
R_TIMEOUT = "timeout"
R_WORKER_ERROR = "worker_error"
R_EMPTY = "empty"
R_INVALID_HEAD = "invalid_head"     # prefix; the full reason names the defect

# --------------------------------------------------------------------------
# #178 pre-filter: DoSS in the GLiNER2 word splitter (github issue #178).
# The splitter tries the e-mail alternative at every word and scans the whole
# run ahead for a missing "@", which is quadratic in run length, and it runs
# on the single inference thread before any truncation.
# --------------------------------------------------------------------------
_RUN_RE = re.compile(r"[A-Za-z0-9._%+-]+")
LONG_RUN_MAX = 256                  # chars kept from an over-long run


def _collapse_long_runs(text: str) -> str:
    """Truncate over-long ``[A-Za-z0-9._%+-]`` runs (mitigation #178b).

    A *maximal* run of that character class cannot contain ``@`` (the class
    excludes it), so the guard is structurally always true today; it is kept
    explicit so the rule stays correct if the class is ever widened.  Truncating
    to 256 chars bounds the quadratic lookahead at 256*256 character tests.
    """
    def repl(match: "re.Match[str]") -> str:
        run = match.group(0)
        if len(run) > LONG_RUN_MAX and "@" not in run:
            return run[:LONG_RUN_MAX] + "…"
        return run

    return _RUN_RE.sub(repl, text)


def prefilter(text: str) -> str:
    """Byte cap, then #178 run collapse.  Applied before *every* model call."""
    if not isinstance(text, str) or not text:
        return ""
    raw = text.encode("utf-8", "surrogatepass")
    if len(raw) > MAX_TEXT_BYTES:
        text = raw[:MAX_TEXT_BYTES].decode("utf-8", "ignore")
    return _collapse_long_runs(text)


# --------------------------------------------------------------------------
# Negation pre-check (the model is documented to ignore negation)
# --------------------------------------------------------------------------
_NEGATION_RE = re.compile(
    r"\b(?:do\s+not|do\s+n[o']t|don'?t|dont|never|no\s+longer|stop|without|avoid)\b",
    re.IGNORECASE,
)
NEGATION_WINDOW = 60                # characters before the keyword
_MIN_KEYWORD_LEN = 3


def label_keywords(label: str) -> list[str]:
    """Tokens that stand for a label in the input text.

    Derived from the label *name* only.  Descriptions are deliberately not
    mined for keywords: they are written to steer the model and routinely
    contain cue words that would make every mention of the concept trip the
    negation check.
    """
    tokens = re.split(r"[^A-Za-z0-9]+", label or "")
    out: list[str] = []
    for tok in tokens:
        low = tok.lower()
        if len(low) >= _MIN_KEYWORD_LEN and low not in out:
            out.append(low)
    return out


def negation_head(text: str, head: "dict[str, Any]") -> bool:
    """True when a negation cue precedes a keyword of one of the head labels."""
    labels = head.get("labels") or {}
    names = list(labels.keys()) if isinstance(labels, dict) else list(labels)
    for name in names:
        for kw in label_keywords(name):
            pattern = r"(?<![A-Za-z0-9])" + re.escape(kw) + r"(?![A-Za-z0-9])"
            for match in re.finditer(pattern, text, re.IGNORECASE):
                window = text[max(0, match.start() - NEGATION_WINDOW):match.start()]
                if _NEGATION_RE.search(window):
                    return True
    return False


# --------------------------------------------------------------------------
# Schema construction
# --------------------------------------------------------------------------
def _autocast(head: str = "decide"):
    """Precision context for a classification head (see AUTOCAST_MODE).

    Measured on Decide: bf16 is 1.71x faster with identical top-1 labels, so it
    is used there.  Measured on GLiGuard: bf16 flips "Please summarize this
    quarterly report for me." from benign 0.9998 to injection 0.668 -- three
    significant digits is not enough to hold a 0.999 decision, and a guard model
    that invents attacks is worse than a slow one.  The guard and the PII span
    decoder stay fp32.
    """
    if head != "decide" or AUTOCAST_MODE not in ("bf16", "bfloat16"):
        return contextlib.nullcontext()
    import torch

    return torch.autocast(device_type="cpu", dtype=torch.bfloat16)


def _sanitize(value: str) -> str:
    """Drop the reserved markers gliner2 injects into the model prompt.

    classification/schema.py rejects these outright; sanitizing here turns a
    rules-file typo into a working label instead of a 500.
    """
    out = value
    for token in ("[P]", "[L]", "[C]", "[E]", "[R]",
                  "[DESCRIPTION]", "[EXAMPLE]", "[OUTPUT]", "(", ")"):
        out = out.replace(token, " ")
    return " ".join(out.split())


def plan_heads(heads: "dict[str, dict]") -> "tuple[dict[str, dict[str, str]], dict[str, str]]":
    """``({head: {model label: caller label}}, {head: reason})`` for one call.

    gliner2 rejects its marker tokens and "(" ")" in task and label names, so
    the model sees the _sanitize()d strings and the caller gets its own string
    back ("btn(2)" must not come back as "btn 2").  A head whose name or label
    is empty once sanitized, or equal to an earlier one once sanitized, cannot
    be mapped back: it gets a specific ``invalid_head: ...`` reason instead of
    failing the whole call with a generic worker_error.
    """
    maps: "dict[str, dict[str, str]]" = {}
    invalid: "dict[str, str]" = {}
    owners: "dict[str, str]" = {}
    for name, head in heads.items():
        task = _sanitize(str(name))
        labels = head.get("labels") or {}
        label_map: "dict[str, str]" = {}
        problem = ""
        if not task:
            problem = f"head name {name!r} is empty once reserved markers are removed"
        elif task in owners:
            problem = (f"head names {owners[task]!r} and {name!r} are identical "
                       f"once reserved markers are removed")
        else:
            for original in (labels.keys() if isinstance(labels, dict) else labels):
                text = str(original)
                model = _sanitize(text)
                if not model:
                    problem = f"label {text!r} is empty once reserved markers are removed"
                    break
                if model in label_map:
                    problem = (f"labels {label_map[model]!r} and {text!r} are identical "
                               f"once reserved markers are removed")
                    break
                label_map[model] = text
        if problem:
            invalid[name] = f"{R_INVALID_HEAD}: {problem}"[:300]
            continue
        owners[task] = str(name)
        maps[name] = label_map
    return maps, invalid


def validate_heads(heads: Any) -> "dict[str, dict]":
    """Enforce the label/head caps.  Raises ValueError (the server maps to 422)."""
    if not isinstance(heads, dict):
        raise ValueError("heads must be an object")
    if len(heads) > MAX_HEADS:
        raise ValueError(f"too many heads: {len(heads)} > {MAX_HEADS}")
    for name, head in heads.items():
        if not isinstance(head, dict):
            raise ValueError(f"head {name!r} must be an object")
        labels = head.get("labels")
        if not isinstance(labels, (dict, list)) or not labels:
            raise ValueError(f"head {name!r} needs a non-empty 'labels'")
        if len(labels) > MAX_LABELS_PER_HEAD:
            raise ValueError(
                f"head {name!r} has {len(labels)} labels > {MAX_LABELS_PER_HEAD}")
        for key in ("threshold", "margin"):
            value = head.get(key, 0.0)
            if not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0:
                raise ValueError(f"head {name!r} field {key} must be in [0, 1]")
    return heads


# --------------------------------------------------------------------------
# Worker side
# --------------------------------------------------------------------------
class _Worker:
    """Holds the three checkpoints.  Lives only in the child process."""

    def __init__(self, config: "dict[str, Any]"):
        from gliner2 import AutoExtractor
        from gliner2.classification import Classifier

        import torch

        torch.set_grad_enabled(False)
        threads = config.get("torch_threads")
        if threads:
            torch.set_num_threads(int(threads))

        self.decide_model = config.get("decide_model", DECIDE_MODEL)
        self.pii_model = config.get("pii_model", PII_MODEL)
        self.guard_model = config.get("guard_model", GUARD_MODEL)
        self.pi_labels = list(config.get("pii_labels", PII_LABELS))
        self.pi_threshold = float(config.get("pii_threshold", PII_THRESHOLD))
        self.revisions = pinned_revisions()
        load = {"local_files_only": True, "map_location": "cpu"}

        decide_path = resolve_model_path(self.decide_model, self.revisions)
        pii_path = resolve_model_path(self.pii_model, self.revisions)
        guard_path = resolve_model_path(self.guard_model, self.revisions)

        self.decide = Classifier.from_pretrained(decide_path, device="cpu", **load)
        self.pii = AutoExtractor.from_pretrained(pii_path, **load)
        self.guard = Classifier.from_pretrained(guard_path, device="cpu", **load)
        self.loaded = (decide_path, pii_path, guard_path)

    # -- schema helpers -------------------------------------------------
    @staticmethod
    def _schema(heads: "dict[str, dict]"):
        from gliner2.classification import ClassificationSchema

        schema = ClassificationSchema()
        for name, head in heads.items():
            labels = head.get("labels")
            if isinstance(labels, dict):
                # An empty (or marker-only) description means "the label name
                # alone": gliner2 rejects "" but takes None as name-only.
                clean = {_sanitize(str(k)): _sanitize("" if v is None else str(v)) or None
                         for k, v in labels.items()}
            else:
                clean = [_sanitize(str(k)) for k in labels]
            # single-label head: min=max=1 -> softmax activation, so the
            # returned probabilities are already a distribution.
            schema.single(_sanitize(str(name)), clean)
        return schema

    @staticmethod
    def _ranked(result, head: "dict[str, dict]", task: Optional[str] = None,
                labels: "Optional[dict[str, str]]" = None) -> "dict[str, Any]":
        """Apply the conf>=threshold AND top1-top2>=margin gate to one head.

        ``task`` is this head's task in a multi-head result (default: the only
        task); ``labels`` maps the model's label back to the caller's string.
        """
        name = task if task is not None else next(iter(result.tasks))
        probs = dict(result.probabilities(name))
        ordered = sorted(probs.items(), key=lambda kv: (-kv[1], kv[0]))
        if not ordered:
            return {"label": None, "conf": 0.0, "margin": 0.0,
                    "abstain": True, "reason": R_EMPTY}
        top_label, conf = ordered[0]
        if labels:
            top_label = labels.get(top_label, top_label)
        second = ordered[1][1] if len(ordered) > 1 else 0.0
        margin = float(conf) - float(second)
        threshold = float(head.get("threshold", 0.0) or 0.0)
        min_margin = float(head.get("margin", 0.0) or 0.0)
        if conf < threshold:
            return {"label": None, "conf": round(float(conf), 6),
                    "margin": round(margin, 6), "abstain": True,
                    "reason": R_BELOW_THRESHOLD}
        if margin < min_margin:
            return {"label": None, "conf": round(float(conf), 6),
                    "margin": round(margin, 6), "abstain": True,
                    "reason": R_BELOW_MARGIN}
        return {"label": top_label, "conf": round(float(conf), 6),
                "margin": round(margin, 6), "abstain": False,
                "reason": R_SELECTED}

    # -- operations -----------------------------------------------------
    def op_decide(self, msg: "dict[str, Any]") -> "dict[str, Any]":
        from gliner2.classification import ClassificationConfig

        heads = msg["heads"]
        text = msg["text"]
        maps, invalid = plan_heads(heads)
        out: dict[str, Any] = {name: {"label": None, "conf": 0.0, "margin": 0.0,
                                      "abstain": True, "reason": reason}
                               for name, reason in invalid.items()}
        valid = {name: head for name, head in heads.items() if name in maps}
        if not valid:
            return out
        schema = self._schema(valid)
        config = ClassificationConfig(batch_size=int(msg.get("batch_size", 8)))
        if msg.get("long"):
            with _autocast():
                result = self.decide.classify_long(
                    text, schema, config=config,
                    chunk_size=int(msg.get("chunk_size", CHUNK_SIZE)),
                    chunk_overlap=int(msg.get("chunk_overlap", CHUNK_OVERLAP)),
                    aggregate="max")
        else:
            with _autocast():
                result = self.decide.classify(text, schema, config=config)
        for name, head in valid.items():
            key = _sanitize(str(name))
            if key in result.tasks:
                out[name] = self._ranked(result, head, key, maps[name])
            else:
                out[name] = {"label": None, "conf": 0.0, "margin": 0.0,
                             "abstain": True, "reason": R_EMPTY}
        return {name: out[name] for name in heads}

    @staticmethod
    def _iter_pii_groups(raw: Any):
        """Yield ``(type, spans)`` pairs from either documented output shape.

        Measured on this checkpoint, ``extract_entities`` returns
        ``{"entities": {label: [span, ...]}}`` -- a dict.  Upstream issue #109
        records the other shape (``{"entities": [ {label: [span, ...]}, ... ]}``)
        from a different code path, plus a bare ``[]`` for an empty result, so
        all three are normalized here rather than trusting one.
        """
        entities = raw.get("entities") if isinstance(raw, dict) else None
        if isinstance(entities, dict):
            yield from entities.items()
        elif isinstance(entities, list):
            for group in entities:
                if isinstance(group, dict):
                    yield from group.items()

    def op_pii(self, msg: "dict[str, Any]") -> "list[dict]":
        raw = self.pii.extract_entities(
            msg["text"], list(self.pi_labels),
            threshold=self.pi_threshold, include_confidence=True,
            include_spans=True)
        found: list[dict] = []
        for ptype, spans in self._iter_pii_groups(raw):
            if not isinstance(spans, list):
                continue
            for span in spans:
                if isinstance(span, dict) and span.get("text"):
                    found.append({
                        "type": ptype,
                        "conf": round(float(span.get("confidence", 0.0)), 6),
                        "start": int(span.get("start", 0)),
                        "end": int(span.get("end", 0)),
                    })
        found.sort(key=lambda item: (-item["conf"], item["start"]))
        return found

    def op_injection(self, msg: "dict[str, Any]") -> "dict":
        from gliner2.classification import ClassificationConfig

        # Label NAMES come from the checkpoint's own model card
        # (JAILBREAK_LABELS) and carry no prose.  Invented labels plus invented
        # descriptions cost 0.32 confidence on the head: "Please summarize this
        # quarterly report for me." read benign 0.9998 with `prompt_injection` /
        # `benign` but injection 0.676 with the invented pair.  The contract's
        # binary label is mapped from `prompt_injection` at the end.
        schema = self._schema({"injection": {
            "labels": ["prompt_injection", "benign"]}})
        with _autocast("guard"):
            result = self.guard.classify(
                msg["text"], schema, config=ClassificationConfig(batch_size=1))
        probs = dict(result.probabilities("injection"))
        raw = max(probs.items(), key=lambda kv: kv[1])[0] if probs else "benign"
        label = "injection" if raw == "prompt_injection" else "benign"
        return {"label": label, "conf": round(float(probs.get(raw, 0.0)), 6)}

    def dispatch(self, msg: "dict[str, Any]") -> Any:
        op = msg.get("op")
        if op == "decide":
            return self.op_decide(msg)
        if op == "pii":
            return self.op_pii(msg)
        if op == "injection":
            return self.op_injection(msg)
        if op == "health":
            return {"models_loaded": True, "pid": os.getpid(),
                    "models": list(self.loaded)}
        raise ValueError(f"unknown op {op!r}")


def _resolve_entry(config: "dict[str, Any]") -> Optional[Callable]:
    """Resolve the ``worker_entry`` test seam ("pkg.mod:func") inside the child.

    Spawn pickles the target by module path, so a string entry point keeps the
    override alive across the process boundary (a monkeypatched attribute would
    not).  Contract tests use it to exercise the timeout/respawn path without
    loading 1 GB of weights.
    """
    entry = config.get("worker_entry")
    if not entry:
        return None
    import importlib

    module_name, _, attr = str(entry).partition(":")
    return getattr(importlib.import_module(module_name), attr)


# --------------------------------------------------------------------------
# Worker memory (2026-10-02): the worker grew 4.8 -> 6.75 GB in ~30 min of hook traffic,
# crossed the cgroup MemoryHigh and the whole service was throttled into a hang (every
# UserPromptSubmit hook hit the 10 s client timeout).  Two guards: return freed heap to
# the OS after every reply, and recycle the worker once its RSS crosses a ceiling.
# --------------------------------------------------------------------------
WORKER_RSS_MAX_MB = int(os.environ.get("LOCAL_DECIDE_WORKER_RSS_MAX_MB", "5600"))


INJECTION_WINDOW_CHARS = 2048       # ~512 encoder tokens: the model's own window
INJECTION_MAX_WINDOWS = 4           # first 3 windows + the last one


def _injection_windows(text: str) -> "list[str]":
    """Split ``text`` into <= INJECTION_MAX_WINDOWS windows of <= INJECTION_WINDOW_CHARS."""
    size = INJECTION_WINDOW_CHARS
    windows = [text[i:i + size] for i in range(0, len(text), size)] or [""]
    if len(windows) > INJECTION_MAX_WINDOWS:
        windows = windows[:INJECTION_MAX_WINDOWS - 1] + [windows[-1]]
    return windows


def _malloc_trim() -> None:
    """glibc malloc_trim(0) after a reply; a no-op where libc lacks it.  Never raises."""
    try:
        import ctypes  # noqa: WPS433

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def _rss_bytes(pid: Optional[int]) -> int:
    """Resident set size of ``pid`` from /proc, 0 when unknown.  Never raises."""
    if not pid:
        return 0
    try:
        with open(f"/proc/{int(pid)}/statm", "r", encoding="ascii") as fh:
            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except Exception:
        return 0


def _worker_main(conn, config: "dict[str, Any]") -> None:
    """Child entrypoint.  Loads models once, then serves one request at a time."""
    entry = _resolve_entry(config)
    if entry is not None:
        entry(conn, config)
        return
    try:
        worker = _Worker(config)
    except BaseException as exc:                      # pragma: no cover - load failure
        try:
            conn.send({"ready": False,
                       "error": f"{type(exc).__name__}: {exc}"})
        except Exception:
            pass
        finally:
            conn.close()
        return
    try:
        conn.send({"ready": True, "pid": os.getpid()})
    except Exception:
        return
    while True:
        try:
            msg = conn.recv()
        except (EOFError, KeyboardInterrupt):
            break
        if not isinstance(msg, dict):
            continue
        # Trim BEFORE replying: the parent reads this process's RSS right after the reply, and an
        # untrimmed post-call peak would trigger a needless recycle.
        try:
            reply = {"ok": True, "result": worker.dispatch(msg)}
        except BaseException as exc:                  # keep the worker alive
            reply = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        _malloc_trim()
        try:
            conn.send(reply)
        except Exception:
            break
    try:
        conn.close()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------
class Engine:
    """Parent-side handle on the worker process."""

    def __init__(
        self,
        decide_model: str = DECIDE_MODEL,
        pii_model: str = PII_MODEL,
        guard_model: str = GUARD_MODEL,
        timeout_s: float = CALL_TIMEOUT_S,
        max_timeout_s: float = MAX_CALL_TIMEOUT_S,
        load_timeout_s: float = 900.0,
        pii_labels: "tuple[str, ...]" = PII_LABELS,
        pii_threshold: float = PII_THRESHOLD,
        rerank_timeout_s: float = RERANK_TIMEOUT_S,
        rerank_ports: "Optional[dict[str, int]]" = None,
        torch_threads: Optional[int] = None,
        worker_entry: Optional[str] = None,
        worker_config: "Optional[dict[str, Any]]" = None,
        autostart: bool = True,
    ):
        self.timeout_s = float(timeout_s)
        self.max_timeout_s = float(max_timeout_s)
        self.load_timeout_s = float(load_timeout_s)
        self.rerank_timeout_s = float(rerank_timeout_s)
        self.rerank_ports = dict(rerank_ports or RERANK_PORTS)
        self.config: dict[str, Any] = {
            "decide_model": decide_model,
            "pii_model": pii_model,
            "guard_model": guard_model,
            "pii_labels": list(pii_labels),
            "pii_threshold": float(pii_threshold),
            "torch_threads": torch_threads,
            "worker_entry": worker_entry,
        }
        if worker_config:
            self.config.update(worker_config)
        self._ctx = mp.get_context("spawn")
        self._lock = threading.RLock()
        self._proc: Any = None
        self._conn: Any = None
        self._ready = False
        self._pid: Optional[int] = None
        self._load_error: Optional[str] = None
        self.restarts = 0
        self.timeouts = 0
        self.recycles = 0
        self.rss_max_bytes = WORKER_RSS_MAX_MB * 1024 * 1024
        self._rerank_cache: dict[str, tuple[float, bool]] = {}
        if autostart:
            self.start()

    # -- worker lifecycle ------------------------------------------------
    def start(self) -> bool:
        """(Re)spawn the worker and wait for model load.  Idempotent."""
        with self._lock:
            if self._ready and self._proc is not None and self._proc.is_alive():
                return True
            self._teardown()
            self._load_error = None
            parent, child = self._ctx.Pipe(duplex=True)
            proc = self._ctx.Process(
                target=_worker_main, args=(child, self.config),
                daemon=True, name="local-decide-worker")
            proc.start()
            child.close()
            if not parent.poll(self.load_timeout_s):
                self._load_error = "model load timed out"
                self._abort(parent, proc)
                return False
            try:
                hello = parent.recv()
            except EOFError:
                hello = {"ready": False, "error": "worker died during load"}
            if not hello.get("ready"):
                self._load_error = str(hello.get("error", "unknown load error"))
                self._abort(parent, proc)
                return False
            self._proc = proc
            self._conn = parent
            self._pid = int(hello.get("pid") or proc.pid)
            self._ready = True
            return True

    @staticmethod
    def _abort(conn: Any, proc: Any) -> None:
        """Kill a child that never came up and release its pipe. No locks taken."""
        try:
            conn.close()
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.join(timeout=5)
        except Exception:
            pass

    def _teardown(self) -> None:
        proc, conn = self._proc, self._conn
        self._proc, self._conn, self._pid = None, None, None
        self._ready = False
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        if proc is not None and proc.is_alive():
            try:
                proc.terminate()
                proc.join(timeout=3)
            except Exception:
                pass
            if proc.is_alive():                        # pragma: no cover
                try:
                    proc.kill()
                    proc.join(timeout=3)
                except Exception:
                    pass

    def stop(self) -> None:
        with self._lock:
            self._teardown()

    def _kill_and_respawn(self) -> None:
        """Hard-stop a wedged worker and bring a fresh one up in the background."""
        with self._lock:
            self._teardown()
            self.restarts += 1
        threading.Thread(target=self._quiet_start, name="local-decide-respawn",
                         daemon=True).start()

    def _quiet_start(self) -> None:
        try:
            self.start()
        except Exception:                             # pragma: no cover
            pass

    # -- request plumbing -------------------------------------------------
    def _budget(self, text: str, long: bool) -> float:
        if not long:
            return self.timeout_s
        words = text.count(" ") + 1
        chunks = max(1, math.ceil(words / CHUNK_STEP))
        return min(self.timeout_s * chunks, self.max_timeout_s)

    def _call(self, msg: "dict[str, Any]", budget: Optional[float] = None) -> Any:
        """Send one request, wait ``budget`` seconds, respawn on breach."""
        deadline = self.timeout_s if budget is None else budget
        with self._lock:
            if not self._ready or self._proc is None or not self._proc.is_alive():
                if not self.start():
                    raise WorkerUnavailable(self._load_error or "worker unavailable")
            conn = self._conn
            try:
                while conn.poll(0):                    # drain stale replies
                    conn.recv()
            except Exception:
                pass
            started = time.monotonic()
            try:
                conn.send(msg)
            except Exception as exc:
                self._kill_and_respawn()
                raise WorkerUnavailable(f"send failed: {exc}") from exc
            if not conn.poll(deadline):
                self.timeouts += 1
                self._kill_and_respawn()
                raise Timeout(f"worker exceeded {deadline:.2f}s")
            try:
                reply = conn.recv()
            except Exception as exc:
                self._kill_and_respawn()
                raise WorkerUnavailable(f"recv failed: {exc}") from exc
            latency = (time.monotonic() - started) * 1000.0
            if self.rss_max_bytes and _rss_bytes(self._pid) > self.rss_max_bytes:
                # The reply is already in hand; recycle before the heap reaches the cgroup cap.
                self.recycles += 1
                self._kill_and_respawn()
            if not isinstance(reply, dict):
                raise WorkerUnavailable("malformed reply")
            if not reply.get("ok"):
                raise WorkerError(str(reply.get("error", "worker error")))
            return reply.get("result"), latency

    # -- public API -------------------------------------------------------
    def decide(self, text: str, heads: "dict[str, dict]",
               long: bool = False) -> "dict[str, dict]":
        """One multi-head classification call.  Never raises on a model error."""
        heads = validate_heads(heads)
        if not long:
            # The encoder sees ≤ 512 tokens anyway; a 64 KB single-shot text only burns budget (worker kills).
            text = text[:SINGLE_SHOT_MAX_CHARS]
        text = prefilter(text)
        out: dict[str, dict] = {}
        pending: dict[str, dict] = {}
        _, invalid = plan_heads(heads)
        for name, head in heads.items():
            if name in invalid:
                out[name] = {"label": None, "conf": 0.0, "margin": 0.0,
                             "abstain": True, "reason": invalid[name]}
            elif negation_head(text, head):
                out[name] = {"label": None, "conf": 0.0, "margin": 0.0,
                             "abstain": True, "reason": R_NEGATION}
            else:
                pending[name] = head
        if not pending or not text:
            for name in pending:
                out[name] = {"label": None, "conf": 0.0, "margin": 0.0,
                             "abstain": True, "reason": R_EMPTY}
            return {k: out[k] for k in heads}

        msg = {"op": "decide", "text": text, "heads": pending, "long": bool(long),
               "chunk_size": CHUNK_SIZE, "chunk_overlap": CHUNK_OVERLAP}
        try:
            result, _ = self._call(msg, self._budget(text, long))
        except Timeout:
            reason = R_TIMEOUT
        except Exception:          # worker error, dead pipe, respawn refused
            reason = R_WORKER_ERROR
        else:
            reason = None
            out.update({k: v for k, v in (result or {}).items() if k in pending})
        for name in pending:
            out.setdefault(name, {"label": None, "conf": 0.0, "margin": 0.0,
                                  "abstain": True, "reason": reason})
        return {k: out[k] for k in heads}

    def pii(self, text: str) -> "list[dict]":
        text = prefilter(text)
        if not text:
            return []
        try:
            result, _ = self._call({"op": "pii", "text": text})
        except Exception:
            return []
        return result if isinstance(result, list) else []

    def injection(self, text: str) -> "dict":
        """Scan in bounded windows, one worker call each (2026-10-02: a whole 64 KB Read went to the
        encoder in one call; attention memory is quadratic, the worker spiked ~1 GB per 900 words and
        was OOM-killed).  Highest injection confidence wins; any window error -> skip that window."""
        text = prefilter(text)
        if not text:
            return {"label": "benign", "conf": 0.0}
        best_inj, best_benign = None, None
        for window in _injection_windows(text):
            try:
                result, _ = self._call({"op": "injection", "text": window})
            except Exception:
                continue
            if not isinstance(result, dict):
                continue
            conf = float(result.get("conf") or 0.0)
            if result.get("label") == "injection":
                if best_inj is None or conf > best_inj["conf"]:
                    best_inj = {"label": "injection", "conf": conf}
            elif best_benign is None or conf > best_benign["conf"]:
                best_benign = {"label": "benign", "conf": conf}
        return best_inj or best_benign or {"label": "benign", "conf": 0.0}

    # -- rerank (llama.cpp, parent side) ---------------------------------
    def _rerank_base(self, model: str) -> Optional[str]:
        port = self.rerank_ports.get(model)
        if port is None:
            return None
        return RERANK_BASE_TEMPLATE.format(port=port)

    def rerank(self, query: str, docs: "list[str]", model: str = "0.6b",
               top_n: Optional[int] = None) -> "list[dict]":
        """POST /v1/rerank to the llama.cpp server.  Any error -> []."""
        base = self._rerank_base(model)
        if base is None or not docs or not query:
            return []
        body: dict[str, Any] = {"query": query, "documents": list(docs)}
        if top_n:
            body["top_n"] = int(top_n)
        try:
            with httpx.Client(timeout=self.rerank_timeout_s) as client:
                resp = client.post(f"{base}/v1/rerank", json=body)
            resp.raise_for_status()
            payload = resp.json()
        except Exception:
            return []
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            return []
        out: list[dict] = []
        for row in results:
            if not isinstance(row, dict) or "index" not in row:
                continue
            score = row.get("relevance_score", row.get("score"))
            if score is None:
                continue
            out.append({"index": int(row["index"]), "score": float(score)})
        out.sort(key=lambda item: (-item["score"], item["index"]))
        if top_n:
            out = out[:int(top_n)]
        return out

    def _probe_rerank(self, model: str, ttl: float = 5.0) -> bool:
        base = self._rerank_base(model)
        if base is None:
            return False
        key = f"{model}:{base}"
        cached = self._rerank_cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < ttl:
            return cached[1]
        ok = False
        try:
            with httpx.Client(timeout=min(1.0, self.rerank_timeout_s)) as client:
                resp = client.get(f"{base}/health")
            ok = resp.status_code < 500
        except Exception:
            ok = False
        self._rerank_cache[key] = (now, ok)
        return ok

    def health(self) -> "dict[str, Any]":
        return {
            "ok": self._ready and self._load_error is None,
            "models_loaded": bool(self._ready),
            "worker_pid": self._pid,
            "rerank_0_6b": self._probe_rerank("0.6b"),
            "rerank_4b": self._probe_rerank("4b"),
            "restarts": self.restarts,
            "recycles": self.recycles,
            "worker_rss_mb": _rss_bytes(self._pid) // (1024 * 1024),
            "timeouts": self.timeouts,
            "load_error": self._load_error,
        }


class Timeout(RuntimeError):
    """The worker breached its wall-clock budget and was killed."""


class WorkerError(RuntimeError):
    """The worker raised while handling the request."""


class WorkerUnavailable(WorkerError):
    """The worker could not be reached or respawned."""


# --------------------------------------------------------------------------
# Benchmark: fp32 vs torch.autocast(bf16) on CPU
# --------------------------------------------------------------------------
BENCH_TEXT = (
    "Please deploy the payment retry service to production tonight. The team has "
    "already approved the change in the release channel and the on-call engineer "
    "confirmed the rollback plan. First read the deployment checklist, then update "
    "the version pins in the service manifest, and finally trigger the rollout "
    "through the standard pipeline. If the health check fails twice, roll back to "
    "the previous revision and page the owner. Write the release notes afterwards "
    "and attach the latency histogram from the staging run so the change log "
    "records the measured numbers rather than an estimate. Do not change the "
    "database migrations in this change. "
) * 2                                        # ~200 words, inside the 512 window


def _bench_heads() -> "dict[str, dict]":
    return {
        "action": {"labels": {
            "deploy": "A request to deploy, release or roll out software.",
            "rollback": "A request to revert or roll back a release.",
            "review": "A request to review, inspect or audit something.",
            "other": "Anything else.",
        }, "threshold": 0.0, "margin": 0.0},
        "risk": {"labels": {
            "destructive": "An action that deletes, drops or destroys state.",
            "irreversible": "An action that cannot easily be undone.",
            "routine": "A routine, reversible change.",
        }, "threshold": 0.0, "margin": 0.0},
        "channel": {"labels": {
            "production": "Work targeting the live production environment.",
            "staging": "Work targeting staging or a test environment.",
            "unknown": "No environment named.",
        }, "threshold": 0.0, "margin": 0.0},
    }


def _percentile(values: "list[float]", pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct / 100.0
    low = math.floor(pos)
    high = math.ceil(pos)
    if low == high:
        return ordered[int(pos)]
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def benchmark(calls: int = 20, output: Optional[str] = None) -> "dict[str, Any]":
    """Run fp32 and autocast(bf16) over the same inputs and record both."""
    import torch
    from gliner2.classification import ClassificationConfig, Classifier

    heads = _bench_heads()
    clf = Classifier.from_pretrained(resolve_model_path(DECIDE_MODEL),
                                     device="cpu",
                                     local_files_only=True, map_location="cpu")
    clf.eval()
    schema = clf.compile_schema(_Worker._schema(heads))
    text = BENCH_TEXT
    cfg = ClassificationConfig(batch_size=1, include_confidence=False)

    def run(bf16: bool) -> "tuple[list[float], dict[str, str]]":
        latencies: list[float] = []
        labels: dict[str, str] = {}
        for _ in range(calls):
            started = time.perf_counter()
            if bf16:
                with torch.autocast(device_type="cpu", dtype=torch.bfloat16):
                    scored = clf.score(text, schema, config=cfg)
            else:
                scored = clf.score(text, schema, config=cfg)
            latencies.append((time.perf_counter() - started) * 1000.0)
            for head in heads:
                top = scored.top(head, 1)
                labels[head] = str(top[0][0]) if top else ""
        return latencies, labels

    # one warm-up pass outside the timer for each mode
    run(False)
    fp32_lat, fp32_labels = run(False)
    run(True)
    bf16_lat, bf16_labels = run(True)

    fp32_p50, fp32_p95 = _percentile(fp32_lat, 50), _percentile(fp32_lat, 95)
    bf16_p50, bf16_p95 = _percentile(bf16_lat, 50), _percentile(bf16_lat, 95)
    disagreements = [k for k in fp32_labels
                     if fp32_labels.get(k) != bf16_labels.get(k)]
    faster = "fp32"
    if bf16_p50 < fp32_p50:
        faster = "bf16"
    verdict = faster
    if disagreements:
        verdict = "fp32"

    report = {
        "calls": calls, "heads": len(heads),
        "text_words": len(text.split()),
        "fp32_p50_ms": round(fp32_p50, 2), "fp32_p95_ms": round(fp32_p95, 2),
        "bf16_p50_ms": round(bf16_p50, 2), "bf16_p95_ms": round(bf16_p95, 2),
        "fp32_labels": fp32_labels, "bf16_labels": bf16_labels,
        "disagreements": disagreements,
        "faster_raw": faster, "verdict": verdict,
    }
    if output:
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(_bench_markdown(report))
    return report


def _bench_markdown(report: "dict[str, Any]") -> str:
    lines = [
        "# local-decide engine benchmark (CPU, fp32 vs autocast bf16)",
        "",
        f"- calls per mode: {report['calls']}, heads per call: {report['heads']}, "
        f"input words: {report['text_words']}",
        f"- torch threads: {os.cpu_count()} vCPU",
        "",
        "| mode | p50 ms | p95 ms |",
        "|---|---|---|",
        f"| fp32 | {report['fp32_p50_ms']} | {report['fp32_p95_ms']} |",
        f"| autocast bf16 | {report['bf16_p50_ms']} | {report['bf16_p95_ms']} |",
        "",
        "## top-1 label per head",
        "",
        "| head | fp32 | autocast bf16 | agree |",
        "|---|---|---|---|",
    ]
    for head in ("action", "risk", "channel"):
        a = report["fp32_labels"].get(head)
        b = report["bf16_labels"].get(head)
        lines.append(f"| {head} | {a} | {b} | "
                     f"{'yes' if a == b else 'NO'} |")
    lines += [
        "",
        f"## verdict",
        "",
        f"- raw faster: **{report['faster_raw']}**",
        f"- label disagreements: {report['disagreements'] or 'none'}",
        f"- kept: **{report['verdict']}** "
        f"({'labels differ, fp32 wins by the tie-break rule' if report['disagreements'] else 'no label differs'})",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":            # pragma: no cover - manual benchmark
    import argparse
    import json

    parser = argparse.ArgumentParser(description="local-decide engine tools")
    parser.add_argument("--bench", action="store_true")
    parser.add_argument("--calls", type=int, default=20)
    parser.add_argument("--out", default=os.path.join(
            os.environ.get("AI_SETUP_ROOT")
            or os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "state", "local-decide", "bench-engine.md"))
    args = parser.parse_args()
    if not args.bench:
        parser.error("nothing to do; pass --bench")
    result = benchmark(calls=args.calls, output=args.out)
    print(json.dumps(result, indent=2))
