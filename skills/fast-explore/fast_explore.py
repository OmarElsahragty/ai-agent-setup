#!/usr/bin/env python3
"""fast_explore — hybrid code search for a repo, in one command.

    python3 fast_explore.py <repo> "<query>" [--top 10] [--model none|4b|0.6b] [--json]

Pipeline (see ../SKILL.md for when to use it):
  1. keyword leg  — `rg -c -i -F -e <kw>...` per-file match counts (BM25-ish)
                    plus a filename-hit prior. Works with no daemon at all.
  2. dense leg    — embed the query and each candidate's file head via the local
                    llama-embed unit on 127.0.0.1:11437 (/v1/embeddings, OpenAI
                    shape) and score by cosine.
  3. RRF fuse     — reciprocal rank fusion, k=60, so a file strong in either leg
                    survives; the pool is padded to >= --min-candidates (50).
  4. rerank       — cross-encoder on the fused pool: 4B (:11439) by default,
                    0.6B (:11435) as the fallback, RRF order if both are down.

Every leg degrades independently: no daemon, no embeddings, no reranker, no `rg`
— each is a note in the output, never a crash. Standard library only.
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

EMBED_URL = "http://127.0.0.1:11437/v1/embeddings"
RERANK_PORTS = {"4b": 11439, "0.6b": 11435}
DAEMON = "http://127.0.0.1:11438"
# AI_SETUP_ROOT wins (install.sh and the bin/ wrappers export it); else <root> is this file's ../../
LOCAL_DECIDE = str(
    Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[2]) / "local-decide"
)

RRF_K = 60.0
STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
    "are", "be", "do", "does", "how", "where", "what", "which", "that", "this",
    "it", "as", "at", "by", "from", "we", "i", "you", "my", "our", "code", "file",
    "files", "find", "show", "me", "please", "can", "use", "using",
}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".zip",
              ".gz", ".bz2", ".xz", ".7z", ".so", ".dylib", ".dll", ".exe",
              ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".wasm", ".pyc"}
MAX_READ_BYTES = 256 * 1024
HEAD_LINES = 40
HEAD_CHARS = 1200
# rg-leg caps: a pathological query must not turn the keyword leg into a
# repo-wide scan with an unbounded process and an unbounded read.
MAX_QUERY_CHARS = 512
RG_TERM_MIN, RG_TERM_MAX, MAX_RG_TERMS = 3, 64, 12
MAX_RG_HITS = 2000
RG_TIMEOUT_S = 30.0


# --------------------------------------------------------------------------
# client.py adapter (same three-liner as the other scripts: client.py is owned
# by another worker; until it lands we call the loopback units directly)
# --------------------------------------------------------------------------
def load_client():
    if LOCAL_DECIDE not in sys.path:
        sys.path.insert(0, LOCAL_DECIDE)
    try:
        import client as real_client  # type: ignore
        if callable(getattr(real_client, "rerank", None)):
            return real_client
    except Exception:
        pass
    return None


def post_json(url, payload, timeout):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body else {}


def usable_ranking(rows, n_docs):
    """A ranking is usable only when it carries signal.

    A llama.cpp reranker whose conversion is missing `cls.output.weight` answers
    with a plausible shape and useless numbers — all-equal (often exactly 0.0)
    scores in arbitrary order. That is the silent-garbage failure mode, so a
    flat ranking is rejected here and the next tier is tried.
    """
    pairs = norm_rows(rows, n_docs)
    if not pairs:
        return False, pairs
    scores = [score for _, score in pairs]
    return (max(scores) - min(scores)) > 1e-6, pairs


def rerank(query, documents, model, top_n, client, notes):
    """4B by default, 0.6B as the fallback; RRF order if both refuse.

    client.rerank signals an unreachable daemon by returning [], so an empty
    answer is treated as a failed attempt and the next tier is tried.
    """
    order = [model] + [m for m in ("4b", "0.6b") if m != model]
    for attempt in order:
        # 1) client.py (daemon proxy) when it is available
        if client is not None:
            try:
                rows = client.rerank(query, documents, model=attempt, top_n=top_n)
            except Exception as exc:
                notes.append("rerank %s via client.py failed: %s" % (attempt, exc))
                rows = None
            ok, pairs = usable_ranking(rows, len(documents))
            if ok:
                return pairs, attempt
            if rows:
                notes.append("rerank %s via client.py gave no signal — trying the next tier" % attempt)
        # 2) the llama.cpp reranker unit itself
        url = "http://127.0.0.1:%d/v1/rerank" % RERANK_PORTS[attempt]
        try:
            raw = post_json(url, {"query": query, "documents": documents,
                                  "top_n": top_n}, timeout=30.0)
        except Exception as exc:
            notes.append("rerank %s unavailable: %s" % (attempt, exc))
            continue
        rows = raw.get("results", raw.get("data")) if isinstance(raw, dict) else raw
        if not isinstance(rows, list):
            notes.append("rerank %s returned no usable ranking" % attempt)
            continue
        ok, pairs = usable_ranking(rows, len(documents))
        if ok:
            return pairs, attempt
        notes.append("rerank %s returned a flat ranking (scores carry no signal) — "
                     "suspect the model conversion, not the query" % attempt)
    return None, None


def norm_rows(raw, n_docs):
    rows = raw
    if isinstance(raw, dict):
        rows = raw.get("results", raw.get("data", []))
    out, seen = [], set()
    for pos, row in enumerate(rows or []):
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
        out.append((idx, score))
    out.sort(key=lambda pair: pair[1], reverse=True)
    return out


# --------------------------------------------------------------------------
# leg 1 — keyword
# --------------------------------------------------------------------------
def keywords(query):
    seen, out = set(), []
    for token in re.findall(r"[A-Za-z0-9_]+", query):
        low = token.lower()
        if low in STOPWORDS or len(low) < 2 or low.isdigit() or low in seen:
            continue
        seen.add(low)
        out.append(low)
    return out or [query.strip().lower() or "*"]


def rg_leg_terms(terms):
    """rg-leg terms only: 3-64 chars, at most 12 (keywords() already dedupes).

    Short tokens ("ai", "js") fan out over half the repo and bury the signal,
    and hundreds of -e flags slow every rg start — so the rg leg searches the
    capped subset while python_counts / the filename prior keep the full set.
    """
    return [t for t in terms if RG_TERM_MIN <= len(t) <= RG_TERM_MAX][:MAX_RG_TERMS]


def rg_counts(repo, terms, notes):
    """{path: match_line_count} via one rg invocation (None when rg is absent).

    Bounded twice over: the process is killed after RG_TIMEOUT_S (partial counts
    kept, noted) and at most MAX_RG_HITS output lines are parsed.
    """
    if not shutil.which("rg") or not terms:
        return None
    cmd = ["rg", "--no-messages", "-c", "-i", "-F"]
    for term in terms:
        cmd += ["-e", term]
    for glob in ("!*.bak", "!*.bak.*", "!*.bak-*", "!*.orig", "!*.rej", "!*~"):  # same backup filter as the dense leg
        cmd += ["-g", glob]
    cmd += ["--", "."]
    try:
        proc = subprocess.Popen(cmd, cwd=repo, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, errors="replace")
    except OSError:
        return None
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=RG_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            out, _ = proc.communicate(timeout=5)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            out = ""
        timed_out = True
    except OSError:
        return None
    counts = {}
    hits = 0
    for line in out.splitlines():
        if hits >= MAX_RG_HITS:
            notes.append("rg output capped at %d file counts — keyword counts are partial"
                         % MAX_RG_HITS)
            break
        path, _, raw = line.rpartition(":")
        if not path:
            continue
        try:
            counts[path] = counts.get(path, 0) + int(raw)
            hits += 1
        except ValueError:
            continue
    if timed_out:
        notes.append("rg hit the %.0fs timeout — keyword counts are partial" % RG_TIMEOUT_S)
    return counts


def walk_files(repo, limit):
    """Repo file list (bounded), used to pad the candidate pool."""
    files = []
    for root, dirs, names in os.walk(repo):
        dirs[:] = [d for d in dirs
                   if d not in {".git", "node_modules", "__pycache__", ".venv", "venv",
                                "dist", "build", ".next", ".cache", "target", ".mypy_cache"}
                   and not d.startswith(".")]
        for name in names:
            if os.path.splitext(name)[1].lower() in BINARY_EXT or name.startswith("."):
                continue
            if name.endswith((".bak", ".orig", ".rej", "~")) or ".bak." in name or ".bak-" in name:
                continue  # near-duplicate editor backups waste rerank slots
            rel = os.path.relpath(os.path.join(root, name), repo)
            files.append(rel)
            if len(files) >= limit:
                return files
    return files


def python_counts(repo, files, terms):
    counts = {}
    for rel in files:
        path = os.path.join(repo, rel)
        try:
            if os.path.getsize(path) > MAX_READ_BYTES:
                continue
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                hits = sum(1 for line in handle if any(t in line.lower() for t in terms))
        except OSError:
            continue
        if hits:
            counts[rel] = counts.get(rel, 0) + hits
    return counts


def file_head(repo, rel):
    path = os.path.join(repo, rel)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            body = "".join([handle.readline() for _ in range(HEAD_LINES)])
    except OSError:
        return ""
    return ("%s\n%s" % (rel, body))[:HEAD_CHARS].strip()


# --------------------------------------------------------------------------
# leg 2 — dense
# --------------------------------------------------------------------------
def embed(texts, notes, timeout):
    if not texts:
        return []
    for payload in ({"input": texts}, {"model": "default", "input": texts}):
        try:
            raw = post_json(EMBED_URL, payload, timeout=timeout)
        except Exception as exc:
            notes.append("embeddings unavailable: %s" % exc)
            return []
        data = raw.get("data") if isinstance(raw, dict) else raw
        if not isinstance(data, list) or not data:
            continue
        vectors = [None] * len(texts)
        for pos, item in enumerate(data):
            vec = item.get("embedding") if isinstance(item, dict) else item
            idx = item.get("index", pos) if isinstance(item, dict) else pos
            if not isinstance(vec, list) or not (0 <= int(idx) < len(texts)):
                continue
            vectors[int(idx)] = vec
        if any(v is not None for v in vectors):
            return [v or [] for v in vectors]
    notes.append("embeddings returned no usable vectors")
    return []


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def rrf(rankings):
    fused = {}
    for ranked in rankings:
        for rank, path in enumerate(ranked, start=1):
            fused[path] = fused.get(path, 0.0) + 1.0 / (RRF_K + rank)
    return fused


# --------------------------------------------------------------------------
def explore(repo, query, top, model, min_candidates, max_embed, timeout):
    notes = []
    if not os.path.isdir(repo):
        return {"error": "not a directory: %s" % repo, "files": [], "notes": notes}
    repo = os.path.abspath(repo)
    query = query[:MAX_QUERY_CHARS]
    terms = keywords(query)
    universe = walk_files(repo, max(max_embed, min_candidates) * 4)
    if not universe:
        return {"error": "no candidate files under %s" % repo, "files": [], "notes": notes}

    rg_terms = rg_leg_terms(terms)
    counts = rg_counts(repo, rg_terms, notes)
    if counts is None:
        notes.append("rg unavailable or no rg-sized terms — keyword leg ran in pure python")
        counts = python_counts(repo, universe, terms)
    else:
        counts = {(path[2:] if path.startswith("./") else path): n
                  for path, n in counts.items()}

    # filename prior: a term in the path is a strong, cheap signal
    for rel in universe:
        low = rel.lower()
        bonus = sum(1 for term in terms if term in low)
        if bonus:
            counts.setdefault(rel, 0)
            counts[rel] += 4 * bonus

    kw_ranked = sorted(counts, key=lambda p: (-counts[p], p))
    if not kw_ranked:
        notes.append("keyword leg found nothing — dense leg carries the search")
        kw_ranked = universe[:max_embed]

    embed_pool = (kw_ranked + [p for p in universe if p not in counts])[:max_embed]
    heads = [file_head(repo, rel) for rel in embed_pool]
    vectors = embed([query] + heads, notes, timeout)

    dense_scores, dense_ranked = {}, []
    if len(vectors) > 1 and vectors[0]:
        query_vec = vectors[0]
        scored = []
        for pos, rel in enumerate(embed_pool):
            vec = vectors[pos + 1] if pos + 1 < len(vectors) else []
            score = cosine(query_vec, vec)
            dense_scores[rel] = score
            scored.append((score, rel))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        dense_ranked = [rel for score, rel in scored if score > 0.0]

    fused = rrf([kw_ranked, dense_ranked])
    pool = sorted(fused, key=lambda p: (-fused[p], p))[:max_embed]
    if len(pool) < min(min_candidates, len(universe)):
        for rel in universe:
            if len(pool) >= min(min_candidates, len(universe)):
                break
            if rel not in fused:
                pool.append(rel)

    documents = [file_head(repo, rel) or rel for rel in pool]
    client = load_client()
    # Code-loc eval 2026-10-02 (state/local-decide/eval-report.md): embed+RRF Acc@10 90% equals both
    # rerankers, which add 0 points for 2-7 s p95 — so the fused order is the default.
    if model == "none":
        ranked, used_model = [], "none"
    else:
        ranked, used_model = rerank(query, documents, model, top, client, notes)

    results = []
    if ranked:
        for idx, score in ranked[:top]:
            rel = pool[idx]
            results.append(_row(rel, counts, dense_scores, fused, score))
    else:
        if model != "none":
            notes.append("no reranker answered — returning the fused order")
        for rel in pool[:top]:
            results.append(_row(rel, counts, dense_scores, fused, fused[rel]))

    return {
        "query": query,
        "repo": repo,
        "terms": terms,
        "candidates": len(pool),
        "keyword_hits": len(counts),
        "dense_hits": len(dense_ranked),
        "rerank_model": used_model,
        "files": results,
        "notes": notes,
    }


def _row(rel, counts, dense_scores, fused, score):
    bits = []
    if rel in counts:
        bits.append("kw:%d" % counts[rel])
    if rel in dense_scores:
        bits.append("cos:%.3f" % dense_scores[rel])
    bits.append("rrf:%.4f" % fused.get(rel, 0.0))
    if score:
        bits.append("rerank:%.4f" % score)
    return {"path": rel, "score": round(float(score), 6), "reason": " ".join(bits)}


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="fast_explore.py",
        description="Hybrid keyword + embedding + rerank code search over a repo.")
    parser.add_argument("repo", help="repository root to search")
    parser.add_argument("query", help="natural-language query or keywords")
    parser.add_argument("--top", type=int, default=10, help="files to return (default 10)")
    parser.add_argument("--model", default="none", choices=["none", "4b", "0.6b"],
                        help="reranker to try first (default 4b, falls back to 0.6b)")
    parser.add_argument("--min-candidates", type=int, default=50,
                        help="floor for the fused pool before rerank (default 50)")
    parser.add_argument("--max-embed", type=int, default=150,
                        help="file heads to embed (default 150)")
    parser.add_argument("--timeout", type=float, default=45.0, help="embedding timeout seconds")
    parser.add_argument("--json", action="store_true", help="print JSON only")
    args = parser.parse_args(argv)

    if args.top < 1:
        parser.error("--top must be >= 1")
    result = explore(args.repo, args.query, args.top, args.model,
                     args.min_candidates, args.max_embed, args.timeout)
    if args.json or "error" in result:
        print(json.dumps(result, indent=2))
    else:
        print("%d candidates (%d keyword, %d dense) — rerank: %s"
              % (result["candidates"], result["keyword_hits"], result["dense_hits"],
                 result["rerank_model"] or "none"))
        for i, row in enumerate(result["files"], 1):
            print("%2d. %s  [%s]" % (i, row["path"], row["reason"]))
        for note in result["notes"]:
            print("note: %s" % note)
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())