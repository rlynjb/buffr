# Calibration — predicted probability matching observed frequency

*Industry standard (probability calibration / reliability). buffr trains no probabilistic classifier, and its cosine scores are uncalibrated similarity, not probabilities — not yet implemented.*

## Zoom out, then zoom in

Any time downstream code reads a score as if it were a probability — thresholds it, ranks on it, plugs it into an expected-value decision — you've quietly assumed the score is *calibrated*. Calibration is the property that makes that assumption safe: of everything the model stamps "0.7", about 70% are actually positive. buffr never trains a classifier, so it has no calibrated model. But it *does* produce a number that looks like a confidence — the cosine score out of pgvector — and the moment any code treats that number as a probability, calibration is the thing it's missing.

```
  Zoom out — where a "confidence" number enters buffr

  ┌─ Provider layer (Ollama, local) ───────────────────────────┐
  │  nomic-embed-text:v1.5 → 768-d embedding                    │
  └─────────────────────────┬───────────────────────────────────┘
                            │  vector
  ┌─ Storage layer (Postgres + pgvector) ───────────────────────┐
  │  agents.chunks.embedding                                     │
  │  ★ 1 - (embedding <=> $1) AS score  ← cosine similarity ★    │ ← we are here
  └─────────────────────────┬───────────────────────────────────┘
                            │  hits[].score (0..1, UNCALIBRATED)
  ┌─ Service layer (pipeline / agent) ──────────────────────────┐
  │  any code that thresholds/ranks on score   ← WOULD attach   │
  │  e.g. "if best score < 0.6 → refuse"        calibration here │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a model is **calibrated** when its predicted probability equals the empirical frequency of the event. The diagnostic is a **reliability diagram** — bucket predictions by their stated probability, plot observed frequency against stated probability, and a perfectly calibrated model lands on the diagonal. buffr's cosine score is *not* on any such diagonal, because it was never fit to one: it's a geometric similarity, not a probability. A 0.8 cosine does not mean "80% relevant." This file teaches the real mechanism, then shows the exact line in buffr where pretending otherwise bites.

## Structure pass

**Layers:** the model (or scorer) that emits a number → the number itself → the downstream code that consumes it.

**Axis — "is the number a probability you can act on, or just an ordering?"** Hold that one question down the stack.

```
  trace "can I act on this number as a probability?" across the layers

  ┌─ scorer ─────────────┐   emits a real number      (buffr: cosine, 0..1)
  │  cosine / softmax     │   "what does 0.8 mean?"
  └──────────────────────┘
  ┌─ the number ─────────┐   ordering vs probability  (buffr: ORDERING only)
  │  monotone? metric?    │   "0.8 > 0.6, but is it 80%?"  → NO
  └──────────────────────┘
  ┌─ consumer ───────────┐   what it does with it      (buffr: ranks → fine;
  │  argmax / rank / thresh│  "argmax? safe. threshold?    thresholds → BITES)
  └──────────────────────┘   needs calibration."
```

**The seam:** between *the number* and *the consumer*. If the consumer only does `argmax` or top-k ranking, calibration is irrelevant — a monotone score is enough, and cosine is monotone in relevance for a single query. The axis-answer flips the instant the consumer thresholds or does expected-value math: now it needs `score = P(relevant)`, and an uncalibrated 0..1 number silently fails the contract. That seam is exactly where a refusal threshold like `if best score < 0.6 → "not in sources"` lives. Pick the wrong side of this seam and you've hard-coded a guess onto a scale that has no fixed meaning.

## How it works

### Move 1 — the mental model

You already know the shape from a weather app. When the app says "70% chance of rain," the honest test isn't "did it rain today" — it's "across all the days it said 70%, did it rain about 70% of the time?" That's calibration: not per-prediction correctness, but *frequency matching in aggregate*. A model can be accurate and badly calibrated (right answers, wrong confidence) or calibrated and inaccurate (humble and often wrong, but honest about it). The reliability diagram is the picture that exposes the gap.

```
  Pattern — the reliability diagram (the calibration x-ray)

  observed
  frequency
   1.0 ┤                              ╱  ← perfect calibration
       │                          ╱       (diagonal: stated = observed)
   0.7 ┤- - - - - - - - - -●- ╱
       │                ╱   ↑ this model: stated 0.9, observed 0.7
   0.5 ┤            ╱      → OVERCONFIDENT (curve sags BELOW diagonal)
       │        ╱  ●
       │    ╱   ↑ stated 0.5, observed 0.4
   0.0 ┼────────────────────────────────►
       0.0      0.5      0.9     1.0
              predicted probability (bucketed)

  on the diagonal = calibrated · below = overconfident · above = underconfident
```

Read it left to right: take every prediction, drop it into a bucket by its stated probability (0.0–0.1, 0.1–0.2, …), and for each bucket plot the fraction that were actually positive. Hug the diagonal and you're calibrated. Sag below it and you're overconfident — the classic failure of modern neural nets, which push softmax outputs toward 0 and 1 far harder than the true frequencies warrant.

### Move 2 — the step-by-step walkthrough

**Why models miscalibrate.** Bridge from something you've seen: a softmax with a low temperature spikes one class to 0.99 even when the evidence is weak. Modern deep nets do this structurally — high capacity plus training to minimize log-loss drives outputs to the extremes, so a net that's 80% accurate routinely reports 99% confidence. The accuracy can be fine while the *probabilities* are fiction. That's why you measure calibration separately from accuracy.

```
  Why nets are overconfident — softmax pushed to the rails

  weak evidence ─► logits [2.1, 1.9] ─► softmax/T(low) ─► [0.98, 0.02]
                                                            ↑
                          stated 0.98, but true frequency for
                          this logit gap is more like 0.65
                          → overconfident; reliability curve sags
```

**Fix 1 — Platt scaling (fit a logistic on the scores).** You already know logistic regression. Platt scaling is *just that*, fit on top of a frozen model: take the model's raw scores `s`, and learn two scalars `A`, `B` so that `P(positive) = sigmoid(A·s + B)`. You fit `A` and `B` on a held-out calibration set by minimizing log-loss against the true labels. It's a one-dimensional logistic regression whose only input is the score. Cheap, needs little data, but it assumes the miscalibration has a sigmoid shape — it can't fix arbitrary wiggles.

```
  Platt scaling — a logistic squashes the score onto a probability

  raw score s ──► [ sigmoid(A·s + B) ] ──► calibrated P(positive)
                       ▲   ▲
                  fit A,B on held-out (score, label) pairs
                  by minimizing log-loss
                  → assumes ONE sigmoid-shaped correction
```

```
  // Platt scaling — fit, then apply
  fit_platt(scores, labels):
    A, B = 1.0, 0.0
    repeat until converged:                  // gradient descent on log-loss
      for (s, y) in zip(scores, labels):
        p = sigmoid(A*s + B)                 // current calibrated estimate
        grad_A += (p - y) * s                // logistic gradient
        grad_B += (p - y)
      A -= lr * grad_A ; B -= lr * grad_B
    return (A, B)

  calibrate(s, A, B):
    return sigmoid(A*s + B)                   // raw score → probability
```

**Fix 2 — isotonic regression (a monotone step fit).** When the miscalibration isn't sigmoid-shaped, fit a free-form *monotone non-decreasing* function instead. Isotonic regression sorts predictions by score, then fits the best step function that never goes down — implemented by pool-adjacent-violators (merge any adjacent buckets where the observed frequency would decrease, averaging them). It can model any monotone distortion, which is more flexible than Platt, but it needs more data and will overfit on a tiny calibration set.

```
  Isotonic regression — monotone step fit via pool-adjacent-violators

  sort by score →   buckets:  [.1][.3][.2][.6][.5]   ← observed freq per bucket
  enforce monotone:           [.1][ .25 ][.55]        ← merge the two violations
                                   (.3,.2)→.25  (.6,.5)→.55
  result: a non-decreasing step function  score → P(positive)
  → fits ANY monotone shape, but needs more labels than Platt
```

```
  // Isotonic — pool adjacent violators (PAV)
  fit_isotonic(scores, labels):
    pairs = sort_by_score(zip(scores, labels))      // ascending score
    blocks = [ {sum:y, n:1, lo:s, hi:s} for (s,y) in pairs ]
    repeat:
      find adjacent blocks where mean(left) > mean(right)   // a violation
      if none: break
      merge them: sum += ; n +=                              // pool → average
    return step_function(blocks)   // score range → block mean = P(positive)
```

**The part that decides whether any of this matters.** Calibration is *only* worth doing when downstream code uses the probability as a probability. If your consumer takes `argmax` (pick the top class) or ranks the top-k, calibration changes nothing — the *ordering* is untouched by a monotone transform, and both Platt and isotonic are monotone. The moment you threshold (`if p > 0.6`), compare against a fixed bar, or compute an expected value (`p · value`), you're reading the number's *magnitude*, and an uncalibrated magnitude is a guess. This is the test to apply before spending a day calibrating: does anything downstream read the magnitude?

```
  The deciding question — does the consumer read magnitude or just order?

  ┌─ argmax / top-k rank ──┐   uses ORDER only   → calibration irrelevant
  │  monotone-invariant     │   (cosine ranking is fine as-is)
  └─────────────────────────┘
  ┌─ threshold / EV math ──┐   uses MAGNITUDE    → calibration REQUIRED
  │  "p > 0.6", "p · value" │   (uncalibrated = arbitrary cutoff)
  └─────────────────────────┘
```

**Where this bites buffr.** buffr's cosine score is computed in `src/pg-vector-store.ts:70-78` as `1 - (embedding <=> $1::vector) AS score` — cosine *similarity*, a geometric quantity in 0..1, never fit to any frequency. Today buffr only *ranks* on it (the pipeline takes top-k, `K=3` in `src/cli/eval-cmd.ts:22`), so it sits on the safe side of the seam. The bug arrives the instant someone adds a **refusal threshold** — the very natural "if the best hit's score is below 0.6, answer *not in sources*." That 0.6 is an arbitrary point on an uncalibrated scale: it has no defensible meaning, it'll behave differently for short vs long queries, and it'll silently over- or under-refuse. The fix isn't a better-guessed constant; it's to calibrate the cosine→relevance mapping first, then read the threshold *off the calibrated curve*.

### Move 3 — the principle

A score is not a probability until you've proven it matches observed frequency. Ranking is free — any monotone score orders correctly — but the moment a single line of code compares that score to a fixed bar or multiplies it by a payoff, you've made a calibration claim, and an uncalibrated number turns that line into a guess wearing a decimal point.

## Primary diagram

```
  Calibration end to end — and the exact buffr line where it would attach

  ┌─ FIT (offline, needs labels) ───────────────────────────────────┐
  │  (score, is_relevant) pairs  ──►  reliability diagram            │
  │                                   │ sags below diagonal?         │
  │                                   ▼                              │
  │            Platt: sigmoid(A·s+B)   OR   isotonic: monotone steps │
  │                                   │                              │
  │                                   ▼  calibrator g(score)         │
  └───────────────────────────────────┬──────────────────────────────┘
                                      │
  ┌─ SERVE (buffr today) ─────────────▼──────────────────────────────┐
  │  pg-vector-store.ts:70  score = 1 - (embedding <=> v)            │
  │     ├─ consumer = top-k RANK  → calibration IRRELEVANT (today)   │
  │     └─ consumer = THRESHOLD   → needs P=g(score), not raw 0.6    │
  │        "if best score < 0.6 → refuse"  ← the line that bites     │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Calibration comes out of forecasting (Brier, 1950; the weather-forecast verification literature) and re-entered ML attention when Guo et al. (2017) showed modern deep nets are systematically overconfident and that a one-parameter *temperature scaling* (Platt with `B=0`, a single divisor on the logits) fixes most of it. The standard summary metric is **Expected Calibration Error (ECE)** — the average gap between bucket confidence and bucket accuracy, i.e. the area between the reliability curve and the diagonal. Calibration connects directly to the rest of this guide: it's the honest underpinning of any **refusal / abstention** behavior (`../05-evals-and-observability`), and it's the precondition for turning a retrieval score into an **expected-value decision**. In a retrieval system specifically, the cleaner framing is often to skip calibrating the raw cosine and instead train a small **reranker** (`../03-retrieval-and-rag/07-reranking.md`) that outputs an actual relevance probability — a learned calibrator with features, not just the bare score. buffr has neither today; the data to fit one (query, retrieved chunk, was-it-relevant) would come from labeling against `eval/queries.json`.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Calibrate the cosine→relevance mapping

- **Exercise ID:** CAL-1 (Case B — no calibrator exists; cosine is raw similarity). **The foundational calibration exercise.**
- **What to build:** an offline script that pulls cosine scores for every (query, retrieved-chunk) pair across `eval/queries.json`, labels each pair relevant / not-relevant (the `relevant` field gives you the ground truth), then fits **isotonic regression** mapping `cosine_score → P(relevant)`. Emit the reliability diagram (bucketed observed frequency vs cosine) so the miscalibration is visible.
- **Why it earns its place:** it proves the cosine is *not* a probability and produces the one artifact — a calibrated curve — that every threshold or expected-value decision downstream needs. The "I showed our 0.8 cosine was actually ~50% relevant" story.
- **Files to touch:** new `eval/calibrate.ts` (mirror the setup in `src/cli/eval-cmd.ts:13-16` for pool/embedder/store); read scores via `PgVectorStore.search` in `src/pg-vector-store.ts:67`; `eval/queries.json` for labels.
- **Done when:** the script prints a reliability table (cosine bucket → observed relevance frequency) and writes the fitted isotonic mapping to disk.
- **Estimated effort:** 1–2 days (labeling the pairs is most of it on 3 queries; widen the query set first).

### Derive the refusal threshold from the calibrated curve

- **Exercise ID:** CAL-2 (Case B — no refusal logic exists; depends on CAL-1).
- **What to build:** instead of a guessed `if best_score < 0.6 → refuse`, use CAL-1's calibrator to pick the *cosine value* at which `P(relevant)` crosses a chosen target (say 0.5), and refuse below that. Document the cosine cutoff as a derived quantity, not a magic constant.
- **Why it earns its place:** turns an arbitrary number into a defensible decision boundary tied to an actual relevance probability — exactly the seam where uncalibrated scores bite.
- **Files to touch:** wherever the refusal check would live in the agent/pipeline path (none exists yet — add it at the consumer of `search()` results); read the calibrator from CAL-1.
- **Done when:** the refusal cutoff is computed from `P(relevant)=target` via the calibrated curve, and changing the target moves the cosine cutoff automatically.
- **Estimated effort:** 4–8 hr (assuming CAL-1 done).

## Interview defense

**Q: buffr's retrieval returns a cosine score in 0..1. Is that a probability? When does it matter?**
Answer: no — it's `1 - (embedding <=> v)` in `src/pg-vector-store.ts:70`, a geometric cosine similarity, never fit to any frequency, so 0.8 doesn't mean "80% relevant." It only matters when downstream code reads the *magnitude*. Today buffr just ranks top-k, so the ordering is all that's used and calibration is irrelevant. The day someone adds a refusal threshold — `if best score < 0.6` — that 0.6 is an arbitrary point on an uncalibrated scale, and now it matters: I'd fit isotonic against labeled relevance and read the cutoff off the calibrated curve.

```
  rank on cosine → fine (order-invariant) · threshold on cosine → needs calibration
```

**Q: Platt vs isotonic — pick one for a small calibration set, and why?**
Answer: Platt scaling — it's a one-parameter (or two-parameter) logistic, `sigmoid(A·s+B)`, so it needs very little data and won't overfit. Isotonic fits a free-form monotone step function, which models any distortion but needs far more labeled points; on buffr's tiny eval set it'd overfit badly. **The part people forget: both are monotone, so neither changes your ranking — they only change the magnitudes. If all you do is argmax or top-k, you don't need either.**

```
  Platt: sigmoid(A·s+B), few params, low data  ·  isotonic: monotone steps, flexible, data-hungry
```

## See also

- `08-confusion-matrices.md` — the other place a threshold turns scores into decisions; calibration is what makes that threshold meaningful.
- `10-recommender-systems.md` — content-based recsys ranks on the same cosine; ranking is order-invariant, so it dodges calibration the way buffr does today.
- `04-model-selection.md` — log-loss / Brier as the metrics that reward calibration, not just accuracy.
- `../03-retrieval-and-rag/07-reranking.md` — a learned reranker is a calibrator with features; the cleaner fix than scaling raw cosine.
- `../05-evals-and-observability/01-eval-set-types.md` — the labeled set you'd fit and validate a calibrator against.
