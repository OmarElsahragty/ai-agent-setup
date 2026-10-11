---
name: fast-explore
description: Hybrid code search (keyword + embeddings + local reranker) that returns ranked files with a reason. Use BEFORE any broad Grep or find sweep when the question is "which files handle X" in an unfamiliar or large repo.
---

# Fast Explore

One command replaces a broad `Grep` sweep when the real question is *"which
files handle this?"* rather than *"which lines contain this string?"*.

## Purpose

Rank a repository's files against a natural-language question using three local
legs fused together, and return the top files with a one-line reason each.

## When to use it

Use it FIRST, before a broad `Grep`/`find`/`rg -l` sweep, when:

- the repo is unfamiliar or large and you do not yet know the file names;
- the question is semantic ("where is the retention/keep-drop logic?",
  "which module enforces the fee rule?") rather than a literal symbol;
- a broad sweep would burn a lot of context on mostly-irrelevant matches;
- you need a ranked shortlist to then read 3-5 files precisely.

Do **not** use it when:

- you already know the exact symbol and want its lines -> `Grep` / `search_code`;
- you want to *change* code -> this is read-only discovery, use it first then `Read`;
- the repo has fewer than ~50 files -> a direct sweep is faster and exact.

## Prerequisites

- [ ] `rg` (ripgrep) on PATH — falls back to a pure-python scan if absent
- [ ] `llama-embed` on `127.0.0.1:11437` for the dense leg (optional; a note is emitted without it)
- [ ] `llama-rerank` on `127.0.0.1:11439` (4B) or `127.0.0.1:11435` (0.6B), or the
      `local-decide` daemon on `127.0.0.1:11438` proxying them (optional; a note is emitted without it)

## Allowed scopes

Read-only. The script never writes, moves or deletes anything, and never leaves
the loopback interface.

## Required tools

- `bash` — to run the script

## Steps

1. **Run the search**
   ```bash
   python3 ${AI_SETUP_ROOT}/skills/fast-explore/fast_explore.py <repo> "<query>"
   ```
   Options: `--top N` (default 10), `--model none|4b|0.6b` (default none: the code-loc eval showed embed+RRF Acc@10 90% with no reranker gain; 4b auto-falls back
   to 0.6b), `--min-candidates N` (default 50), `--max-embed N` (default 150),
   `--json` (JSON only, no human summary).

2. **Read the output** — one line per file: path plus
   `kw:<matches> cos:<cosine> rrf:<fused> rerank:<score>`, so you can see which leg
   found it. Read the top 3-5 files with the normal `Read` tool for exact lines.

3. **Check the `note:` lines before trusting the order** — each note names a leg
   that did not contribute (embeddings down, a reranker down, a flat ranking).

## How it works

1. **Keyword leg** — one `rg -c -i -F -e <term>...` gives per-file match counts,
   plus a filename-hit prior (a term in the path is worth 4 counts).
   Bounded for pathological input: the query is capped at 512 chars, rg gets at
   most 12 distinct terms of 3-64 chars (stopwords already dropped; the pure-
   python fallback still sees the full set), the rg call is killed after 30 s
   and at most 2,000 output lines are parsed (both noted when hit).
2. **Dense leg** — the query and each candidate's file head (path + first 40 lines)
   are embedded via `POST 127.0.0.1:11437/v1/embeddings` and scored by cosine.
3. **RRF fusion** — reciprocal rank fusion, `k=60`, over both legs, padded to at
   least `--min-candidates` so the reranker has a real pool.
4. **Rerank** — the local cross-encoder on the fused pool: 4B first, 0.6B as the
   fallback, fused order if neither answers.

## Validation

```bash
python3 ${AI_SETUP_ROOT}/skills/fast-explore/fast_explore.py ${AI_SETUP_ROOT}/local-decide \
  "retention head keeps or drops a message at compaction" --top 5 --json
```
Expected: `quant-engineer`-style hits ranked first with a non-empty `reason` on
each, and a `rerank_model` of `4b` or `0.6b`.

## Rollback

None needed — the script is read-only. To undo a ranking decision, ignore the
output and `Read` the files you already knew about.

## Learned

- A flat (all-equal, usually exactly `0.0`) reranker response is a **broken model
  conversion**, not a bad query. The script detects it and falls back to the other
  tier; if you see that note, do not trust the 4B unit until its conversion is fixed.
- Embedding file *heads* beats embedding whole files: 150 short heads is one fast
  CPU batch, whole files is not.

## Notes

- Known defect (2026-10-02): `llama-rerank-4b` on `:11439` answers every request
  with `score: 0.0`. The script detects this and falls back to `:11435`.
- Search quality is bounded by the head window: a rule stated 200 lines into a file
  scores like an unrelated file. Use the output to shortlist, then grep precisely.
- Standard library only; runs under `/usr/bin/python3` with no venv.