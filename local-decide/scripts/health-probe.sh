#!/usr/bin/env bash
# ${AI_SETUP_ROOT}/local-decide/scripts/health-probe.sh — Batch E, 2026-10-02.
# One-shot liveness gate for the local AI units. Exits non-zero if ANY check
# fails. One line per check. No timer/cron by owner rule — run ad hoc or from
# a human-triggered gate.
#   11438 local-decide  /health        ok:true
#   11435 llama-rerank  /v1/rerank     Paris ranks above bananas
#   (11439 llama-rerank-4b retired 2026-10-06)
#   11437 llama-embed   /v1/embeddings returns a non-empty vector
set -uo pipefail

fail=0

note() { printf '%s\n' "$1"; }

# 1) local-decide /health — the app recycles its GLiNER worker itself (its own
# watchdog; see `restarts` in the /health payload). During the ~20s model
# reload /health is briefly unavailable while live hook traffic still flows.
# Retry so a single-shot check doesn't land in that recycle window; a dead
# unit fails all five attempts.
ok="false"
for attempt in 1 2 3 4 5; do
  if body="$(curl -sf -m 10 http://127.0.0.1:11438/health 2>/dev/null)" \
     && ok="$(jq -r '.ok // false' <<<"${body}" 2>/dev/null)" && [ "${ok}" = "true" ]; then
    break
  fi
  ok="false"
  [ "${attempt}" -lt 5 ] && sleep 5
done
if [ "${ok}" = "true" ]; then
  note "OK   local-decide    :11438 /health ok=true"
else
  note "FAIL local-decide    :11438 /health (no 200 or ok!=true after retries)"; fail=1
fi

# 2) 3) rerankers: top result must be "Paris" (index 0) with a higher score
for port in 11435; do  # :11439 (rerank-4b) retired 2026-10-06
  body="$(curl -sf -m 120 -X POST "http://127.0.0.1:${port}/v1/rerank" \
    -H 'Content-Type: application/json' \
    -d '{"model":"rerank","query":"Which one is a city?","documents":["Paris","bananas"]}' 2>/dev/null)" || body=""
  verdict="$(jq -r 'if (.results? | length) >= 2 and .results[0].index == 0 and (.results[0].relevance_score > .results[1].relevance_score) then "ok" else "bad" end' <<<"${body}" 2>/dev/null)" || verdict="bad"
  if [ "${verdict}" = "ok" ]; then
    note "OK   rerank :${port} Paris > bananas"
  else
    note "FAIL rerank :${port} (Paris not ranked first, or request failed)"; fail=1
  fi
done

# 4) embeddings: must return a non-empty vector
body="$(curl -sf -m 60 -X POST http://127.0.0.1:11437/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input":"health-probe","model":"embed"}' 2>/dev/null)" || body=""
verdict="$(jq -r 'if (.data? | length) >= 1 and (.data[0].embedding? | length) > 0 then "ok" else "bad" end' <<<"${body}" 2>/dev/null)" || verdict="bad"
if [ "${verdict}" = "ok" ]; then
  note "OK   llama-embed     :11437 embeddings vector returned"
else
  note "FAIL llama-embed     :11437 embeddings (no vector, or request failed)"; fail=1
fi

exit "${fail}"
