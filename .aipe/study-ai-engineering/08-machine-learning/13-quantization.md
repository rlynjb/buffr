# Quantization — shrinking model weights to lower precision

*Model quantization / post-training quantization (PTQ). Industry standard. buffr quantizes nothing itself — but it RUNS an already-quantized model (gemma2:9b ships as a Q4 GGUF via Ollama), so it benefits from quantization at the serving layer without ever performing it.*

## Zoom out, then zoom in

A 9-billion-parameter model in full precision is ~36 GB of weights. Your laptop can't hold that, let alone run it fast. Quantization is the trick that makes a 9B model fit and run on consumer hardware at all — and buffr leans on it completely, even though buffr never runs a quantizer. The quantization already happened upstream: the model Ollama hands buffr is *already* shrunk.

```
  Zoom out — where quantization sits in buffr's stack

  ┌─ buffr app layer ───────────────────────────────────────────┐
  │  pipeline.query() → agent → search_knowledge_base tool       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  HTTP to localhost:11434
  ┌─ Ollama serving layer ────────▼──────────────────────────────┐
  │  loads gemma2:9b weights into RAM, runs inference            │
  │  ★ QUANTIZATION lives HERE ★  weights ship as Q4_K_M GGUF    │ ← we are here
  │  (already quantized upstream — buffr is a CONSUMER)         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ Hardware layer ──────────────▼──────────────────────────────┐
  │  laptop RAM / CPU / GPU — finite, small                      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **quantization** maps a model's floating-point weights (FP32 / FP16) down to smaller integer types (INT8, INT4), trading a little quality for a lot of size and speed. **Post-training quantization (PTQ)** does this *after* the model is trained — no retraining, just a one-pass conversion. buffr never sees that conversion: it pulls `gemma2:9b`, and the weights arrive already in 4-bit form. The win is real and load-bearing for buffr's local-first design — buffr just didn't earn it.

## Structure pass

**Layers:** the precision ladder (FP32 → FP16 → INT8 → INT4) → the conversion step (PTQ vs QAT) → the served model.

**Axis — "how many bits per weight, and what does that buy?"** Trace one number — bits-per-weight — down the ladder and watch size, speed, and quality all move together.

```
  trace "bits per weight" across the precision ladder

  ┌─ FP32 ──────┐  32 bits  baseline  size ×1     quality 100%   (training default)
  ├─ FP16/BF16 ┤  16 bits  half      size ×0.5   quality ~100%  (near-lossless)
  ├─ INT8 ──────┤   8 bits  quarter   size ×0.25  quality ~98%   (small drop)
  └─ INT4 ──────┘   4 bits  eighth    size ×0.125 quality ~95%   (gemma2:9b ships HERE)

  fewer bits → smaller + faster → but quality erodes
```

**The seam:** the boundary between "model author / Ollama packager" and "buffr". The bits-per-weight decision flips across it — upstream, someone chose Q4_K_M; downstream, buffr just runs whatever arrives. buffr can *select* a quant level (pull `gemma2:9b-instruct-q8_0` instead) but it never *performs* the quantization. That seam is exactly where buffr's honest relationship to quantization lives: consumer, not producer.

## How it works

### Move 1 — the mental model

You already know what happens when you store a `float` as an `int` — `3.7` becomes `3`, and the `.7` is gone. Quantization is that, done deliberately and reversibly: pick a scale so a whole *range* of floats maps onto a small set of integer buckets, store the integers, and keep the scale around so you can approximately reconstruct the floats at compute time.

```
  the kernel — float range → integer buckets

  FP32 weights (continuous)        INT4 buckets (16 levels: -8..+7)
  -0.42 ─┐                          ┌─► bucket  -6
  -0.39 ─┤  ─── quantize ───►       ├─► bucket  -6   (both round here)
   0.01 ─┤   q = round(w/scale)     ├─► bucket   0
   0.58 ─┘   w' = q * scale         └─► bucket   8

  store: the int buckets (4 bits each) + ONE scale per group
  reconstruct: w' = bucket * scale   (approximate — the error is the quality loss)
```

The whole game is: how few bits can you use before `w'` drifts far enough from `w` that the model's outputs get worse.

### Move 2 — the step-by-step walkthrough

**The scale + zero-point: how floats map to integer buckets.** A quantizer needs two numbers per group of weights: a **scale** (how wide each bucket is) and a **zero-point** (which integer represents 0.0). Given those, every weight quantizes with one formula and dequantizes with its inverse.

```
  quantize / dequantize — the arithmetic

  scale     = (max_w - min_w) / (q_max - q_min)   // bucket width
  zero_pt   = round(q_min - min_w / scale)         // integer for 0.0

  quantize:    q  = round(w / scale) + zero_pt     // float → int bucket
  dequantize:  w' = (q - zero_pt) * scale          // int bucket → approx float

  example (INT8, q range -128..127):
    weights in [-0.4, +0.6]  → scale = 1.0/255 ≈ 0.0039
    w = 0.58  → q = round(0.58/0.0039) = 149 → clamps to 127
    w' = 127 * 0.0039 ≈ 0.495   // 0.58 stored as 0.495 — that gap is the loss
```

Pseudocode for a single group:

```
  // input:  group of FP32 weights
  // output: int buckets + the scale to rebuild them
  function quantize_group(weights, bits):
    q_max = 2^(bits-1) - 1          // e.g. INT4 → +7
    q_min = -2^(bits-1)             // e.g. INT4 → -8
    scale = (max(weights) - min(weights)) / (q_max - q_min)
    buckets = []
    for w in weights:
      q = round(w / scale)          // map float onto an integer level
      q = clamp(q, q_min, q_max)    // outliers get pinned to the edge ← loss source
      buckets.append(q)
    return buckets, scale           // store both; weights are now `bits` bits each
```

**PTQ vs QAT: when the conversion happens.** There are two times you can quantize, and they trade effort for quality.

```
  two conversion strategies

  ┌─ Post-Training Quantization (PTQ) ──────────────────────────┐
  │  train in FP32  →  ONE-PASS convert to INT4  →  ship         │
  │  cheap, no retraining. gemma2:9b's GGUF is PTQ.             │
  │  quality: good enough for most; worst on outlier-heavy nets │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Quantization-Aware Training (QAT) ─────────────────────────┐
  │  SIMULATE int rounding DURING training → weights adapt       │
  │  expensive (full training run), recovers most lost quality   │
  └──────────────────────────────────────────────────────────────┘
```

buffr's model is PTQ — the cheap path. Nobody retrained Gemma to be 4-bit-friendly; they trained it in high precision and squeezed it afterward. That's why a tiny quality dip is expected and accepted.

**Per-tensor vs per-channel: how big a group shares one scale.** The grouping decision is where Q4_K_M earns its `_K`. One scale for an entire weight tensor is cheap but coarse — a single fat outlier stretches the scale and wastes resolution on everyone else. One scale *per channel* (or per small block, the "K" block-quant scheme Ollama ships) keeps outliers contained.

```
  grouping granularity — who shares a scale?

  per-tensor:   [ all weights in layer ]  → 1 scale   coarse, 1 outlier ruins it
  per-channel:  [ ch0 ][ ch1 ][ ch2 ]...   → 1 scale each   finer, outlier-contained
  per-block(K): [b0][b1][b2][b3]...         → 1 scale per ~32 weights   finest, Q4_K_M
```

**Where the quality loss actually comes from: outlier weights.** Most weights cluster near zero; a few are large. Those outliers stretch the scale so the dense middle gets crushed into too few buckets. That's the real reason INT4 hurts more than INT8 — fewer buckets, less room to both reach the outliers *and* resolve the middle. Block-quant (per-K-block scales) is the standard mitigation, and it's exactly what `Q4_K_M` is.

### Move 2.5 — current state vs future state

```
  Phase A (today)                        Phase B (if buffr engaged quantization)
  ─────────────                          ──────────────────────────────────────
  pulls gemma2:9b (Q4_K_M, fixed)        measures quant levels on its OWN eval
  takes whatever Ollama ships            picks the quant by a quality FLOOR
  no measurement of the tradeoff         (QUANT-1/QUANT-2 below)
  CONSUMER of quantization               INFORMED consumer — still no quantizer
```

The honest takeaway: buffr never has to *build* a quantizer to engage quantization well. The lever it actually owns is *selection* — which pre-quantized GGUF to pull — and it currently pulls the default blind.

### Move 3 — the principle

Quantization is the reason a 9B model runs on a laptop at all — and it's a serving-layer concern, not a training-layer one. You can consume the entire benefit (8× smaller weights, faster inference) by pulling an already-quantized model and never touching a quantizer. The skill that remains for a consumer is *choosing the precision floor*: the lowest bit-width that still clears your quality bar. buffr gets the benefit for free and hasn't yet exercised the choice.

## Primary diagram

```
  buffr and quantization — the full picture

  ┌─ UPSTREAM (not buffr) ──────────────────────────────────────┐
  │  Gemma trained in FP32/BF16                                  │
  │      │  PTQ one-pass conversion (per-K-block scales)         │
  │      ▼                                                       │
  │  gemma2:9b Q4_K_M GGUF  (~5.4 GB vs ~36 GB FP32)            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  ollama pull / ollama run
  ┌─ Ollama serving layer ────────▼──────────────────────────────┐
  │  loads 4-bit weights → dequantizes on the fly → inference   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  HTTP localhost:11434
  ┌─ buffr (CONSUMER) ────────────▼──────────────────────────────┐
  │  benefits: fits in RAM, runs fast — chose nothing, ran it    │
  │  lever buffr OWNS but doesn't use: pick the quant level      │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is one of buffr's strongest genuine connections to classical ML infrastructure, and the honesty cuts both ways. The win is real: `gemma2:9b` is unusable on a laptop in FP32 (~36 GB), comfortable in Q4_K_M (~5.4 GB). buffr's entire local-first, no-cloud-API design depends on that 8× shrink — pull quantization out and the architecture collapses to "call a hosted API," which is a different project. So quantization is load-bearing for buffr in the most literal sense.

But buffr neither chose nor performed it. The quantization happened in someone else's pipeline; Ollama packages the GGUF; buffr runs `ollama run gemma2:9b` and inherits Q4_K_M as a default it never evaluated. That makes buffr a *consumer* of quantization at the serving layer — the same relationship it has to the model weights themselves. The one lever buffr genuinely owns is selection (`gemma2:9b-instruct-q8_0` vs the Q4 default), and it pulls the default blind.

This ties directly to on-device inference: quantization is *what makes* serving a 9B model on a laptop possible. The two concepts are the same fact seen from two angles — "the model is small enough to fit" (quantization) and "the model runs locally" (on-device inference). buffr's prior ML experience (a MediaPipe pose-landmarking pipeline feeding an on-device rep counter) rhymes faintly here — that pipeline also ran a pre-built model on-device — but pose-landmarking models are tiny and the quantization tradeoff never bit. A 9B LLM is where quantization stops being academic.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Measure the quant-level tradeoff curve on buffr's eval

- **Exercise ID:** QUANT-1 (Case B — quantization measurement not yet exercised). **The lead quantization exercise.**
- **What to build:** a script that pulls `gemma2:9b` at three quant levels (Q4_K_M, Q8_0, FP16), runs each against buffr's offline eval, and records size on disk, per-query latency, and answer quality, producing a size/speed/quality tradeoff table.
- **Why it earns its place:** buffr inherits Q4 as an unmeasured default; this turns "we run a quantized model" into "we know exactly what Q4 costs us versus Q8." The story is "I quantified the precision/quality tradeoff on my own eval set instead of trusting the default."
- **Files to touch:** new `scripts/quant-bench.ts` driving `ollama pull`/`ollama run`; reuse `src/cli/eval-cmd.ts` (`pipeline.query(q, K=3)`) and `eval/queries.json` as the fixed query set; record latency around the model call.
- **Done when:** a table reports {size, p50 latency, P@1 / answer-quality} for Q4 / Q8 / FP16 over `eval/queries.json`, with the tradeoff curve documented.
- **Estimated effort:** 1–2 days.

### Pick the quant level by a quality floor

- **Exercise ID:** QUANT-2 (Case B — quant selection by floor not yet exercised).
- **What to build:** a small selection rule on top of QUANT-1's data — choose the *lowest* precision whose quality on `eval/queries.json` still clears a stated floor (e.g. P@1 unchanged, answer-quality within X of FP16), and wire that chosen tag into buffr's model config.
- **Why it earns its place:** this is the one quantization lever buffr actually owns — selection — and exercising it converts a blind default into a justified choice with a measured floor.
- **Files to touch:** the model identifier wherever the Ollama model is named in buffr's config/generation path; `eval/queries.json` as the floor's test set; QUANT-1's output as the input data.
- **Done when:** buffr runs the lowest-precision quant that still passes the eval floor, with the floor and the decision recorded.
- **Estimated effort:** 4–8 hr.

## Interview defense

**Q: buffr runs a quantized model — did buffr quantize it?**
Answer: no, and that distinction matters. `gemma2:9b` ships from Ollama as a Q4_K_M GGUF — post-training-quantized upstream to ~4 bits per weight, with per-K-block scales to contain outliers. buffr pulls that file and runs it; it never runs a quantizer. So buffr is a *consumer* of quantization at the serving layer. The benefit is fully real — an 8× weight shrink is the only reason a 9B model fits in laptop RAM — buffr just inherited it rather than performing it.

```
  upstream PTQ → Q4_K_M GGUF  ──ollama pull──►  buffr runs it
  buffr's lever: SELECT the quant, never PERFORM it
```

**Q: Where does quantization quality loss come from, and why does INT4 hurt more than INT8?**
Answer: from rounding floats into a finite set of integer buckets, and specifically from *outlier weights*. Most weights cluster near zero, a few are large; the large ones stretch the per-group scale, so the dense middle gets crushed into too few buckets. INT4 has only 16 levels versus INT8's 256, so there's far less room to both reach the outliers and resolve the middle — that's why INT4 drops more quality. The standard fix, and exactly what `Q4_K_M` does, is per-block scales (one scale per ~32 weights) so a single outlier only stretches its own block. **The part people forget: it's not uniform rounding error — it's the outliers, and block-quant is the mitigation baked into the format buffr already runs.**

```
  many small weights + a few outliers → one scale stretched
  per-block scale (Q4_K_M) → outlier confined to its block → middle keeps resolution
```

## See also

- `14-training-run-logging.md` — the per-run logging discipline; pairs with quantization as the other "serving/ops" ML concern buffr touches.
- `07-transfer-learning.md` — fine-tuning Gemma, the upstream step you'd quantize *after*.
- `12-on-device-inference.md` — the sibling concept: quantization is *what makes* on-device serving of a 9B model possible.
- `../06-production-serving/02-llm-cost-optimization.md` — quantization as a serving-cost lever (smaller model, lower compute).
