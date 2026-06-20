# ML features in buffr

> Per the spec, this file is generated even when the codebase has no classical-ML features — and it says so honestly.

## This codebase does not currently use any classical-ML features.

buffr trains no model. There is no supervised-learning pipeline, no feature engineering, no labeled-data training set, no train/val/test split, no classifier, no recommender, no on-device *trained* inference, no drift detection, no retraining pipeline. The two models buffr uses — `nomic-embed-text` (embeddings) and `gemma2:9b` (generation) — are pre-trained and consumed as-is through Ollama. buffr never updates their weights.

So the entire SECTION 04 surface of the AI-engineering spec is **not yet exercised** here. The ML system-design templates (recommender, anomaly detection, object detection / CV) are not generated as codebase patterns, because buffr's shape is pure LLM-application-engineering, not classical ML — the spec's rule is to skip ML concept files that don't match the codebase's shape rather than invent ML features.

## Where ML *would* enter, if it ever did

These are study hooks, not current features — named so the gap is a map, not a blank:

```
  ┌────────────────────────┬──────────────────────────────────────────┐
  │ Hypothetical ML feature│ Where it would attach in buffr           │
  ├────────────────────────┼──────────────────────────────────────────┤
  │ Learned reranker       │ on top of cosine top-k in                │
  │ (LightGBM on features  │ PgVectorStore.search — needs click logs  │
  │  like score, recency)  │ as training signal (07-templates/01)     │
  ├────────────────────────┼──────────────────────────────────────────┤
  │ Query intent classifier│ before the agent loop — route easy       │
  │ (heuristic + small LR)  │ queries past the LLM (heuristic-before-  │
  │                        │ LLM, currently absent per audit)         │
  ├────────────────────────┼──────────────────────────────────────────┤
  │ Embedding drift monitor│ PSI on the chunk-embedding distribution  │
  │ (population stability) │ over time — the anomaly-detection shape  │
  │                        │ applied to the corpus, not yet built     │
  └────────────────────────┴──────────────────────────────────────────┘
```

## The reader's ML context (calibration, not buffr)

For the reader: classical ML beyond a single pipeline is named new ground. The one shipped ML pipeline (pose landmarking with MediaPipe → rep counter) lives in a *different* repo (contrl), not buffr — so it can't be anchored to buffr's files. buffr is the right place to be honest: it's an LLM-app codebase, and the ML concepts above are future ground to build *into* it (a learned reranker is the most natural first step, and it has a clean attach point at the retrieval layer), not refreshers of something already here.

If you want a learned reranker as a real exercise, the buildable target is in `07-system-design-templates/01-search-ranking.md` ("How to make it apply", step 3) and `02-rag-query-path.md` (the retrieval path it would sit on top of) — both require click logging first, because a learned ranker needs an interaction signal buffr doesn't currently collect.
