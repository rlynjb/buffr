# Retrieval-Augmented Generation

### *industry: retrieval-augmented generation (RAG) · type: the full pipeline that grounds an LLM in retrieved evidence*

## Zoom out

This is the file every other file in this sub-section was building toward. Embeddings, chunking, the vector store, the search tool — they're all components of *one machine*: a pipeline that retrieves evidence and forces the model to answer from it. This is buffr's whole reason to exist.

**buffr's retrieval stack, RAG as the assembled whole**

```
┌──────────────────────────────────────────────────────────────┐
│  ★ RAG PIPELINE ★       retrieve-then-generate, grounded      │  ◄── this file
│  ┌──────────────────────────────────────────────────────────┐│
│  │ RagQueryAgent  "search first, ground every answer, cite"  ││
│  ├──────────────────────────────────────────────────────────┤│
│  │ search_knowledge_base  ranked chunks + citations          ││
│  ├──────────────────────────────────────────────────────────┤│
│  │ PgVectorStore  cosine top-k over agents.chunks            ││
│  ├──────────────────────────────────────────────────────────┤│
│  │ embeddings · chunker · index path                         ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

You've shipped RAG before, so the *shape* — retrieve, stuff into prompt, generate — lands in one breath. This file slows down hard on the mechanism buffr uses to make it *trustworthy*: the grounding contract, the agent loop's turn budget, citations as a verifiability seam, and the fallback that makes "I don't know" a first-class answer.

## Structure pass

The axis is **where the answer's facts come from**: the model's weights (parametric memory) vs. the retrieved chunks (non-parametric evidence). The seam is the grounding instruction that flips the model from "recall" to "read."

**Parametric recall vs. retrieved grounding**

```
   PLAIN LLM                          RAG (buffr)
   ─────────                          ───────────
   answer from weights                answer from retrieved chunks
   "knows" coffee in general          knows YOUR coffee from coffee.md
   no source, can hallucinate         cited, refusable, verifiable
   ┌──────────────────┐               ┌──────────────────────────────┐
   │ question → model │   ──seam──►    │ question → SEARCH → chunks    │
   │        → answer  │               │ → model grounded in chunks    │
   └──────────────────┘               │ → cited answer / "I don't know"│
                                       └──────────────────────────────┘
        the seam: "search first, ground every answer, cite, or say you can't"
```

Before the seam: the model answers from what it absorbed in training — general, sourceless, prone to confident invention. After the seam: the model is *instructed and structured* to retrieve first and answer only from what it found. Consequence: buffr can answer questions about *your private notes* (which no training run ever saw) and, crucially, *refuse* when the notes don't contain the answer — the difference between a knowledge assistant and a confident liar.

## How it works

### Move 1 — Mental model: an open-book exam with a citation rule

A plain LLM is a closed-book exam — answer from memory, no sources, bluff when unsure. RAG is an open-book exam with one extra rule: *you must quote the book, and if the book doesn't cover it, you say so.* The retrieval is "open the book to the right page"; the grounding prompt is the rule "answer only from the page, and cite it."

**RAG as a graded open-book exam**

```
  question
     │ 1. open the book ──► search_knowledge_base ──► relevant chunks
     ▼
  evidence in hand
     │ 2. answer from the evidence (grounding rule)
     ▼
  cited answer        OR    "the book doesn't cover that" (fallback)
     │
     ▼ 3. citations let a grader CHECK the answer against the source
```

Frontend bridge: it's a data-fetch-then-render component. You don't render from stale local state — you fetch the current data, render *from the response*, and show an empty state when the fetch returns nothing. RAG is fetch-then-render for facts, with citations as the "view source" link and the fallback as the empty state.

### Move 2 — Walk the mechanism

This is the centerpiece, so we walk it in full: the index path, the query path, the grounding contract, the loop budget, citations, and the fallback. Six parts, each a diagram.

**Part A — The index path (offline): doc → chunk → embed → store**

Before any question can be answered, the corpus must become searchable vectors. This runs offline, once per doc, via `npm run index`.

**Index path**

```
  file.md
     │ readFile ; id = basename
     ▼ indexDocumentRow
  documents row (source of truth) ──► pipeline.index({id, text})
     │ chunkText (512/64)
     ▼ embedder.embed(chunks)  → 768-dim vectors
  chunks: { id: "<docId>#<i>", vector, meta:{docId, chunkIndex, text} }
     │ store.upsert (txn, on conflict do update)
     ▼
  agents.chunks  (searchable)
```

```ts
// src/cli/index-cmd.ts:22-26 → src/runtime.ts:11-17 → aptkit pipeline.ts:32-47
await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
// runtime: writes documents row, then pipeline.index → chunk → embed → upsert
```

The index path writes *two* things: the authoritative `documents` row (full text, source path) and the searchable `chunks` (vectors + per-chunk text in `meta`). The documents row is the source of truth; the chunks are the searchable projection of it. Both carry the `docId` so a retrieved chunk can always name its parent document.

**Part B — The query path (online): question → embed → search → chunks**

At question time, the same embedder turns the query into a vector and the store returns the nearest chunks.

**Query path**

```
  question
     │ embedder.embed([question])  → 768-dim query vector
     ▼ store.search(vector, k)
  cosine top-k over agents.chunks  (where app_id, order by <=>)
     │
     ▼ Hit[] { id, score, meta:{docId, chunkIndex, text} }
```

```ts
// aptkit pipeline.ts:50-58 — query path, same embedder as index
const [vector] = await wiring.embedder.embed([query]);   // SAME model as index time
return wiring.store.search(vector, topK);
```

The non-negotiable invariant: the query is embedded with the *same* provider as the corpus (file 02's one-way door). Query path and index path meet in the same 768-dim space, or the search is noise. This is why the pipeline asserts `embedder.dimension === store.dimension` at wiring time.

**Part C — The grounding contract (the system prompt)**

Retrieval gets evidence into the prompt; the *grounding instruction* is what makes the model use it instead of its own memory. This is the load-bearing sentence of the whole system.

**The grounding rule**

```
  SYSTEM PROMPT (RagQueryAgent):
  ┌────────────────────────────────────────────────────────────┐
  │ "Always call search_knowledge_base FIRST to retrieve        │
  │  relevant passages before answering."        ◄── retrieve   │
  │ "Ground every answer in the retrieved chunks and CITE       │
  │  their sources."                             ◄── grounded   │
  │ "If the knowledge base does not contain the answer, say so  │
  │  plainly rather than guessing."              ◄── refusable  │
  └────────────────────────────────────────────────────────────┘
```

```ts
// aptkit rag-query-agent.ts:20-27 — the grounding contract, verbatim shape
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.', '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');
```

Three clauses, three jobs: *retrieve-first* (don't answer from memory), *ground-and-cite* (answer only from chunks, and show your work), *refuse-when-empty* (no guessing). Retrieval without this prompt is just context-stuffing — the model might still answer from its weights. The prompt is what converts retrieved chunks from *available* into *binding*.

**Part D — The agent loop budget (`maxTurns:6`, `maxToolCalls:4`, forced synthesis)**

The model doesn't get unlimited tries. The loop bounds how many turns and tool calls it gets, then *forces* a synthesis turn so it must produce an answer from what it retrieved.

**The bounded loop**

```
  runAgentLoop:
  turn 1 ──► model calls search_knowledge_base ──► chunks back
  turn 2 ──► maybe searches again (refine)      ──► more chunks
     …      (≤ maxToolCalls = 4 searches)
  ───────────────────────────────────────────────────────
  budget hit (≤ maxTurns = 6) ──► FORCED synthesis turn:
     "Now answer directly and concisely, citing what you retrieved."
     ▼
  finalText
```

```ts
// aptkit rag-query-agent.ts:66-80 — the budget and the forced synthesis
const { finalText } = await runAgentLoop({
  …, maxTurns: 6, maxToolCalls: 4,
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
```

The budget exists because a weak local model can loop — search, search again, never commit. `maxToolCalls:4` caps the searching; `maxTurns:6` caps the total back-and-forth; the forced synthesis turn guarantees termination with an *answer* rather than an endless tool spiral. Bounded work, guaranteed output.

**Part E — Citations (the verifiability seam)**

Every retrieved chunk comes back with a citation string — the doc id plus a snippet — so the answer can be checked against its source.

**Citation construction**

```
  Hit { meta: { docId: "coffee.md", text: "Espresso, oat milk, no sugar…" } }
        │
        ▼ toResult: snippet = text.slice(0,157)+"…" if long
  citation = "[coffee.md] Espresso, oat milk, no sugar, every morning…"
        │
        ▼ returned to the model, who cites it in the answer
  reader can now VERIFY: open coffee.md, check the claim
```

```ts
// aptkit search-knowledge-base-tool.ts:108-117 — citation = [docId] + snippet
function toResult(hit) {
  const docId = typeof hit.meta.docId === 'string' ? hit.meta.docId : hit.id;
  const text = typeof hit.meta.text === 'string' ? hit.meta.text : '';
  const snippet = text.length > 160 ? `${text.slice(0, 157)}...` : text;
  return { …, citation: snippet ? `[${docId}] ${snippet}` : `[${docId}]`, meta: hit.meta };
}
```

Citations are the difference between a black box and an auditable one. `[coffee.md] …` lets the reader (or an eval) trace each claim to a source chunk. This is *why* the schema preserves `docId` from index through search through tool result — citation granularity is built into every layer's data shape. Recall file 04: the store *rebuilds* `meta.docId` on search precisely so this citation works.

**Part F — The fallback (refusal as a first-class answer)**

If the loop produces nothing usable, buffr returns an explicit "I couldn't find it" rather than an empty string or a hallucination.

**The fallback floor**

```
  finalText.trim()  ──► empty?
        │ no                    │ yes
        ▼                       ▼
  cited answer            FALLBACK_ANSWER:
                          "I couldn't find anything in the
                           knowledge base to answer that."
```

```ts
// aptkit rag-query-agent.ts:31, 82 — refusal beats a blank or a guess
const FALLBACK_ANSWER = "I couldn't find anything in the knowledge base to answer that.";
…
return finalText.trim() || FALLBACK_ANSWER;
```

The fallback is the grounding contract's "say so plainly" made mechanical. A RAG system that *can't say no* will fabricate; buffr makes "no answer in the KB" an explicit, honest output. Refusal is a feature, not a failure — it's what keeps the system trustworthy when the corpus is silent.

### Move 2.5 — Current vs. future

**buffr is honest single-stage RAG: real grounding, no rewrite/rerank/hybrid (yet).**

```
  TODAY (solid core)                 NOT YET EXERCISED (named in this sub-section)
  ──────────────────                 ─────────────────────────────────────────────
  raw question → cosine top-k        query rewrite / HyDE  (08) — query side
  single-stage ANN                   reranking             (07) — precision side
  dense only                         hybrid + RRF          (05,06) — sparse side
  grounding + citations + fallback   staleness / delta     (09,10) — freshness side
  ┌──────────────────────────┐
  │ the trustworthy core      │  ◄── these all PLUG INTO the same pipeline
  │ works end-to-end          │       without changing the grounding contract
  └──────────────────────────┘
```

The core — grounded, cited, refusable, bounded — is real and complete. The enhancements (rewrite, rerank, hybrid, freshness) are the *named gaps* of the other files, and every one of them slots into this same pipeline without touching the grounding contract. That's the architecture's payoff: the trustworthy core is stable, the quality levers are pluggable.

### Move 2.6 — The above-threshold rule (when NOT to use RAG)

**Don't add RAG where hand-picked retrieval already wins.**

```
  small, fixed, always-relevant context     large, dynamic, query-dependent corpus
  ──────────────────────────────────────    ──────────────────────────────────────
  the profile (me.md)                        the knowledge base (many docs)
  ──► inject DIRECTLY into the prompt         ──► RAG: retrieve only what's relevant
      (no search; it's always relevant)           (can't fit it all, varies per query)
  ┌──────────────────────────┐               ┌──────────────────────────┐
  │ deterministic, no recall  │               │ retrieval earns its cost  │
  │ risk, no latency           │               │ because hand-pick can't    │
  └──────────────────────────┘               └──────────────────────────┘
```

buffr demonstrates *both* answers in one system. The profile is small and relevant to every question, so it's injected directly at the start of the prompt (`injectProfile`, `src/session.ts:57`) — no retrieval, no recall risk. The knowledge base is large and query-dependent, so it gets RAG. The rule: RAG is for context you *can't* hand-pick because it's too big or too query-specific. If you can name the relevant context up front, inject it — retrieval is overhead you haven't earned.

### Move 3 — The principle

**RAG isn't "search plus an LLM" — it's a contract that the answer must come from retrieved, citable evidence or not be given.** The retrieval is the easy half; the grounding contract, the citations, the bounded loop, and the fallback are what make it *trustworthy*. buffr's core is a complete, honest implementation of that contract: it answers from your private corpus, shows its sources, and refuses when the corpus is silent. Every fancier retrieval technique in this sub-section is a quality upgrade *to the retrieval feeding this contract* — none of them change the contract itself. Get the contract right first; the levers come after.

## Primary diagram

The full RAG machine, index to grounded answer.

**buffr's complete RAG pipeline**

```
  OFFLINE INDEX                          ONLINE QUERY
  ─────────────                          ────────────
  file.md                                user question
   │ chunk(512/64)                        │
   │ embed(768)                           │ ┌─ profile (me.md) injected at START
   ▼                                      │ │  (above-threshold: hand-picked, no RAG)
  agents.chunks ◄───── same 768 space ────┤ ▼
   (vector + meta.docId)                  │ RagQueryAgent
                                          │  grounding contract: search-first,
                                          │  ground+cite, refuse-if-empty
                                          ▼
                              runAgentLoop (≤6 turns, ≤4 tool calls)
                                          │ calls search_knowledge_base
                                          ▼
                              cosine top-k ──► chunks + citations "[docId] …"
                                          │
                                          ▼ forced synthesis turn
                              answer grounded in chunks, cited
                                          │
                                          ▼ empty? ──► FALLBACK "couldn't find it"
                              ───────────────────────────────────────────────
                              trustworthy core; rewrite/rerank/hybrid/freshness
                              all plug in WITHOUT changing the contract
```

After the box: index and query meet in one 768-dim space; the contract turns retrieved chunks into a cited, refusable answer; and the whole thing has clean seams for every enhancement the other files describe.

## Elaborate

- **Retrieval-based memory rides the same pipeline.** buffr's conversation memory embeds each past exchange into the *same* store (tagged `kind=memory`, `src/session.ts:53`) so prior turns surface through the *same* `search_knowledge_base` tool. The RAG machine doubles as episodic memory — one retrieval path, two kinds of recall (knowledge + history).
- **`minTopK:4` is a RAG-quality knob, not just a count.** buffr floors top-k at 4 (`src/session.ts:43`) so a weak model can't starve its own retrieval by asking for `top_k:1` on a multi-part question. Small enough to dodge lost-in-the-middle, large enough to cover compound questions.
- **Least privilege: the agent can only search.** `ragQueryToolPolicy` grants exactly one tool — `search_knowledge_base`. The RAG agent can't write, can't call anything else. The grounding contract is enforced partly by *capability*, not just by prompt.
- **Filters are hallucination-resistant.** `matchesFilter` only excludes hits that *have* the filter key with a different value (`search-knowledge-base-tool.ts:101-106`), so a weak model inventing a filter key can't wipe every result. Robustness baked into the retrieval boundary.
- **The fallback is also an eval signal.** A rising fallback rate means the corpus has gaps or retrieval is missing — it's an observable health metric, not just a user-facing message.

## Project exercises

### Measure grounding faithfulness (do citations match claims?)

- **Exercise ID:** [B2A.8] (cite [C2.10], Phase 2A) — Case A: RAG core is implemented. This is the *next step* — verify the grounding contract actually holds.
- **What to build:** An eval that, for each answer, checks whether the cited `[docId]` chunks actually support the answer's claims (LLM-judge faithfulness, or string overlap against the cited chunk text). Track a faithfulness score and the fallback rate.
- **Why it earns its place:** The grounding contract is *instructed* but not *measured* — you don't yet know how often gemma2:9b answers from chunks vs. its own memory. This turns "grounded" from a prompt into a number.
- **Files to touch:** a new eval beside `src/cli/eval-cmd.ts` driving `RagQueryAgent` via `src/session.ts`; persist via `src/supabase-trace-sink.ts`.
- **Done when:** A report shows faithfulness and fallback rate over `eval/queries.json`, and you can name any query where the answer drifts off its citations.
- **Estimated effort:** 1–2 days.

### Add a retrieval-quality gate to the loop (refuse on weak hits)

- **Exercise ID:** [B2A.9] (cite [C2.10], Phase 2A) — Case A: builds on the fallback to make refusal smarter.
- **What to build:** Before synthesis, check the top hit's cosine score against a threshold (measured in [B2A.2]); if everything is below it, short-circuit to the fallback instead of letting the model strain to answer from weak evidence.
- **Why it earns its place:** Today the fallback only fires on an empty answer, not on *weak retrieval*. A score gate makes "the KB doesn't cover this" fire when it should — tightening the refuse-when-empty clause.
- **Files to touch:** the retrieval-to-synthesis seam (`src/session.ts` / around the tool), using scores from `src/pg-vector-store.ts`.
- **Done when:** A query with no good match returns the fallback via the score gate, and the eval confirms it doesn't regress good queries.
- **Estimated effort:** 1 day.

## Interview defense

**Q: "What makes buffr RAG and not just an LLM with search?"**

The grounding contract. The system prompt forces three things: search first, answer only from retrieved chunks *and cite them*, and refuse plainly if the KB lacks the answer. Plus a bounded loop and a fallback. Retrieval feeds it; the contract makes the answer come from evidence, not the model's memory.

```
  search-first ──► ground+cite ──► refuse-if-empty
  retrieval = evidence ; contract = binding
```

Anchor: *"The answer must come from the chunks, or not be given."*

**Q: "When would you NOT use RAG?"**

When the context is small, fixed, and always relevant — hand-pick it. buffr proves this: the profile is injected directly into the prompt (no search), the knowledge base gets RAG. Retrieval is for context too big or too query-specific to name up front. Otherwise it's overhead.

```
  always-relevant + small ──► inject directly
  large + query-dependent ──► RAG
```

Anchor: *"RAG is for context you can't hand-pick."*

**Q: "How does buffr stay trustworthy when it doesn't know?"**

It refuses. The grounding prompt says "say so plainly rather than guessing," and the code backs it with a `FALLBACK_ANSWER` when the loop produces nothing. Citations let any claim be checked against its source. Refusal and verifiability are first-class, not afterthoughts.

```
  empty/weak ──► FALLBACK ; every claim ──► [docId] citation
```

Anchor: *"A RAG system that can't say no will lie."*

## See also

- `./07-reranking.md`, `./08-query-rewriting-hyde.md`, `./05-dense-vs-sparse.md`, `./06-hybrid-retrieval-rrf.md` — the pluggable quality levers feeding this pipeline.
- `./09-stale-embeddings.md`, `./10-incremental-indexing.md` — keeping the corpus this pipeline retrieves over fresh.
- `../04-agents-and-tool-use/` — `runAgentLoop`, the turn budget, and least-privilege tool policy.
- `../02-context-and-prompts/02-lost-in-the-middle.md` — `minTopK:4` and profile-at-start as window curation.
- `../05-evals-and-observability/` — faithfulness, P@1/R@3, and fallback rate as RAG health metrics.
