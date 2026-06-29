# The Supervised Pipeline

### *industry: supervised machine-learning pipeline · type: the five stages from raw data to a serving model*

## Zoom out

Every classical-ML system you've ever shipped or read about is the same five-stage assembly line. buffr lives at the very end of it — and only the end. It serves pre-trained models (gemma2:9b, nomic-embed-text) but builds none of the machinery that produces a model. This file walks the whole line so you can see exactly which half buffr has and which half you've never built.

**The supervised pipeline, with the whole line marked ★ — buffr only touches the last box**

```
┌────────┐   ┌──────────┐   ┌────────┐   ┌────────┐   ┌──────────┐
│  DATA  │──►│ FEATURES │──►│ SPLIT  │──►│ TRAIN  │──►│  DEPLOY  │
│ raw    │   │ raw→     │   │ train/ │   │ fit    │   │ serve    │
│ rows + │   │ numeric  │   │ val/   │   │ params │   │ predict  │
│ labels │   │ vectors  │   │ test   │   │ to data│   │ on live  │
└────────┘   └──────────┘   └────────┘   └────────┘   └──────────┘
★            ★              ★            ★              ★ buffr is HERE
└──────────────── buffr has NONE of this ──────────────┘  (Ollama serves)
         the exact half Rein has never built
```

You built one of these end-to-end once — contrl, the pose-landmarking model: frames in, landmark coordinates out, a real supervised vision pipeline. So you know the *shape*. The point of this file is that buffr is the photographic negative of contrl: it has the Deploy box (a model answering queries) and nothing upstream of it. Naming that gap precisely is the whole job.

## Structure pass

The axis is **who produces the model's parameters**. In contrl, *you* did — gradient descent over labeled frames. In buffr, *someone else* did — Google trained gemma2, Nomic trained the embedder. The seam is the moment a model's weights are frozen: everything left of it is training, everything right is inference.

**One axis: trained-by-you vs trained-by-someone-else**

```
   TRAINING SIDE (contrl)              INFERENCE SIDE (buffr)
   ──────────────────────              ──────────────────────
   you own the labels                  weights arrive frozen
   you own the features                you send tokens, get tokens
   you own the loss/optimizer          you tune prompts, not params
   ┌────────────────────┐              ┌────────────────────┐
   │ data→features→     │   ──seam──►  │ load weights →     │
   │ split→train        │   (freeze)   │ predict / generate │
   └────────────────────┘              └────────────────────┘
        the seam: the moment weights stop changing
```

Left of the seam: the four stages that *make* a model — and buffr has zero of them. Right of the seam: Deploy, the one stage buffr has, where Ollama loads frozen weights and serves predictions. Consequence: every concept in this whole `08-machine-learning` section is new ground for buffr, taught as a thing you'd build in a new `ml/` directory, not a thing buffr already does.

## How it works

### Move 1 — Mental model

A supervised pipeline is a factory that turns labeled examples into a function. You feed it `(input, correct_answer)` pairs; it emits a function that maps `input → predicted_answer` and generalizes to inputs it never saw. The five stages are the stations on the line, and — this is the thesis — **the model station is the least likely place a defect was introduced.** Most ML bugs are data bugs or feature bugs that entered upstream and the model faithfully learned.

**Where defects actually enter the line**

```
  DATA ████████████  ◄── mislabels, leakage, sampling bias    (most bugs)
  FEAT ███████████   ◄── wrong scaling, encoding, leakage     (most bugs)
  SPLIT ████         ◄── leaky split → metrics lie            (silent bugs)
  TRAIN ██           ◄── wrong loss, overfit                  (fewer bugs)
  DEPLOY █           ◄── skew, stale model                    (fewer bugs)

  the bar = how often the real root cause lives there
```

Frontend bridge: it's the render pipeline. When the UI is wrong, the bug is almost never in React's reconciler — it's in the data you passed or the props you shaped. Same here: when the model is wrong, suspect the data and features first, the optimizer last.

### Move 2 — Walk the mechanism

The code blocks below are **illustrative pseudocode** — buffr contains none of this. They show the shape of a pipeline you'd build, using contrl's category (a supervised model) as the reference.

**Stage 1 — Data: rows plus a label column**

Supervised learning needs a label per row — the correct answer the model will be graded against. No labels, no supervision.

```
  ┌─────────────────────────────────────────────┐
  │  X (features)                    │  y (label)│
  │  ────────────────────────────────│───────────│
  │  frame_pixels, joint_angles...   │  pose_id  │  ◄── contrl shape
  │  ────────────────────────────────│───────────│
  │  the label column is what makes  │  REQUIRED │
  │  this "supervised"               │           │
  └─────────────────────────────────────────────┘
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code. The shape of a labeled dataset.
rows = load("examples.parquet")        # one row per example
X = rows.drop(columns=["label"])       # inputs
y = rows["label"]                      # the supervision signal
```

The label is the entire premise. buffr's closest real artifact is `eval/queries.json` — `{query → relevant docs}` is a labeled set — but buffr uses it to *grade retrieval*, never to *fit parameters*. That distinction is the whole section.

**Stage 2 — Features: raw signal becomes numbers**

Models consume numeric vectors, not raw rows. Feature engineering turns `"Tuesday"`, `"premium"`, free text, timestamps into floats. This is stage 02's entire subject.

```
  raw row ──► feature transform ──► numeric vector the model can multiply
  "premium" ─► one-hot [0,1,0] ─┐
  "Tuesday" ─► day_of_week 2   ─┼─► [0,1,0, 2, 1.7, ...]  ◄── model input
  free text ─► embedding/tfidf ─┘
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
X_num = encode_categoricals(X)         # strings → numbers
X_num = scale(X_num)                   # comparable ranges
X_num = add_text_features(X_num, text) # text → vectors
```

**Stage 3 — Split: carve out data the model never trains on**

You partition into train (fit), validation (tune), test (report once). Get the split wrong — leak future or grouped rows across the boundary — and every metric downstream lies. Stage 03's subject.

```
  all rows  ───────────────────────────────────►
  ┌──────────────────┬──────────┬──────────┐
  │      TRAIN        │   VAL    │   TEST   │
  │   fit params      │  tune    │ report×1 │
  └──────────────────┴──────────┴──────────┘
   the wall between TRAIN and TEST must be airtight
```

**Stage 4 — Train: fit parameters by minimizing loss**

The optimizer adjusts parameters to shrink the gap between predictions and labels on the *train* split, checking *val* to avoid memorizing.

```
  predict ─► compare to label ─► loss ─► nudge params ─► repeat
     ▲                                        │
     └──────────── until val loss stops improving
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
model = Classifier()
for epoch in range(N):
    loss = loss_fn(model(X_train), y_train)
    model.step(loss)                   # gradient update
    if val_loss(model) stops improving: break
```

This is the stage contrl had and buffr will never have for gemma2 — Google ran it on TPU clusters; you just download the result.

**Stage 5 — Deploy: serve frozen weights for inference**

Weights freeze; the model answers live inputs. **This is the only stage buffr implements** — Ollama loads frozen gemma2/nomic weights and serves predictions over HTTP.

```
  frozen weights ──► Ollama ──► query in ──► tokens/embedding out
                       ▲
              buffr's whole ML footprint lives in this box
```

### Move 2.5 — Current vs future

**Case B: buffr trains nothing.** It has Deploy and only Deploy. The four upstream stages don't exist in the repo.

```
  TODAY (buffr)                      IF YOU BUILT TRAINING (new ml/)
  ─────────────                      ───────────────────────────────
  ┌────────┐                         ┌────┬────┬─────┬─────┐ ┌────────┐
  │ DEPLOY │  Ollama serves          │DATA│FEAT│SPLIT│TRAIN│►│ DEPLOY │
  │ frozen │  pre-trained            └────┴────┴─────┴─────┘ └────────┘
  └────────┘                          new ml/ dir owns these  same box
   no upstream                        e.g. classify chunk-type, route queries
```

What you *could* build: a small supervised model that classifies incoming queries (route to coffee.md vs work.md) using `eval/queries.json` patterns as seed labels, or a model that predicts chunk usefulness. None exists. The home for it is a new `ml/` directory.

### Move 3 — The principle

**The model is the cheapest stage to get right and the rarest place a bug hides; the data and feature stages are where quality and defects are actually decided.** buffr stands at the Deploy end of a line it never built — which is exactly why this whole section is new ground. Having built contrl means you've stood at the *other* end once. The interview signal is being able to walk both ends of the line, honestly, and say which one buffr occupies and why.

## Primary diagram

The five stages, what each owns, and the hard truth about buffr's coverage.

**The pipeline buffr half-occupies**

```
  DATA      FEATURES    SPLIT       TRAIN       DEPLOY
  labels    raw→numeric train/val/  fit params  serve frozen
  ┌────┐    ┌────┐      ┌────┐      ┌────┐       ┌────┐
  │ ?? │───►│ ?? │─────►│ ?? │─────►│ ?? │──────►│ ✔  │
  └────┘    └────┘      └────┘      └────┘       └────┘
  buffr: ✗  buffr: ✗    buffr: ✗    buffr: ✗     buffr: ✔ (Ollama)
  └──────── most bugs live here ────┘            └ fewest bugs
  contrl: ✔ ✔ ✔ ✔ ✔  (Rein built this whole line once)
```

After the box: buffr is one box out of five. Everything left of Deploy is the half you'd build new — and the half where contrl proves you can.

## Elaborate

- **Why "most bugs are data/feature bugs" is the load-bearing claim.** A model is a faithful mirror: it learns whatever pattern the data presents, including the wrong ones. Mislabeled rows, a leaked column, a feature scaled wrong — the optimizer dutifully fits them and the model looks confidently incorrect. Engineers new to ML reach for hyperparameters; veterans audit the data first. contrl taught you this the hard way if a single bad-frame batch ever poisoned a training run.
- **buffr's Deploy-only footprint is not a weakness — it's a category.** AI-application engineering (consuming pre-trained models) is a legitimate, large discipline. The mistake is *calling it ML training*. buffr does inference, prompt-shaping, retrieval, eval. It does not do supervised learning. Say so plainly in interviews.
- **The latent training corpus buffr already collects.** `agents.messages` logs every turn — role, content, tool_calls, tokens_used. That's a trajectory dataset. It's not training anything today, but it's the raw material a fine-tune or a routing classifier would draw on. Naming it shows you see the pipeline buffr *could* feed.
- **Inference can have bugs too — just fewer, and different.** Train/serve skew (features computed differently at serve time than train time) and stale models are the Deploy-side defects. buffr's analog is stale embeddings (see 03-retrieval-and-rag/09). So Deploy isn't bug-free; it's just not where *most* classical-ML bugs originate.

## Project exercises

### Build a minimal supervised pipeline that classifies query intent

Not yet implemented — buffr trains nothing. This exercise builds the four missing upstream stages end-to-end on a tiny, honest target, so you've stood at the data end of buffr's own line, not just contrl's.

- **Exercise ID:** [B2C.1] (cite [B2C.1], Phase 2C) — Case B: buffr has no training code; this is the primary buildable target.
- **What to build:** A new `ml/intent_classifier.py` that takes labeled `(query → target_doc)` pairs (seeded from `eval/queries.json`), engineers text features, splits train/val/test, trains a simple classifier (logistic regression), and reports test accuracy. All five stages, smallest honest version.
- **Why it earns its place:** It is the half of the pipeline buffr lacks. Running Data→Features→Split→Train on buffr's *own* data turns the abstract gap into a thing you built.
- **Files to touch:** new `ml/` dir (`ml/intent_classifier.py`, `ml/dataset.py`), reads `eval/queries.json` as the seed label set.
- **Done when:** `python ml/intent_classifier.py` prints train/val/test sizes and a single held-out test accuracy, and you can name which stage was hardest.
- **Estimated effort:** 1 day.

### Audit buffr's Deploy stage for train/serve skew risk

Not yet implemented — buffr trains nothing, but it *deploys*, so the Deploy-side failure mode is real and inspectable today.

- **Exercise ID:** [B2C.2] (cite [B2C.2], Phase 2C) — Case B: training stages absent; Deploy stage present and auditable.
- **What to build:** A short written audit (in `ml/DEPLOY_NOTES.md`) of where buffr's inference-time feature computation (embedding the query) must exactly match index-time computation (embedding chunks), and what would break if the embedding model version drifted.
- **Why it earns its place:** Train/serve skew is the canonical Deploy bug. buffr's embed-query-vs-embed-chunk path is a real instance, and `embedding_model` is already a column in `agents.chunks`.
- **Files to touch:** new `ml/DEPLOY_NOTES.md`, references `sql/001_agents_schema.sql` (`embedding_model` column).
- **Done when:** The note names the exact skew risk (query embedded by a different model/version than the chunks) and the existing guard or gap.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "Walk me through a supervised ML pipeline — and where does buffr sit on it?"**

Five stages: Data, Features, Split, Train, Deploy. buffr sits in Deploy only — Ollama serves pre-trained gemma2 and nomic-embed. The four upstream stages don't exist in buffr; that's AI-application engineering, not ML training. I've built the full line once, in contrl, a supervised pose-landmarking model — so I can speak to both ends honestly.

```
  DATA→FEAT→SPLIT→TRAIN→[DEPLOY]
   contrl: all five      buffr: this box only
```

Anchor: *"buffr deploys models; it doesn't make them."*

**Q: "When an ML model is performing badly, where do you look first?"**

Data and features, not the model. The model faithfully learns whatever the data presents — mislabels, leakage, a feature scaled wrong. Most root causes live upstream of training. Hyperparameters are the last thing I touch, not the first.

```
  bug suspected in: TRAIN █  ◄── least likely
  real root cause:  DATA/FEAT ████████  ◄── most likely
```

Most candidates have only consumed pre-trained models — having trained one (contrl) means I've debugged the data end, where the real bugs are. That's the signal.

Anchor: *"Suspect the data before the model."*

## See also

- `./02-feature-engineering.md` — the Features stage in depth (where 60–80% of quality is decided).
- `./03-train-val-test.md` — the Split stage and the leakage rule that keeps metrics honest.
- `./04-model-selection.md` — the Train stage's first real decision: which baseline.
- `../03-retrieval-and-rag/` — buffr's actual Deploy-side work (inference, retrieval).
- `../05-evals-and-observability/` — `eval/queries.json` as a labeled held-out set, P@1/R@3 as ML metrics.
- `../09-ml-system-design-templates/` — assembling these stages into a full system design.
