---
name: postgres-drizzle-audit
description: "Schema parity, migration safety, transaction isolation, index optimization, and locking prevention for PostgreSQL and Drizzle ORM in trading."
---

# PostgreSQL & Drizzle ORM Audit Skill

## 1. Bi-directional Parity Invariant
Whenever modifying `packages/db/schema.ts` or applying PostgreSQL DDL migrations:
- Run `pnpm --filter ./packages/db test` to verify 100% exact parity between Drizzle ORM column definitions and PostgreSQL `information_schema.columns`.
- No column type mismatches, nullability discrepancies, or missing default constraints are permitted.

## 2. Safe Financial Ledger Transactions
- Financial ledger entries (orders, fills, cash transfers, dividends) must execute within database transactions:
  ```typescript
  await db.transaction(async (tx) => {
    // 1. Deduct cash balance with balance check constraint
    // 2. Insert trade record
    // 3. Update position holdings
  });
  ```
- Always rely on PostgreSQL native constraints (`CHECK (balance >= 0)`, `UNIQUE`, `FOREIGN KEY ON DELETE RESTRICT`) rather than application-layer checks alone.

## 3. High-Performance Indexing for Market Data
- Candle and quote tables grow into millions of rows. Ensure compound indexes exist on:
  * `(symbol, timestamp DESC)` for fast historical price bar lookups.
  * `(account_id, created_at DESC)` for trade ledger pagination.
  * `(status, scheduled_time)` for worker queue polling.
- Always run `EXPLAIN (ANALYZE, BUFFERS)` before deploying queries that scan high-volume financial tables.

## 4. Lock Prevention
- Avoid long-running transactions that hold table-level locks (`ALTER TABLE`, unindexed foreign key cascades).
- When altering large tables in production, use `CONCURRENTLY` for index creation:
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_symbol_ts ON trades (symbol, timestamp DESC);`
