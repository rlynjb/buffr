# RFC 01 — The pgvector graduation

**One-line summary.** Graduate the laptop brain from an in-memory RAG pipeline
to a persistent Supabase pgvector one by implementing the port (aptkit's
`VectorStore` contract) with a Postgres adapter (`PgVectorStore`) — so the
corpus and conversations survive a restart, and the agent loop changes zero
lines.

**Status:** Shipped. Built and verified live against `reindb` on 2026-06-19.
**Cited to:** `sql/001_agents_schema.sql`, `src/pg-vector-store.ts`,
`src/session.ts`, `src/supabase-trace-sink.ts`, and the as-built spec
`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`.

---

## 1. Context / problem

The in-memory brain was a toy in one specific way: it forgot everything on exit.
The whole RAG pipeline — embed, upsert, cosine search, return chunks — ran
against an `InMemoryVectorStore` (cosine over a JS array). Re-run the CLI and the
corpus is gone; you re-index from scratch every time. There's no conversation
history because there's no place to put it.

That's fine for proving the pipeline works. It's not a brain. A brain remembers
its corpus and its conversations across runs. The forcing constraint: this is
**v1b of the deferred body** — the smallest persistent step toward an agent that
lives on your machine, single device, no phone, no sync, no HTTP API yet
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:14-22`).

The leverage point is that aptkit already shipped the seams. The port (the
`VectorStore` contract), the embedding port (`EmbeddingProvider`), the
`RagQueryAgent`, the Gemma provider, the evals — all done, all in the library.
buffr doesn't need to build a RAG pipeline. It needs to fill one contract with a
Postgres-backed implementation.

```
  Where the decision sits — the layers it touches

  ┌─ Agent layer (aptkit, unchanged) ───────────────────────────┐
  │  RagQueryAgent → createRetrievalPipeline → search tool       │
  └───────────────────────────┬──────────────────────────────────┘
                              │  depends on the PORT, not the adapter
  ┌─ Contract / port (aptkit) ▼──────────────────────────────────┐
  │  interface VectorStore { dimension; upsert(); search() }     │ ← the seam
  └───────────────────────────┬──────────────────────────────────┘
                              │  ★ THIS RFC: a new adapter ★
  ┌─ Adapter (buffr, NEW) ────▼──────────────────────────────────┐
  │  PgVectorStore implements VectorStore                        │
  └───────────────────────────┬──────────────────────────────────┘
                              │  node-postgres (pg), direct
  ┌─ Storage (Supabase Postgres) ▼───────────────────────────────┐
  │  reindb · schema agents · pgvector + HNSW cosine             │
  └──────────────────────────────────────────────────────────────┘
```

The dependency arrow is the whole game: the agent depends on the port, the port
knows nothing about Postgres, and the adapter is the only new code. That's
dependency inversion, and it's why "swap in-memory for pgvector" is an additive
move rather than a rewrite.

---

## 2. Goals & non-goals

**Goals.**
- The corpus and conversations survive a process restart (persistence).
- The agent loop and retrieval pipeline change **zero lines** — the adapter
  drops into `createRetrievalPipeline` because it satisfies the contract
  exactly (`src/session.ts:41-42`).
- Citations work identically across stores — a hit's metadata has the same
  shape (`docId`, `chunkIndex`, `text`) whether it came from memory or Postgres
  (`src/pg-vector-store.ts:79-84`).
- Forward-compatible schema: columns that are cheap now and painful to retrofit
  (`app_id`, `embedding_model`) exist from day one.

**Non-goals — stated to prevent scope fights.**
- **No HTTP API, no Edge Functions, no PostgREST.** One device has one client;
  direct `pg` is correct until app #2 exists
  (`...graduation-design.md:54-64`).
- **No RLS.** One writer (`app_id='laptop'`); isolation is by convention until a
  second tenant appears.
- **No phone, no sync, no gateway.** Those are the body decision; this RFC is
  laptop-only.
- **No new database.** Reuse the existing `reindb`; add a schema, not a project.

Naming the non-goals is what keeps the review on the actual decision. A reviewer
who wants RLS or an HTTP layer is reviewing a *different, later* RFC.

---

## 3. The decision

Implement the port with a thin Postgres adapter, and give it a `agents` schema
with a vector column and an approximate-nearest-neighbor index (HNSW, cosine).
The shape, before the prose:

```
  The chosen design — adapter fills the contract, schema holds the vectors

  caller (aptkit pipeline)
     │  store.upsert(chunks) / store.search(vector, k)
     ▼
  ┌─ PgVectorStore (buffr) ─────────────────────────────────────┐
  │  upsert:  INSERT ... ON CONFLICT (id) DO UPDATE  (one txn)   │
  │  search:  ORDER BY embedding <=> $1  LIMIT k                 │
  │           score = 1 - cosine_distance                       │
  │  assertDim(v): v.length !== 768 → throw   (loud, never trunc)│
  └────────────────────────────┬────────────────────────────────┘
                               │  pg Pool
  ┌─ agents schema (reindb) ───▼────────────────────────────────┐
  │  chunks(id, document_id, app_id, chunk_index, content,      │
  │         embedding vector(768), embedding_model, meta)        │
  │  INDEX hnsw (embedding vector_cosine_ops)                    │
  │  documents · conversations · messages · profiles            │
  └──────────────────────────────────────────────────────────────┘
```

Three load-bearing details:

**The adapter is a thin translation, not a layer.** `upsert` reads aptkit's
deterministic chunk shape (`meta.docId`, `meta.chunkIndex`, `meta.text`) and
writes a row; `search` runs a cosine query and rebuilds the in-memory metadata
shape on the way out so the `search_knowledge_base` tool's citations work
unchanged (`src/pg-vector-store.ts:38-85`). The `<=>` operator is cosine
*distance*; similarity score is `1 - distance` — done in SQL, not in JS
(`src/pg-vector-store.ts:69-70`).

**The dimension guard is loud.** A vector whose length ≠ 768 throws — same
failure as the in-memory store (`src/pg-vector-store.ts:32-36`). It never
silently truncates, because a truncated embedding is a corrupt one that returns
plausible-looking garbage from search.

**The schema is forward-compat, not minimal.** `app_id` defaults `'laptop'` and
`embedding_model` defaults `'nomic-embed-text:v1.5'`
(`sql/001_agents_schema.sql:14-24`). Neither is used by a second consumer today.
Both exist because adding them after the corpus is populated is a migration over
live vectors; adding them now is a column default.

---

## 4. Alternatives considered

Three real options were on the table. This is "design it twice" written down.

**A — Stay in-memory, persist to a JSON file on exit.** The cheapest path:
serialize the array to disk, reload on start. It loses because cosine search
over a growing JSON array is O(n) per query with no index, and because it
gives you nothing for conversation history — you'd still need a real store for
`conversations`/`messages`. It solves persistence and nothing else. The corpus
is small now, so the O(n) cost doesn't bite *yet* — but the one-way door (you'd
re-migrate to a real DB later anyway) makes paying the cost now correct.

**B — A dedicated vector database (Pinecone / Qdrant / Weaviate).** The
purpose-built option. It loses on two grounds. First, it splits storage: vectors
live in the vector DB, but `documents`/`conversations`/`messages`/`profiles` are
relational and need Postgres anyway — so you'd run two systems and keep them
consistent. Second, it's a managed cloud dependency for a single-device brain
whose whole premise is *self-hosted, your data is yours*
(`agent-layer-plan.md:131`). pgvector keeps vectors and relational data
colocated in one Postgres instance — the same shape AdvntrCue shipped.

**C — A new Supabase project for the agent.** Clean isolation. It loses because
`reindb` already hosts per-app schemas (`app_buffr`, etc.); the agent layer is
just another "app" and gets a schema, not a project
(`...graduation-design.md:31-32`). A new project is operational overhead
(another set of secrets, another dashboard, another connection string) for
isolation that a schema already provides.

```
  Why each alternative lost — the deciding axis

  option              persistence?  index?   one system?  self-hosted?
  ─────────────────   ───────────   ──────   ──────────   ────────────
  A  JSON file        yes           NO       yes          yes
  B  vector DB        yes           yes      NO (two)     NO (cloud)
  C  new project      yes           yes      yes          yes  ← but overhead
  ★  pgvector schema  yes           HNSW     yes          yes
```

The deciding axis is **one system, self-hosted, indexed**. Only pgvector-in-the-
existing-reindb satisfies all three.

---

## 5. Tradeoffs accepted

Owned without flinching. Each is a deliberate cost, not an apology.

**We dropped the chunks→documents foreign key — accepting referential integrity
by convention.** The textbook schema puts a FK from `agents.chunks.document_id`
to `agents.documents.id`. We dropped it (`sql/001_agents_schema.sql:15-27`,
which even drops the constraint idempotently for already-migrated DBs). Two
reasons, both load-bearing:

1. **Contract parity.** A hard FK gives the adapter a hidden precondition — a
   `documents` row must exist before any chunk. But the `VectorStore` contract's
   `upsert(chunks)` knows nothing about documents; aptkit's `indexDocument`
   upserts chunks directly. A FK would make the Postgres adapter behave
   differently from the in-memory one, breaking the drop-in parity that is the
   entire point of this RFC.
2. **Memory rows have no document.** The `@aptkit/memory` engine writes
   conversation memory *as chunks* tagged `kind=memory`, with no `documents` row
   behind them (`src/session.ts:50-53`). A FK would reject every memory write.

The cost: `document_id` is a soft link. An orphaned chunk (a `document_id`
pointing at a deleted document) won't be caught by the database. We accept that —
chunk ids are deterministic (`"<docId>#<index>"`) and re-indexing is
first-class, so the corpus is rebuildable, which is the real integrity guarantee
here. (This is the "fold-it" decision from the overview — a tradeoff of the
graduation, not a doc of its own.)

**We store the chunk text twice — accepting denormalization.** The chunk's text
lives in `agents.chunks.content` and is also reconstructed into `meta.text` on
read (`src/pg-vector-store.ts:46,83`). The duplication buys citation parity: the
tool reads `meta.text` regardless of store, so we don't special-case Postgres in
the agent. The cost is bytes, which for a single-device corpus is free.

**We chose direct `pg` over an HTTP layer — accepting that app #2 needs new
code.** No PostgREST, no Edge Functions. When the phone arrives, it can't reach
Postgres directly; it'll need the HTTP layer this RFC deferred
(`...graduation-design.md:62-64`). We accept re-opening this boundary later
because building it now adds PostgREST indirection and latency for the only
client that exists.

---

## 6. Risks & mitigations

```
  Risk register — what breaks, what guards it

  risk                          blast radius      mitigation
  ───────────────────────────   ───────────────   ──────────────────────────
  embedding dim drift           silent garbage    assertDim throws on ≠768
   (swap embedder → 1536)        from search        (pg-vector-store.ts:32)
                                                    + embedding_model column
                                                    records which model wrote
  app_id isolation is           cross-app reads    one writer today; RLS is a
   convention-only               when app #2        hard prerequisite before
                                 writes             app #2 (named in §8)
  HNSW recall < exact           a relevant chunk   defaults fine for small
   (approximate index)           missed at top-k    corpus; revisit m /
                                                    ef_construction past ~10k
  orphaned chunks (no FK)        stale citation     deterministic ids +
                                                    first-class reindex →
                                                    corpus is rebuildable
```

The sharpest one is **embedding dimension drift**. `nomic-embed-text:v1.5` is
768-dim; switching to OpenAI (1536) or Voyage (1024) is a one-way door over the
whole corpus (`agent-layer-plan.md:115`). The `embedding_model` column is the
mitigation — it records which model embedded each row, so a reindex can detect
the mismatch instead of cosine-searching across incompatible vector spaces.

---

## 7. Rollout / migration

This shipped cleanly because it's additive at the contract — the agent layer
never knew. The rollout that mattered:

**The migration is idempotent.** `sql/001_agents_schema.sql` is all
`create ... if not exists` plus `drop constraint if exists`, so it runs safely
against a fresh DB or one migrated before the FK was dropped
(`sql/001_agents_schema.sql:14-30`). A migrated DB gets the FK removed in place;
a fresh DB never has it.

**The trace-sink ships full-signal from day one** — the second "fold-it"
decision. The sink persists all six `CapabilityEvent` types (step, tool-call
start/end, model usage, warning, error) and sets `created_at` from the *event
timestamp*, not server `now()` (`src/supabase-trace-sink.ts:53-85`). The
timestamp detail is the one worth a sentence in review: `emit()` is synchronous
(aptkit's contract) but the writes are queued and flushed concurrently after the
run (`src/supabase-trace-sink.ts:87-93`) — concurrent inserts race, so without
`created_at` from the event, replay order would be the random order the inserts
landed. This is the *right default*, not an RFC: there's no real alternative to
"capture the full trajectory" once trajectory replay is the goal, so it folds
into rollout instead of standing alone.

**Testing gates on the database.** `PgVectorStore` needs real Postgres +
pgvector, so integration tests gate behind `DATABASE_URL` and skip when it's
unset — no flaky cloud dependency in the default run
(`...graduation-design.md:173-182`). The parity test is the one that proves the
RFC: the same round-trip the in-memory store passes (embed → upsert → search
returns the planted chunk on top; dimension mismatch throws) now runs against
Postgres. If that test passes, the drop-in claim is verified, not asserted.

```
  Migration safety — what changes for whom

  ┌─ aptkit (agent + pipeline) ─┐   changes: NOTHING
  │  depends on the port only   │   the adapter satisfies the contract
  └─────────────────────────────┘

  ┌─ buffr session wiring ──────┐   changes: one line
  │  new PgVectorStore({pool})  │   was: new InMemoryVectorStore()
  └─────────────────────────────┘   (src/session.ts:41)

  ┌─ data already in flight ────┐   changes: re-index once
  │  in-memory corpus was       │   nothing to migrate — there was no
  │  ephemeral                  │   persisted state to carry over
  └─────────────────────────────┘
```

The cleanest part of this rollout: there's no data migration, because the thing
being replaced never persisted anything. You point the session at the new
adapter and re-index the corpus once.

---

## 8. Open questions

Honesty here is the staff signal. Three are genuinely open.

**The RLS-later checkpoint.** The shared `agents` schema relies on `app_id` for
isolation, and RLS is deferred — so that isolation is *by convention only* until
app #2 (`...graduation-design.md:191-195`). Adding RLS plus
always-derive-`app_id`-from-token is a **hard prerequisite** before a second app
writes, not a nice-to-have. This is the one to flag loudly in review: the
deferral is correct for one writer and dangerous the moment there are two.

**HNSW build params.** `m` and `ef_construction` use defaults. Fine for a small
corpus; revisit past ~10k chunks (the parent plan's batch-reindex threshold,
`agent-layer-plan.md:116`). Open because we have no recall numbers at scale yet.

**The two-brain body (a future RFC, design-only).** The north star is reasoning
local per device, data + retrieval shared in Supabase — laptop Gemma2:9b (full
brain) plus a phone on-device model (light brain), one shared memory plane
(`docs/superpowers/specs/2026-06-19-aptkit-packages-design.md`, the body
diagram). That's a sync/merge problem — two brains, one memory — and it's the
buffr canonical-local-with-cloud-mirror pattern again. **It is not written as an
RFC because it isn't built.** When it is, it reuses this schema and this
`VectorStore` contract with no rework — which is exactly what this RFC's
forward-compat columns and clean contract boundary were for.

---

## Coach notes — where a reviewer pushes

- **"Why not a real vector DB?"** Don't get defensive. Lead with the colocation
  answer: "vectors and relational data live in one Postgres instance; a
  dedicated vector DB splits storage and adds a managed cloud dependency to a
  self-hosted brain." That's alternative B, and it's the strongest pushback —
  have it loaded.
- **"Dropping the FK is a data-integrity smell."** Agree it's a smell, then show
  it's the lesser of two evils: a FK breaks contract parity *and* rejects every
  memory write. "I traded database-enforced integrity for contract parity, and
  bought integrity back with deterministic ids + rebuildable corpus." Owning the
  smell and naming the buy-back is what lands it.
- **"No RLS is scary."** Concede immediately and point at the checkpoint:
  "correct for one writer, and RLS is a hard prerequisite — named in open
  questions — before app #2." Conceding fast on a deferred-correctly decision
  reads as judgment, not as a gap.
- **The sentence that gets the yes:** "The agent loop changed zero lines because
  the adapter fills a contract aptkit already shipped." That's the whole RFC in
  one line — the persistence is real and the blast radius was one constructor
  call.

---

→ Next: `02-memory-extraction.md` builds on the same `VectorStore` /
`EmbeddingProvider` contracts this RFC leans on.
→ Comprehension-side walks: `.aipe/study-system-design/01-vector-store-adapter.md`,
`.aipe/study-data-modeling/03-soft-link-no-fk.md`.
