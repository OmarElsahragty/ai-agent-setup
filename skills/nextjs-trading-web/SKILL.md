---
name: nextjs-trading-web
description: Architecture, data fetching, live streaming, zero-mock hydration, and UX stability for Next.js 15 App Router financial and trading dashboards.
---

# Next.js Trading Web Engineering Skill

## 1. Zero-Mock Database SOT (Strict Rule)
- NEVER hardcode mock KPIs, CAGR, profit factor, win rate, or fake account equity charts.
- All metrics and tables must hydrate directly from authoritative database queries (the project's database package) or live backend API routes.
- If no records exist, always render explicit zero/empty states (`0.00 EGP`, `0%`, "No positions open"), never simulation mockups.

## 2. Server vs Client Component Boundaries
- **Server Components (Default)**: Use for initial page data loaders, historical performance summaries, trade ledgers, and SEO metadata. Fetch directly from the project's database package via Drizzle ORM.
- **Client Components (`'use client'`)**: Isolate strictly to interactive widgets:
  * Trade execution order modal (with keyboard shortcut `B` for Buy, `S` for Sell, `Esc` to close).
  * Real-time ticker price feeds via Server-Sent Events (SSE) or WebSockets.
  * Interactive filter controls, date range pickers, and tab navigation.
- Keep Client Component trees as shallow and localized as possible to minimize client bundle size and hydration overhead.

## 3. Financial UX & Stability
- **Layout Shift Prevention**: Always declare explicit dimensions or aspect ratios for chart containers and data tables. Never let arriving data trigger Cumulative Layout Shift (CLS).
- **Tabular Numerics**: Always use `tabular-nums font-mono` for financial amounts, percentages, quantities, and timestamps to ensure columnar visual alignment.
- **Color Discipline**:
  * Gains / Bullish: Emerald/Green (`text-emerald-500`, `bg-emerald-500/10`)
  * Losses / Bearish: Rose/Red (`text-rose-500`, `bg-rose-500/10`)
  * Neutral: Zinc/Slate (`text-zinc-400`)
- **Action Confirmations**: Trade execution actions must always provide a visual review step summarizing ticker, side, shares, limit price, estimated total cost, and broker fees before order dispatch.
