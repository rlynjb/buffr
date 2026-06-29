# 07 · Non-atomic document+chunk write

**Subtitle:** a single logical write split across two independent transactions on
two pooled connections — the capstone red flag — *Project-specific*.

---

## Zoom out, then zoom in

Indexing a document is *one* logical operation: write the `documents` row, then
write its `chunks`. But those two writes happen in two separate transactions on
two different pooled connections, with no shared atomicity. Crash in the gap and
the database is left in a state neither write intended.

```
  Zoom out — where the write splits

  ┌─ App layer ─────────────────────────────────────────────┐
  │  indexDocumentRow(pool, ..., doc)                        │
  │    1. pool.query(insert documents)   ── txn A ──         │
  │    2. pipeline.index(doc) → PgVectorStore.upsert ── txn B│
  └───────────────────────────┬─────────────────────────────┘
                              │  two connections, two commits
  ┌─ Storage: agents ─────────▼─────────────────────────────┐
  │  documents  (committed by A)   ★ THE GAP between A & B ★  │ ← here
  │  chunks     (committed by B)                             │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question is "if the process dies between writing the document and
writing its chunks, what's left in the database?" The answer is a half-write: a
`documents` row with zero chunks, or — if `upsert` partially fails — chunks
referencing a document that committed but then the *next* document's write threw.
Nothing rolls the pair back as a unit, because there's no unit.

## The structure pass

One axis: **failure** — where does it originate, propagate, and get contained?
Trace it across the two writes.

```
  axis = "if this step fails, what's rolled back?"

  ┌─ write 1: documents (runtime.ts:11) ──┐  fails → nothing written
  │  pool.query → implicit txn → commit    │  (clean — document not there)
  └────────────────────┬───────────────────┘
                       │ seam: COMMIT of A. After this point,
                       │       the document is durable and ALONE.
  ┌─ write 2: chunks (pg-vector-store:42) ─┐  fails → chunks rolled back,
  │  client.begin → inserts → commit       │  but the DOCUMENT STAYS.
  └─────────────────────────────────────────┘

  failure containment is per-write, not per-operation → the gap is uncontained
```

The seam is the commit of transaction A. Before it, a failure leaves nothing.
After it, the document is durable and any failure in B leaves it orphaned. Each
write contains its *own* failure correctly — `upsert` even rolls back on error
(`pg-vector-store.ts:59-62`). What's uncontained is failure *between* them.

## How it works

### Move 1 — the mental model

The shape is a **two-phase write with no coordinator** — the same bug as
incrementing two `useState` values in two separate effects and assuming they
update together. They don't; there's a moment where one is new and the other is
old. Here that moment is durable, on disk, after a commit.

```
  two transactions, one logical write (pattern)

  ┌─ txn A ─┐   commit A   ┌─ GAP ─┐   ┌─ txn B ─┐   commit B
  │ docs +  │ ──────────►  │ crash │   │ chunks +│ ──────────►
  └─────────┘   durable    │ here? │   └─────────┘   durable
                           └───────┘
                  document committed, chunks never written
                  → orphaned document, DB can't detect it (no FK, → 03)
```

### Move 2 — the walkthrough

**Write 1: the document, on the pool, in its own implicit transaction.**

```
  File: src/runtime.ts
  Function: indexDocumentRow
  Lines: 11-17

    await pool.query(                            ← pool.query = its OWN
      `insert into agents.documents (...)            connection + implicit
       values ($1, $2, 'markdown', $3, $4)           txn, auto-committed
       on conflict (id) do update set ...`,
      [doc.id, appId, doc.sourcePath ?? null, doc.text]);
    // ── transaction A has now COMMITTED ──
    await pipeline.index({ id: doc.id, text: doc.text });   ← write 2
```

`pool.query(...)` checks out a connection, runs the insert in an implicit
single-statement transaction, commits, and returns the connection. By line 17 the
document is *durable*. Then `pipeline.index` runs — a completely separate write.

**Write 2: the chunks, on a different connection, in their own transaction.**

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.upsert
  Lines: 40-65

    const client = await this.pool.connect();    ← a DIFFERENT connection
    try {
      await client.query('begin');               ← transaction B starts
      for (const c of chunks) { await client.query('insert ... chunks ...'); }
      await client.query('commit');              ← B commits
    } catch (err) {
      await client.query('rollback');            ← B rolls back ITSELF only
      throw err;
    } finally { client.release(); }
```

`upsert` is internally atomic — all chunks for the document commit together or
none do, and a failure rolls *its own* inserts back. That's correct. But it
opened a brand-new connection (`this.pool.connect()`) and a brand-new transaction.
Transaction A is already committed and out of reach. B can roll itself back; it
cannot un-commit A.

```
  Layers-and-hops — one logical write, two physical transactions

  ┌─ indexDocumentRow ──────────────────────────────────────┐
  │                                                          │
  │  hop1: pool.query(insert docs)                           │
  │   ┌─ connection X ──────────┐                            │
  │   │ implicit txn A → COMMIT  │ ── document durable ──┐    │
  │   └──────────────────────────┘                       │    │
  │                          ✗ crash window ✗            │    │
  │  hop2: pipeline.index → upsert                        │    │
  │   ┌─ connection Y ──────────┐                        │    │
  │   │ begin → inserts → COMMIT │ ── chunks durable ─────┘   │
  │   └──────────────────────────┘                            │
  └──────────────────────────────────────────────────────────┘
   X ≠ Y, txn A ≠ txn B → no shared rollback boundary
```

**The boundary condition — the two ways it leaves bad state.**

```
  failure point              resulting DB state
  ─────────────────────────  ─────────────────────────────────────
  crash after commit A,      document row exists, ZERO chunks
  before upsert runs         → a doc that returns nothing on search
  upsert throws mid-way      document committed (A), chunks rolled
                             back (B) → same orphaned-document state
  re-run later (idempotent)  on conflict do update fixes it — IF the
                             re-run happens; nothing guarantees it
```

The redeeming feature: both writes are idempotent (`on conflict do update` in
both — `runtime.ts:14`, `pg-vector-store.ts:50`). So *re-running* `indexDocumentRow`
for the same doc heals the state. But nothing triggers the re-run automatically,
and — per `04-deterministic-chunk-ids.md` — a re-run that produces fewer chunks
orphans the high-index ones anyway. Idempotency makes the bug *recoverable*, not
*absent*.

### Move 2 variant — the load-bearing skeleton

```
  the kernel of the bug
    1. one logical operation = two writes that must both land
    2. the two writes run on DIFFERENT connections
    3. each write commits independently (no shared txn)
    4. no FK to catch the resulting orphan (→ 03)
```

- Fix **(2)+(3)**: thread one `client` (one connection, one `begin/commit`)
  through both the document insert and the chunk upsert. Then a crash anywhere
  rolls the whole operation back — the half-write becomes impossible.
- Fix **(4)** alone doesn't help: a FK would reject *chunks without a document*,
  but the actual failure is a *document without chunks*, which no FK prevents.
- Hardening, not the fix: the idempotent upserts make a manual re-run heal the
  state. Good to have; not a substitute for atomicity.

The honest call: the cleanest fix is to give `PgVectorStore.upsert` an optional
"use this client" path, or to have `indexDocumentRow` own one transaction and
pass the client down. That's an interface change to a method built for `VectorStore`
parity (`03`), which is *why* it opens its own connection — so the fix trades a
little parity for atomicity. Name the tradeoff; don't pretend it's free.

### Move 3 — the principle

Atomicity is about *operations*, not *statements*. A transaction makes a set of
writes all-or-nothing — but only the writes inside *that* transaction. The instant
a logical operation spans two transactions (or two connections), the
all-or-nothing guarantee stops at the boundary between them, and the gap becomes a
durable failure state. The discipline is: find the *logical* unit of work, then
make sure exactly one transaction wraps all of it. When an interface boundary
(here, `VectorStore`) makes that hard, you either pass the transaction across the
boundary or you accept the gap and make the writes idempotent so re-running
heals — and you say which one you chose.

## Primary diagram

The whole hazard and the fix, side by side.

```
  Non-atomic write — the gap, and how to close it

  NOW (two transactions)            FIX (one transaction)
  ──────────────────────            ──────────────────────
  pool.query(docs)  ─ txn A ─►      client.begin
       commit A  ──┐                  insert docs
                   │ ✗ GAP ✗          upsert chunks (same client)
  upsert chunks ─ txn B ─►          client.commit ── txn ──►
       commit B                       (or rollback ALL on any error)

  crash in GAP → doc, no chunks      crash anywhere → nothing committed
  recoverable only via re-run        atomic: no half-write possible
```

## Elaborate

This is the canonical "dual write" hazard, the same shape that bites anyone
writing to two systems (DB + cache, DB + search index) and assuming both land.
The textbook cures are: one transaction spanning both writes (possible here
because both writes are in the same Postgres database — the cheap fix), or, when
the writes truly span systems, the outbox/saga patterns that make the second
write recoverable. This repo's writes are *both* in Postgres, so the expensive
machinery is unnecessary — a single shared connection closes it. The reason it's
split at all is the `VectorStore` interface boundary (`03-soft-link-no-fk.md`):
`upsert` was built to own its own connection so it could be a drop-in store. The
atomicity cost is the bill for that parity, and it's payable.

## Interview defense

**Q: Walk me through the worst failure in your indexing path.**

Indexing a document is two writes — the `documents` row, then its `chunks` — and
they run in two separate transactions on two pooled connections. If the process
dies after the document commits but before the chunks are written, I'm left with
a document that has zero chunks and returns nothing on search. There's no FK to
catch it (dropped for `VectorStore` parity), so the DB can't even detect the
orphan.

```
  pool.query(docs) → commit ──┐
                              ✗ crash ✗  → doc durable, chunks never written
  upsert(chunks)  → commit  ──┘
```

Anchor: "two transactions for one logical write — the gap between the commits is
a durable half-write."

**Q: How do you fix it, and what does the fix cost?**

Thread one connection through both writes: `begin`, insert the document, upsert
the chunks on the *same* client, `commit` — so a crash anywhere rolls the whole
operation back and the half-write is impossible. The cost is that
`PgVectorStore.upsert` currently opens its own connection on purpose — that's
what makes it a drop-in `VectorStore`. Closing the gap means passing a transaction
across that interface boundary, trading a little parity for atomicity. Both writes
are already idempotent, so today re-running heals the state — but that's recovery,
not prevention.

```
  fix: one client → one begin/commit around BOTH writes
  cost: upsert must accept an external client (parity trade)
  stopgap already present: idempotent upserts → re-run heals
```

Anchor: "the fix is one transaction; the cost is one interface seam — and I'd pay
it, because a half-written corpus is silent and the DB can't find it."

## See also

- `03-soft-link-no-fk.md` — why there's no FK to catch the orphaned document, and
  why `upsert` owns its own connection.
- `04-deterministic-chunk-ids.md` — the idempotent upserts that make re-run heal,
  and the separate shrink-orphan gap.
- `audit.md` Lens 4 and Lens 7 — transactions/integrity and the red-flags
  scorecard.
- `study-database-systems` — how Postgres MVCC commits these transactions
  underneath.
