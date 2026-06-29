# 05 — Eval-driven prompt iteration

**Industry term:** eval-driven iteration / golden sets + regression suites · the retrieval eval (`eval/queries.json` + `eval-cmd.ts`) · *Industry standard*

Here's the senior-vs-junior dividing line in one sentence: a junior iterates by vibes ("the response feels better now"); a senior iterates against an eval set. buffr is half senior here — it has a real eval set with a scorer, but it points at *retrieval*, not at the *prompt or the answer*. Naming that gap honestly is the whole point of this file.

## Zoom out, then zoom in

You've written a test that asserts a function returns the right value. An eval is that test for a probabilistic system: a set of inputs with expected outcomes, scored automatically, run on every change. buffr has one — for the retrieval layer.

```
  Zoom out — where the eval sits, and where it doesn't

  ┌─ Eval harness (src/cli/eval-cmd.ts) ──────────────────┐
  │  ★ EVALS RETRIEVAL ★  P@1, R@3 over eval/queries.json │ ← we are here
  └─────────────────────────┬──────────────────────────────┘
                            │  scores hits, NOT answers
  ┌─ Retrieval pipeline ────▼──────────────────────────────┐
  │  embed query → ANN search → ranked chunks              │  ← measured
  └─────────────────────────┬──────────────────────────────┘
                            │  chunks feed the prompt
  ┌─ Prompt + generation ───▼──────────────────────────────┐
  │  BASE_SYSTEM + chunks → Gemma → answer                 │  ← NOT measured
  └────────────────────────────────────────────────────────┘
```

Zoom in: eval-driven iteration means writing the eval *before* you tune the thing, then iterating change → run evals → diff → keep if improved without regressions. buffr does this for retrieval and by vibes for the prompt.

## Structure pass

**Layers:** the labeled set → the scorer → the layer under test. **Axis — "what does the score actually measure?":**

```
  axis: "what is the eval scoring?"

  ┌─ eval/queries.json ─┐ labels: query → expected source doc
  ├─ eval-cmd.ts ───────┤ scores: P@1, R@3 on RETRIEVED DOCS
  └─ the answer text ───┘ scored: NOTHING (no judge, no assertion)
```

**Seam:** the retrieval/generation boundary. The eval lives entirely on the retrieval side of it. Everything downstream — does the prompt ground correctly, does it cite, does it refuse honestly — is unmeasured.

## How it works

### Move 1 — the mental model

The kernel of an eval loop: **labeled set → run → score → diff → keep-if-better.** What breaks without each: no labels = nothing to score against; no score = you're back to vibes; no diff = you can't tell if you regressed.

```
  The eval loop kernel

  ┌─ golden set ─┐ change the   ┌─ run ─┐  ┌─ score ─┐  ┌─ diff ─┐
  │ query→expect │ ───thing───► │ query │─►│ P@1 R@3 │─►│ vs last│
  └──────────────┘              └───────┘  └─────────┘  └───┬────┘
                                                  keep if ↑ no regression
                                                           ▼
                                              (buffr: this loop exists
                                               for retrieval only)
```

### Move 2 — the walkthrough

**The golden set — small, hand-curated, expected outputs.** buffr's is three labeled queries, each with the source doc it should retrieve:

```json
// eval/queries.json
[ { "query": "what does the author do for work",        "relevant": ["work.md"] },
  { "query": "what programming stack and tools are used","relevant": ["stack.md"] },
  { "query": "how does the author take their coffee",    "relevant": ["coffee.md"] } ]
```

This is a golden set in the right shape — input + expected — just small (3 cases; production wants 20–50). And critically, the "expected" is a *source doc*, not an *answer*. The label says "the right chunk came back," not "the right answer was generated."

**The scorer — retrieval metrics.** `eval-cmd.ts` runs each query through the pipeline and scores precision@1 and recall@3 against the labeled docs:

```js
// src/cli/eval-cmd.ts
const hits = await pipeline.query(query, K);            // K = 3
const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;   // P@1
const r = scoreRecallAtK(docs, new Set(relevant), K).score;      // R@3
```

The boundary condition that matters: `pipeline.query` returns chunks. The model never runs in this harness. So this eval catches a retrieval regression (you changed the chunker and `work.md` stopped ranking first) but is blind to a prompt regression (you edited `BASE_SYSTEM` and the model stopped citing).

**What's missing — the prompt/answer eval.** Three things the spec calls for that buffr doesn't have:
- A **golden set of (question → expected answer properties)** — e.g. "must cite a source," "must refuse when KB is empty."
- A **regression suite** — production failures added back as permanent cases.
- **LLM-as-judge** — a second model scoring answer quality where exact-match won't work.

Recall from [02](02-structured-outputs.md) that citation is *unenforced* — the prompt asks, the tool pre-formats, the model copies if it feels like it. The only way to know your citation rate is to measure it, and buffr currently can't. That's the concrete cost of the gap.

### Move 2.5 — current vs future state

```
  Phase A (now)                  Phase B (buildable target)
  ─────────────                  ──────────────────────────
  eval/queries.json (3 cases)    + question→answer-property cases
  P@1, R@3 on retrieval          + LLM-as-judge on answer quality
  no answer-level assertions     + regression suite from prod failures
  prompt tuned by vibes          prompt tuned against the eval
```

What doesn't have to change: the harness shape (`eval-cmd.ts`) already loads a labeled set, runs it, and reports per-case + mean scores. Extending it to score answers is additive — same loop, a judge instead of a set-overlap metric.

### Move 3 — the principle

Write the eval before you iterate the prompt — otherwise you iterate in circles, improving the average while silently regressing the one critical edge case nobody tracked. Skipping evals isn't faster; it's slower, because you can't tell forward progress from sideways motion. buffr proves the discipline works on the retrieval side; the prompt side is waiting for the same treatment.

## Primary diagram

```
  buffr's eval coverage — measured vs vibes

  ┌─ MEASURED (eval/queries.json + eval-cmd.ts) ──────────┐
  │  query → pipeline.query → P@1, R@3 vs labeled docs    │
  └──────────────────────────┬─────────────────────────────┘
                             │ chunks feed prompt
  ┌─ VIBES (no harness) ─────▼─────────────────────────────┐
  │  prompt → Gemma → answer    grounding? cite? refuse?   │
  │  ✗ no golden answers  ✗ no judge  ✗ no regression suite│
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Hamel Husain's writing on evals is the canonical reference — the golden-set-plus-regression-suite discipline, and the warning that an eval which scored 4/5 for six months can turn out to have measured the wrong thing. buffr's eval is honest about *what* it measures (retrieval), which is better than a vague answer-quality score that nobody trusts. LLM-as-judge is appropriate exactly where buffr would need it: answer quality where exact-match is too brittle (does the answer ground in the retrieved chunk?). The prompt+model-version pairing from [03](03-prompts-as-code.md) is *why* this matters — a `gemma2:9b → gemma3` swap could regress citation behavior, and without an answer-level eval you'd ship the regression blind.

## Interview defense

**Q: How do you know a prompt change made things better and not worse?**

You measure it against an eval set, not by feel. This system has the discipline half-built: a labeled golden set and a scorer computing P@1 and R@3 — but it scores *retrieval*, not the generated answer. So retrieval changes are measured; prompt changes are still vibes.

```
  eval set → run → P@1/R@3 → keep-if-better   ← retrieval only
  prompt → answer → ??? (no judge, no golden answers)  ← the gap
```

Anchor: *"The first thing I'd add is an answer-level eval — golden cases asserting 'must cite a source,' 'must refuse on empty KB' — plus an LLM-as-judge for grounding quality. Citation is unenforced in the prompt; the only way to know the citation rate is to measure it. The harness shape is already there in `eval-cmd.ts`; extending it from set-overlap to a judge is additive."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — unenforced citation: the thing the eval gap leaves unmeasured
- [03-prompts-as-code.md](03-prompts-as-code.md) — the prompt+model pairing the eval would protect against
- `study-testing` — the AI-eval seam and the broader correctness story for this repo
