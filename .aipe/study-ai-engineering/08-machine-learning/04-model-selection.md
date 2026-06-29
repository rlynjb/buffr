# Model Selection

### *industry: model selection · type: choosing the baseline, then earning anything fancier*

## Zoom out

This is the Train stage's first real decision, and it's smaller than beginners think: there are two default baselines, you train both, and you pick the simpler one unless the complex one clearly earns its keep. buffr makes no such choice — it trains nothing, so it never selects a model in the ML sense. It only *picks which pre-trained model to call* (gemma2, nomic), which is a serving decision, not model selection.

**The pipeline, with TRAIN marked ★ — model selection is the first choice inside it**

```
┌────────┐   ┌──────────┐   ┌────────┐   ┌────────┐   ┌────────┐
│  DATA  │──►│ FEATURES │──►│ SPLIT  │──►│ TRAIN  │──►│ DEPLOY │
│        │   │          │   │        │   │ ★ which│   │        │
│        │   │          │   │        │   │ model? │   │        │
└────────┘   └──────────┘   └────────┘   └────────┘   └────────┘
                                         ◄── this file
                          two baselines, pick the simpler if scores tie
```

In contrl you eventually settled on a model — but you'd have started by trying the cheapest thing that could work and only adding capacity when it paid for itself. That discipline — baseline first, complexity only when justified — is the whole file. buffr's "model choice" is selecting `gemma2:9b` in a config; that's choosing a vendor, not selecting a trained model from candidates you fit.

## Structure pass

The axis is **interpretability vs flexibility**. Logistic regression is interpretable and rigid — a weighted sum, a straight boundary. Gradient-boosted trees are flexible and opaque — they carve nonlinear boundaries but you can't read them. The seam is the moment their scores are close enough that simplicity should win.

**One axis: the two default baselines**

```
   LOGISTIC REGRESSION                GRADIENT-BOOSTED TREES
   ───────────────────                ──────────────────────
   linear, weighted sum               nonlinear, many small trees
   interpretable (read the weights)   opaque (feature importances only)
   fast, few failure modes            slower, more knobs, can overfit
   ┌────────────────────┐             ┌────────────────────┐
   │ straight boundary  │   ──seam──► │ wiggly boundary    │
   └────────────────────┘             └────────────────────┘
        the seam: if scores tie, the simpler model wins
```

Left: the simple baseline you reach for first. Right: the flexible one that often scores higher but costs interpretability, latency, and failure surface. Consequence: buffr sits off this axis entirely — it selects no trained model — so the whole comparison is new ground, taught as the choice you'd make in a new `ml/` trainer.

## How it works

### Move 1 — Mental model

Model selection is a bake-off with a tiebreaker that favors simplicity. You enter two contestants — a linear model and a tree ensemble — score them fairly with cross-validation, and award the win to trees *only if* they beat linear by enough to justify the cost. A near-tie goes to logistic regression, because simple models are cheaper to serve, easier to debug, and harder to break.

**The bake-off and its tiebreaker**

```
  logistic regression ──┐
                        ├──► cross-validate both ──► compare scores
  gradient-boosted trees┘
                                    │
                        ┌───────────┴───────────┐
                   scores close?            trees clearly ahead?
                        │                        │
                   pick LOGISTIC             pick TREES
                   (simpler wins)            (earned the cost)
```

Frontend bridge: it's reaching for plain CSS before a heavyweight UI library. If flexbox does the job, you don't pull in a layout engine — fewer dependencies, fewer failure modes. You add the heavy tool only when the simple one provably can't do it.

### Move 2 — Walk the mechanism

Code below is **illustrative pseudocode** — buffr trains nothing, so none of this is in the repo.

**Part A — Baseline one: logistic regression**

A linear model: each feature gets a weight, you sum them, squash to a probability. The boundary is a straight line (hyperplane). Its gift is interpretability — the weights tell you which features drive the prediction.

```
  features ─► w1·x1 + w2·x2 + ... ─► sigmoid ─► P(class)
              ▲
              read the weights = read the model's reasoning
  boundary:  a straight line through feature space
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
lr = LogisticRegression()
lr.fit(X_train, y_train)
print(lr.coef_)            # ◄── the model's reasoning, in plain weights
```

**Part B — Baseline two: gradient-boosted trees**

Many shallow decision trees, each correcting the last one's errors. The combined boundary is nonlinear and can capture interactions logistic regression can't. The cost: you can't read it, it has more knobs, and it overfits if untended.

```
  tree1 (rough) ─► residual ─► tree2 (fix) ─► residual ─► tree3 ...
       sum of trees = a wiggly, nonlinear boundary
  you get feature_importances, NOT a readable rule
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
gbt = GradientBoostingClassifier()
gbt.fit(X_train, y_train)
gbt.feature_importances_   # ◄── importances, not interpretable weights
```

**Part C — Score both fairly with cross-validation**

A single val score is noisy on small data. k-fold cross-validation rotates which slice is val across k folds and averages, giving a stable score to compare the two models on equal footing.

```
  5-fold CV (test stays sealed elsewhere):
  fold1: [VAL][   TRAIN   ]   ─► score1
  fold2: [TR][VAL][ TRAIN ]   ─► score2
  fold3: [ TR ][VAL][ TR  ]   ─► score3
  fold4: [  TRAIN  ][VAL][T]   ─► score4
  fold5: [   TRAIN   ][VAL ]   ─► score5
                                 ───────
            mean ± std = a fair, stable comparison number
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
lr_score  = cross_val_score(lr,  X_train, y_train, cv=5).mean()
gbt_score = cross_val_score(gbt, X_train, y_train, cv=5).mean()
```

**Part D — The tiebreaker: simpler wins a near-tie**

Now decide. If the trees beat logistic by a margin that survives the CV noise (the std), they earned it. If it's within the noise, take logistic — fewer failure modes, lower latency, a model you can explain.

```
  lr_score  = 0.86 ± 0.02
  gbt_score = 0.87 ± 0.03   ◄── overlapping → effectively a tie
  decision: pick LOGISTIC (interpretable, faster, fewer ways to break)

  vs.

  gbt_score = 0.93 ± 0.02   ◄── clearly ahead, non-overlapping
  decision: pick TREES (the gap justifies the cost)
```

### Move 2.5 — Current vs future

**Case B: buffr selects no trained model.** Its only "model choice" is which pre-trained model to call — a config line, not a bake-off.

```
  TODAY (buffr)                      IF YOU BUILT TRAINING (new ml/)
  ─────────────                      ───────────────────────────────
  pick a vendor model:               train BOTH baselines on your data:
  gemma2:9b, nomic-embed-text        logistic vs gradient-boosted trees
  ┌────────────────────┐            ┌─────────────────────────────────┐
  │ serving decision,  │  ──gap──►   │ cross-validate, compare, pick   │
  │ not model selection│             │ simpler on a tie                │
  └────────────────────┘            └─────────────────────────────────┘
```

What you'd build: train logistic and GBT on the intent-classifier features from file 02, cross-validate both, and pick — most likely logistic, because the dataset is tiny and interpretable wins. buffr does none of this; selecting `gemma2:9b` is choosing a supplier, not selecting from candidates you trained.

### Move 3 — The principle

**Train both default baselines, then pick the simpler one unless the complex one clearly earns its cost in interpretability, latency, and failure surface.** Complexity is a debt you take on only against proven returns. buffr never makes this call — it consumes pre-trained models, which is a serving choice, not model selection. The signal is the discipline: a baseline first, cross-validated comparison, and a bias toward the model you can explain when the scores tie.

## Primary diagram

The two baselines, the fair comparison, and the simplicity tiebreaker.

**The model-selection bake-off**

```
  ┌──────────────────────┐        ┌──────────────────────┐
  │ LOGISTIC REGRESSION  │        │ GRADIENT-BOOSTED TREES│
  │ linear · readable    │        │ nonlinear · opaque    │
  │ fast · few knobs     │        │ slower · many knobs   │
  └──────────┬───────────┘        └──────────┬───────────┘
             └────────► 5-fold CV ◄──────────┘
                        compare mean ± std
                             │
              ┌──────────────┴──────────────┐
         scores overlap                 trees clearly ahead
              │                              │
         PICK LOGISTIC                   PICK TREES
         (simpler wins the tie)          (gap earns the cost)

  buffr: makes NO such choice — it calls gemma2:9b (a serving decision)
```

After the box: the default move is two baselines and a tiebreaker for simplicity. buffr is off the board entirely — it selects suppliers, not trained models.

## Elaborate

- **Why these two are the defaults.** Logistic regression and gradient-boosted trees bracket the useful range on tabular data: one linear and interpretable, one nonlinear and powerful. If logistic is competitive, your problem is roughly linear and you're done cheaply. If trees crush it, you've learned the problem has real interactions worth the complexity. Two models, and you've mapped the difficulty.
- **The simplicity bias is an operational argument, not an aesthetic one.** A logistic model has fewer hyperparameters to misconfigure, serves faster, and fails in legible ways (you can read the weight that went wrong). A tree ensemble has more knobs, more overfit risk, and opaque failures. On a near-tie, the simple model is cheaper to *own*, which is what actually matters in production.
- **Cross-validation, not a single val score, is what makes the comparison honest.** On small data a single split's score swings wildly; one model can "win" on luck. k-fold averages out that luck and gives you a std, so you can tell a real gap from noise. The test set stays sealed (file 03) — CV happens entirely within train+val.
- **buffr's analog choice is `02-embedding-model-choice` and provider abstraction.** Picking nomic-embed-text over an alternative, or gemma2 over another generator, is a real decision buffr makes — but it's evaluated by serving metrics (latency, P@1/R@3 on `eval/queries.json`), not by training and cross-validating candidates. Calling it "model selection" in the ML sense would be wrong; it's supplier selection. Knowing the difference is the point.

## Project exercises

### Train both baselines and pick with cross-validation

Not yet implemented — buffr trains nothing, so it has never run a model bake-off. This builds the two-baseline comparison on buffr's own intent-classifier task.

- **Exercise ID:** [B2C.7] (cite [B2C.7], Phase 2C) — Case B: no model selection happens in buffr; this is the primary buildable target.
- **What to build:** `ml/select_model.py` that trains logistic regression and gradient-boosted trees on the file-02 features, runs 5-fold cross-validation on each, prints mean ± std for both, and applies the simplicity tiebreaker to declare a winner.
- **Why it earns its place:** It is the Train-stage decision buffr never makes, executed on buffr data, and it forces the cross-validation + tiebreaker discipline rather than just calling `.fit()` once.
- **Files to touch:** new `ml/select_model.py`, uses `ml/features.py` and `ml/split.py`.
- **Done when:** The script prints both CV scores with std and a justified pick, and you can defend why the winner won (gap survives noise, or simplicity broke the tie).
- **Estimated effort:** 1 day.

### Write the model-selection record as a decision note

Not yet implemented — buffr trains nothing, so there's no selection to document. This produces the artifact that proves you reasoned, not just ran.

- **Exercise ID:** [B2C.8] (cite [B2C.8], Phase 2C) — Case B: documents a selection buffr does not perform.
- **What to build:** `ml/MODEL_SELECTION.md` recording the two candidates, their CV scores, the tiebreaker logic, and the final pick — plus an honest line distinguishing this from buffr's real choice (calling gemma2:9b is supplier selection, not model selection).
- **Why it earns its place:** The decision record is the interview artifact. It also forces you to write the distinction that this whole file turns on.
- **Files to touch:** new `ml/MODEL_SELECTION.md`, references `ml/select_model.py` output.
- **Done when:** The note states both scores, the rule applied, the winner, and one sentence separating ML model selection from buffr's serving-model choice.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How do you choose a model for a classical-ML task?"**

Train two baselines — logistic regression and gradient-boosted trees — cross-validate both, and pick the simpler one unless trees beat logistic by a margin that survives the CV noise. Simple wins ties because it's faster, interpretable, and has fewer failure modes. Complexity is debt I only take on against a proven gain.

```
  scores tie    ─► logistic (simpler)
  trees clearly ahead ─► trees (earned it)
```

Anchor: *"Two baselines, and a tiebreaker for simplicity."*

**Q: "buffr uses gemma2 — isn't that model selection?"**

No — that's supplier selection. I'm choosing which pre-trained model to *call*, evaluated by serving metrics like P@1/R@3 and latency. Model selection in the ML sense means training multiple candidates on my own data and comparing them with cross-validation. buffr trains nothing, so it never does that.

```
  buffr: pick a vendor model (config line) ─► serving decision
  ML:    train candidates, cross-validate ─► selection
```

Most candidates have only ever picked a vendor model from a dropdown; having trained two baselines and chosen between them on cross-validated scores (contrl-shaped work) is the signal.

Anchor: *"Calling gemma2 is choosing a supplier, not selecting a model."*

## See also

- `./01-supervised-pipeline.md` — where Train (and this choice) sits in the five-stage line.
- `./02-feature-engineering.md` — good features make logistic competitive, often ending the bake-off.
- `./03-train-val-test.md` — cross-validation reuses the val role; test stays sealed.
- `../03-retrieval-and-rag/02-embedding-model-choice.md` — buffr's real supplier-selection decision.
- `../05-evals-and-observability/` — the metrics (P@1/R@3) that grade buffr's served models.
- `../09-ml-system-design-templates/` — model selection inside a full system design.
