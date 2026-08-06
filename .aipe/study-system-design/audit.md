# System-Design Audit — buffr-laptop

Pass 1 of the two-pass audit. Eight lenses, walked in order against the real code. Each lens
names what the repo *actually does* with `file:line` grounding, or says `not yet exercised`
plainly. Significant findings cross-link to a Pass-2 pattern file for the deep walk.

Evidence base: `src/*` (~20 files, incl. new `src/cli/research-flow.ts`, `src/cli/review-flow.ts`,
`src/cli/parse-review-date.ts`, `src/pg-journal-store.ts`), `sql/001_agents_schema.sql`,
`sql/002_decision_journal.sql`, the design specs under `docs/superpowers/specs/` and
`docs/superpowers/plans/`, `agent-layer-plan.md`, and the monorepo packages:
`packages/capabilities/`, `packages/kernel/src/journal/`, `packages/domain-packs/{investing,market-research}/`,
`packages/engines/{investing,market-research}/`. Observed behavior is grounded in code;
production/scale claims are labelled as inference. Re-walked in full against commits
`dffe49d..HEAD` (33 commits: the market-research engine, the decision-journal subsystem, the
live progress panel, and a 5-bug integration-seam fix pass).

---

## 1. System map and boundaries

Three trust/ownership bands, and the load-bearing boundary sits in the middle — unchanged in
shape since the last audit, but now with two engines and a journal port crossing it instead of
one engine.

```
  buffr code  ──►  @buffr/kernel (monorepo pkg)  ──►  buffr adapters  ──►  Postgres + Ollama
  (owns)           packages/kernel/, consumed          (owns)               (external deps)
                   never edited at root level
```

**Major components and what they own:**
- `src/cli/chat.tsx:1-474` — the OpenTUI UI. Owns screen state (turns, busy, `activeFlow`,
  `progressSteps`) and delegates all work to the session or to an active flow's `controller`.
- `src/cli/research-flow.ts:73-161` — `createResearchFlow()`. Owns the predict→reveal→promote
  state machine's local closure state (`step`, `collected`, `output`, `prediction`, `stake`,
  `resolutionCondition`) for exactly one `/research` invocation. → `09-predict-then-reveal-loop.md`.
- `src/cli/review-flow.ts:33-111` — `createReviewFlow()`. Owns the due-decisions list, the
  current index, and the resolve-in-progress state for exactly one `/review` invocation.
  → `09-predict-then-reveal-loop.md`.
- `src/session.ts:394-883` — `createChatSession()`. The orchestrator. Owns the warm pool, the
  one conversation id, both engines (`investingEngine`, `researchEngine`), the `journalStore`,
  and the wiring of every aptkit piece to every buffr adapter.
- `src/pg-vector-store.ts:19-86` — `PgVectorStore implements VectorStore`. The adapter behind
  the storage port. → `01-vector-store-adapter.md`.
- `src/supabase-trace-sink.ts:49-94` — `SupabaseTraceSink implements CapabilityTraceSink`. The
  adapter behind the observability port. → `03-trajectory-capture.md`.
- `src/pg-journal-store.ts:41-117` — `PgJournalStore implements JournalStore`. The adapter
  behind the decision-journal port, scoped by `app_id` on every method. → `09-predict-then-reveal-loop.md`.
- `src/runtime.ts:5-18` — `indexDocumentRow`. The index path's document-row-then-chunks step.
- `src/profile.ts:4-8`, `src/config.ts:9-16`, `src/db.ts:4-6`, `src/migrate.ts` — profile read,
  pure config, pool factory, transactional migration runner (now runs every file in `sql/` in
  order, not just one — `src/migrate.ts:8-20`).

**Trust boundaries:**
- **The @buffr/kernel boundary** is still the one that matters. `session.ts` imports from
  `@buffr/kernel`, `@buffr/connectors`, `@buffr/capabilities`, `@buffr/contracts`,
  `@buffr/domain-pack-investing`, `@buffr/domain-pack-market-research`, `@buffr/engine-investing`,
  and `@buffr/engine-market-research` — nothing in `src/` reaches into `packages/` internals
  directly. Build order is now `contracts → kernel → connectors → capabilities → domain-packs →
  engines` (`context.md`). Root `src/` implements kernel's *contracts* (`VectorStore`,
  `CapabilityTraceSink`, `JournalStore` — the newest one). → `04-library-as-dependency-boundary.md`.
- **The single-user trust boundary is by convention, not enforcement — and this widened, not
  narrowed, with the journal.** Every table carries `app_id` (`sql/001`, `sql/002:3`), and the
  new `agents.decisions` table adds `user_id`/`workspace_id` columns too (`sql/002:5-6`) — but
  `session.ts` populates both of those from the same single value, `cfg.appId`, on every call
  (`session.ts:747-756,769-782,785-789`). The columns exist for a multi-user future; nothing
  today enforces that two different users could safely share one process. No RLS, still.
- **Secrets boundary:** `DATABASE_URL` / Ollama host / discovery-API keys come from `.env` via
  `dotenv` (`session.ts:395`, `config.ts:9-16`); `.env` is gitignored. No secret is in code.

**External dependencies:** Postgres `reindb` (over `pg`), Ollama at `localhost:11434` (two
models). Five discovery/search APIs now, up from three: Google Custom Search, Brave, Tavily
(all key-gated), plus two unauthenticated ones added this cycle — Reddit search
(`RedditSearchConnector`, `packages/connectors/src/discovery/reddit-search.ts`, hits
`reddit.com/.../search.json`, "frequently 403s outright" per `session.ts:187-188`'s own comment)
and Google Trends (`GoogleTrendsConnector`, scrapes an unofficial endpoint, now guarded against
an HTML-instead-of-JSON response — `search-trends.ts`). Every discovery API is wrapped in
`CachedConnector` (1-hour TTL, `session.ts:132`) before being handed to either engine.

---

## 2. Request / response and data flow

There is no HTTP request — the "request" is a session method call, in-process. Flow count has
grown from 5 to 8: the two indexers, `ask`, `eval`, `/investing`, `/eval investing`,
`/eval research`, and the two new multi-turn flows, `/research` and `/review`.

**The ask flow (unchanged in shape), `session.ts:668-692`:** persist user msg → `agent.answer()`
loop (tool calls emit `CapabilityEvent`s) → flush trace → best-effort `memory.remember()`.
Sequential waterfall, deliberately: persist-before-answer, flush-before-remember. →
`03-trajectory-capture.md`, `05-long-lived-chat-session.md`.

**The `/research` flow is the new interesting one — a two-phase engine call wrapped in a
5-step CLI state machine**, `research-flow.ts:73-161` calling `session.researchCollect()` /
`session.researchEvaluate()` (`session.ts:713-744`), which call
`MarketResearchEngine.collect()` / `.evaluate()` (`packages/engines/market-research/src/engine.ts:56-237`).
Unlike every other flow in this repo, this one pauses mid-pipeline for a human input (a
prediction) that the engine's type signature requires before the second phase can run at all.
→ full walk in `09-predict-then-reveal-loop.md`, engine-internals walk in
`08-domain-pack-and-engine.md`.

**The `/review` flow**, `review-flow.ts:33-111` calling `session.listDueReviews()` →
`journalStore.listDue()` (`pg-journal-store.ts:86-100`), which performs an `UPDATE` (flip
`open`→`review-due` for anything past its `review_at`) *before* the `SELECT` that returns the
due set — a read endpoint with a write side effect, documented as a required-identical-behavior
contract on both adapters (`contracts.ts:61-66`). → `09-predict-then-reveal-loop.md`.

**A new cross-layer contract this cycle: `ProgressEvent`.** Both engines can now emit a typed
progress-event stream (`packages/engines/market-research/src/types.ts:18-24`:
`engine-start`/`connector-start`/`connector-done`/`connector-failed`/`stage-start`/`stage-done`)
through an optional `onProgress` callback threaded engine → session (`session.ts:723,740`) →
flow (`research-flow.ts` forwards `callbacks.onProgress`) → `chat.tsx`'s `updateProgressSteps()`
(`chat.tsx:146-152,270-291`), which renders it live as a `ProgressPanel` (`chat.tsx:86-119`).
This is a genuine new system-level seam — not a UI-only concern — because it changes the engine's
public contract (a new optional parameter on `collect()`/`evaluate()`'s options) purely to serve
a rendering need three layers up. The rendering mechanics themselves (React state, spinner
frames) are `study-frontend-engineering`'s territory; the contract crossing the engine boundary
is this guide's.

**The eval flows, `session.ts:693-711,797-810`:** `evalInvesting()` and the new `evalResearch()`
both load JSON fixtures and run `Scorer.execute()` against them — pure measurement, no LLM,
no persistence, no change in shape from the investing original.

---

## 3. State ownership and source of truth

One question, traced down the layers: **who owns this state, and is it the truth or a copy?**
The table grows by one durable row and one new *kind* of ephemeral state (multi-step flow state).

```
  state                     owner                  truth or copy?
  ───────────────────────   ────────────────────   ──────────────────────────
  screen turns / input      chat.tsx useState       ephemeral view state
  activeFlow controller     chat.tsx useState        ephemeral — one flow instance, GCed on done
  the research/review       flow closure (step,      ephemeral — lost if the CLI exits mid-flow;
  flow's in-progress state  collected, prediction…)  nothing is written until promote/resolve
  the conversation id       session.ts (closure)     the session's identity
  the agent + both engines  session.ts (closure)     built once, reused per turn/analysis
  corpus documents          agents.documents         SOURCE OF TRUTH
  chunks + embeddings       agents.chunks            DERIVED from documents (re-embeddable)
  conversation memory       agents.chunks(kind=mem)  DERIVED from messages
  full trajectory           agents.messages          SOURCE OF TRUTH (replayable)
  user profile              agents.profiles          SOURCE OF TRUTH
  decisions (predictions,   agents.decisions          SOURCE OF TRUTH — written only on
  assessments, review state)                         explicit user promotion, never auto-saved
```

The sharp call, unchanged: **Postgres is still the single source of truth for everything
durable**, and the new `decisions` table doesn't change that — it's one more table in the same
schema, not a second store. The new wrinkle worth naming: **a `/research` run's evidence and
prediction are ephemeral by default.** Nothing is written to `agents.decisions` unless the user
explicitly chooses `hypothesis` or `decision` at the promote step (`research-flow.ts:110-126`);
`discard` (or simply closing the CLI mid-flow) leaves zero trace. This is a deliberate
state-ownership choice — the *evaluation* is cheap and repeatable (re-run `/research`), so
nothing forces persistence until the user decides the result is worth tracking. Compare this to
the `ask` flow, where every turn is persisted unconditionally (`session.ts:674`) — two different
durability defaults in the same codebase, both intentional: chat history is assumed worth
keeping, a research digest is not.

The `userId`/`workspaceId` split inside `JournalEntry` (`journal/contracts.ts:17-39`) is schema
that anticipates multi-user before the rest of the system does — see lens 1's trust-boundary
note and lens 7's scale discussion.

---

## 4. Caching and invalidation

Two caching layers exist now (was one), both in-process and both still deliberately far from a
distributed cache.

**Connector-result cache, `CachedConnector` + `InMemoryCache`, 1-hour TTL
(`CONNECTOR_CACHE_TTL_MS`, `session.ts:132`).** Every discovery connector (RSS, Trends, Amazon,
Brave, Tavily, Google, Reddit) is wrapped before being handed to either engine or the chat
agent's tools. This is new since the last audit and closes a real gap the previous cycle's
"not yet exercised" section named: repeated `/research` or `/investing` calls for the same topic
within an hour now hit cache instead of re-fetching. No invalidation beyond TTL expiry — a
stale-for-up-to-an-hour tradeoff, accepted for a research/discovery use case where freshness to
the minute doesn't matter.

**Trending-topic-suggestion cache, `topicSuggestionCache`, 15-minute TTL
(`TOPIC_SUGGESTION_CACHE_TTL_MS`, `session.ts:183`).** A separate, shorter-lived cache for
`suggestResearchTopics()` — the "no topic given" fallback for `/research`. Kept apart from the
connector cache because it caches a *derived, ranked* result (top Reddit/search hits), not raw
connector output.

**The embedding cache** (`CachedEmbeddingProvider` + `InMemoryCache`, session-lifetime, no TTL,
`session.ts:403-407`) is unchanged from last cycle — same-text-same-vector means zero
staleness risk within a session.

**Still `not yet exercised`:** a response cache, a query-result cache against Postgres, or any
cache that survives a process restart. The `agents.tool_runs` cache remains explicitly deferred
per the design specs. At 10x usage, the next cache that earns its place is the same one named
last cycle — an embedding cache that survives a restart (for re-index-on-model-swap) — plus,
new this cycle, persisting the connector cache past process exit, since `/research` and
`/investing` are now the highest-latency, highest-external-call-volume flows in the system.

---

## 5. Storage choice and durability boundaries

Still one datastore, Postgres with `pgvector`, and the new `agents.decisions` table joins it
rather than spinning up a second store — consistent with the standing "one Postgres instance"
decision (`context.md`; the AdvntrCue shape in `me.md`'s portfolio).

**Durability boundaries that are actually coded, including the new table:**
- `upsert` wraps all chunk inserts in `begin`/`commit` with `rollback` on error
  (`pg-vector-store.ts:40-64`) — unchanged.
- `migrate.ts` now runs **every** migration file in `sql/` in order, not just one
  (`src/migrate.ts:8-20`, exercised by `002_decision_journal.sql` landing after `001`) — each
  file's statements still run inside its own transaction, all-or-nothing per file.
- The trace sink is still non-transactional per-event by design (`supabase-trace-sink.ts:53-93`).
- `embedding vector(768) not null` + the dimension assert remain the guarded one-way door
  (`sql/001:24`, `pg-vector-store.ts:32-36`).
- **New: `agents.decisions`'s numeric/text columns are all nullable except the identity and
  `kind`/`claim`/`created_at`/`status` fields** (`sql/002:1-25`) — `stake`, `resolution_condition`,
  `review_at`, and all four predicted/assessed numeric fields are `null` for `kind='hypothesis'`
  rows by design (`pg-journal-store.ts:61-66` passes explicit `null`s), and populated only for
  `kind='decision'` rows. This is the same pattern as `chunks.document_id`'s soft link — a
  single table doing double duty for two record shapes via nullable columns rather than two
  tables, traded for simplicity at the cost of the CHECK constraint (`sql/002:9`) being the only
  thing enforcing the shape instead of the schema itself.
- **New: the `open → review-due` transition is a plain `UPDATE`, not a trigger or a scheduled
  job** (`pg-journal-store.ts:86-92`) — durability of that transition depends entirely on
  `/review` being invoked; there is no background sweep. A decision whose review date passes
  and is never checked simply sits in `open` state forever, technically overdue but never
  surfaced. This is a real gap, not a deliberate one — see lens 8.

Engine internals and schema-shape detail cross-link unchanged to `study-database-systems` and
`study-data-modeling`.

---

## 6. Failure handling and reliability

Single device, so most distributed-failure concerns still don't apply — but two new reliability
calls were made this cycle, plus one bug-fix pass worth reading as a case study.

**1. Best-effort memory (unchanged).** `session.ts:686-690` swallows a `memory.remember()`
failure so a memory-write bug can't lose an already-returned answer.

**2. Crash-survivable turns (unchanged).** Persist-before-answer, flush-before-remember.

**3. UI-level error containment, now covering flows too.** `chat.tsx` catches rejections from
`session.ask`, `activeFlow.controller.submit()`, and `controller.start()` for both new flows
(`chat.tsx:184-188,207-211`) — a rejection inside `/research` or `/review` surfaces as an error
turn and resets `activeFlow` to `null` rather than leaving the CLI stuck mid-flow or crashing it.

**4. New: startup-failure containment.** `initialDueCount = await session.dueReviewCount().catch(() => 0)`
(`chat.tsx:457`) — a fresh database with no `decisions` table yet, or a transient connection
hiccup, degrades to "0 due" instead of crashing the CLI before the first render. This closed a
real gap (`41ecce8`): before the fix, a brand-new install would crash on startup.

**5. New: degradation inside the engine when the model returns nothing usable.**
`MarketResearchEngine.evaluate()` guards the case where `Analyzer` returns zero findings —
`strongestFinding` becomes `null` instead of crashing on an empty-array `.reduce()`, and the
comparison degrades to `dimensionMatched: false, actualDimension: 'unknown'` (`engine.ts:199-208`,
fixed in `41ecce8`, tested in `engine.test.ts`'s "zero findings" case). This mirrors the
keyProblems/productAngles/explanation fallback pattern already in the same function
(`engine.ts:185-194`) — the file's established defensive style, applied consistently to a case
that was missed on first pass.

**6. Discovery-API failure handling, still not exercised for retries/timeouts but now covers
more surface.** Reddit search and Google Trends were added without any special-casing beyond
what the `Collector` capability already does for every `optional` source
(`packages/capabilities/src/collector/index.ts:35-52`: `Promise.all` per source, a failure in
an optional source becomes a `FailedSource` entry, not a thrown error). Google Trends specifically
gained an HTML-response guard (`search-trends.ts`) — the unofficial endpoint sometimes returns
an HTML error page instead of JSON, and that's now detected and turned into a clean failure
rather than a JSON-parse crash.

**`not yet exercised`, unchanged from last cycle:** retries, timeouts, and backoff against
Ollama, Postgres, or any discovery API; no statement timeout on the pool; no automatic fallback
between web-search providers (Google → Brave → Tavily). Coordination mechanics cross-link
`study-distributed-systems`.

**Case study — the `41ecce8` bug-fix commit as evidence of what an unenforced contract costs.**
Five bugs, closed in one pass after a whole-branch review, four of which are integration-seam
bugs specifically (not internal logic bugs): the empty-input guard in `chat.tsx` blocked
`review-flow`'s legitimate blank-note answer; the startup crash above; the engine's empty-findings
crash above; and — the most instructive one — `InMemoryJournalStore.listDue()` performed its
`open → review-due` side effect **without** scoping by `userId`/`workspaceId`, while
`PgJournalStore.listDue()` always had. The `JournalStore` contract's own doc comment
(`contracts.ts:61-66`) states "both implementations must do this identically" — but nothing in
TypeScript's type system enforces that two adapters behind one interface actually agree on a
side effect neither method signature mentions. The fix added the missing scoping *and* a
regression test asserting a `listDue()` call for one user/workspace cannot flip another's
decision to due (`journal.test.ts`). The lesson for the audit: a port's doc comment is a promise,
not a guarantee — the only thing that turns "both implementations must do this identically" into
something enforced is a shared test run against every adapter, and this repo didn't have one
until the bug was found. → `09-predict-then-reveal-loop.md`'s Interview defense walks this same
bug from the pattern's point of view.

---

## 7. Scale, bottlenecks, and evolution

What breaks first, what stays stable, what forces a rearchitecture — largely unchanged from
last cycle, with the journal adding one new dimension.

**Stable to 10x–100x corpus (unchanged):** the `VectorStore` port and cosine query, HNSW,
`app_id` scoping.

**Breaks first under concurrency (unchanged, and now doubly true):** nothing in this repo is
built for concurrent users, and the new `agents.decisions` table inherits the same limitation
one level deeper — `JournalEntry.userId`/`workspaceId` exist as columns specifically to make a
future multi-user journal possible, but `session.ts` populates both from the single `cfg.appId`
value everywhere it calls `journalStore.*` (lens 1, lens 3). Two users sharing this process
today would not just share a knowledge base (the known limitation) but would also share and
silently corrupt each other's decision journal — a new, more sensitive instance of the same
gap, because `41ecce8`'s bug shows exactly how easy it is to get the scoping wrong even when it
IS supposed to be there.

**New scale question: the missing review-date sweep (lens 5, lens 8).** The `open → review-due`
transition depends entirely on the user running `/review`. At today's scale (one user,
presumably checking in periodically) this is fine; at any scale involving reminders, notifications,
or multiple users depending on timely review surfacing, this becomes the first thing that needs
a real scheduled job instead of a lazy on-read transition.

**The change that forces a rearchitecture (unchanged):** the two-brain body (laptop + phone) —
still the named one-way door, still deferred on purpose.

**Cheap evolutions the design pre-paid for (extended this cycle):** swap the embedder, swap the
vector store, add an app (`app_id`), add the HTTP layer — all unchanged. New: adding a third
domain engine is now proven cheap twice over — `packages/capabilities/` was reused 100%
unchanged for the second domain (`08-domain-pack-and-engine.md`), and the choice of single-call
vs two-phase engine shape is now a named decision point rather than something the next engine
author has to invent from scratch.

---

## 8. System-design red-flags audit

Ranked by architectural risk, each grounded in evidence. Most of these remain deliberately-
accepted tradeoffs for a single-user learning project; two are new this cycle and one is a
genuine gap rather than an accepted tradeoff.

1. **Convention-only tenant isolation, now spanning two tables (medium, accepted but widening).**
   `app_id`/`user_id`/`workspace_id` exist on `agents.decisions` exactly as they do on the rest
   of the schema, with no RLS and no independent population of `userId`/`workspaceId` from
   `app_id` (lens 1, lens 7). The `41ecce8` bug (lens 6) is direct evidence of how easily this
   convention-only boundary breaks even inside a *single* adapter, before a second real user is
   ever in the picture.

2. **No scheduled sweep for due reviews (medium, new, NOT a deliberately-accepted tradeoff).**
   Unlike the other gaps in this list, this one isn't named-and-deferred in a design doc — it's
   a straightforward consequence of `listDue()`'s side effect only firing on read
   (`pg-journal-store.ts:86-92`). A decision whose `review_at` passes while the user never runs
   `/review` simply never surfaces; there's no notification, no startup nudge beyond the
   `initialDueCount` banner shown once per CLI launch (`chat.tsx:122-125`). Worth naming
   explicitly rather than folding into "not yet exercised," because it undermines the whole
   point of the decision journal — a review that never gets surfaced is a review that never
   happens.

3. **No timeouts on external calls, now covering more surface (medium, now higher risk).**
   Neither Ollama, pg, nor any of the five discovery APIs (was three) have a timeout. Reddit
   search in particular is documented in its own calling code as "frequently 403s outright"
   (`session.ts:187-188`) — an accepted, expected failure mode for that one connector, but still
   with no backoff or circuit breaker distinguishing "always fails, stop trying for a while" from
   "just failed this once."

4. **Best-effort memory hides failures silently (low, accepted, unchanged).** Still swallowed
   with no log (`session.ts:686-689`).

5. **Soft-link `document_id` trades integrity for parity (low, accepted and documented,
   unchanged).**

6. **`session.ts` is the wiring choke point, now materially larger (low, watch more closely).**
   `createChatSession()` is 490 lines longer than at the last audit (`git diff --stat`), now
   wiring two engines, a journal store, five discovery connectors (up from three), a
   topic-suggestion subsystem, and every method the two new CLI flows call. Still fine at this
   size — nothing here is incorrect — but it is the single place that would need to be split
   first if a third domain vertical were added with its own connector set.

**`not yet exercised` (named so the audit is honest, not padded):** caching/invalidation beyond
in-process TTL caches, retries and timeouts (including for all five discovery APIs), horizontal
scale, multi-region, an API gateway, enforced RLS, queue/streaming infrastructure, fine-tuning,
a scheduled review-due sweep (see finding 2), multi-user journal isolation beyond the schema
columns, API cost tracking across five discovery providers. Each is deferred on purpose except
where explicitly flagged otherwise above.
