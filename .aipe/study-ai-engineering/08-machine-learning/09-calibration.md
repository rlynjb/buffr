# Calibration

### *industry: calibration (reliability of predicted probabilities) · type: whether a score that says 0.9 is actually right 90% of the time*

## Zoom out

You've spent this section getting a model to *rank* well — pose-landmarking in contrl ordered candidate keypoints, buffr's retrieval orders chunks by cosine. But ranking is only half the story. The moment a *downstream* system reads the raw score — compares it to a threshold, multiplies it into an expected value — you need the score to *mean* something. Calibration is the property that makes a 0.9 trustworthy. See where it sits in the pipeline:

**The supervised pipeline, with the stage calibration corrects**
```
┌────────┐  ┌──────────┐  ┌───────┐  ┌───────┐  ┌─────────────────────────────────────┐
│  Data  │─►│ Features │─►│ Split │─►│ Train │─►│ DEPLOY                               │
│        │  │          │  │       │  │       │  │  raw scores ─► ★ CALIBRATE ★ ─► use  │ ◄── this file
└────────┘  └──────────┘  └───────┘  └───────┘  └─────────────────────────────────────┘
                                                          │
                          the model RANKS fine here ──────┤
                          but a downstream THRESHOLD/EV ───┘ needs the score
                          to equal an actual frequency
```
Calibration is a post-training adjustment on the scores — it never touches how the model ranks, only what the numbers are worth.

## Structure pass

The whole concept turns on one axis: **predicted probability vs the actual observed frequency at that probability.** A calibrated model lies on the diagonal where those two agree; a miscalibrated one drifts off it.

**The one axis: predicted vs observed, with the seam where they diverge**
```
  observed
 frequency
   1.0 ┤                                    ● perfectly calibrated lies HERE
       │                              .·'        (predicted == observed)
   0.6 ┤- - - - - - - - - - - ○ ·'              ○ = a model that SAYS 0.9
       │                  .·'  ▲                     but is right only 0.6 ─► OVERCONFIDENT
       │              .·'      │
   0.0 ┤··········'            │
       └────┬─────────┬────────┬────────┬──► predicted probability
           0.2       0.6      0.9      1.0

   ┌──────────────────────────────── THE SEAM ───────────────────────────────┐
   │ RANKING quality and CALIBRATION are INDEPENDENT. A model can order every  │
   │ example perfectly (great AUC) and still sit far off the diagonal. Fixing  │
   │ calibration does NOT change the order — it only rescales the numbers.      │
   └───────────────────────────────────────────────────────────────────────────┘
```
The seam is the whole point: a model can rank perfectly and still lie about its confidence. Calibration repairs the lie without disturbing the order.

## How it works

### Move 1 — Mental model

The mental model: **bin the predictions by their stated confidence, then check what actually happened in each bin.** Take every example the model scored ~0.9, look at the true labels, and ask "were 90% of these actually positive?" If yes, that bin is calibrated. The reliability diagram is just that check, plotted bin by bin.

**The reliability diagram — one bin, one honesty check**
```
  bin "predicted ≈ 0.9"
  ┌─────────────────────────────────────────────────┐
  │ examples the model scored 0.9: ● ● ● ● ● ● ● ● ● ● │  (10 examples)
  │ how many were ACTUALLY positive? ● ● ● ● ● ● ○ ○ ○ ○ │  (6 of 10 = 0.6)
  └─────────────────────────────────────────────────┘
        stated 0.9   vs   observed 0.6   ─►  gap = 0.3   OVERCONFIDENT bin
```
Each bin contributes one point to the reliability diagram; the gaps across all bins are what you summarize next.

### Move 2 — Walk the mechanism

**Part 1 — Bin the predictions.** Sort every scored example into confidence buckets. This is the raw material for everything downstream.

**Binning: scores fall into confidence buckets**
```
   scores ─►  0.05  0.12 │ 0.31  0.44 │ 0.62  0.68 │ 0.91  0.97
              └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
               bin [0,.25)  bin [.25,.5)  bin [.5,.75)  bin [.75,1]
                  ▼            ▼             ▼            ▼
            each bin gets a (mean predicted, observed frequency) pair
```

**Part 2 — Compute observed frequency per bin and compare.** For each bin, the gap between mean predicted confidence and actual positive rate is the per-bin calibration error.

**Per-bin gap = |mean predicted − observed frequency|**
```
   bin            mean pred   observed   gap
   [0.75, 1.0]      0.90        0.60     0.30  ◄── overconfident
   [0.50, 0.75]     0.62        0.61     0.01      well calibrated
   [0.25, 0.50]     0.40        0.55     0.15  ◄── UNDERconfident
   [0.00, 0.25]     0.12        0.10     0.02
```

**Part 3 — Collapse the gaps into one number: ECE.** Expected Calibration Error is the bin-size-weighted average of those gaps — a single scalar for how far off the model's confidence is. Illustrative, not buffr code:

**Expected Calibration Error (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Weighted average of per-bin gaps.
ece = 0.0
for b in bins:
    weight = len(b.examples) / N                 # how much of the data sits in this bin
    gap    = abs(b.mean_predicted - b.observed_frequency)
    ece   += weight * gap
# ece near 0 = honest scores; large ece = the numbers don't mean what they say
```

**Part 4 — Fix it with a post-hoc map.** Fit a monotonic function that maps raw scores to calibrated ones, on a held-out set. Two standard choices:

**Two calibrators — Platt (sigmoid) vs isotonic (step function)**
```
   PLATT SCALING                          ISOTONIC REGRESSION
   fit a sigmoid: p = σ(a·s + b)          fit a monotonic STEP function
   ┌───────────────────────┐              ┌───────────────────────┐
   │        .·············  │              │           ┌──────────  │
   │     .·'                │              │      ┌────┘            │
   │  .·'                   │              │  ┌──┘                  │
   │·'                      │              │─┘                      │
   └───────────────────────┘              └───────────────────────┘
   2 params, needs less data,             non-parametric, fits any
   assumes sigmoid shape                  monotonic shape, needs MORE data
```
Both are monotonic, so neither changes the ranking — they only relabel the scores. Pick Platt when calibration data is scarce, isotonic when it's plentiful.

### Move 3 — The principle

The principle: **calibration matters exactly when a downstream system consumes the score as a number, not when you only need the argmax label.** If all you do is take the top-ranked item, miscalibration is harmless — the order is untouched. But the instant you threshold ("act if confidence > 0.8"), or compute expected value ("0.7 chance × $100"), or route by confidence, the *value* of the number is load-bearing, and an uncalibrated 0.9 makes the wrong decision. Ask first: does anything read the raw score? If yes, calibrate.

## Primary diagram

The full picture — rank quality is fine, but the score is a lie until a calibrator repairs it.

**Calibration end to end: diagnose with the reliability diagram, summarize with ECE, fix with a monotonic map**
```
   raw model scores
        │
        ▼
   ┌──────────────────┐   bin by confidence    ┌────────────────────────┐
   │ RELIABILITY      │ ─────────────────────► │ predicted vs observed   │
   │ DIAGRAM          │                        │ per bin → see the gaps   │
   └──────────────────┘                        └────────────────────────┘
        │                                                  │
        ▼ summarize                                        ▼ if gaps large
   ┌──────────────────┐                        ┌────────────────────────┐
   │ ECE = weighted   │                        │ PLATT or ISOTONIC fit    │
   │ mean |pred−obs|  │                        │ (monotonic → rank kept)  │
   └──────────────────┘                        └────────────────────────┘
        │                                                  │
        └──────────────► calibrated scores ◄───────────────┘
                              │
   ┌──────────────────────────────────────────────────────────────────────┐
   │ buffr's retrieval `score = 1 - (embedding <=> query)` is an UNCALIBRATED│
   │ cosine similarity used at an implicit threshold (order by + limit). It  │
   │ is NOT a probability — a 0.82 does not mean "82% relevant".              │
   └──────────────────────────────────────────────────────────────────────┘
```
Calibration is the one adjustment that changes what scores mean without changing which one wins.

## Elaborate

The sharp edges:

- **Calibration ≠ accuracy ≠ ranking.** Three independent properties. A model can be accurate but miscalibrated, or well-calibrated but inaccurate. AUC measures ranking; ECE measures calibration; they do not predict each other.
- **Modern neural nets are systematically overconfident.** Deep networks trained with cross-entropy tend to push scores toward 0 and 1, so the reliability curve bows *below* the diagonal. This is why temperature scaling (a one-parameter Platt variant) is a standard last step in deployed classifiers.
- **Calibrate on held-out data, never on train.** Fitting the calibrator on the training scores leaks and gives you a flattering, useless map. Use a dedicated calibration split — same discipline as `03-train-val-test.md`.
- **Bin count is a knob with a bias/variance tradeoff.** Too few bins hides the miscalibration; too many leaves each bin too sparse to estimate a frequency. ECE is sensitive to this — report the bin count alongside it.
- **buffr's honest line.** buffr's retrieval returns `1 - (embedding <=> query)` — a cosine similarity in `src/pg-vector-store.ts`. It is a *score*, used at an implicit threshold via `order by` + `limit`, but it is **not a probability** and nothing calibrates it. There is no trained classifier in the repo, so there is no reliability diagram and no ECE today. The honest gap: the day buffr adds a downstream decision that reads that score as a confidence ("auto-answer if relevance > 0.8"), it would be acting on an uncalibrated number — and calibration becomes a real, buildable need.

## Project exercises

### Measure whether buffr's cosine score behaves like a probability

- **Exercise ID:** [B2C.9] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Treat buffr's retrieval `score` as if it were a relevance probability and *test that assumption empirically*. Over `eval/queries.json`, bin every retrieved chunk's cosine score, and in each bin compute the observed relevance frequency (using the labeled `relevant` sets). Plot a reliability diagram (ASCII is fine) and compute ECE. You will almost certainly find the score is not probability-like — that's the finding, and it's the point.
- **Why it earns its place:** It turns the abstract "the score isn't a probability" claim into a measured fact about buffr's own data, using labels the repo already has. It also teaches the diagnostic half of calibration without needing a trained model.
- **Files to touch:** new `ml/calibration_probe.py` (bin scores, compute observed frequency, ECE), reads `eval/queries.json` and retrieval output from `src/cli/eval-cmd.ts`, writes the reliability diagram to `ml/README.md`.
- **Done when:** a reliability diagram and an ECE number print over the eval set; a one-line note states plainly whether buffr's cosine score is usable as a relevance probability and at what threshold the gap is worst.

- **Estimated effort:** half a day.

### Calibrate a trained classifier's scores with Platt and isotonic

- **Exercise ID:** [B2C.9b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Take the query-intent classifier from the earlier confusion-matrix exercise ([B2C.5]/[B2C.8]), hold out a calibration split, and fit both Platt scaling and isotonic regression on its raw scores. Show the before/after reliability diagrams and ECE, and confirm the ranking (AUC) is unchanged by both maps.
- **Why it earns its place:** It builds the *fix* half of calibration and proves the principle hands-on — that a monotonic map repairs the numbers without touching the order. That demonstration is exactly the interview signal.
- **Files to touch:** new `ml/calibrate.py` (Platt + isotonic fit on held-out scores), reuses the [B2C.5] classifier and its scored test split, results to `ml/README.md`.
- **Done when:** ECE drops measurably after each calibrator, AUC is unchanged to several decimals (proving rank preservation), and a note compares Platt vs isotonic and says which you'd ship given the calibration-set size.
- **Estimated effort:** 1 day.

## Interview defense

Most candidates have only consumed pre-trained models and read their softmax outputs as probabilities without ever checking. Having measured ECE and fit a calibrator is the signal that you know a score isn't automatically a probability.

**Q: A model has great AUC but its 0.9s are right only 60% of the time. Is it broken?**
```
   AUC (ranking) ─► EXCELLENT, order is right
   ECE (calibration) ─► BAD, 0.9 means 0.6
        │
        └─ NOT broken for argmax/top-k use.
           BROKEN for any threshold or expected-value decision.
```
Anchor: ranking and calibration are independent — whether it's "broken" depends entirely on whether anything reads the raw number.

**Q: How do you fix overconfidence without retraining?**
```
   raw scores ─► fit a MONOTONIC map on HELD-OUT data ─► calibrated scores
                 Platt (sigmoid, few params) OR isotonic (step, more data)
                 monotonic ⇒ ranking UNCHANGED
```
Anchor: a post-hoc monotonic map relabels the scores and leaves the order intact — Platt when data is scarce, isotonic when it's plentiful.

**Q: Does buffr need calibration today?**
```
   buffr score = 1 - (embedding <=> query)   ◄── cosine similarity, NOT a probability
        │
        ├─ used only at order-by + limit (top-k) ─► calibration NOT needed
        └─ the day a threshold reads it as "% relevant" ─► calibration becomes real
```
Anchor: an uncalibrated score is fine for top-k retrieval; it only becomes a problem when a downstream threshold or EV decision treats it as a probability.

## See also

- `./08-confusion-matrices.md` — the matrix you read metrics off of once a threshold is chosen; calibration is what makes the threshold meaningful.
- `./10-recommender-systems.md` — where ranked scores get consumed downstream, the regime where calibration starts to matter.
- `../03-retrieval-and-rag/` — where buffr's cosine `score` is produced and used at a threshold.
- `../05-evals-and-observability/` — `eval/queries.json` as the labeled set a reliability diagram would be measured over.
- `../09-ml-system-design-templates/` — where "calibrate scores before a downstream decision consumes them" becomes a serving-design step.
