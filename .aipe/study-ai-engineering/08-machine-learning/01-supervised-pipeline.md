# The supervised ML pipeline — Data → Features → Split → Train → Deploy

*Industry standard (the classical supervised-learning lifecycle). buffr trains no supervised model — it's a pure LLM app consuming pre-trained Ollama models. Not yet implemented.*

## Zoom out, then zoom in

Every classical ML system that learns from labeled examples is the same five-stage assembly line, and this file is the spine the rest of `08-machine-learning/` hangs off — features, splits, selection, drift all live inside one of these five boxes. buffr has none of them, so the diagram below marks where each stage *would* attach if buffr ever trained a model on the one labelable signal it owns: its conversation trajectories.

```
  Zoom out — where a supervised pipeline would sit in buffr (it doesn't, today)

  ┌─ Provider layer (Ollama, pre-trained) ───────────────────────┐
  │  gemma2:9b (generation) · nomic-embed-text:v1.5 (embeddings)  │
  │  buffr CONSUMES these — never trains them                     │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ produces signal buffr stores
  ┌─ Storage layer (Supabase) ───▼────────────────────────────────┐
  │  agents.messages  ← full trajectory of every run (the corpus) │
  │  agents.chunks.embedding ← vector(768) per chunk              │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ a supervised pipeline WOULD attach here
  ┌─ ML layer — ★ NOT PRESENT ★ ─▼────────────────────────────────┐ ← we are here
  │  DATA → FEATURES → SPLIT → TRAIN → DEPLOY                      │
  │  (no labeled set · no features · no split · no model)         │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a **supervised pipeline** is the path a labeled dataset walks to become a deployed predictor — five stages, each owning exactly one promise. **Data** owns label correctness and coverage. **Features** own representation. **Split** owns honest measurement. **Train** owns the model. **Deploy** owns inference parity. buffr stops at "Storage" — it has signal, no pipeline. You've actually built this shape once (the contrl pose pipeline: pose signal → landmark features → on-device rep decision), so the skeleton isn't foreign; what's new ground is owning each stage's contract deliberately.

## Structure pass

**Layers:** the five pipeline stages, stacked Data (bottom, closest to truth) → Deploy (top, closest to the user).

**Axis — "who owns correctness at this stage, and what breaks if they're wrong?"** Trace that one question up the stack and the stages stop looking interchangeable.

```
  trace "what does this stage OWN — and what breaks if it's wrong?"

  ┌─ DATA ──────────┐  owns: label correctness + coverage
  │  labeled rows   │  breaks: wrong labels → model learns the wrong thing
  └────────┬────────┘           (no model choice survives this)
  ┌─ FEATURES ──────┐  owns: representation
  │  signal→vector  │  breaks: leaky feature → fake accuracy, real failure
  └────────┬────────┘
  ┌─ SPLIT ─────────┐  owns: honest measurement
  │  train/val/test │  breaks: leakage → numbers lie, prod underperforms
  └────────┬────────┘
  ┌─ TRAIN ─────────┐  owns: the fitted model
  │  fit on train   │  breaks: wrong model/overfit → underperforms (recoverable)
  └────────┬────────┘
  ┌─ DEPLOY ────────┐  owns: inference parity
  │  serve preds    │  breaks: train≠serve features → silent prod regression
  └─────────────────┘

  same pipeline; each stage owns a DIFFERENT correctness promise
```

**The seam that matters most:** the boundary between **Data/Features** and everything above. The axis-answer flips hard here — below the seam you're responsible for *truth* (are the labels right? is the feature honest?); above it you're responsible for *fit* (did the model learn well?). The load-bearing line of this whole section lives at that seam: **most AI bugs in classical ML are data/feature bugs, not model bugs.** A perfect model trained on garbage labels is garbage; a leaky feature gives you 0.99 AUC in the notebook and a faceplant in prod. You can swap models in an afternoon; you can't out-model a broken label set.

## How it works

### Move 1 — the mental model

You already know this shape as a build pipeline. Source code → bundle → minify → test → ship. Each stage transforms the artifact and hands it forward; a defect introduced early (a bad import) survives every later stage and only surfaces in prod. A supervised pipeline is that exact conveyor belt, except the artifact is *a dataset becoming a predictor*, and the early-stage defects are bad labels and leaky features — invisible until deploy.

```
  PATTERN — the five-stage conveyor (defects flow downhill)

  raw world          known answers        honest yardstick
     │                    │                     │
     ▼                    ▼                     ▼
  ┌──────┐   ┌──────────┐   ┌───────┐   ┌───────┐   ┌────────┐
  │ DATA │──►│ FEATURES │──►│ SPLIT │──►│ TRAIN │──►│ DEPLOY │──► predictions
  └──────┘   └──────────┘   └───────┘   └───────┘   └────────┘
   labels      represent       fit/test     learn       serve
   + coverage   the signal      cleanly      model       SAME features

  a bad label here ─────────────────────────────────────► fails here
  (defect introduced early survives every downstream stage)
```

The whole discipline is: stop defects at the stage that owns them, because no later stage can fix them.

### Move 2 — the step-by-step walkthrough

We walk the five stages bottom-up, one per sub-heading. For each, the question is the same: *what does this stage own, and what breaks if it's wrong?*

**Stage 1 — DATA owns label correctness and coverage.** This is the stage that decides whether the model can succeed at all. You need labeled examples — rows where you know the answer — and they have to be *correct* (the label matches reality) and *cover* the input distribution you'll actually see at inference. Get either wrong and nothing downstream recovers.

```
  DATA stage — labeled rows, correct + covering

  example (label)        is the label right?   covered at inference?
  ─────────────────      ──────────────────     ────────────────────
  trajectory_1 → "good"        ✓                     ✓
  trajectory_2 → "good"        ✗ actually bad   ← poisons training
  trajectory_3 → "bad"         ✓                     ✓
  (rare: tool-error run)    no example           ← coverage gap: model
                                                    never learns this case
```

Here's the buffr-specific truth: **buffr has no labeled set.** The closest thing is `eval/queries.json` — but that's three rows of *query → relevant-doc* for an information-retrieval eval, not a training set, and it labels relevance, not a target class. The *labelable* signal buffr owns is `agents.messages`: every conversation's full trajectory, persisted by `src/supabase-trace-sink.ts`. A row there carries `role`, `content`, `tool_calls`, `tool_results`, `model`, `tokens_used`, `created_at`. None of it is labeled "good answer / bad answer" yet — but it's the only data in the repo you *could* attach labels to. The DATA stage for buffr is "go label trajectories."

**Stage 2 — FEATURES own representation.** A model can't eat a raw conversation; it eats a fixed-width numeric vector. The FEATURES stage turns each labeled example into that vector — turn count, tool-call count, total tokens, error flags. Owning representation means owning *what the model is even allowed to notice*. (Full treatment in `02-feature-engineering.md`.)

```
  FEATURES stage — raw trajectory → fixed-width vector

  agents.messages rows (one conversation)        feature vector
  ─────────────────────────────────────          ─────────────────
  role/content × N turns                    ───►  [ turns=6,
  tool_calls (2 search calls)               ───►    tool_calls=2,
  tokens_used summed                        ───►    tokens=1840,
  error event present?                      ───►    had_error=0,
  durationMs from tool_results              ───►    dur_ms=920 ]
                                                    (the model sees ONLY this)
```

The boundary condition: a **leaky** feature — one that secretly encodes the label — gives spectacular training scores and useless predictions. If you accidentally include "did this run get flagged by a human" as a feature for predicting "is this run good," you've leaked the answer.

**Stage 3 — SPLIT owns honest measurement.** Before you fit anything, you carve the labeled data into train / validation / test. Train teaches the model, validation tunes it, test gives the one honest number you trust. Owning honest measurement means owning the *unit* you split on — and getting that wrong (rows from the same conversation in both train and test) leaks context and inflates every number. (Full treatment in `03-train-val-test.md`.)

```
  SPLIT stage — carve labeled data, no row crosses sets

  all labeled trajectories
        │ split BY conversation_id (the unit seen as NEW at inference)
        ▼
  ┌─ train (70%) ─┐  ┌─ val (15%) ─┐  ┌─ test (15%) ─┐
  │  fit model    │  │  tune/select │  │  final number │
  └───────────────┘  └──────────────┘  └───────────────┘
   never touch test until the very end ──────────┘
```

**Stage 4 — TRAIN owns the model.** Now you fit. Pick a model family (logistic regression, gradient-boosted trees — `04-model-selection.md`), fit it on the train split, tune on val. This is the stage everyone *thinks* is the whole job; it's the recoverable one. A wrong model choice or an overfit underperforms, and you fix it by trying another — in an afternoon.

```
  TRAIN stage — fit on train, tune on val, NEVER on test

  train split ──► fit model parameters
  val split   ──► measure → adjust (depth, regularization, threshold)
                  repeat until val stops improving
  test split  ──► (sealed — not touched here)
```

**Stage 5 — DEPLOY owns inference parity.** The model now scores live inputs. The promise it owns is *parity*: the features computed at serve time must be computed *identically* to training time. Break parity — train on "tokens summed correctly," serve on "tokens off by one because a different code path computes them" — and you get a silent regression no metric in the notebook predicted.

```
  DEPLOY stage — the train/serve parity contract

  TRAIN-time features  ═══ must equal ═══  SERVE-time features
  ┌──────────────────┐                   ┌──────────────────┐
  │ turns, tool_calls │   same code,      │ turns, tool_calls │
  │ tokens, had_error │ ◄═══ same units ══►│ tokens, had_error │
  └──────────────────┘                   └──────────────────┘
        if these diverge → "training/serving skew" → silent prod failure
```

The standard fix is one feature-computation function called by *both* the training job and the serving path — no second implementation to drift.

### Move 3 — the principle

The pipeline is five stages, but the correctness budget isn't spread evenly across them. **Data and features sit at the bottom and own truth; everything above owns fit.** Defects flow downhill and no upstream stage can repair a downstream one, so a bad label or a leaky feature costs you the entire pipeline while a bad model costs you an afternoon. That's why "most classical-ML bugs are data/feature bugs" isn't a slogan — it's a direct consequence of the conveyor's geometry. Spend your attention at the bottom of the stack.

## Primary diagram

The whole pipeline, every stage's owned-promise and failure mode labelled, with buffr's reality marked at each.

```
  The supervised pipeline — stages, ownership, buffr's reality

  Provider (Ollama, pre-trained)   gemma2:9b · nomic-embed-text:v1.5
        │ produces signal
        ▼
  ┌─ DATA ───────────┐ owns: label correctness + coverage
  │ labeled examples │ breaks: wrong labels → unrecoverable
  │ buffr: NONE      │ (eval/queries.json = IR eval, not labels;
  └────────┬─────────┘  agents.messages = labelable, unlabeled)
  ┌─ FEATURES ───────┐ owns: representation
  │ signal → vector  │ breaks: leaky feature → fake accuracy
  │ buffr: NONE      │ (nomic-embed gives features for free — see 02)
  └────────┬─────────┘
  ┌─ SPLIT ──────────┐ owns: honest measurement
  │ train/val/test   │ breaks: leakage → numbers lie
  │ buffr: NONE      │ (natural unit = conversation_id — see 03)
  └────────┬─────────┘
  ┌─ TRAIN ──────────┐ owns: the model (recoverable)
  │ fit + tune       │ breaks: overfit/wrong family → underperform
  │ buffr: NONE      │ (cosine ranker is the de-facto baseline — see 04)
  └────────┬─────────┘
  ┌─ DEPLOY ─────────┐ owns: inference parity
  │ serve predictions│ breaks: train≠serve features → silent regression
  │ buffr: NONE      │
  └──────────────────┘

  ★ buffr stops at Storage: it has signal, not a pipeline ★
```

## Elaborate

This five-stage shape is the backbone of essentially every applied-ML course and production ML platform (it's what tools like scikit-learn pipelines, TFX, and Vertex/SageMaker pipelines formalize). The framing that "data and features dominate" is the empirical heart of the field — it's why "data-centric AI" became a named movement: holding the model fixed and improving labels routinely beats holding labels fixed and chasing models. The contrl pose pipeline you built was a real instance of this conveyor (pose landmarks were the features, the rep-count threshold was a trivial "model," and the camera frame was the live deploy input) — so you've felt the train/serve parity problem before, even if you didn't name it. Where this section goes next: `02` opens the FEATURES box, `03` opens SPLIT, `04` opens TRAIN, and the later files (`14`–`16`) cover what DEPLOY needs to stay honest over time — run-logging, drift, retraining. Read them as zoom-ins on the boxes above.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Build a tiny "is-this-answer-grounded" classification pipeline over trajectories

- **Exercise ID:** PIPE-1 (Case B — supervised pipeline not yet implemented). **The spine exercise: it instantiates all five stages on real buffr data.**
- **What to build:** a minimal end-to-end supervised pipeline that classifies a conversation as *grounded* (answer supported by retrieved chunks) vs *ungrounded*. DATA: label ~50 trajectories by hand. FEATURES: extract turn/tool/token/error features (see FEAT-1). SPLIT: by `conversation_id`. TRAIN: a logistic-regression baseline. DEPLOY: a scorer that runs the same feature function live.
- **Why it earns its place:** it forces you to *own each stage's promise* on the only labelable data buffr has — and surfaces immediately that the hard part is labels, not the model. The "I stood up a real supervised pipeline on my agent's own trajectories" story.
- **Files to touch:** read trajectories from `agents.messages` (via the schema written by `src/supabase-trace-sink.ts`); put the pipeline + scorer alongside `src/cli/eval-cmd.ts` as a sibling CLI command; a new `eval/labels.json` for the hand labels.
- **Done when:** the pipeline runs end-to-end, reports a test-set accuracy, and the *same* feature function is provably called by both train and serve paths (no second implementation).
- **Estimated effort:** 2–3 days.

### Stand up eval-cmd.ts as the reusable "measurement stage" for a future classifier

- **Exercise ID:** PIPE-2 (Case B — measurement stage not generalized). 
- **What to build:** refactor the scoring core of `src/cli/eval-cmd.ts` (currently P@1/R@3 over `eval/queries.json`) into a reusable measurement harness that any model — the IR ranker *or* a future trajectory classifier — can be scored through, with the metric pluggable.
- **Why it earns its place:** the SPLIT/measurement stage is where honesty lives; making it reusable means every future model in buffr gets measured the same disciplined way instead of ad-hoc. It's the cheapest way to make the pipeline's most-skipped stage real.
- **Files to touch:** `src/cli/eval-cmd.ts` (extract the scoring loop); `eval/queries.json` (stays the IR set); new caller for the classifier from PIPE-1.
- **Done when:** the same harness scores both the cosine retrieval ranker and a stub classifier, switching only the metric and the dataset.
- **Estimated effort:** 4–8hr.

## Interview defense

**Q: Walk me through a supervised pipeline and tell me which stage you'd worry about most.**
Answer: five stages — Data → Features → Split → Train → Deploy — and each owns one promise: data owns label correctness and coverage, features own representation, split owns honest measurement, train owns the model, deploy owns inference parity. I worry most about the bottom: data and features. Defects flow downhill and nothing upstream can fix a downstream one, so a bad label or a leaky feature costs me the whole pipeline while a bad model costs me an afternoon. Most classical-ML bugs are data/feature bugs, not model bugs.

```
  DATA → FEATURES → SPLIT → TRAIN → DEPLOY
  └── own TRUTH ──┘   └──────── own FIT ────────┘
   (unrecoverable)        (recoverable)
```

**Q: buffr trains no model — so where would a pipeline even attach?**
Answer: at `agents.messages`. The trace sink (`src/supabase-trace-sink.ts`) persists every conversation's full trajectory — all six event types, with `tokens_used`, tool calls, errors. That's the only labelable signal in the repo. `eval/queries.json` looks like a dataset but it's a 3-row IR eval, not a training set. **The part people forget: having data isn't having a pipeline — you still owe every one of the five stages, and the unlabeled trajectory corpus means the DATA stage (labeling) is the unbuilt long pole, not the model.**

```
  agents.messages (signal exists) ─► label it ─► then the other 4 stages
  eval/queries.json ─► NOT a training set (IR eval, 3 rows)
```

## See also

- `02-feature-engineering.md` — opens the FEATURES box: raw trajectory → engineered vector.
- `03-train-val-test.md` — opens the SPLIT box: split by `conversation_id`, leakage discipline.
- `04-model-selection.md` — opens the TRAIN box: logistic regression vs gradient-boosted trees.
- `../05-evals-and-observability/01-eval-set-types.md` — golden/adversarial/regression sets feed the DATA stage.
- `../05-evals-and-observability/04-llm-observability.md` — the trajectory trace that is the labelable corpus.
