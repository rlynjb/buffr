# 03 — Retrieval and RAG

**Anchor:** LLM application engineering (loopd-shaped). buffr retrieves over a personal markdown corpus indexed into pgvector.

This is the heart of buffr. Everything else — the agent loop, the memory, the evals — exists to serve or measure this pipeline. Two paths matter, and they're mirror images:

```
  the two retrieval paths in buffr

  INDEX (offline, npm run index)        QUERY (per agent tool-call)
  ─────────────────────────────         ──────────────────────────
  text                                  question
   │ chunk (512/64 char)                 │ embed
   ▼                                     ▼
  chunks                                768-dim vector
   │ embed (768-dim)                     │ ANN (HNSW cosine)
   ▼                                     ▼
  pgvector upsert                       top-k chunks
   │                                     │ score = 1 - distance
   ▼                                     ▼
  agents.chunks                         grounded answer
```

## Reading order

The concepts are mostly self-contained, but read these in order for the buffr story:

1. `01-embeddings.md` — the 768-dim vector, what cosine distance measures.
2. `02-embedding-model-choice.md` — why `nomic-embed-text:v1.5`, why 768 is a one-way door.
3. `03-chunking-strategies.md` — the fixed 512/64-char window aptkit uses (and its limits).
4. `04-vector-databases.md` — pgvector in the same Postgres, HNSW, the dropped FK.
5. `11-rag.md` — the full pipeline, end to end. **The capstone of this section.**
6. `10-incremental-indexing.md` — the index path as it runs today (full re-embed per file).

## Exercised vs not

**Exercised:** embeddings, embedding-model choice, vector DB (pgvector), chunking (aptkit's default), RAG, incremental indexing (per-file upsert).

**Not yet exercised** (study material + Case-B exercises): dense-vs-sparse (`05`), hybrid + RRF (`06`), reranking (`07`), query rewriting / HyDE (`08`), stale-embedding tracking (`09`), GraphRAG (`12`). buffr is dense-only, single-stage, no rewrite, no staleness column. Each file is honest about that and names the move.

## See also

- `../04-agents-and-tool-use/` — the loop that calls retrieval as a tool.
- `.aipe/study-database-systems/` — pgvector storage, HNSW internals, cosine distance at the SQL layer.
- `.aipe/study-dsa-foundations/` — vectors, cosine similarity, ANN vs exact k-NN.
