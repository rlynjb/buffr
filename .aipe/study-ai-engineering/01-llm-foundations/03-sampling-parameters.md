# Sampling Parameters

*Industry name: decoding / sampling parameters (temperature, top-p, top-k). Type: **Industry standard.***

## Zoom out, then zoom in

The model produces a probability for every next token. *Sampling* is how one token gets picked. Here's where that knob would sit — and the honest truth is buffr never turns it.

```
buffr stack — the sampling knob (currently untouched)
┌───────────────────────────────────────────────────────────┐
│ session.ts / RagQueryAgent   builds ModelRequest            │
├───────────────────────────────────────────────────────────┤
│ GemmaModelProvider.complete  payload: {model, messages,     │
│                              stream:false}  ← no options{}  │
├───────────────────────────────────────────────────────────┤
│ ★ Ollama /api/chat options{} EMPTY → defaults apply         │ the knob, left at factory
├───────────────────────────────────────────────────────────┤
│ gemma2:9b   samples next token from the distribution        │
└───────────────────────────────────────────────────────────┘
```

Every other file in this section anchors to active code. This one is **Case B-ish: the capability exists in the stack but buffr never drives it.** Buffr sets no `temperature`, no `top_p`, no `top_k`. Ollama applies `gemma2:9b`'s defaults. This file teaches the knob, shows you the exact empty slot where it'd go, and makes wiring it the exercise.

## Structure pass — trace *determinism* across the stack

Pick one axis: **is the output reproducible?** Trace it and find where reproducibility is lost.

```
determinism, request → response
  buffr request      │ no temperature set      │ reproducible? UNKNOWN
  Ollama defaults    │ temperature = default>0 │ NON-deterministic  ★ flips here
  gemma2:9b sample   │ random draw each call   │ different text per call
```

The seam is Ollama's default temperature. Because buffr passes nothing, the default (greater than zero) applies, which means **the same question can yield different answers across runs.** That's invisible until you try to write a stable eval (file 05 of sub-section 05) or use the unwired `RubricJudge`, both of which want `temperature=0` to be reproducible. Buffr hasn't hit that wall yet because it has no automated generation eval wired — but the wall is there.

## How it works

### Move 1 — the mental model: a dial from "boring" to "wild"

You know `Math.random()` and a seed. Temperature is the seed's *intensity*: at 0 the model always takes the single most-likely token (deterministic, repetitive, safe); as temperature rises, lower-probability tokens get a real chance (creative, varied, riskier).

```
the distribution, reshaped by temperature
  raw probs over next token:   ▁▂▆█▃▁
  ─────────────────────────────────────
  temp = 0   →  pick the peak only      ████ ← always same token (argmax)
  temp = 0.7 →  mostly peak, some spread ▂▄██▃ ← natural variety
  temp = 1.5 →  flattened, wild          ▄▅▆▆▅▄ ← surprising / incoherent
```

`top-k` and `top-p` are guardrails on top: top-k = "only consider the k most-likely tokens"; top-p (nucleus) = "only consider the smallest set of tokens whose probability sums to p." They clip the tail so high temperature doesn't pull in absurd tokens.

```
top-k and top-p clip the tail before sampling
  full vocab:  [the, base, knowledge, ... , aardvark, ... , zylophone]
  top-k = 5 →  [the, base, knowledge, search, query]   ← keep 5, drop rest
  top-p = 0.9→ [the, base, knowledge]                  ← keep until cumulative ≥ 0.9
  then temperature samples WITHIN the kept set
```

### Move 2 — the moving parts

#### Bridge: this is the `options` object you never filled in

In frontend, `fetch(url, options)` — when you omit `options`, you get defaults (GET, no headers). Same here. The Gemma transport has an `options` slot in its payload type, and buffr passes it empty. From `gemma-provider.ts:19–25` (the transport type) and `:69–74` (the call):

```ts
export type GemmaChatTransport = (payload: {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;
  options?: Record<string, unknown>;     // ← temperature/top_p/top_k would live HERE
  signal?: AbortSignal;
}) => Promise<OllamaChatResponse>;

// ...inside complete():
lastResponse = await this.chat({
  model: this.defaultModel,
  messages,
  stream: false,
  ...(request.signal ? { signal: request.signal } : {}),
  // ← NO options. ModelRequest.temperature is never read by the Gemma provider.
});
```

Annotation that matters: the `options` field is *typed and ready*, but `complete()` never populates it. Even `request.temperature` (which `generateStructured` does pass through for the `RubricJudge`) is silently dropped here — the Gemma provider doesn't forward it. So today, the dial is welded at Ollama's default.

```
the empty slot
  ModelRequest.temperature ──X──▶ (dropped by GemmaModelProvider)
  payload.options          = (absent)
        │
        ▼
  Ollama applies gemma2:9b defaults (temp≈0.7-ish, top_p, top_k built in)
```

### Move 2.5 — current vs future state

**Current:** no sampling params anywhere. Generation is at Ollama's defaults; output varies run to run. The `RubricJudge` (file 04) accepts a `temperature` option and `generateStructured` forwards it into `ModelRequest`, but the **Gemma provider drops it**, so even the judge can't get deterministic output today.

**Future (the exercise):** thread an `options` object through `GemmaModelProvider`, mapping `request.temperature` (and configured top-p/top-k) into the Ollama payload. Then `temperature: 0` actually reaches the model, and reproducible evals become possible.

```
current → future
  CURRENT:  request.temperature → [dropped] → Ollama default (>0)  ← varies
  FUTURE:   request.temperature → options.temperature → Ollama     ← honored
                                  (0 = deterministic, reproducible evals)
```

### Move 3 — the principle that generalizes

> **Sampling is a policy choice, not a default. "Creative" and "reproducible" are opposite ends of one dial, and you should set it on purpose per use-case.**

A RAG answer wants *low* temperature — you're grounding in retrieved facts, you don't want invention. An LLM judge wants temperature **0** — the same input must score the same way every run, or your eval is noise. Buffr leaving the dial at the default means generation is mildly creative *by accident*, and any future judge is non-reproducible *by accident*. Accidents are not a policy.

## Primary diagram

The knob, its empty slot in buffr, and what setting it unlocks.

```
sampling, the whole picture
  gemma2:9b raw distribution over next token
        │
   ┌────┴──────────────────────────────────────────┐
   │  top_k / top_p clip the tail   ← NOT SET       │
   │  temperature reshapes peak     ← NOT SET       │
   └────┬──────────────────────────────────────────┘
        │  buffr passes options:{} (empty)
        ▼
  Ollama defaults sample → one token → text
  ─────────────────────────────────────────────
  consequence: same question, different answers run-to-run
  blocked: deterministic RubricJudge, reproducible generation evals
```

## Elaborate

- **Origin.** Temperature comes from the softmax: dividing logits by T before normalizing. T→0 sharpens to argmax; T→∞ flattens to uniform. Top-k (Fan 2018) and nucleus/top-p (Holtzman 2019) were introduced to fix high-temperature incoherence by truncating the unreliable tail.
- **Adjacent concepts.** *Tokenization* (02) produces the distribution this file samples from. *Evals* (sub-section 05) is the consumer that *needs* `temperature=0`. *Structured output* (04) is more reliable at low temperature — less drift away from the required JSON shape.
- **Honest gap.** Not just unset — the Gemma provider actively **drops** `request.temperature`. Wiring sampling is two changes: forward the value *and* expose a config for it. Don't claim buffr "uses defaults intentionally"; it uses them because the plumbing was never run.
- **What to read next.** File 04 — structured output, which is the use-case that benefits most from turning this dial to 0.

## Project exercises

### Thread sampling parameters through the Gemma provider

- **Exercise ID:** [B1.5] (Phase 1 — LLM foundations) — **Not yet implemented** (Case B; the slot exists, nothing fills it).
- **What to build:** Make `GemmaModelProvider.complete` map `request.temperature` (and constructor-configured `top_p`/`top_k`) into the Ollama `payload.options`. Add a `temperature` knob to buffr's session config and default RAG answers to a low value (e.g. 0.2). Note the provider lives in aptkit and is consumed by buffr — if you can't edit aptkit, wrap it with a buffr-side provider that injects `options` before delegating, mirroring file 01's logging-provider pattern.
- **Why it earns its place:** This is the single change that unlocks reproducible evals and the `RubricJudge`. Today the dial is welded; this is the wrench.
- **Files to touch:** `src/session.ts:46` (configure temperature); `src/config.ts` (read an env var); a buffr-side `src/sampling-provider.ts` wrapper if aptkit is read-only.
- **Done when:** passing `temperature:0` produces byte-identical output across two runs of the same prompt; the default RAG path runs at a configured low temperature.
- **Estimated effort:** 1–4hr

### Prove non-determinism today, determinism after

- **Exercise ID:** [B1.6] (Phase 1 — LLM foundations)
- **What to build:** A script that asks the same question 5 times and reports how many distinct answers come back — run it before [B1.5] (expect variation) and after with `temperature:0` (expect one distinct answer).
- **Why it earns its place:** Converts "non-deterministic by accident" from a claim into a measured before/after.
- **Files to touch:** new `scripts/sampling-variance.ts`; depends on [B1.5].
- **Done when:** before-run shows >1 distinct answer, after-run shows exactly 1.
- **Estimated effort:** <1hr

## Interview defense

**Q: "What temperature does buffr use and why?"**

Model answer: Honestly, none — buffr passes no `options` to Ollama, so `gemma2:9b`'s default (above zero) applies and answers vary run to run. That's an accident, not a policy. For a RAG system grounded in retrieved facts I'd set a low temperature (~0.2) to suppress invention, and for the LLM judge I'd set 0 for reproducibility. The deeper issue is that the Gemma provider currently drops `request.temperature` entirely, so even the judge can't get deterministic output — fixing that is one change to forward the value into the payload `options`.

```
the honest answer
  buffr today  │ options:{} → Ollama default → varies    ← accident
  should be    │ RAG: temp≈0.2  │  judge: temp=0          ← policy
  blocker      │ provider drops request.temperature       ← fix first
```

Anchor: *No dial set today; the slot exists, the provider drops it, fixing it unlocks reproducible evals.*

## See also

- `02-tokenization.md` — the token distribution this knob reshapes.
- `04-structured-outputs.md` — the path that most wants temperature near 0.
- `../05-evals-and-observability/` — the consumer that breaks without `temperature=0`.
