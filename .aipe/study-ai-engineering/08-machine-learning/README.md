# 08 · Machine Learning

> Classical, model-training ML — the one sub-section where buffr is *not* the worked example, because **buffr trains nothing.**

State it plainly, up front, with no hedging: **buffr does not train, fine-tune, or fit a single model.** It *consumes* two pre-trained models served by Ollama — `gemma2:9b` for generation and `nomic-embed-text:v1.5` for 768-dim embeddings — and wires them into a retrieval pipeline. That is AI-*application* engineering. It is not classical supervised machine learning, and pretending otherwise would teach you the wrong instincts.

So this sub-section is **all new ground.** Every concept here is **Case B** — "Not yet implemented; buffr trains nothing" — and the **Project exercises are the primary buildable target**, not an afterthought. You've shipped exactly one ML pipeline before (contrl pose-landmarking — a supervised vision model). That gives you the *shape* of "data in, fit, predict out." It does **not** give you the classical-ML toolkit: feature engineering, split discipline, class imbalance, calibration, drift. Those are the gaps these sixteen files fill, taught as study material that's correct on its own terms.

```
08-machine-learning/                  ALL CASE B — buffr trains nothing
│
│  THE PIPELINE ──► QUALITY LEVERS ──► EVALUATION ──► PRODUCTION ──► SERVING
│
├── 01-supervised-pipeline.md     ◇ Data→Features→Split→Train→Deploy (the spine)
├── 02-feature-engineering.md     ◇ raw → numeric features (60–80% of quality)
├── 03-train-val-test.md          ◇ split discipline; leakage at the unit boundary
├── 04-model-selection.md         ◇ LR vs GBT; pick the simpler if comparable
│
├── 05-class-imbalance.md         ◇ accuracy lies; macro-F1, recall, class weights
├── 06-domain-gap.md              ◇ train vs inference distribution mismatch
├── 07-transfer-learning.md       ◇ pretrain → fine-tune  ◄ HONEST HOOK (gemma)
│
├── 08-confusion-matrices.md      ◇ read one; derive per-class P/R/F1
├── 09-calibration.md             ◇ predicted prob vs actual frequency
│
├── 10-recommender-systems.md     ◇ content vs collaborative vs hybrid
├── 11-cold-start.md              ◇ new user / new item / new system
│
├── 12-on-device-inference.md     ◇ server vs on-device  ◄ HONEST HOOK (Ollama-local)
├── 13-quantization.md            ◇ FP32→INT4  ◄ HONEST HOOK (gemma is quantized GGUF)
│
├── 14-training-run-logging.md    ◇ what to log per run  ◄ HONEST HOOK (SupabaseTraceSink)
├── 15-drift-detection.md         ◇ PSI; train vs prod distribution
└── 16-retraining-pipelines.md    ◇ scheduled / drift / performance triggers

  ◇ = named gap, primary build target (Case B).  There is no ★ in this section.
```

## The four honest hooks (real, named, not invented)

buffr trains no classifier — but four *adjacent* facts are real, and each file that touches one names it honestly instead of overclaiming:

- **Transfer learning** (`07`) — the embeddings buffr serves *are the output of a transfer-learned model*. `nomic-embed-text` was pretrained on the open web, then contrastively tuned. The realistic ceiling for buffr is **fine-tuning gemma on captured trajectories** — `agent-layer-plan.md` already states the thesis: "capture every conversation as a trajectory now so fine-tuning is *answerable* later." That corpus lives in `agents.messages`. It is a fine-tuning dataset that does not yet train anything.
- **Local inference** (`12`) — buffr **already runs its models locally** via Ollama. That's on-machine inference, with the privacy/offline/latency profile this file teaches — but it is a 9B LLM, *not* a sub-50MB on-device classifier. The file draws that distinction sharply.
- **Quantization** (`13`) — `gemma2:9b` as Ollama serves it is **already quantized** (GGUF, typically 4-bit). You're running a quantized model right now. The file names exactly what that buys and costs.
- **Run logging** (`14`) — `SupabaseTraceSink` writing to `agents.messages` is the **analogous capture pattern** for LLM runs. It logs the same *category* of artifact a training-run logger would (inputs, outputs, the trace), so it's the closest thing buffr has to MLflow — for inference, not training.

And one reused-metrics fact: the **precision/recall** numbers buffr's eval harness computes over `eval/queries.json` (P@1, R@3) **are ML evaluation metrics already in the repo.** `08-confusion-matrices.md` and `05-class-imbalance.md` reuse that exact vocabulary — you're not learning precision/recall from scratch, you're connecting a metric you already compute to the matrix it comes from.

The example *category* for "what a trained classical-ML pipeline looks like" is contrl pose-landmarking — that's the SHAPE to hold in mind throughout. We anchor the shape, not the code.

## Reading order

Read in number order. The arc is: build the pipeline (`01`–`04`), the levers that decide quality (`05`–`09`), the two recommendation/coldstart files that are the most buffr-plausible new feature (`10`–`11`), then how a trained model ships and stays healthy (`12`–`16`).

1. **`01-supervised-pipeline.md`** — the five-stage spine. Read first; every other file is one stage of it. "Most ML bugs in classical ML are data/feature bugs, not model bugs."
2. **`02-feature-engineering.md`** — raw signal → numeric features. The 60–80% of model quality that lives *before* the model.
3. **`03-train-val-test.md`** — split discipline and leakage. Split at the unit the model meets *new* at inference, or your metrics lie.
4. **`04-model-selection.md`** — logistic regression vs gradient-boosted trees; the bias toward the simpler model when scores tie.
5. **`05-class-imbalance.md`** — why accuracy lies, and the macro-F1 / per-class-recall / confusion-matrix / class-weight toolkit.
6. **`06-domain-gap.md`** — train-vs-inference distribution mismatch; the silent killer of "great in the notebook, bad in prod."
7. **`07-transfer-learning.md`** — pretrain → fine-tune. **The fine-tuning hook for gemma lives here.**
8. **`08-confusion-matrices.md`** — read the matrix, derive every per-class metric. Connects to buffr's existing P@1/R@3.
9. **`09-calibration.md`** — when the *probability* must be trustworthy, not just the label.
10. **`10`–`11` (recommenders → cold start)** — the single-user, content+rules recommender is the most realistic *new* ML feature buffr could grow.
11. **`12`–`13` (on-device → quantization)** — how a trained model gets small and fast enough to serve. Both name buffr's real Ollama-local, quantized-gemma reality.
12. **`14`–`16` (run logging → drift → retraining)** — production hygiene: log every run, watch the distribution, decide when to retrain.

If you read only one file, read **`01-supervised-pipeline.md`** — it's the spine, and it makes the honest gap concrete: buffr has the *deploy* and *inference* end (Ollama) but none of the data/feature/split/train end, which is exactly the half you've never built.

## Phase anchor

The driving exercises span the back half of the curriculum, because they build the thing buffr lacks:

> **Phase 2C — stand up a real classical-ML pipeline** ([B2C.x])
> Build one supervised pipeline end-to-end in a new `ml/` dir, against a labeled set you control — turning `eval/queries.json` and/or `agents.messages` into a training problem (e.g. a retrieval-quality or query-intent classifier). Feature engineering, split discipline, model selection, imbalance handling, a confusion matrix, calibration, and a logged run.

> **Phase 3 / Phase 5 — productionize and serve** ([B2C.x], later phases)
> Quantize a small model for on-device serving, log every run, detect drift against the prod distribution, and wire a retraining trigger. The fine-tuning-gemma-on-trajectories exercise is the ceiling, gated on Phase-3 trajectory volume — exactly as `agent-layer-plan.md` frames it.

**The honest state, stated plainly:** buffr *serves* pre-trained models and *captures* the data that could one day train one. It has the deploy/inference end and a latent labeled corpus. It has **no** training code, **no** feature pipeline, **no** model selection, **no** evaluation-of-a-trained-model, **no** drift detection. Those aren't failures — they're the clean Case B seams this sub-section exists to teach, and every exercise here builds a piece you could honestly add.

## Cross-links

- **`../03-retrieval-and-rag/`** — `01-embeddings.md`: the 768-dim vectors buffr retrieves over **are the output of a learned model.** Embeddings ARE applied ML; this section is where you learn what producing such a model entails. `07-transfer-learning.md` here is the upstream of that embedding model.
- **`../05-evals-and-observability/`** — `eval/queries.json` is a **labeled set**; P@1 and R@3 are **ML evaluation metrics already computed.** `08-confusion-matrices.md` and `05-class-imbalance.md` reuse that exact vocabulary. `14-training-run-logging.md` extends `04-llm-observability.md`'s SupabaseTraceSink capture pattern from inference to training.
- **`../09-ml-system-design-templates/`** — the system-design framing of everything here: how a training pipeline, a feature store, a serving path, and a retraining loop fit into an architecture. Read that *after* these concepts so the boxes have content.
- **`../../study-data-modeling/`** — `agents.messages` as a fine-tuning corpus is a data-modeling question first: what schema captures a trajectory cleanly enough to train on.
