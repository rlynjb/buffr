# Study — Performance Engineering · buffr-laptop

What is measurably slow or expensive in this repo, why, and which change improves it
without just moving the bottleneck. Grounded in the real files — no invented scale.

This is a self-hosted, single-device personal RAG agent: Postgres + pgvector (HNSW
cosine), Ollama-served embeddings (`nomic-embed-text:v1.5`, 768-dim) and generation
(`gemma2:9b`), a long-lived Ink chat session. There is no load, no traffic, no SLA.
That fact shapes every verdict below: most "costs" here are real but **don't matter at
laptop scale yet** — and the guide says so honestly rather than inflating them.

## Reading order

```
  1. 00-overview.md   the map: where time and money go, ranked findings
  2. audit.md         Pass 1 — the 8-lens walk, "not yet exercised" named honestly
  3. 01..06           Pass 2 — the six performance patterns this repo actually exercises
```

## Pass 2 — the patterns this repo exercises

```
  01-hnsw-approximate-search.md      sub-linear ANN recall — the main perf win, untuned
  02-embedding-roundtrip.md          batched-per-doc embed, serial-across-files index
  03-per-chunk-insert-loop.md        one INSERT per chunk inside a txn (no COPY / multi-row)
  04-connection-pool-reuse.md        warm pg pool amortized across a whole chat session
  05-per-turn-memory-and-trace-cost.md  the extra embed+upsert and write-amplified trace
  06-no-caching.md                   identical query re-embeds every time (the absent layer)
```

The file list is the artifact: a senior engineer skimming it sees what's interesting
about this repo's performance shape before opening anything.

## Cross-links — adjacent guides

```
  study-database-systems   HNSW internals, txn/durability, index storage  ← the mechanism
  study-networking         Ollama HTTP roundtrip, pg wire, pooling        ← the transport
  study-ai-engineering     embeddings, RAG retrieval, eval harness        ← the AI layer
```

A finding belongs to the generator that owns the mechanism. This guide MEASURES; it
cross-links rather than re-teaching how HNSW or TCP pooling work internally.
