# Domain Gap

### *industry: domain gap (covariate shift) · type: the failure mode where train and inference distributions disagree*

## Zoom out

"Great in the notebook, terrible in prod." Every engineer who ships a model meets this sentence eventually, and it almost never means the model is broken. It means the data the model *meets* at inference doesn't look like the data it *learned from*. Before any definition, see where the gap opens in the pipeline you're studying:

**The supervised pipeline, with the seam where the domain gap opens marked**
```
   TRAIN-TIME world                                  INFERENCE-TIME world
┌────────┐  ┌──────────┐  ┌───────┐  ┌───────┐   ║  ┌────────────────────────────┐
│ Data   │─►│ Features │─►│ Split │─►│ Train │   ║  │ ★ DEPLOY / PREDICT ★       │ ◄── this file
│ (P_tr) │  │          │  │       │  │  fit  │   ║  │ new data (P_inf) ≠ P_tr    │
└────────┘  └──────────┘  └───────┘  └───────┘   ║  └────────────────────────────┘
                                                  ║
                                  the GAP lives ──╨── here: a distribution wall
                                  between the world you fit and the world you serve
```
The model is fine. The two worlds on either side of that wall are different, and nobody measured the difference.

## Structure pass

One axis organizes this entire topic: **what part of the joint distribution shifted.** P(x, y) = P(y | x) · P(x), and the gap lands in one of those two factors.

**The one axis: which factor of P(x,y) drifted**
```
   P(x, y)  =  P(y | x)  ·  P(x)
                  │            │
                  │            └──► COVARIATE SHIFT — inputs look different,
                  │                  the rule still holds. (most common; the
                  │                  "web text → personal markdown" case)
                  │
                  └──► CONCEPT DRIFT — same inputs, the LABEL RULE changed.
                       (the harder, sneakier case)

   ┌───────────────────────────── THE SEAM ─────────────────────────────┐
   │ detection differs: covariate shift you can see in P(x) alone (no    │
   │ labels needed). Concept drift needs fresh LABELS to detect at all.  │
   └─────────────────────────────────────────────────────────────────────┘
```
The seam: covariate shift is detectable with unlabeled production data; concept drift is not — you need new ground truth, which is exactly what production rarely hands you for free.

## How it works

### Move 1 — Mental model

The mental model: **a model interpolates confidently inside the region it saw and hallucinates outside it.** Training data carves out a region of input space; inside that region the model is interpolating and trustworthy, outside it the model is extrapolating and arbitrary. The domain gap is how much of your *inference* traffic lands outside the trained region. Hold contrl pose-landmarking in mind: a pose model trained on studio-lit adults degrades on dim phone video of kids — same task, unseen region.

**Inside the trained region vs outside it**
```
        feature space (2-D shadow of many dims)
   ┌───────────────────────────────────────────────┐
   │        ┌───────────────────────┐               │
   │        │   TRAINED REGION      │   ● ● ●        │
   │        │   ● ● ● ● ●            │  inference     │
   │        │   ● model interpolates │  points OUT    │
   │        │   ● — trustworthy      │  here ─► model │
   │        │   ● ● ● ● ●            │  extrapolates  │
   │        └───────────────────────┘  — arbitrary   │
   └───────────────────────────────────────────────┘
            ●  = training points        ● (right) = prod traffic the gap
```
Accuracy on held-out test data only measures the inside of that box; the gap is everything your production traffic does outside it.

### Move 2 — Walk the mechanism

**Part 1 — The deployment exposes the model to a new input distribution.** Nothing announces this. The model returns confident outputs on data it has no business being confident about.

**The silent onset: confidence stays high, correctness quietly drops**
```
   week 1 (in-domain)        week 6 (drifted-in traffic)
   conf 0.91  acc 0.89       conf 0.90  acc 0.61   ◄── confidence DIDN'T fall
        │                          │                    (that's why it's silent)
        └──────────────────────────┴──► you only notice via downstream KPIs,
                                         not the model's own self-report
```

**Part 2 — Detect it by comparing P(x), not by waiting for labels.** You don't need ground truth to see that the *inputs* moved. Compare the feature distribution of a recent production sample against the training sample. This is illustrative pseudocode, not buffr code:

**Detection by distribution comparison (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Standard covariate-shift detection.

# (A) Population Stability Index per feature: train hist vs prod hist
psi = sum((p_prod - p_train) * log(p_prod / p_train) for each bin)
#   PSI < 0.1  stable | 0.1–0.25 watch | > 0.25 significant shift

# (B) Classifier two-sample test: can a model tell train from prod apart?
clf.fit(X=concat(X_train, X_prod), y=[0]*n_train + [1]*n_prod)
#   AUC ≈ 0.5  indistinguishable (no gap) | AUC → 1.0  the two are separable (gap)
```

**Part 3 — The gap shows up per-feature, so localize it.** Aggregate "the data drifted" is useless; you need *which* feature drifted to act.

**Per-feature drift table localizes the gap**
```
   feature        PSI     verdict
   ─────────────  ─────   ─────────────────────────
   doc_length     0.04    stable
   vocab_overlap  0.31    ★ SHIFTED — prod text uses
                          terms train never saw
   embedding_norm 0.08    stable
                          ▲
                 act on the ★ row, not on a global average
```

**Part 4 — Mitigate, in order of cost.** The honest first answer is almost always "get in-domain data," not a clever algorithm.

**Mitigation ladder, cheapest-honest-fix first**
```
   1. COLLECT in-domain data ──► retrain on what prod actually looks like
      (boring, correct, usually the real fix)            │
   2. RE-WEIGHT training rows ──► importance weighting:   │ lower
      upweight train rows that resemble prod              │ effort
   3. DOMAIN ADAPTATION ───────► learn features invariant │ but
      across source/target domains                        │ riskier
   4. FINE-TUNE / continued training on a small labeled   ▼
      in-domain set  (bridges to 07-transfer-learning.md)
```

### Move 2.5 — current vs future

**buffr's one real, honest domain-gap risk — named, not invented**
```
   nomic-embed-text was PRETRAINED on:        buffr feeds it:
   ┌──────────────────────────────┐           ┌──────────────────────────────┐
   │ broad open WEB TEXT           │           │ personal MARKDOWN notes       │
   │ (articles, forums, code, …)   │  ──gap?──►│ (terse, idiosyncratic, your   │
   │                               │           │  own vocabulary & shorthand)  │
   └──────────────────────────────┘           └──────────────────────────────┘
        SOURCE domain (where it learned)            TARGET domain (where it serves)

   ┌────────────────────────────────────────────────────────────────────────┐
   │ HONEST STATUS: buffr trains nothing. This is a real adjacent RISK in    │
   │ the embedding model buffr CONSUMES — not a trained model buffr owns.    │
   │ If retrieval P@1/R@3 is weak on your notes, this gap is a prime suspect.│
   └────────────────────────────────────────────────────────────────────────┘
```
This is the file's honest hook: the domain gap is real and adjacent, living inside the *pretrained* embedding model — buffr neither trained it nor can retrain it today.

### Move 3 — The principle

The principle: **a held-out test set only certifies the model against its own past; it says nothing about the future the model will actually see.** Your test set is drawn from P_train. Production is drawn from P_inf. The domain gap is the unmeasured distance between them, and the only defense is to measure that distance continuously, not to trust a one-time test number.

## Primary diagram

**The whole picture: two worlds, one wall, and the three ways across it**
```
   SOURCE world (training)              ║              TARGET world (inference)
   ┌──────────────────────┐            ║            ┌──────────────────────────┐
   │  P_train(x, y)        │            ║            │  P_inf(x, y)              │
   │  what the model LEARNED│           ║            │  what the model MEETS     │
   └──────────────────────┘            ║            └──────────────────────────┘
            │                          ║                        ▲
            │         ┌────────────────╨────────────────┐       │
            │         │   DETECT: compare P(x) only       │      │
            │         │   (PSI / two-sample classifier)   │      │
            │         └──────────────┬────────────────────┘      │
            │                        │                            │
            └────────────────────────┼────────────────────────────┘
                                     ▼
              MITIGATE: ① collect in-domain  ② re-weight  ③ adapt/fine-tune
              ──────────────────────────────────────────────────────────────
              concept drift (P(y|x) changed) hides here too — needs FRESH LABELS
```
You cross the wall by measuring P(x) without labels first, then reaching for the cheapest mitigation that closes the measured gap.

## Elaborate

The sharp edges:

- **Covariate shift is detectable label-free; concept drift is not.** You can spot inputs drifting with unlabeled prod data alone. But if the *rule* P(y|x) changed — same inputs, different correct answer — no amount of staring at inputs reveals it. You need new ground truth, which is the expensive part. Don't claim you've "ruled out drift" if you only checked P(x).
- **High confidence is not evidence against a gap.** A model extrapolating outside its trained region is often *more* confident, not less. Confidence is computed from the same warped function that's failing. Trust an external KPI or fresh labels, never the model's self-report.
- **PSI thresholds are conventions, not laws.** 0.1 / 0.25 are industry rules of thumb. Calibrate them to your own false-alarm tolerance; a noisy feature can trip 0.25 without anything real moving.
- **The cheapest fix is almost always boring.** "Collect in-domain data and retrain" beats clever domain-adaptation algorithms most of the time. Reach for adaptation when in-domain labels are genuinely unobtainable, not as a first move.
- **buffr's honest line.** The embedding-model domain gap (web text → personal markdown) is a real risk buffr *inherits* by consuming `nomic-embed-text`. buffr cannot retrain that model today, and it does not. The honest mitigation available now is corpus-side (better chunking, richer context), not model-side — see `06-production-serving` and `03-retrieval-and-rag`.

## Project exercises

### Measure the embedding domain gap on your own corpus

- **Exercise ID:** [B2C.6] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Build a detection harness in `ml/` that quantifies the embedding domain gap honestly: sample a slice of generic web text and a slice of your `eval/corpus` markdown, embed both with `nomic-embed-text`, and run a two-sample test (train-a-classifier-to-separate-them, report AUC) plus per-dimension PSI on the embeddings. You are *measuring a consumed model's gap*, not training one.
- **Why it earns its place:** It turns "is my corpus a domain gap for nomic?" from a vague worry into a number you can defend in an interview. It's the only domain-gap exercise buffr can do without a trained model, and it directly informs retrieval quality.
- **Files to touch:** new `ml/domain_gap.py`, reads from `eval/corpus/`, a small `ml/webtext_sample/` reference set, results appended to `ml/README.md`.
- **Done when:** the harness prints a separability AUC (≈0.5 = no gap, →1.0 = gap) and the top-5 most-shifted embedding dimensions by PSI; a one-paragraph note states whether the gap is severe enough to suspect in retrieval misses.
- **Estimated effort:** 1 day.

### Wire a drift sentinel over captured trajectories

- **Exercise ID:** [B2C.6b] Phase 2C / Phase 3
- **What to build:** Not yet implemented — buffr trains nothing. Build a recurring check that compares the *current* distribution of queries hitting buffr (from `agents.messages`) against a baseline window, using PSI over query embeddings. Emit a single drift score per run. This watches buffr's real input distribution shift over time — still no model trained, just the input world monitored.
- **Why it earns its place:** It's the production-hygiene half of this concept and the on-ramp to `15-drift-detection.md`. It uses a real buffr capture surface (`agents.messages`) as the honest source of "what the system actually sees."
- **Files to touch:** new `ml/drift_sentinel.py`, reads `agents.messages` (query text), writes a per-run drift score to `ml/drift_log.json`.
- **Done when:** running the sentinel twice over two different time windows produces two comparable drift scores; a synthetic injected shift (feed it off-topic queries) reliably trips the threshold.
- **Estimated effort:** 1–1.5 days.

## Interview defense

Most candidates have only consumed pre-trained models and have never measured the gap between train and prod — having instrumented it is the signal.

**Q: Your model scored 0.90 in the notebook and 0.61 in prod. Where do you look first?**
```
   first hypothesis: DOMAIN GAP, not a code bug
        │
        ├─ compare P(x): train sample vs recent prod sample (PSI / 2-sample AUC)
        │     gap found ─► localize the shifted features, then retrain/re-weight
        │
        └─ if P(x) looks stable ─► suspect concept drift; pull fresh labels
```
Anchor: the model is usually fine — the two distributions on either side of deploy are not.

**Q: How do you detect a domain gap without production labels?**
```
   labels NOT required for covariate shift:
     train a classifier to tell train-rows from prod-rows
        AUC ≈ 0.5 ─► indistinguishable, no covariate shift
        AUC → 1.0 ─► the two distributions are separable = gap
   labels REQUIRED for concept drift ─► say so plainly
```
Anchor: covariate shift lives in P(x) and is label-free; concept drift lives in P(y|x) and is not.

**Q: Does buffr have a domain gap?**
```
   honest answer: buffr trains nothing, so it OWNS no model with a gap.
        │
        └─ BUT it CONSUMES nomic-embed (pretrained on web text) over
           personal markdown ─► a real adjacent gap in a model it can't
           retrain. Mitigation today is corpus-side, not model-side.
```
Anchor: name the consumed-model gap honestly; don't manufacture a trained model to own it.

## See also

- `./05-class-imbalance.md` — the other way held-out metrics lie: class ratios, not distribution shift.
- `./07-transfer-learning.md` — fine-tuning on a small in-domain set is the heavyweight domain-gap mitigation.
- `../03-retrieval-and-rag/` — `01-embeddings.md`: the consumed embedding model where buffr's real domain-gap risk lives.
- `../05-evals-and-observability/` — `eval/queries.json` and `agents.messages` as the surfaces you'd measure drift against.
- `../09-ml-system-design-templates/` — where continuous distribution monitoring becomes an architectural component.
