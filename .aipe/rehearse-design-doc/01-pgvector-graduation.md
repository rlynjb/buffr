# DOC 01 — The pgvector Graduation

**Decision (one line):** Graduate the laptop RAG agent from an in-memory vector
store to **persistent Supabase pgvector** by *filling an existing contract* —
`PgVectorStore implements VectorStore` — so the agent, the pipeline, and the
retrieval tool change zero lines, and the agent now remembers its corpus and its
conversations across runs.

*Source: `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`.
Built and verified live against `reindb` on 2026-06-19.*

---

## 2. Context / problem

The laptop brain worked, but it forgot everything on exit. The whole RAG
pipeline — embed → upsert → cosine search → retrieve — ran against an
`InMemoryVectorStore`. Restart the process and the indexed corpus, every
conversation, and any memory of the user was gone. A toy, not a brain.

The forcing function: aptkit had already shipped the *seams* — the `VectorStore`
and `EmbeddingProvider` contracts, the `RagQueryAgent`, the Gemma provider, the
evals. The agent doesn't know or care where vectors live; it only speaks the
`VectorStore` contract. So the persistence problem wasn't "rewrite the agent."
It was "write one adapter that speaks that contract over a real database."

The constraint that shaped everything downstream: **buffr consumes aptkit, never
edits it** (`context.md`, "Must-not-change constraints"). aptkit is the
deployment-agnostic toolkit; buffr is the body. So the persistent store had to
slot into `createRetrievalPipeline` with no changes on the aptkit side at all.

---

## 3. Goals & non-goals

**Goals**

- Corpus and conversations survive process restart — durable RAG.
- Drop into `createRetrievalPipeline` with **zero agent changes** — the store is
  the only thing that knows it's now Postgres.
- One schema that doesn't need a migration when a second app shows up later.
- Same loud failures as in-memory — a wrong-dimension vector throws, never
  silently truncates.

**Non-goals (explicit — these prevent scope fights)**

- **No HTTP API / Edge Functions this phase.** Single device, one client.
- **No RLS.** One writer (`app_id = 'laptop'`); isolation is by convention until
  app #2.
- **No phone, no sync, no gateway, no fine-tune.** All named and deferred
  (graduation spec, "Out of scope").
- **No `agents.tool_runs` cache.** YAGNI for one device.

The non-goals are doing real work here. "No RLS" and "no Edge Functions" are the
two a reviewer reaches for first — naming them as deliberate deferrals, not
oversights, is what stops the review from becoming a scope argument.

---

## 4. The decision

Two pieces: a forward-compat `agents` schema in the existing `reindb`, and a
`PgVectorStore` adapter that fills aptkit's `VectorStore` contract over it. The
agent sits on top, unchanged.

```
  The graduation — adapter fills a contract, agent doesn't move

  ┌─ aptkit (UNCHANGED — consumed, never edited) ───────────────┐
  │  RagQueryAgent → createRetrievalPipeline → VectorStore (iface)│
  └──────────────────────────────────┬───────────────────────────┘
                                      │  the seam: VectorStore contract
                                      │  (upsert / search / dimension)
  ┌─ buffr (NEW) ────────────────────▼───────────────────────────┐
  │  PgVectorStore implements VectorStore   src/pg-vector-store.ts │
  │    upsert → INSERT ... ON CONFLICT (id) DO UPDATE             │
  │    search → ORDER BY embedding <=> $1   (cosine distance)     │
  └──────────────────────────────────┬───────────────────────────┘
                                      │  node-postgres (pg), direct
  ┌─ Storage: reindb (Supabase Postgres) ▼───────────────────────┐
  │  agents schema  (pgvector + HNSW cosine)                     │
  │    documents · chunks(vector 768) · conversations · messages │
  │    · profiles      — every row keyed by app_id               │
  │  [ existing app_* schemas untouched ]                        │
  └──────────────────────────────────────────────────────────────┘
```

**The load-bearing move is the seam, not the database.** Because aptkit defines
`VectorStore` as `{ dimension, upsert, search }` and nothing more, the
persistence change is fully contained in one file. `createChatSession` swaps one
constructor — `new PgVectorStore({ pool, ... })` instead of the in-memory one —
and the agent, the pipeline, the tool, and the memory engine are all none the
wiser (`src/session.ts:41-42`).

`search` does one extra job worth calling out: it rebuilds each hit's `meta`
into the in-memory shape (`docId`, `chunkIndex`, `text`) so the
`search_knowledge_base` tool's citations work *identically* across stores
(`pg-vector-store.ts:79-84`). The contract isn't just the method signatures —
it's the *shape of what comes back*. Honor that and the tool can't tell which
store it's talking to.

**Why direct `pg`, not Edge Functions:** a single device has exactly one client.
Vector search is one cosine query — `ORDER BY embedding <=> $1 LIMIT k`. Wrapping
it in PostgREST or an Edge Function adds an HTTP hop and latency for the only
caller that exists. The HTTP layer is deferred, named, and arrives with app #2.

---

## 5. Alternatives considered

**Alternative A — stay in-memory, rebuild the index on boot.**
Re-embed the whole corpus from markdown at every startup. *Why it lost:* it
re-embeds on every run (slow, and burns the embedder), and it can't persist
*conversations* or *memory* at all — those have no markdown source to rebuild
from. The forgetting problem is unsolved for exactly the data that makes it a
brain.

**Alternative B — a managed/dedicated vector database (Pinecone, Weaviate,
Qdrant).**
Purpose-built ANN, less SQL to own. *Why it lost:* `reindb` already exists and
already runs pgvector-capable Postgres. A separate vector DB means a second
system to operate, a second set of credentials, and — the killer — your
relational data (documents, conversations, profiles) and your vectors now live
in two places that can drift. Colocating vectors and rows in one Postgres
instance keeps a single source of truth and one connection. The pattern (embed +
ANN + retrieval) is identical; only the operational cost differs.

**Alternative C — a new Supabase project for the agent layer.**
Clean isolation. *Why it lost:* `reindb` already hosts per-app schemas
(`app_buffr`, etc.). A new project is a new thing to provision, secure, and pay
for, to hold one schema. Adding the `agents` schema to the existing database
reuses what's there and keeps the existing per-app schemas untouched
(graduation spec, "Decisions locked").

---

## 6. Tradeoffs accepted

- **We chose direct `pg`, accepting that a second client later needs the HTTP
  layer we deferred.** When the phone or app #2 arrives it can't reach `pg`
  directly across the network — that phase builds the Edge Function layer
  wrapping the same SQL. We took the latency win for the one client that exists,
  and the rework is bounded because the SQL doesn't change.
- **We chose `app_id` columns with no RLS, accepting isolation-by-convention.**
  Every `agents.*` table carries `app_id` (`sql/001_agents_schema.sql`), but
  with one writer there are no RLS policies enforcing it. The columns are cheap
  now and painful to retrofit; the *enforcement* waits until a second tenant
  makes it necessary.
- **We chose to own SQL and an HNSW index**, accepting that we now operate a
  vector index (build params, recall tuning) instead of outsourcing it to a
  managed service. For a small single-device corpus, that's a few lines of DDL,
  not an operational burden.

---

## 7. Risks & mitigations

```
  Risk → mitigation

  embedding-dim mismatch   → assertDim() throws on any vector whose length
   (768 everywhere)          ≠ store dimension; same loud failure as in-memory
                             (pg-vector-store.ts:32-36). Never truncates.

  isolation by convention  → app_id is on every table now; RLS is a named
   (no RLS)                  prerequisite gated before app #2 writes
                             (graduation spec, "Open questions").

  HNSW recall on a bigger  → defaults fine for a small corpus; m / ef_construction
   corpus                    revisited past ~10k chunks (the parent plan's
                             batch-reindex threshold).

  swapping the embedder    → embedding_model is stored per chunk; reindex is
   (a one-way door)          first-class so a model change re-embeds the corpus
                             instead of silently mixing dimensions.
```

---

## 8. Rollout / migration

- **Schema:** `sql/001_agents_schema.sql` is idempotent — `create ... if not
  exists` throughout, run by the transactional migration runner (`src/migrate.ts`).
  Safe to re-run against an already-migrated `reindb`.
- **For callers:** nothing changes. The agent, pipeline, and tool see the same
  `VectorStore` interface. The only edit is the store constructor in
  `src/session.ts`.
- **For data in flight:** there was none to migrate — the in-memory store held
  nothing across runs. The corpus is re-indexed once into pg via the `index`
  CLI; from then on it persists.
- **Tests:** integration tests gate behind `DATABASE_URL` and skip when unset,
  so the default `node:test` run stays green with no cloud dependency. The same
  round-trip the `InMemoryVectorStore` passed (embed → upsert → search returns
  the planted chunk on top; dimension mismatch throws) now runs against real pg.

---

## 9. Open questions

- **RLS-later checkpoint.** With RLS deferred, `app_id` isolation is by
  convention only. Adding RLS *plus* always-derive-`app_id`-from-token is a hard
  prerequisite before a second app writes — not an afterthought.
- **HNSW build params (`m`, `ef_construction`).** Defaults are fine now; the
  revisit threshold is ~10k chunks. Unsettled until the corpus is that big.
- **Conversation retention.** Unbounded `messages` growth is a real cost.
  TTL / keep-N-recent / archive is named in the parent plan and not yet decided.

---

## Coach notes — where a reviewer pushes, and the framing that holds

- **"Why not just use a vector database?"** Don't get defensive. The answer is
  colocation: "vectors and relational rows in one Postgres instance is one
  source of truth and one connection; a separate vector DB is a second system
  that can drift from the rows it indexes." That's an architecture answer, not a
  preference.
- **"No RLS is a security hole."** Agree on the principle, reframe the timing:
  "single writer today, so RLS guards nothing yet — and I've gated it as a hard
  prerequisite before the second app, with `app_id` already on every table so
  there's no migration." You've already thought past their objection.
- **The sentence that gets the yes:** *"The agent didn't change. I filled
  aptkit's `VectorStore` contract with a Postgres-backed adapter, and persistence
  fell out."* Lead with that. It signals you found the seam instead of
  rewriting the system.

---

## See also

- DOC 02 — the memory engine that rides this same store.
- DOC 03 — the dropped FK that lets memory rows live in `chunks` with no
  `documents` row.
- `.aipe/study-system-design/01-vector-store-adapter.md`,
  `.aipe/study-data-modeling/01-vector-column-and-ann-index.md`.
