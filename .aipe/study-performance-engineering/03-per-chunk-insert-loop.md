# Per-Chunk Insert Loop — N round-trips inside one transaction

**Industry name(s):** row-at-a-time INSERT vs multi-row INSERT / bulk load (COPY); chatty database access. **Type:** Industry standard.

`PgVectorStore.upsert` writes a document's chunks one INSERT at a time, inside a transaction. Functionally correct, atomic — and N round-trips where one would do.

## Zoom out, then zoom in

When a document is indexed, its chunks (each a 768-dim vector plus metadata) have to land in `agents.chunks`. The question is how many times the application talks to Postgres to make that happen.

```
  Zoom out — where the insert loop lives

  ┌─ Index path ─────────────────────────────────────────────────┐
  │  pipeline.index → store.upsert(chunks)                        │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ PgVectorStore.upsert ────▼───────────────────────────────────┐
  │  src/pg-vector-store.ts:38                                    │
  │    begin                                                       │
  │    for (c of chunks) { ★ await client.query(INSERT one row) ★}│ ← we are here
  │    commit                                                      │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Postgres — agents.chunks ▼───────────────────────────────────┐
  │  N parameterized INSERTs, N network round-trips               │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **row-at-a-time INSERT** — the chatty-access anti-pattern. The transaction wrapping is right (all-or-nothing). What's left on the table is collapsing N INSERTs into one multi-row INSERT (or a COPY), turning N round-trips into one.

## The structure pass

Axis: **cost** — number of client↔server round-trips per document indexed.

```
  axis = "round-trips to Postgres per document"

  ┌─ caller: upsert(chunks) ────────┐   → 1 call, conceptually
  └─────────────────┬────────────────┘
  ┌─ inside: begin + loop + commit ─▼───┐   ═══ THE FLIP ═══
  │  begin               → 1 round-trip │   one logical write
  │  INSERT × N          → N round-trips│   becomes N+2 physical
  │  commit              → 1 round-trip │   round-trips
  └─────────────────┬────────────────────┘   ← seam: 1 → N
  ┌─ Postgres ──────▼────────────────────┐
  │  each INSERT parsed, planned, written │
  └───────────────────────────────────────┘
```

**Seam:** the `for` loop inside the transaction. One logical operation ("store this doc's chunks") becomes N+2 physical round-trips. Each is cheap on a localhost connection; the cost is the *count*, which scales with chunks-per-document.

## How it works

### Move 1 — the mental model

You know the difference between calling `INSERT` in a loop versus `INSERT INTO t VALUES (...), (...), (...)` with all rows in one statement? Same data lands either way; one is N statements and N round-trips, the other is one. buffr does the loop version. The transaction makes it atomic — but atomic and one-round-trip are different properties, and buffr has the first without the second.

```
  row-at-a-time (now)          multi-row (possible)

  begin                        begin
  INSERT (c1)  ──►             INSERT VALUES
  INSERT (c2)  ──►               (c1),(c2),...,(cN)  ──► ONE round-trip
  ...  × N                     commit
  commit
  → N+2 round-trips            → 3 round-trips total
```

### Move 2 — the load-bearing skeleton

The kernel is the loop body. From `src/pg-vector-store.ts:38-65`:

```ts
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);   // dim check, in-memory, cheap
  const client = await this.pool.connect();           // grab one pooled connection
  try {
    await client.query('begin');                      // ── round-trip 1
    for (const c of chunks) {
      // ... unpack docId / chunkIndex / content from meta ...
      await client.query(
        `insert into agents.chunks (...) values ($1,...,$6::vector,...)
         on conflict (id) do update set ...`,         // ── round-trip per chunk
        [c.id, docId, this.appId, chunkIndex, content,
         toVectorLiteral(c.vector), this.embeddingModel, c.meta],
      );
    }
    await client.query('commit');                     // ── round-trip N+2
  } catch (err) {
    await client.query('rollback');                   // atomicity: all or nothing
    throw err;
  } finally {
    client.release();                                 // return connection to pool
  }
}
```

Named by what breaks if removed:

- **`begin` / `commit`** — drop these and a mid-document failure leaves the doc half-indexed. They're the atomicity skeleton; keep them. This is *correct*.
- **the per-chunk `await client.query(INSERT)`** — this is the cost. Each iteration is a full parse + plan + execute + network round-trip. Replace the loop body with one multi-row INSERT and N round-trips collapse to one, inside the same transaction. Nothing about atomicity changes.
- **`on conflict (id) do update`** — the upsert semantics (re-indexing a doc overwrites its chunks). Load-bearing for correctness, and it survives a multi-row rewrite — multi-row INSERT supports `ON CONFLICT` too.
- **`client.release()` in `finally`** — drop this and you leak the connection back-pressure; the pool starves. Correct as written.

**Optional hardening, not skeleton:** for a *large* bulk load (thousands of chunks), even multi-row INSERT is beaten by `COPY ... FROM`, which skips per-row statement overhead entirely. That's the right tool for a corpus import; overkill for a single markdown file.

**Does it matter at laptop scale?** A markdown doc chunks into maybe 5-30 chunks, so that's 5-30 INSERTs per file on a localhost Postgres — single-digit milliseconds each, and they're not on any chat hot path (this runs at index time). The cost is real and the fix is clean, but it earns nothing until either the per-doc chunk count or the corpus size grows a lot. It's the *first* thing to reach for if indexing ever feels slow — bigger lever than the cross-file serialization in `02`, because it cuts round-trips multiplicatively.

### Move 3 — the principle

Round-trips are the unit of database cost, not statements. The loop is correct and atomic; it's just chatty. The general move: when you're writing N rows in a loop, ask whether they can be one multi-row statement — same transaction, same atomicity, one-Nth the round-trips. And past a threshold, reach for the bulk-load path (COPY) that skips per-row overhead entirely. buffr left the cheap collapse undone because at its scale the round-trips are free; that's a defensible call, not an oversight.

## Primary diagram

```
  Per-chunk insert loop — one document, N+2 round-trips

  ┌─ PgVectorStore.upsert ───────────────────────────────────────┐
  │  pool.connect()  → one pooled connection                     │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │ begin                          ── round-trip 1            │ │
  │  │ for c in chunks:                                          │ │
  │  │   INSERT ... ON CONFLICT DO UPDATE  ── round-trip × N     │ │
  │  │ commit                         ── round-trip N+2          │ │
  │  └─────────────────────────────────────────────────────────┘ │
  │  on error → rollback (atomic)   ·  finally → client.release()│
  └───────────────────────────┬───────────────────────────────────┘
                              │  N+2 physical round-trips
  ┌─ Postgres — agents.chunks ▼───────────────────────────────────┐
  │  could be 3 with a multi-row INSERT in the same transaction   │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the textbook chatty-database pattern, and it's everywhere because the naive loop is the obvious way to write it. The reason it's tolerable here and not in a high-throughput service: localhost latency is sub-millisecond and the write volume is tiny. In a cloud setup with the DB across a network hop (which buffr explicitly is *not* this phase — `src/db.ts` is a direct connection), each round-trip would carry real network latency and the loop would dominate index time.

For *why* each INSERT costs what it does — parse/plan/execute, WAL append, the HNSW index maintenance per row — see **`study-database-systems`** (query execution, durability). For the pooled connection this loop borrows, see `04-connection-pool-reuse.md`. This file owns the *round-trip count* read.

## Interview defense

**Q: Your upsert loops one INSERT per chunk. Why, and what would you change?**

> It's atomic and correct — wrapped in begin/commit with `ON CONFLICT DO UPDATE` for re-indexing, and it releases the connection in a `finally`. The weakness is round-trips: a doc with N chunks is N+2 round-trips to Postgres. I'd collapse the loop body into one multi-row INSERT — same transaction, same atomicity, one round-trip instead of N. For a big corpus import I'd go further to `COPY`, which skips per-row statement overhead entirely.

```
  loop:  begin · INSERT×N · commit   → N+2 round-trips
  fix:   begin · INSERT VALUES(...)×1 · commit → 3
```

**Q: Why ship it as a loop then?**

> Round-trips are free at my scale — localhost Postgres, sub-millisecond per call, and it runs at index time, not on a chat turn no user's waiting. The multi-row rewrite earns nothing until chunk-per-doc or corpus size grows. That said, it's the *first* lever I'd pull if indexing got slow, because cutting round-trips is a multiplicative win — bigger than parallelizing the file loop.

> Anchor: `src/pg-vector-store.ts:43-57` (the loop body), `:42`/`:58` (the txn that stays).

## See also

- `00-overview.md` — finding #3
- `audit.md` — lens 5 (I/O), lens 8 (red flags #3)
- `02-embedding-roundtrip.md` — the embed step these writes follow
- `04-connection-pool-reuse.md` — the pooled connection this loop borrows
- `05-per-turn-memory-and-trace-cost.md` — the per-turn write side
- **`study-database-systems`** — INSERT cost, WAL, index maintenance
