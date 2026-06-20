# Per-Chunk INSERT Loop

*Row-at-a-time writes inside a transaction; the multi-row INSERT / COPY it isn't —
Project-specific.*

## Zoom out, then zoom in

After embedding turns a document into vectors, those vectors have to land in
Postgres. That's the write side of indexing — the box marked below. It's
correct and atomic, and it's also doing one statement per chunk where one
statement could do the whole batch.

```
  Zoom out — where the write sits

  ┌─ Pipeline (aptkit) ──────────────────────────────────────────┐
  │  chunk → embed → store.upsert(chunks)                         │
  └─────────────────────────┬────────────────────────────────────┘
                            │  upsert(chunks: Chunk[])
  ┌─ VectorStore (buffr) ───▼────────────────────────────────────┐
  │  PgVectorStore.upsert()   ★ THIS CONCEPT ★                    │ ← we are here
  │  begin → for each chunk: INSERT … on conflict → commit        │
  └─────────────────────────┬────────────────────────────────────┘
                            │  N statements over one warm connection
  ┌─ Storage — Postgres ────▼────────────────────────────────────┐
  │  agents.chunks (id, embedding vector(768), …)                │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the method receives an *array* of chunks but writes them with an array
*of statements* — a `for` loop firing one parameterized INSERT per element. The
pattern is "row-at-a-time inside a transaction." The alternative — one multi-row
INSERT, or `COPY` for bulk — does the same work in one round-trip to the
executor. This file is about that gap, and honestly about how little it matters
at buffr's scale.

## Structure pass

**Layers.** Two that matter: the *transaction boundary* (`begin`/`commit`,
atomicity) and the *statement granularity* (one INSERT per chunk vs one per
batch).

**Axis — cost (statements executed per document).** Trace it:

```
  "how many statements per indexed document?" — traced down

  ┌───────────────────────────────────────┐
  │ upsert(chunks): receives an array     │   → 1 logical operation
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ the for loop: one query per chunk    │   → N statements
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ Postgres: parse+plan+exec each   │   → N executions, 1 txn
          └─────────────────────────────────┘

  one logical upsert fans out to N statements — that's the cost
```

**Seam — the transaction wrapper.** `begin … commit` is the load-bearing joint.
Inside it, the N INSERTs are *atomic* — all land or none do, so a half-indexed
document can't exist. That atomicity is the reason the loop isn't just sloppy:
it's deliberately all-or-nothing. The cost (N statements) and the guarantee
(atomic) both live at this seam.

## How it works

### Move 1 — the mental model

You know how `for (const item of items) await db.insert(item)` in an ORM is the
classic "N+1 write" that everyone learns to replace with a bulk insert? This is
that, with one upgrade: it's wrapped in a transaction, so at least it's atomic.
The strategy: **correctness-first — make the whole document's chunks land
atomically — and accept N statements as the cost.** The optimization the code
declines: collapse the N INSERTs into one multi-row INSERT.

```
  Row-at-a-time vs multi-row (the kernel)

  NOW (per-chunk loop):
    begin
      INSERT … values (c0)        ← statement 1
      INSERT … values (c1)        ← statement 2
      INSERT … values (c2)        ← statement 3
    commit                        ← all atomic

  POSSIBLE (multi-row INSERT):
    begin
      INSERT … values (c0),(c1),(c2)   ← ONE statement, same atomicity
    commit
```

### Move 2 — the moving parts

**The transaction.** Bridge: it's `try { begin } … catch { rollback }` — the SQL
version of all-or-nothing. buffr opens `begin`, loops, then `commit`s; on any
error it `rollback`s and rethrows. Boundary condition: without the transaction, a
crash mid-loop leaves a document half-indexed — some chunks present, some missing,
and the `documents` row (written separately in `runtime.ts`) pointing at an
incomplete set. The transaction is what makes the index consistent.

**The per-chunk INSERT.** Bridge: a parameterized `INSERT … on conflict (id) do
update` — an upsert, so re-indexing the same document overwrites rather than
duplicates. One call per chunk. Boundary condition: the `on conflict` key is
`id`, and chunk ids are deterministic (`"<docId>#<index>"`), so re-indexing is
idempotent. That idempotency is *why* the loop can be re-run safely — but it
doesn't reduce the statement count.

**The warm connection.** Bridge: `pool.connect()` checks out one connection and
*all* N INSERTs + the begin/commit run on it, then `release()` returns it.
Boundary condition: this is the one efficiency the loop *does* have — no
reconnect per chunk. (Detailed in `04-connection-pool-reuse.md`.)

```
  What the loop costs — N statements, one connection, one txn

  pool.connect() ──► [conn] ──┐
                              │ begin
                              │ INSERT c0   ┐
                              │ INSERT c1   ├─ N parse+plan+exec round-trips
                              │ INSERT c2   ┘   to the SAME connection
                              │ commit
  release() ◄─────────────────┘
        │
        └─ the win: no per-chunk reconnect
           the cost: N executions where 1 multi-row INSERT would do
```

### Move 2 variant — the load-bearing skeleton

The kernel of "atomic document indexing," and what breaks without each part:

1. **The transaction (`begin`/`commit`/`rollback`)** — without it, a mid-loop
   failure leaves a document partially indexed; the corpus goes inconsistent.
   This is load-bearing for *correctness*.
2. **The `on conflict do update`** — without it, re-indexing a document throws on
   duplicate `id` instead of overwriting; idempotent re-runs break.
3. **The loop itself** — this is the *only* part that's optional-for-performance.
   Replacing it with a single multi-row INSERT (or `COPY`) keeps parts 1 and 2
   intact and cuts N statements to 1.

So the skeleton is "transaction + upsert semantics"; the per-chunk *loop* is an
implementation choice, not a requirement. That's the whole finding: the
load-bearing parts (atomicity, idempotency) are fine; the swappable part (loop vs
multi-row) is left at the slower option.

### Move 2.5 — current state vs future state

```
  Phase A (now)                       Phase B (multi-row)
  ─────────────                       ───────────────────
  for (const c of chunks)             const values = chunks.map(…)
    await client.query(INSERT c)      await client.query(
                                        INSERT … VALUES (…),(…),(…)
                                        ON CONFLICT … , flatParams)

  N statements per document           1 statement per document
  atomic (txn)                        atomic (same txn, or implicit)
```

What doesn't have to change: the transaction, the `on conflict` upsert semantics,
the dimension guard, the warm connection. Only the inner loop becomes a single
parameterized multi-row INSERT (or, for true bulk, a `COPY` into a temp table
then an upsert-from-select). At buffr's chunk-per-document counts this is a
micro-optimization — name it, don't rush it.

### Move 3 — the principle

A method that *receives* a batch should *write* a batch. Row-at-a-time inside a
loop is the default an ORM nudges you toward and the first thing a perf review
flags — but only when the row count is large enough to matter. Wrapping it in a
transaction makes it correct; it doesn't make it a batch. Atomicity and
batch-granularity are independent properties, and buffr got the first without the
second.

## Primary diagram

The full upsert path, transaction and statement granularity labelled.

```
  Upsert path — chunk array to stored rows

  ┌─ Pipeline (aptkit) ──────────────────────────────────────────┐
  │  store.upsert([c0, c1, c2])                                  │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ PgVectorStore.upsert ──▼────────────────────────────────────┐
  │  for (c of chunks) assertDim(c.vector)   ← 768-dim guard all  │
  │  conn = pool.connect()                   ← one warm conn      │
  │  ┌─ transaction ──────────────────────────────────────────┐  │
  │  │  begin                                                  │  │
  │  │  INSERT c0 … on conflict do update   ┐                  │  │
  │  │  INSERT c1 … on conflict do update   ├ N statements     │  │
  │  │  INSERT c2 … on conflict do update   ┘ (the loop)       │  │
  │  │  commit                                                 │  │
  │  └─────────────────────────────────────────────────────────┘  │
  │  conn.release()                                              │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Storage — Postgres ────▼────────────────────────────────────┐
  │  agents.chunks rows, embedding vector(768), idempotent by id │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on every `pipeline.index(...)` call — i.e. once per
document during `npm run index`. It's the only write path into `agents.chunks`.

**The upsert — `src/pg-vector-store.ts:38-65`:**

```
  src/pg-vector-store.ts  (upsert, lines 38-65)

  for (const c of chunks) this.assertDim(c.vector);  ← fail fast on dim mismatch
  const client = await this.pool.connect();          ← one connection for all
  try {
    await client.query('begin');                     ← txn open → atomicity
    for (const c of chunks) {                         ← THE per-chunk loop
      …
      await client.query(
        `insert into agents.chunks (…)
         values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
         on conflict (id) do update set …`,           ← idempotent upsert
        [c.id, docId, this.appId, …]);                ← one round-trip per chunk
    }
    await client.query('commit');                     ← all land together
  } catch (err) {
    await client.query('rollback');                   ← or none do
    throw err;
  } finally {
    client.release();                                 ← return conn to pool
  }
        │
        └─ the begin/commit/rollback is load-bearing (atomic document).
           the inner for-loop is the swappable part: one multi-row INSERT
           would keep the atomicity and cut N statements to 1.
```

The `$6::vector` cast is where `toVectorLiteral` (line 15-17) feeds in — the
768-float `[…]` string Postgres parses into a `vector`. That string-build is the
per-chunk allocation noted in the audit's cpu-memory lens; invisible at this
scale.

## Elaborate

Row-at-a-time-vs-bulk is one of the oldest database-performance levers. Postgres
gives you three rungs: per-row INSERT (this), multi-row `INSERT … VALUES (…),(…)`
(one statement, up to a few thousand rows), and `COPY` (the bulk-load path,
fastest for large volumes). The right rung depends on volume — buffr's
chunks-per-document count sits squarely in "per-row is fine," which is exactly
why this is the lowest-consequence finding in the audit.

The reason it earns a file anyway: it's a textbook-recognizable pattern, and the
*shape* (receives a batch, writes row-at-a-time) is worth recognizing so you know
when to climb the rungs. What to read next: `study-database-systems` for `COPY`
internals and how the executor handles multi-row INSERT; `02-embedding-http-roundtrip.md`
for the embed call that strictly dominates this write.

## Interview defense

**Q: This upsert loops one INSERT per chunk. Is that a problem?**
At buffr's scale, no — a handful of 512-char chunks per document. The statement
count is dwarfed by the embedding HTTP call that precedes it. But the *shape* is
the classic "receives a batch, writes row-at-a-time," and the fix is a one-line
climb to multi-row INSERT if volume ever grows. The transaction wrapping it is the
part I'd keep untouched — that's what makes the document land atomically.

```
  per-row INSERT  → fine at low volume, N statements
  multi-row INSERT → one statement, same atomicity
  COPY            → bulk-load rung, for thousands of rows
  climb only when volume forces it
```

Anchor: `src/pg-vector-store.ts:43-57` is the loop; `begin`/`commit` at 42/58 is
the atomicity I'd preserve.

**Q: The load-bearing part people forget?**
The transaction. Strip the loop down to a multi-row INSERT and people sometimes
drop the `begin`/`commit` too — but the atomicity is the *correctness* guarantee
(no half-indexed documents), independent of the batching. Keep it.

## Validate

1. **Reconstruct:** write the upsert kernel — transaction + per-chunk upsert —
   from memory, naming what each part guarantees.
2. **Explain:** why does the transaction matter even though chunk ids are
   idempotent (`on conflict do update`)?
3. **Apply:** rewrite `src/pg-vector-store.ts:43-57` as a single multi-row INSERT
   preserving the `on conflict` behavior. What's tricky about the parameter list?
4. **Defend:** argue why this is the *lowest*-priority performance finding in the
   audit despite being the most textbook-flaggable.

## See also

- `audit.md` § io-network-and-database-bottlenecks, § performance-red-flags (#4)
- `02-embedding-http-roundtrip.md` — the embed call that dominates this write
- `04-connection-pool-reuse.md` — the warm connection the loop runs on
- `study-database-systems` — multi-row INSERT, `COPY`, transaction mechanics
