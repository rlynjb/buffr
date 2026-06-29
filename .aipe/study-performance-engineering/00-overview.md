# Overview — where time and money go in buffr-laptop

Before any lens: here's the whole machine in one frame, with the cost annotated on each
hop. Read this, and the audit and pattern files just zoom into the boxes.

```
  buffr-laptop — the two hot paths, cost per hop

  ┌─ CLI / Session layer ───────────────────────────────────────────────┐
  │                                                                       │
  │  PATH A — indexing (npm run index)        PATH B — chat turn (ask())  │
  │  index-cmd.ts                              session.ts ask()           │
  │   for path of paths  ← SERIAL              persistMessage  (1 INSERT) │
  │     read file                              agent.answer()            │
  │     embed all chunks ← 1 HTTP call           ├─ embed query (1 HTTP) │
  │     upsert chunks    ← N INSERTs/txn         ├─ HNSW search (1 query)│
  │                                              └─ gemma2 generate (HTTP)│
  │                                            trace.flush() ← 6 ev types │
  │                                            memory.remember            │
  │                                              ├─ embed exchange (HTTP) │
  │                                              └─ upsert      (1 INSERT)│
  └───────────────┬───────────────────────────────────────┬─────────────┘
                  │ pg wire (warm pool, db.ts)             │ HTTP :11434
    ┌─────────────▼──────────────┐            ┌────────────▼─────────────┐
    │ Storage — Postgres+pgvector│            │ Provider — Ollama        │
    │  HNSW cosine (UNTUNED)      │            │  nomic-embed (768d)      │
    │  agents.chunks             │            │  gemma2:9b generate      │
    └────────────────────────────┘            └──────────────────────────┘

  the dominant cost on Path B is gemma2 generation (seconds, GPU-bound),
  not anything in this repo's own code. that framing matters.
```

## The verdict, first

The single biggest cost on a chat turn is **`gemma2:9b` generation** — seconds of
GPU work inside Ollama, owned by the model, not by buffr's code. Embedding is a distant
second. Everything this repo *itself* controls (the SQL, the pool, the trace inserts) is
sub-millisecond-to-low-millisecond at single-device scale. So the honest headline is:
**the code in this repo is not the bottleneck.** The bottleneck is the LLM, and that's
inherent to running a 9B model locally.

That doesn't make the patterns uninteresting — it makes them *correctly prioritized*.
The one place buffr leaves measurable performance on the table is the **serial-across-files
indexing loop** (Path A), where the GPU sits idle through every database write.

## Ranked findings

```
  rank  finding                          where                    matters at laptop scale?
  ────  ───────────────────────────────  ───────────────────────  ────────────────────────
   1    serial-across-files indexing     index-cmd.ts:22-26       YES — GPU idle between
         (file N+1 waits on file N's                               files; the one real win
         commit; embed↔write don't                                on the indexing path
         overlap)                                                  → 02-embedding-roundtrip
   2    HNSW index is untuned            sql/001:28-29            NOT YET — defaults are
         (no m / ef_construction set,                             fine for a small corpus;
         no ef_search at query time)                              becomes real past ~10^5
         → 01-hnsw-approximate-search                             chunks. Worth knowing now.
   3    no caching layer                 (absent)                 NO — but identical query
         (identical query re-embeds                               re-embeds every time; a
         every turn, ~free to fix)                                trivially cacheable cost
         → 06-no-caching                                          → 06-no-caching
   4    per-chunk INSERT loop            pg-vector-store.ts:43-57 NO — round-trips inside
         (no multi-row / COPY)                                    one txn; fine for tens of
         → 03-per-chunk-insert-loop                               chunks, not for bulk load
   5    per-turn memory + trace cost     session.ts:66 /          NO — an extra embed+upsert
         (extra embed+upsert + 6-event   trace-sink.ts:53-85      and several INSERTs per
         write-amplified trace)                                   turn, dwarfed by gemma2
         → 05-per-turn-memory-and-trace-cost
```

The win nobody names: the **warm connection pool** (`db.ts` + `session.ts:39`). The
Postgres handshake (TCP + auth + TLS) happens once and is reused across the entire
session. That's a real latency cost *avoided* — the most load-bearing perf decision in
the repo, and it's invisible because it works. → `04-connection-pool-reuse`.

## Not yet exercised — say it plainly

This repo has shipped zero performance *measurement* infrastructure. None of these exist,
and the audit names each one rather than pretending:

```
  ✗ performance budget        no p95/p99 target, no latency SLA, no "must answer in N s"
  ✗ baselines / before-after  durationMs + tokens are PERSISTED but never read back
                              (trace-sink.ts:69, 76 → agents.messages, never aggregated)
  ✗ profiling / flamegraphs   no profiler, no flame graph, no CPU/heap sampling
  ✗ load testing              single-device, single-conversation; no concurrency, no rps
  ✗ tail behavior (p95/p99)   no distribution captured; one user, one turn at a time
  ✗ caching layer             no embed cache, no query cache, no result memoization
```

The most fixable gap is the third row of the budget table: buffr already writes
`durationMs` and `tokens_used` to `agents.messages` on every turn (trace-sink.ts), then
never queries them. The baseline is *sitting in the database, unused*. Reading it back is
the cheapest performance win available and the natural next step.

## Cross-links

- `study-database-systems` — how HNSW actually indexes and searches; txn/WAL/durability
  behind the per-chunk loop.
- `study-networking` — the Ollama HTTP roundtrip, pg wire protocol, and pool mechanics
  behind the latency numbers.
- `study-ai-engineering` — embeddings, retrieval pipeline, and the precision@k eval that
  is the closest thing to a baseline here.
