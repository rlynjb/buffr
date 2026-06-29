# Drift detection — catching when production stops matching training

*Data / feature drift detection (PSI — Population Stability Index). Industry standard. buffr monitors no drift — not yet implemented — but the data to compute PSI (embedding and trace-metric distributions) already exists.*

## Zoom out, then zoom in

A model is trained on one distribution and then meets production traffic that slowly stops looking like it. Nothing throws an error — the inputs just drift, the model's assumptions quietly expire, and accuracy bleeds away with no exception to catch. Drift detection is the smoke alarm: it compares "what the world looked like at training time" against "what it looks like now" and fires before the model rots. buffr runs no such alarm, but it sits on two distributions you *could* watch.

```
  Zoom out — where drift detection would sit in buffr

  ┌─ Ingest / retrieval layer ──────────────────────────────────┐
  │  nomic-embed-text → agents.chunks.embedding (vector 768)    │
  │  pg-vector-store search → cosine score distribution         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  produces distributions over time
  ┌─ Monitoring layer ────────────▼──────────────────────────────┐
  │  ★ DRIFT DETECTION (PSI) ★   compare train-window vs now     │ ← we are here
  │  NOT IMPLEMENTED — no job computes PSI on any buffr signal   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  PSI threshold → flag
  ┌─ Action layer ────────────────▼──────────────────────────────┐
  │  alert / investigate / retrain  (ties to 16-retraining)     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **PSI (Population Stability Index)** is the standard scalar for "how far has this distribution moved." You bin a feature at training time and in production, then sum a per-bin term that's large when the bins disagree. One number, three threshold bands: stable, investigate, retrain. buffr has the raw signals — the embedding distribution in `agents.chunks.embedding`, the cosine-score distribution from `pg-vector-store` searches, the token/latency distributions in `agents.messages` — and nothing that turns any of them into a PSI.

## Structure pass

**Layers:** the reference window (train-time distribution) → the live window (production distribution) → the PSI computation → the threshold decision.

**Axis — "is this distribution still the one we built for?"** Trace that one question across the layers.

```
  trace "has the distribution moved?" across the layers

  ┌─ reference window ───┐  train-time bins (the baseline)   "this is normal"
  ├─ live window ────────┤  production bins (now)            "this is current"
  ├─ PSI = Σ contribution┤  per-bin divergence summed         one scalar
  └─ threshold band ─────┘  <0.1 ok / 0.1-0.2 watch / >0.2   the decision
```

**The seam:** the boundary between **feature/covariate drift** (the *inputs* moved — what PSI measures) and **label/concept drift** (the input→output *relationship* moved). PSI lives entirely on the input side; it can't see concept drift because it never looks at labels. That seam is load-bearing: a green PSI does *not* mean the model is fine — it means the inputs haven't moved. The relationship can rot while every input distribution stays put, and PSI will say "stable" the whole time.

## How it works

### Move 1 — the mental model

You already compare two histograms by eye — "last month's latency bars sat left, this month they've shifted right." PSI is that comparison turned into a single number: bin both distributions the same way, and for each bin measure how much the production share diverges from the training share, weighted by the log-ratio so a bin that doubled counts more than one that nudged.

```
  the kernel — bin both, sum the per-bin divergence

  reference (train):  [ 40% | 35% | 25% ]   bins low / mid / high
  production (now):   [ 20% | 30% | 50% ]   ← mass moved to "high"
                        │     │     │
        per-bin term:  (p−r)·ln(p/r)  for each bin
                        ▼     ▼     ▼
              PSI  =  Σ (prod% − train%) · ln(prod% / train%)

  one scalar → which band does it fall in?
```

The shape to remember: PSI is *signed-difference times log-ratio, summed over bins*. A bin contributes nothing when `prod% == train%` (difference zero) and a lot when the share both moved and moved *proportionally* far.

### Move 2 — the step-by-step walkthrough

**Step 1 — bin both distributions identically.** Pick bins from the *reference* distribution (commonly deciles) and apply the same edges to production. Identical edges is non-negotiable — different edges and you're comparing nothing.

```
  Step 1 — same bin edges for both windows

  reference values ─► deciles ─► [b0|b1|b2|...|b9]   (edges fixed HERE)
  production values ─────────────► apply SAME edges  ► [b0|b1|...|b9]
  now each bin has a train% and a prod% you can compare
```

**Step 2 — compute the per-bin contribution and sum.** For each bin, `(prod% − train%) · ln(prod% / train%)`. Sum across bins → PSI. Worked example with three bins:

```
  Step 2 — a worked PSI calculation (3 bins)

  bin   train%  prod%   (p−r)     ln(p/r)        term = (p−r)·ln(p/r)
  ───   ──────  ─────   ──────    ────────       ───────────────────
  low    0.40   0.20    −0.20     ln(0.50)=−0.69   (−0.20)(−0.69) = 0.139
  mid    0.35   0.30    −0.05     ln(0.857)=−0.15  (−0.05)(−0.15) = 0.008
  high   0.25   0.50    +0.25     ln(2.00)=+0.69   (+0.25)(+0.69) = 0.173
                                                   ─────────────────────
                                            PSI  =  0.320   → > 0.2 → RETRAIN
```

Pseudocode:

```
  // input:  reference values, production values, bin_count
  // output: PSI scalar
  function psi(reference, production, bin_count):
    edges = quantile_edges(reference, bin_count)   // bins from the BASELINE
    total = 0
    for bin in bins(edges):
      r = fraction_of(reference,  in=bin)          // train share
      p = fraction_of(production, in=bin)          // prod share
      r = max(r, epsilon)                           // guard: ln(p/0) is undefined
      p = max(p, epsilon)
      total += (p - r) * ln(p / r)                  // per-bin divergence
    return total
```

The `epsilon` guard is the boundary condition: an empty bin makes `ln(p/r)` blow up to infinity, so you floor both shares at a tiny constant. Forget it and a single empty production bin returns PSI = ∞.

**Step 3 — apply the threshold bands.** PSI's value only matters against the standard cutoffs. State them exactly:

```
  Step 3 — the threshold bands (memorize these)

  PSI < 0.10           ─►  NO significant shift     → ok, do nothing
  0.10 ≤ PSI ≤ 0.20    ─►  MODERATE shift           → investigate
  PSI > 0.20           ─►  SIGNIFICANT shift         → retrain

  ├──── ok ────┼─── watch ───┼────── retrain ──────►
  0          0.10          0.20                   ∞
```

**Step 4 — know what PSI can't see: concept drift.** PSI watches inputs. If the *meaning* of an input changes — same distribution, different correct answer — PSI stays green while the model rots.

```
  Step 4 — feature drift vs concept drift

  FEATURE (covariate) drift   ─►  P(X) moves      ─► PSI CATCHES IT  ✓
    inputs look different than training
  CONCEPT (label) drift       ─►  P(Y|X) moves    ─► PSI IS BLIND    ✗
    same inputs, different correct output
    → needs production ground-truth labels, not PSI
```

For buffr the realistic target is feature drift over its own distributions — embeddings and trace metrics — since it has no production labels to detect concept drift with anyway.

### Move 2.5 — current state vs future state

```
  Phase A (today)                        Phase B (PSI wired up)
  ─────────────                          ──────────────────────────────────
  agents.chunks.embedding exists         summary-stat of embeddings binned
  cosine scores produced per search      cosine-score distribution windowed
  tokens_used / durationMs logged        trace-metric distributions windowed
  NOTHING computes PSI                   PSI(reference, live) + threshold flag
```

The data is all there; the missing piece is a job that snapshots a reference window, bins a live window the same way, and runs the PSI sum (DRIFT-1 / DRIFT-2).

### Move 3 — the principle

Drift detection is the admission that a model's accuracy has an expiry date set by the world, not the code. PSI is the cheapest possible alarm — one scalar, three bands, no labels required — and its blind spot (concept drift) is the thing teams forget: a green PSI proves the *inputs* are stable, never that the *model* is still right. buffr has every input distribution it would need and watches none of them.

## Primary diagram

```
  PSI drift detection over a buffr signal — full picture

  ┌─ Reference window (baseline) ───────────────────────────────┐
  │  e.g. cosine scores from week 1 searches → deciles          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  fix bin edges HERE
  ┌─ Live window (now) ───────────▼──────────────────────────────┐
  │  e.g. cosine scores from this week → SAME edges             │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  per bin: (p−r)·ln(p/r)
  ┌─ PSI sum ─────────────────────▼──────────────────────────────┐
  │  PSI = Σ contributions   (guard empty bins with epsilon)    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Threshold band ──────────────▼──────────────────────────────┐
  │  <0.1 ok · 0.1–0.2 investigate · >0.2 retrain → (file 16)   │
  │  watches INPUTS only — blind to concept drift                │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

PSI comes from credit-risk scorecard monitoring, where models score loan applicants for years and the applicant population shifts under them — the exact "model meets a moving world" problem. The 0.1 / 0.2 cutoffs are conventions from that domain that stuck because they're roughly right across applications: under 0.1 the shift is noise, over 0.2 it's structural. PSI is one of a family (KL divergence, Jensen-Shannon, KS-test); it's the one teams reach for because it's a single interpretable scalar with battle-tested thresholds.

For buffr the genuine substrate is its *own* distributions, since it has no labeled production stream. Three candidates, all real: the embedding distribution (`agents.chunks.embedding`, vector(768) from `nomic-embed-text:v1.5`) summarized to a scalar (mean norm, a fixed dimension, etc.) and tracked over ingest windows; the cosine-score distribution from `pg-vector-store` searches (the `1 - (embedding <=> $1::vector) as score` values) over time — a slow slide here means retrieval quality is degrading; and trace metrics from `agents.messages` (`tokens_used`, `tool_results.durationMs`) — a drift in token usage or latency flags that the workload or model behavior has shifted. The data exists; nothing computes PSI on any of it.

The honest caveat is the concept-drift blind spot. buffr can detect that its *inputs* moved, never that its *answers* got worse for unchanged inputs — that would need production ground-truth, which buffr doesn't collect. So PSI is the right first alarm precisely because it needs no labels. buffr's prior ML pipeline (MediaPipe pose-landmarking) faced drift too — lighting and camera changes shift the input distribution — but never monitored it, so PSI is new ground.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Compute PSI on the cosine-score distribution between two time windows

- **Exercise ID:** DRIFT-1 (Case B — drift detection not yet exercised). **The lead drift exercise.**
- **What to build:** a job that pulls retrieval cosine scores (or a 768-dim embedding summary statistic) from two time windows of `agents.chunks` / search logs, bins them identically, and computes PSI — flagging when retrieval-quality distribution drifts.
- **Why it earns its place:** a slow slide in cosine-score distribution is silent retrieval degradation with no error to catch; PSI is the alarm. The story is "I built drift detection on my own retrieval signal."
- **Files to touch:** new `scripts/psi-drift.ts`; read the `1 - (embedding <=> ...) as score` values via the search path in `src/pg-vector-store.ts`; window by `agents.chunks` timestamps; implement the PSI sum with the epsilon guard.
- **Done when:** the job prints a PSI for the cosine-score distribution between two windows and classifies it into the <0.1 / 0.1–0.2 / >0.2 band.
- **Estimated effort:** 1 day.

### Compute PSI on trace metrics and wire the thresholds to a flag

- **Exercise ID:** DRIFT-2 (Case B — trace-metric drift not yet exercised).
- **What to build:** PSI over `tokens_used` and `tool_results.durationMs` from `agents.messages` between two windows, with the 0.1 / 0.2 cutoffs wired to a stable / investigate / retrain flag.
- **Why it earns its place:** token and latency drift signals that model behavior or workload has shifted — the cheapest production health check, and the data is already logged.
- **Files to touch:** new `scripts/psi-trace.ts` reading `agents.messages` (`tokens_used`, `tool_results.durationMs`); reuse the PSI function from DRIFT-1; emit the band as a flag.
- **Done when:** the job returns a banded flag (ok / investigate / retrain) for token-usage and latency drift across two windows.
- **Estimated effort:** 4–8 hr.

## Interview defense

**Q: Walk me through PSI and its thresholds.**
Answer: PSI measures how far a feature's production distribution has moved from its training distribution. Bin both with the *same* edges (from the baseline), then for each bin take `(prod% − train%) · ln(prod% / train%)` and sum — large when a bin's share both moved and moved proportionally far. Thresholds: under 0.1 is stable, 0.1 to 0.2 is a moderate shift worth investigating, over 0.2 is significant and triggers retraining. One guard: floor empty-bin shares at an epsilon or `ln(p/r)` blows up to infinity.

```
  PSI = Σ (p−r)·ln(p/r)   ·   <0.1 ok | 0.1–0.2 watch | >0.2 retrain
```

**Q: What can't PSI catch?**
Answer: concept drift. PSI watches the input distribution P(X); if the input→output relationship P(Y|X) changes — same inputs, different correct answer — PSI stays green while the model quietly gets things wrong. Catching that needs production ground-truth labels, which PSI never looks at. **The part people forget: a green PSI proves your *inputs* are stable, not that your *model* is still right — those are different claims, and for buffr only the first is even measurable since it collects no production labels.**

```
  P(X) moves → PSI catches it    P(Y|X) moves → PSI blind (needs labels)
```

## See also

- `16-retraining-pipelines.md` — the action a >0.2 PSI triggers; drift-triggered retraining.
- `06-domain-gap.md` — train/production mismatch, the static version of what drift makes dynamic.
- `14-training-run-logging.md` — `agents.messages` is the substrate DRIFT-2 reads its metrics from.
- `../05-evals-and-observability/04-llm-observability.md` — the trace whose token/latency distributions DRIFT-2 monitors.
