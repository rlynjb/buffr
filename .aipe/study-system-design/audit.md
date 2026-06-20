# System Design Audit — buffr-laptop (Pass 1)

Eight lenses, walked against the actual code. Each names what the repo does
with `file:line` grounding, or says `not yet exercised` honestly. Where a
finding earns a Pass 2 pattern file, the lens cross-links rather than
restating.

Scope: `buffr-laptop` — TS ESM, single device, Postgres + pgvector,
consuming `@rlynjb/aptkit-core@^0.4.0`. The toolkit is a dependency; this
audit covers buffr's code and the boundary, not aptkit internals.

---

## 1. system-map-and-boundaries

Three buffr-owned layers sit on top of one imported toolkit, one datastore,
and one local model server.

- **CLI entrypoints** — `src/cli/index-cmd.ts`, `src/cli/ask-cmd.ts`,
  `src/cli/eval-cmd.ts`. Each is a top-level module that runs on import
  (`loadEnv()` at `ask-cmd.ts:13`), builds wiring, does one job, calls
  `pool.end()`. No server, no router.
- **Adapter layer** — `PgVectorStore` (`src/pg-vector-store.ts:19`)
  implements aptkit's `VectorStore`; `SupabaseTraceSink`
  (`src/supabase-trace-sink.ts:23`) implements `CapabilityTraceSink`;
  `indexDocumentRow` (`src/runtime.ts:5`) writes the `documents` row;
  `loadProfile` (`src/profile.ts:4`) reads the prompt profile.
- **Pure config + db factory** — `loadConfig(env)` (`src/config.ts:9`) is
  pure (env in, config out); `createPool(databaseUrl)` (`src/db.ts:4`) is a
  one-line `pg.Pool` factory. These two have zero side effects and are the
  most testable code in the repo.
- **External dependencies**: Postgres (`reindb`, schema `agents`) over
  `node-postgres`; Ollama at `cfg.ollamaHost` (default `localhost:11434`,
  `config.ts:14`) serving `gemma2:9b` and `nomic-embed-text:v1.5`.

**Trust boundaries.** There is essentially one trust domain: the laptop. No
auth, no RLS, no network ingress. `app_id` (`config.ts:11`, default
`'laptop'`) is the *only* tenancy key, and this phase has one tenant. The
design doc names this plainly: isolation is "by convention only until app
#2" (`docs/.../laptop-supabase-graduation-design.md:193`). Secrets
(`DATABASE_URL`) live in `.env`, gitignored.

The single most important boundary is the **library-as-dependency seam**:
buffr → `@rlynjb/aptkit-core` is a one-directional import with a hard rule
that aptkit is never edited here (`context.md` must-not-change; design doc
line 6). → see `04-library-as-dependency-boundary.md`.

## 2. request-response-and-data-flow

Two end-to-end flows, both starting at a CLI process.

**Index flow** (`index-cmd.ts:22-26` → `runtime.ts:5` →
`pg-vector-store.ts:38`):

```
  read file → indexDocumentRow → INSERT documents row
                               → pipeline.index({id,text})
                                   → aptkit chunks the text
                                   → OllamaEmbeddingProvider embeds each chunk
                                   → PgVectorStore.upsert(chunks)  [one txn]
```

The documents source-of-truth row is written by buffr (`runtime.ts:11-17`)
*before* `pipeline.index` runs, because the `VectorStore` contract has no
notion of a documents row — the store only ever sees chunks. → see
`02-retrieval-pipeline.md`.

**Ask flow** (`ask-cmd.ts:29-37`):

```
  startConversation → persist user msg → RagQueryAgent.answer(question)
     └─ agent loop: model decides → search_knowledge_base tool
            └─ pipeline.query → embed question → PgVectorStore.search (cosine)
     └─ trace.emit() per step  (sync, queued)
  trace.flush()  (await all queued writes) → print answer → pool.end()
```

The flow is a **waterfall, not parallel** — embed, then search, then
generate, then persist. Single user, no fan-out. The one piece of
deferred-write concurrency is the trace sink: `emit()` is sync and pushes
promises onto a queue (`supabase-trace-sink.ts:27-35`), `flush()` awaits
them all (`:37-39`). → see `03-trajectory-capture.md`.

**Eval flow** (`eval-cmd.ts:24-33`) — loop over labeled queries,
`pipeline.query(query, K)`, map hits to `docId`, score P@1 and R@k with
aptkit's scorers. Read-only against the corpus.

## 3. state-ownership-and-source-of-truth

Postgres is the sole source of truth. There is no client state, no URL
state, no cache. Ownership by table:

- **`agents.documents`** — corpus source-of-truth rows. Owned by the
  `index` CLI via `runtime.ts:11`. Key is aptkit's deterministic `docId`
  (e.g. `basename(path)`, `index-cmd.ts:24`).
- **`agents.chunks`** — embeddings + chunk text. Owned by `PgVectorStore`
  (`pg-vector-store.ts:47`). Key is aptkit's `"<docId>#<index>"`. Upsert is
  `on conflict (id) do update` (`:50`) — re-indexing is idempotent.
- **`agents.conversations` / `messages`** — trajectory. `conversations`
  owned by `startConversation` (`supabase-trace-sink.ts:4`); `messages`
  written from two places: the CLI for the `user` turn (`ask-cmd.ts:30`)
  and the trace sink for `assistant`/`tool` turns
  (`supabase-trace-sink.ts:29-34`).
- **`agents.profiles`** — the me.md profile. Read-only here via
  `loadProfile` (`profile.ts:4`); "most recent wins"
  (`order by updated_at desc limit 1`). No write path in the repo — rows are
  inserted out of band.

The notable ownership split: a chunk's `meta` shape is **reconstructed on
read** (`pg-vector-store.ts:80-84`) to match the in-memory store's shape, so
the citation tool works identically across stores. The DB owns the canonical
columns (`document_id`, `chunk_index`, `content`); the store re-derives the
`meta.docId / chunkIndex / text` view the tool expects. → see
`01-vector-store-adapter.md`.

## 4. caching-and-invalidation

`not yet exercised.` There is no cache layer. The design doc explicitly
defers `agents.tool_runs` (the tool-result cache) as "YAGNI for a single
device" (`laptop-supabase-graduation-design.md:130, 184`). Embeddings are
recomputed on every `ask`/`eval` query; there is no memoization of model
calls or retrieval results.

The one freshness mechanism is upsert idempotency: re-running `index` on the
same file overwrites chunks by deterministic id (`pg-vector-store.ts:50`),
so the corpus is self-invalidating on re-index — but that is overwrite, not
cache invalidation. The connection pool (`db.ts:4`) caches *connections*,
not data.

## 5. storage-choice-and-durability-boundaries

One datastore, chosen deliberately. Postgres + pgvector colocates relational
data (documents, conversations) and vector data (chunk embeddings) in one
engine — the same "vector + relational colocated in one Postgres" shape the
reader shipped in AdvntrCue, here on a self-hosted `reindb` instead of
serverless.

- **Why pgvector, not a dedicated vector DB**: one client, one corpus, and
  the relational side (conversations, profiles) lives in the same place. A
  separate Pinecone/Qdrant would split the source of truth for no gain at
  this scale.
- **`vector(768)`** (`sql/001_agents_schema.sql:22`) is a typed column — the
  dimension is a schema-level invariant, enforced again in app code
  (`pg-vector-store.ts:32-36`) so a mismatch throws loudly rather than
  truncating. This is a named one-way door (`agent-layer-plan.md` open
  questions; design doc must-not-change).
- **HNSW cosine index** (`sql/001_agents_schema.sql:28-29`,
  `vector_cosine_ops`) — approximate-nearest-neighbor index. The query uses
  `<=>` cosine distance, `order by ... limit k` (`pg-vector-store.ts:74-76`).
  Engine internals (how HNSW navigates, recall/ef tradeoffs) →
  cross-link `study-database-systems`.
- **Durability boundary**: `upsert` wraps all chunks of a document in one
  transaction (`pg-vector-store.ts:42, 58`, `begin`/`commit` with
  `rollback` on error) — a partially-embedded document never lands. The
  migration runner does the same for schema (`migrate.ts:11-19`).

Schema shape (the FK that was dropped, `app_id` denormalization, the
`documents`/`chunks` split) → cross-link `study-data-modeling`.

## 6. failure-handling-and-reliability

What is exercised:

- **Loud config failure** — every CLI throws if `DATABASE_URL` is unset
  (`index-cmd.ts:12`, `ask-cmd.ts:15`, `eval-cmd.ts:11`, `migrate.ts:26`).
  Fail fast, no partial run.
- **Dimension mismatch throws** — `assertDim` (`pg-vector-store.ts:32-36`)
  on both `upsert` and `search`. A 3-element vector against a 768 store
  raises before touching the DB (test: `pg-vector-store.test.ts:42-46`).
- **Transactional rollback** — `upsert` and `runMigration` roll back on any
  error (`pg-vector-store.ts:59-61`, `migrate.ts:13-15`). Partial writes
  don't persist.
- **Weak-model robustness fixes** — the design doc records two real
  failures with a local Gemma: it passed `top_k: 1` (starving multi-part
  questions) and a hallucinated `filter` key that zeroed retrieval. Both
  fixed in aptkit (`minTopK` floor wired at `ask-cmd.ts:23`;
  `createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 })`). Named in
  `laptop-supabase-graduation-design.md:209-212`.

What is **not yet exercised**: no retries on a slow/failed Ollama or
Postgres call; no timeout on the embed/generate hop; no graceful
degradation if the model server is down (the process just throws); no
offline behavior (everything is local already, so "offline" is the normal
case); no circuit breaking. Single device, single process — partial failure
of one component fails the whole invocation, by design. Coordination
mechanics for the deferred multi-node future → cross-link
`study-distributed-systems`.

## 7. scale-bottlenecks-and-evolution

Honest framing: this system is built for **N=1 device**, and the design
deliberately defers everything that scale would force. What breaks first,
and what the design already answers:

- **First bottleneck — synchronous index.** `index` embeds and upserts
  inline (`runtime.ts:17`, `index-cmd.ts:22-26`). The plan names the
  threshold: "batch reindex past ~10k chunks"
  (`agent-layer-plan.md` What NOT to do #3; design doc open questions). Below
  that, inline is fine.
- **HNSW build params** — `m` / `ef_construction` use defaults
  (`sql/001_agents_schema.sql:28-29`). Design open question flags revisiting
  past ~10k chunks (`laptop-supabase-graduation-design.md:197`).
- **The 768-dim one-way door** — switching embedders (OpenAI 1536, Voyage
  1024) means re-embedding the whole corpus. The `embedding_model` column
  (`sql/001_agents_schema.sql:23`) exists precisely so a reindex can be
  detected and driven. The design names a `reindex(embedder)` as
  first-class (design doc line 154) — **built into the plan, not yet
  implemented in code** (`not yet exercised` as code; named as intent).
- **What stays stable at 10x**: the `VectorStore` seam and the `agents`
  schema. The whole deferral thesis is that the phone, sync, edge API, and
  RLS phases reuse this schema and contract with no rework
  (`laptop-supabase-graduation-design.md:184-189`). → see `07-deferred-body.md`.

The rearchitecting trigger is **app #2 writing to the schema** — that forces
RLS and always-derive-`app_id`-from-token (design doc line 193). Until then,
`app_id` isolation is convention.

## 8. system-design-red-flags-audit

Ranked by architectural weight. Each is grounded; most are *named-and-
accepted* tradeoffs, not oversights — which is the right read for a
deliberately-scoped v1b.

1. **Tenancy isolation is by convention, not enforced.** Every table has
   `app_id` but nothing enforces it — no RLS, and `app_id` comes from
   config, not a token (`config.ts:11`). At one tenant this is correct; the
   design names RLS + token-derived `app_id` as a *hard prerequisite* before
   app #2 (`laptop-supabase-graduation-design.md:193`). Risk is real only at
   the boundary it's gated behind. → `07-deferred-body.md`.
2. **No timeouts or retries on external hops.** Ollama embed/generate and
   every `pg` query run with no timeout and no retry (`pg-vector-store.ts`,
   `ask-cmd.ts`). A hung Ollama hangs the CLI. Acceptable for an interactive
   single-user CLI; would be a defect in a service.
3. **Trace writes are fire-and-forget until flush.** `emit()` pushes
   promises and never inspects them individually (`supabase-trace-sink.ts:27-35`);
   only `flush()`'s `Promise.all` surfaces a rejection (`:37-39`). If a
   message insert fails mid-run, the failure appears only at flush, after
   the answer is computed. Trajectory loss is non-fatal to the answer — an
   acceptable ordering, but worth naming. → `03-trajectory-capture.md`.
4. **`document_id` has no FK** (`sql/001_agents_schema.sql:16-17, 27`). A
   chunk can reference a non-existent document. This is a *deliberate*
   deviation to keep `VectorStore` drop-in parity (the store upserts chunks
   with no documents row) — the as-built note explains it
   (`laptop-supabase-graduation-design.md:202-207`). Referential integrity
   traded for contract purity. Schema-shape detail → `study-data-modeling`.
5. **CLI wiring is duplicated three times.** `index`, `ask`, `eval` each
   rebuild pool → embedder → store → pipeline (`index-cmd.ts:17-20`,
   `ask-cmd.ts:19-22`, `eval-cmd.ts:13-16`). Minor; a shared `buildPipeline`
   factory would dry it up. Not load-bearing. → `05-cli-as-entrypoints.md`.

---

### Lens summary

| Lens | Verdict |
| --- | --- |
| 1. system-map-and-boundaries | Three buffr layers + toolkit + pg + Ollama; one trust domain |
| 2. request-response-and-data-flow | Two waterfall flows (index, ask) + read-only eval |
| 3. state-ownership | Postgres sole source of truth; meta reconstructed on read |
| 4. caching-and-invalidation | `not yet exercised` (tool cache deferred) |
| 5. storage-choice-and-durability | pgvector colocated; `vector(768)` one-way door; HNSW; txn upsert |
| 6. failure-handling | fail-fast config + dim guard + txn rollback; no retries/timeouts |
| 7. scale-bottlenecks | built for N=1; sync index + 768 door named; reuse-on-scale thesis |
| 8. red-flags | convention-tenancy, no timeouts, fire-and-forget trace, no-FK, dup wiring |
