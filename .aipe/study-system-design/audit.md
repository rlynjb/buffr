# System-Design Audit — buffr-laptop

Pass 1 of the two-pass audit. Eight lenses, walked in order against the real code. Each lens
names what the repo *actually does* with `file:line` grounding, or says `not yet exercised`
plainly. Significant findings cross-link to a Pass-2 pattern file for the deep walk.

Evidence base: `src/*` (10 files), `sql/001_agents_schema.sql`, the two design specs under
`docs/superpowers/specs/`, and `agent-layer-plan.md`. Observed behavior is grounded in code;
production/scale claims are labelled as inference.

---

## 1. System map and boundaries

Three trust/ownership bands, and the load-bearing boundary sits in the middle.

```
  buffr code  ──►  aptkit-core (library)  ──►  buffr adapters  ──►  Postgres + Ollama
  (owns)           (consumed, never edited)    (owns)               (external deps)
```

**Major components and what they own:**
- `src/cli/chat.tsx:9-60` — the Ink UI. Owns only screen state; delegates all work to the session.
- `src/session.ts:34-76` — `createChatSession()`. The orchestrator. Owns the warm pool, the
  one conversation id, and the wiring of every aptkit piece to every buffr adapter.
- `src/pg-vector-store.ts:19-86` — `PgVectorStore implements VectorStore`. The adapter behind
  the storage port. → see `01-vector-store-adapter.md`.
- `src/supabase-trace-sink.ts:49-94` — `SupabaseTraceSink implements CapabilityTraceSink`. The
  adapter behind the observability port. → see `03-trajectory-capture.md`.
- `src/runtime.ts:5-18` — `indexDocumentRow`. The index path's document-row-then-chunks step.
- `src/profile.ts:4-8`, `src/config.ts:9-16`, `src/db.ts:4-6`, `src/migrate.ts` — profile read,
  pure config, pool factory, transactional migration runner.

**Trust boundaries:**
- **The aptkit boundary** is the one that matters (`session.ts:2-6` imports; nothing in `src/`
  reaches into aptkit internals). Stated as a hard constraint in `context.md` ("aptkit is
  consumed, never edited here") and enforced structurally — buffr only implements aptkit's
  *contracts* (`VectorStore`, `CapabilityTraceSink`, `ModelProvider` via Gemma). → `04-library-as-dependency-boundary.md`.
- **The single-user trust boundary is by convention, not enforcement.** Every table carries
  `app_id` (`sql/001:6,17,34` etc.) defaulting `'laptop'`, but there is **no RLS** — isolation
  is cooperative. The graduation spec names this exactly: "isolation is by convention only
  until app #2" (`...graduation-design.md:193-195`).
- **Secrets boundary:** `DATABASE_URL` / Ollama host come from `.env` via `dotenv` (`session.ts:35`,
  `config.ts:9-16`); `.env` is gitignored. No secret is in code.

**External dependencies:** Postgres `reindb` (over `pg`), Ollama at `localhost:11434` (two
models). Both are local/self-hosted — there is no third-party cloud API in the hot path.

---

## 2. Request / response and data flow

There is no HTTP request — the "request" is `session.ask(question)`, an in-process call. Three
end-to-end flows exist; the ask flow is the interesting one.

**The ask flow (the hot path), `session.ts:60-71`:**

```
  chat.tsx onSubmit
    └─► session.ask(q)
         1. persistMessage(user)            ── one INSERT into agents.messages
         2. agent.answer(q)                 ── aptkit loop:
              model → wants search_knowledge_base
              → tool: pipeline.query → embed(q) → PgVectorStore.search (cosine) → rank
              → model → final answer
              (every step emits a CapabilityEvent into SupabaseTraceSink, queued)
         3. trace.flush()                   ── awaits all queued event INSERTs
         4. memory.remember({q, answer})    ── embed exchange → upsert as a memory chunk
                                               (best-effort; failure is swallowed)
         return answer
```

This is a **sequential waterfall**, deliberately: persist-before-answer means the user turn
survives a crash mid-generation; flush-before-remember means the trajectory is durable before
the best-effort memory write. The one place work could parallelize — the per-event INSERTs —
is itself made concurrent by the sink queuing promises and `flush()` awaiting them all at once
(`supabase-trace-sink.ts:87-93`). → `03-trajectory-capture.md`, `05-long-lived-chat-session.md`.

**The index flow, `index-cmd.ts:22-26` → `runtime.ts:5-18`:** read file → write `documents`
row → `pipeline.index` chunks+embeds+upserts. Document row first, chunks second — the source-of-
truth row is the CLI's job, the chunk rows are the store's. → `02-retrieval-pipeline.md`.

**The eval flow, `eval-cmd.ts:24-33`:** for each labeled query, `pipeline.query` → dedupe to
docIds → `scorePrecisionAtK` / `scoreRecallAtK`. Pure measurement, no agent, no persistence.

---

## 3. State ownership and source of truth

One question, traced down the layers: **who owns this state, and is it the truth or a copy?**

```
  state                     owner                  truth or copy?
  ───────────────────────   ────────────────────   ──────────────────────────
  screen turns / input      chat.tsx useState      ephemeral view state
  the conversation id       session.ts (closure)   the session's identity
  the agent instance        session.ts (closure)   built once, reused per turn
  corpus documents          agents.documents       SOURCE OF TRUTH
  chunks + embeddings       agents.chunks          DERIVED from documents (re-embeddable)
  conversation memory       agents.chunks(kind=mem) DERIVED from messages
  full trajectory           agents.messages        SOURCE OF TRUTH (replayable)
  user profile              agents.profiles        SOURCE OF TRUTH
```

The sharp call: **Postgres is the single source of truth for everything durable.** There is no
second store to reconcile (the laptop+phone two-store sync problem is deferred —
`aptkit-packages-design.md:69-74`). `chunks` is *derived* — the soft-link `document_id` and the
`embedding_model` column (`sql/001:16,23`) exist precisely so the corpus can be re-embedded
without losing the source. The conversation id lives in a closure (`session.ts:55`) and is the
only piece of session-scoped mutable state; everything else is either screen-ephemeral or durable.

The honest wrinkle, noted in `session.ts:25-28`: there is **no in-prompt turn history** —
`RagQueryAgent.answer()` treats each question independently. Continuity comes from
*retrieval-based* memory (relevant past exchanges resurface as chunks), not from a growing
message array in the prompt. That's a state-ownership choice: conversational memory is owned by
the vector store, not by the prompt window. → `04-library-as-dependency-boundary.md`.

---

## 4. Caching and invalidation

`not yet exercised` — and named-deferred, not missing by accident.

The `agents.tool_runs` cache is explicitly deferred in both specs ("YAGNI for a single device",
`...graduation-design.md:131`; deferred in `aptkit-packages-design.md:348`). There is no response
cache, no embedding cache, no query-result cache. Every ask re-embeds the query and re-runs the
cosine search.

The one thing that *resembles* a cache — conversation memory riding on `chunks` — is not a cache:
it has no invalidation, no TTL, no staleness contract; it's an append-only episodic store. The
specs flag conversation retention (TTL / keep-N) as an open question (`agent-layer-plan.md:118`),
which is the invalidation decision deferred to when growth becomes a cost.

At 10x corpus this stays fine; the first cache that would earn its place is an embedding cache on
re-index, since re-embedding the whole corpus on a model swap (`...graduation-design.md` reindex
note) is the named expensive operation.

---

## 5. Storage choice and durability boundaries

One datastore, chosen deliberately: **Postgres with the `pgvector` extension**, so the vector
index and the relational data live in **one instance** (`context.md`; matches the AdvntrCue shape
in `me.md`'s portfolio — "vector + relational data colocated, one Postgres instance").

**Why one store, what it owns:** colocating vectors and rows means a retrieval hit and its
citation metadata come from the same query (`pg-vector-store.ts:70-85` returns score *and*
content/docId in one round-trip) — no join across a separate vector DB, no consistency gap
between "the chunk exists" and "the embedding exists."

**Durability boundaries that are actually coded:**
- `upsert` wraps all chunk inserts in `begin`/`commit` with `rollback` on error
  (`pg-vector-store.ts:40-64`) — a partial multi-chunk index is impossible.
- `migrate.ts:8-20` runs the whole schema script in one transaction — all-or-nothing migration.
- The trace sink takes the opposite, deliberate stance: each event is its own INSERT, queued and
  flushed, **not** transactional (`supabase-trace-sink.ts:53-93`) — losing one trajectory event
  must not roll back the others. Durability granularity is per-event, by design.
- `embedding vector(768) not null` (`sql/001:24`) + the assert in `pg-vector-store.ts:32-36` make
  a dimension mismatch a loud throw, never a silent truncate — the 768-dim one-way door is
  guarded at the storage edge.

Engine internals (how HNSW indexes, how `<=>` executes, MVCC durability of the commit) → cross-link
`study-database-systems`. Schema shape (the soft FK, the jsonb meta) → `study-data-modeling`.

---

## 6. Failure handling and reliability

Single device, so most distributed-failure concerns don't apply — but the repo makes three
real reliability calls.

**1. Best-effort memory.** `session.ts:64-69` wraps `memory.remember` in try/catch and swallows:
"a memory-write failure must not lose the answer the user has." The answer is already returned;
memory is downstream and optional. This is graceful degradation at the right granularity.

**2. Crash-survivable turns.** Persist the user message *before* running the agent
(`session.ts:61-62`) and flush the trajectory *before* the best-effort memory write
(`session.ts:63-66`). If generation crashes, the user turn is already a row. Ordering is the
reliability mechanism.

**3. UI-level error containment.** `chat.tsx:30-32` catches any `session.ask` rejection and
renders it as a buffr turn rather than crashing the TUI. The session stays alive for the next
question.

**`not yet exercised`:** retries, timeouts, and backoff against Ollama or Postgres. There is no
retry on a failed embed, no timeout on `agent.answer`, no circuit breaker. The `pg.Pool`
(`db.ts:4-6`) gives connection reuse but no configured statement timeout. For a single local user
this is acceptable; the moment Ollama is remote or Postgres is Supabase-cloud, timeouts become the
first gap. Coordination mechanics (partial failure across services) → cross-link
`study-distributed-systems` — but honestly, this repo has no cross-service coordination to fail.

---

## 7. Scale, bottlenecks, and evolution

What breaks first, what stays stable, what forces a rearchitecture.

**Stable to 10x–100x corpus:** the `VectorStore` port and the cosine query. HNSW handles growing
chunk counts; the `app_id` index (`sql/001:30`) keeps the scan scoped. The graduation spec already
names the threshold — "batch reindex past ~10k chunks" (`agent-layer-plan.md`) — so the bottleneck
is *known*, not discovered.

**Breaks first under concurrency:** nothing in this repo is built for concurrent users. The
integration tests run `--test-concurrency=1` because they share one DB and `app_id='test'`
(`...graduation-design.md:213-215`) — that's a tell. One conversation, one pool, one user is baked
into `session.ts`. Two users would need RLS (the `app_id` columns are already there, the *policies*
are not) — a one-migration change the schema was pre-shaped for (`...graduation-design.md:28-29`).

**The change that forces a rearchitecture:** the **two-brain body** (laptop + phone). The moment a
second device writes the same memory, the single-source-of-truth model in lens 3 becomes a
sync/merge problem — explicitly the deferred "canonical-local-with-cloud-mirror" pattern
(`aptkit-packages-design.md:69-74`). The direct-`pg` access path also flips: a phone can't open a
raw pg connection, so the deferred Edge Function / HTTP layer (`...graduation-design.md:55-63`)
arrives with it. Both are named one-way doors, not surprises.

**Cheap evolutions the design pre-paid for:** swap the embedder (the `embedding_model` column +
reindex op), swap the vector store (the port), add an app (the `app_id` columns), add the HTTP
layer (same SQL behind it). The forward-compat columns in `sql/001` are the bet that these stay
migration-free.

---

## 8. System-design red-flags audit

Ranked by architectural risk, each grounded in evidence. The honest framing: most of these are
*deliberately-accepted* tradeoffs for a single-user learning project, not accidents.

1. **Convention-only tenant isolation (medium, accepted).** `app_id` everywhere but no RLS
   (`sql/001`, no policy statements). Correct for one user; a hard prerequisite before app #2
   writes (`...graduation-design.md:193-195`). The risk is forgetting it's convention-only when
   the second writer arrives.

2. **No timeouts on external calls (medium).** Neither Ollama nor pg calls have a timeout
   (`session.ts`, `db.ts:4-6`). A hung Ollama hangs the turn with no upper bound. Lowest-effort,
   highest-value hardening when the model server goes remote.

3. **Best-effort memory hides failures silently (low, accepted).** `session.ts:67-68` swallows
   the error with no log. The right call for not losing the answer, but a silent catch means a
   systematically-failing memory write is invisible. A one-line warn would close it. Observability
   detail → cross-link `study-debugging-observability`.

4. **Soft-link `document_id` trades integrity for parity (low, accepted and documented).** The FK
   is deliberately dropped (`sql/001:26-27`, `pg-vector-store.ts` writes a possibly-null docId) to
   keep drop-in parity with aptkit's in-memory store. A chunk can outlive/precede its document row.
   Documented as an as-built deviation (`...graduation-design.md:199-208`). Schema-integrity
   detail → cross-link `study-data-modeling`.

5. **`session.ts` is the single wiring choke point (low).** Every component is hand-wired in one
   function (`session.ts:34-58`). Fine at this size; the place that grows complex first if the body
   expands. Not a problem yet — flagged so it's watched.

**`not yet exercised` (named so the audit is honest, not padded):** caching/invalidation, retries
and timeouts, horizontal scale, multi-region, an API gateway, enforced RLS, queue/streaming
infrastructure, fine-tuning. Each is deferred *on purpose* in the design specs, not absent by
oversight.
