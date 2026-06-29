# Database systems — red flags audit

**Industry name:** the storage-engine and consistency risk audit — *Project-specific*

---

## Zoom out — where this concept lives

This file is the verdict layer. Every other file taught a mechanism; this one ranks the
*risks* those mechanisms carry in buffr specifically, by consequence, with the evidence
cited. It spans the whole map — the risks live at different bands.

```
  where the red flags live on the map

  ┌─ Application ──────────────────────────────────────────────────────┐
  │  ★ cross-transaction write (R2)  ★ unstated isolation (R3)          │
  │  ★ no EXPLAIN discipline (R5)    ★ unbatched row-at-a-time inserts  │
  └───────────────────────────┬────────────────────────────────────────┘
  ┌─ Access methods ──────────▼────────────────────────────────────────┐
  │  ★ operator/opclass alignment — the silent-scan trap (R1)           │
  └───────────────────────────┬────────────────────────────────────────┘
  ┌─ Storage / durability ────▼────────────────────────────────────────┐
  │  ★ upsert bloat / HNSW churn (R4)   ★ no PITR/backup (R6)           │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Zoom in — narrow to the concept

The question: *ranked by consequence, where is buffr's storage layer most likely to
bite, and what's the evidence?* The ranking rule: a risk's score is *likelihood of
firing × cost when it fires × silence* (a silent failure outranks a loud one at equal
cost, because nothing tells you it happened). buffr's top risks are all *silent* — they
don't throw, they don't log, they just quietly do the wrong (or slow) thing. Walk them
in order, each with its file cross-link and the move that fixes it.

---

## The structure pass

### Layers + axis: trace *"how would you find out it's wrong?"* across the risks

```
  "how does this failure announce itself?"  — the silence axis

  R1 misaligned opclass    →  SILENT. correct but slow. only EXPLAIN reveals it.
  R2 cross-txn write       →  SILENT. orphaned doc, FK dropped, no error.
  R3 unstated isolation    →  SILENT. fine until a 2nd writer; no signal then either.
  R4 upsert bloat          →  SLOW-CREEPING. degrades over re-indexes; visible in size.
  R5 no EXPLAIN            →  META: this is the absence of the tool that reveals R1.
  R6 no PITR/backup        →  SILENT until disaster. no restore path when you need one.

  the through-line: buffr's storage risks don't error — they require a DELIBERATE
  probe (EXPLAIN, size check, a recovery drill) to surface. that's the audit's job.
```

### Seams

The risks cluster at the seams the earlier files named: the operator/opclass seam (R1),
the transaction-intent seam (R2), the durability seam (R6). Hand off: a ranked walk,
silence-weighted, each anchored to a file and a fix.

---

## How it works — the ranked audit

### Move 1 — the shape of the ranking

```
  buffr's storage risks — ranked by consequence × silence

  ┌─ R1 ─ operator/opclass alignment ── HIGH ── the silent seq scan ──┐
  │  ─ R2 ─ cross-transaction write ──── HIGH ── orphaned documents ──│
  │  ─ R3 ─ unstated isolation level ─── MED  ── safe-by-luck ─────────│
  │  ─ R4 ─ upsert bloat / HNSW churn ── MED  ── degrades over time ───│
  │  ─ R5 ─ no EXPLAIN discipline ────── MED  ── can't verify R1 ──────│
  │  ─ R6 ─ no PITR / backup ─────────── LOW* ── *LOW only because     │
  └──────────────────────────────────────────  corpus is reproducible ┘
```

### Move 2 — each risk, evidence, fix

---

#### R1 — the operator/opclass alignment is correct, but unverified and silent if broken · HIGH

**Evidence:**
- Query orders by the cosine-distance operator (`<=>`): `src/pg-vector-store.ts:75`.
- Index built with the matching opclass (`vector_cosine_ops`):
  `sql/001_agents_schema.sql:28-29`.

**Verdict:** they align today, so the ANN index (HNSW) is used and search is fast. The
risk is the *failure mode's silence*: build the index with `vector_l2_ops` or `<#>`
mismatched against `<=>`, and nothing errors — the planner silently falls to a sequential
scan, computing cosine distance per row. Results stay correct, latency goes O(n) and
grows with the corpus. No exception, no log.

```
  the trap
  query <=>  ⟷  index vector_cosine_ops   → Index Scan HNSW   ✓ (buffr today)
  query <=>  ⟷  index vector_l2_ops        → Seq Scan + Sort   ✗ silent, slow
```

**Fix:** run `EXPLAIN ANALYZE` on the search query against a populated table; confirm
`Index Scan using chunks_embedding_hnsw` (see R5). → full walk in `03`, `04`.

---

#### R2 — the document+chunk write is non-atomic across two transactions · HIGH

**Evidence:**
- `indexDocumentRow` writes the documents row on the pool (autocommit, txn #1):
  `src/runtime.ts:11-16`.
- Then `pipeline.index(...)` runs `PgVectorStore.upsert`'s own `begin`/`commit`
  (txn #2): `src/runtime.ts:17` → `src/pg-vector-store.ts:40-58`.
- The chunks→documents FK is **deliberately dropped**: `sql/001_agents_schema.sql:27`.

**Verdict:** a crash or an embedding-model error between the two commits leaves an
orphaned document — a `documents` row with zero `chunks`, indexed on paper, invisible to
retrieval. Because the FK is dropped (a modeling choice → `study-data-modeling`), the
engine raises nothing. Durability faithfully preserves the inconsistency (file `07`).

```
  insert documents ─commit─► ░crash░ ─► insert chunks (never)
  → durable orphaned document, no constraint to catch it
```

**Fix:** thread one transaction through both writes — open `begin` in `indexDocumentRow`,
write the documents row on that connection, pass it into the chunk upsert. That requires
aptkit's `RetrievalPipeline` to accept an injected connection (an aptkit seam change,
hence not done — aptkit is consumed, never edited here). Interim mitigations: order the
writes so the documents row commits *last*, or add a reconciliation sweep that deletes
documents with no chunks. → full walk in `05`.

---

#### R3 — isolation level is READ COMMITTED by default and never stated · MEDIUM

**Evidence:**
- Every `begin` takes the default — no `SET TRANSACTION ISOLATION LEVEL` anywhere:
  `src/pg-vector-store.ts:42`, `src/migrate.ts:11`.

**Verdict:** correct today *only* because there's exactly one writer (file `06`). READ
COMMITTED permits non-repeatable reads and lost updates; buffr never hits them because
no two transactions touch the same row. The risk is that this safety is a property of
the deployment, not a decision in the code — and it's invisible. A second writer (a sync
daemon, a second device) makes the anomalies reachable with zero warning.

**Fix:** when a second writer arrives, decide the level explicitly — for buffr's
mostly-disjoint writes, an optimistic `version int` column beats raising the global
isolation level. Until then, the move is a one-line comment naming the assumption.
→ `05`, `06`.

---

#### R4 — upsert-heavy workload bloats the heap and churns the HNSW index · MEDIUM

**Evidence:**
- `on conflict (id) do update` rewrites the chunk tuple on every re-index:
  `src/pg-vector-store.ts:50-54`.

**Verdict:** each update writes a new tuple and a new HNSW graph entry, leaving the old
ones dead (MVCC, file `06`). Re-running the indexer on the same corpus — easy in dev —
inflates live+dead tuples and the proximity graph until autovacuum reclaims. The HNSW
re-insertion is the expensive part (file `03`'s write cost). It degrades gradually, not
catastrophically, and it's visible in table/index size.

**Fix:** let autovacuum run (defaults are fine for a small corpus), or `VACUUM
agents.chunks` after bulk re-indexes; skip re-indexing unchanged documents (content
hash). → `02`, `03`, `06`; tuning owned by `study-performance-engineering`.

---

#### R5 — no EXPLAIN discipline anywhere in the repo · MEDIUM

**Evidence:**
- No `EXPLAIN` / `EXPLAIN ANALYZE` in `src/` or `sql/` (grep-clean).

**Verdict:** this is the *meta-risk* — it's the absence of the tool that would catch R1.
The index alignment is correct by inspection, but "correct by reading code" is weaker
than "proven by planner output." Without EXPLAIN, a future opclass mismatch, stale
statistics, or a table-too-small-to-index situation all pass silently.

**Fix:** add one `EXPLAIN ANALYZE` check (a test or a script) that asserts the search
query produces `Index Scan using chunks_embedding_hnsw` on a populated table. → `04`;
discipline owned by `study-performance-engineering`.

---

#### R6 — no PITR, no WAL archiving, no scheduled backup · LOW (conditionally)

**Evidence:**
- Single instance, default `fsync` durability only; no archiving/backup config in repo.

**Verdict:** WAL gives local crash recovery for free (file `07`), but a disk failure or
an accidental `delete from chunks` has no restore path. Scored **LOW only because** the
corpus is reproducible from source markdown (`documents.source_path`,
`sql/001_agents_schema.sql:7`) — re-index and it's back. The score jumps the moment the
database holds non-reproducible state: the conversation trajectories in `messages` and
the episodic-memory chunks (`meta.kind='memory'`) *cannot* be regenerated from source.

**Fix:** a `pg_dump` on a schedule covers the non-reproducible tables cheaply; PITR
(base backup + archived WAL) is the full answer when the data justifies it. → `07`;
decision owned by `study-system-design`.

---

### The N+1 note (not a top risk, but real)

`upsert` inserts one chunk per round trip (`src/pg-vector-store.ts:43`) and the trace
sink fires one insert per event (`src/supabase-trace-sink.ts`, the `push` calls). These
are row-at-a-time round trips, not a planner problem (there are no SQL joins anywhere).
A batching opportunity, owned by `study-performance-engineering`, listed here so the
audit is complete.

### Move 3 — the principle

Every top risk in this repo is *silent* — it doesn't throw, it doesn't log, it just does
the slow or inconsistent thing. That's the signature of storage-engine risk in
particular: the engine is doing exactly what you told it, and what you told it drifted
from what you meant. The audit's job is to make the silence loud — name the gap between
the assumption and the mechanism, and attach the deliberate probe (EXPLAIN, a vacuum, a
recovery drill) that would have caught it.

---

## Primary diagram — the audit at a glance

```
  buffr database-systems risk audit — full recap

  ┌─ HIGH ─────────────────────────────────────────────────────────────┐
  │ R1 opclass alignment  pg-vector-store.ts:75 ⟷ schema:28-29  silent  │
  │ R2 cross-txn write    runtime.ts:11-17 + FK dropped schema:27       │
  ├─ MEDIUM ───────────────────────────────────────────────────────────┤
  │ R3 unstated isolation pg-vector-store.ts:42, migrate.ts:11          │
  │ R4 upsert bloat/churn pg-vector-store.ts:50-54                      │
  │ R5 no EXPLAIN         (absent across src/ + sql/)                   │
  ├─ LOW* ─────────────────────────────────────────────────────────────┤
  │ R6 no PITR/backup    *LOW only b/c corpus reproducible from source  │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Not yet exercised — honest gaps (the audit's other half)

Per the spec, the lenses that find nothing get named plainly, not padded into findings.

```
  lens                          status        becomes relevant when…
  ────────────────────────────  ────────────  ──────────────────────────────────
  replication / read replicas   ABSENT        a 2nd device reads the corpus (file 08)
  WAL archiving / PITR          ABSENT        non-reproducible data must survive (R6)
  isolation > READ COMMITTED    DEFAULT       a 2nd writer contends (R3)
  EXPLAIN / ANALYZE             ABSENT        you must prove the index path (R5)
  HNSW param tuning (m/ef_*)    DEFAULTS      recall or build time disappoints
  pool sizing (max/timeouts)    DEFAULTS      a 2nd writer shares the pool (db.ts:5)
  failover / stale-read routing N/A           reads move off the primary (file 08)
  SQL joins / N+1 in planner    NONE          (single-table by design — not a gap)
```

---

## Interview defense

**Q: "What's the single most dangerous thing about this database setup?"**

```
  the silent seq scan
  index opclass ≠ query operator → no error → O(n) forever, undetected
```

Answer: "The operator/opclass alignment on the vector index — and not because it's wrong
today, it's right. Because the failure mode is *silent*. If the HNSW index is ever built
with a distance opclass that doesn't match the `<=>` in the query, the planner drops to a
sequential scan with no error and no log — results stay correct, latency goes linear and
gets worse as the corpus grows. The repo runs no EXPLAIN, so nothing would catch it. The
fix is one `EXPLAIN ANALYZE` assertion that the plan is `Index Scan using
chunks_embedding_hnsw`." Anchor: *the worst storage risks don't throw — they require a
deliberate probe to surface.*

**Q: "If you had one PR to harden this, what's in it?"**

Answer: "Two things. One: thread a single transaction through `indexDocumentRow` so the
document and its chunks are one atom — that closes the orphaned-document anomaly, though
it needs aptkit's pipeline to accept an injected connection. Two: an `EXPLAIN ANALYZE`
check on the search query so the index path is *proven*, not assumed. Those are the two
HIGH risks, and both are silent today." Anchor: *fix the silent ones first — atomicity
(R2) and verifiability (R1/R5).*

---

## See also

- `00-overview.md` — the same ranking in the overview, with the reading order.
- `03` / `04` — R1 and R5 (the alignment and EXPLAIN).
- `05` — R2 and R3 (the cross-transaction write and isolation).
- `06` — R4 (upsert bloat / HNSW churn).
- `07` — R6 (durability / PITR gap).
- `08` — replication (not yet exercised).
- `study-data-modeling` — the dropped FK as a modeling choice (the missing constraint
  behind R2).
- `study-performance-engineering` — pool sizing, HNSW tuning, batching, EXPLAIN
  discipline.
