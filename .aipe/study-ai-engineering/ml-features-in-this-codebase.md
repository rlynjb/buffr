# ML features in this codebase

The honest version, up front: **buffr-laptop trains no machine-learning model.** It consumes two pre-trained models — `gemma2:9b` for generation and `nomic-embed-text:v1.5` for embeddings, both served locally by Ollama — but it never fits, trains, or evaluates a model of its own. That is AI-application engineering, not classical ML.

So this page does not describe an ML pipeline buffr ships, because there isn't one. It does two things instead: it draws the line between *consuming* a learned model and *training* one, and it names the real hooks in buffr where classical ML could attach. The concept files in `08-machine-learning/` teach each ML pattern as new ground, with the build exercises as the primary deliverables.

## Where the line falls

```
Consuming a learned model  vs  training one — where buffr sits

┌─ buffr DOES this (consume) ──────────────────────────────────────┐
│  gemma2:9b        — pre-trained LLM, served by Ollama            │
│  nomic-embed-text — pre-trained embedder, served by Ollama       │
│  the embeddings   — output of a transfer-learned model           │
│  precision@k/recall@k — ML *metrics*, computed over retrieval    │
└──────────────────────────────────────────────────────────────────┘
                              │ the line: no .fit() anywhere
                              ▼
┌─ buffr does NOT do this (train) ─────────────────────────────────┐
│  no labeled training set fed to a model         (eval/queries    │
│  no feature engineering pipeline                 .json is a       │
│  no train/val/test split                         retrieval eval,  │
│  no model selection (LR vs GBT)                  not a training    │
│  no confusion matrix / calibration               set)            │
│  no drift detection / retraining                                 │
└──────────────────────────────────────────────────────────────────┘
```

Every concept in `08-machine-learning/` lives below that line. None of it is wired in buffr today — they are all Case B (the exercise is the buildable target), taught honestly as new ground.

## The real hooks — where ML could attach

These are honest seams, not claims that buffr does ML. Each is a place where the existing code already produces the raw material a classical-ML feature would need.

```
buffr's real ML hooks (raw material exists; the ML does not)

┌─ hook ─────────────────┬─ what already exists ────────────────────┐
│ Fine-tuning corpus     │ agents.messages — full trajectories      │
│ (the ceiling)          │ (step/tool/usage). A SFT/LoRA dataset.   │
├────────────────────────┼──────────────────────────────────────────┤
│ Quantized weights      │ gemma2:9b is served as a quantized GGUF   │
│                        │ by Ollama — Rein runs a quantized model   │
│                        │ but did not quantize it.                  │
├────────────────────────┼──────────────────────────────────────────┤
│ Local inference        │ both models run on-laptop via Ollama —    │
│                        │ the privacy/offline/latency shape of      │
│                        │ on-device inference (a 9B LLM, not a      │
│                        │ <50MB classifier — draw the distinction). │
├────────────────────────┼──────────────────────────────────────────┤
│ Reused ML metrics      │ precision@k / recall@k over eval/queries  │
│                        │ .json are the same metrics a classifier   │
│                        │ eval uses — already computed.             │
├────────────────────────┼──────────────────────────────────────────┤
│ Drift substrate        │ query + chunk embeddings in agents.chunks │
│                        │ — a PSI drift detector needs no trained   │
│                        │ model, just these distributions.          │
├────────────────────────┼──────────────────────────────────────────┤
│ Ranking surface        │ PgVectorStore.search cosine ranking is a  │
│                        │ content-based recommender seed (single    │
│                        │ user → no collaborative filtering).       │
└────────────────────────┴──────────────────────────────────────────┘
```

## The ML features table (honest)

```
ML features actually shipped

┌────────────────────┬────────────────┬────────────────┐
│ Feature            │ Model type     │ Inference loc. │
├────────────────────┼────────────────┼────────────────┤
│ (none — buffr trains and ships no ML model)          │
└──────────────────────────────────────────────────────┘
```

The closest things to "ML features" are the *consumed* models (generation, embeddings), which are covered as AI features in `ai-features-in-this-codebase.md`, not here, because buffr did not train them.

## What this means for study and for interviews

The interview signal in classical ML is having *trained* a model end-to-end — labeled data, feature engineering, train/val/test discipline, a confusion matrix, a deployment. Most candidates have only consumed pre-trained models; buffr, today, is in that majority. That is exactly why `08-machine-learning/` matters as a build path: the strongest single ML deliverable buffr can grow is a real supervised pipeline (start with the curriculum's Phase 2C build items), and the rarest, highest-signal one is **fine-tuning gemma2:9b on the captured trajectories** — the ceiling named in `08-machine-learning/07-transfer-learning.md`.

## See also

- `08-machine-learning/` — every classical-ML concept, taught as new ground with build exercises.
- `08-machine-learning/07-transfer-learning.md` — the fine-tuning ceiling, anchored to `agents.messages`.
- `08-machine-learning/13-quantization.md` — gemma2:9b as a quantized GGUF.
- `08-machine-learning/12-on-device-inference.md` — local inference via Ollama vs a true on-device classifier.
- `09-ml-system-design-templates/` — recommender / anomaly / object-detection interview reframes.
- `ai-features-in-this-codebase.md` — what buffr actually ships (the AI side).
