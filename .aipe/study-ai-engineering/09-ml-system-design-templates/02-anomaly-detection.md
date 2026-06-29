# Anomaly detection system design

- **The prompt:** "Design an anomaly detection system that flags unusual events in a stream."

- **Standard architecture:**

  ```
  Event stream
    │
    ▼
  ┌──────────────────────────────────┐
  │ Feature extraction               │
  │  (windows, aggregates, encode)   │
  └──────────────┬───────────────────┘
                 │  feature vector
                 ▼
  ┌──────────────────────────────────┐
  │ Scoring                          │
  │  (statistical / model-based)     │
  └──────────────┬───────────────────┘
                 │  anomaly score
                 ▼
  ┌──────────────────────────────────┐
  │ Threshold                        │
  │  (static / adaptive)             │
  └──────────────┬───────────────────┘
                 │  flagged events
                 ▼
  ┌──────────────────────────────────┐
  │ Alert + human review             │
  └──────────────┬───────────────────┘
                 │  labels
                 ▼
  ┌──────────────────────────────────┐
  │ Feedback (label → retrain)       │
  └──────────────────────────────────┘
  ```

- **Data model:**
  - Event stream `{timestamp, entity, metrics}` — the raw signal; in buffr this is per-turn trace events in `agents.messages`.
  - Feature store — windowed aggregates (rolling mean/variance, rate) per entity.
  - Score log `{event_id, score, threshold, flagged}` — for tuning the threshold.
  - Label store `{event_id, is_anomaly}` — human review outcomes that feed retraining.

- **Key components:**
  - *Feature extraction*: turns raw events into a feature vector over a time window. Decision: streaming windows (e.g. last-5-min rate) so detection is online, not batch.
  - *Scoring*: assigns an anomaly score — distance from normal. Decision: start with a statistical baseline (z-score, PSI drift) before reaching for an isolation forest or autoencoder; simpler is debuggable.
  - *Threshold*: converts score to a binary flag. Decision: adaptive threshold per entity, because a fixed global cutoff drowns in false positives across heterogeneous streams.
  - *Alert + review*: routes flags to a human, whose verdict becomes a label. Decision: rate-limit alerts so a spike doesn't page a hundred times.

- **Scale concerns:**
  - At high event rate: per-event scoring becomes the bottleneck. Solution: aggregate into windows, score the window not the event.
  - At many entities: per-entity baselines blow up state. Solution: cluster entities, share a baseline per cluster.
  - Concept drift: "normal" shifts over time and yesterday's threshold over-flags. Solution: rolling-window baselines, PSI monitoring on the feature distribution itself.

- **Eval framing:**
  - Offline: precision/recall on a labeled anomaly set; the base rate is tiny, so precision@k and PR-AUC matter, not accuracy.
  - Online: alert precision (fraction of flags a human confirms), time-to-detection, missed-incident rate.
  - The class imbalance is the whole problem: anomalies are rare, so a model that predicts "normal" always scores 99%+ accuracy and is useless.

- **Common failure modes:**
  - Alert fatigue → too many false positives, humans stop looking. Mitigation: adaptive thresholds, alert rate-limiting, severity tiers.
  - Drift → baseline goes stale, everything flags. Mitigation: rolling baselines, monitor PSI on inputs.
  - Label scarcity → too few confirmed anomalies to train. Mitigation: unsupervised scoring first, semi-supervised once labels accrue.

- **Applies to this codebase:** **partially — as a thought experiment.** buffr trains no anomaly model, but it *emits the right stream*. The trace persisted by `src/supabase-trace-sink.ts` into `agents.messages` carries `tokens_used`, per-tool `durationMs` inside `tool_results`, and warning/error events — that is exactly a stream you could score for anomalies: latency outliers, token-count outliers, repeated tool failures, the empty-query `search_knowledge_base` failure that surfaces when Gemma emulates a tool call with a bad argument (no arg validation). There is also a clean LLM analog: **hallucination detection is anomaly detection** — a low-faithfulness answer is an anomalous output, and the unwired RubricJudge faithfulness scorer is the detector that would flag it. So the architecture maps, but nothing in buffr today computes a score or a threshold.

- **How to make it apply:** Run a PSI / z-score baseline over the trace metrics already landing in `agents.messages` via `src/supabase-trace-sink.ts`. Flag token-count and `durationMs` outliers per turn against a rolling window; flag spikes in Gemma parse-failures (the tool-call emulation produces these and they cluster when a prompt regresses); flag repeated `search_knowledge_base` failures including the empty-query case. For the LLM analog, wire RubricJudge faithfulness (cross-link `05-evals-and-observability/`) and treat a low score as a flagged anomaly. None of this needs a trained model — it's threshold-over-stream on data buffr already persists, which is why this is the one ML template that maps even partially.
