# Model selection — baselining and the compare-on-val loop

*Industry standard (model selection / baselining). buffr selects no model — its retrieval ranker is a parameter-free cosine baseline. Not yet implemented.*

## Zoom out, then zoom in

The TRAIN stage of the pipeline (`01-supervised-pipeline.md`) is where you pick a model — and the discipline isn't "pick the best," it's "train a couple, compare on the *validation* set, and pick the simpler one if it's close." buffr selects nothing, but it does ship a de-facto baseline model: the cosine-similarity ranker in `src/pg-vector-store.ts`, a parameter-free function that any learned reranker would have to *beat on the eval set* to justify its complexity.

```
  Zoom out — where model selection sits; buffr's de-facto baseline

  ┌─ Storage (Supabase) ─────────────────────────────────────────┐
  │  agents.chunks.embedding  vector(768)                        │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ ranked by
  ┌─ Retrieval (src/pg-vector-store.ts) ─▼────────────────────────┐
  │  cosine ranker: 1 - (embedding <=> $1::vector)  ← BASELINE    │
  │  parameter-free · no training · the model to BEAT            │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ model SELECTION WOULD attach here
  ┌─ ML SELECTION — ★ NOT PRESENT ★ ─▼────────────────────────────┐ ← we are here
  │  logistic regression  vs  gradient-boosted trees             │
  │  compare on VAL · pick simpler if comparable                 │
  │  buffr: no learned model selected (cosine baseline only)     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **model selection** is choosing the model family and settings by comparing candidates on held-out data. The two workhorse baselines are **logistic regression** (linear, interpretable, fast, well-calibrated-ish) and **gradient-boosted trees** (nonlinear, handles interactions automatically, usually wins on tabular data — but heavier and harder to read). The discipline: train both, compare on the **validation** set (not train, not test), and pick the *simpler* one if scores are comparable — a 0.5% AUC gain rarely justifies losing interpretability and serving simplicity. The contrl pose pipeline rhymes faintly here: a threshold on a joint angle was a parameter-free baseline, exactly like buffr's cosine score — the simplest "model" that works, beaten only if something complex earns it.

## Structure pass

**Layers:** the candidate models (bottom) → the comparison loop → the selection decision (top).

**Axis — "what's the cost of this model beyond its accuracy?"** Trace it across the two families and the choice stops being "just pick the higher number."

```
  trace "what does this model COST beyond accuracy?"

  ┌─ logistic regression ─┐  cost: low — interpretable, fast, calibrated-ish
  │  linear               │  weakness: misses interactions unless engineered
  └───────────┬───────────┘
  ┌─ gradient-boosted ────┐  cost: high — opaque, heavier to serve, tune-hungry
  │  trees (nonlinear)    │  strength: finds interactions, usually higher AUC
  └───────────┬───────────┘
  ┌─ cosine baseline ─────┐  cost: ~zero — parameter-free, one SQL expression
  │  (buffr today)        │  weakness: can't learn; pure geometric similarity
  └───────────────────────┘

  higher accuracy is one axis; interpretability + serving cost is another
```

**The seam:** the boundary between train-set scores and validation-set scores. This is where selection either works or fools you. On the train side, a flexible model (GBT) always looks better — it can memorize. On the val side, you see *generalization*, and the gap between the two is overfitting. The axis-answer flips across that seam: "which model is better?" reverses depending on which set you ask. Selection that compares on *train* picks the overfitter; selection that compares on *val* picks the generalizer. That seam is the whole game.

## How it works

### Move 1 — the mental model

You already do this when you A/B two implementations: you don't pick the one that's faster on the dev machine you built it on, you pick the one that's faster on a *fresh* benchmark — and if they're a wash, you keep the simpler code. Model selection is that, with one hard rule: the "fresh benchmark" is the validation set, *never* the training data the model already saw, and *never* the test set you're saving for the final number.

```
  PATTERN — the compare-on-val selection loop

  ┌─ candidates ─┐
  │ A: logistic  │──┐
  │ B: GBT       │  │ fit each on TRAIN
  └──────────────┘  ▼
              ┌─ score each on VALIDATION (not train, not test) ─┐
              │  A: AUC 0.84      B: AUC 0.845                    │
              └───────────────────────┬──────────────────────────┘
                                      ▼
              gap ≤ tolerance? ──► pick SIMPLER (A)
              gap large?       ──► pick STRONGER (B)
                                      │
                                      ▼
              report the WINNER's number on TEST (once)
```

The strategy: fit on train, choose on val, report on test — and let interpretability break ties.

### Move 2 — the step-by-step walkthrough

Four moves: the two baseline families, the bias/variance lens, the compare-on-val loop, and the simpler-if-comparable rule.

**Logistic regression — the linear, interpretable baseline.** It fits a weighted sum of features through a sigmoid to produce a probability. Its virtues are exactly its limits: every feature has one readable weight (you can *explain* a prediction), it trains in milliseconds, it serves as a dot product, and its outputs behave roughly like probabilities. Its weakness: it's linear, so it can't see interactions unless you hand-engineer them (`02-feature-engineering.md`).

```
  Logistic regression — weighted sum → sigmoid → probability

  features          weights (READABLE)
  tokens_scaled ───► w1=0.4 ┐
  tool_calls ──────► w2=0.9 ├─ sum ─► sigmoid ─► P(good)=0.73
  had_error ───────► w3=-1.2┘         (each w explains its feature)
  strength: interpretable, fast, calibrated-ish
  weakness: linear — needs engineered interactions to see combos
```

**Gradient-boosted trees — the nonlinear workhorse.** It builds many small decision trees in sequence, each correcting the last one's errors. It finds feature interactions *automatically* (a tree can branch on `tool_calls` then on `had_error` without you engineering the product), and it usually wins on tabular data. The cost: it's opaque (no single weight per feature), heavier to serve, and has more knobs to tune.

```
  Gradient-boosted trees — sequential trees, each fixes the last

  tree_1 (rough) ─► residuals ─► tree_2 (fixes them) ─► ... ─► tree_N
                                                              │
  prediction = sum of all trees' outputs ◄────────────────────┘
  strength: finds interactions itself · usually highest AUC on tabular
  weakness: opaque · heavier serving · more hyperparameters
```

**The bias/variance lens — why GBT looks better on train.** This is the trap selection exists to avoid. Logistic regression is high-bias / low-variance: it underfits a bit but is stable. GBT is low-bias / high-variance: it can fit anything, *including the training noise*. So GBT almost always wins on the train set — and that tells you nothing, because the win might be memorization.

```
  Bias/variance — why train-set scores mislead

  model        train score   val score    gap = overfit signal
  ──────────   ───────────   ─────────    ────────────────────
  logistic     0.83          0.84         small  (stable, underfits a touch)
  GBT (deep)   0.99          0.81         HUGE   (memorized train → worse on val)
  GBT (tuned)  0.88          0.845        small  (regularized → generalizes)

  → never select on train; the flexible model always "wins" there
```

The boundary condition: a big train-vs-val gap is the alarm — it means the model fit noise, and you regularize (shallower trees, fewer of them) until the gap closes.

**The compare-on-val loop and the simpler-if-comparable rule.** You fit both on train, score both on val, and apply a decision rule *with a tolerance*. If GBT beats logistic by a hair, you keep logistic — because interpretability and serving simplicity are worth more than a rounding-error AUC gain.

```
  pseudocode — select with a simpler-if-comparable rule

  fit logistic on TRAIN ; fit gbt on TRAIN
  auc_lr  = score(logistic, VAL)            // e.g. 0.840
  auc_gbt = score(gbt,      VAL)            // e.g. 0.845
  if (auc_gbt - auc_lr) <= TOLERANCE:       // TOLERANCE e.g. 0.01
      pick logistic                         // simpler wins ties
  else:
      pick gbt                              // complexity earned its place
  report pick.score on TEST  (once)         // the honest final number
```

For buffr, this loop has a concrete shape: the **cosine ranker in `src/pg-vector-store.ts` is the baseline**, and a learned reranker is the "GBT" you'd compare against it.

```ts
// src/pg-vector-store.ts:70-77 — buffr's de-facto baseline "model"
`select id, content, ...,
        1 - (embedding <=> $1::vector) as score   // parameter-free ranker
 from agents.chunks
 where app_id = $2
 order by embedding <=> $1::vector                // pure cosine, nothing learned
 limit $3`
```

A learned reranker (taking FEAT-2's features) only earns its place if it beats this cosine baseline on `eval/queries.json` by more than your tolerance — otherwise you keep the one-line SQL expression that has zero parameters to train, monitor, or drift.

### Move 3 — the principle

Model selection isn't "find the highest number" — it's "find the simplest model whose number is good enough, judged on data it didn't train on." Two rules carry it: compare on the validation set, because the flexible model always wins on train by memorizing; and break ties toward simplicity, because interpretability, serving cost, and the ability to debug are real value that a 0.5% AUC gain rarely outweighs. The generalizing version: a parameter-free baseline that's *almost as good* usually beats the learned model that's marginally better — buffr's cosine ranker is that baseline, and the burden of proof sits on any learned thing that wants to replace it.

## Primary diagram

The full selection discipline, both families, the val seam, and buffr's baseline.

```
  Model selection — fit on train, choose on val, simpler-if-comparable

  ┌─ candidates ──────────────────────────────────────────────┐
  │ LOGISTIC REGRESSION        GRADIENT-BOOSTED TREES          │
  │ linear · interpretable     nonlinear · finds interactions  │
  │ fast · calibrated-ish      heavier · opaque · tune-hungry  │
  │ (high bias/low variance)   (low bias/high variance)        │
  └───────────────┬────────────────────────┬───────────────────┘
       fit on TRAIN                fit on TRAIN
                  ▼                        ▼
  ┌─ compare on VALIDATION (the seam — NOT train, NOT test) ───┐
  │  auc_lr = 0.840        auc_gbt = 0.845                      │
  │  gap ≤ tolerance? → pick LOGISTIC (simpler wins)           │
  │  gap large?       → pick GBT (complexity earned it)        │
  └───────────────────────────┬────────────────────────────────┘
                              ▼
                report winner on TEST (once) → honest number

  ★ buffr's baseline = cosine ranker (src/pg-vector-store.ts):       ★
  ★ parameter-free; a learned reranker must BEAT it on eval to ship  ★
```

## Elaborate

"Train both, compare on val, prefer the simpler" is the bread-and-butter of applied ML, and the logistic-vs-GBT pairing is the canonical baseline duel for tabular problems (gradient boosting via XGBoost / LightGBM / CatBoost dominates tabular Kaggle, while logistic regression remains the interpretable reference everyone starts from). The "simpler if comparable" instinct is the practitioner's version of Occam's razor, and it's load-bearing in production for reasons accuracy charts hide: a linear model you can explain to a stakeholder, serve as a dot product, and debug by reading weights is often worth more than a marginally-better black box. This connects forward to calibration (`09-calibration.md` — logistic's probabilities are usually more trustworthy than a tree ensemble's) and back to features (`02` — logistic *needs* engineered interactions that GBT discovers for free). For buffr the honest frame is that it already lives by this principle by default: its retrieval "model" is the simplest possible thing, a parameter-free cosine score, and nothing has earned the right to replace it — which is exactly the right place to start. The reranker exercise below is how you'd *test* whether something has earned it.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Compare the cosine baseline against a tiny learned reranker on the eval set

- **Exercise ID:** SEL-1 (Case B — model selection not yet implemented). **The core exercise: it runs a real compare-on-val loop with buffr's baseline as the incumbent.**
- **What to build:** take the cosine ranker in `src/pg-vector-store.ts` as the baseline, train a tiny learned reranker (logistic regression over FEAT-2's per-hit features), and compare both on `eval/queries.json` via `src/cli/eval-cmd.ts` — same metric, same data, head to head.
- **Why it earns its place:** it forces the discipline of *baselining before complexity* on buffr's one real ML-adjacent path, and usually proves the parameter-free baseline is hard to beat — the most useful lesson in model selection. The "I held my reranker to beating the cosine baseline on the eval set" story.
- **Files to touch:** `src/pg-vector-store.ts` (baseline scores); the per-hit features from FEAT-2; `src/cli/eval-cmd.ts` (run both, report both numbers); `eval/queries.json` (the comparison set, split per SPLIT-2).
- **Done when:** the harness prints both models' scores on the eval set, side by side, from the same run.
- **Estimated effort:** 1–2 days.

### Pick a metric and a simpler-if-comparable decision rule, and record both models' val scores

- **Exercise ID:** SEL-2 (Case B — selection rule not yet implemented).
- **What to build:** define the selection metric (e.g. P@1 or R@3) and an explicit decision rule with a tolerance ("keep the cosine baseline unless the reranker beats it by ≥ X"), then have the harness print the rule's verdict alongside both models' validation scores.
- **Why it earns its place:** it turns "which is better?" from a vibe into a written rule applied to recorded numbers — the difference between selecting a model and guessing. It also documents *why* buffr keeps the simple ranker, which is the honest answer.
- **Files to touch:** `src/cli/eval-cmd.ts` (metric + decision rule + verdict print); a small record of both models' val scores next to `eval/`.
- **Done when:** the harness outputs both val scores and a one-line verdict ("keep baseline" / "ship reranker") derived from the written tolerance rule.
- **Estimated effort:** 4–8hr.

## Interview defense

**Q: You've got logistic regression and gradient-boosted trees both fitted — how do you choose?**
Answer: compare on the validation set, never on train. GBT almost always wins on train because it can memorize, so a train comparison picks the overfitter — the train-vs-val gap is my overfitting alarm. On val I see generalization. Then I apply a simpler-if-comparable rule: if GBT only beats logistic by a hair, I keep logistic, because interpretability and serving simplicity outweigh a rounding-error AUC gain. I report the winner's number on test, once.

```
  fit on TRAIN ──► choose on VAL ──► report on TEST
  ties broken toward the simpler model
```

**Q: buffr selects no model — so what's its "model," and what would replace it?**
Answer: its model is the cosine-similarity ranker in `src/pg-vector-store.ts` — `1 - (embedding <=> vector)` — a parameter-free baseline with nothing to train. The thing that *could* replace it is a learned reranker, which is the "GBT" in the compare-on-val loop: it'd have to beat the cosine baseline on `eval/queries.json` by more than my tolerance to earn its complexity. **The part people forget: a parameter-free baseline that's almost as good usually beats the learned model that's marginally better — the burden of proof is on the complex thing, not the simple one.** Today nothing has met that burden, so the one-line SQL ranker stays.

```
  baseline: cosine (0 params) ──── must be BEATEN on eval ────► learned reranker
  burden of proof sits on the complex challenger
```

## See also

- `01-supervised-pipeline.md` — the TRAIN stage this file opens up.
- `02-feature-engineering.md` — logistic needs engineered interactions; trees find them; FEAT-2 feeds the reranker.
- `03-train-val-test.md` — selection happens on VAL, the test set stays sealed.
- `09-calibration.md` — logistic's probabilities are usually more trustworthy than a tree ensemble's.
- `../05-evals-and-observability/02-eval-methods.md` — the P@1/R@3 scoring the compare-on-val loop reuses.
