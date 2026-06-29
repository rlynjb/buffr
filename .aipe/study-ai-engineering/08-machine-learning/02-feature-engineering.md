# Feature Engineering

### *industry: feature engineering · type: turning raw signal into numeric features before the model*

## Zoom out

This is the stage that decides whether your model is good, and it sits *before* the model touches anything. In classical ML, 60–80% of model quality is set here — in how you turn raw rows into numbers — not in the model choice. buffr does none of it. It hand-engineers no features; it leans entirely on a learned feature extractor (the embedder) it didn't build.

**The pipeline, with FEATURES marked ★ — the stage that decides most of the quality**

```
┌────────┐   ┌──────────┐   ┌────────┐   ┌────────┐   ┌────────┐
│  DATA  │──►│ FEATURES │──►│ SPLIT  │──►│ TRAIN  │──►│ DEPLOY │
│        │   │ ★ raw →  │   │        │   │        │   │        │
│        │   │ numeric  │   │        │   │        │   │        │
└────────┘   └──────────┘   └────────┘   └────────┘   └────────┘
              ◄── this file
              60–80% of model quality is decided HERE, BEFORE the model
```

In contrl you did this constantly — raw frames became joint angles, normalized coordinates, distances between landmarks. Those weren't pixels you fed the model; they were *features you computed*. That hand-crafting is the thing buffr skips entirely, because nomic-embed-text does it learned-style. This file is about the hand-crafted craft, and the honest contrast with embeddings.

## Structure pass

The axis is **hand-engineered vs learned features**. contrl (and all classical ML) hand-engineers: a human decides "the angle between these two joints matters" and computes it. buffr uses learned: the embedder *discovered* what matters during its own training. The seam is who chose the features — a human, or gradient descent.

**One axis: who designed the features**

```
   HAND-ENGINEERED (classical / contrl)   LEARNED (buffr's embedder)
   ────────────────────────────────────   ──────────────────────────
   human picks transforms                 model discovers them
   scale, one-hot, day_of_week, ratios    768 floats, no human meaning
   inspectable, debuggable                opaque, but no manual labor
   ┌──────────────────────────┐           ┌──────────────────────────┐
   │ raw ─► chosen transforms │ ──seam──► │ raw text ─► nomic ─► 768d │
   └──────────────────────────┘           └──────────────────────────┘
        the seam: did a human or an optimizer choose the features?
```

Left of the seam: the classical craft — and buffr does none of it. Right of the seam: buffr's reality — it hands raw text to a learned extractor and gets a vector. Consequence: buffr never decides what a feature *is*, so the entire skill below is new ground, taught as a thing you'd build, with embeddings as the honest contrast.

## How it works

### Move 1 — Mental model

Feature engineering is translation: the model speaks only numbers with comparable scales, so you translate every raw signal into that language. A string, a date, a paragraph — each needs a transform that preserves the *useful* information as floats. Do the translation well and a simple model wins; do it badly and no model recovers.

**Raw signals and their transforms**

```
  RAW                    TRANSFORM                  NUMERIC FEATURE
  ─────────────────────  ─────────────────────────  ───────────────
  47.0, 9000.0 (mixed)   scale (z-score / min-max)  -0.3, 1.8
  "premium" (category)   one-hot / target encode    [0,1,0] or 0.72
  "great coffee" (text)  tf-idf / embedding         sparse / 768d vec
  2026-06-19 (datetime)  extract day/month/cyclic   day=4, sin(month)
  price × qty (interact) multiply / cross           feature_AB
```

Frontend bridge: it's the serializer between your domain model and the wire format. The model is an API that only accepts a strict numeric schema; feature engineering is the adapter that conforms every input to it. A sloppy adapter corrupts everything downstream.

### Move 2 — Walk the mechanism

All code below is **illustrative pseudocode** — buffr has none of it. The categories are the standard toolkit, shaped by contrl-style examples.

**Category A — Numeric scaling: make ranges comparable**

A feature in [0,1] and one in [0,10000] aren't comparable; distance- and gradient-based models will let the big one dominate. Scaling fixes the units.

```
  before:  age=47    income=90000   ◄── income swamps age
  z-score: (x - mean) / std
  after:   age=-0.3  income=1.8      ◄── now comparable
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
mean, std = X_train.mean(), X_train.std()   # FIT on train only
X_train = (X_train - mean) / std
X_test  = (X_test  - mean) / std            # reuse train stats (no leakage)
```

The leakage trap is baked in here: you compute mean/std on *train only* and reuse them — never fit the scaler on the full set (that's stage 03's rule, appearing already).

**Category B — Categorical encoding: strings to numbers**

Models can't multiply `"premium"`. One-hot makes a binary column per category; target encoding replaces a category with its mean label — powerful but leakage-prone.

```
  ONE-HOT                         TARGET ENCODE
  "premium" ─► [0,1,0]            "premium" ─► mean(label | premium)=0.72
  safe, sparse, high-cardinality  dense, strong, LEAKS if fit on test
  blows up with many categories   needs out-of-fold computation
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
X = one_hot(X, "tier")                      # safe default
# target encoding MUST be out-of-fold to avoid leaking the label:
X["tier_te"] = target_encode_oof(X["tier"], y)
```

**Category C — Text to features: the place embeddings live**

Raw text becomes numbers two ways. Classical: tf-idf — a sparse vector of term weights. Learned: an embedding — a dense 768-d vector. **This is buffr's one real feature step, and it's the learned kind.**

```
  CLASSICAL (tf-idf)              LEARNED (buffr: nomic-embed-text)
  "great coffee" ─► sparse vec    "great coffee" ─► 768 dense floats
  one slot per vocabulary term    no human-readable slots
  human-inspectable weights       opaque, captures meaning
  ◄── you'd build this            ◄── buffr already does this
```

```python
# ILLUSTRATIVE PSEUDOCODE — not buffr code.
X_tfidf = tfidf.fit_transform(texts)        # classical, sparse
# buffr's real path is the learned extractor instead:
# embedding = ollama.embed("nomic-embed-text:v1.5", text)  # 768-d
```

**Category D — Datetime: unpack the timestamp**

A raw timestamp is one opaque number. The signal lives in its parts — day of week, hour, month — and cyclic features encode that Sunday is next to Monday.

```
  2026-06-19 14:00
        │ extract
        ▼
  day_of_week=4   hour=14   month=6
        │ cyclic (so Dec is near Jan)
        ▼
  sin(2π·month/12), cos(2π·month/12)
```

**Category E — Interactions: combine features that only matter together**

Sometimes `price` alone and `quantity` alone are weak, but `price × quantity` (total) is the real signal. Interaction features hand the model the combination explicitly.

```
  price=4   quantity=3       ─► weak alone
  price × quantity = 12      ─► strong (the model can't always find this itself)
```

### Move 2.5 — Current vs future

**Case B: buffr engineers no hand-crafted features.** Its only feature step is the learned embedding — and it didn't even build that; it calls Nomic's frozen extractor.

```
  TODAY (buffr)                      IF YOU BUILT FEATURES (new ml/)
  ─────────────                      ───────────────────────────────
  text ─► nomic ─► 768d              raw signal ─► hand-crafted features:
  one learned step, opaque            scale + one-hot + datetime + tf-idf
  ┌──────────────┐                   ┌─────────────────────────────────┐
  │ no human      │   ──gap──►       │ a human-chosen feature vector,   │
  │ feature design│                  │ inspectable, for a real model    │
  └──────────────┘                   └─────────────────────────────────┘
```

What you'd build: features for the intent classifier from file 01 — query length, has-question-mark, tf-idf over query terms, maybe the cosine to each doc's centroid. That's hand-engineering, and buffr has none of it.

### Move 3 — The principle

**Features are where the modeling actually happens; the model just draws the boundary your features made drawable.** A linear model on great features beats a deep model on raw garbage. buffr sidesteps this entirely by renting a learned extractor — convenient, but it means buffr has never decided what a feature *is*. contrl did, every day. The signal is being able to say: "embeddings are a learned feature extractor, and the classical alternative is the hand-crafted vector I'd build instead — here's when each wins."

## Primary diagram

The five feature categories and buffr's single learned shortcut past all of them.

**Hand-engineered toolkit vs buffr's one learned step**

```
  HAND-ENGINEERED (you'd build — buffr has none)
  ┌─────────┬───────────┬──────────┬──────────┬─────────────┐
  │ scaling │ categorical│  text   │ datetime │ interactions │
  │ z-score │ one-hot/TE │ tf-idf  │ cyclic   │ a×b crosses  │
  └─────────┴───────────┴──────────┴──────────┴─────────────┘
                    │ a human chose each transform
                    ▼
  ────────────────────────────────────────────────────────────
  LEARNED (buffr's only feature step)
  raw text ─► nomic-embed-text ─► 768 floats   ◄── no human design
```

After the box: buffr lives on the bottom line only. The top line is the craft this file teaches and the half buffr never does.

## Elaborate

- **Why feature engineering is 60–80% of quality.** The model's job is to find a boundary in feature space. If your features already separate the classes, a trivial model finds the boundary; if they don't, no model can. Garbage in, garbage boundary. This is why veterans spend their time on features and juniors spend it on architectures.
- **Embeddings are feature engineering — just automated.** nomic-embed-text learned, during *its* training, which combinations of token patterns carry meaning, and bakes them into 768 dimensions. That's feature extraction, learned instead of hand-coded. The tradeoff: you lose inspectability (no dimension means "has question mark") and gain coverage (it handles paraphrase you'd never hand-code). Saying this out loud connects buffr's real work to the classical concept.
- **The leakage trap lives in features, not just splits.** Fitting a scaler or a target-encoder on the full dataset leaks test information into training. The fix — fit transforms on train only, apply to val/test — belongs to feature engineering even though it's a split concern. The two stages are coupled.
- **buffr's corpus would barely need hand features — that's why it gets away with embeddings.** Personal markdown notes are pure text; the embedder handles them. The moment you add structured signal (timestamps on messages, token counts, tool-call patterns from `agents.messages`), hand-engineered features re-enter, and buffr has no machinery for them.

## Project exercises

### Hand-engineer a feature set for the query-intent classifier

Not yet implemented — buffr trains nothing, so it has no hand-engineered features at all. This builds the Features stage on buffr's own queries and forces the human design decisions the embedder hides.

- **Exercise ID:** [B2C.3] (cite [B2C.3], Phase 2C) — Case B: no hand-crafted features exist; this is the primary buildable target.
- **What to build:** `ml/features.py` that turns a raw query string into a hand-crafted numeric vector: length, word count, has-question-mark, tf-idf over query terms, and (optionally) cosine to each doc centroid. Fit all transforms on train only.
- **Why it earns its place:** It makes the abstract "60–80% of quality is here" concrete on buffr data, and it makes you choose features a human can read — the opposite of the opaque 768-d embedding.
- **Files to touch:** new `ml/features.py`, `ml/dataset.py` (reads `eval/queries.json` for seed labels).
- **Done when:** `features.py` emits a documented numeric vector per query, transforms are fit on train only, and you can name which feature you expect to matter most.
- **Estimated effort:** 1 day.

### Contrast hand features vs embeddings on the same task

Not yet implemented — buffr only has the learned path, so the comparison doesn't exist. This runs both extractors side by side to feel the tradeoff.

- **Exercise ID:** [B2C.4] (cite [B2C.4], Phase 2C) — Case B: learned features present, hand features absent; this builds the missing arm.
- **What to build:** Train the same simple classifier twice — once on `ml/features.py` hand features, once on nomic embeddings of the query — and compare accuracy and inspectability.
- **Why it earns its place:** It turns "embeddings are a learned feature extractor" from a sentence into a measured result on your corpus, with the inspectability tradeoff visible.
- **Files to touch:** `ml/features.py`, new `ml/compare_features.py`; embeddings via the existing Ollama embed path.
- **Done when:** A table prints accuracy for hand-features vs embedding-features, and you can say which won and why on this small corpus.
- **Estimated effort:** 1 day.

## Interview defense

**Q: "What's the relationship between embeddings and feature engineering?"**

Embeddings *are* feature engineering — the learned kind. A hand-engineered pipeline has a human choose transforms (scale, one-hot, tf-idf, datetime). An embedder lets gradient descent discover the transforms during its own training and emits a dense vector. buffr uses the learned kind exclusively; it hand-engineers nothing.

```
  hand: human picks transforms ─► inspectable vector
  learned: optimizer picks them ─► opaque 768-d vector (buffr)
```

Anchor: *"An embedding is a feature extractor someone else trained."*

**Q: "Why spend most of your time on features rather than model choice?"**

Because features decide whether the classes are separable at all. A simple model on good features beats a complex one on raw signal — the model only draws the boundary the features made drawable. I learned this in contrl, where joint-angle features mattered far more than the network depth.

```
  good features + simple model ─► wins
  raw signal   + complex model ─► loses
```

Most candidates have only consumed pre-trained embeddings; having hand-engineered features for a real model (contrl) means I know what the embedding is doing under the hood. That's the signal.

Anchor: *"The model draws the boundary the features made possible."*

## See also

- `./01-supervised-pipeline.md` — where Features sits in the five-stage line.
- `./03-train-val-test.md` — the leakage rule for fitting transforms (train only).
- `./04-model-selection.md` — good features make the simple model competitive.
- `../03-retrieval-and-rag/01-embeddings.md` — buffr's learned feature extractor in depth.
- `../05-evals-and-observability/` — measuring whether your features actually moved the metric.
- `../09-ml-system-design-templates/` — feature pipelines inside a full system design.
