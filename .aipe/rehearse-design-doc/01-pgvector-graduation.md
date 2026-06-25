# Design Doc — The pgvector Graduation

> **Summary:** Graduate buffr's RAG from an in-memory vector store to a
> persistent Supabase pgvector store by *filling aptkit's `VectorStore`
> contract* with a `PgVectorStore` adapter — single device, direct `pg`, no
> rewrite of the agent. The in-memory toy becomes a brain that remembers its
> corpus and conversations across runs, and nothing above the store changes.

**Status:** Shipped — verified live against `reindb` 2026-06-19.
**Grounds:** `src/pg-vector-store.ts`, `sql/001_agents_schema.sql`,
`src/session.ts`, `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`.

---

## 2. Context / problem

buffr's predecessor (`docs/superpowers/plans/2026-06-19-laptop-build.md`)
built a working RAG agent on aptkit's runtime with an **in-memory** vector
store. It worked — and forgot everything on exit. Re-index the corpus every
run; lose every conversation; no episodic memory across sessions.

The forcing constraint: aptkit already shipped the *seams*. `RagQueryAgent`,
`createRetrievalPipeline`, the Gemma provider, the embedder, and the
`VectorStore` / `CapabilityTraceSink` contracts all exist in the published
`@rlynjb/aptkit-core` bundle. aptkit is **consumed, never edited here**
(`.aipe/project/context.md`, Must-not-change constraints). So the persistence
problem isn't "rewrite the agent" — it's "fill a contract aptkit already
defined, from inside buffr."

That reframing is the whole decision. The question stops being *how do I add a
database to my RAG app* and becomes *what's the smallest persistent thing I
can drop into an existing seam.*

> **Coach:** Lead with this reframing, not with "we needed persistence."
> Every candidate has needed persistence. The staff move is recognizing the
> problem was already shaped into a contract by the layer below — and that the
> right answer was an *adapter*, not a feature. Say: "aptkit had already
> drawn the seam; my job was to fill it without the agent noticing."

---

## 3. Goals & non-goals

**Goals**
- Persist the corpus (chunks + embeddings) and conversations across runs.
- Drop into `createRetrievalPipeline` with **zero agent changes** — the
  `search_knowledge_base` tool, its citations, and the agent loop must work
  unchanged across stores.
- Single device, one writer (`app_id = 'laptop'`).
- Forward-compatible schema so adding apps later needs no migration.

**Non-goals** (these are the scope fences — name them or the review drifts)
- No HTTP API / Edge Functions / PostgREST this phase. One client exists.
- No RLS policies. One tenant.
- No phone, no laptop↔phone sync, no multi-platform gateway.
- No `agents.tool_runs` cache.
- No new Supabase project — reuse existing `reindb`.

> **Coach:** The non-goals are where you win the review. When a reviewer says
> "shouldn't this go through an API?", you don't defend — you point at the
> non-goal: "named and deferred; YAGNI until a second client exists." A doc
> with explicit non-goals turns scope-creep questions into already-answered
> ones.

---

## 4. The decision

Fill aptkit's `VectorStore` seam with a buffr-owned `PgVectorStore` over
node-postgres, talking directly to a new `agents` schema in the existing
`reindb` Postgres (pgvector + HNSW cosine). The agent, pipeline, and tool are
untouched aptkit code.

```
  The graduation — same agent, store swapped underneath

  ┌─ Service layer (buffr runtime, src/session.ts) ──────────────┐
  │  GemmaModelProvider (guarded)   ← aptkit, unchanged          │
  │  RagQueryAgent                  ← aptkit, unchanged           │
  │  createRetrievalPipeline        ← aptkit, unchanged           │
  │        │ depends on the VectorStore CONTRACT                  │
  │        ▼                                                      │
  │  ┌──────────────────────── seam ────────────────────────┐    │
  │  │  BEFORE: InMemoryVectorStore   (aptkit, ephemeral)    │    │
  │  │  AFTER:  ★ PgVectorStore ★     (buffr, persistent)    │    │
  │  └───────────────────────────────────────────────────────┘   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ node-postgres (pg), direct
                                  │ ORDER BY embedding <=> $1  (cosine)
  ┌─ Storage layer (reindb Postgres) ─────────────────────────────┐
  │  schema agents:  documents · chunks(vector 768, HNSW) ·       │
  │                  conversations · messages · profiles          │
  │  [ existing app_* schemas untouched ]                         │
  └───────────────────────────────────────────────────────────────┘
```

The seam is the load-bearing idea. Everything above it sees a `VectorStore`;
whether that store lives in a JS `Map` or in Postgres is invisible. The
adapter's whole job is to *be* a `VectorStore` so convincingly that the agent
can't tell the difference.

Two details make the swap real:
- `PgVectorStore.search` rebuilds each hit's `meta` to the in-memory shape
  (`docId`, `chunkIndex`, `text`) so the tool's citations work unchanged
  (`src/pg-vector-store.ts:79-84`). The contract isn't just the method
  signatures — it's the *shape of what comes back*.
- A vector whose length ≠ `dimension` throws — the same loud failure
  `InMemoryVectorStore` gives (`src/pg-vector-store.ts:32-36`). Parity
  includes parity of failure.

> **Coach:** Borderline-doc callout — the trace-sink
> (`src/supabase-trace-sink.ts`) ships *with* this graduation: it fills the
> sibling `CapabilityTraceSink` contract, persisting all 6 `CapabilityEvent`
> types with `created_at` from `event.timestamp` for deterministic replay
> order. It's the same "fill the contract" move applied to trajectory
> capture. It doesn't get its own RFC because its alternatives are thin — but
> mention it here as evidence the seam-filling pattern is repeatable, not a
> one-off.

---

## 5. Alternatives considered

Three real options were on the table. Each lost for a nameable reason.

**A — Stay in-memory, persist with a snapshot file.**
Serialize the `Map` to disk on exit, reload on boot. Cheapest. Lost because it
doesn't give vector *search* over a growing corpus — you'd reload everything
into RAM every run, and there's no HNSW index, so retrieval is a linear scan
that degrades with corpus size. It also can't host conversation memory as
queryable rows. It's persistence without the thing persistence was *for*.

**B — A fresh Postgres project, dedicated to buffr.**
Clean isolation. Lost because `reindb` already hosts per-app schemas and
pgvector; a new project is operational overhead (another connection, another
secret, another thing to back up) for zero isolation benefit at one tenant.
The `agents` schema inside `reindb` is the cheaper boundary
(`agent-layer-plan.md`: "centralize the *agent layer*, not the *data*").

**C — Go straight to an HTTP API (Supabase Edge Functions / supabase-js).**
The "real architecture." Lost because it adds PostgREST indirection and
network latency for the *only client that exists* — the laptop, in-process.
Direct `pg` is one hop; the HTTP layer is YAGNI until a phone or a second app
appears (graduation spec, "Connection approach"). It's named and deferred, not
rejected: when app #2 arrives, the Edge layer wraps the *same* SQL.

> **Coach:** Alternative C is the one a senior reviewer pushes hardest —
> "real" systems have an API. Don't fold. The framing that holds: "an API is a
> boundary between clients; I have one client, in-process. Adding the boundary
> now buys indirection and latency and buys *nothing* until a second client
> exists. The SQL I'm writing is exactly what that future API would wrap." You
> didn't skip the API out of laziness — you deferred a one-way *cost*, not a
> one-way door.

---

## 6. Tradeoffs accepted

- **We chose direct `pg`, accepting that buffr now owns a SQL surface** that a
  future HTTP layer would otherwise hide. Cost: when the API arrives, the
  query in `search` (`src/pg-vector-store.ts:70-78`) moves behind an endpoint.
  Owned: it's a copy-paste move, not a redesign — the SQL is the contract.
- **We chose the shared `agents` schema with `app_id` columns, accepting that
  tenant isolation is by convention until RLS lands.** Cost: nothing stops a
  buggy writer from using the wrong `app_id`. Owned: at one tenant there's no
  second writer to isolate from; the column exists so RLS is an `ALTER`, not a
  migration (graduation spec, Open questions: "RLS-later checkpoint").
- **We chose pgvector colocated with relational data in one Postgres,
  accepting a single store for two access patterns** (ANN search + row
  lookups). Owned deliberately — colocating the vector and relational data is
  the point; it's how a chunk's `content` and its `embedding` stay one row.

---

## 7. Risks & mitigations

- **Risk: embedding-dimension drift.** Switch the embedder and every stored
  768-dim vector is wrong. *Mitigation:* `vector(768)` is hard-coded in the
  schema (`sql/001_agents_schema.sql:22`) and `assertDim` throws on any
  mismatch (`src/pg-vector-store.ts:32-36`) — a mismatch fails loud, never
  silently truncates (`.aipe/project/context.md`, constraints). The
  `embedding_model` column records which model wrote each row, so a re-embed
  is targetable.
- **Risk: a JS `number[]` mis-serialized into a Postgres array literal.**
  *Mitigation:* `toVectorLiteral` produces pgvector's `[a,b,c]` text form and
  the query casts `$1::vector` explicitly (`src/pg-vector-store.ts:14-17`).
- **Risk: partial corpus on a failed batch index.** *Mitigation:* `upsert`
  wraps the whole batch in a `begin`/`commit`/`rollback` transaction
  (`src/pg-vector-store.ts:40-64`) — all chunks land or none do.

---

## 8. Rollout / migration

- The schema migration is **idempotent** — every object is
  `create ... if not exists` (`sql/001_agents_schema.sql`), so re-running the
  migration on an already-graduated DB is a no-op.
- For callers: **nothing changes.** That's the whole point of filling a
  contract. `src/session.ts:39-42` swaps `InMemoryVectorStore` for
  `PgVectorStore` in the pipeline construction; the agent built at
  `src/session.ts:57` is unaware.
- Data in flight: the old in-memory brain held nothing across runs, so there's
  no data to migrate — the first `index` run populates the persistent corpus
  fresh.

---

## 9. Open questions

- **HNSW build params** (`m`, `ef_construction`) are defaults. Fine for a
  small corpus; revisit past ~10k chunks (graduation spec; `agent-layer-plan.md`
  batch-reindex threshold).
- **RLS-at-app-#2 is a hard prerequisite, not a nicety.** The shared schema's
  isolation is `app_id`-by-convention until a second app writes. Before that
  happens: RLS on every `agents.*` table + always-derive-`app_id`-from-token.
  Named now so it's not discovered later.
- **The reindex one-way door.** Changing `embedding_model` requires re-embedding
  the whole corpus. The design names a first-class `reindex(embedder)`
  operation; whether it's online or stop-the-world at scale is open.

---

## See also

- `02-aptkit-memory-extraction.md` — the memory engine that rides this same
  store via the same contract.
- `03-dropped-chunks-documents-fk.md` — the schema tradeoff that keeps this
  store drop-in compatible.
- `.aipe/study-system-design/` — the mechanism walk of the `VectorStore` seam.
- `.aipe/rehearse-problem-selection/` — why persistence was worth the spend.
