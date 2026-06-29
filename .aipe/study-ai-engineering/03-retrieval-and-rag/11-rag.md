# RAG — Retrieval-Augmented Generation

*Industry standard. The core pattern of buffr.*

## Zoom out, then zoom in

Okay — pull up the whole stack and find where RAG lives. It isn't one box; it's the wiring between the agent and storage that lets a model answer from data it was never trained on.

```
  Zoom out — where RAG sits

  ┌─ Agent layer (aptkit) ──────────────────────────────────────┐
  │  RagQueryAgent.answer() — the loop that calls the tool       │
  └───────────────────────────┬─────────────────────────────────┘
                              │  search_knowledge_base(query)
  ┌─ Retrieval layer ─────────▼─────────────────────────────────┐
  │  ★ RAG: embed query → ANN search → return ranked chunks ★    │ ← we are here
  │  createRetrievalPipeline({ embedder, store })                │
  └──────────────┬──────────────────────────┬───────────────────┘
                 │ embed (768-dim)          │ search(vector, k)
  ┌─ Provider ───▼───────────┐  ┌─ Storage ──▼──────────────────┐
  │ nomic-embed-text:v1.5    │  │ pgvector, HNSW cosine          │
  │ (Ollama, 768-dim)        │  │ agents.chunks                  │
  └──────────────────────────┘  └───────────────────────────────┘
```

You already see RAG as a shape: retrieve → augment → generate. What buffr adds is that the "augment" step is a *tool the model chooses to call*, not a fixed pre-fetch. The model decides it needs the knowledge base, calls `search_knowledge_base`, and the retrieved chunks come back as the tool result that grounds its next turn. So buffr's RAG is **agentic** — retrieval is inside the loop, not bolted on in front of it.

## Structure pass

Before the mechanics, read the skeleton. Three layers, one axis traced across them, and the seam where it flips.

**Layers:** agent (decides to retrieve) → retrieval pipeline (embeds + searches) → storage (pgvector ANN).

**Axis traced — "who decides what gets into the model's context?"**

```
  one axis: who decides the context content?

  ┌─ agent ────────────────┐   the LLM decides WHETHER to retrieve
  │  LLM emits a tool call  │   (it can also just answer cold)
  └────────────┬───────────┘
               │  seam: free-text → structured query
  ┌─ pipeline ─▼───────────┐   the EMBEDDER decides WHAT is "similar"
  │  embed → ANN → rank     │   (geometry, not the LLM)
  └────────────┬───────────┘
               │  seam: vector → SQL ANN scan
  ┌─ storage ──▼───────────┐   the INDEX decides which k rows return
  │  HNSW cosine top-k      │   (approximate, not exact)
  └────────────────────────┘
```

**The seam that matters:** the agent→pipeline boundary, where the model's free text becomes a structured `{query}` argument. That's exactly where Gemma's tool-call emulation can drop the ball (wrong key → empty query). The whole RAG quality story hinges on that one contract. Hold that; `04-agents-and-tool-use/02-tool-calling.md` walks it in full.

## How it works

### Move 1 — the mental model

You know how a `fetch()` in a component pulls fresh data the component didn't have at build time, and then you render with it? RAG is that for an LLM. The model's training is the build-time bundle — frozen, generic. Retrieval is the `fetch()` — it pulls *your* data at request time so the answer is grounded in something specific the model never saw.

```
  the RAG kernel — three moves

  question
    │
    ▼  (1) RETRIEVE   embed query, ANN search pgvector
  [chunk] [chunk] [chunk]          ← the fresh, private data
    │
    ▼  (2) AUGMENT    stuff chunks into the prompt as tool result
  system + profile + chunks + question
    │
    ▼  (3) GENERATE   model answers FROM the chunks
  answer (grounded, citable)
```

The kernel is those three moves. Strip any one and it stops being RAG: no retrieve → the model guesses from training; no augment → the chunks never reach the model; no generate → you have search, not an answer.

### Move 2 — the step-by-step walkthrough

**Step 1 — the pipeline is wired once, with a dimension assertion.** buffr builds the retrieval pipeline by handing aptkit an embedder and a store. The dimension is asserted at construction so an index/query mismatch can't slip through silently.

```ts
// src/session.ts:40-42
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension }); // 768
const pipeline = createRetrievalPipeline({ embedder, store });
```

aptkit's `createRetrievalPipeline` calls `assertWiring(wiring)` on both the index and query paths (`packages/retrieval/src/pipeline.ts`), throwing if `embedder.dimension !== store.dimension`. This is the first of buffr's four defense-in-depth dimension checks — see `02-embedding-model-choice.md`.

**Step 2 — the query path: embed, search, return.** When the agent calls the tool, the pipeline embeds the query string into one 768-dim vector and hands it to the store's `search`.

```ts
// aptkit packages/retrieval/src/pipeline.ts:49-59  (queryKnowledgeBase)
const [vector] = await wiring.embedder.embed([query]);
if (!vector) return [];
return wiring.store.search(vector, topK);
```

Note the boundary condition: if the embedder returns nothing, the pipeline returns `[]` — an empty retrieval, not an error. Downstream, an empty result becomes "no chunks to ground on," which is the *better* failure (the alternative is a confidently wrong answer).

**Step 3 — the ANN search in pgvector.** buffr's `PgVectorStore.search` is where the geometry happens. The `<=>` operator is pgvector's cosine *distance*; similarity score is `1 - distance`.

```ts
// src/pg-vector-store.ts:67-85
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);                              // per-vector dimension guard
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score    -- cosine similarity
     from agents.chunks
     where app_id = $2
     order by embedding <=> $1::vector                 -- HNSW ANN, ascending distance
     limit $3`,
    [toVectorLiteral(vector), this.appId, k]);
  return rows.map((r) => ({
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
  }));
}
```

Two load-bearing details. First, `order by embedding <=> $1::vector` is what hits the HNSW index — without it the planner does a full scan. Second, the `meta` is *rebuilt* to the exact in-memory shape (`docId`, `chunkIndex`, `text`) so the `search_knowledge_base` tool's citation formatter works unchanged whether the store is in-memory or pgvector. That parity is deliberate: buffr is a drop-in `VectorStore` implementation.

**Step 4 — augment and generate.** The tool returns the ranked chunks; aptkit's tool handler formats them into a result the agent loop feeds back to the model as the next message. The model's next turn sees system prompt + profile + chunks + question, and answers. The "augment" is literally "the tool result is in the conversation now."

```
  Layers-and-hops — one RAG turn

  ┌─ Agent ──────┐  hop 1: search_knowledge_base({query})   ┌─ Pipeline ──┐
  │ RagQueryAgent│ ────────────────────────────────────────►│ embed+search│
  └──────▲───────┘  hop 4: [chunk,chunk,chunk] as result ◄── └──────┬──────┘
         │                                              hop 2 │ vector
         │ hop 5: generate answer from chunks                 ▼
         │                                             ┌─ Storage ────────┐
         └─────────────────────────────────────────── │ pgvector HNSW    │
                       hop 3: top-k rows ◄──────────── │ agents.chunks    │
                                                       └──────────────────┘
```

### Move 3 — the principle

RAG is only as good as its retrieval. A perfect model over bad chunks gives a confident wrong answer; a mediocre model over the right chunks gives a correct one. That's why buffr measures *retrieval* (precision@k) before anything else — and why the unmeasured gap (faithfulness: did the model actually use the chunks?) is the real risk. The model is rarely the bug. The retrieval, or the model ignoring good retrieval, is.

## Primary diagram

The full pipeline, both paths, one frame:

```
  buffr RAG — index path (offline) + query path (per turn)

  INDEX (npm run index -- file.md)
  ────────────────────────────────
  file.md ─► indexDocumentRow ─► documents row (source of truth)
                   │
                   └─► pipeline.index() ─► chunk(512/64) ─► embed(768) ─► chunks
                                                                              │
  ════════════════════════════════════════════════════════════════ pgvector ╪══════
                                                                              │
  QUERY (agent tool-call)                                                     ▼
  ────────────────────────                                          agents.chunks
  question ─► embed(768) ─► search(vector,k) ─► HNSW cosine ─► top-k ─┘
                                                       │
                                                       ▼  1 - distance = score
                                              [chunk,chunk,chunk] ─► augment ─► generate ─► answer
```

## Elaborate

RAG emerged because two facts about LLMs are permanent: they don't know your private data, and even public data they know is frozen at training time. Retrieval injects fresh, specific, private knowledge at request time without retraining. buffr's variant is *agentic* RAG — retrieval is a tool inside the agent loop rather than a fixed pre-fetch — which is strictly more flexible (the model can skip retrieval, or retrieve twice) and strictly harder to make reliable (the tool-call boundary is fragile under Gemma emulation).

The above-threshold rule applies hard here: don't add RAG to features that work without it. buffr's corpus is small (a handful of markdown files), so a naive "stuff all docs" approach would also work at this scale. RAG earns its place the moment the corpus exceeds the context window — and it's the right architecture to grow into, which is why buffr builds it now even though the corpus is tiny.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Render citations to the user

- **Exercise ID:** RAG-1 (Case A — RAG implemented; next step).
- **What to build:** surface the retrieved chunk citations (already captured in `tool_results`) in the Ink TUI, so each answer shows which `docId#chunkIndex` it drew from.
- **Why it earns its place:** "citations rendered, not just stored" is the difference between a demo and a trustworthy RAG product; interviewers probe for it.
- **Files to touch:** `src/cli/chat.tsx`, `src/session.ts` (return citations alongside the answer), read from `agents.messages.tool_results`.
- **Done when:** a chat answer displays its source chunks, and clicking/expanding shows the chunk text.
- **Estimated effort:** 1–4hr.

### Add a relevance-threshold refusal

- **Exercise ID:** RAG-2 (Case A — hardening).
- **What to build:** if the top chunk's cosine score is below a threshold, have the agent refuse ("I don't have that in the knowledge base") instead of answering ungrounded.
- **Why it earns its place:** "refuse rather than hallucinate" is the single most-probed RAG failure mitigation.
- **Files to touch:** the tool handler wiring in `src/session.ts:43` (wrap or configure `createSearchKnowledgeBaseTool`), possibly a small post-retrieval check.
- **Done when:** a query with no relevant doc yields a refusal, verified by an eval case.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: What is RAG and why does buffr use it instead of just fine-tuning Gemma on the corpus?**
Answer: RAG retrieves private data at request time and grounds the answer in it; fine-tuning bakes knowledge into weights. RAG wins for buffr because the corpus changes (re-index a file, retrieval updates instantly — no retraining), it's citable (the answer points at chunks), and it's cheap locally. Fine-tuning is buffr's *ceiling*, not its current move — and notably, buffr is already capturing the trajectory corpus a future fine-tune would need.

```
  RAG vs fine-tune — the one-liner sketch
  RAG:        weights frozen + fetch data at query time   → fresh, citable
  fine-tune:  bake data into weights                       → stale, opaque
```

**Q: Where does buffr's RAG break, and how would you know?**
Answer: at the tool-call seam — Gemma emulation has no arg-schema validation, so a wrong key (`q` instead of `query`) silently searches the empty string. You'd catch it with the precision@k eval *if* it covered the agent path, but `eval-cmd.ts` tests the pipeline directly, bypassing the agent — so today you wouldn't know from evals. The anchor: **the load-bearing part people forget is validating the tool argument before the search runs.**

## See also

- `01-embeddings.md` — what the 768-dim vector means geometrically.
- `04-vector-databases.md` — pgvector, HNSW, the dropped FK.
- `10-incremental-indexing.md` — the index path in detail.
- `../04-agents-and-tool-use/02-tool-calling.md` — the fragile seam.
- `../05-evals-and-observability/02-eval-methods.md` — why retrieval is measured but faithfulness isn't.
