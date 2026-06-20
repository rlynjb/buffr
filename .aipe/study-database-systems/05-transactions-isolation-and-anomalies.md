# Transactions, Isolation, and Anomalies

**Industry name(s):** ACID transactions / isolation levels / atomicity boundary · **Type:** Industry standard

---

## Zoom out, then zoom in

buffr opens an explicit transaction in exactly two places — the schema migration and the chunk upsert. Everything else is a bare `pool.query()`, which Postgres still runs as a transaction (a single-statement one) but where buffr made no atomicity *decision*. This file is about where the all-or-nothing boundaries are, where they're missing, and the anomalies that gap allows.

```
  Zoom out — where transactions live

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  ★ explicit BEGIN/COMMIT: migrate.ts, pg-vector-store.upsert ★│ ← we are here
  │  implicit single-stmt txn: indexDocumentRow, persistMessage,  │
  │                            startConversation, loadProfile     │
  └──────────────────────────┬──────────────────────────────────┘
                             │  SQL
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  READ COMMITTED (default) · MVCC snapshots · WAL at commit    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a transaction is the unit that's all-or-nothing and isolated-from-others. The verdict up front: **buffr's atomicity is correct *within* a chunk batch and *within* the migration, but a document and its chunks are written in two separate transactions — so a crash between them leaves the source row without its index, or the reverse.** That's a real anomaly the design accepts.

---

## The structure pass

Two layers: the explicit-transaction writes and the implicit-transaction writes. One axis: *what's the atomic unit — and what spans more than one unit?*

```
  Axis = "what is guaranteed all-or-nothing together?"

  ┌─ migrate.ts ─────────────────┐  BEGIN…COMMIT  → whole schema = 1 unit  ✓
  ├─ upsert(chunks[]) ───────────┤  BEGIN…COMMIT  → all chunks = 1 unit    ✓
  ├─ indexDocumentRow ───────────┤  2 separate units:
  │   1. INSERT documents (impl) │    documents row ─┐  ◄── NOT atomic
  │   2. pipeline.index→upsert    │    chunks batch  ─┘      together
  ├─ persistMessage ─────────────┤  1 statement = 1 unit
  └─ startConversation ──────────┘  1 statement = 1 unit
```

The seam is *inside* `indexDocumentRow`: it does two transactions that should arguably be one. Across that seam the atomicity guarantee flips from "together" to "separate." **That flip is the most important anomaly in the repo** — a partial-index state is reachable.

---

## How it works

### Move 1 — the mental model

You know how `Promise.all([a, b, c])` either you treat as "all done" or you handle partial failure yourself? A transaction is the opposite default: `BEGIN; a; b; c; COMMIT;` is *one* outcome — all of a,b,c or none. The `ROLLBACK` on error is the "none."

```
  The pattern — the transaction envelope

      BEGIN                ← open the unit
        write 1            ┐
        write 2            ├─ all visible to others only AFTER commit
        write 3            ┘
      COMMIT               ← the unit lands atomically + durably
        ── or ──
      ROLLBACK (on error)  ← the unit vanishes, as if it never ran
```

One sentence: **wrap related writes in BEGIN…COMMIT and they're one atomic, durable unit; on error, ROLLBACK makes them disappear.**

### Move 2 — the load-bearing skeleton

The transaction kernel in buffr is four moves, and dropping any one breaks atomicity:

```
  upsert()'s transaction kernel (pg-vector-store.ts:40-64)

  client = pool.connect()        // ① pin ONE connection — txn is per-connection
  BEGIN                          // ② open the unit
    for each chunk: INSERT…       // ③ the work, all on this connection
  COMMIT                         // ④ land atomically
   on error: ROLLBACK           //   undo the whole unit
   finally: client.release()    //   return the connection to the pool
```

**① Pin one connection — without it, no transaction at all.** A transaction is bound to a *connection*, not the pool. If you ran the loop on `pool.query()` (which checks out a *random* connection per call), each INSERT could land on a different connection — `BEGIN` on one, `INSERT` on another. The `client = await pool.connect()` is what makes the transaction real. This is the part people forget.

**② BEGIN — without it, each statement auto-commits.** Postgres runs every bare statement in its own implicit transaction. `BEGIN` is what *groups* them.

**③ The work on the pinned client — must use `client.query`, not `pool.query`.** Every statement inside must go through the same `client`, or it escapes the transaction.

**④ COMMIT / ROLLBACK — the atomic landing or the clean undo.** `COMMIT` makes all chunks visible and durable at once. `ROLLBACK` (in the `catch`) discards the whole batch on any chunk's failure.

```
  The two explicit-transaction sites — identical skeleton

  migrate.ts:8-20            pg-vector-store.ts:40-64
  ───────────────            ────────────────────────
  pool.connect()             pool.connect()
  BEGIN                      BEGIN
   run whole .sql file        loop: INSERT chunk
  COMMIT                     COMMIT
   catch→ROLLBACK             catch→ROLLBACK
   finally→release            finally→release
```

**The implicit-transaction writes.** `persistMessage`, `startConversation`, `loadProfile`, and `indexDocumentRow`'s `INSERT documents` all use `pool.query()` — each is one statement, so each is its own implicit transaction. That's atomic *per statement*, which is all a single INSERT needs.

**The cross-transaction gap — the real anomaly.** `indexDocumentRow` (`src/runtime.ts:11-17`) does this:

```
  indexDocumentRow — two transactions, one logical operation

  txn A:  INSERT into documents …            ← implicit, commits immediately
  ─── crash window ───                       ← if the process dies HERE…
  txn B:  pipeline.index → upsert(chunks)    ← BEGIN…COMMIT, separate unit
       │
       └─ …you have a documents row with NO chunks (un-retrievable source),
          or — if reindexing — old chunks pointing at updated content.
          The two are NOT atomic together.
```

Bridge: it's the same hazard as updating a record in one API call and its search-index entry in a second — a crash between them desyncs the two. buffr accepts it because (a) it's single-device with one writer, so the window is tiny and there's no concurrent reader to observe the inconsistency, and (b) re-running `index` is idempotent (stable ids, `ON CONFLICT`), so the fix is "just re-index." Honest verdict: **acceptable for a laptop agent, would need a wrapping transaction the moment correctness under crash matters.**

### Move 2.5 — current vs future isolation

buffr runs the **READ COMMITTED** default and never changes it. What that buys and what it doesn't:

```
  Isolation — current (default) vs what's not exercised

  CURRENT: READ COMMITTED (Postgres default, never set in code)
   ├─ each statement sees rows committed before IT began
   ├─ no dirty reads (never sees uncommitted data)
   └─ ALLOWS: non-repeatable reads, phantoms within a txn

  NOT YET EXERCISED:
   ├─ REPEATABLE READ  — snapshot fixed at txn start (no set in code)
   ├─ SERIALIZABLE     — as-if-serial, retry on conflict (no set in code)
   └─ SELECT … FOR UPDATE — row locks (never used)
```

Why the default is fine *here*: buffr has one writer (the CLI), so the anomalies READ COMMITTED permits — non-repeatable reads, phantoms — require concurrent transactions that buffr never runs. The isolation level is untouched because the concurrency that would expose its limits doesn't exist yet. The moment a second writer appears, `06` becomes load-bearing.

### Move 3 — the principle

A transaction is the boundary of "all-or-nothing, isolated." The skill isn't writing `BEGIN` — it's drawing the boundary around the writes that must succeed or fail *together*. buffr draws it correctly around a chunk batch and the migration, and *omits* it around document+chunks — a deliberate, documented tradeoff that's safe under single-writer/idempotent-reindex and unsafe the day either assumption breaks.

---

## Primary diagram

Every write path and its atomic unit.

```
  buffr write paths — atomic units mapped

  ┌─ migrate.ts ──────────────────┐
  │ BEGIN [whole schema] COMMIT   │  1 unit ✓  (rollback on any DDL error)
  └────────────────────────────────┘
  ┌─ pg-vector-store.upsert ──────┐
  │ BEGIN [chunk0…chunkN] COMMIT  │  1 unit ✓  (all chunks or none)
  └────────────────────────────────┘
  ┌─ runtime.indexDocumentRow ────┐
  │ ① INSERT documents  (txn A)   │  ┐
  │ ─── crash window ───          │  ├─ 2 units ✗  NOT atomic together
  │ ② upsert chunks     (txn B)   │  ┘  (the repo's one real anomaly)
  └────────────────────────────────┘
  ┌─ trace-sink / profile reads ──┐
  │ single statement = 1 txn each │  per-statement atomic
  └────────────────────────────────┘

  Isolation: READ COMMITTED (default) everywhere · no FOR UPDATE · no SERIALIZABLE
```

---

## Implementation in codebase

**Use cases.** Explicit transactions guard the two batch writes (schema, chunks). The cross-transaction gap is reached on every `index` run — `indexDocumentRow` is how the CLI loads a markdown doc.

```
  src/pg-vector-store.ts  (lines 40–64)  — the chunk batch transaction

  const client = await this.pool.connect();   ← pin ONE connection
  try {
    await client.query('begin');              ← open the unit
    for (const c of chunks) {
      …
      await client.query(`insert … on conflict (id) do update …`, [...]);
    }
    await client.query('commit');             ← all chunks land atomically
  } catch (err) {
    await client.query('rollback');           ← any failure undoes ALL chunks
    throw err;
  } finally {
    client.release();                         ← return conn to pool
  }
       │
       └─ the `pool.connect()` (not pool.query) is what makes this a real
          transaction. Swap to pool.query in the loop and BEGIN/COMMIT would
          land on different connections — silently no transaction.
```

```
  src/migrate.ts  (lines 8–20)  — the schema in one transaction

  await client.query('begin');
  await client.query(sql);          ← the ENTIRE 001_agents_schema.sql
  await client.query('commit');
   catch → rollback                 ← a failed CREATE rolls back the whole schema
       │
       └─ DDL in Postgres is transactional, so a half-applied schema is
          impossible — you get the full schema or none of it.
```

```
  src/runtime.ts  (lines 11–17)  — the cross-transaction gap

  await pool.query(`insert into agents.documents … on conflict (id) …`, [...]);
                                    ← txn A: commits NOW (implicit)
  await pipeline.index({ id: doc.id, text: doc.text });
                                    ← txn B: separate BEGIN…COMMIT inside upsert
       │
       └─ no surrounding transaction. A crash between these leaves the
          documents row without chunks. Tolerated: single writer + idempotent
          re-index (stable ids, ON CONFLICT). A wrapping transaction here
          is the fix if crash-consistency ever matters.
```

---

## Elaborate

ACID's "A" (atomicity) is the transaction's whole reason to exist: group writes so partial failure is impossible. Postgres gives you transactional DDL too (not every database does — MySQL historically didn't), which is why `migrate.ts` can wrap a whole schema file and trust it's all-or-nothing.

The cross-transaction gap in `indexDocumentRow` is the classic "dual write" problem in miniature — two stores (here, two tables) that must agree, updated in two steps. At scale the answer is the outbox pattern or a saga; at buffr's scale the answer is "wrap both in one transaction" (one-line fix: pass the `client` from a single `BEGIN` into both the documents insert and the chunk upsert). It's left un-wrapped because the soft `document_id` link (see below) and idempotent re-index make the inconsistency self-healing.

**The dropped foreign key.** `chunks.document_id` is a *soft* link — `sql/001_agents_schema.sql:16-17` explains why, and line 27 actively drops any prior FK. A hard FK (`references documents(id)`) would reject a chunk whose document row doesn't exist yet — which would *break* the VectorStore contract, since `upsert(chunks)` is called with no guarantee a documents row exists (the pipeline indexes chunks directly). So the FK was removed to preserve drop-in parity with an in-memory store that has no documents table at all. The cost: no referential integrity — orphan chunks and dangling `document_id`s are possible and never rejected by the engine. Cross-link `study-data-modeling` for whether that link *should* be hard.

---

## Interview defense

**Q: What's guaranteed atomic in this codebase, and what isn't?**

Atomic: the schema migration and a chunk batch — both wrapped in BEGIN…COMMIT with ROLLBACK on error. Not atomic: a document row and its chunks. `indexDocumentRow` inserts the document in one implicit transaction and upserts chunks in a separate one — a crash between them leaves a source row with no index.

```
  documents row (txn A) ─── crash window ─── chunks (txn B)
       │                                          │
       └─────── NOT one unit; partial state reachable ──────┘
```

Anchor: *"Chunk batches are atomic; document-plus-chunks isn't — a deliberate gap, safe under single-writer + idempotent re-index."*

**Q: What makes `upsert` an actual transaction and not just a loop of inserts?**

The `pool.connect()` pinning one connection. A transaction lives on a connection; if I looped on `pool.query()` each insert could land on a different pooled connection and BEGIN/COMMIT wouldn't group them. The pinned client is the load-bearing part.

Anchor: *"A transaction is per-connection — `pool.connect()`, not `pool.query()`, is what makes BEGIN…COMMIT real."*

---

## Validate

1. **Reconstruct:** Write the five-move transaction skeleton (connect → BEGIN → work → COMMIT → release) from memory. Which move makes it a *real* transaction?
2. **Explain:** Why is the cross-transaction gap in `indexDocumentRow` (`src/runtime.ts:11-17`) tolerable for buffr but not for a multi-writer service?
3. **Apply:** Close the gap. Which one parameter must `indexDocumentRow` thread through both writes to make them atomic? (Hint: a pinned `client`.)
4. **Defend:** Explain why the FK on `chunks.document_id` was dropped (`sql/001_agents_schema.sql:16-17,27`) and what integrity that costs.

---

## See also

- `06-locks-mvcc-and-concurrency-control.md` — why READ COMMITTED's anomalies never surface here
- `07-wal-durability-and-recovery.md` — what COMMIT actually guarantees
- `04-query-planning-and-execution.md` — the N+1 loop inside the upsert transaction
- `study-data-modeling` — whether the soft `document_id` link should be a hard FK
