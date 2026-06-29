# 03 · Retrieval and RAG

> How buffr answers from *your* corpus instead of from the model's memory — the core of the whole system.

This is the heart of buffr. Everything else — the context window, the agent loop, the eval harness — exists to serve one machine: a pipeline that retrieves evidence from your indexed documents and forces the model to answer from it, with citations, or refuse. You shipped a pgvector RAG app before, so the *shape* lands fast. These twelve files slow down on the *mechanism* and, just as importantly, on the parts buffr **doesn't** do yet.

```
03-retrieval-and-rag/
│
│  FOUNDATIONS ──────► STORE ──────► THE GAPS (Case B) ──────► THE WHOLE
│
├── 01-embeddings.md            ★ text → 768-dim vector; cosine = angle
├── 02-embedding-model-choice.md★ nomic:v1.5; the 768 ONE-WAY DOOR (4 guards)
├── 03-chunking-strategies.md   ★ fixed 512/64; deterministic, untuned (honest)
├── 04-vector-databases.md      ★ pgvector + HNSW; the dropped-FK soft link
│
├── 05-dense-vs-sparse.md       ◇ buffr is PURE DENSE; no BM25  (Case B)
├── 06-hybrid-retrieval-rrf.md  ◇ RRF fusion; NOT implemented   (Case B)
├── 07-reranking.md             ◇ single-stage ANN; no rerank   (Case B)
├── 08-query-rewriting-hyde.md  ◇ embeds RAW question; no rewrite (Case B)
├── 09-stale-embeddings.md      ◇ no staleness tracking; real risk (Case B)
├── 10-incremental-indexing.md  ◇ incremental-by-file; no delete/detect (Case B)
│
├── 11-rag.md                   ★★ THE CENTERPIECE — full pipeline, grounding,
│                                  citations, fallback, above-threshold rule
└── 12-graphrag.md              ◇ no entity/relation graph; meta.kind = seed (Case B)

  ★ = implemented in buffr (Case A)      ◇ = named gap, primary build target (Case B)
```

## Reading order

Read in number order. They build a foundation, then the store, then the honest gaps, then assemble the whole.

1. **`01-embeddings.md`** — the geometric primitive. Text becomes a 768-dim direction; cosine compares angles. Everything else moves these vectors around.
2. **`02-embedding-model-choice.md`** — the one-way door. The embedding model is welded shut at four assert sites; changing it is a corpus migration.
3. **`03-chunking-strategies.md`** — what becomes one vector. buffr's fixed-512 splitter is deterministic, vendor-neutral, and honestly never tuned.
4. **`04-vector-databases.md`** — where vectors live and how HNSW searches them. Includes the deliberately dropped foreign key.
5. **`05`–`06` (dense/sparse → hybrid)** — buffr is pure dense; the exact-token blind spot, and how RRF would fuse in a sparse channel.
6. **`07-reranking.md`** — the precision stage buffr lacks; recall vs. precision as two models' jobs.
7. **`08-query-rewriting-hyde.md`** — the query side; buffr embeds the raw question and eats the vocabulary gap.
8. **`09`–`10` (stale → incremental)** — keeping the corpus fresh; buffr's refresh is correct but manual, with no delete handling.
9. **`11-rag.md`** — **read this last among the core.** The full machine assembled: index path, query path, the grounding contract, the bounded loop, citations, the fallback, and the rule for when *not* to use RAG.
10. **`12-graphrag.md`** — the furthest gap; relationship/multi-hop retrieval buffr has only seeded via `meta.kind`.

If you read only one file, read **`11-rag.md`** — it's the centerpiece, and every other file is either a component it depends on or a quality lever that plugs into it.

## Phase 2A / 2B anchor

The driving exercises for this sub-section split across two phases:

> **Phase 2A — strengthen the implemented core** ([B2A.x], cite [C2.1]–[C2.3], [C2.10])
> Make the existing pipeline *measured and guarded*: visualize the embedding space, sweep chunk size, prove HNSW is used, add the model-name guard, and **measure grounding faithfulness** — the RAG core works but is largely unmeasured.

> **Phase 2B — close the named retrieval gaps** ([B2B.x], cite [C2.4]–[C2.9], [C2.11])
> Build what buffr honestly lacks: a sparse channel + RRF, a reranking stage, query rewrite/HyDE, staleness tracking + idle re-embed, delete/change-detection, and an entity-extraction seed toward GraphRAG.

**The honest state, stated plainly:** buffr's RAG *core* — grounded, cited, refusable, bounded — is real and complete (Case A). But buffr is **pure dense, single-stage, raw-query, no-rerank, no-hybrid, with no staleness tracking, no delete handling, and no knowledge graph** (Case B). Those aren't oversights to apologize for — they're the clean, named seams this sub-section exists to fill, and every one plugs into `11-rag.md`'s pipeline *without changing the grounding contract*.

## Cross-links

- **`../02-context-and-prompts/`** — retrieval is how buffr keeps the 8192-token window from overflowing. `02-lost-in-the-middle.md` points at `./07-reranking.md` for the not-yet-built best-chunk-placement fix; `03-prompt-chaining.md` is where `./08-query-rewriting-hyde.md`'s rewrite stage slots in.
- **`../04-agents-and-tool-use/`** — `runAgentLoop` (`maxTurns:6`, `maxToolCalls:4`, forced synthesis), the least-privilege `search_knowledge_base`-only tool policy, and the across-turns view of the RAG loop.
- **`../05-evals-and-observability/`** — `eval/queries.json`, P@1/R@3, and the faithfulness/fallback-rate metrics that decide whether any Phase 2B lever earns its place. Every "measure first" exercise here lands there.
- **`../../study-database-systems/`** — HNSW, EXPLAIN/query planning, the idempotent `on conflict` upsert, transactions, full-text search (the sparse channel), cache invalidation (stale embeddings), and change-data-capture (incremental indexing).
- **`../../study-dsa-foundations/`** — vectors and distance metrics (embeddings), graph search and skip-lists (HNSW), merging ranked lists (RRF), and graph traversal (GraphRAG).
