# LLM-as-judge bias — position, verbosity, self-preference

*Industry standard (LLM-as-judge evaluation). buffr's `RubricJudge` (aptkit) is wired into nothing yet — this is relevant the moment you wire it, with one buffr-specific trap: don't judge gemma2:9b with gemma2:9b.*

## Zoom out, then zoom in

The moment you use one LLM to grade another LLM's output, the grader brings its own biases. buffr is one wiring step away from this: aptkit ships a `RubricJudge`, buffr instantiates it nowhere (`02-eval-methods.md`). So this file is study-now, apply-when-wired — and the single most important buffr-specific point is a one-liner: **if you wire `RubricJudge` using gemma2:9b to grade gemma2:9b's own answers, you've built self-preference bias into your eval.**

```
  Zoom out — where the judge WOULD sit (unwired today)

  ┌─ Faithfulness eval (NOT wired) ─────────────────────────────┐
  │  ★ RubricJudge (aptkit) — an LLM grades the answer ★         │ ← we are here
  │   judge(answer, chunks) → {dimensions, verdict, fix}        │
  │   bias risk: position · verbosity · SELF-PREFERENCE         │
  └───────────────────────────┬─────────────────────────────────┘
                              │  would call a model to grade
  ┌─ Generator (gemma2:9b) ───▼─────────────────────────────────┐
  │  the model whose answers are being graded                   │
  │   ⚠ if judge model == generator model → self-preference     │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: three biases dominate LLM judges. **Position bias** — when comparing two answers, the judge favors whichever came first (or second). **Verbosity bias** — the judge rates longer answers higher regardless of correctness. **Self-preference bias** — a model rates outputs from its own family higher. buffr's specific exposure is the third: a local-first setup naturally reaches for the one model it already runs (gemma2:9b) as the judge, which is exactly the wrong choice.

## Structure pass

**Layers:** the eval harness → the judge model → the generated answer being graded.

**Axis — "what skews the judge's score, independent of actual quality?"**

```
  trace "what biases the score" across the judge

  ┌─ position ──────────────┐   order of options       (pairwise judging)
  │  favors A-then-B vs B-A  │   fix: swap order, average
  └─────────────────────────┘
  ┌─ verbosity ─────────────┐   answer length          (any judging)
  │  longer rated higher     │   fix: rubric scores grounding, not length
  └─────────────────────────┘
  ┌─ self-preference ───────┐   judge == generator family (buffr's trap)
  │  rates own output higher │   fix: DIFFERENT model family as judge
  └─────────────────────────┘

  same judge, three skews — each inflates a score for a non-quality reason
```

**The seam:** the judge→generator boundary is where self-preference lives. If the same model sits on both sides — gemma2:9b grading gemma2:9b — the boundary collapses and the eval grades itself. Keeping a *different* model family on the judge side is what makes that seam load-bearing instead of a mirror.

## How it works

### Move 1 — the mental model

Think of code review by the author versus by a peer. Author self-review (self-preference) misses what the author already thinks is fine. A reviewer who skims and approves the longest PR (verbosity) rewards bulk, not quality. A reviewer who always rubber-stamps the first diff in the queue (position) isn't reading. An LLM judge has all three failure modes, and the fixes are the same as in code review: a different reviewer, a rubric that scores substance, and randomized order.

```
  the three biases — score inflated for the wrong reason

  POSITION          VERBOSITY          SELF-PREFERENCE
  ────────          ─────────          ───────────────
  A first → A wins  longer → higher    same family → higher
  fix: swap+avg     fix: rubric on     fix: different
                       grounding          judge model
                                       buffr's live trap ⚠
```

### Move 2 — the step-by-step walkthrough

The judge isn't running in buffr, so this walks **the judge aptkit gives you and where each bias would bite.**

**Step 1 — `RubricJudge` grades an answer against a rubric, producing a structured verdict.** It's a single-answer (pointwise) judge: it scores one answer against named dimensions and returns a verdict + fix. Pointwise judging sidesteps *position* bias (there's no A-vs-B order), but *verbosity* and *self-preference* still apply.

```ts
// aptkit packages/evals/src/rubric-judge.ts:72-104 (the class buffr never calls)
export class RubricJudge {
  judge(input, options = {}): Promise<StructuredGenerationResult<RubricJudgment>> {
    return generateStructured({
      model: this.model,                              // ← WHICH model judges = the bias knob
      system: buildRubricJudgeSystemPrompt(this.rubric),
      userPrompt: buildRubricJudgeUserPrompt(input),  // the answer + chunks to grade
      validate: createRubricJudgmentValidator(this.rubric),
    });
  }
}
// returns { dimensions, checks?, verdict, fix, reasoning? }
```

`this.model` is the bias knob. Whatever you pass here is the grader, and its family determines self-preference exposure.

```
  Step 1 — pointwise judge, one bias knob

  RubricJudge({ model: ?, rubric }).judge({answer, chunks})
                       │
                       ▼  → {verdict: pass/fail, dimensions, fix}
  the "?" is the whole game: same family as generator → self-preference
```

**Step 2 — self-preference: the buffr trap, made concrete.** buffr runs gemma2:9b locally. The path of least resistance is to instantiate `RubricJudge({ model: new GemmaModelProvider(...) })` — the model you already have warm. Now gemma2:9b grades gemma2:9b's own answers, and research shows models systematically rate their own family's outputs higher. Your faithfulness scores come out inflated, and you'd trust them.

```
  Step 2 — the self-preference collapse

  WRONG (the easy path)              RIGHT
  ─────────────────────              ─────
  generator: gemma2:9b               generator: gemma2:9b
  judge:     gemma2:9b   ⚠           judge:     DIFFERENT family
  → grades its own output            → independent grader
  → inflated faithfulness scores     → trustworthy scores
```

The fix is one line — pass a different model family to `RubricJudge` than the one generating the answers. For a local-first setup that means running a second small model of a different lineage as the judge (or accepting a cloud judge for eval runs only).

**Step 3 — verbosity: defend against it in the rubric, not the model.** A judge left to its own instincts rewards longer answers. The defense is the *rubric*: score grounding and correctness explicitly ("is every claim supported by a retrieved chunk?"), so length stops being a proxy for quality. aptkit's judge takes the rubric as a constructor arg — the rubric design is where you spend the verbosity-bias defense.

```
  Step 3 — rubric kills verbosity bias

  bad rubric: "rate answer quality 1-5"   → judge rewards length
  good rubric: "every claim cite a chunk? (y/n) · unsupported claims? (count)"
              → length irrelevant; grounding is scored directly
```

**Step 4 — position bias: only if you go pairwise.** `RubricJudge` is pointwise, so buffr dodges position bias by default. It returns the moment you compare two answers (A/B testing two prompts, two models). Then the fix is mechanical: judge both orders (A-then-B and B-then-A) and average, so first-slot favoritism cancels.

```
  Step 4 — position bias (only in pairwise mode)

  judge(A, B) → A wins?   judge(B, A) → B wins?   ← disagreement = position bias
  fix: run both orders, average the verdicts (favoritism cancels)
```

### Move 2.5 — current state vs future state

```
  Phase A (today)                      Phase B (RubricJudge wired)
  ─────────────                        ───────────────────────────
  no judge running                     judge running per answer
  no bias exposure                     position (if pairwise),
                                         verbosity, self-preference live
  faithfulness UNMEASURED              faithfulness measured —
                                         only trustworthy if judge ≠ generator
```

The migration (also `02-eval-methods.md`'s EVAL-1): instantiate `RubricJudge` with a faithfulness rubric, feed it the answer + retrieved chunks from the trace. The bias work is the constraint on *how* you wire it — a different judge model family (kills self-preference), a grounding-focused rubric (kills verbosity), pointwise scoring or order-swapping (kills position). What doesn't change: the generator, the agent, the retrieval. The judge is additive; its bias discipline is design, not code volume.

### Move 3 — the principle

An LLM judge is a measurement instrument, and an instrument that shares a bias with the thing it measures isn't measuring — it's agreeing with itself. The single rule that protects every LLM-as-judge eval: **the judge must be independent of the generator** — different model family, a rubric that scores substance not style, and randomized order when comparing. buffr's local-first instinct (reuse the one model you run) is the exact instinct that breaks this, which is why naming it matters before the judge is ever wired.

## Primary diagram

```
  LLM-as-judge bias — the three skews and their fixes, buffr-anchored

  ┌─ RubricJudge({ model, rubric }).judge(answer, chunks) ───────┐
  │                                                              │
  │  POSITION (pairwise only)   ─► fix: swap order + average     │
  │   buffr: dodged (pointwise judge)                            │
  │                                                              │
  │  VERBOSITY (any judging)    ─► fix: rubric scores grounding  │
  │   buffr: design the faithfulness rubric to ignore length     │
  │                                                              │
  │  SELF-PREFERENCE  ⚠ LIVE    ─► fix: judge ≠ generator family │
  │   buffr trap: gemma2:9b judging gemma2:9b → inflated scores  │
  │   → use a DIFFERENT model family as the judge                │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

LLM-as-judge took off because human eval is slow and expensive, and a capable model agrees with human raters often enough to scale. The biases were documented almost immediately — Zheng et al.'s MT-Bench work named position and verbosity bias and the order-swap mitigation; self-preference was shown across model families soon after. The practical upshot for a local-first system like buffr is sharper than for a cloud one: cloud setups can casually reach for a strong third-party judge, while a local-first project's instinct is to reuse its single warm model — which is the precise setup that triggers self-preference. So buffr's bias risk is structurally higher *because* of its architecture, even though no judge runs yet. This connects directly to the faithfulness gap (`02-eval-methods.md`): the eval buffr most needs is the one most exposed to judge bias, so the two must be designed together — wire the judge, but wire it with a different family, a grounding rubric, and order-swapping if pairwise.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Wire RubricJudge with a non-Gemma judge model

- **Exercise ID:** JUDGE-1 (Case B — judge not yet exercised). **The exercise that makes this file real.**
- **What to build:** a faithfulness eval that instantiates aptkit's `RubricJudge` with a model from a *different family* than gemma2:9b (a second local model of another lineage, or a cloud judge for eval-only runs), scoring answer-vs-chunks.
- **Why it earns its place:** closes the faithfulness gap (`02-eval-methods.md`) AND demonstrates you designed around self-preference bias — the "I knew not to grade my model with itself" signal.
- **Files to touch:** new `src/cli/eval-faithfulness-cmd.ts`, instantiate `RubricJudge` with the non-Gemma judge model, reuse the agent build from `src/session.ts`, read chunks from `agents.messages.tool_results`.
- **Done when:** a hallucinated answer scores `fail` and a grounded one scores `pass`, with the judge model explicitly NOT gemma2:9b.
- **Estimated effort:** 1–2 days.

### Measure self-preference empirically

- **Exercise ID:** JUDGE-2 (Case B — bias quantified).
- **What to build:** run the same set of answers through two judges — gemma2:9b and a different family — and compare the verdicts to see how much gemma2:9b inflates its own scores.
- **Why it earns its place:** turns "self-preference bias exists" from a claim into a number you measured on your own system — the strongest possible defense of the design choice.
- **Files to touch:** extend the faithfulness harness from JUDGE-1 to run both judges and diff their verdicts.
- **Done when:** you have a measured gap between same-family and cross-family judging on identical answers.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: You want to use an LLM to score buffr's answer faithfulness. What biases do you design around?**
Answer: three. Position bias (the judge favors order in pairwise comparisons — fix by swapping order and averaging; buffr's `RubricJudge` is pointwise so it dodges this). Verbosity bias (longer answers score higher — fix with a rubric that scores grounding, not length). And self-preference (a model rates its own family higher) — which is buffr's live trap, because the easy local-first move is to judge gemma2:9b with gemma2:9b.

```
  position (swap+avg) · verbosity (rubric on grounding) · self-preference (different family)
```

**Q: What's the one rule you'd never break with an LLM judge?**
Answer: the judge must be independent of the generator — a different model family. **The part people forget, especially in local-first setups, is self-preference: reusing the one model you already run as the judge means it grades its own output and inflates the score.** For buffr that means NOT using gemma2:9b to judge gemma2:9b — wire `RubricJudge` with a different family even though gemma is the warm, convenient choice. An instrument that shares a bias with what it measures isn't measuring.

```
  the anchor:  judge ≠ generator family  →  gemma2:9b must NOT judge gemma2:9b
```

## See also

- `02-eval-methods.md` — the faithfulness eval `RubricJudge` would power, and the unwired gap.
- `01-eval-set-types.md` — the adversarial answers a judge would score.
- `04-llm-observability.md` — the trace the judge reads the answer + chunks from.
- `../04-agents-and-tool-use/02-tool-calling.md` — why a grounding rubric matters (silent garbage retrieval).
