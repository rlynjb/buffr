# Study — Performance Engineering (buffr-laptop)

What is measurably slow or expensive in this repo, why, and which change improves it without just moving the bottleneck somewhere else.

This is an **audit-style** guide. One audit walks the 8 lenses; the numbered files each deep-dive one performance pattern the repo actually exercises.

## Reading order

```
  00-overview.md   ← start here: the map, ranked findings, what's not measured yet
  audit.md         ← Pass 1: the 8-lens walk, file:line grounded
  ───────────────────────────────────────────────────────────
  01-hnsw-approximate-search.md          the main latency win (untuned)
  02-embedding-roundtrip.md              batched-per-doc, serial-across-files
  03-per-chunk-insert-loop.md            one INSERT per chunk in a txn
  04-connection-pool-reuse.md            one warm pool across a session — now also a bounded-shutdown story
  05-per-turn-memory-and-trace-cost.md   the write amplification per chat turn
  06-no-caching.md                       the RAG path re-embeds every time (still true)
  07-connector-fan-out.md                /research + /investing gather concurrently, not serially
  08-connector-result-caching.md         every external connector sits behind a TTL cache
```

## How to read a finding

Every claim is anchored to a real `file:line`. The discipline throughout: **name the cost, then say whether it matters at laptop scale.** Most of these costs are real and most of them don't matter yet — because the dominant per-turn cost is `gemma2:9b` generation, which Ollama owns and this repo doesn't control. A finding that can't name a number it would change stays in the audit; it doesn't get a pattern file.

## The standard-term-leads convention

These files lead with the established industry term and put the repo's local name in parens on first use — "approximate nearest-neighbour search (the HNSW index)", "the connection pool (`pg.Pool`)", "write amplification (the 6-event trace fan-out)", "batching (the per-doc embed call)". After first mention the local name stands alone. You learn the transferable word, then bind it to this repo.

## Cross-links to neighbouring guides

- **`study-database-systems`** — the storage-engine mechanics underneath: how the HNSW index actually traverses its graph, what `begin`/`commit` costs, MVCC, and why a multi-row INSERT beats a loop. This guide *measures* those; that guide *explains* them.
- **`study-networking`** — the transport layer under every Ollama call, every `pg` query, and every connector's HTTP call: connection reuse, the HTTP roundtrip to `/api/embed`, timeouts, pooling. The serialization and fan-out findings here bottom out in network behaviour there.
- **`study-ai-engineering`** — the retrieval pipeline, embedding model choice, eval harness, and the RAG shape these costs hang off. Why precision@k matters, what `nomic-embed-text` is doing, where caching would change eval cost.
- **`study-frontend-engineering`** — the OpenTUI rendering mechanics behind the live progress panel (`07`'s UI counterpart) and the raw-mode terminal input handling behind `04`'s Ctrl+C fix. This guide notes both exist and why they matter for perceived latency / exit reliability; that guide owns how they're built.
- **`study-debugging-observability`** — the trace sink and `ProgressEvent` stream as observability mechanisms, and the "process won't exit" class of failure `04`'s bounded shutdown now guards against.

## Partition seam

This guide measures and improves observed bottlenecks. It does **not** explain execution mechanisms (that's `study-runtime-systems`) or architecture-scale tradeoffs (that's `study-system-design`). When a finding bottoms out in "how does pgvector's HNSW graph traverse," it cross-links rather than re-teaching.
