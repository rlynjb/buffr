# 08 — Machine Learning (classical, taught as new ground)

**Anchor:** classical supervised ML — the contrl-mo shape (one prior pipeline: MediaPipe pose-landmarking → on-device rep counter). **Curriculum:** Phase 2C / 3 / 5.

Read this first, because it changes how you read every file below:

**buffr trains no model.** It is a pure LLM application. It *consumes* two pre-trained models served by Ollama — `gemma2:9b` for generation, `nomic-embed-text:v1.5` for embeddings — and it never trains, fine-tunes, or evaluates a classical supervised model. There is no labeled training set (the 3-row `eval/queries.json` is an information-retrieval eval, not a model-training set), no feature engineering, no train/val/test split, no confusion matrix, no on-device classifier, no recommender, no quantization-of-a-trained-model step.

So this entire section is **study material taught as new ground**, plus **Case-B project exercises** that identify the ML features buffr *could* add. Every file's "in this codebase" reality is **Not yet implemented** — and the Project exercises become the primary buildable target. The concept teaching inside *How it works* is real ML, taught properly: features, splits, confusion matrices, calibration, drift PSI, quantization, all with diagrams.

```
  what this section is — and isn't

  ┌─ buffr (the only subject repo) ──────────────────────────────┐
  │  LLM app: Ollama (gemma2:9b gen, nomic-embed-text embeds)     │
  │  trains NO model · NO train/val/test · NO confusion matrix    │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ this section teaches ↓
  ┌─ classical ML — NEW GROUND ──▼────────────────────────────────┐
  │  pipeline · features · splits · selection · imbalance ·       │
  │  domain gap · transfer · confusion · calibration · recsys ·   │
  │  cold-start · on-device · quantization · run-logging ·        │
  │  drift · retraining                                           │
  │  → every file: "Not yet implemented" + Case-B exercise        │
  └───────────────────────────────────────────────────────────────┘
```

## The one genuinely ML-relevant fact about buffr

`agents.messages` captures the **full-signal trajectory** of every conversation — all six `CapabilityEvent` types (step, tool_call_start, tool_call_end, model_usage, warning, error), with deterministic replay order via `event.timestamp` (`src/supabase-trace-sink.ts`). That trajectory corpus is two things at once: the **fine-tuning corpus** a future trained model would learn from, and the **drift-monitoring substrate** a monitor would watch. The data exists; no model is trained on it. **Fine-tuning is buffr's ceiling — not done.**

The other attach points the exercises lean on:
- `agents.chunks.embedding` — `vector(768)` from nomic-embed-text (drift, re-embed cadence, the recsys content vectors).
- `src/cli/eval-cmd.ts` — the offline IR eval, the only labeled-pair file in the repo and the natural home for any scoring harness.

## Where buffr genuinely rhymes (the honest connections)

Four files carry a real connection, not a forced one. Read these for the strongest "this actually touches buffr" moment:

```
  the four genuine rhymes (still: nothing is trained)

  07 transfer-learning   → buffr's FT ceiling: agents.messages is the
                           small target set a future fine-tune would use
  12 on-device-inference → buffr IS local-first; Ollama's privacy/offline/
                           no-network-in-hot-path properties already apply
  13 quantization        → gemma2:9b ships as quantized GGUF via Ollama;
                           buffr benefits from quantization without doing it
  14 run-logging         → the trace sink is per-run trajectory logging —
                           the same DISCIPLINE applied to LLM runs
```

## Files

1. `01-supervised-pipeline.md` — Data → Features → Split → Train → Deploy; what each of the 5 stages owns. *Most classical-ML bugs are data/feature bugs.*
2. `02-feature-engineering.md` — raw signal → engineered features; features contribute 60–80% of result, the model ~10%.
3. `03-train-val-test.md` — split discipline and leakage; split at the unit the model sees as new at inference (session-level, not row-level).
4. `04-model-selection.md` — logistic regression vs gradient-boosted trees; train both, compare on val, pick the simpler if comparable.
5. `05-class-imbalance.md` — why accuracy lies; macro-F1, per-class recall, confusion matrix; class weights / oversampling / SMOTE / focal loss / threshold move.
6. `06-domain-gap.md` — train/inference distribution mismatch; domain adaptation, normalization, augmentation.
7. `07-transfer-learning.md` — pretrain on big set, fine-tune on small target set. **buffr's FT-ceiling rhyme.**
8. `08-confusion-matrices.md` — read one; per-class precision/recall/F1 derived; diagonal = correct.
9. `09-calibration.md` — predicted probability vs actual frequency; reliability diagram; Platt / isotonic; matters when downstream code uses the probability. buffr's cosine scores are uncalibrated similarity, not probabilities.
10. `10-recommender-systems.md` — content vs collaborative vs hybrid; single-user buffr = content + rules only (collaborative needs a population).
11. `11-cold-start.md` — new user / new item / new system; mitigations.
12. `12-on-device-inference.md` — server vs on-device tradeoffs. **buffr IS local-first — privacy/offline already apply.**
13. `13-quantization.md` — FP32 / FP16 / INT8 / INT4 size–speed–quality tradeoff. **gemma2:9b is already quantized GGUF via Ollama.**
14. `14-training-run-logging.md` — what to log per run (data/feature/model version, metrics, confusion matrix, git commit). **The trace sink is the same discipline for LLM runs.**
15. `15-drift-detection.md` — PSI over feature distributions; PSI < 0.1 ok / < 0.2 investigate / > 0.2 retrain. Case B: PSI over buffr's embedding distribution.
16. `16-retraining-pipelines.md` — scheduled vs drift-triggered vs performance-triggered. Case B: re-embed cadence / fine-tune trigger on trajectory volume.

## How to read this section

You've built exactly one ML pipeline before (contrl: MediaPipe pose-landmarking → on-device rep counter). That gives you the *shape* of "signal in → features → decision out, on-device." These files teach classical ML **beyond** that as new ground — they'll occasionally note where a concept rhymes with that pose pipeline, but buffr is the only subject. Read `01` first (the spine every other file hangs off), then `02`/`03` (where the bugs actually live), then sweep the rest. The four rhyme files (`07`, `12`, `13`, `14`) are where you'll feel buffr in the room.

## See also

- `../ml-features-in-this-codebase.md` — the section-level honesty statement and the candidate-ML-surface table.
- `../09-ml-system-design-templates/` — the "reframe buffr as an ML system" interview prompts, every "applies?" bullet answered honestly.
- `../05-evals-and-observability/04-llm-observability.md` — the trajectory trace that is the FT corpus and drift substrate.
