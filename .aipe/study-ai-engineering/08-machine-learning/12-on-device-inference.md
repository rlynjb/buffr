# On-device inference — edge serving vs server inference

*Industry standard (on-device / edge inference). buffr trains no model — but it serves its LLMs locally via Ollama, so the edge-inference properties (privacy, offline, no per-token cost) genuinely already hold.*

## Zoom out, then zoom in

Where inference runs decides almost everything about a system's cost, privacy, and latency profile — and there are two topologies: the request crosses the network to a GPU you rent, or it stays on the user's own machine. Most of this ML section is "buffr doesn't do this yet." This one is different. buffr trains no model, but it *runs* its models — gemma2:9b for generation, nomic-embed-text for embeddings — through Ollama on the user's laptop. So even with no training in sight, the on-device inference *properties* already describe buffr's serving. This is the strongest genuine rhyme in the section.

```
  Zoom out — buffr's inference topology is already on-device

  ┌─ Application (buffr CLI, local process) ────────────────────┐
  │  pipeline.query / agent.answer                              │
  └─────────────────────────┬───────────────────────────────────┘
                            │  HTTP to localhost (no internet hop)
  ┌─ Provider layer (Ollama, ON THE SAME MACHINE) ──────────────┐
  │  ★ gemma2:9b (generate)  ·  nomic-embed-text:v1.5 (embed) ★  │ ← we are here
  │     cfg.ollamaHost = http://localhost:11434                  │
  └─────────────────────────┬───────────────────────────────────┘
                            │  vectors / tokens, never leave the box
  ┌─ Storage (Postgres + pgvector, local) ──────────────────────┐
  │  agents.chunks.embedding · agents.messages                  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **on-device (edge) inference** runs the model where the data lives — no network round-trip, no per-token bill, data never leaves the machine, works offline. **Server inference** runs the model in a datacenter behind an API — bigger models, but every call crosses the network and egresses your data, costs per token, and dies without connectivity. buffr's serving lands squarely in the first column because Ollama listens on `localhost`. The model isn't *trained* on-device, but it's *served* on-device, and the properties that matter at serve time are the same.

## Structure pass

**Layers:** the application → the model runtime (local Ollama vs remote API) → the hardware the weights actually execute on.

**Axis — "does the request leave the machine?"** That single question separates the two topologies and drives every downstream property.

```
  trace "does the request leave the machine?" across the layers

  ┌─ application ────────┐   issues the call      (buffr: local CLI process)
  │  pipeline / agent     │   "where does it go?"
  └──────────────────────┘
  ┌─ runtime ────────────┐   on-device vs server  (buffr: Ollama on localhost)
  │  Ollama vs cloud API  │   "localhost or datacenter?"  → localhost
  └──────────────────────┘
  ┌─ hardware ───────────┐   where weights run    (buffr: user's own CPU/GPU)
  │  local GPU vs cloud   │   "whose silicon?"            → user's
  └──────────────────────┘
```

**The seam:** the network boundary between application and runtime. In a server setup that seam is the public internet — data egresses, latency includes a round-trip + queue, and every token is billed. In buffr that seam is `localhost`: the "network call" never leaves the box. The axis-answer ("does it leave?") flips from *yes* (server) to *no* (buffr), and every property — privacy, offline, cost — flips with it. That single seam is why buffr inherits the edge profile despite training nothing.

## How it works

### Move 1 — the mental model

You already know this tradeoff from where you put a database. A managed cloud DB scales huge but every query crosses the network and you pay per operation; SQLite-in-process is tiny by comparison but the query never leaves the machine, costs nothing per call, and works on a plane. On-device inference is the SQLite-in-process choice for a model: smaller model, but local, free-per-call, private, offline. Server inference is the managed-cloud choice: bigger model, but networked, metered, and online-only.

```
  Pattern — two inference topologies (the seam is the network boundary)

  SERVER INFERENCE                       ON-DEVICE (buffr)
  ┌─ app ─┐  request   ┌─ cloud GPU ─┐   ┌─ app ─┐ localhost ┌─ Ollama ─┐
  │ client│ ─────────► │  big model  │   │ buffr │ ────────► │ gemma2:9b│
  │       │ ◄───────── │  (metered)  │   │       │ ◄──────── │ (local)  │
  └───────┘  response  └─────────────┘   └───────┘           └──────────┘
       ▲ data egress, network in hot path        ▲ data stays, no internet hop
       ▲ per-token cost, needs connectivity       ▲ free per call, works offline
```

### Move 2 — the step-by-step walkthrough

Walk the five axes one at a time; each one flips across the network seam. For each, name what buffr concretely gets.

**Model size — server hosts huge, device must fit RAM/VRAM.** Bridge from deploying any binary: the cloud has effectively unlimited memory, the laptop has whatever's installed. Server inference runs 100B+ parameter models because the datacenter has the VRAM; on-device you're bounded by the user's hardware. buffr's gemma2:9b is *chosen for the constraint* — 9B parameters fit in a laptop's RAM where a 70B model wouldn't. The cost of going local is the ceiling on model size.

```
  Model size — the one axis where server WINS

  SERVER: 70B+ ─ datacenter VRAM, no local ceiling
  DEVICE: 9B   ─ must fit user RAM   ← buffr picks gemma2:9b to fit
```

**Latency — device has no network round-trip in the hot path; server adds network + queue.** Bridge from any API call you've timed: server inference latency is `network_out + queue_wait + compute + network_back`. On-device it's just `compute` — the call to `cfg.ollamaHost` (`http://localhost:11434`, `src/config.ts:14`) is a loopback, no internet hop, no provider queue. The compute itself may be slower on a laptop than on a datacenter GPU, but you delete the entire network-and-queue tax from the hot path, and you delete the variance that comes with it.

```
  Latency — what's in the hot path

  SERVER:  [net out]→[queue]→[compute]→[net back]   ← 3 taxes + variance
  DEVICE:  [compute]                                 ← buffr: localhost only
           Ollama call in src/cli/eval-cmd.ts:14 → no internet hop
```

**Cost — device is free per call after hardware; server bills per token / GPU-hour.** Bridge from a metered API: every server call is money, scaling linearly with tokens and traffic. On-device, the hardware is a sunk cost and every subsequent inference is free — buffr can embed every chunk and run gemma2:9b on every query at zero marginal cost. That's why an eval loop like `src/cli/eval-cmd.ts:24-32` can hammer the embedder over every query without a bill.

```
  Cost — marginal cost per inference

  SERVER: $ per token, scales with traffic   ─ embed 10k chunks = $$
  DEVICE: $0 per call after hardware          ─ buffr: free to over-embed
```

**Privacy — device keeps data on the machine; server egresses it.** Bridge from any third-party API: server inference means your prompt — here, the user's personal markdown and conversation history — leaves the machine and hits someone else's logs. On-device, none of it crosses the seam. buffr's personal notes (`agents.chunks`) and full conversation trajectories (`agents.messages`) are embedded and generated against entirely on the user's own box. The data-egress risk is structurally absent, not policy-mitigated.

```
  Privacy — does the user's data leave the box?

  SERVER: prompt + notes → provider logs        ← egress
  DEVICE: notes + conversations stay local       ← buffr: nothing egresses
          agents.chunks / agents.messages never cross the network seam
```

**Offline — device works with no network; server needs connectivity.** Bridge from a PWA that breaks on a plane: server inference is dead without a connection. On-device inference doesn't care — buffr's inference hot path is `localhost`, so it runs with the Wi-Fi off. (The one caveat: buffr's *storage* is Postgres, which may be remote; the inference path itself is local-first, but a fully-offline buffr would also need a local DB.)

```
  Offline — does it run with no internet?

  SERVER: no connection → no inference            ← hard dependency
  DEVICE: localhost inference runs offline         ← buffr: hot path is local
          (caveat: Postgres storage may still be remote)
```

**The load-bearing point: served-on-device, not trained-on-device.** Here's the honest framing. buffr trains nothing — gemma2:9b and nomic-embed-text are pre-trained weights pulled by Ollama. But the on-device *properties* are a serve-time phenomenon, and buffr serves locally. So "local-first LLM serving inherits the edge-inference profile" is exactly true: privacy, offline, no-per-token-cost all hold for buffr's serving today, with no training and no quantization-of-a-trained-model step in sight. The properties come from *where the weights run*, which is `cfg.ollamaHost` on the user's machine — not from how the weights were made.

```
  The framing — properties come from WHERE it runs, not HOW it was made

  trained on-device? ─ NO (Ollama pulls pre-trained gemma2:9b)
  served on-device?  ─ YES (cfg.ollamaHost = localhost)
       │
       ▼ and the edge PROPERTIES are serve-time:
  privacy ✓   offline ✓   no per-token cost ✓   ← buffr HAS these today
```

### Move 3 — the principle

The edge-inference profile — private, offline, free-per-call — is a property of *where the weights execute*, not of who trained them. A system that merely *serves* a pre-trained model on the user's machine inherits the entire profile; you don't need to train on-device, or even own the model, to get the privacy and offline guarantees that come from the request never leaving the box.

## Primary diagram

```
  Server vs on-device — five axes, and buffr's serve-time verdict

  axis          SERVER inference            ON-DEVICE (buffr, via Ollama)
  ───────────   ─────────────────────       ─────────────────────────────
  model size    100B+ (datacenter VRAM)      9B (must fit laptop RAM)   ← server wins
  latency       net + queue + compute        compute only (localhost)   ← device wins
  cost          $ per token / GPU-hour        $0 marginal after hardware ← device wins
  privacy       data egresses to provider     stays on the machine       ← device wins
  offline       needs connectivity            runs with Wi-Fi off        ← device wins

  buffr's seam: cfg.ollamaHost = http://localhost:11434  (src/config.ts:14)
  → request never leaves the box → 4 of 5 axes land in the edge column
  → trained on-device? NO.  served on-device? YES — and that's what gives the profile.
```

## Elaborate

The server-vs-edge inference split is the central deployment question in applied ML, and it sharpened as LLMs grew: frontier models are too large to run on consumer hardware, pushing them to server APIs, while a parallel track — quantization (4-bit/8-bit weights), distillation, and runtimes like **Ollama**, `llama.cpp`, and GGUF — works to shrink capable models down to laptop scale. buffr rides that second track: Ollama serves a 9B model locally precisely because the ecosystem made 9B good enough to be useful. The properties buffr gets — privacy, offline, zero marginal cost — are why local-first AI is a live architecture and not a toy, especially for *personal* data like notes and conversations, where egress is the whole risk. Worth naming the honest edges: model-size ceiling is the real cost (gemma2:9b is not gpt-class), and buffr's *storage* (Postgres) may still be remote, so "local-first" describes the inference path more cleanly than the whole system. The natural next step is graceful degradation — today an unreachable Ollama just throws; a production local-first app needs a fallback or a clear offline mode (see DEV-2). This file connects to **production serving** (`../06-production-serving`) as its cloud counterpart: same five axes, opposite column.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Measure local inference latency and prove the no-network property

- **Exercise ID:** DEV-1 (Case B — serving is local, but the edge properties are unmeasured). **The headline on-device exercise.**
- **What to build:** an instrument that times gemma2:9b first-token latency and nomic-embed-text embed latency against `cfg.ollamaHost`, and documents that the call is a `localhost` loopback with no internet hop in the hot path — turning the "edge profile" claim into numbers.
- **Why it earns its place:** it makes buffr's strongest real architectural property concrete (no network in the inference hot path, free per call) instead of asserted. The "I measured our local first-token latency and showed the hot path never leaves the box" story.
- **Files to touch:** new `src/bench/inference.ts`; reuse the `OllamaEmbeddingProvider` + `cfg.ollamaHost` setup from `src/cli/eval-cmd.ts:14`; read `ollamaHost` from `src/config.ts:14`.
- **Done when:** the bench prints first-token and embed latencies, and confirms (e.g. by inspecting the host) that the endpoint is `localhost`, not a remote API.
- **Estimated effort:** 4–8 hr.

### Design a graceful-degradation path for an unreachable Ollama

- **Exercise ID:** DEV-2 (Case B — today an unreachable Ollama just errors).
- **What to build:** detect when `cfg.ollamaHost` is unreachable and degrade gracefully — a clear offline-mode message, a retry/backoff, or an optional remote fallback provider — instead of throwing a raw connection error from the embedder/generator.
- **Why it earns its place:** local-first means the inference dependency is the user's own daemon, which can be down; a production edge app needs an offline story, not a stack trace. It's the missing reliability seam on the strongest property.
- **Files to touch:** wrap the Ollama providers constructed in `src/cli/eval-cmd.ts:14` (and the agent's generator); add a reachability check against `cfg.ollamaHost` from `src/config.ts:14`.
- **Done when:** with Ollama stopped, buffr reports a clear offline/degraded state (or falls back) instead of crashing with a connection-refused error.
- **Estimated effort:** 1 day.

## Interview defense

**Q: buffr trains no model — so why does on-device inference apply to it at all?**
Answer: because the edge properties are a *serve-time* phenomenon, and buffr serves locally. It runs gemma2:9b and nomic-embed-text through Ollama on the user's own machine — `cfg.ollamaHost` is `http://localhost:11434` (`src/config.ts:14`), so the inference call never leaves the box. That gives buffr the full edge profile today: privacy (the user's notes and conversations never egress), offline (the hot path is loopback), and zero per-token cost. Trained on-device? No. Served on-device? Yes — and that's where the properties come from.

```
  properties come from WHERE weights run (localhost), not HOW they were trained
```

**Q: What's the cost of going local, and where does buffr pay it?**
Answer: model size. The datacenter has unlimited VRAM and can host 70B+ models; a laptop can't, so buffr runs gemma2:9b — chosen to fit local RAM. You trade peak model quality for privacy, offline, and free-per-call inference. **The part people forget: latency is mixed, not purely a win — local *compute* can be slower than a datacenter GPU, but you delete the network round-trip, the provider queue, and their variance from the hot path, which is usually the bigger latency tax for a single interactive user.**

```
  give up: 70B model ceiling · keep: privacy + offline + $0/call · latency: lose net+queue, slower compute
```

## See also

- `09-calibration.md`, `10-recommender-systems.md`, `11-cold-start.md` — the other ML concepts that run over the same locally-served embeddings.
- `07-transfer-learning.md` — buffr consumes pre-trained weights (the input to local serving) rather than training its own.
- `../06-production-serving/README.md` — the server-inference counterpart: same five axes, opposite column.
- `../03-retrieval-and-rag/02-embedding-model-choice.md` — why nomic-embed-text:v1.5, the locally-served embedder timed in DEV-1.
