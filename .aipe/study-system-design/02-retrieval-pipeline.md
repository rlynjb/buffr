# 02 — Retrieval Pipeline

**Industry name(s):** RAG (Retrieval-Augmented Generation) · the ingest/query split · embed → store → search → rank. **Type:** Industry standard.

## Zoom out — where this concept lives

This is the *hand* of the system — the part that reaches into the corpus and pulls back the
chunks the model reasons over. It has two halves that run at different times: an **index path**
(offline, when you load documents) and a **query path** (online, inside every ask). Both run
over the same `VectorStore` port from `01`, so the pipeline itself is store-agnostic.

```
  Zoom out — the retrieval pipeline in the system

  ┌─ CLI / Agent layer ───────────────────────────────────────────┐
  │  index-cmd (offline)        RagQueryAgent (online, per ask)    │
  └──────────┬─────────────────────────────┬──────────────────────┘
             │ index path                  │ query path
  ┌─ Pipeline layer (aptkit) ▼─────────────▼──────────────────────┐
  │  createRetrievalPipeline({ embedder, store })                 │
  │   ★ index: doc → chunk → embed → store.upsert ★               │
  │   ★ query: text → embed → store.search → rank → chunks ★      │
  └──────────┬─────────────────────────────┬──────────────────────┘
             │ OllamaEmbeddingProvider      │ PgVectorStore (port 01)
  ┌─ Provider / Storage ▼───────────────────▼─────────────────────┐
  │  Ollama nomic-embed-text 768d           agents.chunks (HNSW)  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **RAG's retrieval stage**. The model can't answer from a corpus it
wasn't trained on, so you give it the corpus at question time — but you can't paste the whole
corpus into the prompt, so you retrieve only the *relevant* pieces. The question this pipeline
answers: *which 4 chunks, out of thousands, does the model need to answer this question?*

## Structure pass — layers, axis, seam

**Layers:** caller (CLI/agent) → pipeline (aptkit logic) → adapters (embedder + store) → engines
(Ollama, pgvector).

**Axis — trace *when does this run* (lifecycle) across the two paths:**

```
  axis = "when does this happen?"

  index path   →  at ingest time, once per document, offline    (write-heavy)
  query path   →  at ask time, once per question, in the hot path (read-heavy)

  same pipeline object, two lifecycles. the embedder is shared;
  the seam is the store: upsert on one path, search on the other.
```

**The seam:** the `VectorStore` port (`01`) is the joint both paths hinge on — index calls
`upsert`, query calls `search`. The other seam is the `EmbeddingProvider`: it's the one piece
**both paths must share**, because a chunk embedded at 768d can only be searched by a 768d query.
That shared-embedder requirement is the dimension one-way door, sitting right at this seam.

## How it works

### Move 1 — the mental model

You know `Array.prototype.filter` returns the items matching a predicate. Vector search is filter
with a *fuzzy* predicate: instead of `item.x === target`, it's "the k items whose embedding is
closest to the query's embedding." Closeness is cosine similarity. That's the whole idea —
nearest-neighbor instead of exact-match.

```
  The RAG retrieval shape — two paths, one store

  INDEX (offline)                         QUERY (online, per ask)
  ──────────────                          ───────────────────────
  document                                 question text
     │ chunk                                  │ embed (same model!)
     ▼                                        ▼
  ["chunk 0", "chunk 1", …]                query vector  ●
     │ embed                                  │ search(vec, k=4)
     ▼                                        ▼
  [v0, v1, …]                              ┌─────────────────────┐
     │ store.upsert                        │  nearest 4 in vector│
     ▼                                     │  space, by cosine   │
  agents.chunks  ●●●●●●●●  ◄───────────────│  ●→ ● ● ● (ranked)  │
  (the vector space)        search reads   └─────────────────────┘
```

### Move 2 — the walkthrough

**Index path, step 1 — the document row comes first.** buffr owns one custom step on the index
path: writing the source-of-truth `documents` row *before* handing the text to aptkit's pipeline
(`runtime.ts:5-18`):

```ts
// src/runtime.ts:5
export async function indexDocumentRow(pool, appId, pipeline, doc) {
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, ...`,   // idempotent
    [doc.id, appId, doc.sourcePath ?? null, doc.text]);
  await pipeline.index({ id: doc.id, text: doc.text });   // aptkit: chunk → embed → upsert
}
```

The ordering is deliberate and it's a state-ownership statement (audit lens 3): the `documents`
row is the **source of truth**, the chunks are **derived**. buffr writes the truth; aptkit's
`pipeline.index` derives the chunks. If you re-run, `on conflict` updates the truth and the chunks
re-upsert idempotently (`01`'s `on conflict` in `upsert`). The CLI that drives it just loops over
file paths (`index-cmd.ts:22-26`).

**Index path, step 2 — chunk → embed → upsert (aptkit's logic).** This lives behind the pipeline,
constructed in `session.ts:42-43`:

```ts
// src/session.ts:40
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
```

Notice line 41: the store's `dimension` is taken *from the embedder* (`embedder.dimension`). That's
the dimension contract being wired at construction — the store and the embedder can't disagree
because the store is told the embedder's number. Mismatch becomes impossible at this seam, and
`assertDim` (`01`) catches any vector that violates it later.

**Query path — embed the question, search, rank.** The query path is the hot path; it runs inside
the agent's tool call. The tool is built once (`session.ts:43-44`):

```ts
// src/session.ts:43
const tool  = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });   // floor of 4 chunks
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
```

The `minTopK: 4` is a buffr fix for a weak local model: Gemma was passing `top_k: 1`, starving
multi-part questions (`...graduation-design.md:209-212`). The floor forces at least 4 chunks back
regardless of what Gemma asks for. That's a system-design adaptation to a provider weakness — the
pipeline is generic, the floor is buffr compensating for *this* model.

**The eval path uses the query path directly.** `eval-cmd.ts:24-30` calls `pipeline.query(query, K)`
straight, skipping the agent, to measure retrieval in isolation:

```ts
// src/cli/eval-cmd.ts:24
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);                  // the query path, no agent
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];   // dedupe chunks → docs
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;      // is the top doc right?
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;
}
```

This is why retrieval has a *number*. The labeled set (`eval/queries.json`) pairs a question with
the doc that should answer it; precision@1 asks "was the top-ranked doc the right one?" Separating
the query path from the agent means you can tell a *retrieval* miss from a *synthesis* miss — the
exact failure-categorization the parent plan demands (`agent-layer-plan.md:96-97`).

### Move 2 variant — the load-bearing skeleton

```
  RAG retrieval kernel:
    1. shared embedder        — same model both paths, or dimensions don't match
    2. chunk + embed + upsert — the write path (index)
    3. embed + search + rank  — the read path (query)
    4. k (top-k floor)        — how many chunks come back
```

- Drop **#1's sharing** (embed index with model A, query with model B) → vectors live in different
  spaces, every search is garbage. This is the dimension one-way door.
- Drop **#4's floor** → Gemma asks for 1, multi-part questions starve (the real bug buffr fixed).
- Ranking (#3's `rank`) is closer to kernel than hardening: unordered hits give the model no
  signal about which chunk matters most.

Optional hardening *not* here: reranking models, hybrid keyword+vector search, query expansion,
the deferred `tool_runs` cache. None are in buffr — the kernel alone hits the precision bar.

### Move 3 — the principle

**RAG splits into a write path you run rarely and a read path you run constantly, joined by one
invariant: the same embedding model on both sides.** Get the invariant wrong and nothing else
matters — the corpus and the query live in different vector spaces and similarity is meaningless.
Everything else (chunk size, k, reranking) is tuning; the shared-embedder contract is law. buffr
encodes the law structurally: the store takes its dimension *from* the embedder (`session.ts:41`),
so you can't wire a mismatch.

## Primary diagram

```
  Retrieval Pipeline — full picture

  ┌─ Index (offline) ─────────────────────────────────────────────┐
  │ index-cmd → indexDocumentRow                                   │
  │   1. INSERT agents.documents  (source of truth, buffr)         │
  │   2. pipeline.index → chunk → OllamaEmbed(768) → store.upsert  │
  └────────────────────────────────────────────┬──────────────────┘
                                                ▼  writes
  ┌─ Storage ─────────────────────────────────────────────────────┐
  │  agents.chunks  ●●●●●●●●  (vector(768), HNSW cosine, app_id)   │
  └────────────────────────────────────────────▲──────────────────┘
                                                │  reads
  ┌─ Query (online, per ask) ─────────────────────────────────────┐
  │ agent → search_knowledge_base(minTopK 4)                       │
  │   query text → OllamaEmbed(768) → store.search(vec,4) → rank   │
  │   → top-4 chunks (with docId/text meta) → model synthesizes    │
  └───────────────────────────────────────────────────────────────┘
  ┌─ Eval (offline, no agent) ────────────────────────────────────┐
  │ pipeline.query per labeled Q → precision@1 / recall@K numbers  │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

RAG emerged because fine-tuning a model on your private corpus is expensive, slow, and stale the
moment the corpus changes — retrieval gives the model fresh, private knowledge at inference time
with no training. buffr's whole thesis leans on this: the parent plan defers fine-tuning as "the
ceiling" and bets on RAG + measurement instead (`agent-layer-plan.md:17-19`). The eval path is the
portfolio artifact — "evals with numbers" is the line the plan draws between "played with an LLM"
and "does AI engineering" (`agent-layer-plan.md:30`).

You shipped this exact pipeline before in AdvntrCue (`me.md`: "classic RAG, vector + relational
colocated"). The difference here is the embedder and store are *ports*, not welded vendors — the
lesson learned from AdvntrCue's OpenAI lock-in.

Read next: `01-vector-store-adapter.md` (the store the query path hits), `06-profile-injection-as-
context.md` (the other thing the prompt gets besides chunks). The ANN algorithm itself →
`study-dsa-foundations`. The RAG-as-AI-engineering treatment → `study-ai-engineering`.

## Interview defense

**Q: Walk me through what happens between a question and an answer.**
Embed the question with the same model the corpus was embedded with; cosine-search the vector store
for the nearest k chunks; rank them; hand the top chunks to the model as context; the model
synthesizes a grounded answer. In buffr that's `pipeline.query` inside the `search_knowledge_base`
tool, k floored at 4 (`session.ts:43`).

```
  Q ─embed→ vec ─search(k=4)→ [chunk,chunk,chunk,chunk] ─→ prompt+chunks ─model→ answer
       ▲ same model that indexed the corpus — the one invariant that can't break
```

**Q: What's the one thing that, if wrong, breaks everything?**
The shared embedding model. Index with nomic-768 and query with OpenAI-1536 and the two vectors
live in different spaces — every similarity score is noise. buffr makes it un-wrong-able: the store
takes its dimension from the embedder at construction (`session.ts:41`) and `assertDim` throws on
any mismatch (`pg-vector-store.ts:32-36`).

**Q: How do you know retrieval is actually good?**
You measure it separately from the agent. `eval-cmd.ts` runs `pipeline.query` against a labeled set
and reports precision@1 / recall@K — no model in the loop. That isolation lets you tell a retrieval
miss (wrong chunks) from a synthesis miss (right chunks, bad answer), which is the failure
categorization the whole project's "ship vs. iterate vs. fine-tune" decision rides on.

## See also

- `01-vector-store-adapter.md` — the port both paths use.
- `06-profile-injection-as-context.md` — the prompt gets profile *and* retrieved chunks.
- `audit.md` lens 2 (data flow), lens 5 (storage colocation).
- `study-ai-engineering` → RAG + evals. `study-dsa-foundations` → ANN / cosine. `study-data-modeling` → chunks schema.
