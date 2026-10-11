---
description: Token usage + estimated cost report (today / last 7 days, by model and lane)
---
Run the router cost report and summarize it for me.

!`python3 ${AI_SETUP_ROOT}/scripts/cost-report.py $ARGUMENTS`

Interpret the table in 3 bullets max: today's spend vs the 7-day trend, which model/lane dominates, and the cache-hit ratio (low = we are paying for re-reads). If any model shows "price unknown", remind me once that model-prices.json needs an owner-verified entry. Prices in model-prices.json are UNVERIFIED placeholders — say "estimated" whenever you quote a dollar figure.
