# Eval methods

### The oracle ladder — exact-match, fuzzy, rubric, LLM-judge, pairwise, human — and where buffr stands

We've placed the eval set (`01`). Now: given an actual output and an expected one, *how do you decide if they match*? That decision is the **method** — the oracle. There's a ladder of them, cheap-and-rigid at the bottom, expensive-and-flexible at the top. buffr stands firmly on the bottom rung, and it's the right rung for what buffr measures.

```
THE EVAL STACK — the method is the oracle
┌──────────────────────────────────────────────────────────────┐
│  ★ METHOD    how actual vs expected is compared (THIS FILE)   │
│      ladder: exact ─ fuzzy ─ rubric ─ judge ─ pairwise ─ human│
├──────────────────────────────────────────────────────────────┤
│  Harness     src/cli/eval-cmd.ts                              │
├──────────────────────────────────────────────────────────────┤
│  Eval set    eval/queries.json (3 golden rows)               │  ← 01
└──────────────────────────────────────────────────────────────┘
```

The method is where rigor and cost trade off. Lead with it because picking the method *is* the eval-design decision — the set just supplies inputs.

## Structure pass

The single axis is **comparison rigidity vs. judgment flexibility.** At the bottom, the oracle is a deterministic function (`===`, set membership) — perfectly reproducible, zero cost, but blind to meaning. At the top, the oracle is a human — full meaning, but slow, costly, and irreproducible. Every rung trades reproducibility for the ability to judge *semantics*.

```
ONE AXIS — rigidity ↑ vs. flexibility ↓                buffr?
  exact-match ─────► id == id, set membership          ★ HERE
     "deterministic, free, blind to meaning"           precision@k
                                                        recall@k
  fuzzy-match ─────► overlap, edit distance, threshold  ✗
  rubric (coded) ──► scored checklist, programmatic     ✗
  LLM-as-judge ────► model scores against a rubric      ✗ (→ 03)
  pairwise ────────► judge picks A or B                 ✗
  human ───────────► a person reads and rates           ✗
        ▲
        │ reproducible & cheap                semantic & costly
        └──────────────────────────────────────────────►
```

The seam: buffr measures **retrieval** (did the right document come back?), which is an *identity* question — `work.md` either appeared in the top-k or it didn't. Identity is exactly what exact-match does perfectly. The moment you ask a *meaning* question — "is this answer faithful to the chunks?" — exact-match is useless and you must climb to the judge rung (that's `03`). buffr asks the identity question and stops.

## How it works

### Move 1 — mental model: precision and recall are two complementary counters

The two scorers buffr uses are counters over the same top-k window. **Precision@k** asks: *of what I showed, how much was right?* **Recall@k** asks: *of what was right, how much did I show?* Same numerator — distinct relevant ids in the top-k — different denominators.

```
THE PRECISION/RECALL PATTERN (one top-k window)
   relevant set = { work.md }          retrieved top-3 = [ work.md, stack.md, x.md ]
                                                            ●hit     miss     miss
   matched (distinct hits) ........ 1

   precision@1 = matched / min(k, retrieved)  = 1 / 1  = 1.00   "of top-1, all right"
   recall@3    = matched / |relevant set|     = 1 / 1  = 1.00   "of all right, all shown"
```

You know this shape from classification metrics. The only twist for *retrieval* is the **distinct** count: a document that appears as three chunks in the top-k is one hit, not three — buffr measures relevance *coverage*, not frequency. That's why the harness dedupes chunks to docIds before scoring.

### Move 2 — buffr's exact-match oracle, in code

buffr's method is two pure functions from aptkit, called once each per query. No model, no randomness, no network — the oracle is arithmetic.

**The numerator: distinct hits in the top-k.** This is the shared engine of both scorers. Bridging from set operations you know: it's `retrieved.slice(0,k)` intersected with `relevant`, counted as a set so duplicates collapse.

```
aptkit evals/precision-at-k.ts:27 — countDistinctHits
  const topK = retrievedIds.slice(0, k);        ← only the first k count
  const seen = new Set<string>();
  for (id of topK) if (relevantIds.has(id)) seen.add(id);   ← Set ⇒ distinct
  return seen.size;                             ← the shared numerator
```

**precision@1: of the top-1, what fraction was relevant.** The denominator is `min(k, retrieved.length)` — so a short result list isn't unfairly punished. buffr calls it with `k=1`: did the single best hit nail it?

```
src/cli/eval-cmd.ts:27                  precision-at-k.ts:53
  scorePrecisionAtK(docs,                 total = min(k, retrieved.length)
    new Set(relevant), 1).score           if (total === 0) → not well-formed
                                          matched = countDistinctHits(...)
  ▲ k = 1: "is the TOP hit right?"        score = matched / total
```

**recall@3: of all relevant, what fraction appeared in top-3.** Same numerator, denominator is the *full relevant set size*. buffr calls it with `k=K=3`: did the right document appear anywhere in the window the model actually sees?

```
src/cli/eval-cmd.ts:28                  precision-at-k.ts:74
  scoreRecallAtK(docs,                    total = relevantIds.size      ← full set
    new Set(relevant), K=3).score         if (total === 0) → not well-formed
                                          matched = countDistinctHits(...)
  ▲ K = 3: "did it show up at all?"       score = matched / total
```

**The "not-well-formed" guard is a correctness signal, not a quality one.** Both scorers return `{ ok: false, score: 0 }` when the metric is *undefined* — `k <= 0`, nothing retrieved, or an empty relevant set. A real score of `0` (retrieved the wrong thing) is `ok: true`. This distinction is exactly what lets an adversarial *must-refuse* row (empty `relevant`) be handled correctly instead of polluting the mean — see `01`'s [B3.7].

```
   ok:false  → metric UNDEFINED (k≤0, nothing retrieved, no relevant)   ← skip from mean
   ok:true, score:0 → measured a real MISS                              ← counts
```

**The harness aggregates to two means.** `eval-cmd.ts:29`–`33` sums per-query scores and divides by count: mean P@1 and mean R@3 are buffr's two headline numbers.

```
src/cli/eval-cmd.ts:29  p1 += p ;  rk += r
              :33  mean P@1 = p1 / queries.length
                   mean R@3 = rk / queries.length
```

### Move 2.5 — current vs. future: the rungs buffr skipped

buffr stops at exact-match. The higher rungs aren't wired — and one of them is the load-bearing gap.

```
            buffr today          what each higher rung would add
 exact      ★ P@k / R@k          (retrieval identity — DONE)
 fuzzy      ✗                    answer string overlap vs. expected
 rubric     ✗                    coded checklist (cites present? refused?)
 LLM-judge  ✗  ← THE GAP         FAITHFULNESS: is the answer grounded? → 03
 pairwise   ✗                    "is config A's answer better than B's?"
 human      ✗                    ground-truth for everything above
```

The skipped rung that matters is **LLM-as-judge**. Exact-match on docIds proves the *right chunks were retrieved*; it says nothing about whether the *answer* used them. An answer can retrieve `work.md` perfectly (P@1 = 1.00) and then hallucinate a job the document never mentions. buffr cannot currently detect that — measuring it requires the judge rung, which `03` covers, and the tool to do it (`RubricJudge`) already exists in aptkit but is unwired.

### Move 3 — the principle

**Pick the cheapest oracle that can see the failure you care about.** Don't climb the ladder for prestige — climb it only when the rung below is *blind* to your failure mode. buffr's failure mode for *retrieval* is "wrong document came back," which exact-match sees perfectly, so buffr correctly stays on the bottom rung for that question. Its failure mode for *generation* is "answer drifted off the chunks," which exact-match is blind to — so for *that* question, staying on the bottom rung isn't frugality, it's not measuring at all.

## Primary diagram

The full method ladder, buffr's position, and the one rung that's a real gap.

```
                      THE EVAL METHOD LADDER (buffr)
   cost/flexibility
      ▲   human ─────────── ✗  ground truth
      │   pairwise ──────── ✗  A vs B preference
      │   LLM-as-judge ──── ✗  FAITHFULNESS (the gap → 03; RubricJudge unwired)
      │   rubric (coded) ── ✗  scored checklist
      │   fuzzy-match ───── ✗  overlap / threshold
      │   exact-match ───── ★  precision@k / recall@k    ← BUFFR
      └──────────────────────────────────────────────────────►
                                                   reproducibility/cheapness
   ★ src/cli/eval-cmd.ts:27-28 → aptkit precision-at-k.ts (pure, deterministic)
   measures RETRIEVAL identity ·  does NOT measure generation faithfulness
```

## Elaborate

Why `k=1` for precision but `k=3` for recall is a deliberate asymmetry, not an oversight. Precision@**1** asks the hardest version of "is it right" — is the *single* top result correct? That's the metric a user feels, because they read the first hit. Recall@**3** asks the gentler "did it show up at all in the window the model synthesizes from?" — because the RAG model sees all three retrieved chunks, so a relevant doc at rank 3 is still usable. The two `k` values encode two different consumers: the human reading the top result, and the model reading the whole window.

Why exact-match on **ids** rather than on the answer text: buffr's eval deliberately stops at the retrieval boundary. The answer is non-deterministic (gemma2:9b sampling), so exact-matching answer *text* would be flaky — the same query yields different prose each run. docIds are deterministic given the same index and query, so the oracle is reproducible. This is the principled reason buffr evals retrieval and not generation with this method: retrieval is deterministic enough to exact-match, generation is not. Generation needs the *judge* rung precisely because it's non-deterministic — `03`.

## Project exercises

### Add a per-query failure view to the eval output

- **Exercise ID:** [B3.2] (cite [C3.2], Phase 3) — Case A: scores print; this is the next step — make *failures* legible, not just the mean.
- **What to build:** Extend `eval-cmd.ts` so that when a query scores below 1.0, it prints the expected docId, the actual top-k docIds, and the cosine scores — so a failing row tells you *why* it failed, not just that it did.
- **Why it earns its place:** Today a `P@1 0.00` line tells you something broke but not what came back instead. The failure view turns the eval from a thermometer into a debugger.
- **Files to touch:** `src/cli/eval-cmd.ts` (the loop body around lines 24–31), reading scores from `src/pg-vector-store.ts`.
- **Done when:** A deliberately-mislabeled query prints its wrong top-k and scores, and you can diagnose the miss from the output alone.
- **Estimated effort:** 0.5 day.

### Add a fuzzy answer-overlap method as a second oracle

- **Exercise ID:** [B3.3] (cite [C3.3], Phase 3) — Case B: no method above exact-match is wired. Primary build target.
- **What to build:** A `fuzzy` scorer that, for each golden query, runs the full `RagQueryAgent` and measures token/string overlap between the generated answer and the cited chunk text — a cheap, deterministic proxy for "did the answer use what it retrieved" before climbing to the LLM-judge.
- **Why it earns its place:** It's the rung between exact-match and the judge: it touches the *answer* (not just retrieval) without paying for a model judge, and exposes the cases the judge rung in `03` will need.
- **Files to touch:** new scorer beside `src/cli/eval-cmd.ts`; drive the agent via `src/session.ts`; cited chunks from `src/pg-vector-store.ts`.
- **Done when:** `npm run eval` reports a fuzzy overlap score per query alongside P@1/R@3, and a hallucinated answer scores visibly lower.
- **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Your eval scores 1.00 on P@1. Does that mean the answers are good?"**

No — and conflating the two is the trap. P@1 measures *retrieval*: the right document came back at rank 1. It says nothing about whether the *answer* used that document. An answer can retrieve `work.md` perfectly and then state a job the file never mentions — P@1 stays 1.00 while the answer is a hallucination. buffr measures retrieval identity, which exact-match does perfectly, and does **not** measure generation faithfulness, which needs the judge rung in `03`.

```
   retrieval P@1 = 1.00  ──►  right CHUNK retrieved   ✓ measured
   generation faithfulness ──►  answer USED the chunk  ✗ unmeasured (→03)
```

*Anchor: precision@k grades the retriever's aim, not the writer's honesty.*

**Q: "Why exact-match instead of an LLM judge, given LLM judges are everywhere now?"**

Because the cheapest oracle that can see my failure wins, and for *retrieval* the failure ("wrong doc") is an identity question that exact-match sees perfectly, deterministically, for free. An LLM judge here would add cost, latency, and bias (`03`) to answer a question arithmetic already answers exactly. I climb to the judge rung only for the question exact-match is *blind* to — faithfulness — and that's a named, separate eval, not a replacement for these scorers.

```
   question: "right doc?"      → exact-match (free, exact)      ✓ correct rung
   question: "faithful answer?"→ LLM-judge   (costly, biased)   only when needed
```

*Anchor: don't pay for a judge to answer a question a Set can answer.*

## See also

- **`01-eval-set-types.md`** — the corpus these methods score; the not-well-formed guard handles empty-`relevant` adversarial rows.
- **`03-llm-as-judge-bias.md`** — the next rung up, and why faithfulness needs it; the unwired `RubricJudge`.
- **`../03-retrieval-and-rag/11-rag.md`** — the pipeline these scorers run against, end to end.
- **`study-testing/`** — assertions and oracles; precision@k is a fuzzy assertion over a fixture.
