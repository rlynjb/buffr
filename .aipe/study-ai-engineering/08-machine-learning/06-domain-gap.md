# Domain gap — train-serve distribution shift

*Industry standard (covariate / distribution shift). buffr trains nothing, so it has no train-serve gap of its own — Not yet implemented. (One real nuance below: nomic-embed-text was pretrained off-domain from buffr's personal markdown.)*

## Zoom out, then zoom in

Every trained model carries a hidden assumption: that the data it sees at serving time looks like the data it learned from. When that assumption breaks — the inputs drift away from the training distribution — the model doesn't error out. It stays confident and goes quietly wrong. buffr trains no model, so it owns no train-serve gap. But it *consumes* a pretrained embedder (`nomic-embed-text:v1.5`) that learned on a broad general corpus and is now asked to embed your personal markdown — a mild, real domain gap between the encoder's home turf and buffr's content.

```
  Zoom out — where a domain gap WOULD live (and the one mild real one)

  ┌─ Encoder (pretrained, off-domain) ──────────────────────────┐
  │  nomic-embed-text:v1.5 — trained on a GENERAL web corpus    │
  │  ★ mild real domain gap ★ vs buffr's personal markdown      │ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
                                  │ embeds buffr's content
  ┌─ Vector store (exists) ──────▼──────────────────────────────┐
  │  agents.chunks.embedding vector(768) · cosine search        │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ a FUTURE trained model would face ↓
  ┌─ ML layer (no model — WOULD attach) ─▼──────────────────────┐
  │  any classifier trained on yesterday's runs, served today   │
  │  → covariate / label / concept shift bites here             │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a **domain gap** (train-serve distribution shift) is the mismatch between the distribution a model was trained on and the distribution it actually sees in production. The dangerous part isn't that the model is wrong — it's that it's *confidently* wrong off-distribution, because nothing in its training taught it to be uncertain about inputs it never saw. This file names the three kinds of shift, shows why confidence and correctness decouple off-domain, and points at the fixes that close the gap.

## Structure pass

**Layers:** the training distribution → the model's learned decision surface → the serving distribution it's actually fed.

**Axis — "does this layer assume train and serve look the same?"**

```
  trace "is the same-distribution assumption holding?" down the layers

  ┌─ training distribution ─┐   defines what "normal" means
  │  P_train(x)             │   the model's entire worldview
  └─────────────────────────┘
  ┌─ decision surface ──────┐   ASSUMES serve looks like train
  │  learned boundary       │   confident everywhere, even off-domain
  └─────────────────────────┘
  ┌─ serving distribution ──┐   may have DRIFTED — P_serve ≠ P_train
  │  P_serve(x)             │   model still confident → quietly wrong
  └─────────────────────────┘

  the assumption is invisible until the serving distribution moves
```

**The seam:** the boundary between *training* and *serving* is where the axis flips — on the training side the same-distribution assumption is trivially true; on the serving side it can silently become false. That seam carries no exception, no log line, no alert. It's the most dangerous kind of boundary precisely because crossing it wrong produces a confident answer, not a crash. (Drift detection, `15-drift-detection.md`, is the instrument you bolt onto this seam.)

## How it works

### Move 1 — the mental model

You know this from a regex you wrote against last month's log format. It worked perfectly — until the upstream service changed its timestamp format and your regex started silently matching the wrong field, returning plausible garbage with no error. A model off-distribution behaves exactly like that regex: the *shape* of the input changed, the model has no idea, and it keeps producing confident output against inputs it was never built for. The strategy is to either make serving look like training (normalize inputs) or make training cover serving (augment, collect in-domain data).

```
  the pattern — two distributions drifting apart

  P_train(x)                 P_serve(x)  (later)
     ╱╲                          ╱╲
    ╱  ╲                        ╱  ╲
   ╱    ╲                      ╱    ╲
  ╱  ●●  ╲                    ╱      ╲  ●●  ← serving mass moved
 ─┴──────┴──────────────────┴────────┴──────── feature axis
        ▲                           ▲
   model trained here          model SERVED here
   (confident & right)         (confident & WRONG — same surface)
```

### Move 2 — the step-by-step walkthrough

**The three shifts — name which one moved.** "Distribution shift" is three distinct failures wearing one coat. You diagnose the gap by asking *what* moved: the inputs, the label balance, or the relationship between them.

```
  three shifts — what moved between train and serve

  ┌─ covariate shift ───────────────────────────────────────────┐
  │  P(x) changed, P(y|x) same                                  │
  │  inputs look different; the rule still holds                │
  │  e.g. new users write longer notes than training notes      │
  └──────────────────────────────────────────────────────────────┘
  ┌─ label shift ───────────────────────────────────────────────┐
  │  P(y) changed, P(x|y) same                                  │
  │  the class balance moved (failures got rarer/commoner)      │
  └──────────────────────────────────────────────────────────────┘
  ┌─ concept shift ─────────────────────────────────────────────┐
  │  P(y|x) changed — the RULE ITSELF moved                     │
  │  the same input now means a different outcome (worst case)  │
  └──────────────────────────────────────────────────────────────┘
```

Covariate shift is the common one and the focus here: the inputs drift but the underlying rule is intact. Label shift is the class-balance moving (it links straight to imbalance, `05-class-imbalance.md`). Concept shift is the nasty one — the world changed its mind about what an input means, and no amount of input normalization saves you; you have to relearn.

**Why confidence and correctness decouple off-domain.** A trained model partitions feature space into regions and assigns a confident label to each. Inside the training cloud, that confidence is earned — it saw examples there. *Outside* the cloud, the decision surface still extends (the model has to answer *something*), but there's no data backing it. So the model reports high confidence in a region it never learned. This is the single most important fact about domain gap: **off-distribution, confidence stops being evidence.**

```
  confidence ≠ correctness off-domain

  feature space:

   ┌──────── training cloud (data-backed) ────────┐
   │   ● ● ●   region A    │   region B   ● ● ●    │
   │   ● ● ●  (confident,   │  (confident, ● ● ●    │
   │           CORRECT)     │   CORRECT)            │
   └───────────────────────┼───────────────────────┘
                           │
        decision surface extends OUT here ↓ (NO data)
        ✦ new serving point lands here →  confident, label = A
          but nothing was ever learned about this region → WRONG
```

In pseudocode, the gap is something you can *detect* without labels, by watching the inputs alone:

```
  // INPUT: training feature stats (mean, std per feature) saved at train time
  //        live serving feature vector x
  for each feature f:
    z[f] = (x[f] - train_mean[f]) / train_std[f]   // how many train-stds out?
  drift_score = mean(abs(z[f]) for all f)           // big = far off-domain
  if drift_score > threshold:
    flag("off-distribution input — model confidence is NOT evidence here")
  // OUTPUT: a warning BEFORE you trust the prediction
  // note: this needs no labels — it watches P(x), so it catches covariate shift
```

**The fixes — close the gap from one side or the other.** You can move serving toward training, or move training toward serving. Four tools, two directions.

```
  four fixes, by which distribution they move

  ┌─ make SERVING look like TRAINING ───────────────────────────┐
  │  input normalization — scale serving inputs to TRAIN's      │
  │    mean/std (reuse train stats, never recompute on serve)   │
  │  domain adaptation   — fine-tune/align the model toward the │
  │    target domain (the embedder rhyme below)                 │
  └──────────────────────────────────────────────────────────────┘
  ┌─ make TRAINING cover SERVING ───────────────────────────────┐
  │  data augmentation   — widen P_train: typos, paraphrases,   │
  │    crops, noise → the model sees the variety up front       │
  │  collect in-domain   — gather real serving-domain data and  │
  │    retrain on it (the durable fix; ties to 16-retraining)   │
  └──────────────────────────────────────────────────────────────┘
```

*Input normalization* is the cheap, load-bearing one: you save the training feature statistics and apply them to serving inputs — and the classic bug is recomputing stats on the serving batch instead of reusing the training ones, which *hides* the very gap you're trying to expose. *Domain adaptation* nudges the model itself toward the target domain. *Augmentation* widens the training distribution so serving variety falls inside it. *Collecting in-domain data* is the durable fix and the most expensive: get real examples from the serving domain and retrain.

**The buffr nuance — the embedder's mild, real domain gap.** Here's the one honest connection. `nomic-embed-text:v1.5` was pretrained on a broad general corpus (web text, generic documents). buffr asks it to embed *your* personal markdown — your notes, your stack, how you take your coffee. The encoder's training domain and buffr's content domain don't perfectly overlap, so the embeddings are slightly less discriminative for buffr's idioms than an in-domain embedder would be. This is mild — nomic generalizes well, and cosine retrieval still works (the 3-row eval passes) — but it's a *real* domain gap, and a fine-tuned or in-domain embedder would close it. Don't overstate it: nothing is broken, the gap is a quality ceiling, not a failure.

```
  the buffr embedder gap — mild and real (not a failure)

  ┌─ nomic-embed-text training domain ──┐   broad general web text
  │  generic prose, docs, Q&A           │
  └──────────────────┬───────────────────┘
        partial overlap ▽ (gap = the non-overlap)
  ┌─ buffr's content domain ────────────┐   personal markdown, your idioms
  │  your notes / stack / coffee.md     │   → agents.chunks.embedding vector(768)
  └──────────────────────────────────────┘
        an in-domain embedder would shrink the gap → better separation
```

### Move 3 — the principle

A model's competence is bounded by its training distribution, and the boundary is invisible from the inside. The failure mode that costs the most isn't a model that's wrong — it's a model that's *confidently* wrong on inputs it never saw, because off-distribution, confidence is no longer evidence. The discipline is to watch the inputs, not just the outputs: distribution shift is detectable on `P(x)` alone, before a single label arrives. buffr's only real instance is the gentle embedder gap, and it's the right size to teach with — real enough to matter, mild enough not to be alarming.

## Primary diagram

```
  Domain gap — the assumption, the three shifts, the fixes (full recap)

  ┌─ TRAINING distribution P_train(x) ──────────────────────────┐
  │  nomic-embed-text's general corpus · or yesterday's runs    │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ model assumes serve == train
  ┌─ DECISION SURFACE ───────────▼──────────────────────────────┐
  │  confident everywhere — even where it has NO data           │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ but serving drifts ↓
  ┌─ SERVING distribution P_serve(x) ───────────────────────────┐
  │  three shifts: covariate P(x) · label P(y) · concept P(y|x) │
  │  off-domain points → confident & WRONG (no error thrown)    │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ close the gap ↓
  ┌─ FIXES ──────────────────────▼──────────────────────────────┐
  │  serve→train: input normalization · domain adaptation       │
  │  train→serve: augmentation · collect in-domain + retrain    │
  │  detect: z-score on P(x), no labels needed (→ 15-drift)     │
  │  buffr's real one: nomic's general domain vs your markdown  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Distribution shift is one of the oldest problems in applied ML and one of the least respected — models are validated on held-out data drawn from the *same* distribution as training, which by construction can't reveal a serving gap. The taxonomy (covariate / label / concept shift) comes from the dataset-shift literature (Quiñonero-Candela et al., 2009); the key insight is that they demand different fixes, so naming which one moved is half the work. Covariate shift is correctable by reweighting or normalization; concept shift requires relearning because the target function itself moved. Domain adaptation grew into its own subfield — unsupervised domain adaptation, adversarial feature alignment — driven by exactly buffr's situation: a model pretrained on a big general domain, applied to a narrow target domain with little labeled data (which is also the bridge to transfer learning, `07-transfer-learning.md`: fine-tuning *is* domain adaptation). The detection side connects to drift (`15-drift-detection.md`): PSI over feature distributions is the productionized version of the z-score check above. This rhymes with your contrl pose pipeline — MediaPipe was trained on a broad population of bodies and lighting; point it at a dark room or an unusual camera angle and the landmarks degrade confidently, the same off-distribution failure in a different medium.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Quantify the embedding-space coverage of buffr's corpus vs generic queries

- **Exercise ID:** GAP-1 (Case B — no trained model; measures the real embedder gap). **The "show me the gap is real" exercise.**
- **What to build:** a script that embeds buffr's corpus chunks and a set of *generic* queries (off-domain web-style questions), then compares the cosine-similarity distributions — in-domain query→chunk scores versus generic query→chunk scores. Report whether buffr's personal-markdown chunks cluster tightly (in-domain separation good) and how far generic content sits from that cluster.
- **Why it earns its place:** it turns the "mild domain gap" claim from a sentence into a measured distribution. You see, on buffr's own vectors, how the general-corpus encoder represents your content versus generic content — the honest, non-overstated version of the gap.
- **Files to touch:** new `scripts/embedding-coverage.ts`; read embeddings via the cosine search in `src/pg-vector-store.ts` (`1 - (embedding <=> $1::vector) as score`); embed queries with the same `OllamaEmbeddingProvider` setup as `src/cli/eval-cmd.ts`.
- **Done when:** the script prints the in-domain vs generic similarity distributions and a one-line read on how distinct buffr's content cluster is.
- **Estimated effort:** 1 day.

### Augment eval/queries.json with paraphrase and typo variants to expose brittleness

- **Exercise ID:** GAP-2 (Case B — widens the eval distribution).
- **What to build:** generate paraphrase and typo variants of the 3 existing `eval/queries.json` rows (e.g. "what does the author do for work" → "where does the writer work?", "what does teh author do for work"), keep the same relevant-doc labels, and run them through the eval harness. Measure how much P@1/R@3 degrades on the perturbed variants versus the clean originals.
- **Why it earns its place:** augmentation is the train→serve fix you *can* afford with no model — and applying it to the eval set widens the test distribution and exposes whether the embedder is brittle to surface variation (the covariate-shift signature). It's GAP-1's claim made actionable in the existing harness.
- **Files to touch:** new `eval/queries-augmented.json`; a small variant of `src/cli/eval-cmd.ts` that loads it; reuse the existing `scorePrecisionAtK`/`scoreRecallAtK` scorers.
- **Done when:** the run reports clean vs augmented P@1/R@3 and you can point to which paraphrase/typo variants drop retrieval.
- **Estimated effort:** 1 day.

## Interview defense

**Q: Your model passes validation but fails in production. First hypothesis?**
Answer: domain gap. Validation is drawn from the training distribution, so it structurally can't catch a serving-distribution shift. My first move is to check `P(x)` — compare serving input statistics to the training stats I saved, no labels needed. If the inputs drifted, the model is off-distribution and its confidence stopped being evidence; I'd then ask which shift moved — covariate, label, or concept — because each needs a different fix.

```
  passes val, fails prod  ──►  compare P_serve(x) to P_train(x)
                               drifted? → off-domain → confident-wrong
```

**Q: What's the most dangerous property of an off-distribution input?**
Answer: the model stays confident. It partitions feature space and the decision surface extends into regions it never saw data for, so it returns a high-confidence label with nothing backing it — no error, no low-confidence flag, just plausible garbage. **The part people forget: distribution shift throws no exception. You only catch it by monitoring the input distribution, because the output looks fine right up until it isn't.**

```
  off-domain point → confident label, ZERO data behind it → silent wrong
                     └─ catch it on P(x), never on the output alone
```

## See also

- `15-drift-detection.md` — PSI over feature distributions is the productionized version of the gap-detection check here.
- `07-transfer-learning.md` — fine-tuning is domain adaptation; the embedder gap closes by adapting to buffr's domain.
- `05-class-imbalance.md` — label shift is a distribution shift in `P(y)`; the two files overlap there.
- `16-retraining-pipelines.md` — collecting in-domain data and retraining is the durable gap fix.
- `../05-evals-and-observability/04-llm-observability.md` — the trajectory trace where serving-distribution signals would live.
