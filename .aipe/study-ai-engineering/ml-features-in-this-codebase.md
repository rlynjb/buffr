# How buffr-laptop uses ML

Short version: it doesn't train one.

buffr is a pure LLM application. It *consumes* two pre-trained models served by Ollama — `gemma2:9b` for generation and `nomic-embed-text:v1.5` for embeddings — but it never trains, fine-tunes, or evaluates a classical supervised model. There is no labeled training set (other than the 3-row retrieval eval, which is an information-retrieval eval, not a model-training set), no feature engineering pipeline, no train/val/test split, no confusion matrix, no on-device classifier, no recommender.

So the classical-ML sections of this guide — `08-machine-learning/` and `09-ml-system-design-templates/` — are covered as **study material**, not as walkthroughs of your code. Their Project-exercise blocks identify the ML features that *could* be added, framed against buffr's actual data.

## What would count as ML in buffr (and where it would attach)

```
  the ML-shaped surfaces buffr could grow (none built today)

  ┌─ candidate ML feature ──────────┬─ attaches to ─────────────────┐
  │ Learned reranker over cosine    │ src/pg-vector-store.ts        │
  │  (rank top-50 → top-5)          │ search() results              │
  ├─────────────────────────────────┼───────────────────────────────┤
  │ Fine-tune gemma on trajectories │ agents.messages (the FT corpus│
  │  (the ceiling — not done)       │ already being captured)       │
  ├─────────────────────────────────┼───────────────────────────────┤
  │ Embedding-drift / staleness     │ agents.chunks.embedding_model │
  │  detector (PSI over corpus)     │ + a stale_at column           │
  ├─────────────────────────────────┼───────────────────────────────┤
  │ Anomaly flag on trace metrics   │ agents.messages.tokens_used,  │
  │  (latency / token outliers)     │ durationMs in tool_results    │
  └─────────────────────────────────┴───────────────────────────────┘
```

The single most ML-relevant fact about buffr is that it is **already collecting the corpus a future trained model would need**: `agents.messages` captures the full-signal trajectory of every conversation (all six `CapabilityEvent` types — step, tool_call_start, tool_call_end, model_usage, warning, error), with deterministic replay order. That's the fine-tuning corpus and the drift-monitoring substrate. The data exists; the model does not.

## ML features

```
  ┌────────────────────┬────────────────┬────────────────┐
  │ Feature            │ Model type     │ Inference loc. │
  ├────────────────────┼────────────────┼────────────────┤
  │ (none trained)     │ —              │ —              │
  └────────────────────┴────────────────┴────────────────┘
```

There are no trained-model features to tabulate. The two models buffr runs are pre-trained and consumed as-is.

## Where to go

- The supervised-learning, evaluation, and on-device concepts are taught as new ground in `08-machine-learning/` (calibrated to the reader's one prior ML pipeline — contrl's MediaPipe pose pipeline — without assuming more).
- The "reframe buffr as an ML system" interview prompts are in `09-ml-system-design-templates/`, with every "Applies to this codebase" bullet answered honestly (`no` or `partially`) and a concrete "how to make it apply".
- The fine-tuning discussion — why it's the ceiling and why the trajectory capture is the prerequisite — lives in `05-evals-and-observability/04-llm-observability.md` (the trace) and is named throughout as buffr's not-yet-done frontier.
