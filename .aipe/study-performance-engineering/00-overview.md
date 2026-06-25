# Performance Engineering — Overview

`buffr-laptop` is a single-device RAG agent. There's no traffic, no SLA, no
second user. That changes what "performance" even means here: nothing is
contended, nothing is hot, and the only clock that runs is *your* patience
waiting for an `index` to finish or a `chat` turn to answer at the terminal. So this guide is
honest about scale. Most of the lenses a server-side perf audit would light up
(p95 budgets, backpressure, queue depth, GC pressure) are `not yet exercised` —
and that's the correct verdict, not a gap to apologize for.

What's left after stripping the server-shaped lenses is still real, and it's
where the actual time goes: **embeddings over HTTP** and **Postgres round-trips**.

```
  Where the wall-clock time actually goes — buffr at laptop scale

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  npm run index -- *.md        npm run chat  (interactive)    │
  └─────────┬───────────────────────────────┬────────────────────┘
            │ one file at a time            │ many turns, one session
  ┌─ Pipeline (aptkit) ───────────▼─────────▼────────────────────┐
  │  chunk → embed → upsert       per turn: embed → search →      │
  │                               LLM loop → memory embed+upsert  │
  └─────────┬───────────────────────────────┬────────────────────┘
            │ HTTP  ◄── DOMINANT COST ──►    │ HTTP (×2 embeds/turn)
  ┌─ Ollama (localhost:11434) ────▼──────────▼───────────────────┐
  │  nomic-embed-text (embed)     gemma2:9b (generate, the slow   │
  │                               one on a laptop GPU/CPU)        │
  └──────────────────────────────────────────────────────────────┘
            │ SQL (one warm pool, held across the whole session)
  ┌─ Postgres + pgvector ─────────▼──────────────────────────────┐
  │  HNSW index on chunks.embedding  ←── the main perf WIN        │
  │  per-chunk INSERT loop inside a txn  ←── a small perf cost    │
  │  per-turn: memory upsert + ×n trace INSERTs  ←── added writes │
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

4. **One warm pool carries an entire chat session's query stream — the win
   strengthened.** `chat` (`src/session.ts`) holds *one* `pg.Pool`
   (`src/db.ts:4-5`, created at `session.ts:39`) and *one* conversation across
   every turn, until `close()` (`session.ts:73`). Setup (`loadProfile` +
   `startConversation`, `session.ts:47,55`) pays once; then *each turn* fires
   `persistMessage` + vector `search` + the trace `flush` + a new per-turn
   `memory.remember` upsert (`session.ts:61-66`) over that same pool — no
   per-query reconnect, no TLS handshake per statement, for the life of the
   session. The old one-shot `ask` amortized the handshake over a single burst;
   the long-lived session amortizes it over a whole conversation. Two added
   per-turn costs ride along: the memory embed+upsert (finding below) and a
   trace `flush` that now writes *several* INSERTs per turn (all 6 event types,
   `src/supabase-trace-sink.ts:56-84`) instead of ~2 — minor write
   amplification, all on the warm pool. A quiet win, not a problem.
   → `04-connection-pool-reuse.md`

5. **No caching anywhere — identical queries re-embed and re-search every
   time.** Ask the same question twice in `chat` and you pay the embed HTTP call
   and the HNSW search twice (now also a second memory embed per turn). There is
   no query-vector cache, no result cache, no memoization. At single-user laptop
   scale this is fine; named here because it's the first thing that becomes wrong
   the moment this serves more than one caller. → `05-no-caching.md`

6. **`durationMs` is the only latency instrument — and the trace sink now
   PERSISTS it.** aptkit's tool registry wraps every tool call in
   `performance.now()` (`tool-registry.js:21-23`) and emits `durationMs` on the
   `tool_call_end` event. The trace sink now captures it — the
   `tool_call_end` handler writes `durationMs` (and `error`) into the message's
   `tool_results` jsonb (`src/supabase-trace-sink.ts:67-71`), and the
   `model_usage` handler fills the previously-orphaned `tokens_used` column
   (`src/supabase-trace-sink.ts:73-78`). The latency number is no longer dropped
   on the floor — though buffr still has no harness that *reads it back* to form
   a baseline. → see `audit.md` § measurement-baselines-and-profiling.

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
5. `04-connection-pool-reuse.md` — why the SQL stream is cheap across a session.
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

---

Updated: 2026-06-24 — `npm run ask`/`ask-cmd.ts` → `npm run chat` (`chat.tsx` +
`session.ts`). Diagram and findings reframed to the long-lived chat session: one
pool/conversation across many turns (finding 4 strengthened). Added the per-turn
memory embed+upsert (`session.ts:53,66`) and trace write-amplification (all 6
event types → ×n INSERTs/turn). Finding 6 corrected: the trace sink now PERSISTS
`durationMs` + `tokens_used` (`supabase-trace-sink.ts:67-78`) rather than dropping
them. HNSW / per-chunk-insert / no-caching / serial-across-files findings
re-verified unchanged.
