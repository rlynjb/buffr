# Train / Validation / Test

### *industry: data splitting · type: the discipline that keeps your metrics honest*

## Zoom out

This is the cheapest stage to implement and the easiest to get catastrophically wrong. Split the data carelessly and every number you report afterward is a lie you'll believe. buffr doesn't split anything for training — but it *does* hold out a labeled set for grading (`eval/queries.json`), which is the same discipline wearing a different hat.

**The pipeline, with SPLIT marked ★ — the stage that decides whether your metrics are real**

```
┌────────┐   ┌──────────┐   ┌────────┐   ┌────────┐   ┌────────┐
│  DATA  │──►│ FEATURES │──►│ SPLIT  │──►│ TRAIN  │──►│ DEPLOY │
│        │   │          │   │ ★ train│   │        │   │        │
│        │   │          │   │ val/   │   │        │   │        │
│        │   │          │   │ test   │   │        │   │        │
└────────┘   └──────────┘   └────────┘   └────────┘   └────────┘
                            ◄── this file
                  get this wrong and TRAIN's metrics are fiction
```

In contrl you had to do this right or your landmark accuracy was a fantasy — if frames from the same video landed in both train and test, the model "memorized" the person and your test score lied. That exact trap — splitting at the wrong unit — is the heart of this file. buffr's `eval/queries.json` is the held-out analog: queries the system is graded on, kept separate from anything it tunes against.

## Structure pass

The axis is **what each split is allowed to influence**. Train influences the model's parameters. Val influences your choices (which model, which hyperparameters). Test influences nothing — it is read exactly once, at the end, to report. The seam is the wall the model must not see across.

**One axis: what each split touches**

```
   TRAIN              VAL                TEST
   ─────              ───                ────
   fits parameters    tunes choices      reports once
   model sees it all  model sees scores  model never sees it
   ┌────────────┐     ┌────────────┐     ┌────────────┐
   │ optimizer  │     │ you, picking│    │ sealed until │
   │ updates    │     │ models/HP   │    │ the very end │
   └────────────┘     └────────────┘     └────────────┘
        │                   │                  │
        └── touches params  └── touches choices └── touches nothing
                  the seam: TEST is sealed; crossing it invalidates the score
```

Left: train and val, which the model and you are allowed to learn from. Right: test, sealed. Consequence: buffr trains nothing so it has no train/val, but the *sealed held-out* concept is exactly what `eval/queries.json` enforces — and P@1/R@3 are the numbers you read off it.

## How it works

### Move 1 — Mental model

A held-out set is a sealed exam. Train is the textbook, val is the practice quiz you can retake, test is the final you sit once. If you peek at the final while studying — let any test information leak into training — your grade stops measuring what you actually learned and starts measuring how well you cheated. The whole discipline is keeping the exam sealed.

**The three roles, and the one-way wall**

```
  STUDY ─────────────────────────► SIT EXAM
  ┌────────┐    ┌────────┐         ┌────────┐
  │ TRAIN  │───►│  VAL   │         │  TEST  │
  │textbook│    │ retake │         │ once,  │
  │        │    │ quiz   │         │ sealed │
  └────────┘    └────────┘  ║WALL║ └────────┘
   info flows left to right; NOTHING flows back across the wall
```

Frontend bridge: it's prod data discipline. You don't develop against the production database; you use a copy, and you ship to prod once you're confident. Touching prod during development is exactly the leak this stage forbids.

### Move 2 — Walk the mechanism

Code below is **illustrative pseudocode** — buffr trains nothing, so none of this exists in the repo.

**Part A — The three-way split**

You partition rows into three disjoint sets. Train fits, val tunes, test reports. They must not overlap.

```
  all rows ───────────────────────────────────►
  ┌──────────────────┬──────────┬──────────┐
  │      TRAIN (70%)  │ VAL (15%)│ TEST(15%)│
  └──────────────────┴──────────┴──────────┘
   disjoint: a row lives in exactly one set
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
train, temp = split(rows, 0.70)
val, test   = split(temp, 0.50)            # 15% / 15%
# fit on train, tune on val, touch test ONCE at the end
```

**Part B — The leakage rule: split at the unit the model meets NEW at inference**

This is the whole file. Random row-splitting is *wrong* whenever rows are grouped or time-ordered, because related rows land on both sides of the wall and the model effectively sees the test answers.

```
  WRONG: random split when rows are grouped
  video V: [f1 f2 f3 f4]
  random ─► f1,f3 in TRAIN   f2,f4 in TEST
            └── model memorizes V's person, "passes" test  ◄── leak!

  RIGHT: GROUP split — whole video to one side
  video V: [f1 f2 f3 f4] ──► all four in TRAIN (or all in TEST)
            └── test has people the model never saw  ◄── honest
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
# split by GROUP (e.g. video_id), not by row:
train_groups, test_groups = split(unique(video_id), 0.8)
train = rows[rows.video_id.isin(train_groups)]
test  = rows[rows.video_id.isin(test_groups)]
```

contrl is the textbook case: split by `video_id`, never by frame. If you split by frame, your test accuracy is inflated nonsense.

**Part C — Temporal split: when time is the unit**

If you'll predict the future at inference, your test must be the future relative to train. A random split lets the model train on tomorrow to predict today — impossible at serve time.

```
  time ───────────────────────────────────►
  ┌──────────────────────┬──────────────────┐
  │   TRAIN (past)        │   TEST (future)  │
  └──────────────────────┴──────────────────┘
   the cut is a date; never shuffle across it
```

**Part D — Test is read ONCE**

Every time you peek at test and adjust, you leak. Val is your repeatable feedback; test is the final, single, honest number. Tune on val, report on test, then stop.

```
  val:  check ─► adjust ─► check ─► adjust ... (as often as you like)
  test: check ─── once ───► report ─── STOP
        peeking + adjusting on test = silently overfitting to it
```

### Move 2.5 — Current vs future

**Case B: buffr has no train/val split — it trains nothing.** But it *does* run the held-out discipline: `eval/queries.json` is a sealed labeled set the system is graded against, and P@1/R@3 are the reported metrics.

```
  TODAY (buffr)                      IF YOU BUILT TRAINING (new ml/)
  ─────────────                      ───────────────────────────────
  eval/queries.json                  split labels into:
  = held-out labeled set             ┌───────┬─────┬──────┐
  graded once ─► P@1, R@3            │ TRAIN │ VAL │ TEST │
  ┌────────────────────┐            └───────┴─────┴──────┘
  │ test-set role only │  ──gap──►   with GROUP/TEMPORAL split so
  │ (no train/val)     │             the model meets new units at test
  └────────────────────┘
```

What you'd build: split a labeled dataset (seeded from `eval/queries.json`) into train/val/test using a *group* split (e.g. by source doc) so the classifier is tested on queries about docs it didn't train on. `eval/queries.json` already plays the test role; the train/val arms are what's missing.

### Move 3 — The principle

**Split at the unit the model meets new at inference, or your metrics lie — and read the test set exactly once.** The model's reported skill is only as honest as the wall between train and test. Random splitting is the default trap; group and temporal splitting are the corrections. buffr's `eval/queries.json` is the held-out half of this discipline already in the repo — the train/val half is the new ground. The signal is naming, for a given dataset, what the leakage unit is *before* you split.

## Primary diagram

The three splits, the one-way wall, and where buffr's real held-out set sits.

**The split discipline, with buffr's eval set placed**

```
  ┌──────────────────┬──────────┬──────────┐
  │      TRAIN        │   VAL    │   TEST   │
  │  fit parameters   │ tune     │ report×1 │
  └──────────────────┴──────────┴──────────┘
   split UNIT = what the model meets new at inference
   (group split by video/doc, OR temporal split by date)

  buffr today:  ✗ TRAIN   ✗ VAL   ✔ TEST-role = eval/queries.json
                                       graded once ─► P@1, R@3
```

After the box: buffr has the sealed-exam half (`eval/queries.json`) and lacks the train/val half. The leakage rule is the part that separates people who've trained a model from people who've only read about it.

## Elaborate

- **Why leakage is the silent killer.** A leaked split doesn't crash — it gives you a *great* test score, which is worse. You ship a model that aced a rigged exam and faceplants in production. The only defense is reasoning about the unit *before* splitting: "what does the model see fresh at serve time?" That unit is your split boundary.
- **Group split, temporal split, stratified split — pick by the data's structure.** Grouped rows (frames per video, messages per conversation) → group split. Time-ordered data → temporal split. Rare classes → stratified split to keep class balance. Random split is correct only when rows are genuinely independent, which is rarer than beginners assume.
- **`eval/queries.json` is already the right shape.** It's `{query → relevant docs}`, held out, graded once per change. If you grew it into a training corpus, the leakage question becomes: don't put queries about `coffee.md` in both train and test if the model could memorize the doc. Group-by-doc is the natural split. The repo already models the test role correctly.
- **Cross-validation is the val-set used k times (forward ref).** When data is scarce, you rotate which slice is val across k folds and average — squeezing more signal from few rows. That's the comparison engine in file 04. The wall to test stays sealed regardless.

## Project exercises

### Build a leakage-safe split for the intent classifier

Not yet implemented — buffr trains nothing, so no train/val/test split exists. This builds it with a deliberate group split so you internalize the leakage rule on buffr data.

- **Exercise ID:** [B2C.5] (cite [B2C.5], Phase 2C) — Case B: no training split exists; this is the primary buildable target.
- **What to build:** `ml/split.py` that splits a labeled query dataset into train/val/test, grouping by source doc so the model is never tested on queries about a doc it trained on. Print the group membership to prove no doc straddles the wall.
- **Why it earns its place:** It forces the one decision that separates real ML from cargo-cult ML — choosing the split *unit* — on buffr's own corpus, with `eval/queries.json` as the test-role seed.
- **Files to touch:** new `ml/split.py`, reads `eval/queries.json`.
- **Done when:** The script prints disjoint train/val/test sets where no source doc appears in more than one split, and you can state the leakage unit out loud.
- **Estimated effort:** 1–4hr.

### Demonstrate inflated metrics from a leaky split

Not yet implemented — buffr trains nothing, so there's no metric to inflate yet. This builds the cautionary experiment: train once with a leaky random split and once with a group split, and watch the test score drop to honesty.

- **Exercise ID:** [B2C.6] (cite [B2C.6], Phase 2C) — Case B: builds both the leaky and the honest split to contrast.
- **What to build:** Train the same classifier twice — random split vs group split — and report both test accuracies. The gap is the leakage you'd have shipped.
- **Why it earns its place:** Nothing teaches the leakage rule like watching a great score evaporate when you fix the split. It's the contrl lesson, reproduced on buffr.
- **Files to touch:** `ml/split.py`, new `ml/leakage_demo.py`.
- **Done when:** A printed comparison shows the random-split test accuracy is meaningfully higher (falsely) than the group-split accuracy, and you can explain why.
- **Estimated effort:** 1 day.

## Interview defense

**Q: "How do you split data, and what goes wrong if you do it naively?"**

Train fits, val tunes, test reports once. The trap is random splitting when rows are grouped or time-ordered — related rows land on both sides and the model memorizes instead of generalizing, so the test score is inflated fiction. The fix is to split at the unit the model meets new at inference: group split or temporal split.

```
  random split on grouped data ─► leak ─► fake-high score
  group/temporal split         ─► honest test
```

Anchor: *"Split at the unit the model meets new at inference."*

**Q: "buffr doesn't train — does any of this apply?"**

The test-set discipline does. `eval/queries.json` is a held-out labeled set the system is graded against, and P@1/R@3 are the reported metrics. It plays the test role correctly — kept separate from anything tuned. The train/val arms don't exist because buffr fits no parameters.

```
  buffr: eval/queries.json = sealed exam ─► P@1, R@3
         (test role present, train/val absent)
```

Most candidates have only consumed pre-trained models and never had to reason about a split unit. Having done it in contrl — split by video, not by frame — is the signal that I know where the metrics come from.

Anchor: *"The test set is sealed; eval/queries.json already is."*

## See also

- `./01-supervised-pipeline.md` — where Split sits in the five-stage line.
- `./02-feature-engineering.md` — fit transforms on train only (the feature-side leak).
- `./04-model-selection.md` — cross-validation reuses the val role to compare models.
- `../05-evals-and-observability/01-eval-set-types.md` — `eval/queries.json` as a held-out eval set.
- `../03-retrieval-and-rag/` — what the P@1/R@3 metrics are actually grading.
- `../09-ml-system-design-templates/` — splitting strategy inside a full system design.
