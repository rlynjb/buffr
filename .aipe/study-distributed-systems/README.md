# Study — Distributed Systems (applied to `buffr-laptop`)

Reading order and what each file is for. This guide is **audit-style** (`me.md` two-pass shape): one honest lens audit, then a short list of pattern files for the few coordination seams the repo actually has.

The headline up front, because it's the most important thing about this repo: **`buffr-laptop` is a single-device system.** One Node process, two remote dependencies (Postgres over a pool, Ollama over HTTP). No peers, no replicas, no queues, no consensus, no second writer. Most distributed-systems lenses come back **`not yet exercised`** — and that's the correct verdict, not a gap to paper over. The real distributed problem (a laptop brain and a phone brain sharing one Supabase) is **designed but deferred** — design, not code.

## Reading order

```
  1. 00-overview.md   the coordination map + ranked findings + the honest "not yet exercised" ledger
  2. audit.md         all 9 distributed-systems lenses walked against the repo, each marked honestly
  3. 01-app-to-postgres-boundary.md      the ONE real client/server seam (pg.Pool, fail-fast)
  4. 02-trace-sink-write-buffering.md    async write buffering where ordering is decided at emit, not by the flush race
  5. 03-deferred-two-brain-shared-memory.md   DESIGN-NOT-CODE: the future laptop+phone-share-Supabase distributed problem
```

Read `00` first for the map and the verdict. Read `audit.md` to see every lens checked. The three pattern files are the only places this repo has anything coordination-shaped worth a deep walk — and the third is explicitly a future design, labeled as such throughout.

## Cross-links (where the neighboring mechanism actually lives)

This guide owns **correctness across a coordination boundary**. It deliberately does *not* re-teach mechanisms that belong to its neighbors:

- **`study-system-design/`** — the architectural shape and scale tradeoffs (the deferred-body decision, the vector-store adapter, the long-lived session). See `study-system-design/07-deferred-body.md` and `04-long-lived-chat-session.md`.
- **`study-database-systems/`** — datastore-*local* consistency: transactions, isolation, MVCC, WAL, single-node durability. The `begin/commit/rollback` in `migrate.ts` and the `ON CONFLICT` upserts are taught there (`05-transactions-isolation-and-anomalies.md`, `08-replication-and-read-consistency.md`).
- **`study-debugging-observability/`** — the trajectory capture as an *observability* artifact (what the trace sink lets you see). This guide covers the same sink as a *write-ordering* problem; observability covers it as evidence.

A finding belongs to the generator that owns the mechanism. When in doubt this guide cross-links rather than duplicates.
