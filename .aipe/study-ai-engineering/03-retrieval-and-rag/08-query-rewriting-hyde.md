# Query Rewriting & HyDE

### *industry: query rewriting / Hypothetical Document Embeddings (HyDE) · type: closing the query–document vocabulary gap before retrieval*

## Zoom out

Every file so far has worked on the *document* side — how docs are chunked, embedded, stored, ranked. This one works on the *query* side. The query you embed is the raw user question, and a question often doesn't look like the answer that answers it. That mismatch is the gap this file closes — and buffr leaves it wide open.

**buffr's retrieval stack, the query-side gap marked**

```
┌──────────────────────────────────────────────────────────────┐
│  RagQueryAgent          embeds the RAW question                │
├──────────────────────────────────────────────────────────────┤
│  ★ QUERY REWRITE / HyDE ★  reshape query → doc-space           │  ◄── this file
│                            NOT IMPLEMENTED — raw question only │
├──────────────────────────────────────────────────────────────┤
│  embeddings             embed(query) ──► cosine search         │
└──────────────────────────────────────────────────────────────┘
```

You embedded raw queries on your last app too — most people do, and it mostly works. This file shows the specific shape of query where it *doesn't*, and the two standard pre-retrieval fixes buffr doesn't have.

## Structure pass

The axis is **what you actually embed**: the user's words, or a transformed version closer to the answer's words. The seam is the transformation step that buffr skips.

**Raw query vs. rewritten/hypothetical query**

```
   RAW (buffr)                       REWRITTEN / HyDE (missing)
   ──────────                        ──────────────────────────
   embed the question verbatim       transform first, then embed:
   "how do I caffeinate"             • rewrite: "coffee preparation
        │                              method, brewing, espresso"
        ▼ may sit far from            • HyDE: draft a fake answer,
   the answer's vocabulary             embed THAT (it looks like a doc)
   ┌──────────────────┐              ┌──────────────────────────────┐
   │ embed(question)  │   ──seam──►  │ embed(transform(question))    │
   └──────────────────┘              └──────────────────────────────┘
        the seam: do you embed what was asked, or what an answer looks like?
```

Left of the seam: a question and its answer are different *shapes of text* — "how do I X?" is interrogative, the answer is declarative. Their embeddings can sit a measurable angle apart. Right of the seam: you first reshape the query toward answer-space (rewrite) or generate a fake answer and embed *that* (HyDE), so the search vector lands in the neighbourhood of real answers. Consequence: buffr embeds a question into a space organized by *answers*, and eats whatever angle that mismatch costs.

## How it works

### Move 1 — Mental model: search with the answer's words, not the question's

If you wanted to find a paragraph about espresso, you wouldn't search "how do I caffeinate" — you'd search "espresso oat milk no sugar," words that *appear in the answer*. HyDE does this automatically: it has the LLM write a plausible answer first, then searches with that, because a fake answer shares vocabulary with the real one far better than the question does.

**HyDE: draft an answer, search with it**

```
  question: "how does the author take their coffee"
        │ LLM drafts a HYPOTHETICAL answer (may be wrong on facts!)
        ▼
  "The author drinks espresso with oat milk, no sugar, every morning."
        │ embed THIS (it's answer-shaped, like real docs)
        ▼
  search ──► lands near the REAL coffee chunk
            (shared vocabulary: espresso, oat milk, morning)
```

Frontend bridge: it's autocomplete that rewrites a typo'd, vague search into the canonical query before hitting the index — "stripe refund api" expanded to the terms your docs actually use. You search the *normalized* query, not the raw keystrokes.

### Move 2 — Walk the mechanism

**Part A — buffr embeds the raw question (the honest state)**

The query path takes the user's question and embeds it directly. No rewrite, no HyDE, no expansion.

**The raw-query path**

```
  user question ──► embed([query]) ──► search(vector, k)
                    ▲
          the EXACT question text becomes the search vector
          (no transformation step)
```

```ts
// aptkit pipeline.ts:50-58 — query path embeds the raw string
export async function queryKnowledgeBase(query, wiring, topK = 5) {
  const [vector] = await wiring.embedder.embed([query]);   // raw question
  if (!vector) return [];
  return wiring.store.search(vector, topK);
}
```

```ts
// aptkit rag-query-agent.ts:62-80 — the agent passes the question through unchanged
async answer(question: string, …) {
  …
  userPrompt: question,   // raw; the tool embeds it verbatim
}
```

The question travels from `RagQueryAgent.answer(question)` to `search_knowledge_base` to `embed([query])` *unmodified*. Whatever vocabulary mismatch exists between the question and the answer is carried straight into the search vector. There is no stage that would reshape it.

**Part B — Where a rewrite chain would slot in**

A pre-retrieval LLM call transforms the question before it's embedded — either rewriting it toward doc-vocabulary or drafting a hypothetical answer to embed.

**The rewrite-before-retrieve chain**

```
  question
    │ STAGE 0 (missing): LLM rewrite / HyDE
    ▼ transformed query (answer-shaped vocabulary)
    │
    ▼ embed ──► search ──► chunks ──► answer
  ───────────────────────────────────────────
  one extra LLM call BEFORE retrieval,
  feeding the existing query path unchanged
```

The plug point is clean: the transformation produces a *string*, and the existing path already takes a string. So a rewrite stage is a prompt-chain link *in front of* `search_knowledge_base` — it doesn't touch embeddings, the store, or the agent loop. This is the same prompt-chaining shape `../02-context-and-prompts/03-prompt-chaining.md` describes: one call with one job (reshape the query) feeding the next.

### Move 2.5 — Current vs. future

**Case B: buffr does no query transformation. It embeds the raw question, period.**

```
  TODAY                              REWRITE / HyDE (this is the gap)
  ─────                              ───────────────────────────────
  embed(raw question)                STAGE 0: rewrite or HyDE
                                       │
  ┌──────────────────┐               ┌──────────────────────────────┐
  │ question ──► vec │               │ question ──► LLM ──► better    │
  └──────────────────┘               │ query/fake-answer ──► vec      │
   vocabulary gap unaddressed        └──────────────────────────────┘
                                      query lands in answer-space
```

The cost is one extra LLM call per query, in the request path — real latency on a local model. So this earns its place only on corpora where the question/answer vocabulary gap is wide. For buffr's short, plain-spoken markdown notes the gap is modest; on a jargon-heavy or multi-domain corpus it'd matter more. Measure the gap before paying the latency.

### Move 3 — The principle

**Retrieval quality depends on the query as much as the corpus, so the query deserves engineering too.** Every other file optimizes the document side; this one says the *search vector* is also a design surface. A raw question is a convenient default, not an optimal query — it's shaped like a question, and your index is shaped like answers. buffr embedding the raw question is honest and simple, but it's leaving a query-side lever entirely unpulled. The discipline: when retrieval misses, ask whether the *query* was the problem before blaming the index.

## Primary diagram

The raw path buffr has, and the transformed path it's missing.

**Two query shapes hitting the same index**

```
  RAW (buffr today)                  TRANSFORMED (the gap)
  ─────────────────                  ─────────────────────
  question                           question
     │                                  │ LLM rewrite OR HyDE draft
     │ embed                            ▼ answer-shaped query
     ▼                                  │ embed
  search vector ──┐                     ▼
                  │                  search vector ──┐
  ────────────────┴─────────────────────────────────┴────────────
        both hit:  search(vector, k) over agents.chunks
        but the transformed vector lands nearer real answers
```

After the box: same index, same store, same agent — the only difference is *which vector* you search with, and that vector is something you can engineer instead of accept.

## Elaborate

- **HyDE tolerates a factually-wrong draft.** The hypothetical answer doesn't need to be correct — it only needs to be *shaped like* the real answer, with overlapping vocabulary. Its embedding pulls the search toward the right region; the real chunks still supply the actual facts. Wrong-but-answer-shaped beats right-but-question-shaped for *retrieval*.
- **Rewrite is cheaper and safer than HyDE.** A rewrite ("expand to synonyms, normalize") is a smaller, more controllable transform than generating a whole fake answer. It's the lower-risk first step; HyDE is the heavier hammer.
- **It composes with multi-part questions.** A rewrite stage can also *split* a compound question ("my work and my coffee?") into sub-queries, each retrieved separately — addressing the same multi-part miss that `minTopK:4` patches from the other side.
- **The cost is real and in-path.** Unlike chunking (offline) or reranking (over a small set), query rewrite is one LLM call *before every retrieval*. On a local model that's noticeable latency — which is exactly why it should be gated on measured benefit.

## Project exercises

### Add a query-rewrite chain before retrieval

- **Exercise ID:** [B2B.8] (cite [C2.7], Phase 2B) — Case B: buffr embeds the raw question; query rewriting is **not implemented**. This is the primary target.
- **What to build:** A pre-retrieval LLM step that rewrites the user's question toward answer-vocabulary (synonym expansion, normalization, optional sub-question split), then feeds the rewritten string into the existing query path. A/B against raw on the eval.
- **Why it earns its place:** It's the unpulled query-side lever, and it's a clean prompt-chain link in front of `search_knowledge_base` — no change to embeddings or the store. Reuses the local model already wired.
- **Files to touch:** a rewrite step before `pipeline.query` (in `src/session.ts` or around the tool); reuse `GemmaModelProvider` from `src/session.ts`; verify with `src/cli/eval-cmd.ts`.
- **Done when:** `eval-cmd` shows rewritten-query P@1/R@3 vs. raw, and you can state whether the gain beats the added per-query latency.
- **Estimated effort:** 1–2 days.

### Prototype HyDE and compare to rewrite

- **Exercise ID:** [B2B.9] (cite [C2.7], Phase 2B) — Case B: the heavier query-side transform.
- **What to build:** A HyDE step — draft a hypothetical answer with gemma2:9b, embed *that*, search with it — run head-to-head against the rewrite from [B2B.8] and raw on the eval set.
- **Why it earns its place:** HyDE and rewrite attack the same gap differently; only the eval says which buffr's corpus prefers, and at what latency. This is the measurement that picks the right tool.
- **Files to touch:** a HyDE variant of the [B2B.8] step; `src/cli/eval-cmd.ts` to compare all three modes.
- **Done when:** A three-way table (raw / rewrite / HyDE) shows P@1/R@3 and latency, and you can defend buffr's choice.
- **Estimated effort:** 1 day (after [B2B.8]).

## Interview defense

**Q: "Why would you transform a query before embedding it?"**

Because a question and its answer are different shapes of text, so their embeddings sit apart in a space organized by answers. Rewriting toward answer-vocabulary — or HyDE, embedding a drafted fake answer — moves the search vector into the answer neighbourhood. buffr embeds the raw question and eats that gap.

```
  raw question ──► question-shaped vector ──► gap
  rewrite/HyDE ──► answer-shaped vector ──► lands near real answers
```

Anchor: *"Search with the answer's words, not the question's."*

**Q: "Why doesn't buffr do this already, and when should it?"**

Because it's one extra in-path LLM call per query — real latency on a local model — and buffr's short markdown notes have a modest vocabulary gap. It earns its place on jargon-heavy or multi-domain corpora. Measure the gap on the eval before paying for it.

```
  cost: +1 LLM call per query (in-path)
  worth it when: wide question↔answer vocabulary gap
```

Anchor: *"The query is a design surface — but pay for it only when it pays back."*

## See also

- `../02-context-and-prompts/03-prompt-chaining.md` — query rewrite is a prompt-chain link in front of retrieval.
- `./01-embeddings.md` — why question-shaped and answer-shaped text land at an angle.
- `./11-rag.md` — where the (raw, today) query feeds the grounded answer.
- `../05-evals-and-observability/` — the eval that decides whether rewrite/HyDE earns its latency.
