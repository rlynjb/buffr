# Agentic retrieval (model-driven search vs static RAG)

**Industry name(s):** Agentic RAG / retrieval-as-a-tool / model-driven
retrieval · *Industry standard*

---

## Zoom out, then zoom in

The difference between buffr and a classic RAG app is one decision: *who decides
whether to retrieve.* In static RAG the engineer hard-wires a `retrieve` step
before generation. In buffr, retrieval is a tool the model chooses to call —
0 to 4 times, with its own query each time.

```
  Zoom out — retrieval as a tool inside the loop

  ┌─ Agent loop (aptkit) ─────────────────────────────────────┐
  │  reason → ★ act: search_knowledge_base ★ → observe → …     │ ← we are here
  └───────────────────────────────┬───────────────────────────┘
                                  │ pipeline.query(query, topK)
  ┌─ Retrieval pipeline ──────────▼───────────────────────────┐
  │  embed query (nomic) → PgVectorStore.search → rank chunks  │
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ Storage ─────────────────────▼───────────────────────────┐
  │  pgvector HNSW cosine, 768-dim, app_id scoped              │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is the *thin* version of agentic RAG. The model can refine its
query and search again, which is the agentic part. What it does **not** do
(yet): grade chunk relevance, decompose the question into sub-queries, or route
across multiple sources. Those are the next rungs — covered honestly below.

---

## Structure pass

**Axis: control — who triggers retrieval, and who shapes the query?**

```
  "who decides to retrieve?" — static vs buffr

  static RAG:   CODE decides (always retrieve, fixed k)
                  │
  buffr:        MODEL decides (call search? what query? again?)
                  │
  inside tool:  CODE decides (embed, ANN search, rank — deterministic)
```

**The seam:** the boundary between the model's *intent* ("search for X") and the
tool's *deterministic execution* (embed → HNSW → rank). Control flips here: the
model is free above the line, the pipeline is fixed below it. The interesting
agentic behavior is all above the line; everything below is the same retrieval
mechanics any RAG app has (covered in `.aipe/study-system-design/02-retrieval-pipeline.md`).

---

## How it works

### Move 1 — the mental model

You know how a `useEffect` that fetches on every render is wasteful, versus
fetching only when the user actually needs the data? Agentic retrieval is the
"only when needed" version: the model fetches when it decides the answer
requires it, with the query it decides is right — not on a fixed schedule.

```
  The pattern — static RAG vs agentic loop

  static (one shot):
    query ──► retrieve top-k ──► stuff ──► generate   (no second try)

  agentic (a loop):
    ┌─ model: do I need to search? what query? ─┐
    │            yes ▼                           │
    │       search_knowledge_base(query, k)      │
    │            ▼                               │
    │       chunks back into context             │
    │            ▼                               │
    │  enough to answer? ── no ──► refine, search again (≤4)
    │            │ yes                           │
    └────────────┴──► answer, cite sources ──────┘
```

### Move 2 — the mechanism, part by part

**The model chooses the query.** The tool's input schema exposes `query`,
`top_k`, and an optional `filter` (`search-knowledge-base-tool.js:10-27`). The
model fills these. So between turns it can rephrase — search "auth flow," see
weak results, search "login token refresh" next. That rephrasing *is* the
agentic loop.

```
  turn 0: search("vlog compose pipeline")  → 4 chunks, partial
  turn 1: model reads chunks, reasons "need clip ordering"
  turn 1: search("clip ordering ffmpeg")    → 4 chunks, better
  turn 2: answer grounded in both
```

What breaks without model-chosen queries: you're back to static RAG — one fixed
query, one shot, no recovery from a bad first retrieval.

**The tool over-fetches when filtering, and refuses to let a bad filter wipe
results.** If the model passes a `filter`, the handler fetches `topK * 4` then
post-filters, and a filter key that a chunk simply *doesn't have* is ignored
rather than treated as a mismatch. This is a guard against a weak model
hallucinating a filter like `{textContains: "x"}` and silently zeroing every
result.

```
  matchesFilter: key absent from chunk.meta → ignored (not excluded)
                 key present, value differs  → excluded
  → a hallucinated filter key can't wipe the whole result set
```

What breaks without this: Gemma invents a plausible-but-wrong filter field, the
post-filter excludes everything, the agent "finds nothing" and gives up — a
silent retrieval failure caused by the model, not the corpus.

**`minTopK` floors the result count.** buffr constructs the tool with
`minTopK: 4` (`ask-cmd.ts:23`), so even if the model asks for `top_k: 1` it
gets at least 4 chunks. Bridge: it's a `Math.max` clamp on a user-supplied
limit — the model doesn't get to starve its own context.

```
  Layers-and-hops — one search call, end to end

  ┌─ model ──────┐ hop 1: tool_use{search, {query, top_k}}  ┌─ handler ────┐
  │ Gemma        │ ─────────────────────────────────────►  │ search_kb    │
  └──────────────┘                                          └──────┬───────┘
                                          hop 2: pipeline.query    │
                                                                   ▼
                                                          ┌─ pipeline ────┐
                                                          │ embed → store │
                                                          └──────┬────────┘
                                          hop 3: HNSW cosine     │
                                                                 ▼
                                                          ┌─ pgvector ────┐
                                                          │ ranked chunks │
                                                          └───────────────┘
       hop 4: { query, results:[{id, score, citation, meta}] } ◄── back to model
```

### Move 3 — the principle

All agentic RAG is agentic AI; not all agentic AI does retrieval. buffr is the
case where the *primary* tool happens to be retrieval — which makes it look
like "fancy RAG," but the control structure is a general agent loop. The reframe:
you didn't build a retrieval pipeline with a model on top; you built an agent
whose one capability is retrieval. The pipeline mechanics are
interchangeable; the loop that decides when to use them is the architecture.

---

## Primary diagram

```
  Agentic retrieval in buffr — full recap

  ┌─ loop (≤6 turns, ≤4 searches) ─────────────────────────────┐
  │  model reasons over messages                               │
  │     │ needs evidence?                                      │
  │     ▼ yes                                                  │
  │  tool_use{ search_knowledge_base, {query, top_k, filter} } │
  │     │                                                      │
  │  ┌──▼ handler ──────────────────────────────────────────┐ │
  │  │ topK = max(top_k, minTopK=4)                          │ │
  │  │ fetchK = filter ? topK*4 : topK                       │ │
  │  │ hits = pipeline.query(query, fetchK)  → pgvector HNSW  │ │
  │  │ if filter: keep hits whose meta matches (absent=ok)   │ │
  │  │ return { query, results:[{id,score,citation,meta}] }  │ │
  │  └───────────────────────────────────────────────────────┘ │
  │     │ chunks → messages → reason again or answer           │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Every question where the answer lives in the indexed corpus. The model decides
the search query from the user's phrasing, reads the cited chunks, and can
search again with a refined query if the first pass was thin. Reached on most
runs; skipped only if the model answers from a profile fact or declines (which
the prompt discourages — `rag-query-agent.js:14-18` says "always call … first").

### Code, side by side

The tool handler (`@aptkit/retrieval/dist/src/search-knowledge-base-tool.js:29-45`):

```
const handler = async (args) => {
  const query = typeof args.query === 'string' ? args.query : '';
  const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0
    ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);     ← floor at minTopK=4 (ask-cmd.ts:23)
  const filter = args.filter && typeof args.filter === 'object'
    && !Array.isArray(args.filter) ? args.filter : undefined;
  const fetchK = filter ? topK * 4 : topK;            ← over-fetch so post-filter can fill topK
  let hits = await pipeline.query(query, fetchK);     ← embed + ANN search (the RAG mechanics)
  if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
  return { query, results: hits.map(toResult) };      ← citations the model grounds in
};
```

The filter guard (`search-knowledge-base-tool.js:48-53`):

```
function matchesFilter(hit, filter) {
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value);
       │                  │                    │
       │                  │                    └─ present + equal → keep
       │                  └─ key ABSENT from meta → ignore (don't exclude)
       └─ a hallucinated filter key can't zero the whole result set
}
```

### Not yet exercised — the next rungs

- **Self-corrective RAG (relevance grading).** No grader scores "is this chunk
  relevant / grounded?" before synthesis. Chunks flow straight into context.
  Adding it: a grade step between `pipeline.query` and the model's next turn —
  see `06-orchestration-templates.md`, the support-system template.
- **Query decomposition.** The model rephrases but doesn't split one question
  into parallel sub-questions. That's the multi-agent research template
  (`06-orchestration-templates.md`).
- **Retrieval routing.** One source (pgvector). No router across vector/SQL/web.

---

## Elaborate

The retrieval *mechanics* — embeddings, chunking, HNSW, ranking — are not this
file's job; they live in `.aipe/study-system-design/02-retrieval-pipeline.md`
and (sibling generator) `.aipe/study-ai-engineering/03-retrieval-and-rag/`. This
file owns only the *control* angle: retrieval as a loop the agent drives. The
tradeoff agentic retrieval buys is real — roughly 3–10x token cost and 2–5x
latency over static RAG, because you pay for the reasoning turns between
searches. buffr keeps that cost bounded by capping searches at 4. The
above-threshold rule applies: use the loop only when one-shot retrieval
measurably fails on multi-step queries — which is exactly the kind of evidence
the Phase-4 eval (`agent-layer-plan.md:96-97`) is meant to produce.

---

## Interview defense

**Q: How is this different from a RAG pipeline?**
In a RAG pipeline the code calls `retrieve` once on a fixed schedule. Here retrieval is a tool the model decides to call — it picks the query, reads the chunks, and can search again with a refined query up to 4 times. The control over *whether and what* to retrieve moved from my code to the model.

```
  static:  code → retrieve(fixed q) → generate
  buffr:   model → search(q it chose) → [refine → search]* → answer
```
Anchor: "Retrieval is a tool the model drives, not a step I scheduled."

**Q: A weak model invents a bad filter and finds nothing. What happens?**
The tool's `matchesFilter` ignores filter keys that a chunk doesn't have, so a hallucinated field can't exclude every result — it only excludes chunks that have that field with a different value. The model gets results back and can recover.
Anchor: "Absent key is ignored, not a mismatch — hallucinated filters can't wipe recall."

---

## Validate

1. **Reconstruct:** Draw static RAG vs buffr's agentic loop. Where does the
   "who retrieves" control flip? (`search-knowledge-base-tool.js`, the tool
   boundary.)
2. **Explain:** Why over-fetch `topK * 4` when a filter is present?
   (`search-knowledge-base-tool.js:37`.)
3. **Apply:** The model passes `{filter: {textContains: "ffmpeg"}}` but no chunk
   has a `textContains` meta key. What comes back? (All hits — key ignored.
   `search-knowledge-base-tool.js:52`.)
4. **Defend:** Argue when buffr's agentic loop earns its 3–10x token cost over
   one-shot retrieval. (`agent-layer-plan.md:96-97`.)

---

## See also

- `01-bounded-react-loop.md` — the loop retrieval runs inside
- `02-single-tool-capability-scope.md` — search is the *only* tool
- `06-orchestration-templates.md` — self-RAG and decomposition as refactors
- `.aipe/study-system-design/02-retrieval-pipeline.md` — the embed/ANN mechanics
- RAG mechanics (sibling generator): `.aipe/study-ai-engineering/03-retrieval-and-rag/`
