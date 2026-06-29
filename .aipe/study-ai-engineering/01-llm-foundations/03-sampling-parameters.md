# Sampling Parameters

*Decoding parameters — temperature / top-p / top-k — Industry standard.*

## Zoom out, then zoom in

`01-what-an-llm-is.md` ended on a fact: the model's output is *sampled*, so the same prompt can give different answers. Sampling parameters are the dials on that pick. buffr leaves them at Gemma's defaults — it sets none in `src/` — which for a grounded RAG agent is a missed lever. Here's where the dials *would* sit.

```
  Zoom out — where the sampling dials live (and don't, in buffr)

  ┌─ Agent layer ───────────────────────────────────────┐
  │  RagQueryAgent.answer → runAgentLoop                  │
  └──────────────────────────┬───────────────────────────┘
                             │  ModelRequest {system, messages, tools}
  ┌─ Provider layer ─────────▼───────────────────────────┐
  │  GemmaModelProvider.complete → this.chat({...})       │
  │     options?: { ★ temperature / top_p / top_k ★ }     │ ← the dials go HERE
  │     buffr passes NONE → Ollama/gemma2:9b defaults     │   (currently empty)
  └──────────────────────────┬───────────────────────────┘
                             │  HTTP /api/chat
  ┌─ Ollama / gemma2:9b ─────▼───────────────────────────┐
  │  next-token sampling, using whatever defaults apply   │
  └──────────────────────────────────────────────────────┘
```

Zoom in: at each next-token step the model produces a *ranking* over the whole vocabulary. Sampling parameters decide how that ranking becomes a single pick. **Temperature** flattens or sharpens the ranking; **top-k** keeps only the k highest; **top-p** keeps the smallest set whose probabilities sum past p. For a RAG agent that should parrot retrieved facts, you want the pick *boring and repeatable* — low temperature. buffr doesn't set that today, so this file is mostly study plus a Case-B exercise to expose it.

## Structure pass

The dials would live at one layer, but they shape behavior at another. Trace the axis **how much randomness is allowed?** across the seam.

```
  Axis: "how random is the next token?" — across the request seam

  ┌─ Agent / app layer ──────────────────────┐
  │  decides INTENT: "be faithful to chunks" │  desired = LOW randomness
  └─────────────────────┬─────────────────────┘
                        │  seam: ModelRequest → chat options
  ┌─ Provider/Ollama ───▼─────────────────────┐
  │  actual SAMPLING happens here             │  actual = DEFAULT randomness
  │  (buffr passes no temperature)            │  (intent never reaches here)
  └───────────────────────────────────────────┘
```

The seam is the `this.chat({...})` call inside `GemmaModelProvider`. The app layer *knows* it wants faithful, low-variance answers — but that intent dies at the seam because buffr never encodes it as a `temperature` option. The axis "how random" should flip from "we want it low" above the seam to "it's low" below it; right now it flips to "whatever Gemma defaults to." That gap is the whole lesson of this file.

## How it works

#### Move 1 — the mental model

You know how `Math.random()` gives a uniform pick, but you sometimes want a *weighted* pick — bias toward certain outcomes? Sampling parameters are the weighting controls on the model's next-token pick. The strategy: **the model gives you a probability distribution; temperature/top-k/top-p reshape or truncate it before you draw one sample.**

```
  Pattern — three dials reshaping the same next-token distribution

  raw ranking for next token (after "The capital of France is"):
    Paris   ████████████████  0.82
    Lyon    ███               0.06
    France  ██                0.04
    a       ██                0.03  ... long tail ...

  temperature ↓ (e.g. 0.1): sharpen → Paris ~0.99  → near-deterministic
  temperature ↑ (e.g. 1.2): flatten → tail gets real odds → creative/risky

  top-k = 1:  keep only {Paris}                 → always Paris (greedy)
  top-p = 0.9: keep smallest set summing ≥ 0.9  → {Paris, Lyon} only
```

For RAG you want the left column: sharpen and truncate so the model picks the obvious, grounded token. For brainstorming you'd want the right.

#### Move 2 — the step-by-step walkthrough

**Where the dials would be passed.** aptkit's Gemma transport already has a slot for them — `options?: Record<string, unknown>` — but `complete` never fills it.

```
  GemmaChatTransport payload — gemma-provider.ts:19-25 (annotated)

  export type GemmaChatTransport = (payload: {
    model: string;
    messages: { role: string; content: string }[];
    stream: false;
    options?: Record<string, unknown>;   // ← temperature / top_p / top_k live HERE
    signal?: AbortSignal;
  }) => Promise<OllamaChatResponse>;
```

The slot maps straight onto Ollama's `options` object. Pass `{ temperature: 0.2 }` and Ollama honors it. The contract is ready; buffr just doesn't reach for it.

**Where the call is made — with the slot empty.** Look at the actual `this.chat({...})` in `complete`:

```
  GemmaModelProvider.complete — gemma-provider.ts:69-74 (annotated)

  lastResponse = await this.chat({
    model: this.defaultModel,
    messages,
    stream: false,                              // (non-streaming — see 05-streaming)
    ...(request.signal ? { signal: request.signal } : {}),
  });                                            // ← NO `options`. No temperature set.
```

No `options` key. So sampling runs at Ollama's / `gemma2:9b`'s defaults for every buffr call. There's also nothing in `src/session.ts` or `src/config.ts` that sets a temperature — confirmed by reading both. This is the honest gap: buffr's answers are as random as the default allows, even though a grounded knowledge assistant wants them tight.

**The one place a temperature *is* threaded — for contrast.** aptkit's `RubricJudge` (an eval component, not in buffr's hot path) does accept and pass a `temperature`. It's worth seeing so you know the plumbing exists.

```
  Layers-and-hops — temperature plumbed (judge) vs not (buffr loop)

  ┌─ RubricJudge (aptkit eval) ─┐  temperature ──► generateStructured
  │  options.temperature        │  ──────────────► model.complete(opts)   ✔ threaded
  └──────────────────────────────┘

  ┌─ buffr session loop ────────┐  (no temperature)
  │  GemmaModelProvider          │  ──────────────► chat({ ...no options }) ✗ default
  └──────────────────────────────┘
```

`rubric-judge.ts:64,99-104` carries `temperature` into `generateStructured`; buffr's loop carries none. Same provider interface, opposite choices — the judge cares about calibrated scoring, buffr (today) doesn't encode any preference.

#### Move 2.5 — current state vs future state

This concept is built-but-not-active in buffr's path: the slot exists, the value doesn't.

```
  Phase A (now) vs Phase B (Case B) — sampling control

  Phase A — TODAY                    Phase B — exposed temperature
  ┌──────────────────────────┐       ┌──────────────────────────────┐
  │ chat({ ...no options })  │       │ chat({ options: {            │
  │ temperature = default    │  ──►   │   temperature: cfg.temp(0.2) │
  │ answers vary run-to-run  │       │ }})  → grounded, repeatable  │
  └──────────────────────────┘       └──────────────────────────────┘
  what must change: pass an options object from config into the
  transport. What does NOT change: the provider interface, the loop,
  retrieval — all untouched.
```

The migration cost is tiny (one config field, one options object) because aptkit already exposes the slot.

#### Move 3 — the principle

Sampling parameters are where you encode *what kind of answer you want* — faithful and repeatable, or creative and varied. A grounded RAG agent wants low temperature so it parrots the retrieved facts instead of embroidering them. Leaving the dials at default isn't neutral; it's an unstated choice to accept whatever variance the model ships with. Name the choice, then set it.

## Primary diagram

```
  Sampling in buffr — the dials, present in the contract, absent in use

  next-token distribution (inside gemma2:9b)
        │
        │  reshaped by → temperature (sharpen/flatten)
        │                top-k       (keep k best)
        │                top-p       (keep cumulative p)
        ▼
  ┌─ Provider seam (gemma-provider.ts) ───────────────────────────┐
  │  transport payload.options ── slot exists [gemma:19-25]       │
  │  complete() → chat({...}) ── slot left EMPTY [gemma:69-74]    │ ← buffr's gap
  └───────────────────────────────────────────────────────────────┘
        │ contrast
        ▼
  RubricJudge → generateStructured(temperature) [rubric-judge.ts:99] ← plumbed
        │
        ▼
  Phase B exercise: thread cfg.temperature → options.temperature
```

## Elaborate

Temperature comes from the softmax that turns the model's raw scores (logits) into probabilities: dividing logits by a temperature `T` before softmax sharpens (`T<1`) or flattens (`T>1`) the distribution. `T→0` approaches greedy decoding (always the top token); `T=1` is the model's "natural" distribution. Top-k and top-p (nucleus sampling) are truncation strategies layered on top — they decide *which* tokens are even eligible before temperature weights them.

For an application engineer the takeaway is that these are the cheapest behavior dials you have — no retraining, no prompt rewrite, just a number. RAG, structured extraction, and any task where you want the *same* answer to the *same* input lean low. Open-ended generation leans higher. buffr sits squarely in the first camp and should set a low temperature; that it doesn't yet is the gap this file names. This connects forward to `04-structured-outputs.md` (low temperature makes valid JSON more likely) and `05-evals-and-observability/` (non-determinism is what makes evals statistical rather than exact).

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **not yet exercised** — Case B (expose a temperature config).

### EX-03-1 — Expose and wire a generation temperature

- **Exercise ID:** EX-03-1
- **What to build:** Add an `OLLAMA_TEMPERATURE` (default `0.2`) to `loadConfig`, and pass `options: { temperature }` through `GemmaModelProvider` construction so buffr's RAG answers run at low, repeatable temperature instead of the model default.
- **Why it earns its place:** Closes the named gap — encodes "be faithful to retrieved chunks" as an actual sampling choice. Highest-leverage, lowest-effort behavior change in the repo.
- **Files to touch:** `src/config.ts` (add field), `src/session.ts:46` (pass into `GemmaModelProvider` options). aptkit's transport already accepts `options` — do not edit aptkit.
- **Done when:** the same question asked twice returns the same answer (or near-identical), and a test confirms the temperature reaches the transport payload.
- **Estimated effort:** 1-4hr

### EX-03-2 — Measure the variance the default temperature costs you

- **Exercise ID:** EX-03-2
- **What to build:** A script that asks one fixed question N times at default temperature and again at `0.2`, then reports answer-text variance (e.g. distinct outputs), demonstrating *why* low temperature matters for a knowledge assistant.
- **Why it earns its place:** Makes the abstract "non-determinism" concrete and justifies EX-03-1 with data.
- **Files to touch:** new `scripts/temperature-variance.ts`; reads `src/session.ts`. No aptkit edits.
- **Done when:** the script prints variance at both settings and the low setting is visibly tighter.
- **Estimated effort:** 1-4hr

## Interview defense

**Q: "What temperature does buffr use for its RAG answers, and is that right?"**

It uses the model default — buffr sets none. For a grounded assistant that's wrong; you'd want a low temperature (~0.2) so the model repeats retrieved facts faithfully instead of sampling from the tail and embroidering.

```
  RAG wants the left dial

  faithful answer  ◄── low T ── default ── high T ──► creative answer
       (want this)                              (not for RAG)
```

*Anchor:* `chat({...})` at `gemma-provider.ts:69-74` passes no `options` — the slot at `:19-25` is unused.

**Q: "Temperature vs top-p — what's the difference?"**

Temperature *reshapes* the whole distribution (sharper or flatter); top-p *truncates* it to the smallest set of tokens whose probabilities sum past p, then samples from that nucleus. One scales odds; the other cuts the tail.

```
  reshape vs truncate

  temperature: ████▁▁▁ → █████▁▁  (re-weight all)
  top-p 0.9:   ████▁▁▁ → ████ | ✂ (drop the tail past 0.9)
```

*Anchor:* both ride in the same `options` object slot — `gemma-provider.ts:19-25`.

## See also

- `01-what-an-llm-is.md` — why output is sampled in the first place.
- `04-structured-outputs.md` — low temperature raises the odds of valid structured output.
- `08-provider-abstraction.md` — the provider seam where these options would be passed.
- `../05-evals-and-observability/02-eval-methods.md` — why non-determinism makes evals statistical.
