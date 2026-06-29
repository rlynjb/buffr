# Anomaly Detection

### *interview reframe · fixed 9-bullet shape · Phase 5 anchor C5.12*

---

**The prompt:** Design an anomaly detection system that flags unusual events in a stream.

---

**Standard architecture**

```text
┌──────────────────────────── ANOMALY DETECTOR (top-to-bottom) ───────────────────────┐
│                                                                                      │
│   event stream (one record per event, unbounded)                                     │
│            │                                                                          │
│            ▼                                                                          │
│   ┌──────────────────┐     extract numeric/embedding features per event              │
│   │ FEATURIZE        │                                                                │
│   └────────┬─────────┘                                                                │
│            │ feature vector                                                           │
│            ▼                                                                          │
│   ┌──────────────────┐     compare against a learned/known NORMAL profile            │
│   │ SCORE            │ ◄── distance-to-normal, density, reconstruction error,        │
│   │ anomaly_score    │     or distributional distance (PSI/KL) over a window         │
│   └────────┬─────────┘                                                                │
│            │ anomaly_score                                                            │
│            ▼                                                                          │
│   ┌──────────────────┐     score > threshold ? (threshold tuned for precision/recall)│
│   │ THRESHOLD / FLAG │                                                                │
│   └────────┬─────────┘                                                                │
│            │ flagged events                                                           │
│            ▼                                                                          │
│   ┌──────────────────┐                                                                │
│   │ ALERT / ROUTE    │ ──► human review ──┐                                           │
│   └──────────────────┘                    │ labels                                    │
│                                           ▼                                            │
│   ┌──────────────────────────────────────────────────────────┐                       │
│   │ NORMAL-PROFILE UPDATE ◄── rolling window of recent normal │                       │
│   └──────────────────────────────────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

**Data model**

- **Event log** — append-only stream of raw events with timestamps; the input the detector scores.
- **Feature vector per event** — numeric or embedding representation; what "normal vs unusual" is measured over.
- **Normal-profile / reference window** — the rolling baseline distribution (mean/cov, density model, or a reference embedding set); anomalies are deviations from it.
- **Anomaly score + flag** — per-event score and boolean above-threshold; the output and the audit trail.
- **Threshold + label feedback** — the tuned cutoff plus human verdicts on flagged events; used to recalibrate precision/recall.

---

**Key components**

- **Featurizer** — turns a raw event into a comparable vector; choose **the embedding that already exists** when the stream is text (no separate feature pipeline) over hand-built numeric features.
- **Scorer** — assigns deviation-from-normal; choose **distributional distance (PSI / population stability index) over a window** for drift-style anomalies and **distance-to-known-normal** for point anomalies, because the two answer different questions (the world shifted vs this one event is weird).
- **Thresholder** — converts score to flag; choose a **tuned cutoff with an explicit precision/recall trade-off** over a fixed magic number, because the cost of a false alarm vs a miss is domain-specific.
- **Feedback / profile updater** — keeps "normal" current as the stream evolves; choose a **rolling reference window** over a frozen baseline so seasonal drift isn't flagged forever as anomalous.

---

**Scale concerns** (ordered by which hits first)

- **At the first deployment, you have no labels.** Anomalies are rare by definition, so there's no balanced training set day one — the system must start *unsupervised* (distance/density) and earn labels from human review. This is the class-imbalance wall (see `../08-machine-learning/05-class-imbalance.md`) and it hits before any throughput concern.
- **At ~1k events/sec, per-event scoring must be O(1) against the profile.** Re-fitting the normal model on every event doesn't scale; past low-thousands/sec you precompute the reference statistics and only update the window periodically.
- **At a few weeks of runtime, seasonal drift floods alerts.** A frozen "normal" baseline flags every legitimate trend (weekday vs weekend, growth) as anomalous; the rolling window must adapt or precision collapses to noise.
- **At any scale, threshold drift silently changes alert volume.** As the underlying distribution shifts, a fixed threshold either goes quiet (misses) or screams (false alarms); the cutoff itself needs monitoring.

---

**Eval framing**

- **Offline:** on a labeled set of known anomalies, precision / recall / PR-AUC at the chosen threshold — *not* accuracy, which is meaningless when 99.9% of events are normal. The threshold sweep (the PR curve) is the real deliverable; a single number hides the trade-off.
- **Online:** alert precision (fraction of flags a human confirms) and time-to-detection, measured against the live human-review queue. A detector with 5% alert precision trains its operators to ignore it.
- **Per-deployment:** for a low-volume single-user system there's no statistical alert population; eval is the qualitative question "did the flag correspond to a genuinely weird retrieval / answer," spot-checked by the one user.

---

**Common failure modes**

- **Alert fatigue from low precision** — too many false flags and operators stop looking. *Mitigation:* tune the threshold toward precision and add a severity tier so only high-confidence anomalies page.
- **Concept drift mislabeled as anomaly** — the world legitimately changed and every new event looks "unusual" against a stale baseline. *Mitigation:* rolling reference window + an explicit drift monitor (PSI) that distinguishes "distribution shifted" from "this event is an outlier."
- **No ground truth to validate against** — without labels you can't prove the detector works. *Mitigation:* seed with injected synthetic anomalies and build the human-review loop that produces real labels over time.
- **The anomaly is in the model's output, not the input** — a hallucinated answer is an anomaly the input featurizer never sees. *Mitigation:* score the *output* too (groundedness), not just the query distribution.

---

**Applies to this codebase: partially**

buffr has no anomaly-detection subsystem, but it ships one hand-built anomaly *signal* and inherits another. The hand-built one: every retrieval returns scores `1 - (embedding <=> $1)` (`src/pg-vector-store.ts:72`), and when **all** top-k scores are low, that *is* an anomaly signal — it means the knowledge base contains nothing relevant to the query, an out-of-distribution input relative to the indexed corpus. buffr already half-acts on this: the `RagQueryAgent` grounding prompt (provided by aptkit, consumed via `src/session.ts:57`) is instructed that if the KB lacks the answer it should say so, and it returns a fallback answer rather than fabricating — the canonical anomaly-then-mitigate behavior, except the "anomaly" is detected by the LLM reading low-relevance chunks rather than by an explicit score threshold. The LLM analog of anomaly detection is **hallucination / groundedness detection** — flagging an answer that drifted off its retrieved evidence — and buffr does **not** measure that today (the `RubricJudge` that would is unwired; see `../05-evals-and-observability/03-llm-as-judge-bias.md`). So: **partially** — the low-all-scores → fallback path is a real, if implicit, anomaly signal; the explicit scorer, threshold, and groundedness check are missing. The raw material is already in the database: every query embedding's neighbor scores, and every chunk embedding in `agents.chunks`, exist and are queryable.

---

**How to make it apply**

Three concrete additions turn buffr's implicit signal into a real anomaly detector, all over files that already exist:

- **Low-score flagger (point anomaly).** Add `ml/anomaly.ts` that, after `PgVectorStore.search` returns hits, computes `max(score)` across the top-k; if it falls below a tuned threshold, flag the query as out-of-distribution ("KB has nothing relevant"). This promotes the implicit fallback path into an explicit, logged signal — the same condition that should drive `minTopK` and the fallback answer in `src/session.ts:43`.
- **PSI drift monitor (distributional anomaly).** The query embeddings already exist as the vectors searched against `agents.chunks`. Add a job (in `ml/`) that bins recent query embeddings vs a reference window and computes **PSI / population stability index** per dimension or over a clustered profile — exactly the drift machinery in `../08-machine-learning/15-drift-detection.md`. Rising PSI means the user is asking about topics the corpus wasn't built for: covariate shift, the leading indicator of degrading retrieval.
- **Wire the unwired `RubricJudge` for groundedness (output anomaly).** The hallucination case is the anomaly the input scorer can't see. Wire `RubricJudge` (built in aptkit, never constructed in buffr) into a faithfulness eval over `eval/queries.json` so an answer that drifts off its retrieved chunks is flagged — this is exactly exercise **[B3.9]** from `../05-evals-and-observability/03-llm-as-judge-bias.md`, reused here as the output-side anomaly detector.
- **Feed the signal stream from the trace.** `src/supabase-trace-sink.ts` already persists every retrieval and answer event to `agents.messages` with scores and timestamps. The drift and flagger jobs read that table as their event stream — no new ingestion path, the log already exists.
