# The datastore map

**Subtitle:** datastore topology / engine choice / query-path inventory — *Project-specific*

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole storage system on one screen.
`buffr-laptop` has exactly one datastore: a Postgres instance named `reindb`,
with the `vector` extension loaded, reached over a single connection pool. No
cache layer, no second database, no queue. Every read and write in the repo
lands here.

```
  Zoom out — where the database sits in buffr-laptop

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  Ink chat TUI (src/cli/chat.tsx)                         │
  └───────────────────────────────┬──────────────────────────┘
                                  │  in-process call
  ┌─ Service layer ───────────────▼──────────────────────────┐
  │  session.ts (ask loop) · runtime.ts (index) ·            │
  │  pg-vector-store.ts · supabase-trace-sink.ts             │
  └───────────────────────────────┬──────────────────────────┘
                                  │  pg.Pool (node-postgres)
  ┌─ Storage layer ───────────────▼──────────────────────────┐
  │  ★ Postgres reindb · schema agents · pgvector ★          │ ← THIS GUIDE
  │  documents · chunks · conversations · messages · profiles│
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the "database system" is the bottom band — the engine that takes a
SQL string plus parameters and turns it into pages read off disk, an index
walked, a transaction committed to the WAL. The question this whole guide
answers: **how does that band execute and preserve what the Service layer asks
of it, and what does the Service layer assume it gets back?**

---

## The structure pass

**Layers.** Three nested levels inside the storage band:

```
  ┌─ SQL / planner ────────────────────────┐  what to compute
  │   parse → plan → choose index or scan   │
  └─────────────────┬───────────────────────┘
  ┌─ Access methods ▼───────────────────────┐  how to find rows
  │   heap scan · btree · HNSW (pgvector)    │
  └─────────────────┬───────────────────────┘
  ┌─ Storage / WAL ─▼───────────────────────┐  how to persist
  │   8KB pages · buffer cache · WAL · MVCC  │
  └──────────────────────────────────────────┘
```

**Axis — trace `guarantees` (sync vs best-effort, atomic vs not) down the
stack.** Hold one question: *what does each layer promise the one above it?*

- SQL/planner promises **a correct result for the query as written** — but
  *not* that it used the index. Wrong opclass → silent seq scan, same answer,
  cliff-edge latency.
- Access methods promise **the rows that match** — HNSW promises only
  *approximately* the nearest neighbors (it's ANN, not exact).
- Storage/WAL promises **durability of a committed transaction** — but only
  *per transaction*. Two transactions get two independent promises.

**Seams — where the guarantee flips:**

1. **Service ↔ Pool.** Above it: application objects, JS numbers. Below it: a
   wire protocol, a finite set of connections (`db.ts:4`). The guarantee that
   flips is *availability* — above the seam you call freely; below it you're
   one of at most `max` clients.
2. **Query ↔ access method.** Above it: declarative SQL. Below it: the planner
   *chooses* exact-or-approximate, index-or-scan. The guarantee that flips is
   *exactness* — and the choice is invisible unless you run `EXPLAIN`.
3. **Transaction boundary.** Above it: a sequence of statements. Below it: all
   or nothing — but only within one `begin`/`commit`. The guarantee that flips
   is *atomicity*, and `runtime.ts` straddles two of these boundaries (the
   anomaly in `05`).

---

## How it works

### Move 1 — the mental model

A database engine is a translator with a memory. You hand it a declarative
sentence ("give me the 4 nearest chunks to this vector, for app `laptop`") and
it decides *how* to get them — which index, which scan, in which order — then
runs that plan against pages it keeps partly in RAM and fully on disk, logging
every change so a crash can't lose a committed write.

```
  The engine's job — one query, four stages

  SQL string ─► PARSE ─► PLAN ─► EXECUTE ─► result rows
                          │         │
                   "use HNSW or    "walk index,
                    seq scan?"      read pages,
                    cost-based      apply filter"
                    decision
                          │
                   ┌──────▼──────┐
                   │  every write │  WAL append (durability)
                   │  also logs   │  MVCC version (isolation)
                   └─────────────┘
```

The repo touches all four stages but configures none of them. That's the
through-line of this guide: the mechanisms are all *present* (they're Postgres
defaults), and the interesting questions are about the few places the
application code reaches in and makes a choice — the opclass, the transaction
boundaries, the pool.

### Move 2 — the query-path inventory

Every database operation in this repo is one of four paths. Walk them one at a
time; each one is a different demand on the engine.

**Path 1 — the similarity read (the hot path).** Every chat turn runs one of
these. `PgVectorStore.search()` issues a nearest-neighbor query that the planner
*should* answer with the HNSW index.

```
  Path 1 — similarity read (per turn)

  ┌─ Service ──────┐  k=4, query vector   ┌─ Storage ──────────┐
  │ search()       │ ───────────────────► │ ORDER BY <=> LIMIT │
  │ pg-vector-     │                       │ → HNSW index walk  │
  │ store.ts:67    │ ◄─────────────────── │ → top-4 by cosine  │
  └────────────────┘   id, score, meta     └────────────────────┘
```

```ts
// pg-vector-store.ts:70-78 — the read path, annotated
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score   // distance → similarity
   from agents.chunks
   where app_id = $2                                // btree-eligible filter
   order by embedding <=> $1::vector                // HNSW-eligible ordering
   limit $3`,                                       // top-k cutoff
  [toVectorLiteral(vector), this.appId, k],
);
```

The `order by ... <=> ... limit k` is the exact shape pgvector's HNSW index is
built to accelerate. Lose that shape (add a `having`, wrap the distance in a
function, change the operator) and the index drops out. → `04`.

**Path 2 — the transactional upsert (indexing + memory).** `upsert()` writes
chunks inside an explicit transaction.

```
  Path 2 — transactional upsert

  begin ─► insert ... on conflict do update (per chunk) ─► commit
    │                                                        │
    └──────────────── rollback on any error ────────────────┘
                      (pg-vector-store.ts:40-65)
```

This path runs from two callers: `pipeline.index()` during corpus indexing, and
`memory.remember()` after every turn (`session.ts`). Both land in the same
`upsert()`, the same transaction shape.

**Path 3 — the autocommit single write (documents, messages, conversations).**
No explicit transaction — a bare `pool.query` is its own implicit transaction.

```ts
// runtime.ts:11-16 — autocommit documents write (txn A)
await pool.query(
  `insert into agents.documents (...) values (...)
   on conflict (id) do update set ...`,        // one implicit txn, commits alone
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
await pipeline.index({ id: doc.id, text: doc.text });  // → Path 2 (txn B, separate)
```

The `messages` writes in `supabase-trace-sink.ts:27` and the `conversations`
insert in `startConversation` are the same shape: single `pool.query`,
autocommit, no batching.

**Path 4 — the DDL migration.** `runMigration()` runs the whole schema file in
one transaction (`migrate.ts:8-20`). Postgres supports transactional DDL, so a
failed migration rolls back cleanly — a real strength worth naming.

### Move 3 — the principle

A database system gives you a stack of guarantees, but **only the ones you ask
for the way it expects**. The engine is the same Postgres whether you use the
index or not, commit one statement or fifty; what changes is the contract you
hand it. This guide is mostly about the three places `buffr-laptop` reaches
across a seam and makes a choice the engine can't second-guess: the opclass it
must match, the transaction boundaries it draws, and the pool it sizes (or
doesn't).

---

## Primary diagram

The complete map: four query paths, three seams, one engine.

```
  buffr-laptop — datastore map, all paths

  ┌─ Service layer ─────────────────────────────────────────────┐
  │  search()  upsert()  pool.query()  runMigration()           │
  └────┬─────────┬──────────┬──────────────┬─────────────────────┘
       │ Path 1  │ Path 2   │ Path 3       │ Path 4
       │ read    │ txn      │ autocommit   │ DDL txn
  ─────┼─────────┼──────────┼──────────────┼──── seam: pg.Pool (max 10, db.ts:4)
       ▼         ▼          ▼              ▼
  ┌─ Planner ───────────────────────────────────────────────────┐
  │  index-or-scan choice  ◄── seam: exactness flips here        │
  └────┬──────────────────────────────────────┬──────────────────┘
       ▼ HNSW (vector_cosine_ops)              ▼ btree (app_id) / heap
  ┌─ Storage / WAL / MVCC ──────────────────────────────────────┐
  │  8KB pages · buffer cache · WAL append · READ COMMITTED      │
  │  ◄── seam: atomicity flips per begin/commit                  │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Postgres is a process-per-connection, MVCC, WAL-logged relational engine — the
same architecture whether it's storing a `text` column or a 768-dim vector.
pgvector (the `vector` extension, loaded at `001_agents_schema.sql:1`) is an
*extension*: it adds a new column type (`vector`), new operators (`<=>`, `<->`,
`<#>`), and new index access methods (`hnsw`, `ivfflat`) on top of the same
engine. That's why everything else in this guide — transactions, MVCC, WAL,
pooling — applies unchanged: the vector data rides the same machinery as the
relational data. This colocation (vector + relational in one instance) is the
system-design call; see `study-system-design`.

---

## Interview defense

**Q: Walk me through what happens when buffr answers a chat turn — at the
database level.**

> One read and (after the answer) one transactional write. The read is
> `search()` at `pg-vector-store.ts:67`: an `order by embedding <=> $1 limit k`
> that the planner answers with the HNSW index, returning the top-4 chunks by
> cosine similarity for `app_id='laptop'`. After the agent produces an answer,
> `memory.remember()` embeds the exchange and lands in `upsert()` — an explicit
> `begin`/`commit` transaction. So: one ANN read, one durable write, one bare
> pool between them.

```
  turn:  search() ──read──► HNSW ──top4──► agent ──► remember() ──txn──► commit
```

> Anchor: every turn is exactly one similarity read plus one best-effort
> transactional memory write.

**Q: Where could the same query return a different answer than you expect?**

> Two places. One — the opclass: if the query operator stopped matching the
> index opclass, you'd silently get a seq scan, same answer but a latency cliff.
> Two — HNSW is *approximate*: `<=>` over an HNSW index can miss a true nearest
> neighbor that an exact scan would find. The answer is "the 4 *approximately*
> nearest," and that's the right tradeoff for sub-second retrieval.

```
  exact scan:  every row compared   → always the true top-k, O(n)
  HNSW (ANN):  graph walk           → usually the top-k, sub-linear
```

> Anchor: the engine guarantees a result, not that it's the index path or the
> exact answer — `EXPLAIN` is how you check the first, recall@k the second.

---

## See also

- `02-records-pages-and-storage-layout.md` — how these rows sit on disk.
- `04-query-planning-and-execution.md` — the index-or-scan decision in depth.
- `05-transactions-isolation-and-anomalies.md` — the four paths' transaction
  boundaries, including the two-transaction write.
- `study-system-design` — why one Postgres instance holds both vector and
  relational data.
