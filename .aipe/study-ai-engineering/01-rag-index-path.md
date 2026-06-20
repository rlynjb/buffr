# RAG index path — chunk → embed → pgvector upsert

**Industry name(s):** RAG ingestion / indexing pipeline · Language-agnostic pattern.

## Zoom out, then zoom in

Before the agent can answer anything, the corpus has to exist as searchable vectors. The index path is the write side of RAG — it runs when you point `npm run index` at a markdown file, and it never runs again until you re-index. Here's where it sits.

```
  Zoom out — where the index path lives

  ┌─ CLI layer ──────────────────────────────────────────────┐
  │  index-cmd.ts   →   ★ INDEX PATH ★   (write side of RAG)  │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  doc text
  ┌─ Library layer ───────────▼──────────────────────────────┐
  │  RetrievalPipeline.index()  →  chunkText  →  embedder     │
  └───────────────────────────┬──────────────────────────────┘
                              │  768-dim vectors
  ┌─ Provider layer ──────────▼──────────────────────────────┐
  │  nomic-embed-text (Ollama)                                │
  └───────────────────────────┬──────────────────────────────┘
                              │  upsert
  ┌─ Storage layer ───────────▼──────────────────────────────┐
  │  agents.documents (source of truth) + agents.chunks(HNSW) │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the index path turns one document into N searchable rows. It does two writes — the whole document into `documents` (so you keep the source of truth), and one row per chunk into `chunks` (so you can retrieve a *passage*, not a whole file). The chunk is the unit of retrieval; everything downstream depends on getting that granularity right.

## Structure pass

Three layers, one axis held constant: **who owns the data at each layer, and is it mutable?**

```
  Axis traced = "who owns the data, is it mutable?"

  ┌─ CLI: indexDocumentRow ─────────────┐  owns nothing — orchestrates
  │  reads file, calls two writers       │  → transient, per-invocation
  └──────────────────┬───────────────────┘
                     │  seam ① — buffr code ═╪═ library pipeline
  ┌─ Pipeline: index() ─────────────────┐  owns the chunk shape
  │  chunkText → embed → store.upsert    │  → derived, regenerable
  └──────────────────┬───────────────────┘
                     │  seam ② — library ═╪═ pgvector (the durable line)
  ┌─ Storage: documents + chunks ───────┐  owns the durable truth
  │  documents = canonical, chunks =     │  → documents immutable-ish,
  │  derived & re-derivable              │    chunks fully derived
  └──────────────────────────────────────┘
```

Two seams matter. **Seam ①** is where buffr's `indexDocumentRow` hands off to the library's `pipeline.index()` — buffr owns the `documents` write, the library owns chunking and the `chunks` write. **Seam ②** is the durability line: above it everything is regenerable from the document text; below it is the only state you can't rebuild for free (the embeddings, which cost an Ollama round-trip each). The load-bearing insight: `documents` is the source of truth, `chunks` is a *cache of derived vectors* — and like any cache, it can go stale or get orphaned.

## How it works

The mental model first. You know how a build step compiles source into artifacts you ship — `.ts` → `.js`, and you can always rebuild from source? Same shape. The document text is source; the chunks-with-embeddings are the built artifact. The index path is the build.

```
  The index path — one document fans out to N chunk rows

  doc.text  ("# Work\nI build RAG systems...")
     │
     ▼  chunkText (fixed 512-char windows, 64 overlap)
     │
   ["...chunk 0...", "...chunk 1...", "...chunk 2..."]
     │
     ▼  embedder.embed(texts)  — one Ollama call, batched
     │
   [[v0_768], [v1_768], [v2_768]]
     │
     ▼  zip text+vector+index → id = "<docId>#<i>"
     │
   store.upsert([{id:"work.md#0", vector:v0, meta:{...}}, ...])
     │
     ▼  one BEGIN/COMMIT transaction
     │
   agents.chunks rows (embedding vector(768), HNSW-indexed)
```

### Step 1 — buffr writes the source-of-truth document row

Before any chunking, `indexDocumentRow` writes the *whole* document to `agents.documents` with an upsert. This is buffr's own layer, not the library's — the library's pipeline has no notion of a "document row," it only knows chunks. buffr adds the canonical-source table on top so you never lose the original text. Boundary condition: if this insert fails, nothing is chunked — the document row is the gate.

### Step 2 — the library chunks the text

`pipeline.index()` calls `chunkText`. The strategy is **fixed-size-by-character**: 512-char windows with 64 chars of overlap carried between them. Why character-fixed and not token- or sentence-based? It's deterministic and needs no tokenizer dependency — the right default for a from-scratch pipeline. The overlap is load-bearing: a fact that straddles a 512-char boundary would be split across two chunks and lost from both; the 64-char overlap keeps it whole in at least one.

```
  Overlap keeps a boundary-straddling fact whole

  ...I take my coffee black, no sugar, every morning...
                    │ 512-char boundary falls here │
  chunk 0:  ...I take my coffee black, no sug|
  chunk 1:        |coffee black, no sugar, every morning...
                  └── 64-char overlap ──┘
                  the fact "black no sugar" survives in chunk 1
```

### Step 3 — the library embeds every chunk in one call

`embedder.embed(texts)` sends all chunk texts to nomic-embed-text in a single batched Ollama request and gets back one 768-dim vector per chunk. Boundary condition: the pipeline asserts the embedder's dimension matches the store's dimension *before* embedding (`assertWiring`), so you can never produce vectors the store can't hold. → see `05-embedding-model-choice.md`.

### Step 4 — buffr's store upserts the chunks transactionally

`PgVectorStore.upsert` opens one transaction, loops the chunks, and does `insert ... on conflict (id) do update`. The chunk id `<docId>#<index>` is deterministic, so re-indexing the same file overwrites the same rows instead of duplicating them — that's what makes re-index idempotent. The vector is serialized to pgvector's text literal `[0.1,0.2,...]` and cast `$6::vector`. Boundary condition: dimension is asserted again per chunk (`assertDim`) before any write — a mismatch throws and the transaction rolls back, never a silent truncation.

### Move 2.5 — the orphaned-chunk gap (current state vs the fix)

Here's the part that bites. Chunk ids are `<docId>#<index>`. Upsert overwrites matching ids — but it never *deletes*.

```
  Re-indexing a shrunk document leaves orphans

  v1: doc is 3 chunks → work.md#0, work.md#1, work.md#2
  v2: edit shrinks it to 2 chunks → work.md#0, work.md#1
      upsert overwrites #0, #1 ✓
      work.md#2 from v1 is NEVER touched → orphan
      (stale content, still searchable, still cited)
```

Current state: the orphan stays in `chunks`, still has a valid embedding, and can still be returned by search and cited as if current. The fix is a delete-then-upsert (or `delete from chunks where document_id = $1` inside the same transaction before the upsert loop). It's a small change with a real correctness payoff.

### Move 3 — the principle

The index path is a build step over a cache of derived state. The discipline that generalizes: treat your vector table as derived-and-regenerable, keep the canonical source separately, and make every re-index either fully replace a document's chunks or be honest that it doesn't. buffr keeps the source (good) but does partial replacement (the gap).

## Primary diagram

The whole index path, every layer labeled.

```
  buffr index path — full recap

  ┌─ CLI: src/cli/index-cmd.ts ────────────────────────────────┐
  │  readFile(path) → indexDocumentRow(pool, appId, pipeline,  │
  │                     {id: basename(path), text, sourcePath})│
  └───────────────────────────┬────────────────────────────────┘
            write A            │            delegate B
   ┌────────────────────┐      │      ┌──────────────────────────┐
   │ agents.documents   │◄─────┴─────►│ pipeline.index(doc)      │
   │ (source of truth)  │             │  chunkText (512/64)      │
   └────────────────────┘             │  embedder.embed → 768-d  │
                                      │  upsert chunks           │
                                      └─────────────┬────────────┘
                                                    ▼
                                      ┌──────────────────────────┐
                                      │ agents.chunks            │
                                      │  id "<docId>#<i>"        │
                                      │  embedding vector(768)   │
                                      │  HNSW vector_cosine_ops  │
                                      └──────────────────────────┘
```

## Implementation in codebase

**Use cases.** Run when you build or refresh the personal corpus: `npm run index -- eval/corpus/work.md eval/corpus/coffee.md`. Each file becomes one `documents` row and N `chunks` rows. Re-running on an edited file refreshes its chunks in place (idempotent on id).

**Code side by side.**

```
  src/cli/index-cmd.ts  (lines 17–26)

  const embedder = new OllamaEmbeddingProvider({           ← 768-dim provider
    model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
  const store = new PgVectorStore({                        ← Postgres-backed store
    pool, appId: cfg.appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });
        │                                                  ← wiring asserts dims match
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    await indexDocumentRow(pool, cfg.appId, pipeline,      ← write doc + index chunks
      { id: basename(path), text, sourcePath: path });
  }
       │
       └─ dimension is read FROM the embedder, not hardcoded — the embedder
          is the single source of the 768 (one-way door, see 05)
```

```
  src/runtime.ts  (lines 11–17)

  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, ...`,  ← canonical write
    [doc.id, appId, doc.sourcePath ?? null, doc.text]);
  await pipeline.index({ id: doc.id, text: doc.text });    ← then chunk+embed+upsert
       │
       └─ two writes, NOT one transaction across both — documents commits before
          chunks even start. If indexing throws, the documents row is already
          written without its chunks (a small atomicity gap, named honestly)
```

```
  src/pg-vector-store.ts  (lines 38–58, upsert)

  for (const c of chunks) this.assertDim(c.vector);        ← fail before any write
  await client.query('begin');
  for (const c of chunks) {
    await client.query(
      `insert into agents.chunks (id, document_id, app_id, chunk_index,
         content, embedding, ...) values ($1,$2,$3,$4,$5,$6::vector,...)
       on conflict (id) do update set ...`, [...]);          ← idempotent on id
  }
  await client.query('commit');
       │
       └─ assertDim runs on ALL chunks before begin — so a dimension bug
          rolls back the whole batch instead of half-writing it
```

## Elaborate

This pattern comes from the standard RAG ingestion shape: documents are too big to embed whole (and too coarse to retrieve usefully), so you split them into chunks, embed each, and store the vectors next to enough metadata to cite the source. The library's choice to make `chunkText` deterministic and tokenizer-free is the pragmatic call — it trades retrieval-quality headroom (a semantic splitter would chunk on meaning boundaries) for simplicity and testability. buffr inherits that choice unchanged.

The orphaned-chunk gap connects to the spec's "stale embeddings" and "incremental indexing" concepts: buffr does incremental-by-invocation indexing but lacks the delete half of a clean delta. The fix is small; the lesson — derived caches need a deletion story, not just an upsert story — is general.

What to read next: `05-embedding-model-choice.md` (why 768 is fixed and what re-indexing the whole corpus would cost), then `02-rag-query-path.md` (the read side that consumes these rows).

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so no `[Bx.y]` provenance IDs are cited. Exercises name the buildable target directly.

### Close the orphaned-chunk gap

- **What to build:** Delete a document's existing chunks before re-upserting, inside the same transaction, so re-indexing a shrunk document leaves no stale chunks.
- **Why it earns its place:** "I found a silent staleness bug in my own index path and closed it transactionally" is a concrete correctness story — exactly the kind of detail that signals you built the thing, not just wired a tutorial.
- **Files to touch:** `src/pg-vector-store.ts` (add a `deleteByDocument` or fold a delete into `upsert`), `src/runtime.ts` (call it before `pipeline.index`).
- **Done when:** a test indexes a 3-chunk doc, re-indexes a 2-chunk version, and asserts `select count(*) from chunks where document_id = $1` returns 2, not 3.
- **Estimated effort:** 1–4hr.

### Make documents + chunks one atomic unit

- **What to build:** Wrap the `documents` insert and `pipeline.index` chunk writes in a single transaction so a failed embed never leaves a document row without chunks.
- **Why it earns its place:** Demonstrates you understand the atomicity seam between buffr's canonical table and the library's derived table.
- **Files to touch:** `src/runtime.ts` (thread a client/transaction through), `src/pg-vector-store.ts` (accept an external client).
- **Done when:** a test that forces the embedder to throw mid-index leaves zero `documents` rows for that id.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Walk me through what happens when you index a document.**

```
  doc.text → chunkText(512/64) → embed(batch) → upsert "<docId>#<i>"
                                                  ↑ deterministic id = idempotent
```

"The document goes whole into a canonical `documents` table, then the library chunks it into 512-character overlapping windows, embeds all chunks in one Ollama call, and upserts each as a `chunks` row keyed `<docId>#<index>`. The deterministic id is what makes re-indexing idempotent — same file overwrites the same rows." Anchor: the chunk id is the idempotency key.

**Q: What's the load-bearing part people forget?**

The 64-char overlap and the fact that upsert never deletes. "The overlap stops a boundary-straddling fact from being lost; the missing delete means a shrunk document leaves orphan chunks. Most people show me the happy-path upsert and never mention what happens on re-index of a smaller doc." Anchor: derived caches need a deletion story.

## Validate

- **Reconstruct:** From memory, draw the index path from `doc.text` to `agents.chunks` rows, naming the chunk-id format. (`src/runtime.ts:17`, `src/pg-vector-store.ts:38`)
- **Explain:** Why does the dimension assertion run on all chunks *before* `begin`? (`src/pg-vector-store.ts:39`)
- **Apply:** You edit `work.md` so it now produces 2 chunks instead of 3, then re-index. Which rows are correct, which are stale, and why? (`src/pg-vector-store.ts:50`)
- **Defend:** The library chose fixed-size-by-character chunking. Defend that choice for buffr, then name the one thing it costs you. (`chunker.js` in the library; `src/runtime.ts:17`)

## See also

- `02-rag-query-path.md` — the read side that searches these chunks.
- `05-embedding-model-choice.md` — the 768-dim one-way door this path commits to.
- `.aipe/study-database-systems/02-records-pages-and-storage-layout.md` — how the chunk rows physically live in Postgres.
- `.aipe/study-system-design/02-retrieval-pipeline.md` — the architectural view of the pipeline boundary.
- `.aipe/study-testing/02-fake-embedder-injection.md` — how the index path is tested without a live model.
