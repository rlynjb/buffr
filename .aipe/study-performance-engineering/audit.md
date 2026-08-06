# Performance Audit — buffr-laptop (Pass 1)

The 8-lens walk. Each lens names what the codebase actually does with `file:line` grounding, or says `not yet exercised` honestly. Significant findings cross-link to a Pass-2 pattern file rather than restating it.

The recurring verdict, stated once so each lens can lean on it: **the dominant per-turn cost is `gemma2:9b` generation, owned by Ollama.** Every cost below is measured against that baseline. Most are real and most don't matter yet, because they're rounding error next to the generation step. The one place that verdict gets a genuine second act is the two research engines (`/research`, `/investing`): their evidence-gathering step fans out to 2-5 external connectors, and that step is I/O-bound on someone else's network, not on `gemma2:9b` — which is exactly why lenses 3, 5, and 6 below have grown since the last pass.

---

## 1. performance-budget

Still `not yet exercised` for anything that governs how *fast* a turn runs — no p95/p99 target, no per-turn latency SLO, no cost ceiling. But one real budget landed since the last pass, on a different axis: **exit latency.** `close()`'s pool-shutdown race (1s) and `forceExit`'s hard deadline (1.5s, `src/cli/chat.tsx:464-466`) together are, structurally, the first latency ceiling anywhere in this codebase — "shutdown will take at most 1.5s, no matter what." It's a worst-case bound on an operation, which is what a budget is, even though nobody called it that when they wrote it. It's not a p95 target and it doesn't generalize to "turns are fast" — but it's worth naming as the repo's first instance of the *pattern* a budget represents. → `04-connection-pool-reuse.md`.

Everything else here is still open: no timeout represents a *latency* budget (`ContextWindowGuardedProvider({ maxTokens: 8192 })` at `src/session.ts` is a context-window guard, not a latency budget), and nothing fails or warns when a turn or a connector fan-out gets slow.

When it becomes relevant: the moment buffr serves more than one user, the corpus grows enough that HNSW recall degrades, or the research engines gain enough connectors that the fan-out's tail (lens 3) becomes worth bounding the same way shutdown now is. At single-device scale, "fast enough" is whatever `gemma2:9b` does on the local GPU, and the repo correctly doesn't pretend to control that.

---

## 2. measurement-baselines-and-profiling

Partially exercised, and this is the most important lens in the guide because it's where the gap is.

**What exists.** The trace sink captures real per-event timing and token data:
- `src/supabase-trace-sink.ts:67-71` — `tool_call_end` events persist `durationMs` into `tool_results`.
- `src/supabase-trace-sink.ts:73-78` — `model_usage` events persist `tokensUsed = inputTokens + outputTokens`.
- The eval harness (`src/cli/eval-cmd.ts:22-33`) is a representative *correctness* workload — it runs every labeled query through the pipeline and scores precision@1 and recall@3.

**What's missing.** Nothing reads the timing back. `durationMs` and `tokens_used` land in `agents.messages` and are never aggregated, queried, or compared before/after. There is no profiler wired in — no `node --prof`, no `clinic`, no `0x`, no flamegraph. The eval harness measures precision, not latency; it never times `pipeline.query`. The new `ProgressEvent` stream (`stage-start`/`stage-done`/`connector-start`/`connector-done`, threaded from the engines into `ProgressPanel` — lens 7) is display-only: it carries labels and counts, no timestamps, so it doesn't backfill this gap even though it looks adjacent to it. A `stage-done` event with a duration attached would be the cheapest addition that turns the connector-fan-out latency claim in lens 3 from inference into a measurement.

So every "does this matter" verdict in this audit is an *estimate*, not a measurement. The instrumentation is built; the measurement loop is open. Closing it — one SQL aggregation over `agents.messages.tokens_used` and the trace `durationMs` — is the highest-leverage performance move in the repo. → see `00-overview.md` finding 6.

---

## 3. latency-throughput-and-tail-behavior

`not yet exercised` for tail behavior, partially exercised for latency composition — and this lens now has a real concurrency story where it previously had none.

**Latency composition (observed structure, inferred timing).** One `ask()` turn (`src/session.ts:668-689`) is a fixed sequence: persist user message → `agent.answer()` (embed query → HNSW search → optional web API call → `gemma2:9b` generate, possibly multi-step) → `trace.flush()` → `memory.remember()`. The generation step is the dominant term by an order of magnitude; web search API calls (200-800ms external HTTP when triggered) are the next real tier; the embed roundtrips and HNSW search are below that; the DB writes are noise. This is structural inference from the call order, not a measured distribution — no span wraps the per-tool HTTP calls yet, so none of it lands in `durationMs`.

**Connector fan-out — concurrent, not sequential.** `/research` and `/investing` each gather evidence from N independent external sources before analysis starts. That gather is genuinely parallel: `Collector.execute` (`packages/capabilities/src/collector/index.ts:35-49`) wraps every source's `fetch` in `Promise.all`, so wall-clock cost for the gather step is `max(latency)` across sources, not `Σ(latency)`. Both `InvestingEngine.run()` and `MarketResearchEngine.collect()` route through the same `Collector`, so the concurrency is shared infrastructure, not duplicated per engine. This is a genuine positive latency finding — the research pipeline is I/O-bound on external APIs, and the code doesn't leave that I/O serialized. → see `07-connector-fan-out.md`.

**The gap in that concurrency:** no per-source timeout. `Promise.all` waits for every connector's own `fetch` to settle; a hung or slow connector sets the batch's wall-clock time, not a fixed ceiling. At N=2-5 config-bounded sources this hasn't bitten yet, but it's the one place in the fan-out that isn't fully bounded — contrast with `04-connection-pool-reuse.md`'s bounded-shutdown fix, which is the same "bound the worst case" move applied to a different resource.

**Throughput.** Single-user, single-conversation, in-process (`src/session.ts` holds one conversation across turns). There is no request concurrency at the session level — the fan-out above is *within* one turn's evidence-gathering step, not across turns or users. No queue, no fan-in across turns, so there is still no cross-turn throughput figure to report.

**Tail behavior.** `not yet exercised` — p95/p99 are undefined because there's no workload generating a latency distribution. No load test exists. The only multi-iteration path is the eval harness, which doesn't time anything. The connector fan-out is the one place a tail number would actually be informative (the batch's tail is set by whichever connector is slowest), and it's exactly the piece with no timing baseline yet.

---

## 4. cpu-memory-and-allocation

Low-pressure and `not yet measured`, which together mean: nothing here is a concern, and nothing has been profiled to confirm it.

**Allocation shapes worth naming.** `toVectorLiteral` (`src/pg-vector-store.ts:15-17`) builds a string of 768 floats joined by commas for every upsert and every search — a transient allocation per vector. At one query per turn it's invisible; in a tight indexing loop over a large corpus it's a small, real GC churn. The `search` result mapping (`src/pg-vector-store.ts:80-84`) rebuilds a meta object per hit, bounded by `k` (typically 3-4), so trivial.

**Heavy memory lives outside this process.** The embedding model and `gemma2:9b` hold their weights in Ollama, not in the Node heap. buffr's own footprint is the pg pool buffers, the OpenTUI render tree, and per-turn transient strings. No retention, no leak surface, no GC tuning needed at this scale. No heap snapshot has been taken — this is inference from the code shape, not a measurement.

---

## 5. io-network-and-database-bottlenecks

The richest lens — this is where buffr's real I/O patterns live, all of them deprioritized by the generation baseline but all of them genuinely present.

- **Approximate nearest-neighbour search (the HNSW index)** — `src/pg-vector-store.ts:67-85`, schema at `sql/001_agents_schema.sql:28-29`. The `<=>` cosine-distance operator with `order by ... limit k` gives sub-linear retrieval. This is the main I/O *win*, not a bottleneck — but it's untuned. → see `01-hnsw-approximate-search.md`.
- **Embedding roundtrip** — one HTTP call to Ollama's `/api/embed` per document (batched across that doc's chunks), but serialized across files in the index CLI. → see `02-embedding-roundtrip.md`.
- **Per-chunk INSERT loop** — `src/pg-vector-store.ts:38-65` loops one parameterized INSERT per chunk inside a single transaction. N round-trips where a multi-row INSERT or COPY would be one. → see `03-per-chunk-insert-loop.md`.
- **Connection pool reuse** — `src/db.ts:4-6` builds one `pg.Pool`; `src/session.ts:399` keeps it warm across the whole session, now also shared by `PgJournalStore`. The right call — avoids per-query connect cost. **New evidence this pass:** teardown used to be unbounded — `pool.end()` could hang the whole process on `/exit` if a connection was ever left in a bad state. `64f822f` and `9c1b1e6` fixed it with two independent timeouts (a 1s race inside `close()`, a 1.5s hard deadline in the exit handler) plus an explicit Ctrl+C handler in the TUI's keyboard layer, because raw-mode terminal input doesn't reliably deliver `SIGINT`. This is an availability fix, not a latency one — the happy path is unchanged, the worst case is now bounded instead of unbounded. → see `04-connection-pool-reuse.md`.
- **Per-turn write amplification** — `src/session.ts:61-67` plus `src/supabase-trace-sink.ts:53-85`: one user INSERT, up to 6 trace INSERTs (one per `CapabilityEvent` type), plus `memory.remember`'s embed+INSERT. → see `05-per-turn-memory-and-trace-cost.md`.

Worth naming: the trace INSERTs are *queued* during the agent run (`emit()` is sync, pushes a promise) and *awaited together* in `flush()` (`src/supabase-trace-sink.ts:87-93`). So they overlap rather than blocking the run serially — a deliberate, decent choice. They still all hit the DB; `flush()`'s `Promise.all` means they race the connection pool.

**`index:db` sequential round-trips.** `src/cli/index-db-cmd.ts` fires 8 sequential `pool.query()` calls — one per `DbSource` in `src/db-sources.ts` (loopd: entries/todo_meta/nutrition/vlogs/habits; contrl: exercises/sessions/week_progress). These are independent reads with no ordering dependency; they could be `Promise.all`'d for parallel execution, but aren't. After each query, `source.toText(row)` is called per row, followed by `sanitize()` and then one embedding call per chunk — all serially. Wall-clock cost for a large corpus: `8 × query_latency + N_rows × chunks_per_row × embed_latency`. No measurement exists; no baseline has been taken. The second bottleneck (after serialized DB calls) is the per-chunk Ollama embed path, same as markdown indexing but with a potentially larger row count.

**Web/connector I/O.** When a connector tool fires — in chat, or inside `/research`/`/investing` — it routes to a `DataConnector` that makes an outbound HTTP call to Brave/Tavily/Google/Reddit/RSS/Trends. These are external-network round-trips: latency is not buffr-controlled and not currently measured as a span. In `/research`/`/investing` specifically, N of these fire concurrently rather than one at a time (lens 3, `07-connector-fan-out.md`), and each is wrapped in a TTL cache that skips the network call entirely on a repeat within the last hour (lens 6, `08-connector-result-caching.md`). Quota exhaustion (Google: 100/day) surfaces as a tool error, not a timeout — adding a per-connector latency trace and a remaining-quota counter is still the measurement gap for this tier; the cache reduces how often quota gets exercised but doesn't make the gap visible.

**Single-row write path — `agents.decisions`.** `PgJournalStore` (`src/pg-journal-store.ts`) is the newest DB-touching component, writing the decision-journal loop (`create`, `listDue`, `snooze`, `resolve`). Every method is one `pool.query` call, no loop, no explicit transaction — the correct shape for a single-logical-row write, and a useful contrast against the per-chunk INSERT loop below: this codebase only loops INSERTs where the write genuinely is N rows. → see `03-per-chunk-insert-loop.md`.

---

## 6. caching-batching-and-backpressure

**Batching — exercised, partially.** Embedding is batched per document: one `/api/embed` call carries all of a document's chunks (handled inside aptkit's pipeline). The trace writes are batched in the sense of queued-then-flushed (`src/supabase-trace-sink.ts:91-93`). What is *not* batched: the chunk INSERTs (one per chunk, lens 5 / file `03`) and the cross-file embed calls (serial, file `02`).

**Caching — split verdict, corrected this pass.** The RAG retrieval path — embed + HNSW search — has no cache: an identical query, the same string asked twice, or the eval harness re-run unchanged, pays the full embed roundtrip and HNSW search every time (`src/pg-vector-store.ts:67`, `src/cli/eval-cmd.ts:25`). That part of the earlier verdict stands. → see `06-no-caching.md`.

What's changed: the earlier version of this audit also claimed web search had no caching. That was wrong — every connector reachable from chat or the research engines (`Brave`, `Tavily`, `Google Search`, `Reddit`, `RSS`, `Google Trends`) is wrapped in `CachedConnector` (`packages/connectors/src/cached-connector.ts`), a TTL cache-aside decorator (1hr default) sitting in front of every outbound call, wired at `src/session.ts:459-469` and shared across `/research` and `/investing` from the same connector instance. The same topic asked twice within the TTL window costs zero outbound calls the second time — a real, working mechanism, not an absence. Its invalidation story is easier than the RAG cache's would be (pure time-based expiry vs. corpus-change invalidation), which is exactly why this one shipped and the other hasn't. → see `08-connector-result-caching.md`.

**Backpressure — `not yet exercised`, and now genuinely worth re-checking twice.** There is no queue, no fan-in across turns, so there's nothing to apply backpressure to at the session level. `flush()`'s `Promise.all` (`src/supabase-trace-sink.ts:92`) fires all pending trace writes at once with no bound — fine at ~6 writes. The connector fan-out (lens 3, `07-connector-fan-out.md`) is the same shape at a different layer — `Promise.all` over N connector fetches with no bound and no per-source timeout — and it's closer to mattering than the trace fan-out, because N there is set by how many API keys are configured, not a fixed small constant. Still small today (2-5), but it's the one `Promise.all` in the repo with the least headroom before it'd need a concurrency cap.

---

## 7. rendering-client-and-mobile-performance

`not yet exercised` in the web/mobile sense — there is no browser bundle, no DOM, no main-thread budget.

The one client surface is the OpenTUI (React-in-terminal via Zig) TUI at `src/cli/chat.tsx`. It re-renders the terminal on each state change. At the scale of a single conversation transcript this is negligible; the reconciler is well under any perceptible budget here. No bundle size, no startup-time, no frame budget applies to a terminal app of this size. (For the real-time frame-budget shape, that lives in the `contrl` project, not buffr.)

**New this pass — the live progress panel is a perceived-latency technique, not a real one, and worth naming as such.** `ProgressPanel` (`src/cli/chat.tsx:86-119`) renders a spinner, elapsed time, live token count, and a per-step list (`connector-start`/`connector-done`/`stage-start`/`stage-done` events threaded through from `MarketResearchEngine` via the `ProgressEvent` type) on a 100ms `setInterval` while a turn or research/investing run is in flight. This changes *nothing* about how long the underlying work takes — `gemma2:9b` generation and the connector fan-out run exactly as long either way. What it changes is what the user experiences during that wait: a static "thinking…" blank versus a per-stage status feed that makes an actually-parallel, several-second gather (lens 3) legible instead of opaque. This is the classic perceived-latency move — you can't always cut wall-clock time, but you can cut the *feels-like* time by showing progress instead of hiding it. This audit doesn't own the rendering mechanics of that panel (state updates, `setInterval` cost, OpenTUI reconciliation) — that's **`study-frontend-engineering`** territory — and doesn't own the event-plumbing-as-observability angle either — that's **`study-debugging-observability`**. What this lens owns is the one-line verdict: it's real UX value, zero throughput value, and it's correctly scoped as a display concern rather than a performance fix.

---

## 8. performance-red-flags-audit

Ranked by consequence, with the evidence named for each — and for this repo, "evidence" is almost always *a missing measurement*, which is itself the finding. One long-standing red flag was closed this pass (noted, not ranked); the rest are re-ranked with the two new engines' evidence folded in.

1. **The measurement loop is open (highest leverage, unchanged).** `durationMs` and `tokens_used` are written (`src/supabase-trace-sink.ts:67-78`) and never read. Evidence: instrumentation present, aggregation absent. Every other verdict here is an estimate until this closes — including the new connector-fan-out latency claim in lens 3, which is structurally sound but has zero measured milliseconds behind it. Fix: one aggregation query over `agents.messages`.

2. **HNSW is untuned.** No `m` / `ef_construction` at build (`sql/001_agents_schema.sql:28-29`), no `ef_search` at query (`src/pg-vector-store.ts:70-78`). Evidence: defaults in use, no recall@k-vs-latency curve measured. Matters only past a few thousand chunks — `not yet measured` whether the corpus is there. → `01`.

3. **Connector fan-out has no per-source timeout.** `Promise.all` over N connector fetches (`packages/capabilities/src/collector/index.ts:35-49`) waits for every source to settle — one slow or hung connector sets the whole batch's wall-clock time, and there's no `Promise.race`-with-deadline per source the way `04`'s pool shutdown now has. Evidence: code shape; no timeout config on any connector's own `fetch`. New this pass — didn't exist as a finding before the two research engines landed. → `07`.

4. **Per-chunk INSERT loop.** N round-trips per document (`src/pg-vector-store.ts:43-57`). Evidence: code shape; no index-time profile. The first fix if indexing ever feels slow. → `03`.

5. **No caching on the RAG path.** Identical query re-embeds (`src/pg-vector-store.ts:67`). Evidence: no cache layer exists; repeat-rate unmeasured. Helps eval runs more than chat. Demoted one slot this pass because the *connector* half of "no caching" turned out to be false — see the fix note below. → `06`.

6. **Serial cross-file indexing.** GPU idle through each file's DB writes (`src/cli/index-cmd.ts:22-26`). Evidence: `for...await` structure; no index-time wall-clock measured. → `02`.

6b. **`index:db` serial round-trips.** 8 sequential `pool.query()` calls for independent tables (`src/cli/index-db-cmd.ts`, `src/db-sources.ts`). No parallelism, no batch. The table reads are independent — `Promise.all` over the 8 sources would remove 7/8 of the query-latency cost, the same fix already applied one layer over in `Collector.execute` (`07`). Evidence: `for...of` structure over `DB_SOURCES`; no timing baseline.

7. **Unbounded `flush()` fan-out.** `Promise.all` over all pending trace writes (`src/supabase-trace-sink.ts:92`). Evidence: ~6-7 writes today, no bound. A latent red flag, not a current one — only fires if per-turn event count grows large.

**Fixed this pass — connection pool shutdown.** Previously not tracked as a red flag because it hadn't surfaced yet: `pool.end()` had no bound, so a connection left in a bad state could freeze the CLI on `/exit`. `64f822f` and `9c1b1e6` closed it with two independent timeouts plus explicit Ctrl+C handling in the TUI's raw-mode keyboard layer. Listed here so the audit shows its work — this was a real bug, not a hypothetical, and it's now closed. → `04`.

**Corrected this pass — "no web-search caching" was wrong.** The previous version of this list didn't separately flag it, but the caching lens above did claim web search was uncached. It isn't — `CachedConnector` covers it. → `08`.

The honest bottom line: none of the open red flags are on fire, because the generation baseline makes most of them small. #1 is still the one worth doing regardless of urgency, because it's the only fix that turns every other verdict in this audit — including the new fan-out latency claim — from an estimate into a number. #3 is the one to watch as the research engines get more source connectors added.
