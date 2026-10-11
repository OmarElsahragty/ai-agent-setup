#!/usr/bin/env python3
"""spec_audit — which spec rules have no test that actually checks them?

    python3 spec_audit.py <spec> <tests_dir> [--top 3] [--threshold 0.6] [--json]

For every normative rule line in the spec (MUST / SHALL / never / always /
required / forbidden / prohibited), the top-K candidate test files are reranked
against the rule (0.6B cross-encoder), then each candidate is asked a yes/no
question: "does this test file actually assert this rule?" A rule is COVERED
when at least one candidate answers yes with confidence >= --threshold.

The yes/no pass is grouped BY TEST FILE, because /v1/decide sends one text and
asks every head about it: all rules that picked the same file are judged in one
multi-head call, chunked at the engine's 16-head cap.

Abstain means "not established": an abstained rule is reported as UNCOVERED with
`abstained: true`, never as covered. Standard library only.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# AI_SETUP_ROOT wins (install.sh and the bin/ wrappers export it); else <root> is this file's ../../
LOCAL_DECIDE = str(
    Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[2]) / "local-decide"
)
RERANK_PORT = 11435  # 0.6B — always available even when the 4B unit is broken
TIMEOUT_S = 8.0
DOC_CHARS = 2000
DOC_LINES = 60
RULE_CHARS = 300
HEADS_PER_CALL = 15
RULES_PER_CHUNK = 5
UNAVAILABLE = "local-decide unavailable"

NORMATIVE = re.compile(
    r"(?i)\b(must\s+not|must|shall\s+not|shall|should\s+not|should|"
    r"never|always|required\s+to|is\s+required|are\s+required|"
    r"forbidden|prohibited|it\s+is\s+mandatory|mandatory)\b")
TEST_FILE = re.compile(
    r"(?i)(^|[/._-])(test[_.-]|spec[_.-]|tests?$)|(^test)|(_test\.)|"
    r"(Test\.(java|kt)$)|(\.test\.(ts|tsx|js|jsx)$)|(\.spec\.(ts|tsx|js|jsx)$)")
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".zip",
              ".gz", ".so", ".dll", ".exe", ".woff", ".woff2", ".ttf", ".pyc"}


def post_json(url, payload, timeout=TIMEOUT_S):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body else {}


def load_client():
    if LOCAL_DECIDE not in sys.path:
        sys.path.insert(0, LOCAL_DECIDE)
    try:
        import client as real_client  # type: ignore
        if callable(getattr(real_client, "decide", None)) and callable(getattr(real_client, "rerank", None)):
            return real_client
    except Exception:
        pass
    return None


# --------------------------------------------------------------------------
# rule extraction
# --------------------------------------------------------------------------
def extract_rules(path):
    """[(rule_id, line_no, text)] — one per normative line outside code fences."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        raw_lines = handle.read().splitlines()
    rules, heading, in_fence, seq = [], "", False, 0
    for number, line in enumerate(raw_lines, 1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence or not stripped:
            continue
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            continue
        if stripped.startswith(("<!--", "//")):
            continue
        if not NORMATIVE.search(stripped):
            continue
        bullet = re.sub(r"^([-*+]|\d+[.)])\s+", "", stripped)
        context = ("%s: " % heading) if heading else ""
        rules.append(("R%d" % (seq + 1), number, (context + bullet)[:RULE_CHARS]))
        seq += 1
    return rules


def collect_tests(root):
    """[(relpath, document)] for every file that looks like a test."""
    out = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")
                   and d not in {"node_modules", "__pycache__", "venv", ".venv", "dist", "build"}]
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in BINARY_EXT or name.startswith("."):
                continue
            if not TEST_FILE.search(name):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    body = "".join([handle.readline() for _ in range(DOC_LINES)])
            except OSError:
                continue
            out.append((rel, ("%s\n%s" % (rel, body))[:DOC_CHARS].strip()))
    return out


# --------------------------------------------------------------------------
# model calls
# --------------------------------------------------------------------------
def rerank_candidates(rule_text, docs, top, client, notes):
    """[(index, score)] of the top candidates, or [] when no reranker answered."""
    rows = None
    if client is not None:
        try:
            rows = client.rerank(rule_text, docs, model="0.6b", top_n=top)
        except Exception as exc:
            notes.append("rerank via client.py failed: %s" % exc)
            rows = None
    if not rows:
        try:
            raw = post_json("http://127.0.0.1:%d/v1/rerank" % RERANK_PORT,
                            {"query": rule_text, "documents": docs, "top_n": top},
                            timeout=30.0)
            rows = raw.get("results", raw.get("data")) if isinstance(raw, dict) else raw
        except (urllib.error.URLError, OSError, ValueError) as exc:
            notes.append("reranker unavailable: %s" % exc)
            return []
    pairs, seen = [], set()
    for pos, row in enumerate(rows or []):
        idx = row.get("index", row.get("doc", pos)) if isinstance(row, dict) else pos
        score = row.get("score", row.get("relevance_score", 0.0)) if isinstance(row, dict) else row
        try:
            idx = int(idx)
            score = float(score)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(docs) and idx not in seen:
            seen.add(idx)
            pairs.append((idx, score))
    pairs.sort(key=lambda pair: pair[1], reverse=True)
    if pairs and (max(s for _, s in pairs) - min(s for _, s in pairs)) <= 1e-6:
        notes.append("reranker returned a flat ranking (scores carry no signal)")
        return []
    return pairs[:top]


def decide_batch(text, heads, client, timeout=TIMEOUT_S):
    """{head: {label, conf, margin, abstain}} or None when the daemon is down."""
    raw = None
    if client is not None:
        try:
            raw = client.decide(text, heads, long=False, timeout=timeout)
        except TypeError:  # a client that does not take `timeout`
            raw = client.decide(text, heads)
        except Exception as exc:
            raise RuntimeError("decide via client.py failed: %s" % exc)
    if raw is None and client is None:
        try:
            raw = post_json("http://127.0.0.1:11438/v1/decide",
                            {"text": text, "heads": heads, "long": False}, timeout)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise RuntimeError("decide unavailable: %s" % exc)
    if not isinstance(raw, dict):
        return None
    inner = raw.get("heads") if isinstance(raw.get("heads"), dict) else raw
    out = {}
    for head, item in inner.items():
        if isinstance(item, dict):
            out[str(head)] = {
                "label": item.get("label"),
                "conf": float(item.get("conf") or 0.0),
                "margin": float(item.get("margin") or 0.0),
                "abstain": bool(item.get("abstain", False)),
            }
    return out


def judge_doc(test_doc, questions, client, threshold):
    """{head: (covered, abstained)} for every rule asked about ONE test file.

    `questions` is [(head_name, rule_text), ...]. They share a single multi-head
    call because /v1/decide sends one text and asks every head about it — which
    is exactly the shape of "does this test file assert rule R?".
    """
    heads = {head: {
        "labels": {
            "yes": "this test file asserts, exercises or verifies the rule: %s" % rule_text,
            "no": "this test file does not test this rule at all, or tests something else",
        },
        "threshold": threshold,
        "margin": 0.10,
    } for head, rule_text in questions}
    results = decide_batch(test_doc, heads, client)
    if results is None:
        raise RuntimeError(UNAVAILABLE)
    verdict = {}
    for head, _ in questions:
        res = results.get(head)
        if res is None or res["abstain"] or res["label"] != "yes":
            verdict[head] = (False, res is None or res["abstain"])
        else:
            verdict[head] = (res["conf"] >= threshold, False)
    return verdict


# --------------------------------------------------------------------------
def audit(spec, tests_dir, top, threshold, max_rules):
    notes = []
    if not os.path.isfile(spec):
        return {"status": "error", "error": "no such spec: %s" % spec, "notes": notes}
    if not os.path.isdir(tests_dir):
        return {"status": "error", "error": "no such tests dir: %s" % tests_dir, "notes": notes}
    rules = extract_rules(spec)
    tests = collect_tests(tests_dir)
    if len(rules) > max_rules:
        notes.append("audited the first %d of %d rules (--max-rules)" % (max_rules, len(rules)))
        rules = rules[:max_rules]
    if not rules:
        return {"status": "no_rules", "spec": os.path.abspath(spec), "rules": [],
                "covered": [], "uncovered": [], "notes": notes + ["no normative rule line found"]}
    if not tests:
        return {"status": "no_tests", "spec": os.path.abspath(spec), "rules": len(rules),
                "test_files": 0, "covered": [], "uncovered": [],
                "notes": notes + ["no test files matched under %s" % tests_dir]}

    client = load_client()
    docs = [doc for _, doc in tests]
    covered, uncovered = [], []

    # Pass 1 — rerank each rule over the test corpus, keep the top-N candidates.
    candidates = {}   # rule_id -> (line_no, text, [(doc_index, score)])
    for rule_id, line_no, rule_text in rules:
        pairs = rerank_candidates(rule_text, docs, top, client, notes)
        if not pairs:
            uncovered.append({"rule": rule_id, "line": line_no, "text": rule_text,
                              "best_candidates": [], "reason": "no reranker answered",
                              "abstained": True})
            continue
        candidates[rule_id] = (line_no, rule_text, pairs)

    # Pass 2 — group the questions by TEST FILE (one multi-head call per file,
    # chunked at the engine's 16-head cap) because /v1/decide asks one question
    # set about one text.
    by_doc = {}
    for rule_id, (_, rule_text, pairs) in candidates.items():
        for doc_index, score in pairs:
            by_doc.setdefault(doc_index, []).append((rule_id, rule_text, score))

    verdicts = {}
    for doc_index, questions in sorted(by_doc.items()):
        for start in range(0, len(questions), HEADS_PER_CALL):
            batch = questions[start:start + HEADS_PER_CALL]
            asked = [("%s_%d" % (rule_id, doc_index), rule_text) for rule_id, rule_text, _ in batch]
            try:
                answers = judge_doc(docs[doc_index], asked, client, threshold)
            except RuntimeError as exc:
                return {"status": "unavailable", "error": str(exc),
                        "spec": os.path.abspath(spec), "rules": len(rules),
                        "covered": covered, "uncovered": uncovered,
                        "notes": notes + ["stopped early: %s" % exc]}
            for rule_id, _, _ in batch:
                verdicts.setdefault(rule_id, []).append(
                    (docs and tests[doc_index][0],) + answers["%s_%d" % (rule_id, doc_index)])

    for rule_id, (line_no, rule_text, pairs) in candidates.items():
        answers = verdicts.get(rule_id, [])
        witness = next((path for path, hit, _ in answers if hit), None)
        best = [{"path": tests[idx][0], "score": round(score, 6)} for idx, score in pairs]
        if witness:
            covered.append({"rule": rule_id, "line": line_no, "text": rule_text,
                            "witness": {"path": witness}})
        else:
            uncovered.append({
                "rule": rule_id, "line": line_no, "text": rule_text,
                "best_candidates": best,
                "reason": "no top-%d candidate asserts this rule" % top,
                "abstained": any(abstained for _, _, abstained in answers),
            })

    return {
        "status": "ok",
        "spec": os.path.abspath(spec),
        "tests_dir": os.path.abspath(tests_dir),
        "test_files": len(tests),
        "rules": len(rules),
        "covered_count": len(covered),
        "uncovered_count": len(uncovered),
        "coverage": round(len(covered) / float(len(rules)), 4) if rules else 0.0,
        "covered": covered,
        "uncovered": uncovered,
        "notes": notes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="spec_audit.py",
        description="Report spec rules (MUST/SHALL/never/always) with no test that checks them.")
    parser.add_argument("spec", help="specification file (markdown or text)")
    parser.add_argument("tests_dir", help="directory holding the tests")
    parser.add_argument("--top", type=int, default=3, help="candidates judged per rule (default 3)")
    parser.add_argument("--threshold", type=float, default=0.6,
                        help="minimum confidence for a 'covered' verdict (default 0.6)")
    parser.add_argument("--max-rules", type=int, default=60, help="rule cap (default 60)")
    parser.add_argument("--json", action="store_true", help="print JSON only")
    parser.add_argument("--fail-on-uncovered", action="store_true",
                        help="exit 2 when any rule is uncovered")
    args = parser.parse_args(argv)

    result = audit(args.spec, args.tests_dir, args.top, args.threshold, args.max_rules)
    if args.json or result["status"] not in ("ok",):
        print(json.dumps(result, indent=2))
    else:
        print("%s — %d rules, %d covered (%.0f%%), %d uncovered, %d test files"
              % (os.path.basename(result["spec"]), result["rules"], result["covered_count"],
                 result["coverage"] * 100, result["uncovered_count"], result["test_files"]))
        for item in result["uncovered"]:
            best = item["best_candidates"][0]["path"] if item["best_candidates"] else "-"
            print("  UNCOVERED %s (line %d): %s  [closest: %s]"
                  % (item["rule"], item["line"], item["text"][:90], best))
        for note in result["notes"]:
            print("note: %s" % note)

    if result["status"] in ("error", "unavailable"):
        return 1
    if args.fail_on_uncovered and result.get("uncovered_count"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())