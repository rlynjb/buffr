# Evals — precision@k and recall@k (and the faithfulness gap)

**Industry name(s):** Offline retrieval evaluation / IR metrics (precision@k, recall@k) · Industry standard.

## Zoom out, then zoom in

How do you know retrieval works? Not by reading answers and nodding — by scoring it against a labeled set. `eval-cmd.ts` runs a golden set of query→relevant-doc pairs through the *exact* retrieval path the agent uses and prints precision@1 and recall@3. It's the only automated quality signal in buffr, and it covers exactly half of RAG.

```
  Zoom out — where evals sit

  ┌─ CLI layer ──────────────────────────────────────────────┐
  │  eval-cmd.ts → ★ scorePrecisionAtK / scoreRecallAtK ★     │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  for each labeled query
  ┌─ Library layer ───────────▼──────────────────────────────┐
  │  pipeline.query (same path the agent uses)                │
  │  (RubricJudge ships here — buffr does NOT consume it)     │
  └───────────────────────────┬──────────────────────────────┘
  ┌─ Storage ─────────────────▼──────────────────────────────┐
  │  agents.chunks (the indexed corpus)                       │
  └───────────────────────────────────────────────────────────┘
   labels: eval/queries.json  (golden set: query → relevant docIds)
```

Zoom in: an eval is a labeled set plus a scoring function. buffr labels three queries with their relevant document, retrieves top-k, and asks "of what I retrieved, how much was relevant (precision) and of what was relevant, how much did I retrieve (recall)." The verdict up front: buffr measures **retrieval** correctly but not **faithfulness** — whether the generated answer actually follows from the retrieved chunks is unscored, even though the library ships a rubric judge that could do it.

## Structure pass

Two layers, one axis: **what's being measured, and what's the ground truth?**

```
  Axis traced = "what's measured, what's the ground truth?"

  ┌─ MEASURED: retrieval ───────────────┐  ground truth = hand-labeled docIds
  │  did the right DOCUMENT come back?   │  → exact-match, deterministic
  │  scorePrecisionAtK / scoreRecallAtK  │  → cheap, no model needed
  └──────────────────┬───────────────────┘
                     │  seam — the eval boundary stops HERE
                     │  (everything below is UNMEASURED)
  ┌─ NOT MEASURED: generation ──────────┐  ground truth = would need a rubric
  │  did the ANSWER follow from chunks?  │  → faithfulness, hallucination
  │  RubricJudge exists, unused          │  → needs an LLM judge
  └──────────────────────────────────────┘
```

The seam is the lesson: buffr's eval boundary stops at retrieval. Above it, scoring is cheap and exact — comparing retrieved docIds to a hand-labeled set needs no model and is fully deterministic. Below it, scoring generation faithfulness needs an LLM judge (the library's `RubricJudge`), which buffr hasn't wired. So a run can score precision@1 = 1.0 (perfect retrieval) and still hand the user a hallucinated answer, and the eval would never know.

## How it works

Mental model: you know how a search-results test asserts "the expected URL is in the top 3"? IR metrics are that, made into fractions. Precision = "what fraction of what I showed was right." Recall = "what fraction of all the right answers did I show."

```
  Precision@k vs recall@k — same hits, two denominators

  query: "how does the author take their coffee"
  relevant (labeled): {coffee.md}
  retrieved top-3:    [coffee.md, work.md, stack.md]
                       ✓         ✗        ✗

  precision@1 = hits in top-1 / min(1, retrieved)  = 1/1 = 1.00
  recall@3    = distinct relevant hits / |relevant| = 1/1 = 1.00

  if retrieved were [work.md, coffee.md, stack.md]:
  precision@1 = 0/1 = 0.00   ← top result was wrong
  recall@3    = 1/1 = 1.00   ← but coffee.md is still in top-3
```

### Step 1 — load the golden set

`eval/queries.json` is a hand-curated array of `{query, relevant: [docId...]}`. Three items today, each with one relevant doc. This is the golden set from the spec's eval-set taxonomy — small, high-signal, "this is the right answer." It's read relative to the compiled file's URL so it works from `dist/`. Boundary condition: three items is enough to smoke-test, too few to trust a percentage — one query flipping moves the mean by 33%.

### Step 2 — retrieve through the real path

For each query, `pipeline.query(query, K)` runs — the *same* embed→cosine→rank path the agent's search tool uses (`02`). This is what makes the eval honest: it measures the production retrieval, not a parallel test rig. The hits are deduped to distinct docIds, because relevance here is per-document (two chunks from `coffee.md` count as one retrieved doc).

### Step 3 — score with the two metrics

```
  Layers-and-hops — one query scored

  ┌─ eval ────────┐ hop 1: query string     ┌─ pipeline ──┐
  │  per query    │ ──────────────────────► │  embed+cosine│
  │               │ hop 2: ranked hits       │  (file 02)  │
  │               │ ◄────────────────────── └──────────────┘
  │  dedupe→docIds│
  │  hop 3: scorePrecisionAtK(docs, relevant, 1)
  │  hop 4: scoreRecallAtK(docs, relevant, 3)
  └───────────────┘ → print P@1, R@3 per query, then means
```

`scorePrecisionAtK(docs, relevantSet, 1)` counts distinct top-1 docs that are relevant, over `min(1, retrieved)`. `scoreRecallAtK(docs, relevantSet, 3)` counts distinct top-3 relevant docs over the full relevant-set size. Both return `ok: false, score: 0` when not well-formed (k≤0 or empty sets) so a degenerate case doesn't pollute the mean with a fake 1.0. Boundary condition: precision's denominator is `min(k, retrieved.length)`, not `k` — a short result list isn't penalized for being short.

### Step 4 — what's missing: the faithfulness half

The eval stops here. There is no step that takes the *generated answer* and checks it against the retrieved chunks. The library's `RubricJudge` does exactly this — `generateStructured` against a rubric with dimensions, validated to a typed shape — but buffr's `eval-cmd.ts` imports only the two retrieval scorers. So hallucination, ungrounded claims, and ignored-context answers are all invisible to the eval.

### Move 3 — the principle

Measure retrieval and generation separately, because they fail separately. The principle: precision/recall tell you the right *chunks* came back; only a faithfulness judge tells you the *answer* used them. A RAG system with perfect retrieval and a hallucinating model scores 1.0 on buffr's current eval and still lies to the user. You can't fix what you don't measure, and buffr currently measures the easier half.

## Primary diagram

The full eval, what it covers and what it doesn't.

```
  buffr eval — full recap (and the gap)

  eval/queries.json (golden set)
     │ per {query, relevant}
     ▼
  ┌─ COVERED: retrieval scoring ──────────────────────────────┐
  │  pipeline.query(query, 3) → dedupe docIds                  │
  │  scorePrecisionAtK(docs, relevant, 1) → P@1                │
  │  scoreRecallAtK(docs, relevant, 3)    → R@3                │
  │  print per-query + mean                                    │
  └───────────────────────────────────────────────────────────┘
  ┌─ NOT COVERED: generation faithfulness ────────────────────┐
  │  answer = agent.answer(query)                              │
  │  RubricJudge.judge({subject: answer, context: chunks})    │ ← library has this,
  │  → groundedness / citation-accuracy / verdict             │   buffr doesn't wire it
  └───────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Run `npm run eval` after indexing the corpus to get a retrieval-quality number. It's the regression check: change the chunk size, the embedding model, or the corpus, and re-run to see if precision/recall moved. It's how you'd *measure before adding* a reranker or hybrid search — exactly the discipline the spec demands.

**Code side by side.**

```
  src/cli/eval-cmd.ts  (lines 22–33)

  const K = 3;
  for (const { query, relevant } of queries) {
    const hits = await pipeline.query(query, K);              ← real retrieval path
    const docs = [...new Set(hits.map((h) => String(h.meta.docId)))]; ← dedupe to docs
    const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;  ← P@1
    const r = scoreRecallAtK(docs, new Set(relevant), K).score;     ← R@3
    p1 += p; rk += r;
    process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)} R@${K} ${r.toFixed(2)}\n`);
  }
  process.stdout.write(`\nmean P@1 ${(p1/queries.length).toFixed(2)} ...`); ← aggregate
       │
       └─ P@1 and R@3 measure different things: P@1 = "is the BEST result right?",
          R@3 = "is the right doc anywhere in the top 3?". Both reported on purpose
```

```
  eval/queries.json  (the golden set, 3 items)

  [ { "query": "what does the author do for work", "relevant": ["work.md"] },
    { "query": "what programming stack and tools are used", "relevant": ["stack.md"] },
    { "query": "how does the author take their coffee", "relevant": ["coffee.md"] } ]
       │
       └─ one relevant doc each → recall@3 is binary per query (found or not).
          Useful smoke test; too small to trust a percentage. Grow it before
          drawing conclusions
```

The faithfulness gap — the library's `RubricJudge` is exported from `@rlynjb/aptkit-core` but appears nowhere in `src/`. Wiring it is the single highest-value eval addition.

## Elaborate

Precision@k and recall@k come from classic information retrieval — they predate RAG by decades. They're the right *offline* metrics for the retrieval stage: deterministic, model-free, fast. The deduplication-to-docIds is a deliberate modeling choice (relevance is per-document, not per-chunk), and the well-formed guards (`ok: false` on degenerate input) keep the aggregate honest.

The faithfulness gap is the most important finding in this file. The spec is emphatic about one thing: an LLM-as-judge should use a *stronger or different* model than the one being graded, to avoid self-preference bias. buffr's trap-to-avoid is concrete — if you wire `RubricJudge` with Gemma2:9b to grade Gemma2:9b's own answers, you've built exactly the self-preference bias the spec warns against. The right move is to judge with a different family (a hosted Claude/GPT model, or at least a different local model), accepting that this breaks the "fully local" property for the eval step only.

What to read next: `02-rag-query-path.md` (the retrieval this scores) and `04-gemma-tool-call-emulation.md` (a faithfulness eval would catch emulation failures that retrieval scoring can't see).

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Wire a faithfulness judge with a different model family

- **What to build:** An `eval-faithfulness-cmd.ts` that runs each golden query through `agent.answer`, then scores the answer against the retrieved chunks with the library's `RubricJudge` — using a *different* model than Gemma as the judge.
- **Why it earns its place:** Closes the biggest eval gap and demonstrates the self-preference-bias awareness the spec calls the key LLM-as-judge insight — "I judge Gemma's answers with a different model family on purpose."
- **Files to touch:** new `src/cli/eval-faithfulness-cmd.ts`, a rubric definition (groundedness, citation accuracy), a non-Gemma `ModelProvider` for the judge.
- **Done when:** the command prints a per-query faithfulness verdict and the judge model is provably not the one being graded.
- **Estimated effort:** 1–2 days.

### Grow the golden set and add a regression set

- **What to build:** Expand `eval/queries.json` to ~20 queries and add a separate `eval/regressions.json` seeded with any query that ever retrieved wrong.
- **Why it earns its place:** Three items can't support a trustworthy percentage; a regression set is how you stop re-introducing fixed retrieval bugs.
- **Files to touch:** `eval/queries.json`, new `eval/regressions.json`, `src/cli/eval-cmd.ts` (run both sets).
- **Done when:** `eval` reports means over a 20-item golden set and a separate regression-set pass/fail.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How do you measure whether your RAG works?**

```
  golden set → pipeline.query (real path) → dedupe docIds
  P@1 = best result right?   R@3 = right doc anywhere in top 3?
```

"I run a labeled query→relevant-doc set through the exact retrieval path the agent uses and score precision@1 and recall@3. It's deterministic and model-free, so it's a clean regression check — I'd run it before and after adding a reranker to prove the reranker helps." Anchor: measure retrieval before you optimize it.

**Q: What's the gap, and what's the trap in closing it?**

"It only measures retrieval, not faithfulness — a hallucinated answer over perfectly-retrieved chunks scores 1.0. The library ships a RubricJudge to close it, but the trap is self-preference bias: judging Gemma's answers with Gemma. The fix is to judge with a different model family, even though that breaks fully-local for the eval step." Anchor: judge with a stronger/different model than the one being graded.

## Validate

- **Reconstruct:** Write the difference between precision@1 and recall@3 as formulas, including the denominators. (`eval-cmd.ts:27-28`; library `precision-at-k.js`)
- **Explain:** Why dedupe hits to docIds before scoring? (`src/cli/eval-cmd.ts:26`)
- **Apply:** Retrieval scores precision@1 = 1.0 across the set, but users report wrong answers. What's unmeasured, and how would you measure it? (`eval-cmd.ts` imports only the two scorers; library `RubricJudge`)
- **Defend:** buffr's golden set has 3 items. Defend its current value, then name exactly when it stops being trustworthy. (`eval/queries.json`)

## See also

- `02-rag-query-path.md` — the retrieval path this scores.
- `04-gemma-tool-call-emulation.md` — failures a faithfulness eval would catch.
- `07-system-design-templates/01-search-ranking.md` — the eval framing in interview shape.
- `.aipe/study-testing/01-env-gated-integration-tests.md` — how DB-touching evals/tests gate on `DATABASE_URL`.
