# Database Systems — Red Flags Audit

**Industry name(s):** storage-engine risk audit / consistency review · **Type:** Project-specific

---

## Zoom out, then zoom in

This is the verdict file: storage-engine and consistency risks in buffr, ranked by consequence, each with `file:line` evidence and the move that closes it. Not every item is a bug — several are deliberate, documented tradeoffs that are *correct for a single-device laptop agent* and would become real risks at a different scale. The ranking says which to watch.

```
  Zoom out — where each risk lives

  ┌─ Persistence ───────────────────────────────────────────────┐
  │  cross-txn gap (R1) · N+1 indexing (R5) · pool sizing (R6)   │
  └──────────────────────────┬──────────────────────────────────┘
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  operator/opclass slip (R2) · untuned HNSW (R4)              │
  │  no backup of trace tables (R3) · no EXPLAIN discipline (R7) │
  └─────────────────────────────────────────────────────────────┘
                             │
  ┌─ Integrity / durability boundary ───────────────────────────┐
  │  dropped FK / soft link (R8) · no PITR (R9)                  │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: ranked by *consequence if it fires*, not by likelihood. R1–R3 can lose or corrupt data; R4–R7 cost performance or hide problems; R8–R9 are accepted-integrity tradeoffs to revisit when the scale assumptions break.

---

## The ranking

```
  buffr DB risks — by consequence

  ┌─────┬──────────────────────────────────────┬───────────┬──────────┐
  │  #  │ risk                                 │ if it fires│ severity │
  ├─────┼──────────────────────────────────────┼───────────┼──────────┤
  │ R1  │ document+chunks not atomic           │ partial    │ HIGH     │
  │     │ (cross-transaction gap)              │ index state│          │
  │ R2  │ operator/opclass slip → silent       │ 100×       │ HIGH     │
  │     │ seq scan                             │ slowdown   │          │
  │ R3  │ trace tables have no backup          │ permanent  │ HIGH     │
  │     │ (not re-derivable)                   │ data loss  │          │
  │ R4  │ untuned HNSW ef_search / m           │ low recall │ MEDIUM   │
  │ R5  │ N+1 indexing loop                    │ slow index │ MEDIUM   │
  │ R6  │ unbounded/default pool sizing        │ conn       │ MEDIUM   │
  │     │                                      │ exhaustion │          │
  │ R7  │ no EXPLAIN/measurement discipline    │ blind      │ MEDIUM   │
  │ R8  │ dropped FK → orphan chunks possible  │ integrity  │ LOW*     │
  │ R9  │ no PITR / DROP protection            │ disaster   │ LOW*     │
  └─────┴──────────────────────────────────────┴───────────┴──────────┘
   *LOW = deliberate tradeoff, correct at current scale
```

---

## R1 — Document and chunks aren't written atomically · HIGH

**Evidence:** `src/runtime.ts:11-17` — `indexDocumentRow` inserts the `documents` row (implicit transaction, commits immediately) then calls `pipeline.index` → `upsert` (a *separate* `BEGIN…COMMIT`, `src/pg-vector-store.ts:42-58`). Two transactions for one logical operation.

**Consequence if it fires:** A crash between the two commits leaves a `documents` row with no chunks (un-retrievable source) or, on re-index, stale chunks against updated content. The retrieval index and the source corpus disagree.

**Why it's tolerated:** Single-writer CLI (tiny window, no concurrent reader to observe it) plus idempotent re-index (stable ids + `ON CONFLICT`) — re-running `index` self-heals. Documented reasoning is sound for a laptop agent.

**The move:** Thread one pinned `client` through both writes so they share a single `BEGIN…COMMIT`. One-parameter change. Do it the moment crash-consistency matters or a second writer appears. → `05`

---

## R2 — Operator/opclass slip silently disables the vector index · HIGH

**Evidence:** index built `using hnsw (embedding vector_cosine_ops)` (`sql/001_agents_schema.sql:28-29`); query orders by `embedding <=> $1` (`src/pg-vector-store.ts:74`). The `<=>` cosine operator and `vector_cosine_ops` opclass are a matched pair.

**Consequence if it fires:** Change the query operator to `<->` (L2) or `<#>` (inner product) — an easy edit during a refactor — and the planner can't use the HNSW index. It falls back to a full sequential scan over every vector. No error, no warning: just a query that's correct but orders of magnitude slower as the corpus grows.

**The move:** Lock the operator↔opclass pairing with a comment (already present at `src/pg-vector-store.ts:69`) *and* an `EXPLAIN`-based assertion in a test that fails if the plan shows a Seq Scan on `chunks`. → `03`, `04`

---

## R3 — Trace tables have no backup and aren't re-derivable · HIGH

**Evidence:** `conversations`/`messages` written by `src/supabase-trace-sink.ts:4-19`; no `pg_dump`, `archive_command`, or backup script anywhere in the repo. WAL (`07`) protects against crash, not disk loss.

**Consequence if it fires:** Documents/chunks are re-derivable from the markdown corpus (re-run `index`), so a wiped `reindb` loses nothing permanent *there*. But the trajectory history — conversations and messages — is reconstructible from *nothing*. A disk failure destroys it permanently. This is the one slice of buffr data that genuinely needs a backup and has none.

**The move:** A `pg_dump --table=agents.conversations --table=agents.messages` on a cron, even daily, even local. Cheap insurance on the only non-re-derivable data. → `07`

---

## R4 — HNSW index runs entirely on default parameters · MEDIUM

**Evidence:** `sql/001_agents_schema.sql:28-29` sets no `(m=…, ef_construction=…)`; no `SET hnsw.ef_search` anywhere. pgvector defaults (`m=16`, `ef_construction=64`, `ef_search=40`).

**Consequence if it fires:** Retrieval recall is whatever the defaults give and is never measured against an exact baseline. `eval-cmd.ts` scores P@1/R@3 on the *approximate* results (`src/cli/eval-cmd.ts:24-32`) without knowing what exact NN would return — so a recall regression from too-low `ef_search` is invisible.

**The move:** Add an exact-scan baseline to the eval (`ORDER BY` without the index, or `SET enable_indexscan=off`), compare to the HNSW result, and tune `ef_search` until recall is acceptable. → `03`

---

## R5 — Indexing is an N+1 loop of round trips · MEDIUM

**Evidence:** `src/pg-vector-store.ts:43-57` — `for (const c of chunks) await client.query(insert…)`. One round trip per chunk inside the transaction.

**Consequence if it fires:** A 40-chunk document is 40 serial round trips. Negligible on localhost; a real cost the moment Postgres is across a network. Atomic (inside the transaction) but serial.

**The move:** Collapse to one multi-row `INSERT … VALUES (…),(…),…` or `UNNEST`-based insert — N round trips become 1, still inside the same transaction. Defer until latency to Postgres stops being ~0. → `04`

---

## R6 — Connection pool is unbounded by config and untuned · MEDIUM

**Evidence:** `src/db.ts:4-6` — `new pg.Pool({ connectionString })`. No `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, or `statement_timeout`.

**Consequence if it fires:** Runs on the node-postgres default `max: 10`. Fine for a single-CLI workload. But there's no `statement_timeout`, so a pathological query (e.g. a vector search that fell back to seq scan per R2 on a huge corpus) can hang a connection indefinitely with no server-side cutoff.

**The move:** Set an explicit `max` and a `statement_timeout` on the pool. The timeout is the higher-value one — it bounds the blast radius of R2. → `01`, `04`

---

## R7 — No EXPLAIN or measurement discipline · MEDIUM

**Evidence:** No `EXPLAIN`/`EXPLAIN ANALYZE` anywhere; no `ANALYZE` cron; eval measures retrieval quality but never query plans or latency.

**Consequence if it fires:** The repo trusts the planner blind. R2 (silent seq scan) and R4 (recall regression) are both invisible without a plan/latency check. You'd find out from a slow `chat` turn, not from a metric.

**The move:** One `EXPLAIN ANALYZE` on `search()` against a realistic corpus, captured as a test assertion. Confirms the Index Scan is chosen and pins the latency. → `04`

---

## R8 — Dropped FK allows orphan chunks · LOW (deliberate)

**Evidence:** `sql/001_agents_schema.sql:16-17` documents the soft-link choice; line 27 drops any prior FK (`alter table … drop constraint if exists chunks_document_id_fkey`). `document_id` is a plain `text` column with no referential integrity.

**Consequence if it fires:** A chunk can carry a `document_id` pointing at a non-existent `documents` row, and the engine never rejects it. Orphans and dangling links are possible.

**Why it's a deliberate tradeoff:** A hard FK would reject chunks upserted before their document row exists, breaking the `VectorStore` drop-in contract (the pipeline upserts chunks with no notion of a documents row). The FK was removed *on purpose* to preserve parity with an in-memory store that has no documents table. The dropped FK now does double duty: episodic **memory chunks** written via `createConversationMemory` (`src/session.ts:53,67`) land in the same `chunks` table with *no* documents row at all (ids namespaced `memory:<conv>:<n>`, `meta.kind='memory'` — set inside aptkit's memory engine, not buffr) — a hard FK would reject every one. Correct call. → `05`, cross-link `study-data-modeling`

**The move (only if integrity becomes a requirement):** Either re-add the FK and change the indexing order to insert the document first within one transaction (also fixes R1), or add a periodic orphan-check query. Not needed at current scale.

---

## R9 — No point-in-time recovery / DROP protection · LOW (deliberate)

**Evidence:** No WAL archiving, no base backup, no PITR config (`07`, `not yet exercised`).

**Consequence if it fires:** An accidental `DROP TABLE` or bad migration can't be rewound to a point in time. WAL only protects against crash, not human error.

**Why it's a deliberate tradeoff:** Documents/chunks are re-indexable; PITR for them buys little. (The trace-table exposure is R3, ranked higher because it's *not* re-derivable.)

**The move:** Covered by R3's `pg_dump` for the tables that matter; full PITR is overkill for a laptop agent. → `07`

---

## Primary diagram

The audit as a single map — risk, location, the close.

```
  buffr DB red flags — ranked, located, closable

  HIGH ─────────────────────────────────────────────────────────────
   R1 cross-txn gap        runtime.ts:11-17      → share one client/txn
   R2 operator/opclass     pg-vector-store.ts:74 → EXPLAIN-assert no seqscan
   R3 trace tables backup  supabase-trace-sink.ts→ pg_dump conv/messages
  MEDIUM ───────────────────────────────────────────────────────────
   R4 untuned HNSW         schema.sql:28-29      → baseline + tune ef_search
   R5 N+1 indexing         pg-vector-store.ts:43 → batch multi-row INSERT
   R6 pool sizing          db.ts:4-6             → set max + statement_timeout
   R7 no EXPLAIN           (absent)              → EXPLAIN ANALYZE in a test
  LOW (deliberate) ─────────────────────────────────────────────────
   R8 dropped FK           schema.sql:16-17,27   → revisit if integrity needed
   R9 no PITR              (absent)              → R3's pg_dump suffices
```

---

## Implementation in codebase

**The two highest-value, lowest-effort fixes, side by side.**

```
  R1 fix — one transaction around indexDocumentRow (src/runtime.ts:11-17)

  // before: two transactions
  await pool.query(`insert into agents.documents …`);   ← commits alone
  await pipeline.index(…);                               ← separate txn

  // after: one transaction (sketch)
  const client = await pool.connect();
  await client.query('begin');
  await client.query(`insert into agents.documents …`); ← same unit
  // …chunk upsert reuses `client` instead of pool…
  await client.query('commit');                         ← atomic together
       │
       └─ closes R1 AND R8's worst case (doc always exists before its chunks)
```

```
  R3 fix — back up the only non-derivable data (package.json script)

  "backup:trace": "pg_dump \"$DATABASE_URL\" \
     --table=agents.conversations --table=agents.messages \
     -f backups/trace-$(date +%F).sql"
       │
       └─ documents/chunks are re-indexable from markdown; conversations/
          messages are not. This one script covers the real loss surface.
```

---

## Elaborate

The pattern across this audit: buffr's *deliberate* tradeoffs (R8 dropped FK, R9 no PITR) are correctly scoped to a single-device laptop agent and well-documented in the schema. The *latent* risks (R1 cross-txn gap, R2 operator slip, R3 trace backup) are the ones that bite without warning — R1 and R2 silently, R3 catastrophically-but-rarely. A good review separates "chose this cost on purpose" from "didn't notice this exposure," and buffr is mostly the former with three of the latter worth closing.

The single highest-leverage move is R1's one-transaction fix, because it also resolves R8's worst case (a document always exists before its chunks) — two findings, one change. After that, R3's `pg_dump` script is the cheapest insurance against the only permanent-loss surface. Everything else is performance hygiene that localhost latency is currently hiding. Cross-link `study-data-modeling` for the integrity findings (R8) and `study-performance-engineering` for R4–R7.

---

## Interview defense

**Q: What's the single most dangerous storage assumption in this codebase?**

That a document and its chunks are written together — they're not (R1). `indexDocumentRow` uses two transactions, so a crash between them leaves a source row with no index. It's tolerated under single-writer + idempotent re-index, but it's the one place a crash produces a visibly inconsistent state. The fix is one shared transaction, which also guarantees the document exists before its chunks.

```
  documents (txn A) ─crash─ chunks (txn B)  → fix: one client, one BEGIN…COMMIT
```

Anchor: *"Two transactions for one logical write — collapse them into one and you close the atomicity gap and the orphan-chunk case together."*

**Q: What would silently slow this down with no error?**

Changing the vector distance operator without rebuilding the index (R2). The HNSW index is `vector_cosine_ops`; the query uses `<=>`. Swap to `<->` and the planner full-scans every vector — correct results, no error, growing-ly slow. I'd guard it with an `EXPLAIN`-based test that fails on a Seq Scan over `chunks`.

Anchor: *"Operator/opclass mismatch is the silent killer — assert the plan, don't trust it."*

---

## Validate

1. **Reconstruct:** From memory, list the three HIGH risks and the one-line fix for each.
2. **Explain:** Why is R3 (trace-table backup) ranked above R9 (no PITR) when both are "no backup"?
3. **Apply:** You have time for exactly one fix. Which gives the most coverage, and which two findings does it close? (R1.)
4. **Defend:** Justify why R8 (dropped FK) is correctly LOW and not a bug — cite the contract it protects.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — R1, R8 in depth
- `03-btree-hash-and-secondary-indexes.md` — R2, R4 in depth
- `04-query-planning-and-execution.md` — R5, R7 in depth
- `07-wal-durability-and-recovery.md` — R3, R9 in depth
- `study-data-modeling` — the integrity side of R8
- `study-performance-engineering` — the measurement side of R4–R7

---

Updated: 2026-06-24 — `slow ask` → `slow chat turn`; R8 now notes episodic-memory chunks (`createConversationMemory`, `src/session.ts:53,67`) also live in `chunks` with no documents row, reinforcing the deliberate-FK-drop verdict. R1 cross-transaction finding re-verified against `src/runtime.ts:11-17` — unchanged, still stands.
