# Retrieval Pipeline

**Industry names:** RAG (Retrieve-Augment-Generate) · ingest/query pipeline ·
embedding + ANN retrieval · Industry standard

## Zoom out, then zoom in

The pipeline is the data path that turns markdown on disk into cited answers.
It has two directions that share one embedder and one store: **index**
(text → chunks → vectors → rows) and **query** (question → vector → nearest
chunks). aptkit owns the pipeline object; buffr owns the store underneath it
and the documents row beside it.

```
  Zoom out — where the pipeline sits

  ┌─ CLI layer (buffr) ──────────────────────────────────────────┐
  │  index-cmd        chat session / eval-cmd                     │
  └────────┬──────────────────┬──────────────────────────────────┘
           │ index()          │ query()
  ┌─ Toolkit layer (aptkit) ──▼──────────────────────────────────┐
  │       ★ RetrievalPipeline ★   ← we are here                   │
  │   chunk → embed (Ollama) → store.upsert / store.search        │
  └────────┬───────────────────────────────┬─────────────────────┘
           │ VectorStore port              │ EmbeddingProvider port
  ┌─ Adapter + Provider ──────────────────▼─────────────────────┐
  │  PgVectorStore (pg)          OllamaEmbeddingProvider (768)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **retrieve-then-generate**, and this file is the
*retrieve* half (the *generate* half is the agent loop —
`03-trajectory-capture.md` and `study-agent-architecture`). Strip the
pipeline out and the agent has no grounding — it answers from the model's
weights alone, with no corpus and no citations. The pipeline is what makes it
RAG instead of a chatbot.

## Structure pass

**Layers** — CLI → pipeline (aptkit) → two ports (embedder, store) →
Ollama + Postgres.

**Axis: where does the text-to-vector transformation happen, and who holds
the result?** Trace it.

```
  One question: "where does text become a vector, and who keeps it?"

  ┌──────────────────────────────────────────────┐
  │ index: text → CHUNKS → embed → vectors        │  → pipeline transforms,
  │        → store keeps them                     │     DB keeps them
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ query: question → embed → vector          │  → pipeline transforms,
      │        → store returns nearest, discards  │     nothing kept
      └───────────────────────────────────────────┘

  same embedder both ways — the symmetry is the point
```

**Seam.** Two horizontal seams hang off the pipeline: the `EmbeddingProvider`
port (text↔vector) and the `VectorStore` port (vector↔rows). The
load-bearing invariant *across both* is the **768 dimension** — the embedder
produces it, the store demands it, the schema types it. A flip there (wrong
embedder) breaks the whole path, which is why it's guarded at the store
(`01-vector-store-adapter.md`).

## How it works

### Move 1 — the mental model

You know `fetch()` → `.json()` → render? RAG indexing is the same shape
pointed at a corpus: read → split → embed → store. And query is `fetch()`
with a similarity `WHERE`: embed the question, ask the store for the closest
rows.

```
  RAG — two passes over the same embedder

  INDEX (write once):
    text ─► [chunk] ─► [embed] ─► [upsert] ─► rows in DB
                          │
                          ▼  same model
  QUERY (read often):
    question ─► [embed] ─► [search k] ─► nearest chunks ─► answer
```

### Move 2 — the step-by-step walkthrough

#### Index step 1 — the documents row goes first (buffr's job)

Before aptkit chunks anything, buffr writes the *source-of-truth* `documents`
row. This is deliberate: the `VectorStore` contract only ever sees chunks, so
the documents row is the CLI/runtime's responsibility, not the store's.

```
  layers-and-hops — index, the documents row first

  ┌─ CLI ────────┐  hop 1: indexDocumentRow(pool, pipeline, doc)
  │ index-cmd    │ ───────────────────────────────────────────►┐
  └──────────────┘                                              │
  ┌─ Runtime (buffr) ───────────────────────────────────────────▼┐
  │ hop 2: INSERT agents.documents (source-of-truth row)         │
  │ hop 3: pipeline.index({id, text})  ───────────────────────►  │
  └──────────────────────────────────────────────────────────┬──┘
  ┌─ Pipeline (aptkit) ───────────────────────────────────────▼──┐
  │ hop 4: chunk → embed → store.upsert                          │
  └───────────────────────────────────────────────────────────────┘
```

What breaks if you skip the documents row: chunks exist with a
`document_id` pointing at nothing. (There's no FK to stop it — that's the
deliberate no-FK deviation; see `study-data-modeling`.) The corpus loses its
source-of-truth layer.

#### Index step 2 — chunk, embed, upsert (aptkit's job)

`pipeline.index` splits the text into chunks, embeds each through the Ollama
provider (768-dim), and hands the batch to `store.upsert`. aptkit assigns the
deterministic ids: `docId` for the document, `"<docId>#<index>"` per chunk.

```
  pseudocode — pipeline.index

  function index(doc):
    chunks = chunk(doc.text)                 // aptkit's chunker
    for each chunk at position i:
      chunk.id   = doc.id + "#" + i          // deterministic → idempotent
      chunk.meta = { docId: doc.id, chunkIndex: i, text: chunk.text }
      chunk.vector = embedder.embed(chunk.text)   // → 768 floats via Ollama
    store.upsert(chunks)                      // one transaction (PgVectorStore)
```

The deterministic id is what makes re-indexing the same file a no-op-or-
overwrite, never a duplicate — it rides straight into `on conflict (id)`.

#### Query step — embed the question, rank by cosine

`pipeline.query(question, k)` embeds the question with the *same* model, then
calls `store.search(vector, k)`, which runs the cosine ANN query.

```
  query — embed then nearest-k

  question ─► embedder.embed ─► [768 floats]
                                   │
                                   ▼  store.search(vector, k)
  SQL:  order by embedding <=> vector   limit k     ← HNSW cosine, nearest first
        score = 1 - (embedding <=> vector)          ← similarity, higher better
                                   │
                                   ▼
        k hits, each with meta.{docId, chunkIndex, text}  → tool cites them
```

The boundary condition the design hit live: a weak local Gemma asked for
`top_k: 1`, starving multi-part questions. The fix is a `minTopK` floor wired
where the tool is built (`session.ts:43`) — the pipeline always retrieves at
least 4 regardless of what the model requested. That floor is the difference
between "answered half the question" and "answered all of it."

#### Eval step — the same query path, scored

`eval` runs `pipeline.query` over labeled queries and scores the returned
`docId`s with aptkit's `scorePrecisionAtK` / `scoreRecallAtK`. Same retrieve
path the agent uses — the eval measures the *real* retrieval, not a mock.

### Move 3 — the principle

RAG's whole leverage is that *retrieval and generation are decoupled*. You
can improve the corpus, swap the embedder, or tune `k` without retraining the
model — and you can measure the retrieve half in isolation (that's what
`eval` does). The pipeline is the seam that makes "is this a retrieval miss or
a synthesis miss?" an *answerable* question.

## Primary diagram

The full pipeline, both directions, every hop labeled.

```
  Retrieval pipeline — index and query end to end

  ┌─ CLI (buffr) ───────────────────────────────────────────────────┐
  │  index-cmd ──► indexDocumentRow ──► INSERT documents (buffr)     │
  │  chat/eval ──► pipeline.query(q, k)                              │
  └───────────────┬───────────────────────────────┬────────────────┘
                  │ pipeline.index                 │ pipeline.query
  ┌─ Pipeline (aptkit) ──────────────────────────────────────────────┐
  │  INDEX: chunk → embed(768) → store.upsert [txn]                  │
  │  QUERY: embed(768) → store.search(k) → hits(meta) → minTopK≥4   │
  └───────┬──────────────────────────────────────┬─────────────────┘
          │ EmbeddingProvider                     │ VectorStore
  ┌─ Ollama ▼─────────────┐          ┌─ Postgres (pgvector) ▼────────┐
  │ nomic-embed-text:v1.5 │          │ agents.chunks · HNSW cosine   │
  │ 768-dim               │          │ documents (source of truth)   │
  └───────────────────────┘          └───────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Index runs once per corpus file (`index`); query runs on every
chat turn (through the tool) and every `eval` row. The pipeline is rebuilt per
one-shot process, but in `chat` it's built ONCE at `createChatSession` and
reused for every turn — there's no shared server.

**Pipeline construction (identical in all three entrypoints)** —
`src/cli/index-cmd.ts:18-20`

```
  const embedder = new OllamaEmbeddingProvider({ model:'nomic-embed-text:v1.5', host: cfg.ollamaHost });
  const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });
        │
        └─ store.dimension is sourced FROM embedder.dimension (line 19), so the
           768 invariant flows from the provider into the store automatically.
```

**The documents-row-first ordering** — `src/runtime.ts:11-17`

```
  insert into agents.documents (id, app_id, source_type, source_path, content)
    values ($1,$2,'markdown',$3,$4) on conflict (id) do update ...   ← 12-14
  await pipeline.index({ id: doc.id, text: doc.text });              ← 17
        │
        └─ documents row written FIRST (buffr's job), then aptkit indexes chunks.
           The store never writes documents — that keeps VectorStore drop-in.
```

**The minTopK floor (the weak-model fix)** — `src/session.ts:43`

```
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
        │
        └─ Gemma asked for top_k:1; this floor forces ≥4 chunks retrieved,
           so multi-part questions don't starve. Named in the design's
           as-built deviations (laptop-supabase-graduation-design.md:209-211).
```

**The eval, scoring the real retrieve path** — `src/cli/eval-cmd.ts:24-33`

```
  const hits = await pipeline.query(query, K);                       ← 26
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];  ← 27: dedupe by doc
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;     ← 28: P@1
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;        ← 29: R@K
        │
        └─ same pipeline.query the agent uses, so the number measures real
           retrieval. h.meta.docId is the reconstructed field from the adapter.
```

## Elaborate

RAG was introduced (Lewis et al., 2020) to ground generation in retrieved
documents instead of relying on parametric memory — exactly the "answer from
the corpus, cite the source" behavior here. The reader shipped this shape in
AdvntrCue (Next.js + pgvector + GPT-4); buffr is the same pattern with the
generation model swapped to local Gemma and the store made explicitly
swappable behind aptkit's port. The interesting evolution: by decoupling
retrieve from generate *and* keeping the eval on the retrieve half, buffr can
answer the Phase-4 question the parent plan cares about — "retrieval miss vs
synthesis miss vs model gap" (`agent-layer-plan.md` Phase 4) — with numbers,
not vibes. Embedding/ANN mechanics → `study-database-systems`; the agent loop
that consumes these hits → `study-agent-architecture`.

## Interview defense

**Q: Walk the index path. Who writes what, and in what order?**

buffr writes the `documents` source-of-truth row first (`runtime.ts:12`),
*then* calls `pipeline.index` (`runtime.ts:17`), which chunks, embeds with
Ollama, and upserts into `agents.chunks`. The order matters because the
`VectorStore` only sees chunks — the documents row is buffr's job, not the
store's, which keeps the store drop-in.

```
  documents row (buffr) ──then──► chunks (aptkit via store) — never the reverse
```

Anchor: `src/runtime.ts:11-17`.

**Q: A multi-part question only got half answered. Where do you look?**

First, is it retrieval or synthesis? Run `eval` — it scores the retrieve half
in isolation. If retrieval missed, check `k`: the live bug was Gemma asking
for `top_k:1`, fixed with a `minTopK:4` floor (`session.ts:43`). The decoupled
pipeline is what makes this diagnosable.

```
  miss ──► eval P@1 ──┬─ low  → retrieval problem (k, chunking, embedder)
                      └─ high → synthesis problem (model, prompt)
```

Anchor: `src/session.ts:43`, `src/cli/eval-cmd.ts:24-33`.

## Validate

1. **Reconstruct.** Draw the index path from `read file` to a row in
   `agents.chunks`, naming which layer owns each step.
2. **Explain.** Why is the `documents` row written by `runtime.ts` and not by
   `PgVectorStore`? (`runtime.ts:11-17`.)
3. **Apply.** `eval` reports mean P@1 = 0.33 on three queries. Is that a
   retrieval problem or a synthesis problem, and how do you know?
   (`eval-cmd.ts`.)
4. **Defend.** Justify the `minTopK: 4` floor (`session.ts:43`) — what does it
   cost, and what does it buy?

## See also

- `01-vector-store-adapter.md` — the `upsert`/`search` underneath the pipeline.
- `03-trajectory-capture.md` — the generate half that consumes the hits.
- `05-cli-as-entrypoints.md` — where the pipeline is built (once, in the chat
  session; per-process for one-shots).
- `study-ai-engineering` / `study-agent-architecture` — RAG and the agent loop.
- `study-database-systems` — embedding + ANN execution.

---

Updated: 2026-06-24 — re-anchored the `minTopK:4` floor and query path from
`ask-cmd.ts:23` to `session.ts:43`; `ask` CLI replaced by the long-lived `chat`
session (pipeline built once per session, not per call).
