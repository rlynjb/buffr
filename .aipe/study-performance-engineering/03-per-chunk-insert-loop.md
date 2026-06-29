# Per-Chunk Insert Loop

**Industry names:** row-at-a-time insert · the N+1 write · single-row vs bulk insert
(the fix is multi-row `VALUES` / `COPY`). **Type:** Industry standard anti-pattern (here,
at a benign scale).

---

## Zoom out, then zoom in

When a document is indexed, its chunks have to land in `agents.chunks`. buffr writes them
one INSERT at a time, in a loop, inside a single transaction. That's one network
round-trip to Postgres per chunk. The transaction is the right call; the row-at-a-time
loop is the part that scales badly — though not at the size buffr runs today.

```
  Zoom out — where the insert loop sits

  ┌─ Pipeline (aptkit) ─────────────────────────────────────────┐
  │  chunk doc → embed all chunks → store.upsert(chunks[])       │
  └──────────────────────────────────┬──────────────────────────┘
                                      │
  ┌─ Storage: PgVectorStore.upsert (pg-vector-store.ts:38-65) ──▼┐
  │  begin                                                       │
  │  for (const c of chunks)  ← ★ one INSERT per chunk ★         │ ← we are here
  │    client.query(insert ... on conflict ...)                  │
  │  commit                                                      │
  └──────────────────────────────────┬──────────────────────────┘
                                      │ pg wire (one round-trip per query)
  ┌─ Postgres ─────────────────────▼─────────────────────────────┐
  │  agents.chunks                                               │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **row-at-a-time insert inside one transaction**. The question this
file answers: what does the loop cost (N round-trips), what does the transaction buy
(atomicity, one fsync), and when does the round-trip count start to hurt.

---

## Structure pass

**Layers.** Two: the transaction envelope (`begin` / `commit` / `rollback` at
`pg-vector-store.ts:42,58,60`) and the per-chunk INSERT inside it (lines 43-57).

**Axis — cost (round-trips per upsert).** Hold "how many times do we cross the wire to
Postgres?" constant:

```
  One question — "how many wire round-trips to upsert N chunks?" —

  ┌─ transaction envelope ──────────────────────────┐
  │  begin (1)  ...  commit (1)         → 2 fixed    │  cheap, amortized over the batch
  └─────────────────────────────────────────────────┘
       ┌─ per-chunk loop ──────────────────────────┐
       │  INSERT × N                  → N round-trips│  ← THIS scales with N
       └────────────────────────────────────────────┘

  total = N + 2 round-trips. the envelope is fixed; the loop is linear in chunks.
```

**Seam — the loop boundary inside the txn.** The seam worth studying is between "one
transaction" (good — atomic, one commit) and "N statements" (the cost — each `client.query`
is a separate request/response on the wire). The transaction makes the *durability* cost
cheap (one fsync at commit), but does nothing about the *round-trip* cost (still N).

---

## How it works

### Move 1 — the mental model

You know the classic N+1 query problem on the read side — a list view that fires one query
per row instead of one query for all rows? This is the *write*-side twin: one INSERT per
chunk instead of one INSERT for all chunks. The strategy buffr uses: **wrap the N writes
in a transaction so they're atomic and commit once — but still pay the wire round-trip N
times.**

```
  Per-chunk loop — the shape

  begin ──┐
          ├─► INSERT chunk[0]   ← round-trip 1
          ├─► INSERT chunk[1]   ← round-trip 2
          ├─► INSERT chunk[2]   ← round-trip 3
          │        ...
          ├─► INSERT chunk[N-1] ← round-trip N
  commit ─┘   ← one fsync for the whole batch

  the commit is batched (good); the INSERTs are not (the cost)
```

### Move 2 — the walkthrough

**The transaction envelope — the part that's right.** `pg-vector-store.ts:38-65`:

```ts
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);   // ← validate all before any write
  const client = await this.pool.connect();           // ← one connection for the whole batch
  try {
    await client.query('begin');                      // ← open txn
    for (const c of chunks) {
      ...
      await client.query(`insert into agents.chunks ... on conflict (id) do update ...`,
        [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), ...]);
    }                                                 // ← ★ one round-trip PER chunk ★
    await client.query('commit');                     // ← one fsync for all of them
  } catch (err) {
    await client.query('rollback');                   // ← all-or-nothing on failure
    throw err;
  } finally {
    client.release();                                 // ← back to the pool, not closed
  }
}
```

Three things this gets right, before the criticism: it grabs *one* connection for the whole
batch (not one per chunk), it validates every dimension *before* writing anything
(line 39 — no half-written batch on a bad vector), and it's atomic — a failure rolls back
the whole document, so you never get a partially-indexed doc. The `on conflict (id) do
update` makes it an idempotent upsert: re-indexing the same file overwrites cleanly.

**The load-bearing skeleton — what breaks if you remove each part:**

```
  upsert kernel — name each part by what breaks without it

  1. one pooled connection      remove → connect per chunk; handshake × N (catastrophic)
  2. begin/commit envelope      remove → N separate txns; N fsyncs; not atomic
  3. assertDim before writes    remove → a bad vector mid-loop leaves a partial batch
  4. on conflict do update      remove → re-indexing a file throws on duplicate id
  5. rollback on error          remove → a mid-batch failure leaves the doc half-written
  ── the cost, not the skeleton ──
  6. the per-chunk loop itself  this is the N round-trips — replaceable by multi-row VALUES
```

Parts 1-5 are the skeleton — pull any and correctness or amortization breaks. Part 6, the
loop, is the *performance* part: it's correct but it's N round-trips where it could be one.

**The fix, and why it's not in yet.** A multi-row insert collapses N round-trips into one:

```
  pseudocode — multi-row VALUES (the throughput fix)

  build one INSERT with N value-tuples:
    insert into agents.chunks (...) values
      ($1,$2,...), ($9,$10,...), ($17,...), ...      // all chunks, one statement
    on conflict (id) do update set ...
  → ONE round-trip, still inside the txn, still atomic

  for very large batches: COPY ... FROM STDIN is faster still
```

**Does it matter at laptop scale? No.** A document chunks into maybe tens of rows. Tens of
round-trips over a warm local pool is a handful of milliseconds — invisible next to the
embed call that produced those vectors, let alone next to gemma2. The per-chunk loop only
becomes a real cost during *bulk* load — importing thousands of chunks at once — where N
round-trips and N `toVectorLiteral` string allocations (line 55) add up. For interactive,
hand-fed indexing, the simple loop is the right call: easy to read, obviously correct, and
fast enough.

### Move 3 — the principle

Separate the two costs a write batch carries: **durability** (fsyncs) and **round-trips**
(wire crossings). A transaction batches the first and leaves the second alone. buffr
correctly batched durability and left round-trips row-at-a-time — fine until N is large,
at which point multi-row `VALUES` or `COPY` batches the second cost too. Knowing *which*
cost a transaction does and doesn't amortize is the lesson.

---

## Primary diagram

```
  Per-chunk insert loop — durability batched, round-trips not

  ┌─ PgVectorStore.upsert(chunks[]) ──────────────────────────────────┐
  │  assertDim × N  (validate first — no partial batch)               │
  │  pool.connect()  ← ONE connection for the batch                   │
  │  ┌──────────────────────────────────────────────────────────┐    │
  │  │ begin                                                     │    │
  │  │   INSERT chunk[0] ─┐                                      │    │
  │  │   INSERT chunk[1]  ├─ N round-trips  ← the cost (linear)  │    │
  │  │   ...              │                                      │    │
  │  │   INSERT chunk[N-1]┘                                      │    │
  │  │ commit            ← ONE fsync  ← durability batched (good)│    │
  │  └──────────────────────────────────────────────────────────┘    │
  │  catch → rollback (atomic)   finally → client.release() (pooled)  │
  └────────────────────────────────────┬──────────────────────────────┘
                                        │ pg wire
  ┌─ Postgres: agents.chunks ─────────▼───────────────────────────────┐
  │  on conflict (id) do update  → idempotent re-index                │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The single-row-in-a-loop insert is one of the most common DB performance footguns because
it's the *natural* way to write the code — you have an array, you loop, you insert. It only
shows up in profiles under volume. The two escalating fixes — multi-row `VALUES`, then
`COPY` — are standard Postgres bulk-load technique. pgvector inserts have an extra wrinkle:
each insert also triggers HNSW index maintenance, so bulk-loading with the index present is
slower than loading then indexing — another reason `COPY`-then-index matters at real volume.

This pairs with `02-embedding-roundtrip`: the per-chunk write *is* the "write" half of that
file's GPU-idle gap. Collapsing N inserts into one shortens the write, which shortens the
idle window the GPU waits through.

---

## Interview defense

**Q: Your upsert loops one INSERT per chunk. Why not bulk-insert?**

Correctness-wise it's solid — one pooled connection, one transaction, atomic rollback,
idempotent via `on conflict`. The transaction batches durability: one fsync at commit, not
N. What it *doesn't* batch is wire round-trips — it's N `client.query` calls, one per chunk.

```
  durability:    begin..commit → 1 fsync          ← batched (good)
  round-trips:   INSERT × N    → N wire crossings ← NOT batched (the cost)
```

The fix is a multi-row `VALUES` to collapse N round-trips into one, or `COPY` for very large
batches. I haven't done it because a document is tens of chunks over a warm local pool —
single-digit milliseconds, dwarfed by the embed call and gemma2. The loop is the right call
for hand-fed indexing; multi-row is what I'd reach for if I bulk-imported a corpus. The part
I'd flag: with pgvector, each insert also does HNSW maintenance, so at real volume you'd
`COPY` first and build the index after.

**Anchor:** `pg-vector-store.ts:38-65`.

---

## See also

- `02-embedding-roundtrip.md` — the write loop is the "write" half of the GPU-idle gap.
- `04-connection-pool-reuse.md` — why grabbing one connection per batch is cheap.
- `audit.md` §4 (the per-vector string allocation), §5, §8 (red flag #5).
- `study-database-systems` — transactions, WAL, fsync, and HNSW index maintenance on insert.
