# Performance Engineering — Overview

`buffr-laptop` is a single-device RAG agent. There's no traffic, no SLA, no
second user. That changes what "performance" even means here: nothing is
contended, nothing is hot, and the only clock that runs is *your* patience
waiting for an `index` or an `ask` to finish at the terminal. So this guide is
honest about scale. Most of the lenses a server-side perf audit would light up
(p95 budgets, backpressure, queue depth, GC pressure) are `not yet exercised` —
and that's the correct verdict, not a gap to apologize for.

What's left after stripping the server-shaped lenses is still real, and it's
where the actual time goes: **embeddings over HTTP** and **Postgres round-trips**.

```
  Where the wall-clock time actually goes — buffr at laptop scale

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  npm run index -- *.md        npm run ask -- "..."           │
  └─────────┬───────────────────────────────┬────────────────────┘
            │ one file at a time            │ one question
  ┌─ Pipeline (aptkit) ───────────▼─────────▼────────────────────┐
  │  chunk → embed → upsert       embed → search → LLM loop       │
  └─────────┬───────────────────────────────┬────────────────────┘
            │ HTTP  ◄── DOMINANT COST ──►    │ HTTP
  ┌─ Ollama (localhost:11434) ────▼──────────▼───────────────────┐
  │  nomic-embed-text (embed)     gemma2:9b (generate, the slow   │
  │                               one on a laptop GPU/CPU)        │
  └──────────────────────────────────────────────────────────────┘
            │ SQL (warm pool)
  ┌─ Postgres + pgvector ─────────▼──────────────────────────────┐
  │  HNSW index on chunks.embedding  ←── the main perf WIN        │
  │  per-chunk INSERT loop inside a txn  ←── a small perf cost    │
  └──────────────────────────────────────────────────────────────┘
```

## Ranked findings — what matters, in order

1. **HNSW approximate search is the one real performance win, and it's
   untuned.** `agents.chunks` carries an HNSW index
   (`sql/001_agents_schema.sql:30-31`) and `search()` rides it with
   `order by embedding <=> $1 limit k` (`src/pg-vector-store.ts:70-77`). That's
   sub-linear retrieval instead of a full scan over every chunk. But `m`,
   `ef_construction`, and `ef_search` are all left at Postgres defaults — never
   set, never measured. At three eval docs it doesn't matter; the point is that
   *the knob exists and nobody has turned it.* → `01-hnsw-approximate-search.md`

2. **Indexing cost is dominated by embedding HTTP, and the loop is
   document-serial.** `embed(texts)` POSTs *all* of a document's chunks in one
   `/api/embed` call (the array batches —
   `ollama-embedding-provider.js` `defaultHttpTransport`), so it is NOT
   one-HTTP-call-per-chunk. But `index-cmd.ts:22-26` walks files in a plain
   `for…await` loop: file N+1's embedding can't start until file N's embed +
   insert + commit finishes. The lever isn't "batch the chunks" (already done) —
   it's "overlap the documents." → `02-embedding-http-roundtrip.md`

3. **Upsert writes one INSERT per chunk inside a transaction.**
   `src/pg-vector-store.ts:43-57` loops `client.query(INSERT …)` once per chunk.
   The transaction makes it atomic and the warm connection avoids reconnect, but
   it's N statements where one multi-row INSERT (or `COPY`) would do. At a
   handful of 512-char chunks per doc it's noise next to the embed call. → `03-per-chunk-insert-loop.md`

4. **One warm connection carries an ask's whole burst of queries.** A single
   `ask` fires `loadProfile` + `startConversation` + `persistMessage`
   (`src/cli/ask-cmd.ts:27-30`) plus the vector `search` during the agent loop
   plus the trace `flush`, all over one `pg.Pool` (`src/db.ts:4-5`). No
   per-query reconnect, no TLS handshake per statement. This is a quiet win, not
   a problem. → `04-connection-pool-reuse.md`

5. **No caching anywhere — identical queries re-embed and re-search every
   time.** Ask the same question twice and you pay the embed HTTP call and the
   HNSW search twice. There is no query-vector cache, no result cache, no
   memoization. At single-user laptop scale this is fine; named here because
   it's the first thing that becomes wrong the moment this serves more than one
   caller. → `05-no-caching.md`

6. **`durationMs` is the only latency instrument, and buffr never reads it.**
   aptkit's tool registry wraps every tool call in `performance.now()`
   (`tool-registry.js:21-23`) and emits `durationMs` on the `tool_call_end`
   event. buffr's trace sink catches that event
   (`src/supabase-trace-sink.ts` `emit`) but persists only `toolName` and
   `result` — it drops the duration on the floor. There is no other timing in
   the repo. → see `audit.md` § measurement-baselines-and-profiling.

## Not yet exercised — and why that's correct here

- **No performance budget.** No target latency, no "index must finish in N
  seconds," no cost ceiling. Single user, run-it-when-you-want.
- **No baselines, no profiler, no flamegraphs.** Nothing has been timed,
  recorded, or compared before/after. The `durationMs` aptkit hands over is
  thrown away.
- **No p95/p99, no tail behavior.** One caller means one sample at a time;
  there is no distribution to have a tail.
- **No load testing, no throughput target.** No concurrent indexing, no
  request-per-second goal.
- **No backpressure / bounded work.** No queue, no concurrency cap, no overload
  mode — because there's no fan-in to overload it.
- **No memory/GC concern.** Markdown files into 512-char chunks; nothing
  retained, nothing that pressures the heap.
- **No client/rendering perf.** This is a CLI. No bundle, no main thread, no
  paint.

Every one of these flips from "correct verdict" to "real gap" the moment buffr
stops being single-device. The audit names exactly when.

## Reading order

1. `audit.md` — the 8-lens walk. Start here; it's the map.
2. `01-hnsw-approximate-search.md` — the one real win.
3. `02-embedding-http-roundtrip.md` — where indexing time goes.
4. `03-per-chunk-insert-loop.md` — the write path.
5. `04-connection-pool-reuse.md` — why the SQL burst is cheap.
6. `05-no-caching.md` — the lever not yet pulled.

## Cross-links

- **`study-database-systems`** — HNSW as an index *type*, how `<=>` plans, txn
  and isolation mechanics, `COPY` vs INSERT at the storage-engine level. This
  guide measures the index; that guide explains it.
- **`study-networking`** — the `/api/embed` HTTP call, connection pooling, TLS,
  timeouts, retries. This guide names the round-trip as a cost; that guide
  explains the transport.
- **`study-runtime-systems`** — the `for…await` serialization in `index-cmd`,
  the event loop, `Promise.all` in the trace flush. This guide says the loop is
  serial; that guide explains why and how to overlap it.
