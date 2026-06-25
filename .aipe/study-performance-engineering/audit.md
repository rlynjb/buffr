# Performance Engineering — Audit (Pass 1)

The 8-lens walk. Each lens names what `buffr-laptop` actually does, grounded in
`file:line`, or emits `not yet exercised` with the condition that would make it
relevant. This is a single-device CLI RAG agent — no traffic, no SLA — so the
honest verdict on most server-shaped lenses is "not yet exercised, and correctly
so." Where a finding earns a deep walk, it cross-links to a Pass 2 pattern file.

---

## performance-budget

**not yet exercised.**

There is no budget anywhere in the repo — no target latency, no "index N files
in under M seconds," no cost ceiling, no token budget enforced for perf reasons.
The one thing that *looks* like a budget is `ContextWindowGuardedProvider(...,
{ maxTokens: 8192 })` (`src/session.ts:46`), but that's a correctness guard
(don't overflow gemma2's context), not a performance budget.

Why correct here: one user runs `index` and `chat` at the terminal when they feel
like it. A budget is a promise you make to *someone else* — a caller waiting on
a p95, a cost owner watching egress. buffr has neither.

When it becomes relevant: the moment `chat` is fronted by an HTTP handler serving
more than one caller, "answer in under X ms" becomes a real budget — and the
gemma2:9b generation on a laptop GPU is the part that blows it.

---

## measurement-baselines-and-profiling

**Partially exercised — the instrument now lands in the DB, but nothing reads it
back.**

aptkit's tool registry wraps every tool handler in a wall-clock measurement:

```
  tool-registry.js:21-23
    const start = performance.now();
    const result = await handler(args, options);
    return { result, durationMs: Math.round(performance.now() - start) };
```

That `durationMs` rides out on the `tool_call_end` event
(`@aptkit/runtime/.../events.d.ts:14-19`). buffr's trace sink receives that exact
event and **now persists it**: the `tool_call_end` handler writes
`{ result, error, durationMs }` into the message's `tool_results` jsonb
(`src/supabase-trace-sink.ts:67-71`), and a sibling `model_usage` handler fills
the formerly-orphaned `tokens_used` column from input+output tokens
(`src/supabase-trace-sink.ts:73-78`, schema `sql/001_agents_schema.sql:48`). So
the latency number is no longer dropped on the floor — it reaches
`agents.messages`. The remaining gap is *consumption*: nothing queries those
durations back into a baseline or aggregate.

Beyond that: no baselines (nothing has been timed, recorded, and *compared*), no
profiler, no flamegraphs, no representative-workload harness for *speed*. The
closest thing to a measurement harness is `src/cli/eval-cmd.ts`, but it measures
*quality* (precision@1, recall@k over `eval/queries.json`), not latency — it
never times the `pipeline.query` call it makes on line 25.

When it becomes relevant: the cheap win is no longer "stop dropping `durationMs`"
(done) — it's "read the persisted `tool_results.durationMs` / `tokens_used` back"
into a per-tool-call baseline; the instrumentation is already in the table.

→ see `00-overview.md` finding 6.

---

## latency-throughput-and-tail-behavior

**not yet exercised** for tail/throughput; latency is observable per-call but
uninstrumented.

No p95/p99 — a single sequential caller has no distribution to have a tail. No
throughput target, no requests-per-second, no concurrent indexing. The `index`
path is strictly serial (`src/cli/index-cmd.ts:22-26`, one file per loop
iteration, `await`ed), so "throughput" is just `1 / mean-file-time` and nobody
measures it.

Where the per-call latency actually lives, ranked:
1. **gemma2:9b generation** during a `chat` turn — the agent loop calls the LLM
   over HTTP; on a laptop this dominates everything else by an order of magnitude.
   (Inside aptkit's `RagQueryAgent.answer`, `src/session.ts:62`.)
2. **nomic-embed-text embedding** — now *two* `/api/embed` HTTP calls per chat
   turn (the query embed, plus the post-answer memory embed via
   `memory.remember`, `src/session.ts:66`), and one per indexed *document*.
3. **HNSW vector search** — sub-linear, fast, the part that was deliberately
   engineered to *not* be the bottleneck (`src/pg-vector-store.ts:67-85`).

When it becomes relevant: a multi-caller deployment gives you a real latency
distribution, and gemma2 generation time is what its tail is made of.

---

## cpu-memory-and-allocation

**not yet exercised** as a concern.

The data sizes are tiny: markdown files chunked into 512-char windows with 64-char
overlap (`@aptkit/retrieval/.../chunker.js`, `CHUNK_SIZE = 512`). A document's
chunks are held in two arrays (`texts`, `vectors`) for the length of one
`indexDocument` call (`pipeline.js` `indexDocument`) and then released. Nothing
is retained across files. No streaming-vs-buffering tradeoff, no large
allocations, no GC tuning, no observed heap pressure.

The one allocation worth naming: `toVectorLiteral` (`src/pg-vector-store.ts:15-17`)
builds a `[0.1,0.2,...]` string of 768 floats per vector via `.join(',')`. That's
a transient string per upserted chunk and per search. At laptop volume it's
invisible; it'd only matter under sustained high-volume indexing, which buffr
doesn't do.

---

## io-network-and-database-bottlenecks

**Exercised — this is where the real cost lives.** Three sub-findings.

**1. Embedding HTTP is the dominant indexing cost.** Every indexed document makes
exactly one `POST /api/embed` to Ollama with *all* its chunks batched into the
`input` array (`ollama-embedding-provider.js` `defaultHttpTransport`, sending
`input: payload.texts`). The aptkit `indexDocument` calls `embedder.embed(texts)`
once with the full chunk array (`pipeline.js`). So the common worry — "N chunks =
N round-trips" — is **false within a document**; the chunks are already batched.
The real serialization is *across* documents: `src/cli/index-cmd.ts:22-26` loops
files with `for (const path of paths) { … await indexDocumentRow(…) }`, so file
N+1's embed call cannot begin until file N's embed + insert + commit completes.
→ `02-embedding-http-roundtrip.md`

**2. The write is a per-chunk INSERT loop.** `src/pg-vector-store.ts:43-57` opens
a transaction and runs one `client.query(INSERT … on conflict do update)` per
chunk. Atomic and correct, but N statements where a single multi-row INSERT or a
`COPY` would do one. → `03-per-chunk-insert-loop.md`

**3. The read is HNSW approximate search — the engineered win.**
`src/pg-vector-store.ts:70-77` does `order by embedding <=> $1 limit k`, riding
the `chunks_embedding_hnsw` index (`sql/001_agents_schema.sql:30-31`). Sub-linear
instead of scanning every chunk. The `where app_id = $2` filter is backed by its
own btree (`chunks_app_id`, line 32). → `01-hnsw-approximate-search.md`

**4. New per-turn writes in `chat`.** Each turn now also (a) embeds + upserts the
exchange into the same vector store for episodic memory
(`memory.remember`, `src/session.ts:53,66`) — one extra Ollama embed + one extra
pg upsert per turn; and (b) flushes a trace that writes *several* INSERTs per turn
— the sink persists all six CapabilityEvent variants (step, tool_call_start/end,
model_usage, warning, error; `src/supabase-trace-sink.ts:56-84`) instead of the
~2 it used to. Minor write amplification, dominated by the gemma2 generation, but
it scales with turn count.

The database connection itself is reused across the whole `chat` session's many
queries via one long-lived `pg.Pool` (`src/db.ts:4-5`, held in `src/session.ts:39`
until `close()`), so none of the above — including the per-turn memory upsert and
the larger trace flush — pays a per-statement connect/handshake.
→ `04-connection-pool-reuse.md`

---

## caching-batching-and-backpressure

**Batching: partial. Caching: none. Backpressure: not yet exercised.**

**Batching** is done *within* a document (all chunks in one embed call, see the
I/O lens) but *not across* documents (the serial file loop) and *not* on the
write (per-chunk INSERT). So buffr batches the expensive thing (embedding) at the
granularity it happens to receive it, and leaves the two cross-unit batchings
(documents, INSERTs) on the table.

**Caching: none.** Ask the same question twice in `chat` and you pay the embed
HTTP call and the HNSW search both times (plus the per-turn memory embed) — there
is no query-vector cache, no result cache, no memoization of `pipeline.query`. The
`profiles` read (`src/profile.ts:5-6`) is the one thing the session *does* cache
de-facto: `loadProfile` now runs once at session setup (`src/session.ts:47`), not
per turn — so within a session the profile is read once, a small improvement over
the old per-ask re-read. → `05-no-caching.md`

**Backpressure: not yet exercised.** No queue, no concurrency limit, no overload
mode, no debounce/throttle. There's no fan-in to apply backpressure *to* — one
CLI process, one operation at a time. The `pg.Pool` has an implicit default max
(10 connections) that would queue excess checkouts, but buffr never checks out
concurrently, so that ceiling is never approached.

When it becomes relevant: caching is the first lever to pull if `chat` ever serves
repeat queries from multiple users; a query-vector LRU keyed on the question
string would cut the embed HTTP call and the HNSW search to a hash lookup.

---

## rendering-client-and-mobile-performance

**not yet exercised** — though `chat` now has a terminal UI. `chat` renders an
Ink (React-in-the-terminal) interface (`src/cli/chat.tsx`): `useState` turn list,
a `TextInput`, a busy `Spinner`. No browser, no bundle, no DOM paint, no mobile
target — Ink reconciles to ANSI writes on stdout, and the render cost is trivial
against the gemma2 generation each turn waits on. The one perf-shaped property:
the UI stays responsive because `session.ask()` is awaited off the render path
with a `busy` guard (`src/cli/chat.tsx:13-35`), so a slow turn shows a spinner
rather than blocking input handling. (The *parent* `buffr` is React Native per the
project vision; this laptop repo's only client surface is the Ink TUI.)

---

## performance-red-flags-audit

Ranked by consequence at the repo's actual scale, with evidence named.

**1. HNSW index parameters are untuned and unmeasured.**
*Evidence: missing measurement.* The index exists (`sql/001_agents_schema.sql:30-31`)
but `m`, `ef_construction`, and `ef_search` are all Postgres defaults — never set,
never benchmarked against the recall numbers `eval-cmd.ts` already produces. At
three eval docs this is harmless; the flag is that *the tuning knob with the
highest retrieval-quality-per-millisecond leverage in the whole system is
untouched and nobody has the baseline to tune it.* The recall@k harness exists
(`src/cli/eval-cmd.ts:24-33`) — wiring `ef_search` against it is the move.

**2. The one latency number the system produces is persisted but never read
back.** *Evidence: code path.* `durationMs` is computed (`tool-registry.js:21-23`),
emitted (`events.d.ts:19`), received, and now *written* into
`agents.messages.tool_results` (`src/supabase-trace-sink.ts:67-71`); the
formerly-empty `tokens_used` column is filled from `model_usage`
(`src/supabase-trace-sink.ts:73-78`, `sql/001_agents_schema.sql:48`). The flag
downgraded: the data lands in the table, but no query or harness reads it back
into a baseline — instrumentation without consumption.

**3. Indexing serializes across documents.**
*Evidence: code path, no baseline.* `src/cli/index-cmd.ts:22-26` `await`s each
file in sequence. For a one-file corpus this is irrelevant; for a many-file
corpus, the wall-clock is the *sum* of per-file embed-HTTP times when a bounded
`Promise.all` could overlap them. No baseline exists to say how bad it is — which
is itself the flag.

**4. Per-chunk INSERT loop.**
*Evidence: code path, no baseline.* `src/pg-vector-store.ts:43-57`. N statements
per document where one multi-row INSERT would do. Lowest-consequence flag on the
list — it's strictly dominated by the embed call it sits behind.

**5. No caching of identical queries.**
*Evidence: missing mechanism.* Every `chat` turn re-embeds and re-searches from
scratch (`src/session.ts:62` via `pipeline.query`). Correct for one user; the
first real gap if buffr ever serves repeat traffic.

---

Updated: 2026-06-24 — `ask`/`ask-cmd.ts` → `chat` (`session.ts`, `chat.tsx`).
Corrected measurement lens + red-flag #2: the trace sink now PERSISTS `durationMs`
and `tokens_used` (`supabase-trace-sink.ts:67-78`) — the gap downgraded from
"dropped" to "written but not read back." Added per-turn memory embed+upsert and
trace write-amplification to the I/O lens (sub-finding 4) and latency ranking.
Rendering lens updated for the new Ink TUI (`chat.tsx`). Caching lens notes
`loadProfile` now runs once per session, not per turn. HNSW / serial-files /
per-chunk-insert / no-caching findings re-verified unchanged.
