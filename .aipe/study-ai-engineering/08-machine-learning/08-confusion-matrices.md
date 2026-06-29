# Confusion Matrices

### *industry: confusion matrix · type: the table every classification metric is read off of*

## Zoom out

Precision, recall, F1, accuracy — you've seen the words, maybe even computed P@1/R@3 in buffr. But they aren't independent quantities you memorize separately. They are all *read off one small table* of counts, and once you can build that table you can derive every metric without looking anything up. This is the most mechanical file in the section and the one that ties the rest together. See where it sits:

**The supervised pipeline, with the stage the confusion matrix lives in marked**
```
┌────────┐  ┌──────────┐  ┌───────┐  ┌───────┐  ┌────────────────────────────────┐
│  Data  │─►│ Features │─►│ Split │─►│ Train │─►│ ★ EVALUATE ★                    │ ◄── this file
│        │  │          │  │       │  │       │  │ predictions vs truth → the MATRIX│
│        │  │          │  │       │  │       │  │ → every per-class metric falls out│
└────────┘  └──────────┘  └───────┘  └───────┘  └────────────────────────────────┘
                                                          │
                            P@1 / R@3 in buffr's eval ◄───┘ are the SAME family,
                            read off the SAME kind of table
```
The confusion matrix is the evaluation stage's source of truth — every score downstream is just arithmetic on its four cells.

## Structure pass

One axis organizes the whole table: **agreement vs disagreement between prediction and truth, split by which side was positive.** Four cells, two diagonals.

**The one axis: the four cells, by (predicted, actual)**
```
                         PREDICTED
                    Positive      Negative
        ┌────────┬────────────┬────────────┐
 ACTUAL │  Pos   │    TP      │    FN      │  ◄── actual positives row
        │        │ (right)    │ (missed)   │
        ├────────┼────────────┼────────────┤
        │  Neg   │    FP      │    TN      │  ◄── actual negatives row
        │        │ (false     │ (right)    │
        │        │  alarm)    │            │
        └────────┴────────────┴────────────┘
              ▲ predicted positives column

   ┌────────────────────────────── THE SEAM ──────────────────────────────┐
   │ DIAGONAL (TP, TN) = correct.  OFF-DIAGONAL (FP, FN) = the two error    │
   │ TYPES — and they are NOT interchangeable. FP = false alarm, FN = miss. │
   └───────────────────────────────────────────────────────────────────────┘
```
The seam: the off-diagonal holds two *different* errors. Conflating a false alarm with a miss is how people pick the wrong metric — precision punishes FP, recall punishes FN.

## How it works

### Move 1 — Mental model

The mental model: **precision and recall read the matrix in two different directions — down a column vs across a row.** Precision asks "of what I *called* positive, how much was right?" (read down the predicted-positive column). Recall asks "of what *was* positive, how much did I catch?" (read across the actual-positive row). Same TP in the numerator, different denominators. Hold contrl pose-landmarking in mind — that model's every "is this a wrist" decision lands in exactly one of these four cells.

**Precision reads a column, recall reads a row — same TP, different denominator**
```
                    PREDICTED
               Pos          Neg
        ┌────┬─────────┬─────────┐
 ACTUAL │Pos │  TP ────┼── FN    │  RECALL = TP / (TP + FN)  ──► read ACROSS the row
        ├────┼────│────┼─────────┤
        │Neg │  FP│    │  TN     │
        └────┴────│────┴─────────┘
                  │
         PRECISION = TP / (TP + FP)  ──► read DOWN the column
```
One number falls out per direction; everything else is built from these two.

### Move 2 — Walk the mechanism

**Part 1 — Predictions meet truth and land in exactly one cell each.** Every test example increments exactly one of the four counts. The matrix is just the tally.

**Each example lands in one cell — the matrix is the histogram of outcomes**
```
   example: predicted Pos, actual Pos ─► TP++ 
   example: predicted Pos, actual Neg ─► FP++   (false alarm)
   example: predicted Neg, actual Pos ─► FN++   (miss)
   example: predicted Neg, actual Neg ─► TN++
                                          │
                       after all N examples ─► the filled matrix
```

**Part 2 — Derive the per-class metrics from the four counts.** Illustrative pseudocode, not buffr code — pure arithmetic on the cells:

**Every metric, derived from TP/FP/FN/TN (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Pure arithmetic on the four cells.
precision = TP / (TP + FP)          # of predicted-positive, how many right
recall    = TP / (TP + FN)          # of actual-positive, how many caught
f1        = 2 * precision * recall / (precision + recall)   # harmonic mean
accuracy  = (TP + TN) / (TP + FP + FN + TN)   # of ALL, how many right (lies under imbalance)
```

**Part 3 — F1 is the harmonic mean, so it punishes imbalance between P and R.** A model with precision 0.9 and recall 0.1 has a *harmonic* mean near 0.18, not the arithmetic 0.5 — F1 refuses to let one strong number cover for a weak one.

**Why F1 uses the harmonic mean — it can't be gamed by one high number**
```
   precision = 0.90 ─┐
                     ├─ arithmetic mean = 0.50  ◄── flattering, hides the 0.10
   recall    = 0.10 ─┘
                     └─ HARMONIC mean (F1) = 0.18  ◄── honest: dragged toward
                                                       the weaker number
```

**Part 4 — Generalize to multi-class: the diagonal is correct, off-diagonal cells name the confusions.** With K classes you get a K×K matrix; per-class precision/recall come from treating each class as "positive vs the rest."

**The multi-class matrix — diagonal is right, off-diagonal tells you WHO gets confused with WHO**
```
              PREDICTED
           A    B    C
        ┌────┬────┬────┐
   A    │ 50 │  3 │  2 │   recall(A) = 50 / (50+3+2) = 0.91  (read row A)
        ├────┼────┼────┤
   B    │  4 │ 40 │ 11 │   recall(B) = 40 / (4+40+11) = 0.73
 A      ├────┼────┼────┤
 C      │  1 │  9 │ 35 │   recall(C) = 35 / (1+9+35) = 0.78
 T      └────┴────┴────┘
 U          ▲    ▲
 A  precision(A)=50/(50+4+1)=0.91   ★ the 11 and 9 cells: B and C get confused
 L  precision(B)=40/(3+40+9)=0.77      for each other — a SPECIFIC, actionable fact
```

### Move 2.5 — current vs future

**The metric Rein already computes, traced back to the matrix it comes from**
```
   ALREADY REAL (buffr eval)                  THE SOURCE TABLE (Case B to build)
   ┌──────────────────────────────┐          ┌──────────────────────────────────┐
   │ over eval/queries.json:        │          │ a CONFUSION MATRIX from a trained │
   │   P@1  = precision at rank 1    │  same    │ classifier — where P@1/R@3 would  │
   │   R@3  = recall at rank 3   ◄───┼──family──┤ be read off TP/FP/FN/TN instead   │
   │ (precision / recall — REAL)     │          │ of off a retrieval rank           │
   │ NO trained model behind them    │          │ NO such model exists yet          │
   └──────────────────────────────┘          └──────────────────────────────────┘
```
buffr already computes precision and recall — over a retrieval rank, not a classifier's matrix. The vocabulary is identical; the table behind it is the Case B piece you'd build.

### Move 3 — The principle

The principle: **never report a single classification number — report the matrix, because the matrix says *which* error you're making.** Accuracy collapses four cells into one and throws away the only information you can act on: whether you're missing positives (FN) or crying wolf (FP). The matrix keeps both, and every metric you need is a two-line derivation from it.

## Primary diagram

**The whole picture: one table, every metric, both error types preserved**
```
                         PREDICTED
                    Positive      Negative
        ┌────────┬────────────┬────────────┐
 ACTUAL │  Pos   │    TP      │    FN      │ ── RECALL = TP/(TP+FN)  (catches misses)
        ├────────┼────────────┼────────────┤
        │  Neg   │    FP      │    TN      │
        └────────┴────────────┴────────────┘
                  │
         PRECISION = TP/(TP+FP)  (catches false alarms)
                  │
                  ├──► F1 = harmonic mean(P, R)   — balances the two
                  ├──► ACCURACY = (TP+TN)/all     — LIES under imbalance (see 05)
                  └──► multi-class: K×K, diagonal correct, off-diagonal = confusions
   ┌──────────────────────────────────────────────────────────────────────┐
   │ buffr's P@1 / R@3 are this exact precision / recall family — already   │
   │ computed over eval/queries.json, just off a rank instead of a matrix.  │
   └──────────────────────────────────────────────────────────────────────┘
```
Build the table once and every classification metric in the curriculum falls out of it.

## Elaborate

The sharp edges:

- **FP and FN are not symmetric in cost.** A spam filter's FP (real mail in spam) hurts differently than its FN (spam in inbox). The matrix keeps them separate so you can weight them; accuracy throws the distinction away. Always ask which error is more expensive *before* picking a threshold.
- **Multi-class: macro vs micro averaging.** Macro-averaging means per-class metrics each count equally (rare classes get a vote — ties to `05-class-imbalance.md`). Micro-averaging pools all cells first, so the common classes dominate. Report macro when the rare classes matter.
- **The off-diagonal is the most useful part.** In the multi-class table, "B gets confused for C 11 times" is a specific, fixable fact — maybe those classes need a better feature, or the labels are ambiguous. A single accuracy number hides it completely.
- **Normalize by row to read recall at a glance.** Dividing each row by its sum turns the matrix into per-class recall directly — handy for spotting which class the model is worst at catching.
- **buffr's honest line.** P@1 and R@3 over `eval/queries.json` are the precision/recall family this matrix generates — buffr computes them today over a retrieval rank. There is no classifier and no confusion matrix in the repo yet; building one is the Case B exercise, and it would let you read those same metrics off TP/FP/FN/TN.

## Project exercises

### Generate and read a confusion matrix from a trained classifier

- **Exercise ID:** [B2C.8] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Take the [B2C.5] query-intent classifier, and in `ml/` produce a full confusion matrix on the test split plus a derived report: per-class precision, recall, F1, and macro-F1 — every number computed *from the four cells*, not from a library shortcut, so you prove you can do the arithmetic. Print the matrix, then the derived table beside it.
- **Why it earns its place:** It makes precision/recall stop being memorized words and become a table you build. It also closes the loop with buffr's real metrics: you'll see that P@1/R@3 are the same family, read off a different structure.
- **Files to touch:** new `ml/confusion_matrix.py` (build matrix + derive metrics by hand), reuses the [B2C.5] classifier and test split, results to `ml/README.md`.
- **Done when:** the matrix prints with labeled rows/columns; precision, recall, and F1 per class are derived explicitly from TP/FP/FN/TN and match a library's numbers; a one-line note identifies the worst confusion (largest off-diagonal cell) and what you'd do about it.
- **Estimated effort:** half a day to 1 day.

### Connect buffr's P@1/R@3 to a matrix view

- **Exercise ID:** [B2C.8b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Reframe buffr's existing retrieval eval as a confusion-matrix problem: for each query in `eval/queries.json`, treat "is the retrieved chunk relevant" as a binary classification, tally TP/FP/FN across the eval set, and show that the P@1/R@3 buffr already reports fall out of that tally. No model is trained — this connects an *existing* metric to the *matrix structure* behind it.
- **Why it earns its place:** It's the honest bridge: it proves the metric vocabulary in the repo is the same one this section teaches, and it's the one confusion-matrix exercise buffr can do with data it already has.
- **Files to touch:** new `ml/retrieval_as_matrix.py`, reads `eval/queries.json` and the retrieval output, writes a matrix-view note to `ml/README.md`.
- **Done when:** running it reproduces buffr's existing P@1/R@3 numbers from a TP/FP/FN tally; a short note states plainly that this is a retrieval-rank reinterpretation, not a trained classifier.
- **Estimated effort:** half a day.

## Interview defense

Most candidates quote precision and recall but can't derive them from a table on a whiteboard. Having built the matrix — and read the off-diagonal — is the signal.

**Q: Walk me from a confusion matrix to recall.**
```
              PRED Pos   PRED Neg
   ACTUAL Pos    TP        FN     ◄── read this row
   ACTUAL Neg    FP        TN
        recall = TP / (TP + FN)   "of all actual positives, the fraction caught"
```
Anchor: recall reads across the actual-positive row; precision reads down the predicted-positive column.

**Q: Why ever report the full matrix instead of one F1 number?**
```
   F1 = 0.5 could be  (P=0.9, R=0.35)  OR  (P=0.35, R=0.9)
        │                                     │
        same F1, OPPOSITE failure modes ─► only the matrix tells you
        whether you're crying wolf (FP) or missing positives (FN)
```
Anchor: one number hides which error you're making; the matrix preserves both error types.

**Q: How does this connect to anything buffr already does?**
```
   buffr computes P@1 / R@3 over eval/queries.json TODAY
        │
        └─ same precision/recall family, read off a retrieval RANK
           ── building a trained classifier's confusion matrix is the
              Case B piece that doesn't exist yet
```
Anchor: buffr owns the metrics over a rank; the matrix behind a trained classifier is the honest gap.

## See also

- `./05-class-imbalance.md` — why accuracy (one matrix collapsed) lies, and the per-class metrics this matrix produces.
- `./07-transfer-learning.md` — read a before/after fine-tune comparison as two matrices.
- `../03-retrieval-and-rag/` — where buffr's P@1/R@3 retrieval metrics are defined.
- `../05-evals-and-observability/` — `eval/queries.json` as the labeled set the matrix would be tallied over.
- `../09-ml-system-design-templates/` — where per-class metric reporting becomes part of an eval system's design.
