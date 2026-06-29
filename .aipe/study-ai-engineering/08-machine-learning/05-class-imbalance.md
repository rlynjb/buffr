# Class imbalance — skewed-class evaluation and the metrics that survive it

*Industry standard (skewed-class evaluation). buffr trains no classifier, so it has no class imbalance and no metric to mislead — Not yet implemented.*

## Zoom out, then zoom in

Imbalance isn't a model bug — it's an *evaluation* bug waiting to happen. The moment one class is rare (fraud, defects, failed runs), accuracy stops measuring what you think it measures, and a model that does nothing scores 99%. buffr has no classifier today, so there's no imbalance to fight — but the instant you put a "did this agent run fail?" classifier over `agents.messages`, you land in the textbook case: most runs succeed, the failures are rare, and accuracy will lie to you on day one.

```
  Zoom out — where a classifier WOULD attach, and where imbalance bites

  ┌─ Data layer (exists) ───────────────────────────────────────┐
  │  agents.messages — every run's trajectory (6 event types)   │
  │  warning/error events are RARE → most runs succeed          │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ label = "did this run fail?"
  ┌─ ML layer (★ no model here — WOULD attach) ─▼───────────────┐
  │  ★ run-outcome classifier ★   skewed: ~5% positive          │ ← we are here
  │  imbalance bites at EVAL: accuracy 95% by guessing "pass"    │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ honest metrics ↓
  ┌─ Metric layer ───────────────▼──────────────────────────────┐
  │  macro-F1 · per-class recall · confusion matrix (08)        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **class imbalance** is when the label distribution is lopsided — one class dominates, the other is rare. The trap is that the *cheap* metric (accuracy) rewards predicting the majority, so it hides total failure on the class you actually care about. This file teaches the metrics that don't lie (macro-F1, per-class precision/recall, the confusion matrix) and the fixes that rebalance the learning signal (class weights, resampling, SMOTE, focal loss, threshold move).

## Structure pass

**Layers:** the labeled data → the metric that scores it → the fix that rebalances it.

**Axis — "does this layer's choice reward predicting the rare class, or ignoring it?"**

```
  trace "does this reward catching the rare positive?" down the layers

  ┌─ metric: accuracy ──────┐   NO — rewards all-majority guessing
  │  (TP+TN)/total          │   99% by predicting "negative" always
  └─────────────────────────┘
  ┌─ metric: macro-F1 ──────┐   YES — averages per-class F1 equally
  │  mean(F1_pos, F1_neg)   │   rare-class failure tanks the score
  └─────────────────────────┘
  ┌─ fix: class weights ────┐   YES — penalizes missing a positive more
  │  loss × weight[class]   │   tells the model the rare class costs more
  └─────────────────────────┘

  same data; the metric/fix choice decides whether the rare class matters
```

**The seam:** the boundary between *accuracy* and *per-class metrics* is where the axis flips. On one side a model can be 99% "correct" and useless; on the other side the same model scores near-zero on the class you built it for. Cross that seam consciously — choosing the metric is the load-bearing decision, not choosing the model.

## How it works

### Move 1 — the mental model

You already know this shape from a `try/catch` you never test. If the error path almost never fires, a test suite that only runs the happy path is green forever and proves nothing about the catch block. An imbalanced dataset is the same: the rare class is the catch block, and accuracy is the happy-path-only test that stays green while the thing you care about is broken. The strategy is simple — stop scoring the system as one blob, and score each class on its own.

```
  the all-negative trap — the pattern to paraphrase later

  truth:      950 PASS   ·   50 FAIL   (5% positive)
  model:      "always PASS"
                │
                ▼
  accuracy = 950/1000 = 95%   ← looks great
  recall(FAIL) = 0/50 = 0%    ← catches ZERO failures
                                the metric and the truth disagree
```

### Move 2 — the step-by-step walkthrough

**Why accuracy lies — the all-negative classifier.** Picture a run-outcome classifier over `agents.messages` where 5% of runs fail. A model that emits "pass" for *every* run — a constant, learning nothing — scores 95% accuracy. It is, by the cheap metric, an A-student. It also catches none of the failures, which is the entire reason you'd build it. Accuracy is `(TP + TN) / total`; when `TN` dwarfs everything, the formula is dominated by the easy negatives and the rare-class result vanishes into rounding.

```
  the trap, with the arithmetic

  confusion matrix of the all-"pass" model:
                  pred PASS   pred FAIL
    actual PASS │    950     │    0     │  ← all majority, correct
    actual FAIL │     50     │    0     │  ← all minority, MISSED
                  ─────────────────────
  accuracy = (950+0)/1000 = 0.95   ← lies
  recall(FAIL) = 0/(50+0) = 0.00   ← the truth
```

**The honest views — per-class precision, recall, macro-F1.** Break the score apart per class. **Precision** of "FAIL" asks: of the runs I *called* failures, how many were? **Recall** of "FAIL" asks: of the runs that *actually* failed, how many did I catch? F1 is their harmonic mean. Then **macro-F1** averages the per-class F1s *with equal weight* — so the rare class counts as much as the common one, and a model that ignores it can't hide.

```
  macro-F1 — equal weight per class (rare class can't hide)

  per-class:   F1(PASS) = 0.97        F1(FAIL) = 0.00
                    │                       │
                    └───────── average ─────┘   (NOT weighted by size)
                              │
                              ▼
  macro-F1 = (0.97 + 0.00) / 2 = 0.485   ← the all-"pass" model's true grade
  (contrast: micro/accuracy-weighted would report ~0.95 and lie)
```

In pseudocode, the choice is one line at the end:

```
  // INPUT: y_true[], y_pred[], classes = {PASS, FAIL}
  for each class c in classes:
    TP = count(y_true == c AND y_pred == c)
    FP = count(y_true != c AND y_pred == c)   // predicted c, wasn't
    FN = count(y_true == c AND y_pred != c)   // was c, missed it
    precision[c] = TP / (TP + FP)             // col-wise: of predicted-c
    recall[c]    = TP / (TP + FN)             // row-wise: of actual-c
    f1[c]        = 2 * precision[c] * recall[c] / (precision[c] + recall[c])
  // THE load-bearing line — equal weight, not size-weighted:
  macro_f1 = mean(f1[c] for c in classes)     // rare class counts fully
  // OUTPUT: macro_f1  (and ALWAYS print per-class recall next to it)
```

**The fixes — rebalance the learning signal.** Honest metrics tell you you're failing; these make the model stop. There are four families, and they attack the imbalance at different points in the pipeline.

```
  four fixes, by WHERE they intervene

  ┌─ at the DATA ───────────────────────────────────────────────┐
  │  oversample minority   — duplicate FAIL rows until balanced  │
  │  undersample majority  — drop PASS rows (cheap, loses data)  │
  │  SMOTE                 — SYNTHESIZE new FAIL rows            │
  └──────────────────────────────────────────────────────────────┘
  ┌─ at the LOSS ───────────────────────────────────────────────┐
  │  class weights — multiply a missed FAIL's loss by ~19×       │
  │  focal loss    — down-weight EASY examples the model nails   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ at the THRESHOLD (post-training, no retrain) ──────────────┐
  │  threshold move — lower the 0.5 cutoff to catch more FAILs   │
  └──────────────────────────────────────────────────────────────┘
```

*Class weights* tell the loss function that missing a rare positive costs more — set the weight inversely proportional to class frequency (`weight[FAIL] = total / (n_classes × count[FAIL])`), and a single missed failure hurts as much as ~19 missed passes. *Oversampling* duplicates minority rows so the model sees them more often; *undersampling* throws away majority rows (cheap, but you discard real signal). *SMOTE* (Synthetic Minority Over-sampling Technique) is the clever one: instead of duplicating a rare row, it manufactures a *new* one by interpolating between a minority example and one of its nearest minority neighbors.

```
  SMOTE — synthesize, don't duplicate

  feature space (two FAIL examples, A and B, are k-nearest neighbors):

      A ●───────────────● B
          ↑
       new synthetic point = A + rand(0,1) × (B − A)
       (a fresh FAIL row ON the line between two real ones)

  duplication gives the model the SAME point 19×;
  SMOTE gives it 19 plausible, slightly-different points → less overfit
```

*Focal loss* attacks a different angle: it down-weights examples the model already classifies easily (the obvious passes) so gradient updates concentrate on the hard, rare cases — `loss = (1 − p_correct)^γ × cross_entropy`, where a confident-correct prediction (`p_correct ≈ 1`) gets multiplied by nearly zero and stops drowning out the minority.

**The threshold move — the fix that needs no retraining.** Every probabilistic classifier defaults to a 0.5 decision cutoff: predict FAIL if `P(FAIL) > 0.5`. But on imbalanced data the model is shy about the rare class, so its FAIL probabilities cluster *below* 0.5 even when it's onto something. Lower the threshold to, say, 0.2 and you trade precision for recall — catch more failures, at the cost of more false alarms. It's a dial you turn *after* training, often alongside reweighting.

```
  threshold move — slide the cutoff, no retrain

  P(FAIL) line for actual-FAIL runs (model is under-confident):

   0.0 ──────●──●─●────────●───────●──────── 1.0
                 ▲                 ▲
            default 0.5         (only this one caught at 0.5)
                 │
      move cutoff to 0.2 ──┐
   0.0 ──●──●─●────────●───┴───────●──────── 1.0
         └─ now 4 of 5 FAILs caught; recall ↑, precision ↓
```

### Move 3 — the principle

Imbalance is decided at the metric, not the model. The single most expensive mistake in skewed-class work is reporting accuracy and calling it done — because the rarer and more important the positive class, the more accuracy flatters a model that ignores it. Pick a metric that weights the rare class fully (macro-F1, per-class recall), *then* reach for the fixes. buffr's eventual run-failure detector is the canonical case: failures are rare, catching them is the whole point, and the day you score it on accuracy is the day it's silently broken.

## Primary diagram

```
  Class imbalance — the trap, the honest metrics, the fixes (full recap)

  ┌─ DATA (skewed) ─────────────────────────────────────────────┐
  │  agents.messages → label "fail?"   950 PASS · 50 FAIL (5%)  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │
  ┌─ THE TRAP ───────────────────▼──────────────────────────────┐
  │  accuracy = 0.95   ←─ "always PASS" model, recall(FAIL)=0   │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ replace the metric ↓
  ┌─ HONEST METRICS ─────────────▼──────────────────────────────┐
  │  per-class precision (col-wise) · recall (row-wise)         │
  │  macro-F1 = mean(F1 per class, EQUAL weight)  → 0.485       │
  │  confusion matrix (see 08) = the per-cell truth             │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ then rebalance ↓
  ┌─ FIXES ──────────────────────▼──────────────────────────────┐
  │  data:  oversample · undersample · SMOTE (interpolate)      │
  │  loss:  class weights · focal loss (down-weight easy)       │
  │  post:  threshold move (slide cutoff, no retrain)           │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Skewed-class evaluation came out of fraud detection, medical diagnosis, and information retrieval — fields where the positive class is rare *and* the cost of missing it dwarfs the cost of a false alarm. That cost asymmetry is why "just balance the data" isn't always right: undersampling throws away real majority signal, and oversampling can teach the model to memorize the few minority rows. SMOTE (Chawla et al., 2002) was the response — synthesize plausible minority examples instead of duplicating them. Focal loss (Lin et al., 2017, "Focal Loss for Dense Object Detection") came from object detection, where background pixels vastly outnumber objects; it generalized into the standard tool for "the easy examples are drowning the hard ones." The threshold move connects directly to calibration (`09-calibration.md`): you can only move a threshold sensibly if the predicted probabilities mean something, and on imbalanced data they often don't until you calibrate them. The adjacent concept is the confusion matrix (`08-confusion-matrices.md`) — every metric in this file is derived from its cells, which is why the two files are a pair. This rhymes faintly with your contrl pose pipeline: a rep-counter that fired on every frame would have great "accuracy" against mostly-not-a-rep frames and catch no reps — same trap, different domain.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Measure buffr's true base rate and pick the metric that survives it

- **Exercise ID:** IMB-1 (Case B — no classifier exists yet). **The metric-discipline exercise.**
- **What to build:** a one-off script that queries `agents.messages`, computes the base rate of `warning` and `error` event rows versus total runs (the natural "failed run" label), and reports what the imbalance is. Then write down — with the arithmetic — why accuracy would be the wrong metric for a failure detector at that base rate, and which metric (macro-F1 + per-class recall) you'd report instead.
- **Why it earns its place:** it forces the load-bearing decision *before* any model exists. You discover the imbalance is real (failures are rare in `agents.messages`) and prove, on buffr's own numbers, that accuracy would lie. The "I checked the base rate before I picked the metric" story.
- **Files to touch:** new `scripts/base-rate.ts` (or a query you run against `agents.messages`); read the event-type semantics from `src/supabase-trace-sink.ts` (the `warning`/`error` cases of `emit()`).
- **Done when:** the script prints the positive-class fraction and a one-line justification of macro-F1 over accuracy at that fraction.
- **Estimated effort:** 2–4 hr.

### Prototype threshold-moving on a rare-event detector over trace metrics

- **Exercise ID:** IMB-2 (Case B — no classifier exists yet).
- **What to build:** a toy rare-event detector over trace-derived features (e.g. `tokens_used`, tool-call count, presence of an `error` event per conversation) that outputs a probability, plus a threshold sweep that plots precision and recall as you slide the cutoff from 0.5 down. Pick the threshold that hits a target recall on the rare class.
- **Why it earns its place:** threshold-moving is the fix you can demo with no retraining and no labeled training set — exactly what buffr can afford. It makes the precision/recall trade tangible on buffr's own trajectory data.
- **Files to touch:** new `scripts/threshold-sweep.ts` reading features from `agents.messages` (columns `tokens_used`, `tool_calls`, `tool_results`); reuse the DB pool pattern from `src/cli/eval-cmd.ts`.
- **Done when:** the sweep prints a precision/recall pair per candidate threshold and you can name the cutoff that meets a stated recall target.
- **Estimated effort:** 1 day.

## Interview defense

**Q: Your run-failure classifier reports 96% accuracy. Are you happy?**
Answer: not until I see per-class recall. If failures are ~4% of runs, a model that predicts "pass" for everything scores 96% accuracy and catches zero failures — accuracy is dominated by the easy negatives. I'd report macro-F1 and the recall on the FAIL class specifically; that's the number that tells me whether the thing I built for actually works.

```
  accuracy 96%  ──►  recall(FAIL)?  ──►  if 0% → useless despite 96%
```

**Q: You're imbalanced. Walk me through your options.**
Answer: three points of intervention. At the data: oversample the minority, undersample the majority, or SMOTE (synthesize new minority rows by interpolating between neighbors instead of duplicating). At the loss: class weights (a missed rare positive costs proportionally more) or focal loss (down-weight the easy examples). And the one people forget — **the threshold move: you don't have to retrain at all; slide the 0.5 decision cutoff down to trade precision for recall.** That's the cheapest fix and often the first I reach for.

```
  data (SMOTE) · loss (weights/focal) · threshold (slide 0.5 → 0.2)
                                          └─ no retrain — the forgotten one
```

## See also

- `08-confusion-matrices.md` — every metric here is derived from its cells; read it as the companion.
- `09-calibration.md` — you can only move a threshold sensibly when the probabilities mean something.
- `04-model-selection.md` — pick the metric (this file) before you compare models.
- `14-training-run-logging.md` — log the confusion matrix per run so imbalance is visible over time.
- `../05-evals-and-observability/02-eval-methods.md` — buffr's existing P@1/R@3 scorers, the nearest real metric code.
