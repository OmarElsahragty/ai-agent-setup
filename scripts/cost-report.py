#!/usr/bin/env python3
"""WO-6 cost visibility: token + estimated-cost report from router-usage.jsonl.

Reads the router's usage log (default ${AI_SETUP_ROOT}/state/router-usage.jsonl,
overridable with --fixture <path> for tests) and prints today's and the last 7
days' totals per model and per lane, the cache-hit ratio, and an estimated cost
from scripts/model-prices.json (placeholder prices, UNVERIFIED — owner to confirm).
Read-only; never exits non-zero on malformed lines.
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("AI_SETUP_ROOT") or Path(__file__).resolve().parents[1])
USAGE_LOG = ROOT / "state" / "router-usage.jsonl"
PRICES = Path(__file__).with_name("model-prices.json")
FIELDS = ("input", "output", "cache_read", "cache_creation")


def parse_ts(ts):
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.astimezone()
    except Exception:
        return None


def load_prices():
    try:
        data = json.loads(PRICES.read_text("utf-8"))
        return data.get("per_1m_usd", {}), data.get("_meta", {}).get("note", "")
    except Exception:
        return {}, ""


def cost_usd(model, rec, prices):
    p = prices.get(model)
    if not p:
        return None
    total = 0.0
    for f in FIELDS:
        key = "cache_write" if f == "cache_creation" else f
        total += rec[f] * float(p.get(key, 0.0)) / 1e6
    return total


def fmt_tok(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else (f"{n / 1e3:.1f}k" if n >= 1000 else str(n))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fixture", help="read this jsonl instead of the live usage log")
    args = ap.parse_args()
    src = Path(args.fixture) if args.fixture else USAGE_LOG

    prices, note = load_prices()
    now = datetime.now().astimezone()
    today = now.date()
    week_start = (now - timedelta(days=7)).timestamp()
    per_model = {today: defaultdict(lambda: dict.fromkeys(FIELDS, 0)), "7d": defaultdict(lambda: dict.fromkeys(FIELDS, 0))}
    per_lane = {today: defaultdict(lambda: dict.fromkeys(FIELDS, 0)), "7d": defaultdict(lambda: dict.fromkeys(FIELDS, 0))}
    lines = requests = 0

    try:
        fh = src.open("r", encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"no usage log at {src} ({e.strerror or e}) — nothing to report yet")
        return 0
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            ts = parse_ts(rec.get("ts"))
            if not ts or ts.timestamp() < week_start:
                continue
            # the 7-day window includes today
            buckets = (today, "7d") if ts.date() == today else ("7d",)
            requests += 1 if ts.date() == today else 0
            model, lane = str(rec.get("model", "?")), str(rec.get("lane") or rec.get("role") or "-")
            for f in FIELDS:
                v = rec.get(f)
                if isinstance(v, (int, float)) and v >= 0:
                    for bucket in buckets:
                        per_model[bucket][model][f] += v
                        per_lane[bucket][lane][f] += v

    def section(title, bucket):
        print(f"\n== {title} ==")
        if not per_model[bucket]:
            print("  no usage recorded")
            return
        print(f"  {'model':<24}{'in':>9}{'out':>9}{'cache_r':>9}{'cache_w':>9}  est.cost")
        grand = 0.0
        unknown = False
        for model in sorted(per_model[bucket]):
            r = per_model[bucket][model]
            c = cost_usd(model, r, prices)
            if c is None:
                unknown = True
                cost_s = "price unknown"
            else:
                grand += c
                cost_s = f"${c:.2f}"
            print(f"  {model:<24}{fmt_tok(r['input']):>9}{fmt_tok(r['output']):>9}"
                  f"{fmt_tok(r['cache_read']):>9}{fmt_tok(r['cache_creation']):>9}  {cost_s}")
        print(f"  {'TOTAL':<24}{'':>36}  ${grand:.2f}" + ("  (+ unknown-price models)" if unknown else ""))
        print("  by lane: " + ", ".join(
            f"{lane}={fmt_tok(sum(r[f] for f in FIELDS))}" for lane, r in sorted(per_lane[bucket].items())))

    print(f"router cost report — source: {src}")
    if note:
        print(f"prices: {note}")
    cr = sum(per_model[today][m]["cache_read"] for m in per_model[today])
    tot = sum(sum(per_model[today][m][f] for f in FIELDS) for m in per_model[today])
    print(f"today: {requests} logged responses, cache-hit ratio {cr / tot * 100:.1f}%" if tot else "today: no usage recorded")
    section("today", today)
    section("last 7 days", "7d")
    return 0


if __name__ == "__main__":
    sys.exit(main())
