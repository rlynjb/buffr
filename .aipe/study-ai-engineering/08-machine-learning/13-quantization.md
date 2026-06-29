# Quantization

### *industry: quantization (model weight precision reduction) · type: the size/speed/quality trade you make by shrinking the numbers a model is made of*

## Zoom out

You keep saying "gemma2:9b runs on my laptop." Stop and ask *how*. A 9-billion-parameter model in full FP32 precision is ~36 GB of weights — that does not fit in your machine's memory, let alone its VRAM. It runs because Ollama hands you a *quantized* build: the same architecture, but the weights stored in 4-bit integers instead of 32-bit floats. You have been running a quantized model since day one and never made the trade yourself — Ollama made it for you. This file is about that trade, and where in a *training* pipeline you'd make it deliberately.

**The MLOps lifecycle, with the stage quantization lives in marked**
```
┌────────┐ ┌──────────┐ ┌───────┐ ┌───────┐ ┌────────┐ ┌─────────┐
│  Data  │►│ Features │►│ Split │►│ Train │►│ ★DEPLOY│►│ Monitor │
│        │ │          │ │       │ │       │ │ ★      │ │         │
└────────┘ └──────────┘ └───────┘ └───────┘ └───┬────┘ └─────────┘
                                                │   ◄── this file
                                  QUANTIZE: take the trained FP32/FP16 weights,
                                  re-express them in INT8 / INT4 so the model
                                  fits + runs faster on the target hardware
```
Quantization is a deploy-stage transform: training produces high-precision weights, and you compress them right before they go to the box that serves them.

## Structure pass

One axis runs through everything here: **numeric precision — how many bits encode each weight.** Drop bits, drop bytes; drop bytes, gain speed and shrink memory; drop too many bits, lose accuracy. That single dial is the whole topic.

**The one axis: the precision ladder, FP32 down to INT4**
```
 PRECISION        BITS/WEIGHT   REL. SIZE   TYPICAL USE
 ┌────────────┐
 │  FP32      │   32 bit         1.0x       training, reference math
 ├────────────┤                             (full precision)
 │  FP16/BF16 │   16 bit         0.5x       training + serving, near-lossless
 ├────────────┤                             ◄── half the bytes, ~same quality
 │  INT8      │    8 bit         0.25x      serving, small accuracy cost
 ├────────────┤
 │  INT4      │    4 bit         0.125x     serving on constrained HW  ★
 └────────────┘                             ◄── gemma2:9b on YOUR laptop lives here

   ┌──────────────────────── THE SEAM ────────────────────────┐
   │ FP16→INT8→INT4 each ~halves size + adds error. The trade  │
   │ is NOT linear: the LAST bits dropped cost the most quality.│
   └───────────────────────────────────────────────────────────┘
```
The seam: every step down the ladder is roughly 2x smaller, but the quality cost accelerates — INT4 is where you start to feel it, which is exactly where your laptop build sits.

## How it works

### Move 1 — Mental model

The mental model: **quantization is lossy compression for weights.** You take a wide continuous range of float values and *map* them onto a small grid of integers, storing a `scale` (and sometimes a `zero-point`) so you can approximately reconstruct the float at compute time. It's the same idea as turning a 24-bit photo into an 8-bit GIF — fewer distinct values, smaller file, visible-but-tolerable error.

**The pattern: map a float range onto an integer grid via a scale factor**
```
   FP32 weights (continuous)          INT4 grid (16 buckets)
   -0.41  -0.12  0.03  0.38  ...      ┌──┬──┬──┬──┬──┬──┬──┬──┐
        │     │    │    │             │-8│-6│..│ 0│..│ 6│ 7│  │
        ▼     ▼    ▼    ▼     ──map──► └──┴──┴──┴──┴──┴──┴──┴──┘
   each float snaps to the NEAREST bucket; store the bucket index (4 bits)
   + one shared `scale` per block to undo the mapping at runtime:
        reconstructed ≈ bucket_index * scale
                              │
                  the gap between float and reconstructed = QUANTIZATION ERROR
```
Every weight gets rounded to its nearest grid point; the accumulated rounding *is* the accuracy cost.

### Move 2 — Walk the mechanism

**Part 1 — Pick the precision target for the hardware budget.** The target is set by where the model must run. A 9B model in INT4 is ~5 GB; in FP16 it's ~18 GB. Your laptop forces INT4.

**Memory budget decides the rung you can afford**
```
   gemma2:9b weights, by precision:
     FP16  ≈ 18 GB ──► needs a datacenter GPU
     INT8  ≈  9 GB ──► high-end desktop GPU
     INT4  ≈  5 GB ──► fits a laptop ★  ◄── Ollama picks this for you (Q4_K_M)
                          │
              the hardware budget, not preference, selects the rung
```

**Part 2 — Post-training quantization (PTQ): quantize an already-trained model.** No retraining. You take finished FP16 weights and convert them. Fast, cheap, and what Ollama's GGUF builds are. Illustrative pseudocode, not buffr code:

**PTQ — convert finished weights, no gradient steps (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Post-training quantization, per block.
def quantize_block_int4(weights_fp16):
    scale = weights_fp16.abs().max() / 7      # 7 = max INT4 magnitude
    q = round(weights_fp16 / scale).clip(-8, 7).astype(int4)
    return q, scale                            # store both; reconstruct at runtime
# no training data, no backprop — just a numeric re-encoding of the trained model
```

**Part 3 — Quantization-aware training (QAT): train WITH the rounding in the loop.** Instead of quantizing after, you simulate the rounding error during training so the model *learns weights that survive it*. More expensive, but recovers accuracy PTQ loses.

**QAT vs PTQ — when the rounding error enters the picture**
```
   PTQ:   [ train in FP16 ] ───────────────► [ quantize ] ► deploy
                                              error appears AFTER, uncorrected

   QAT:   [ train, simulating INT4 rounding every step ] ► [ quantize ] ► deploy
                  ▲                                         error was SEEN during
          model adapts to the grid as it learns            training, so it's smaller
```

**Part 4 — At inference, dequantize on the fly.** The INT4 weights are unpacked to float using the stored `scale` right before the matmul. The storage is 4-bit; the math still happens in float — you save *memory and bandwidth*, and bandwidth is usually the bottleneck, which is why it's also faster.

**Runtime: stored small, computed in float**
```
   INT4 weight (4 bits) ──► × scale ──► ≈ FP16 value ──► matmul ──► activation
        │                                                    │
   small in memory + cheap to move ─────────────────► fewer bytes moved = faster
```

### Move 2.5 — Current vs future

Right now, in buffr, quantization is **invisible and not yours.** Ollama serves a pre-quantized GGUF; you never chose the rung, never measured the cost.

**What buffr does today vs what the exercise adds**
```
   TODAY:  Ollama ──► gemma2:9b Q4_K_M (4-bit) ──► you just call it
            │  the quantization happened upstream; you inherited it blind

   FUTURE: YOU train a small model in ml/ ──► YOU quantize FP32→INT8
            │  ──► YOU measure the accuracy delta on eval/queries.json-style set
            └──► now you've MADE the trade, not just consumed it
```

### Move 3 — The principle

The principle: **quantization buys deployability with a quality loan, and you must measure the interest.** Fewer bits = smaller, faster, cheaper to serve — but every bit dropped is rounding error injected into every weight. The discipline is not "quantize" or "don't"; it's *quantize to the lowest rung that still passes your eval gate*, and prove it with a number, not a vibe.

## Primary diagram

**The full picture: precision ladder, the two quantization paths, and where YOUR laptop's gemma2:9b sits**
```
                    TRAINED MODEL (FP32 reference)
                            │
            ┌───────────────┴────────────────┐
            ▼                                 ▼
        PTQ (no retrain)                  QAT (retrain with rounding)
        cheap, fast                       expensive, higher accuracy
            │                                 │
            └───────────────┬─────────────────┘
                            ▼
              QUANTIZED WEIGHTS at a chosen rung:
              FP16 ── INT8 ── INT4
                       │        │
                       │        └─► gemma2:9b Q4_K_M  ◄── ★ YOU RUN THIS NOW
                       │            ~5GB, fits laptop, slight quality drop vs FP16
                       │            (Ollama quantized it — you didn't)
                       ▼
              GATE: does it still pass the eval set?
                    ┌──────────────┬───────────────┐
                    │ pass ► ship  │ fail ► climb  │
                    │              │ back up a rung│
                    └──────────────┴───────────────┘
```
Read it top to bottom: a high-precision model becomes a low-precision one via PTQ or QAT, and the rung you ship is the lowest one that still clears the eval gate — gemma2:9b on your machine is already at the bottom rung, chosen for you.

## Elaborate

A few things worth holding precisely:

- **Q4_K_M is a *format*, not just "4-bit."** The `K` means k-quants — a smarter scheme that mixes precisions inside a block (more bits for the weights that matter, fewer for the rest) and uses block-wise scales. That's why a well-built Q4 model loses far less quality than naive uniform 4-bit would. The `_M` is the "medium" size variant. You are running an *engineered* quantization, not a crude one.
- **Activations vs weights.** This file is about *weight* quantization, which is the big memory win. There's also *activation* quantization (INT8 activations for faster matmul on integer hardware) — separate axis, usually harder because activations have wilder ranges than weights.
- **Embeddings are a different beast.** Your `nomic-embed-text:v1.5` 768-dim vectors are stored as `vector(768)` floats in pgvector. Quantizing *those* (e.g. to int8 or binary embeddings) is a retrieval-side optimization — shrinks the index, speeds cosine search — and is a distinct topic from weight quantization. Don't conflate "quantize the model" with "quantize the embeddings."
- **You cannot quantize your way out of a bad model.** Quantization only ever *loses* quality relative to the FP16 baseline. If the FP16 model is wrong, INT4 is wrong and smaller. Quantization is a serving optimization, never a quality fix.

## Project exercises

### Exercise — Train a tiny model, quantize it, measure the cost

- **Exercise ID:** [B2C.13] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing.* This is genuinely new ground: buffr only consumes Ollama's already-quantized gemma2:9b, so to *make* the quantization trade yourself you first need a model you trained. Build a small supervised model in a new `ml/` dir (a tiny text classifier over a buffr-relevant label, e.g. "is this chunk profile-relevant"), then quantize it FP32 → INT8 with a PTQ pass, and report the size shrink and the accuracy delta on a held-out set.
- **Why it earns its place:** It converts "Ollama quantized my model" into "I quantized a model and measured what it cost." The interview signal is the *delta number* — most candidates have only ever inherited a quantized GGUF and can't tell you what the trade bought or cost.
- **Files to touch:** new `ml/train_classifier.py` (train + save FP32), new `ml/quantize.py` (PTQ to INT8 + save), new `ml/eval_quant.py` (size + accuracy before/after), output written alongside `eval/queries.json`-style labeled rows so the eval discipline matches buffr's.
- **Done when:** you can print a table: `FP32: X MB, acc Y` vs `INT8: X/4 MB, acc Y'`, and state in one sentence whether the accuracy drop is acceptable for the size win.
- **Estimated effort:** Medium — a day. The training is small; the discipline of measuring the delta honestly is the work.

### Exercise — Document gemma2:9b's quantization as a serving fact

- **Exercise ID:** [B2C.13b] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing,* and this one stays honest about that. Add a short serving-facts note (in `src/config.ts` comments or a `docs/serving.md`) that records: the model is gemma2:9b served by Ollama as Q4_K_M (4-bit), the approximate memory footprint, and the explicit statement that buffr *inherited* this quantization rather than performing it.
- **Why it earns its place:** It makes the invisible visible. Knowing your serving stack runs a 4-bit model — and being able to say why it fits the laptop — is the difference between operating a system and just typing commands at it.
- **Files to touch:** `src/config.ts` (where the model name lives), optional new `docs/serving.md`.
- **Done when:** a reader of your repo can learn, from your own notes, that the model is 4-bit-quantized, why, and that you didn't quantize it.
- **Estimated effort:** Small — under an hour. This is a documentation-of-reality task, not a build.

## Interview defense

**Q: "You run gemma2:9b on a laptop. How?"**
```
   ┌──────────────────────────────────────────────────────────┐
   │ FP32 9B ≈ 36GB ──no──► laptop                            │
   │ Ollama serves Q4_K_M (4-bit GGUF) ≈ 5GB ──yes──► laptop  │
   │ trade: ~3-4x smaller + faster, slight quality drop vs FP16│
   └──────────────────────────────────────────────────────────┘
```
Anchor: "It fits because Ollama hands me a 4-bit quantized build — I'm running a compressed model, and I didn't compress it."

**Q: "PTQ or QAT — when would you reach for each?"**
```
   PTQ: have trained weights, want cheap shrink ──► default, do this first
   QAT: PTQ dropped too much accuracy ──► retrain WITH rounding to recover
        (costs a training run; only worth it when the eval gate fails)
```
Anchor: "PTQ first because it's free; QAT only when the eval gate says PTQ cost too much."

**Q: "Have you ever actually made a quantization trade?"**
```
   consuming a quantized GGUF ◄── most candidates stop here
   training a model + quantizing it + measuring the delta ◄── the signal
```
Anchor: "Most candidates have only consumed pre-trained, pre-quantized models. Having trained one and measured the precision/accuracy trade myself is the signal — that's exactly the [B2C.13] exercise."

## See also

- ./12-graphrag.md is in retrieval; the sibling ML files: ./12-* in this dir context — see ./14-training-run-logging.md (logging the quantized artifact + its eval as part of a run), ./15-drift-detection.md, ./16-retraining-pipelines.md.
- ../03-retrieval-and-rag/04-vector-databases.md — embedding quantization (a different axis: shrinking the pgvector index, not the model).
- ../05-evals-and-observability/01-eval-set-types.md — the eval gate that decides which quantization rung is shippable.
- ../06-production-serving/02-llm-cost-optimization.md — quantization as a serving-cost lever.
- ../09-ml-system-design-templates — where a deploy-time quantization step slots into a system-design answer.
