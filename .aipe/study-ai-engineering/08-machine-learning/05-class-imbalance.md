# Class Imbalance

### *industry: class imbalance · type: the failure mode where accuracy lies because one class dominates*

## Zoom out

You trained a model. It reports 99% accuracy. You ship it, and it never once catches the thing you built it to catch. That's not a bug in your code — it's the oldest trap in classical ML, and it's invisible to the one metric every beginner reaches for first. Before defining anything, look at where this bites in the pipeline you're learning:

**The supervised pipeline, with the stage class imbalance corrupts marked**
```
┌────────┐   ┌──────────┐   ┌────────┐   ┌────────┐   ┌──────────────────────────┐
│  Data  │──►│ Features │──►│ Split  │──►│ Train  │──►│ ★ EVALUATE / DEPLOY ★    │ ◄── this file
│ 99% A  │   │  numeric │   │ strat. │   │  fit   │   │ accuracy=0.99 — A LIE    │
│  1% B  │   │          │   │        │   │        │   │ recall(B)=0.00 — TRUTH   │
└────────┘   └──────────┘   └────────┘   └────────┘   └──────────────────────────┘
     │                                                            ▲
     └── imbalance is born HERE (in the data)──────but only SHOWS HERE (in eval)
```
Imbalance is a property of the **data**, but it does its damage at the **evaluation** seam, where one number quietly papers over a model that learned to do nothing.

## Structure pass

There is one axis that matters here: **prevalence** — what fraction of your labels belong to the rare class. Everything in this file is a response to prevalence dropping toward zero.

**The one axis: minority-class prevalence, and what each band demands**
```
 prevalence of positive class (the thing you care about)
  50% ──────────── 10% ──────────── 1% ──────────── 0.1%
  │                │                │                │
  balanced         mild             severe           extreme
  accuracy OK      watch macro-F1   accuracy USELESS  may need anomaly
                                    │                 detection, not
                                    │                 classification
                                    ▼
                          ┌──────────────────────┐
                          │  THE SEAM:            │
                          │  metric you trust  ◄──┼── changes with prevalence
                          │  must change here     │
                          └──────────────────────┘
```
The seam is this: the metric you are allowed to trust is a function of prevalence — and accuracy crosses from useful to actively misleading somewhere around the 10% mark. Below it, you switch toolkits.

## How it works

### Move 1 — Mental model

The mental model: **a metric that can be maximized by ignoring the input is not measuring your model.** Accuracy on a 99/1 split is exactly that — predict "majority" for every row, touch none of the features, and you score 0.99. You think of contrl pose-landmarking as "data in, fit, predict out"; imbalance is the case where the "predict out" can be a constant and still win the scoreboard.

**The degenerate baseline: a model that reads nothing and still scores 99%**
```
        input row ─────► [ ALWAYS PREDICT "A" ] ─────► "A"
                              ▲
                              │ ignores every feature
                              │
   99% of rows ARE "A"  ──────┘   so it is right 99% of the time
                                   accuracy = 0.99   recall(B) = 0.00
                                   ┌──────────────────────────────┐
                                   │ "high accuracy" can mean      │
                                   │ "learned absolutely nothing"  │
                                   └──────────────────────────────┘
```
If a constant function beats your model on your headline metric, your headline metric is the problem, not the model.

### Move 2 — Walk the mechanism

**Part 1 — The prevalence collapses the accuracy signal.** Accuracy weights every row equally, so the majority class buys nearly all the score outright.

**Accuracy is a weighted average dominated by the majority**
```
 accuracy = (correct on A) * P(A)  +  (correct on B) * P(B)
          = (correct on A) * 0.99  +  (correct on B) * 0.01
                                │                          │
                          99% of the budget          1% of the budget
                                ▼
            you can score 0.99 with ZERO skill on B
```

**Part 2 — Switch to per-class recall, which the majority cannot hide.** Per-class recall asks: of the actual B's, how many did you catch? The majority class can't inflate it.

**Per-class recall isolates each class so neither hides behind the other**
```
                    PREDICTED
                    A        B
        ┌───────┬────────┬────────┐
 ACTUAL │   A   │  9800  │   100  │  recall(A) = 9800/9900 = 0.99
        ├───────┼────────┼────────┤
        │   B   │    90  │    10  │  recall(B) =   10/100  = 0.10  ◄── the truth
        └───────┴────────┴────────┘
                                       accuracy = 9810/10000 = 0.98 (still a lie)
```

**Part 3 — Collapse the per-class numbers with macro-F1.** Macro-F1 averages the F1 of each class *unweighted*, so the rare class counts as much as the common one.

**Macro-F1 gives the rare class an equal vote**
```
   F1(A) = 0.99 ─┐
                 ├─► MACRO-F1 = (0.99 + 0.18) / 2 = 0.59  ◄── unweighted mean
   F1(B) = 0.18 ─┘                                            (rare class fully counted)

   vs MICRO/weighted-F1 = 0.98  ◄── rare class drowned again — DON'T report this alone
```

**Part 4 — Apply a fix, in rough order of cheapness.** None of these are buffr code — this is illustrative pseudocode showing the standard toolkit:

**The four standard fixes, cheapest first**
```python
# ILLUSTRATIVE ONLY — not buffr code. Standard imbalance toolkit.

# (1) THRESHOLD TUNING — free, do this first. Move the decision boundary.
pred = (model.predict_proba(X)[:, 1] > 0.18)   # not the default 0.50

# (2) CLASS WEIGHTS — tell the loss the rare class costs more.
model = LogisticRegression(class_weight="balanced")   # weight ∝ 1/prevalence

# (3) RESAMPLING — rebalance the TRAINING set only (never val/test).
X_res, y_res = SMOTE().fit_resample(X_train, y_train)  # synth minority rows

# (4) FOCAL LOSS — down-weight easy majority examples during training.
loss = -alpha * (1 - p_t)**gamma * log(p_t)            # gamma focuses on hard cases
```

**Where each fix acts in the pipeline**
```
   class weights ─────────────┐
   focal loss ────────────────┼──► TRAIN stage (changes the loss)
                              │
   SMOTE / resampling ────────┼──► DATA stage, TRAIN SPLIT ONLY ★ leakage risk if you
                              │                                  resample before split
   threshold tuning ──────────┴──► EVAL stage (changes the decision, not the model)
```

### Move 2.5 — current vs future

**What buffr has today vs what a trained classifier would add**
```
   TODAY (real)                          FUTURE (Case B — the exercise)
   ┌──────────────────────────┐          ┌──────────────────────────────┐
   │ eval/queries.json        │          │ ml/ classifier over a labeled │
   │  P@1, R@3 computed   ◄────┼──same────┼──► set, where positives are   │
   │  (precision / recall      │  metric  │   RARE — and you must NOT     │
   │   family — already real)  │  family  │   report accuracy alone       │
   │ NO trained model          │          │ trained model + macro-F1 +    │
   │ NO imbalance handling     │          │ confusion matrix + threshold  │
   └──────────────────────────┘          └──────────────────────────────┘
```
The vocabulary is already in the repo; the trained model that would force you to *handle* imbalance is not.

### Move 3 — The principle

The principle: **choose the metric before you choose the model, and choose it for the rare class you actually care about.** Imbalance doesn't make the problem harder to model — it makes the problem easy to *fake*. Accuracy is the faker's favorite tool. The fix is never a single trick; it's refusing to let one number stand alone.

## Primary diagram

**The whole picture: same model, three metrics, only one of them honest**
```
                         ┌─────────────────────────────────┐
                         │      99% A / 1% B  test set       │
                         └─────────────────────────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  ▼                    ▼                    ▼
         ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐
         │   ACCURACY     │   │  RECALL(B)     │   │   MACRO-F1       │
         │     0.98       │   │     0.10       │   │     0.59         │
         │  "looks great" │   │ "catches none" │   │ "rare class voted"│
         │   ✗ LIES       │   │   ✓ honest     │   │   ✓ honest       │
         └────────────────┘   └────────────────┘   └──────────────────┘
                  │                    │                    │
                  └──────────► report the right TWO ◄───────┘
                              (per-class recall + macro-F1),
                              never accuracy alone, plus PR-AUC
                              when you also need a threshold-free view
```
One model, three numbers — the one a beginner quotes is the one that's lying.

## Elaborate

A few sharp edges worth holding:

- **PR-AUC over ROC-AUC under imbalance.** ROC-AUC can look strong even when the positive class is hopeless, because its x-axis (false-positive rate) has a huge denominator of negatives. Precision-Recall AUC keeps the rare positives in the denominator where you can see them. Under heavy imbalance, report PR-AUC.
- **SMOTE only on the training split, and only after the split.** Synthesize minority rows *before* you split and synthetic neighbors of a test point leak into train — your eval inflates and you won't know why. This is the imbalance-flavored version of the leakage lesson from `03-train-val-test.md`.
- **Threshold tuning is free and underused.** Class weights and resampling change the model; moving the decision threshold from 0.50 changes only how you read its probabilities. Always try the free lever first, and tune the threshold on validation, not test.
- **Resampling distorts calibration.** After SMOTE or class weights, the model's output probabilities no longer match real-world frequencies — see `09-calibration.md`. If you need trustworthy probabilities (not just labels), you may have to recalibrate after rebalancing.
- **buffr's honest connection.** P@1 and R@3 over `eval/queries.json` are precision and recall — the exact family this file lives in. buffr already computes them; it just computes them over a retrieval rank, not over a trained classifier's predictions. Same arithmetic, no model behind it yet.

## Project exercises

### Build a query-intent classifier where the positive class is rare

- **Exercise ID:** [B2C.5] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Build the first real classifier in a new `ml/` dir: a binary query-intent model (e.g. "is this query answerable from the corpus" vs "out-of-scope") trained on a labeled set you grow from `eval/queries.json`. Engineer the labels so the positive class is genuinely rare (~5–10%), then handle the imbalance: report macro-F1 and per-class recall, never accuracy alone; apply class weights; tune the decision threshold on a validation split.
- **Why it earns its place:** It forces the one instinct interviews probe and beginners lack — distrusting accuracy. You'll feel the 99% lie firsthand, then fix it with the standard toolkit. It also connects directly to a metric vocabulary already in the repo.
- **Files to touch:** new `ml/intent_classifier.py` (or `.ts`), new `ml/labels.json` derived from `eval/queries.json`, new `ml/metrics.py` (macro-F1, per-class recall, PR-AUC), a short `ml/README.md` recording the headline numbers.
- **Done when:** the harness prints accuracy AND macro-F1 AND per-class recall side by side; a one-paragraph note explains why accuracy alone would mislead here; the chosen threshold is justified from a validation PR curve, not left at 0.50.
- **Estimated effort:** 1–2 days (most of it building the labeled set, which is the realistic ratio).

### Compare three imbalance fixes on the same model

- **Exercise ID:** [B2C.5b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Take the [B2C.5] classifier and run an honest bake-off: baseline (no fix), class weights, SMOTE-on-train-only, and threshold tuning. Hold the model architecture and split fixed; vary only the imbalance treatment. Record macro-F1, per-class recall, and PR-AUC for each.
- **Why it earns its place:** Teaches that there is no single "balance the classes" button — each fix has a cost (SMOTE distorts calibration, weights shift the threshold) and you must measure, not assume. This is the measurement-driven-decision discipline `agent-layer-plan.md` calls the portfolio separator.
- **Files to touch:** new `ml/imbalance_bakeoff.py`, reuse `ml/metrics.py`, append a results table to `ml/README.md`.
- **Done when:** a four-row results table exists with the same train/test split across all rows; one sentence names which fix you'd ship and why; the SMOTE row demonstrably resampled the training split *only*.
- **Estimated effort:** 1 day on top of [B2C.5].

## Interview defense

Most candidates have only consumed pre-trained models — they've never owned the metric. Having trained a classifier under imbalance and *chosen* the metric is the signal.

**Q: Your model reports 95% accuracy. Why might I not be impressed?**
```
   "What's the class balance?" ◄── the first question, always
        │
        ├─ if 95% of rows are one class:
        │     a constant predictor scores 95% — accuracy proves nothing
        │
        └─ "Show me per-class recall and macro-F1. Accuracy on an
            imbalanced set rewards ignoring the minority class."
```
Anchor: accuracy is a weighted average the majority class can buy outright.

**Q: When do you reach for PR-AUC instead of ROC-AUC?**
```
   imbalance heavy?
     │
     ├─ YES ─► PR-AUC: keeps rare positives in the denominator,
     │          so it can't be flattered by a sea of true negatives
     │
     └─ NO  ─► ROC-AUC is fine; FPR denominator isn't dominated
```
Anchor: ROC's false-positive rate hides under a huge negative denominator; PR-AUC doesn't.

**Q: You used SMOTE and your eval scores jumped. Should I trust it?**
```
   did you resample BEFORE or AFTER the split?
     │
     ├─ before ─► LEAKAGE. Synthetic neighbors of test points
     │             contaminated train. The jump is fake.
     │
     └─ after, train-only ─► legitimate; report it
```
Anchor: rebalance the training split only — resampling before the split leaks.

## See also

- `./06-domain-gap.md` — the *other* way eval lies: not class ratios, but a train-vs-inference distribution shift.
- `./08-confusion-matrices.md` — the matrix every per-class recall and macro-F1 number in this file is read off of.
- `../03-retrieval-and-rag/` — `eval/queries.json` as a labeled set; the P@1/R@3 vocabulary reused here.
- `../05-evals-and-observability/` — where buffr's precision/recall numbers are actually computed today.
- `../09-ml-system-design-templates/` — where "which metric do we trust" becomes a system-level decision.
