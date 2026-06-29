# Database systems — red-flags audit

**Subtitle:** ranked storage-engine and consistency risks, grounded in the repo — *Project-specific*

---

## Zoom out, then zoom in

This is the verdict file. Every other concept file teaches a mechanism; this one
ranks the *risks* those mechanisms create in `buffr-laptop`, by consequence,
each with `file:line` evidence and a move. Read this first if you want the
"what's actually dangerous here" answer before the teaching.

```
  Zoom out — where each risk lives

  ┌─ Service / app ─────────────────────────────────────────┐
  │  R2: two-txn write (runtime.ts:11+17)                    │
  │  R4: unsized pool (db.ts:4)                              │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Query / planner ────────▼───────────────────────────────┐
  │  R1: <=>/opclass alignment (pg-vector-store.ts:75 ↔      │
  │      001_agents_schema.sql:29)   R6: no EXPLAIN           │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / durability ───▼───────────────────────────────┐
  │  R3: dropped FK soft link (schema:16-27)                 │
  │  R5: no backups/PITR (memory not re-derivable)           │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the risks split into two kinds — *latent correctness* (something can
silently produce a wrong or incomplete result: R1, R2, R3) and *operational
ceiling* (something works now but caps growth: R4, R5, R6). The ranking weights
silent-correctness over operational, because a silent wrong answer costs more
than a known limit.

---

## The ranked risks

### R1 — The `<=>` operator must stay aligned with `vector_cosine_ops`, or the index silently drops out
**Severity: high (latent, catastrophic-on-drift) · likelihood: low (held by convention)**

**Evidence:** query orders by `embedding <=> $1::vector` (`pg-vector-store.ts:75`);
index built `using hnsw (embedding vector_cosine_ops)`
(`001_agents_schema.sql:29`). They align — cosine operator, cosine opclass.

**The risk:** nothing *enforces* the alignment; it's a convention held across two
files. Change the query operator to `<->` (L2) or `<#>` (inner product) without
rebuilding the index, and Postgres picks a sequential scan with **no error and no
log** — same answer, O(n) latency that grows with the corpus. → `03`, `04`.

**The move:** add an `EXPLAIN`-based test asserting the plan contains
`Index Scan using chunks_embedding_hnsw`. One test pins the convention so a
future edit can't break it silently. (See EX-QРY-1 in `04`.)

---

### R2 — Documents and chunks are written in two separate transactions
**Severity: medium (recoverable inconsistency) · likelihood: low (crash window only)**

**Evidence:** `indexDocumentRow` writes `documents` via autocommit `pool.query`
(`runtime.ts:11`), then calls `pipeline.index()` → `PgVectorStore.upsert()`,
which opens its own `begin`/`commit` (`pg-vector-store.ts:42-58`). Two
transactions, no shared boundary.

**The risk:** a crash/error/kill in the gap commits the documents row with zero
chunks — a document in the corpus that contributes nothing to retrieval, with
nothing flagging it. WAL recovery *preserves* the gap rather than healing it. →
`05`, `07`.

**The move:** none required — this is a deliberate, owned tradeoff. Wrapping both
in one transaction would force aptkit's `VectorStore` contract to know about a
`documents` row and break drop-in parity. The mitigation is already in place:
both writes are `on conflict do update` (`runtime.ts:14`, `pg-vector-store.ts:50`),
so re-indexing heals the gap idempotently. **Keep it. Name it.** If you ever want
the gap closed, the cost is threading an outer transaction through
`pipeline.index()` — pay it only when the inconsistency stops being recoverable.

---

### R3 — The chunks→documents foreign key is deliberately dropped
**Severity: low (by design) · likelihood: n/a**

**Evidence:** `document_id` declared with no FK and an idempotent
`alter table agents.chunks drop constraint if exists chunks_document_id_fkey`
(`001_agents_schema.sql:16-27`).

**The risk (mechanism lens):** without the FK, Postgres does no referential
integrity check on chunk writes — a chunk can reference a non-existent
`document_id`, and nothing stops it. That's not a bug here; it's *required*. Memory
chunks (`meta.kind='memory'`, written by `memory.remember()` in `session.ts`) ride
the same `chunks` table with **no `documents` row at all** — the dropped FK is
what makes that legal. → `05`, `08`.

**The move:** none. The integrity *shape* of this choice belongs to
`study-data-modeling`; from the engine's side it's a correct, intentional removal
of a constraint that would break the `VectorStore` abstraction. Documented in the
schema with a comment explaining exactly why — which is the right way to ship a
dropped constraint.

---

### R4 — One bare `pg.Pool` with no sizing or timeouts
**Severity: medium (operational ceiling) · likelihood: low at current scale**

**Evidence:** `new pg.Pool({ connectionString: databaseUrl })` — no `max`, no
`idleTimeoutMillis`, no `connectionTimeoutMillis` (`db.ts:4`). node-postgres
defaults `max` to 10.

**The risk:** `upsert()` checks out a dedicated client for a whole multi-chunk
transaction (`pg-vector-store.ts:40`); a corpus index run pins a connection. With
no `connectionTimeoutMillis`, an exhausted pool makes the next `connect()` wait
**indefinitely** instead of failing fast. Harmless for one in-process
conversation; the first thing to break when a second concurrent caller or a
background indexer appears. → `06`.

**The move:** set `max` to the workload and add `connectionTimeoutMillis` so
exhaustion fails fast rather than hangs. Cheap, and it converts a silent hang
into a visible error. Not urgent at single-device scale.

---

### R5 — No backups, no PITR; conversation memory has no second copy
**Severity: medium (data-loss exposure) · likelihood: low (single device)**

**Evidence:** no `archive_mode`, no base backup, no `pg_dump` in scripts, no
restore path anywhere in the repo. Durability stops at default `fsync=on` crash
recovery. → `07`.

**The risk:** crash recovery survives a *process* crash, not a *disk* failure.
The implicit backup plan is "rebuild from the markdown corpus" — which works for
indexed *documents* but **not for memory chunks**: `memory.remember()`
(`session.ts`) generates them from conversations, and they're not in the source
corpus. A disk loss takes the memory with it.

**The move:** the day memory matters, add a periodic `pg_dump` (or WAL archiving
for PITR). Until then, name the boundary explicitly: documents are re-derivable,
memory is not.

---

### R6 — No EXPLAIN discipline; the index claim is reasoned, not measured
**Severity: low (verification gap) · likelihood: n/a**

**Evidence:** no `EXPLAIN` / `EXPLAIN ANALYZE` anywhere in `src/` or `test/`. The
"HNSW is used" claim throughout this guide is inferred from the opclass
alignment, never observed. → `04`.

**The move:** add an `EXPLAIN (ANALYZE, BUFFERS)` harness (EX-IDX-1 / EX-QРY-1)
to *prove* the plan. This is also the test that catches R1, so it pays for two
risks at once. Highest-leverage cheap fix in this list.

---

## Risk map

```
  buffr-laptop — risks ranked by consequence

  ┌────┬──────────────────────────────────┬──────────┬──────────────┐
  │ #  │ risk                             │ severity │ evidence     │
  ├────┼──────────────────────────────────┼──────────┼──────────────┤
  │ R1 │ <=>/opclass alignment (silent)   │ HIGH     │ pgvs:75 ↔    │
  │    │                                  │          │ schema:29    │
  │ R2 │ two-transaction doc+chunk write  │ MEDIUM   │ runtime:11+17│
  │ R4 │ unsized pool, no timeouts        │ MEDIUM   │ db.ts:4      │
  │ R5 │ no backups; memory not re-derive │ MEDIUM   │ (absent)     │
  │ R3 │ dropped FK soft link (by design) │ LOW      │ schema:16-27 │
  │ R6 │ no EXPLAIN discipline            │ LOW      │ (absent)     │
  └────┴──────────────────────────────────┴──────────┴──────────────┘

  highest-leverage fix: R6's EXPLAIN harness — it also pins R1.
  deliberate & correct as-is: R2 (idempotent heal), R3 (abstraction parity)
```

---

## Elaborate

Two of the top three "risks" (R2, R3) are deliberate engineering tradeoffs, not
defects — and that's the most important thing this audit says. A red-flags audit
isn't a list of mistakes; it's a list of *places where the engine's default
guarantee was traded away on purpose*, plus the few where it was traded away by
omission (R4, R5, R6). The discipline is naming which is which: R2 and R3 buy a
clean `VectorStore` abstraction and self-heal via idempotency; R1, R4, R5, R6 are
real gaps with cheap closes. The single highest-leverage move is the EXPLAIN
harness, because it converts the guide's central reasoned claim (the index is
used) into a measured, regression-pinned fact — and catches the one silent
catastrophe (R1) in the same test.

---

## Interview defense

**Q: What's the most dangerous thing about this database setup, and why isn't it
on fire?**

> The `<=>` operator and the HNSW index's `vector_cosine_ops` opclass have to
> name the same distance metric, and nothing enforces it — it's a convention
> across `pg-vector-store.ts:75` and `001_agents_schema.sql:29`. If they ever
> drift, Postgres silently falls back to a sequential scan: same answer, O(n)
> latency that worsens as the corpus grows, no error. It's not on fire because
> they were chosen together and haven't changed. The fix that makes it *stay*
> safe is one `EXPLAIN` test asserting the plan uses the HNSW index — which also
> gives me the EXPLAIN discipline the repo otherwise lacks.

```
  pgvs:75  <=>  ══ must match ══  schema:29  vector_cosine_ops
  drift → silent seq scan → latency cliff → caught only by EXPLAIN
```

> Anchor: the highest risk is a silent index drop the planner never warns about;
> one EXPLAIN test pins it.

**Q: You said the two-transaction write is a "risk" but also "correct." Which is
it?**

> Both — it's an owned tradeoff. `indexDocumentRow` commits documents and chunks
> in separate transactions (`runtime.ts:11`, then `upsert()`'s own
> `begin`/`commit`), so a crash in the gap leaves an orphaned document. That's a
> real anomaly. But closing it means forcing aptkit's `VectorStore` to know about
> a documents row, which breaks the drop-in parity that's the whole point of the
> abstraction. So the call is: accept a recoverable inconsistency, make both
> writes idempotent with `on conflict` so re-indexing heals it, keep the clean
> abstraction. Naming exactly which inconsistency you accepted, and why, is the
> point.

```
  txn A docs ──► ⚠gap⚠ ──► txn B chunks   → orphan on crash
  heal: idempotent re-index   ·   cost of closing: break VectorStore parity
```

> Anchor: it's a deliberate atomicity tradeoff bought for abstraction cleanliness
> and paid back by idempotency.

---

## See also

- `00-overview.md` — the same findings as the top-level ranking with reading
  order.
- `03` / `04` — R1, R6: the opclass alignment and EXPLAIN.
- `05` / `07` — R2, R5: the two-transaction write and durability boundary.
- `06` — R4: pool sizing.
- `study-data-modeling` — R3's integrity shape (the soft-link normalization
  call).
- `study-performance-engineering` — R1/R4's latency and throughput consequences.
