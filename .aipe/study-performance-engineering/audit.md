# Performance Audit — buffr-laptop (Pass 1)

The 8-lens walk. Each lens names what the codebase actually does with `file:line` grounding, or says `not yet exercised` honestly. Significant findings cross-link to a Pass-2 pattern file rather than restating it.

The recurring verdict, stated once so each lens can lean on it: **the dominant per-turn cost is `gemma2:9b` generation, owned by Ollama.** Every cost below is measured against that baseline. Most are real and most don't matter yet, because they're rounding error next to the generation step.

---

## 1. performance-budget

`not yet exercised` — there is no user-visible or system-visible performance budget anywhere in the repo. No p95/p99 target, no per-turn latency SLO, no cost ceiling, no timeout that represents a budget (the only timeout-shaped config is `ContextWindowGuardedProvider({ maxTokens: 8192 })` at `src/session.ts:46`, which is a context-window guard, not a latency budget). Nothing in the codebase fails or warns when a turn gets slow.

When it becomes relevant: the moment buffr serves more than one user, or the corpus grows enough that HNSW recall degrades. At single-device scale, "fast enough" is whatever `gemma2:9b` does on the local GPU, and the repo correctly doesn't pretend to control that.

---

## 2. measurement-baselines-and-profiling

Partially exercised, and this is the most important lens in the guide because it's where the gap is.

**What exists.** The trace sink captures real per-event timing and token data:
- `src/supabase-trace-sink.ts:67-71` — `tool_call_end` events persist `durationMs` into `tool_results`.
- `src/supabase-trace-sink.ts:73-78` — `model_usage` events persist `tokensUsed = inputTokens + outputTokens`.
- The eval harness (`src/cli/eval-cmd.ts:22-33`) is a representative *correctness* workload — it runs every labeled query through the pipeline and scores precision@1 and recall@3.

**What's missing.** Nothing reads the timing back. `durationMs` and `tokens_used` land in `agents.messages` and are never aggregated, queried, or compared before/after. There is no profiler wired in — no `node --prof`, no `clinic`, no `0x`, no flamegraph. The eval harness measures precision, not latency; it never times `pipeline.query`.

So every "does this matter" verdict in this audit is an *estimate*, not a measurement. The instrumentation is built; the measurement loop is open. Closing it — one SQL aggregation over `agents.messages.tokens_used` and the trace `durationMs` — is the highest-leverage performance move in the repo. → see `00-overview.md` finding 6.

---

## 3. latency-throughput-and-tail-behavior

`not yet exercised` for tail behavior, partially exercised for latency composition.

**Latency composition (observed structure, inferred timing).** One `ask()` turn (`src/session.ts:60-71`) is a fixed sequence: persist user message → `agent.answer()` (embed query → HNSW search → `gemma2:9b` generate, possibly multi-step) → `trace.flush()` → `memory.remember()`. The generation step is the dominant term by an order of magnitude; the embed roundtrips and HNSW search are the next tier; the DB writes are noise. This is structural inference from the call order, not a measured distribution.

**Throughput.** Single-user, single-conversation, in-process (`src/session.ts:34` holds one conversation across turns). There is no concurrency, no queue, no fan-in, so there is no throughput figure to report and no contention to measure.

**Tail behavior.** `not yet exercised` — p95/p99 are undefined because there's no workload generating a latency distribution. No load test exists. The only multi-iteration path is the eval harness, which doesn't time anything.

---

## 4. cpu-memory-and-allocation

Low-pressure and `not yet measured`, which together mean: nothing here is a concern, and nothing has been profiled to confirm it.

**Allocation shapes worth naming.** `toVectorLiteral` (`src/pg-vector-store.ts:15-17`) builds a string of 768 floats joined by commas for every upsert and every search — a transient allocation per vector. At one query per turn it's invisible; in a tight indexing loop over a large corpus it's a small, real GC churn. The `search` result mapping (`src/pg-vector-store.ts:80-84`) rebuilds a meta object per hit, bounded by `k` (typically 3-4), so trivial.

**Heavy memory lives outside this process.** The embedding model and `gemma2:9b` hold their weights in Ollama, not in the Node heap. buffr's own footprint is the pg pool buffers, the Ink render tree, and per-turn transient strings. No retention, no leak surface, no GC tuning needed at this scale. No heap snapshot has been taken — this is inference from the code shape, not a measurement.

---

## 5. io-network-and-database-bottlenecks

The richest lens — this is where buffr's real I/O patterns live, all of them deprioritized by the generation baseline but all of them genuinely present.

- **Approximate nearest-neighbour search (the HNSW index)** — `src/pg-vector-store.ts:67-85`, schema at `sql/001_agents_schema.sql:28-29`. The `<=>` cosine-distance operator with `order by ... limit k` gives sub-linear retrieval. This is the main I/O *win*, not a bottleneck — but it's untuned. → see `01-hnsw-approximate-search.md`.
- **Embedding roundtrip** — one HTTP call to Ollama's `/api/embed` per document (batched across that doc's chunks), but serialized across files in the index CLI. → see `02-embedding-roundtrip.md`.
- **Per-chunk INSERT loop** — `src/pg-vector-store.ts:38-65` loops one parameterized INSERT per chunk inside a single transaction. N round-trips where a multi-row INSERT or COPY would be one. → see `03-per-chunk-insert-loop.md`.
- **Connection pool reuse** — `src/db.ts:4-6` builds one `pg.Pool`; `src/session.ts:39` keeps it warm across the whole session. The right call — avoids per-query connect cost. → see `04-connection-pool-reuse.md`.
- **Per-turn write amplification** — `src/session.ts:61-67` plus `src/supabase-trace-sink.ts:53-85`: one user INSERT, up to 6 trace INSERTs (one per `CapabilityEvent` type), plus `memory.remember`'s embed+INSERT. → see `05-per-turn-memory-and-trace-cost.md`.

Worth naming: the trace INSERTs are *queued* during the agent run (`emit()` is sync, pushes a promise) and *awaited together* in `flush()` (`src/supabase-trace-sink.ts:87-93`). So they overlap rather than blocking the run serially — a deliberate, decent choice. They still all hit the DB; `flush()`'s `Promise.all` means they race the connection pool.

---

## 6. caching-batching-and-backpressure

**Batching — exercised, partially.** Embedding is batched per document: one `/api/embed` call carries all of a document's chunks (handled inside aptkit's pipeline). The trace writes are batched in the sense of queued-then-flushed (`src/supabase-trace-sink.ts:91-93`). What is *not* batched: the chunk INSERTs (one per chunk, lens 5 / file `03`) and the cross-file embed calls (serial, file `02`).

**Caching — `not yet exercised`.** No embedding cache, no query cache, no result memoization. An identical query — the same string asked twice, or the eval harness re-run unchanged — pays the full embed roundtrip and HNSW search every time (`src/pg-vector-store.ts:67`, `src/cli/eval-cmd.ts:25`). → see `06-no-caching.md`.

**Backpressure — `not yet exercised` and correctly so.** There is no queue, no fan-in, no concurrent producer, so there's nothing to apply backpressure to. `flush()`'s `Promise.all` (`src/supabase-trace-sink.ts:92`) fires all pending writes at once with no bound — fine at ~6 writes, would need a bound only if the trace ever fanned out to hundreds of events per turn.

---

## 7. rendering-client-and-mobile-performance

`not yet exercised` in the web/mobile sense — there is no browser bundle, no DOM, no main-thread budget.

The one client surface is the Ink (React-in-terminal) TUI at `src/cli/chat.tsx`. It re-renders the terminal on each state change. At the scale of a single conversation transcript this is negligible; Ink's reconciler is the constraint and it's well under any perceptible budget here. No bundle size, no startup-time, no frame budget applies to a terminal app of this size. (For the real-time frame-budget shape, that lives in the `contrl` project, not buffr.)

---

## 8. performance-red-flags-audit

Ranked by consequence, with the evidence named for each — and for this repo, "evidence" is almost always *a missing measurement*, which is itself the finding.

1. **The measurement loop is open (highest leverage).** `durationMs` and `tokens_used` are written (`src/supabase-trace-sink.ts:67-78`) and never read. Evidence: instrumentation present, aggregation absent. Every other verdict here is an estimate until this closes. Fix: one aggregation query over `agents.messages`.

2. **HNSW is untuned.** No `m` / `ef_construction` at build (`sql/001_agents_schema.sql:28-29`), no `ef_search` at query (`src/pg-vector-store.ts:70-78`). Evidence: defaults in use, no recall@k-vs-latency curve measured. Matters only past a few thousand chunks — `not yet measured` whether the corpus is there. → `01`.

3. **Per-chunk INSERT loop.** N round-trips per document (`src/pg-vector-store.ts:43-57`). Evidence: code shape; no index-time profile. The first fix if indexing ever feels slow. → `03`.

4. **No caching.** Identical query re-embeds (`src/pg-vector-store.ts:67`). Evidence: no cache layer exists; repeat-rate unmeasured. Helps eval runs more than chat. → `06`.

5. **Serial cross-file indexing.** GPU idle through each file's DB writes (`src/cli/index-cmd.ts:22-26`). Evidence: `for...await` structure; no index-time wall-clock measured. → `02`.

6. **Unbounded `flush()` fan-out.** `Promise.all` over all pending writes (`src/supabase-trace-sink.ts:92`). Evidence: ~6 writes today, no bound. A latent red flag, not a current one — only fires if per-turn event count grows large.

The honest bottom line: none of these red flags are on fire, because the generation baseline makes them all small. The one that's actually *worth doing now* is #1 — not because it's slow, but because without it you can't prove any of the others are or aren't.
