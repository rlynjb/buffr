# audit.md — the 8-lens architectural audit

Pass 1. One `##` section per system-design lens, walked against the real codebase with
`file:line` grounding. Where a lens finds nothing, it says `not yet exercised` — no
invented services, no invented scale. Significant findings cross-link to a Pass-2
pattern file rather than restating it.

The honest frame up front: **buffr-laptop is single-device, single-user, single-process,
direct-to-one-Postgres.** That shape is a deliberate decision
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:27` — "single
device has one client; HTTP API is YAGNI"). Several lenses that light up in a
distributed web service read `not yet exercised` here — and that's the correct reading,
not a gap to apologize for.

---

## 1. system-map-and-boundaries

The full map lives in `00-overview.md`. The boundaries that carry real contracts:

**The aptkit/buffr boundary — the load-bearing seam.** buffr consumes
`@rlynjb/aptkit-core@^0.4.1` and never edits it (`package.json:14`, and the
must-not-change constraint in `.aipe/project/context.md:65`). aptkit owns the contracts
(`VectorStore`, `CapabilityTraceSink`, `EmbeddingProvider`, `ModelProvider`) and the
logic (agent loop, retrieval pipeline, memory engine, evals). buffr owns the
*implementations* of those contracts plus the storage and interface. The seam is a
vertical one: control and data cross it in both directions — buffr injects a
`PgVectorStore` *down* into aptkit's pipeline (`src/session.ts:42-44`), and aptkit's
memory engine was extracted *up* out of buffr and is re-consumed
(`.aipe/project/context.md:24`). → see `02-library-as-dependency-boundary.md`.

**The store boundary.** `PgVectorStore` (`src/pg-vector-store.ts:19`) implements
aptkit's `VectorStore` exactly so it drops into `createRetrievalPipeline` with zero
agent changes. → see `01-vector-store-adapter.md`.

**The trace boundary.** `SupabaseTraceSink` (`src/supabase-trace-sink.ts:49`) implements
`CapabilityTraceSink`; aptkit's agent emits events, buffr persists them. → see
`03-trajectory-capture.md`.

**The process/DB boundary.** node-postgres `pg.Pool` (`src/db.ts:4`), direct SQL, no
HTTP indirection. One trust boundary: the `.env` `DATABASE_URL`
(`src/config.ts:11`), gitignored. **External dependencies:** Ollama on localhost
(`src/config.ts:14`) and Postgres `reindb`. Both are local/self-hosted — no third-party
cloud API in the hot path.

**Trust boundaries:** there is essentially one — the operator's own machine. `app_id`
defaults to `'laptop'` and is the *only* tenancy key, applied by convention, not
enforced (no RLS). With one user that's correct; the audit flags it under lens 8 and
lens 7 as the thing that must change before a second writer.

---

## 2. request-response-and-data-flow

The one important end-to-end flow is a chat turn. It is a waterfall with one internal
loop (the agent's tool-call cycle), not a fan-out.

```
  one chat turn — the data flow

  Ink TUI                Session              aptkit agent          Postgres
  (chat.tsx)            (session.ts)          + Ollama              (agents)
     │ onSubmit(q)          │                     │                    │
     │────────────────────►│ ask(q)              │                    │
     │                     │ persistMessage(user)│───────────────────►│ INSERT messages
     │                     │ agent.answer(q) ───►│ Gemma: tool_use?    │
     │                     │                     │ search_knowledge_   │
     │                     │                     │   base ────────────►│ cosine search
     │                     │                     │ Gemma: synthesize   │
     │                     │◄─── answer ─────────│                    │
     │                     │ trace.flush() ──────────────────────────►│ INSERT messages×N
     │                     │ memory.remember() ──────────────────────►│ upsert chunk(kind=memory)
     │◄─── answer ─────────│                    │                    │
     │ setTurns(...)       │                    │                    │
```

The order is fixed and synchronous (`src/session.ts:60-71`): persist the user turn,
run the agent to completion, *then* flush the trace, *then* best-effort remember. No
parallelism across these steps — the trace flush deliberately happens after the answer
is in hand, and memory is wrapped in try/catch so a memory failure can't lose the
answer (`src/session.ts:65-69`). The agent loop itself (Gemma deciding to call the
retrieval tool, then synthesizing) is aptkit's; buffr sees it only as `answer()`. →
see `04-long-lived-chat-session.md` for the orchestration walk.

The two one-shot CLIs (`src/cli/index-cmd.ts`, `src/cli/eval-cmd.ts`) are simpler
flows: index reads markdown → `indexDocumentRow` → pipeline.index → chunks; eval reads
a labeled set → pipeline.query → precision@k/recall@k. Both open and close a pool per
run, unlike the warm-pool chat session.

---

## 3. state-ownership-and-source-of-truth

Trace one axis — *who owns this state and where does it live* — across the layers:

| State | Lives in | Owner | Lifecycle |
| --- | --- | --- | --- |
| turn list, input, busy | Ink component (`src/cli/chat.tsx:11-13`) | the UI | ephemeral — dies with the process |
| the conversation id | session closure (`src/session.ts:55`) | the session | one per `chat` run, held across turns |
| the warm pool | session closure (`src/session.ts:39`) | the session | created once, `pool.end()` on close |
| the corpus + vectors | `agents.documents` / `agents.chunks` | Postgres (canonical) | persists across runs |
| the trajectory | `agents.messages` / `agents.conversations` | Postgres | append-only, per turn |
| the profile | `agents.profiles` | Postgres | loaded once per session (`src/session.ts:47`) |
| episodic memory | `agents.chunks` tagged `kind=memory` | Postgres, via aptkit memory engine | written per turn, recalled by similarity |

**Postgres is the single source of truth** for everything durable. There is no client
cache, no mirror, no second store to reconcile — so there is no source-of-truth
*conflict* to resolve. The interesting ownership detail: conversation memory does not
get its own table; it rides the `chunks` table
(`.aipe/project/context.md:43-45`), which is why the document_id FK had to be dropped
(memory chunks have no documents row). → see `06-retrieval-as-memory.md`.

The one piece of state aptkit's engine owns in-process is the memory `counters` map
(`packages/memory/src/conversation-memory.ts:71` in aptkit) — per-conversation id
counters. That's ephemeral and rebuilt each session; the durable ids it generates land
in Postgres.

---

## 4. caching-and-invalidation

**`not yet exercised` as an architectural layer.** There is no cache tier — no Redis,
no in-process memo of search results, no tool-run cache. The design spec named an
`agents.tool_runs` cache and deferred it explicitly as YAGNI for one device
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:131`).

The one thing that *is* cached, and worth naming precisely so it isn't mistaken for a
cache layer: the **warm `pg.Pool`** (`src/db.ts:4`, held in `src/session.ts:39`). It
caches *connections*, not results — the session reuses one pool across every turn
instead of reconnecting. That's connection pooling, not a cache with an invalidation
story. There is no staleness question because nothing memoizes query results.

Because there's no result cache, there's no invalidation strategy to audit. The HNSW
index is the closest thing to a derived structure, and pgvector keeps it current on
`upsert` — invalidation is the database's job, not the app's. → engine-level index
maintenance belongs to `study-database-systems`.

---

## 5. storage-choice-and-durability-boundaries

One datastore: **Postgres `reindb`, schema `agents`, pgvector extension**
(`sql/001_agents_schema.sql:1-2`). It exists because the project graduated an in-memory
RAG toy to durable persistence — the whole point of v1b
(`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:14`). It owns
five tables and one durability guarantee that matters: **a chat turn is durable once the
inserts commit.**

The durability boundaries, drawn precisely:

- **Corpus + vectors** (`documents`, `chunks`): durable; `upsert` runs in an explicit
  transaction with rollback (`src/pg-vector-store.ts:42-64`). The 768-dim guard throws
  *before* any write so a wrong-dimension vector never lands
  (`src/pg-vector-store.ts:32-36`, `.aipe/project/context.md:67`).
- **Trajectory** (`messages`): durable but *best-effort-ordered* — `emit()` is sync
  (aptkit's contract), writes are queued and awaited in `flush()`
  (`src/supabase-trace-sink.ts:91-93`). The event timestamp is persisted into
  `created_at` so replay order matches emit order, not the race between concurrent
  flush inserts (`src/supabase-trace-sink.ts:46-48`). → see `03-trajectory-capture.md`.
- **Memory** (`chunks` tagged): durable, but *best-effort to write* — a `remember`
  failure is swallowed so the answer the user already has is never lost
  (`src/session.ts:65-69`). The durability boundary here is asymmetric on purpose:
  the answer is the product, the memory is a bonus.

Why one Postgres and not a separate vector DB: vector and relational data are colocated
in one instance, so a single transaction and a single connection cover both — the same
colocation choice AdvntrCue made. Engine internals (HNSW build params, `<=>` operator,
MVCC on the upsert) belong to `study-database-systems`; schema shape (the soft FK, the
jsonb meta, chunk-id design) belongs to `study-data-modeling`.

---

## 6. failure-handling-and-reliability

Single-device means most distributed failure modes don't apply — there's no partial
failure across services because there's one service. What the repo *does* handle:

- **Memory-write failure is contained** (`src/session.ts:65-69`): try/catch swallows it
  so the turn still returns the answer. Named tradeoff: memory is best-effort.
- **Transaction rollback on upsert** (`src/pg-vector-store.ts:59-62`): a mid-batch
  failure rolls the whole batch back — no half-indexed document.
- **Dimension mismatch throws loudly** (`src/pg-vector-store.ts:32-36`): a wrong-size
  vector fails fast rather than silently truncating — the embedding-dimension one-way
  door, named not hidden (`.aipe/project/context.md:67`).
- **Per-turn error surfacing in the UI** (`src/cli/chat.tsx:30-32`): a failed
  `session.ask` renders as an error turn instead of crashing the TUI.
- **Missing config fails fast** (`src/session.ts:37`, `src/migrate.ts:26`): no
  `DATABASE_URL` throws at startup, not mid-run.

What is **`not yet exercised`:** retries with backoff, request timeouts, circuit
breakers, graceful degradation when Ollama is down, offline behavior, health checks.
If Ollama is unreachable the agent call simply throws and surfaces as an error turn —
there's no fallback chain wired here (aptkit *has* a `provider-fallback` pattern; buffr
doesn't compose it). The trace sink's queued-writes model has no retry: if a flush
insert fails, `Promise.all` rejects and that turn's trajectory is incomplete. For one
local user these are acceptable; coordination-under-partial-failure mechanics belong to
`study-distributed-systems` and become real only when the phone brain lands.

---

## 7. scale-bottlenecks-and-evolution

What breaks first, in order:

**At 10x corpus (≈10k+ chunks):** HNSW recall and index build time degrade with default
`m` / `ef_construction` — flagged as the batch-reindex threshold in both plans
(`agent-layer-plan.md:105`,
`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:197`).
Synchronous per-document indexing (`src/runtime.ts:17`) also starts to hurt; the plan
says batch reindex past that point.

**At a second writer (app #2 or the phone):** the `app_id`-by-convention isolation
breaks. RLS is deferred (`sql` has no policies), and `app_id` is set by buffr, not
derived from a token. The graduation spec calls this a hard prerequisite before a
second app writes (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md:193`).

**At a second device (the two-brain body):** one memory plane shared by two brains
becomes a sync/merge problem — the canonical-local-with-cloud-mirror pattern again
(`docs/superpowers/specs/2026-06-19-aptkit-packages-design.md:73`). This is the change
that would force the most rearchitecture, and it's deliberately the *second* thing to
solve, not the first.

**What stays stable across all of these:** the `VectorStore` contract. Swapping the
in-memory store for pgvector required zero agent changes; swapping pgvector for an
Edge-Function-backed store later is the same move. The contract is the evolution
insurance. → see `07-deferred-body.md` for what's gated and what won't have to change.

**What does NOT scale by adding machines:** nothing here is horizontally scalable today
because nothing is stateless-behind-a-load-balancer. The chat session is a single
stateful process. That's correct for one user; it's the first thing that would change
for many.

---

## 8. system-design-red-flags-audit

Ranked by architectural risk. Each is grounded; none is a surprise — the plans named
most of them as deliberate, deferred tradeoffs.

1. **`app_id` isolation is by convention, not enforced** (no RLS;
   `sql/001_agents_schema.sql` has no policies, `app_id` set in app code at
   `src/pg-vector-store.ts:27`). Correct for one user; a **hard one-way risk** the
   moment a second tenant writes. The spec already gates it
   (`...graduation-design.md:193`). Highest risk because it's a data-isolation
   boundary that looks present (the column exists) but isn't enforced.

2. **No timeouts / retries / fallback on the model + DB calls** (lens 6). A hung Ollama
   or a flaky connection stalls or fails the turn with no recovery. Low impact at one
   local user; would be the first reliability gap to close before any remote use.

3. **Trajectory completeness depends on `flush()` succeeding** (`src/supabase-trace-sink.ts:91`).
   `Promise.all` over queued inserts means one failed insert leaves that turn's
   trajectory partial, and there's no retry. Since the trajectory is the *portfolio
   artifact* (the whole "capture now so fine-tuning is answerable later" thesis,
   `agent-layer-plan.md:17`), partial capture is more costly here than it looks.

4. **Synchronous per-document indexing** (`src/runtime.ts:17`) — fine for a hand-loaded
   corpus, a bottleneck past ~10k chunks. Already flagged for batch reindex.

5. **Memory recall over-fetches then filters in-process** (aptkit
   `conversation-memory.ts:94`, driven by buffr sharing the store). The `VectorStore`
   contract has no metadata filter, so recall fetches `max(k*4, 20)` and filters by
   `kind` in JS. Cheap now; a real cost at large corpora where memory rows are sparse
   among documents. This is a consequence of the shared-store choice in
   `06-retrieval-as-memory.md`.

Not a red flag, called out to prevent a false one: the **dropped FK** on
`chunks.document_id` (`sql/001_agents_schema.sql:26-27`) looks like a missing integrity
constraint but is a *deliberate* drop to preserve `VectorStore` drop-in parity
(`...graduation-design.md:204`). It's a documented tradeoff, not an oversight. →
`01-vector-store-adapter.md`.

---

## `not yet exercised` — the honest inventory

Named so the map doesn't pretend to infrastructure that isn't there:

- **caching** — no result cache or tool-run cache (lens 4); only connection pooling.
- **retries / timeouts / circuit breakers** — none on model or DB calls (lens 6).
- **horizontal scale / load balancing** — single stateful process, not behind an LB (lens 7).
- **multi-region / replication** — one Postgres instance, one region (lens 5/7).
- **HTTP gateway / API layer** — direct `pg`, no Edge Functions this phase (lens 1).
- **enforced RLS / multi-tenant isolation** — `app_id` by convention only (lens 8).
- **multi-device sync** — the two-brain memory merge is deferred (lens 7; `07-deferred-body.md`).
- **fine-tuning** — the ceiling, gated on Phase-4 evidence (`agent-layer-plan.md:19`).
