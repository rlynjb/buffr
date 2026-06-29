# Confusion matrices — per-class error analysis

*Industry standard (per-class error analysis). buffr has no classifier, so it has no confusion matrix — Not yet implemented. The exercises build one over `agents.messages`.*

## Zoom out, then zoom in

A single accuracy number tells you *whether* a classifier is failing; it never tells you *how*. The confusion matrix is the per-cell breakdown that does — it shows you exactly which class gets mistaken for which, so you can debug the specific confusion instead of the aggregate. buffr has no classifier, so there's no matrix today. But the day you put a run-outcome classifier over `agents.messages` — success / warning / error — the confusion matrix is the view that tells you whether it confuses warnings for errors, or quietly calls every failed run a success.

```
  Zoom out — where a confusion matrix WOULD attach

  ┌─ Data layer (exists) ───────────────────────────────────────┐
  │  agents.messages — runs labelled success / warning / error  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ classifier predicts a class
  ┌─ ML layer (no model — WOULD attach) ─▼──────────────────────┐
  │  3-class run-outcome classifier                             │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ score per-cell ↓
  ┌─ Eval layer (★ matrix attaches here ★) ─▼───────────────────┐
  │  ★ CONFUSION MATRIX ★  rows=actual, cols=predicted          │ ← we are here
  │  diagonal=correct · off-diagonal=the specific confusions    │
  │  → per-class precision/recall/F1 derived from the cells     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a **confusion matrix** is a grid where rows are the *actual* classes and columns are the *predicted* classes (state the convention up front — people swap it and misread everything). The diagonal is where actual equals predicted: the correct calls. Every off-diagonal cell is a specific mistake — "actual error, predicted success" is a different, more dangerous bug than "actual warning, predicted error." This file teaches you to *read* the matrix and *derive* per-class precision, recall, and F1 from its cells, with the arithmetic shown.

## Structure pass

**Layers:** the raw predictions → the matrix that tallies them → the per-class metrics extracted from the matrix.

**Axis — "what does this layer let me see about a specific mistake?"**

```
  trace "can I see WHICH class confuses WHICH?" across the layers

  ┌─ accuracy (scalar) ─────┐   NO — one number, no per-class detail
  │  fraction correct       │   "85%" hides every specific confusion
  └─────────────────────────┘
  ┌─ confusion matrix ──────┐   YES — every actual×predicted pair, cell by cell
  │  rows=actual cols=pred  │   off-diagonal = the exact mistakes
  └─────────────────────────┘
  ┌─ per-class metrics ─────┐   YES — precision/recall/F1 read OFF the cells
  │  derived from columns/  │   column = predicted, row = actual
  │  rows of the matrix     │
  └─────────────────────────┘

  the matrix is the only layer that shows the SHAPE of the error
```

**The seam:** the boundary between the matrix and the per-class metrics is where the same numbers get read two ways — read a *column* and you get precision (of what I predicted as X, how much was X); read a *row* and you get recall (of what was actually X, how much did I catch). Same cells, two directions. Getting that direction backwards is the single most common confusion-matrix mistake, which is why the convention (rows=actual, cols=predicted) has to be nailed before any arithmetic.

## How it works

### Move 1 — the mental model

You've debugged a router that dispatches requests to the wrong handler. You don't fix it by knowing "10% of requests are misrouted" — you fix it by knowing *which* route goes *where it shouldn't*: `/users` requests landing in the `/orders` handler. A confusion matrix is exactly that routing table for a classifier — each cell is "how many actual-X did I dispatch to predicted-Y." The diagonal is correct routing; the off-diagonal cells name the specific misroutes you go fix.

```
  the pattern — the matrix as a routing table (rows→cols)

                 predicted →
                 ┌─ A ─┬─ B ─┬─ C ─┐
       actual  A │ ✓✓✓ │  ·  │  ·  │   diagonal (✓) = routed correctly
         ↓      B │  ·  │ ✓✓✓ │  ·  │
              C │  X  │  ·  │ ✓✓✓ │   off-diagonal (X) = actual-C → predicted-A
                 └─────┴─────┴─────┘        a SPECIFIC misroute to debug
```

### Move 2 — the step-by-step walkthrough

**The convention — rows actual, columns predicted, diagonal correct.** Fix this first or every later number is backwards. Each row is one *actual* class; each column is one *predicted* class. A cell `(row r, col c)` counts examples whose true class is `r` and that the model predicted as `c`. The diagonal (`r == c`) is correct predictions; everything off it is a mistake, and *which* off-diagonal cell tells you the exact nature of the mistake.

```
  the 2×2 — name every cell (the binary base case)

                   predicted POS   predicted NEG
    actual POS  │      TP        │      FN       │  ← row = actual positives
    actual NEG  │      FP        │      TN       │  ← row = actual negatives
                   ─────────────────────────────
                   col = predicted pos   col = predicted neg

  TP true positive   · FN false negative (missed a real positive)
  FP false positive  · TN true negative
  diagonal = TP, TN (correct) · off-diagonal = FP, FN (the two error types)
```

**Derive precision — read a COLUMN.** Precision answers "of everything I *called* positive, how much actually was?" That's the predicted-positive *column*: `TP / (TP + FP)`. You're dividing the correct cell in that column by the whole column. Column = predicted = precision.

```
  precision = read DOWN the predicted-POS column

                   predicted POS │ predicted NEG
    actual POS  │      TP ───────┐│
    actual NEG  │      FP ───────┤│
                   ──────────────┘
                   precision(POS) = TP / (TP + FP)
                   "of what I predicted POS, the fraction that was POS"
```

**Derive recall — read a ROW.** Recall answers "of everything that *actually* was positive, how much did I catch?" That's the actual-positive *row*: `TP / (TP + FN)`. Correct cell in the row, divided by the whole row. Row = actual = recall.

```
  recall = read ACROSS the actual-POS row

                   predicted POS   predicted NEG
    actual POS  │  ┌── TP ──────────── FN ──┐ │  ← whole row
                   └─────────────────────────┘
                   recall(POS) = TP / (TP + FN)
                   "of what truly was POS, the fraction I caught"
```

F1 is then the harmonic mean of the two: `F1 = 2·P·R / (P + R)` — one number that punishes you if *either* precision or recall is bad. In pseudocode, all three fall straight out of the cells:

```
  // INPUT: confusion matrix M, where M[actual][predicted] = count
  for each class c:
    TP = M[c][c]                              // diagonal cell for c
    FP = sum(M[other][c] for other != c)      // column c minus the diagonal
    FN = sum(M[c][other] for other != c)      // row c minus the diagonal
    precision[c] = TP / (TP + FP)             // COLUMN read
    recall[c]    = TP / (TP + FN)             // ROW read
    f1[c]        = 2*precision[c]*recall[c] / (precision[c]+recall[c])
  // OUTPUT: per-class precision, recall, f1 — all from the matrix cells
```

**Work a concrete 2×2 — the arithmetic.** Take a binary "did the run fail?" classifier evaluated on 100 runs.

```
  worked 2×2 — failure detector, 100 runs

                   pred FAIL   pred PASS
    actual FAIL │    8 (TP)  │   2 (FN)  │  ← 10 actual failures
    actual PASS │    5 (FP)  │  85 (TN)  │  ← 90 actual passes
                   ─────────────────────
  accuracy      = (8+85)/100        = 0.93   ← looks fine
  precision(FAIL)= 8/(8+5)  = 8/13  = 0.62   ← column: noisy alarms
  recall(FAIL)   = 8/(8+2)  = 8/10  = 0.80   ← row: caught 8 of 10
  F1(FAIL)       = 2·.62·.80/(.62+.80)       = 0.70
  → 93% accuracy, but 38% of FAIL alarms are false. The matrix shows it.
```

**Now a 3×3 — buffr's actual case.** A run-outcome classifier over `agents.messages` with three classes: success / warning / error. The 3×3 shows *which* confusion happens, which a binary matrix can't.

```
  worked 3×3 — run-outcome classifier, 150 runs

                     predicted →
                  success  warning  error    │ row total (actual)
  actual success │   90   │   6   │   4   │ │   100
  actual warning │    7   │  18   │   5   │ │    30
  actual error   │    3   │   2   │  15   │ │    20
                  ───────────────────────────
  col total (pred)   100      26      24

  per-class, read off the cells:
    precision(error) = 15 / 24 = 0.63    (column "error": 15 correct of 24 predicted)
    recall(error)    = 15 / 20 = 0.75    (row "error": caught 15 of 20 actual)
    F1(error)        = 2·.63·.75/(.63+.75) = 0.68

  the off-diagonal that matters: actual error → predicted success = 3 runs
    → 3 real failures called "success" — the silent, dangerous confusion
```

That last line is the whole point of a confusion matrix: the 3 in the (actual error, predicted success) cell is a *specific, named* failure mode — failed runs marked successful — that the accuracy number (which here is `(90+18+15)/150 = 0.82`) completely hides.

### Move 3 — the principle

A scalar metric grades the classifier; the confusion matrix *debugs* it. The single most useful habit in classification work is to stop reading accuracy and start reading the off-diagonal cells, because each one is a specific, fixable mistake with a cost attached — and the costs aren't equal (a real error called "success" is far worse than a warning called "error"). Every per-class metric you care about — precision, recall, F1, macro-F1 — is just a column or a row of this one grid. Learn to read it cell by cell and you can diagnose any classifier from its predictions alone.

## Primary diagram

```
  Confusion matrix — convention, derivations, the dangerous cell (full recap)

  CONVENTION: rows = ACTUAL · cols = PREDICTED · diagonal = CORRECT

                     predicted →
                  success  warning  error
  actual success │   90   │   6   │   4   │   ← row read = RECALL
  actual warning │    7   │  18   │   5   │
  actual error   │  ▼ 3   │   2   │  15   │
                  ─────────────────────────
                     ▲                ▲
                column read        diagonal (90,18,15) = correct
                = PRECISION         everything else = a confusion

  derive (per class c):
    TP = diagonal[c] · FP = column[c] − TP · FN = row[c] − TP
    precision = TP/(TP+FP)  [column]   recall = TP/(TP+FN)  [row]
    F1 = 2·P·R/(P+R)        macro-F1 = mean(F1 per class)  (→ 05)

  the load-bearing cell: actual error → predicted success (3)
    = real failures called fine → the confusion accuracy can't show
```

## Elaborate

The confusion matrix is the oldest tool in classifier evaluation — it predates machine learning, coming out of signal-detection theory and medical-test analysis (sensitivity = recall, specificity = TN-rate are the same cells under different names). It's the substrate every classification metric is built on: precision, recall, F1, macro-F1 (`05-class-imbalance.md`), ROC and PR curves are all derived from sliding a threshold and re-reading the matrix. Its real power is in *imbalanced and multi-class* settings, where a single accuracy number is most misleading — exactly buffr's eventual 3-class run-outcome case, where success vastly outnumbers error. The adjacent concept is calibration (`09-calibration.md`): the matrix is computed at one decision threshold, and moving that threshold (the threshold-move fix from `05`) reshuffles the cells, trading FP for FN. In practice you log the confusion matrix per training run (`14-training-run-logging.md`) so you can watch which confusions appear or vanish as the model and data change. This rhymes with the router-debugging instinct from your frontend work, and faintly with contrl: a rep-counter is a binary classifier per frame (rep / not-rep), and its confusion matrix would show false-positive reps (FP) versus missed reps (FN) — the same two error types, the same per-cell debugging, in a pose-pipeline medium.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Build a confusion-matrix renderer for a 3-class run-outcome classifier

- **Exercise ID:** CM-1 (Case B — no classifier exists yet). **The core per-class-debugging exercise.**
- **What to build:** a function that takes arrays of actual and predicted labels (success / warning / error) over runs from `agents.messages` and renders the 3×3 confusion matrix as ASCII — rows=actual, cols=predicted, diagonal highlighted — then prints per-class precision, recall, and F1 derived from the cells. Seed it with a trivial rule-based "classifier" (e.g. label by whether the run contains an `error` event) so you have real labels to render even before any model exists.
- **Why it earns its place:** it makes the per-class view concrete on buffr's own data, and the rule-based seed means you can build and verify the renderer with zero training. The "I can read and derive every classification metric from the matrix" muscle.
- **Files to touch:** new `src/confusion-matrix.ts` (the renderer + derivations); read run outcomes from `agents.messages` (the `warning`/`error` event rows persisted by `src/supabase-trace-sink.ts`) using the DB pool pattern from `src/cli/eval-cmd.ts`.
- **Done when:** the renderer prints the 3×3 grid with the diagonal marked and correct per-class precision/recall/F1 below it.
- **Estimated effort:** 1 day.

### Wire the matrix into eval-cmd.ts output

- **Exercise ID:** CM-2 (Case B — no classifier exists yet).
- **What to build:** extend the eval command so that, alongside the existing P@1/R@3 retrieval scores, it prints the run-outcome confusion matrix from CM-1 — so a future classifier's per-class breakdown sits next to the IR metrics in one report. Until a model exists, print the rule-based seed's matrix as a placeholder labelled honestly.
- **Why it earns its place:** it establishes the reporting home for any future classifier inside buffr's only existing eval harness, so the matrix is a first-class output rather than a one-off script — the same discipline as logging it per run.
- **Files to touch:** `src/cli/eval-cmd.ts` (append the matrix render after the mean P@1/R@3 lines); import the renderer from `src/confusion-matrix.ts` (CM-1).
- **Done when:** `npm run eval` prints the confusion matrix and per-class metrics below the existing P@1/R@3 summary.
- **Estimated effort:** 2–4 hr.

## Interview defense

**Q: I give you a confusion matrix. Derive precision and recall for one class.**
Answer: first I confirm the convention — rows are actual, columns predicted, diagonal is correct. For class X, the diagonal cell is TP. Precision is a *column* read: TP divided by the whole predicted-X column (TP + the other actuals predicted as X = FP). Recall is a *row* read: TP divided by the whole actual-X row (TP + the actual-X predicted as other = FN). Column gives precision, row gives recall — same TP cell, two directions.

```
  precision(X) = TP / column_X   (read down)
  recall(X)    = TP / row_X      (read across)
                 same diagonal TP, two readings
```

**Q: Accuracy is 82% on a 3-class run classifier. What does the confusion matrix add?**
Answer: it shows me *which* confusions make up the 18% I'm getting wrong — and they aren't equal in cost. The cell I care about most is actual-error predicted-success: real failures the model calls fine. **The part people forget: the off-diagonal cells aren't interchangeable — the accuracy number averages them, but a missed error is a far more expensive mistake than a misgraded warning, and only the matrix shows you that specific cell.**

```
  82% accuracy → matrix shows the (actual error → pred success) cell
                 = silent failures · the costly confusion accuracy hides
```

## See also

- `05-class-imbalance.md` — every metric here feeds macro-F1; the matrix is its companion.
- `09-calibration.md` — the matrix is computed at one threshold; moving it reshuffles the cells.
- `14-training-run-logging.md` — log the confusion matrix per run to watch confusions appear/vanish.
- `04-model-selection.md` — compare models by their matrices, not just one scalar.
- `../05-evals-and-observability/02-eval-methods.md` — buffr's P@1/R@3 eval, where CM-2 wires the matrix in.
