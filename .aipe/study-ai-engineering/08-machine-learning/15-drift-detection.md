# Drift Detection

### *industry: data drift / covariate shift detection · type: the production monitor that catches when the world stopped matching your training data*

## Zoom out

A trained model is a frozen snapshot of the world it was trained on. Production is a moving world. The gap between them — *drift* — is the slow failure mode no test catches, because the code is fine; it's the *input distribution* that changed. In buffr you don't have a trained model to drift yet, but you do have a stream of query embeddings landing in pgvector every day, and *that distribution* — what people ask — absolutely shifts. Drift detection is the monitor that watches a distribution over time and raises its hand when "now" stops looking like "then."

**The MLOps lifecycle, with the stage drift detection lives in marked**
```
┌────────┐ ┌──────────┐ ┌───────┐ ┌───────┐ ┌────────┐ ┌──────────┐
│  Data  │►│ Features │►│ Split │►│ Train │►│ Deploy │►│ ★MONITOR │
│        │ │          │ │       │ │       │ │        │ │ ★        │
└───┬────┘ └──────────┘ └───────┘ └───────┘ └────────┘ └────┬─────┘
    │                                                        │ ◄── this file
    │  TRAIN distribution  ◄───── compare ─────►  PROD distribution
    └────────────────────────────────────────────────────────┘
              drift = the two distributions diverging over time
```
Drift detection closes the loop from monitor back to data: it watches production inputs against the training reference and flags divergence.

## Structure pass

One axis runs through the whole topic: **distribution distance — how far has the live input distribution moved from the reference one?** Everything reduces to comparing two histograms (reference vs current) and reducing their difference to a single number you can threshold.

**The one axis: reference distribution vs current distribution, reduced to one number**
```
   REFERENCE (training-time)         CURRENT (production, this week)
   counts per bucket                 counts per bucket
    █                                     █
    ███                                  ███
    ████  ██                          ██ ████
    ──────────────                    ──────────────
       buckets                            buckets
            │                                  │
            └──────────► PSI = Σ contributions ◄┘
                              │
              one scalar: 0 = identical, larger = more drift

   ┌──────────────────────────── THE SEAM ───────────────────────────┐
   │ DATA drift (inputs change) ≠ CONCEPT drift (input→label relation │
   │ changes). PSI catches the FIRST. The second needs fresh labels.  │
   └──────────────────────────────────────────────────────────────────┘
```
The seam: PSI sees the inputs moving (covariate shift / data drift). It cannot see the *meaning* of a label changing under fixed inputs — that's concept drift, and it needs ground truth, not just a histogram.

## How it works

### Move 1 — Mental model

The mental model: **bucket both distributions the same way, then sum how much each bucket's share moved.** PSI (Population Stability Index) is the workhorse: bin the reference and current data into the same buckets, and for each bucket measure how its *proportion* shifted, weighted by the log of the ratio. Small total = stable; large total = the population moved.

**The pattern: same buckets, sum the per-bucket shift**
```
   bucket │ ref%  │ cur% │ contribution = (cur% - ref%) * ln(cur%/ref%)
   ───────┼───────┼──────┼──────────────────────────────────────────
     b1   │ 0.20  │ 0.10 │  (−0.10)*ln(0.5)  = +0.069
     b2   │ 0.50  │ 0.45 │  (−0.05)*ln(0.9)  = +0.005
     b3   │ 0.30  │ 0.45 │  (+0.15)*ln(1.5)  = +0.061
   ───────┴───────┴──────┴──────────────────────────────────────────
                                  PSI = Σ = 0.135
```
PSI is just that column summed — a single number standing in for "how different are these two histograms."

### Move 2 — Walk the mechanism

**Part 1 — Freeze a reference distribution.** At training (or, for buffr, at a chosen baseline week), snapshot the bucketed distribution of the feature you'll monitor. This is the "then" you compare against.

**The reference is frozen once, the baseline you measure drift FROM**
```
   training data feature ──► histogram ──► FREEZE as reference%
                                              │
                          stored; never changes until you re-baseline
```

**Part 2 — Bucket the live data the same way.** Critically, use the *reference's* bucket edges on the current data. Re-binning current data into its own buckets makes the two incomparable.

**Same bucket edges on both, or the comparison is meaningless**
```
   reference edges:  [.. | .. | .. | ..]   ◄── defined once
   current data ─────apply SAME edges────► current%
        │  using fresh edges here = comparing apples to a different fruit
```

**Part 3 — Compute PSI and read the threshold.** Sum the per-bucket contributions. The conventional reading is stable / moderate / significant. Illustrative pseudocode, not buffr code:

**PSI computation + threshold bands (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code.
def psi(ref_pct, cur_pct, eps=1e-6):
    total = 0.0
    for r, c in zip(ref_pct, cur_pct):
        r, c = max(r, eps), max(c, eps)          # guard against ln(0)/div0
        total += (c - r) * math.log(c / r)
    return total

# conventional bands:
#   PSI < 0.10  → stable, no action
#   0.10–0.25   → moderate drift, watch
#   PSI > 0.25  → SIGNIFICANT drift → alert + consider retrain
```

**Part 4 — Drift fires a signal, not a retrain (yet).** A PSI breach is an *alert*, not an automatic rebuild. It says "the inputs moved" — the operator (or a downstream pipeline) decides whether that warrants action.

**Detection → alert → (maybe) retrain trigger**
```
   PSI > 0.25 ──► ALERT ──► investigate ──► [ retrain? re-baseline? ignore? ]
                    │
        the monitor's job ends at the alert; file 16 wires the trigger
```

### Move 2.5 — Current vs future

buffr has no trained model, so there's no model to drift. But there *is* a live distribution to measure today: the query embeddings flowing into pgvector. You can start measuring drift before you ever train anything.

**What buffr can measure NOW vs what needs a model LATER**
```
   NOW (buildable, no model required):
     query embeddings in agents.chunks/queries ──► reduce to a 1-D feature
       (e.g. mean cosine-to-corpus, or top PCA component) ──► PSI week-over-week
     ★ "what users ask" drifting is a REAL, measurable buffr signal

   LATER (needs a trained model):
     model input features ──► PSI ──► retrain trigger
     drift on the things a TRAINED model consumes
```

### Move 3 — The principle

The principle: **a model's accuracy can rot without a single line of code changing, because the world is the real input.** Drift detection is the smoke alarm for that silent failure: it watches the input distribution, reduces divergence to one thresholded number, and converts "something feels off" into "PSI crossed 0.25 on Tuesday." You don't need ground-truth labels to run it — which is exactly why it's the monitor you can build first.

## Primary diagram

**The full picture: reference vs live, reduced to PSI, thresholded into an alert**
```
   TRAINING / BASELINE                      PRODUCTION (rolling window)
   ┌────────────────────┐                   ┌────────────────────┐
   │ feature histogram   │                  │ feature histogram   │
   │  → FREEZE ref%      │                  │  (same bucket edges) │
   └─────────┬───────────┘                  └─────────┬───────────┘
             │                                         │
             └──────────────► PSI = Σ (c−r)·ln(c/r) ◄──┘
                                     │
                    ┌────────────────┼─────────────────┐
                    ▼                ▼                  ▼
               PSI < 0.10        0.10–0.25          PSI > 0.25  ★
               stable            watch              ALERT → retrain trigger
                                                         │
                              ┌──────────────────────────┘
                              ▼
                    buffr hook (buildable NOW):
                    PSI over QUERY-EMBEDDING distribution, week over week
                    — drift in what users ASK, no trained model required
```
Read it left-to-right then down: two histograms collapse to one PSI number, the number falls into a band, and only the top band fires an alert — and in buffr you can run this today over the query-embedding stream.

## Elaborate

- **PSI is symmetric-ish but not a true distance — and that's fine.** It's a stability index, not a metric in the mathematical sense. KL divergence is the closer theoretical cousin (PSI is essentially a symmetrized, bucketed KL). For monitoring, the thresholds matter more than the theory; 0.25 is the field-standard "significant" line.
- **Bucket count is a real knob.** Too few buckets and you miss drift hiding inside a wide bin; too many and sparse buckets make PSI noisy and the `ln` term explode. Ten deciles is the common default. Always guard against empty buckets (the `eps` in the pseudocode) or `ln(0)` blows up.
- **High-dimensional inputs need a projection.** A 768-dim embedding has no single histogram. You monitor *derived scalars*: distance-to-centroid, a top principal component, or per-dimension PSI averaged. Don't try to PSI a 768-vector directly — reduce first, then bucket.
- **Data drift is not concept drift.** PSI on inputs catches "users started asking different things." It does *not* catch "the right answer to the same question changed." The latter needs labels — which is why drift detection alerts you to *look*, and a labeled canary (file 16) tells you whether quality actually dropped.
- **Re-baselining is a decision, not an accident.** When drift is legitimate (the world genuinely moved and you've adapted), you reset the reference. Doing this silently hides future drift; doing it deliberately, logged, keeps the monitor honest.

## Project exercises

### Exercise — PSI monitor over buffr's query-embedding distribution

- **Exercise ID:** [B2C.15] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing* — and this exercise leans into that by monitoring an input distribution that exists *without* a trained model. Build a `ml/drift.py` that snapshots a reference distribution of query embeddings (reduced to a scalar like mean cosine-similarity-to-corpus, or the top PCA component), then computes weekly PSI of the live query stream against that reference, printing the band (stable / watch / significant).
- **Why it earns its place:** It's the rare ML-monitoring exercise that's *fully buildable on buffr today* — no model required to start measuring drift in what users ask. It proves you can stand up a production monitor and reason about distribution shift, which is the harder half of MLOps.
- **Files to touch:** new `ml/drift.py`, reads embeddings from `agents.chunks` / the query log (via `src/pg-vector-store.ts`'s table), writes a reference snapshot to a new `agents.drift_baseline` row.
- **Done when:** running it weekly emits a PSI number + band, and synthetically injecting off-topic queries pushes PSI above 0.25 and prints `SIGNIFICANT`.
- **Estimated effort:** Medium — a day. The PSI math is small; the work is the embedding-to-scalar reduction and the baseline snapshot.

### Exercise — Wire the PSI breach to an alert

- **Exercise ID:** [B2C.15b] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing,* so there's no retrain to trigger yet — but the *alert* half is buildable. Extend `ml/drift.py` to emit a structured alert (log line / row in a `agents.drift_events` table) when PSI > 0.25, capturing the offending feature, the PSI value, and the window — the same "capture the full signal" discipline `SupabaseTraceSink` uses.
- **Why it earns its place:** Detection without a signal is a dashboard nobody reads. Producing a thresholded, recorded alert is what turns a metric into an operational trigger — and it's the input file 16's retraining pipeline will consume.
- **Files to touch:** `ml/drift.py`, new `sql/003_drift_events.sql`, modeled on `agents.messages`.
- **Done when:** a PSI breach writes one `agents.drift_events` row with feature, value, and window; a stable week writes none.
- **Estimated effort:** Small to medium — half a day on top of the monitor.

## Interview defense

**Q: "How do you detect data drift in production?"**
```
   freeze REFERENCE histogram (training/baseline)
   bucket LIVE data with the SAME edges
   PSI = Σ (cur% − ref%)·ln(cur%/ref%)
   ┌──────────────────────────────────────────┐
   │ <0.10 stable · 0.10–0.25 watch · >0.25 act │
   └──────────────────────────────────────────┘
```
Anchor: "Bucket both distributions the same way, reduce the difference to one PSI number, and threshold it at 0.25."

**Q: "Drift fired. Do you retrain?"**
```
   PSI > 0.25 ──► ALERT (not auto-retrain)
                   │
        DATA drift? → investigate, maybe re-baseline
        quality actually dropped? → labeled canary confirms → THEN retrain
```
Anchor: "Drift is a reason to *look*, not an automatic rebuild — I confirm quality actually dropped on a labeled canary before spending a training run."

**Q: "Could you measure drift without a trained model?"**
```
   most candidates: 'drift needs a deployed model' ◄── incomplete
   reality: PSI on ANY input distribution ◄── buffr's query embeddings, today
```
Anchor: "Most candidates have only consumed pre-trained models and think drift requires one. PSI runs on any input distribution — I can measure drift in buffr's query embeddings right now, no model needed. That's [B2C.15]."

## See also

- ./14-training-run-logging.md — the run record pins the *reference* distribution drift is measured against.
- ./16-retraining-pipelines.md — the drift-triggered retrain that consumes this monitor's alert.
- ./06-domain-gap.md — drift is domain gap appearing *over time* in production, not just train-vs-test.
- ../03-retrieval-and-rag/09-stale-embeddings.md — the retrieval-side cousin: the corpus drifting under fixed embeddings.
- ../05-evals-and-observability/04-llm-observability.md — where the drift alert surfaces alongside inference telemetry.
- ../06-production-serving/04-rate-limiting-backpressure.md — drift monitoring as a production-health signal.
- ../09-ml-system-design-templates — drift monitoring as a required box in a serving-system design.
