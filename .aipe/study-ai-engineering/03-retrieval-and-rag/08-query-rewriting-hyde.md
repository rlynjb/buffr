# Query rewriting & HyDE — the pre-retrieval step buffr skips

*Industry standard (NOT yet exercised). Transforming the query before it's embedded.*

## Zoom out, then zoom in

Pull up the query path and look at what happens to the user's question before it's embedded. In buffr: nothing. The raw query string goes straight into the embedder. Query rewriting (and its cousin HyDE) is a step that *transforms* the query first — to make it match the corpus better. buffr has no such step.

```
  Zoom out — the pre-retrieval transform buffr is missing

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  user question  ──►  search_knowledge_base({query})          │
  └───────────────────────────┬─────────────────────────────────┘
                              │ raw query (verbatim)
  ┌─ Retrieval layer ─────────▼─────────────────────────────────┐
  │  ★ rewrite / HyDE (MISSING) ★  →  embed → cosine ANN         │ ← here
  │  buffr: NO rewrite — embeds the raw string directly          │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You know how a search box sometimes silently "did you mean…" or expands your terms before searching? Query rewriting is that, done by an LLM, ahead of retrieval. **HyDE** (Hypothetical Document Embeddings) is the sharpest version: instead of embedding the *question*, you have the LLM write a fake *answer*, then embed *that* — because a hypothetical answer looks more like the real answer-chunk than the question does. buffr embeds the raw question, full stop. This file builds rewrite/HyDE and the Case-B move to add the step.

## Structure pass

Read the skeleton: retrieval with vs without a pre-transform.

**Layers:** raw query → (optional transform) → embed → search. buffr's transform layer is empty.

**Axis traced — "what text gets embedded?"**

```
  one axis: what actually gets turned into the query vector?

  ┌─ buffr today ───────────┐   THE RAW QUESTION — verbatim user string
  │  embed(query)            │   ("how do I renew it?") embedded as-is
  └────────────┬────────────┘
               │ seam: the missing transform lives here
  ┌─ rewrite / HyDE ────────┐   A TRANSFORMED STRING — a cleaned-up query,
  │  embed(LLM-rewritten)    │   OR a hypothetical ANSWER (HyDE) that looks
  └─────────────────────────┘   like the chunk you're hoping to retrieve
```

**The seam that matters:** the boundary between the user's words and the embedded text. A raw question is often a *bad* query — vague, pronoun-laden ("how do I renew *it*?"), phrased unlike the documents. The transform layer's job is to close the gap between *how people ask* and *how documents are written*. buffr's transform layer is empty, so that gap is never closed. Hold that: the question and the answer-chunk are different *kinds* of text, and embedding the question hopes they're close anyway.

## How it works

### Move 1 — the mental model

You know how a good search query isn't how you'd *say* it to a friend — you reword it to match what the page probably says? Query rewriting does that automatically. HyDE goes further with a clever inversion: it asks the LLM to *hallucinate the answer*, then searches for chunks similar to that fake answer — because a fake answer is shaped like a real answer-chunk, while the question is shaped like a question.

```
  the HyDE kernel — embed a fake answer, not the question

  question: "how do I renew it?"
     │ (1) ask LLM for a hypothetical answer
     ▼
  fake answer: "To renew a passport, submit form DS-82 with two photos..."
     │ (2) embed the FAKE ANSWER (not the question)
     ▼
  query vector  ── now lands near REAL answer-chunks ──►  cosine ANN
  why: answer-shaped text ≈ answer-chunk text  (question-shaped text isn't)
```

The kernel: transform the query (rewrite or generate-a-fake-answer) → embed the *transformed* text → search. The load-bearing insight is the type-match: embed text that's the same *kind* as what you want to retrieve.

### Move 2 — the step-by-step walkthrough

**Step 1 — what buffr does today: embed the raw query.** The query string is embedded verbatim, with zero pre-processing:

```ts
// aptkit packages/retrieval/src/pipeline.ts:55-58 (queryKnowledgeBase)
const [vector] = await wiring.embedder.embed([query]);   // ← raw query, no rewrite
if (!vector) return [];
return wiring.store.search(vector, topK);
```

`query` is whatever the agent passed into `search_knowledge_base`. There's no LLM call to clean it, expand it, or turn it into a hypothetical answer. Vague or pronoun-heavy queries embed exactly as vaguely as they're phrased.

**Step 2 — where the raw query hurts.** A query like *"what about the second one?"* (a follow-up referring to earlier context) embeds to a vector about "second" and "one" — useless. Even a clean question is *question-shaped*, not *answer-shaped*, so it sits a little off from the chunks that answer it. The gap is small but real, and it's pure upside to close.

```
  Comparison — raw query vs transformed query

  ┌─ buffr (raw) ────────────┐    ┌─ rewrite / HyDE ───────────┐
  │ embed("how renew it?")    │    │ rewrite: "passport renewal  │
  │ vague, pronoun, question- │    │   process and requirements" │
  │ shaped → off from chunks  │    │ HyDE: embed a fake ANSWER   │
  │                           │    │   → answer-shaped, on target│
  └───────────────────────────┘    └────────────────────────────┘
```

**Step 3 — the Case-B move: add a rewrite/HyDE step before embedding.** Insert one LLM call between "get the query" and "embed it." buffr already has a local generation model (`gemma2:9b`), so the transform is in-stack:

```
  // query rewrite / HyDE (the Case-B step to add)
  function transformQuery(rawQuery, mode):
      if mode == "rewrite":
          return llm.generate("Rewrite this as a search query: " + rawQuery)
      if mode == "hyde":
          return llm.generate("Write a short passage answering: " + rawQuery)
      // then the EXISTING path embeds the transformed string
  ...
  vector = embed( transformQuery(query, "hyde") )   // embed transformed, not raw
  hits   = store.search(vector, topK)               // unchanged downstream
```

```
  Layers-and-hops — where the transform would slot in

  ┌─ pipeline ───┐ hop 1: transformQuery (NEW)   ┌─ gemma2:9b ──────┐
  │ query()      │ ─────────────────────────────►│ rewrite / HyDE   │
  │ (NEW step    │ hop 2: transformed string ◄─── └──────────────────┘
  │  before embed)│ hop 3: embed(transformed)     ┌─ nomic-embed ────┐
  └──────┬───────┘ ─────────────────────────────►│ 768-vector       │
         ▼ hop 4: search(vector, k) → existing path, unchanged
```

Everything downstream (embed, cosine, ANN) is untouched — the transform is a pure prefix.

**Step 4 — the boundary condition: it adds latency and can mislead.** The rewrite is an extra LLM call per query (latency), and HyDE can *hallucinate wrong* — a fake answer about the wrong topic pulls retrieval off course. So like reranking, this needs measurement: does rewrite/HyDE improve precision@k enough to justify the extra generation call? Sometimes the raw query is already good and the transform only adds cost.

### Move 3 — the principle

Retrieval quality starts before retrieval. The query you embed is a knob, not a given — and the cheapest way to improve matches is often to fix the *query*, not the index. The deep idea behind HyDE is type-matching: embed text of the same *kind* as what you want to retrieve. You're searching answer-chunks, so embed an answer-shaped string, not a question-shaped one. The general lesson: when two things don't match well, transform one to look like the other before comparing.

## Primary diagram

The pre-retrieval transform buffr skips, one frame:

```
  query rewriting / HyDE — the step buffr doesn't run

  user question  "how do I renew it?"
     │
     │  ★ TRANSFORM (MISSING): rewrite OR generate fake answer ★
     │     buffr skips this — embeds the raw question
     ▼
  embed(query)  ──► cosine ANN ──► top-k
  ───────────────────────────────────────────────────────────
  Case B (with gemma2:9b):
    rewrite → cleaner search string         (cheap fix)
    HyDE    → embed a hypothetical ANSWER    (answer-shaped → on target)
  then the EXISTING embed→search path runs unchanged. MEASURE precision@k.
```

## Elaborate

Query transformation is a family. *Rewriting* cleans and expands the query (resolve pronouns, add synonyms, split a multi-part question). *Query expansion* adds related terms. *HyDE* (Gao et al., 2022) is the elegant one: generate a hypothetical document answering the query, embed *that*, and retrieve against it — it works because a generated answer, even an imperfect one, shares the vocabulary and shape of real answer-chunks far more than a question does, so it lands closer in embedding space.

For buffr, this is a clean Case-B because the generation model is already in-stack (`gemma2:9b` via Ollama) — the transform is one extra local LLM call, no new dependency. The honest caveat is the same as reranking and hybrid: it adds latency and can mislead (a hallucinated HyDE passage drags retrieval off-topic), so it must be measured, not assumed. It also interacts with buffr's agentic loop — in a multi-turn chat, rewriting to resolve "it"/"the second one" against conversation history is where rewrite earns the most.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Add a HyDE pre-retrieval step

- **Exercise ID:** HYD-1 (Case B — buffr embeds raw queries; add a transform).
- **What to build:** a `transformQuery(query, mode)` that, in HyDE mode, asks `gemma2:9b` for a short hypothetical answer and returns it to be embedded instead of the raw query; wire it before the embed call in the query path.
- **Why it earns its place:** it closes the question-shaped-vs-answer-shaped gap using the model already in-stack, with zero new dependency, and downstream stays untouched.
- **Files to touch:** new `src/retrieval/transform-query.ts` (calls the existing Ollama generation provider), wired into the query path in `src/session.ts` before retrieval; the embed/search path (`aptkit pipeline.ts:55-58`) stays unchanged.
- **Done when:** a vague query (e.g. with a pronoun) retrieves the correct chunk via its HyDE-transformed form where the raw query missed it.
- **Estimated effort:** half a day.

### Add conversation-aware query rewriting

- **Exercise ID:** HYD-2 (Case B — resolve follow-ups against history).
- **What to build:** a rewrite mode that takes the last few `agents.messages` turns and rewrites a follow-up ("what about the second one?") into a standalone query before embedding — then measure precision@k vs raw on a multi-turn eval set.
- **Why it earns its place:** in an agentic multi-turn chat, follow-up queries are where rewrite earns the most; it's the most realistic version of the gap.
- **Files to touch:** `src/retrieval/transform-query.ts` (add history-aware rewrite), reading recent `agents.messages` (schema `sql/001_agents_schema.sql:40-50`), wired in `src/session.ts`.
- **Done when:** a follow-up referencing earlier context retrieves the right chunk, with a precision@k delta vs raw on multi-turn cases.
- **Estimated effort:** half a day. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: Does buffr rewrite queries, and what's HyDE?**
Answer: no — buffr embeds the raw query string verbatim; there's no transform between the agent's `search_knowledge_base({query})` and the embed call. HyDE (Hypothetical Document Embeddings) is the sharpest version of the missing step: instead of embedding the *question*, you have the LLM write a hypothetical *answer* and embed *that* — because an answer-shaped string lands near real answer-chunks in embedding space, while a question-shaped string sits a little off. It's type-matching: embed the same kind of text you're retrieving.

```
  buffr: embed(raw question)  ← question-shaped, off from answer-chunks
  HyDE:  embed(LLM fake answer) ← answer-shaped → lands near real answers
```

**Q: Where would you add it in buffr, and what's the cost?**
Answer: one `transformQuery` step before the embed call, using the in-stack `gemma2:9b` — so no new dependency, and the embed→cosine→ANN path stays unchanged. The cost is an extra LLM call per query (latency) and the risk that HyDE hallucinates off-topic and drags retrieval astray, so it must be measured with precision@k, not assumed. The anchor: **the load-bearing idea people forget is that the query is a knob — fixing the query is often cheaper than fixing the index.**

```
  transformQuery (gemma2:9b) → embed transformed → existing search
  cost: +1 LLM call, can mislead → measure precision@k before shipping
```

## See also

- `01-embeddings.md` — why question-shaped and answer-shaped text land in different places.
- `07-reranking.md` — the *post*-retrieval quality lever (this one is pre-retrieval).
- `11-rag.md` — the query path where the raw query is embedded today.
- `../04-agents-and-tool-use/02-tool-calling.md` — the `{query}` argument the rewrite would transform.
