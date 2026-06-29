# On-Device Inference

### *industry: on-device vs server inference · type: where the model runs, and what that buys and costs you*

## Zoom out

A trained model has to run *somewhere* when a request arrives — on a server you control, or on the user's own hardware. That single placement choice trades latency, privacy, offline capability, and cost against a hard ceiling on model size. This is the deployment file: the model is fixed; the question is *where it executes*. See it at the serving stage:

**The supervised pipeline, with the serving-placement choice marked**
```
┌────────┐  ┌──────────┐  ┌───────┐  ┌───────┐  ┌─────────────────────────────────────┐
│  Data  │─►│ Features │─►│ Split │─►│ Train │─►│ ★ SERVE — WHERE? ★                   │ ◄── this file
│        │  │          │  │       │  │       │  │  server  ◄──┬──►  on-device          │
└────────┘  └──────────┘  └───────┘  └───────┘  └─────────────┼───────────────────────┘
                                                              │
                            same trained model, two homes ────┘
                            different latency/privacy/cost/SIZE profile
```
Placement is a deployment decision made *after* training — the model doesn't change, only where its forward pass happens.

## Structure pass

One axis governs the tradeoff: **does the forward pass run on a remote server or on the local machine** — and the catch is that local execution caps how big the model can be.

**The one axis: server vs on-device, with the seam that constrains size**
```
   SERVER INFERENCE                       ON-DEVICE INFERENCE
   ┌──────────────────────┐               ┌──────────────────────┐
   │ model runs remotely   │               │ model runs LOCALLY    │
   │ + big models OK       │               │ + private (no upload) │
   │ + central updates     │               │ + works offline       │
   │ − network round-trip  │               │ + low/no per-call cost│
   │ − data leaves device  │               │ − model SIZE limited  │
   │ − per-call cost       │               │ − tied to local HW    │
   └──────────────────────┘               └──────────────────────┘

   ┌──────────────────────────────── THE SEAM ───────────────────────────────┐
   │ On-device buys privacy + offline + latency, but PAYS in model SIZE,       │
   │ bounded by local hardware. The classic mobile regime is a SUB-50MB        │
   │ classifier on a phone. buffr is a DIFFERENT on-device regime: a 9B LLM    │
   │ on a LAPTOP GPU via Ollama. Same VALUE, very different SIZE/HARDWARE.      │
   └───────────────────────────────────────────────────────────────────────────┘
```
The seam is size: on-device wins privacy and offline, but local hardware sets the ceiling — and that ceiling is wildly different for a phone classifier vs a laptop running gemma2:9b.

## How it works

### Move 1 — Mental model

The mental model: **on-device means the data never leaves the machine — the model travels to the data instead of the data traveling to the model.** Server inference ships your input over the network to where the model lives; on-device ships the model (once) to where your input lives, and every inference stays local.

**The data-flow inversion: who travels, the data or the model?**
```
   SERVER                                  ON-DEVICE
   input ──network──► [ model ]            [ model already local ]
                         │                        ▲
   result ◄─network──────┘                input ──┘  (never leaves)
                                          result stays local
   data CROSSES the network               data NEVER crosses
```
That inversion is the source of every on-device benefit — privacy, offline, and no round-trip latency all follow from the data staying put.

### Move 2 — Walk the mechanism

**Part 1 — Latency: on-device removes the network round-trip.** No request travels to a datacenter and back. Local inference is bounded by local compute, not by network conditions.

**Latency: round-trip vs local compute**
```
   SERVER:   |--net--|--queue--|--infer--|--net--|   ◄── network dominates, variable
   DEVICE:   |--infer (local)--|                     ◄── compute only, predictable
```

**Part 2 — Privacy: input never leaves the machine.** For sensitive data (personal notes, health, keystrokes), on-device means there's no upload to leak, intercept, or subpoena.

**Privacy: the boundary the data never crosses**
```
   ┌────────────── user's machine ──────────────┐
   │  input ─► [ local model ] ─► result          │   data stays INSIDE the box
   └──────────────────────────────────────────────┘
                     ▲ nothing crosses this boundary ─► nothing to leak server-side
```

**Part 3 — Offline + cost: no dependency on a reachable, billed endpoint.** Local inference works on a plane; it has no per-call API charge. The cost moves from per-request to one-time (the user's hardware + model download).

**Offline + cost: the dependency that disappears**
```
   SERVER:  needs reachable endpoint + pays per call ─► offline = DEAD, cost = ∝ calls
   DEVICE:  no endpoint, no per-call bill            ─► offline = WORKS, cost = one-time HW
```

**Part 4 — The price: model size is bounded by local hardware.** This is the constraint everything trades against. A phone fits a sub-50MB classifier; a laptop GPU fits a quantized 9B LLM; a microcontroller fits kilobytes. Illustrative, not buffr code:

**Size budget by device — the ceiling that forces the regime (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Placement gated by a size budget.
DEVICE_BUDGET = {
    "microcontroller": "kilobytes",     # tiny ML, quantized to int8
    "phone":           "< 50 MB",       # mobile classifier, the classic regime
    "laptop_gpu":      "several GB",     # quantized gemma2:9b lives HERE  ◄── buffr
}
def can_run_on_device(model_size, device):
    return fits(model_size, DEVICE_BUDGET[device])   # placement gated by SIZE, not desire
```

### Move 2.5 — current vs future

**Two on-device regimes — same value, different size class**
```
   CLASSIC MOBILE REGIME                    buffr's REGIME (ALREADY REAL)
   ┌────────────────────────────┐           ┌────────────────────────────────┐
   │ sub-50MB classifier on a    │           │ gemma2:9b + nomic-embed via      │
   │ phone CPU                    │   same    │ Ollama on a LAPTOP GPU            │
   │ privacy ✓ offline ✓ latency ✓│  VALUE    │ privacy ✓ offline ✓ latency ✓    │
   │ SIZE: tens of MB             │  diff     │ SIZE: GIGABYTES (9B params,      │
   │ HARDWARE: phone CPU          │  REGIME   │ quantized), laptop GPU/RAM        │
   └────────────────────────────┘           └────────────────────────────────┘
```
buffr already does on-device inference — but draw the distinction sharply: it's a 9B LLM on a laptop, not a tiny mobile classifier. The privacy/offline value is identical; the size and hardware regime is an order of magnitude apart.

### Move 3 — The principle

The principle: **choose on-device when privacy, offline, or per-call cost dominate — and accept the model-size ceiling your hardware imposes as the price.** The decision is never "on-device is better"; it's "the data is too sensitive to upload / the app must work offline / per-call cost is prohibitive, *and* a model small enough for this hardware is good enough." If the best model doesn't fit the device, you either quantize it down, accept lower quality, or go back to the server. Placement is a constraint-satisfaction problem, not a preference.

## Primary diagram

The full picture — the tradeoff, and the two on-device regimes with buffr's marked.

**On-device vs server, with buffr's already-real placement**
```
                 ┌────────────────────────────────────────────┐
                 │  privacy / offline / per-call cost matter?    │
                 └───────────────────────┬──────────────────────┘
              YES ───────────────────────┼─────────────────────── NO ─► SERVER (big models)
   ┌─────────────────────────────────────┴──────────────────────┐
   │                  ON-DEVICE — but does it FIT?               │
   └──────────────┬─────────────────────────────┬───────────────┘
                  ▼                             ▼
   sub-50MB phone classifier         several-GB laptop model
   (classic mobile regime)           ★ buffr: gemma2:9b + nomic via Ollama ★
                                          │
   ┌──────────────────────────────────────────────────────────────────────┐
   │ buffr ALREADY runs on-device: gemma2:9b (generation) + nomic-embed-text │
   │ (768-dim) locally via Ollama. Privacy + offline + no per-call API cost — │
   │ the on-device value profile, in the LAPTOP-GPU regime, NOT the sub-50MB  │
   │ mobile-classifier regime.                                                │
   └──────────────────────────────────────────────────────────────────────┘
```
buffr is the rare study-guide case where the concept isn't a gap — it's the running architecture, just at a different size class than the textbook example.

## Elaborate

The sharp edges:

- **Quantization is what makes big models fit small-ish hardware.** gemma2:9b runs on a laptop because it's quantized (int8/int4) — the same trick that shrinks a mobile classifier, applied to a 9B model. On-device at scale is mostly a quantization story.
- **On-device costs move from opex to capex.** No per-call API bill, but the user supplies the compute (GPU, RAM, battery, heat). For buffr that's your laptop's resources; for a phone app it's the user's battery. The cost didn't vanish — it relocated.
- **Updates are harder on-device.** A server model updates centrally and instantly; an on-device model has to be re-downloaded by every user. buffr re-pulls models via Ollama — a deliberate, local update, not a silent server push.
- **Latency is predictable but not always lower.** On-device removes network variance but is bounded by local hardware — a big local model on a weak GPU can be *slower* than a fast server. The win is privacy/offline/predictability, and only sometimes raw speed.
- **buffr's honest line — and this one is NOT a gap.** buffr already runs gemma2:9b and nomic-embed-text:v1.5 locally via Ollama. That *is* on-device inference: the data (your markdown, your queries) never leaves the machine, it works offline, and there's no per-call API cost — exactly the value this file teaches. The honest distinction to hold sharply: this is a 9B LLM on a laptop GPU, **not** the canonical sub-50MB on-device mobile classifier. Same value (privacy/offline/latency), different regime (size/hardware). buffr trains nothing — it's *consuming* pre-trained models locally — so the on-device story here is a serving-placement story, not a training one.

## Project exercises

### Profile buffr's local inference as an on-device serving decision

- **Exercise ID:** [B2C.12] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Make buffr's existing local serving *measurable as a placement choice*: instrument the Ollama calls (gemma2:9b generation, nomic-embed-text embedding) to record per-call latency, then write a comparison sheet against a hypothetical hosted-API alternative — latency, privacy (data leaves machine? no), offline (works? yes), and cost (per-call vs one-time hardware). Quantify the size regime: gemma2:9b's on-disk footprint vs the sub-50MB mobile-classifier baseline.
- **Why it earns its place:** It turns buffr's "we run models locally" from an implementation detail into an explicit, defended deployment decision with numbers — and forces you to articulate the regime distinction (laptop-GPU 9B vs phone-class classifier) that interviewers probe.
- **Files to touch:** new `ml/serving_profile.py` or instrumentation around the Ollama client in `src/runtime.ts`, reads model/timing from the call path, writes the comparison sheet to `ml/README.md`.
- **Done when:** real per-call latency for generation and embedding is recorded, a server-vs-on-device table is filled with buffr's actual values, and a note states the size regime (gigabytes, laptop GPU) explicitly versus the sub-50MB mobile baseline.
- **Estimated effort:** half a day to 1 day.

### Demonstrate the size/quality tradeoff by swapping a smaller local model

- **Exercise ID:** [B2C.12b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Swap gemma2:9b for a smaller quantized local model (e.g. a 2B or 3B class model via Ollama), re-run buffr's eval (`eval/queries.json`, P@1/R@3 plus a generation-quality spot check), and measure latency. Plot the size-vs-quality-vs-latency tradeoff — the exact curve that governs on-device model selection.
- **Why it earns its place:** It makes the model-size ceiling concrete on buffr's own hardware: you see directly what privacy/offline costs in quality when you shrink the model to fit a tighter budget — the core on-device tradeoff, measured rather than asserted.
- **Files to touch:** new `ml/size_tradeoff.py`, switches the model name in `src/config.ts`/`src/runtime.ts`, reruns `src/cli/eval-cmd.ts` over `eval/queries.json`, writes the tradeoff curve to `ml/README.md`.
- **Done when:** at least two model sizes are compared on retrieval/generation quality and latency, the curve shows the cost of shrinking, and a note states which model you'd ship on-device for a given quality bar and why.
- **Estimated effort:** 1 day.

## Interview defense

Most candidates have only consumed pre-trained models behind a hosted API — they've never made the placement decision. Having run a real model on-device (and reasoned about the size ceiling) is the signal.

**Q: When do you serve on-device instead of from a server?**
```
   privacy / offline / per-call-cost dominate ─► ON-DEVICE
        │  AND a model small enough for the hardware is good enough
        └─ else ─► SERVER (no size ceiling, but data leaves + per-call cost)
```
Anchor: on-device is a constraint decision — privacy/offline/cost win it, but the model must fit the local hardware budget.

**Q: buffr runs gemma2:9b locally — is that "on-device inference"?**
```
   YES — data never leaves the machine, works offline, no per-call API cost
        │
        └─ BUT regime ≠ mobile: 9B LLM on a LAPTOP GPU, not a sub-50MB phone classifier
           same VALUE (privacy/offline/latency), different SIZE/HARDWARE class
```
Anchor: yes, it's genuine on-device serving — the privacy/offline value is identical; the distinction is the size regime, laptop-GPU gigabytes vs phone-class megabytes.

**Q: How does a 9B model even fit on a laptop?**
```
   quantization (int8/int4) shrinks the weights ─► fits laptop GPU/RAM
        │
        └─ same trick that fits a mobile classifier on a phone, applied to 9B params
```
Anchor: quantization is what bridges model size to the local hardware budget — it's the mechanism that makes any on-device regime, mobile or laptop, possible.

## See also

- `./11-cold-start.md` — both are deployment-reality files: cold start is the data gap at launch, on-device is the placement gap at serving.
- `./09-calibration.md` — a score consumed on-device by a downstream threshold still needs to mean something.
- `../03-retrieval-and-rag/` — buffr's local Ollama embedding + generation path, the on-device inference this file describes.
- `../05-evals-and-observability/` — `eval/queries.json` and P@1/R@3, reused to measure the size/quality tradeoff when swapping local models.
- `../09-ml-system-design-templates/` — where "serve on-device for privacy/offline, bounded by size" becomes a documented serving-design choice.
