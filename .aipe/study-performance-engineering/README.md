# Study — Performance Engineering

Measurement and optimization of `buffr-laptop`: budgets, baselines, profiling,
latency, throughput, memory, I/O, caching, batching, backpressure, cost — applied
to this repo's real files, not in the abstract.

The honest frame up front: this is a **single-device CLI RAG agent**. No traffic,
no SLA, no second caller. So most server-shaped performance lenses come back
`not yet exercised` — and that's the correct verdict, named with the condition
that would make each one matter. What's left is real and is where the wall-clock
time actually goes: **embedding over HTTP** and **Postgres round-trips**, with
**HNSW approximate search** as the one deliberate performance win.

## Reading order

1. **`00-overview.md`** — the map: ranked findings, where time goes, the
   `not yet exercised` list. Start here.
2. **`audit.md`** — Pass 1, the 8-lens walk (budget · baselines/profiling ·
   latency/throughput/tail · cpu/memory · I/O & DB · caching/batching/backpressure
   · rendering · red-flags). Each lens grounded in `file:line` or honestly
   `not yet exercised`.

Then the Pass 2 pattern files, the patterns this repo actually exercises:

3. **`01-hnsw-approximate-search.md`** — the one real perf win. Sub-linear
   retrieval via the HNSW graph index; untuned (`m` / `ef_search` at defaults).
4. **`02-embedding-http-roundtrip.md`** — where indexing time lives. Chunks batch
   into one `/api/embed` call (already done); files serialize (the open lever).
5. **`03-per-chunk-insert-loop.md`** — the write path: row-at-a-time INSERTs in a
   transaction; the multi-row INSERT it isn't. Lowest-consequence finding.
6. **`04-connection-pool-reuse.md`** — the quiet win: one warm `pg.Pool` carries
   an ask's whole query burst; handshake paid once per process.
7. **`05-no-caching.md`** — the lever not yet pulled: identical asks re-embed and
   re-search every time. Correct at single-user scale; named with its trigger.

## What this guide measures vs what neighbors explain

This generator **measures and improves observed bottlenecks**. It does not
re-teach the mechanisms underneath them — it cross-links to the generators that
own those:

- **`study-database-systems`** — HNSW as an index *type*, how `<=>` plans, `COPY`
  vs multi-row INSERT, transaction/connection mechanics. *This guide measures the
  index and the write; that guide explains the storage engine.*
- **`study-networking`** — the `/api/embed` HTTP transport, connection pooling,
  TLS, timeouts, retries. *This guide names the round-trip as the dominant cost;
  that guide explains the transport.*
- **`study-runtime-systems`** — the `for…await` serialization in `index-cmd`, the
  event loop, `Promise.all` overlap, the trace flush. *This guide says the index
  loop is serial; that guide explains why and how to overlap it.*

## The one-line takeaway

The performance story of buffr is: **HNSW makes retrieval fast on purpose
(untuned), embedding HTTP makes indexing slow by necessity (batched within docs,
serial across them), Postgres is cheap (pooled, per-chunk inserts), and there's
no caching or measurement yet — all correct for one user, each with a named
trigger that flips it.**
