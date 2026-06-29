# The Context Window

**Industry name(s):** context window · context length · token budget · prompt budget.
**Type:** Industry standard.

---

## Zoom out, then zoom in

Every model call buffr makes is one flat string going into one model. That string has a ceiling — and buffr puts a guard right in front of the model so nothing oversized ever reaches it.

```
  Zoom out — where the context window lives

  ┌─ CLI / Session layer ───────────────────────────────────┐
  │  ask("how does X work?")                                 │
  │      → RagQueryAgent.answer(question)                    │
  └───────────────────────────────┬─────────────────────────┘
                                  │  builds one ModelRequest:
                                  │  system + messages + tools
  ┌─ Provider layer (aptkit) ─────▼─────────────────────────┐
  │  ★ ContextWindowGuardedProvider (maxTokens: 8192) ★      │ ← we are here
  │      estimate tokens → ok? pass : throw                  │
  └───────────────────────────────┬─────────────────────────┘
                                  │  only if it fits
  ┌─ Model layer (Ollama) ────────▼─────────────────────────┐
  │  GemmaModelProvider → gemma2:9b → text                   │
  └──────────────────────────────────────────────────────────┘
```

That `★` box is the whole concept. The context window is the maximum amount of text — measured in **tokens**, not characters — the model can take in for a single call. buffr fixes that ceiling at **8192 tokens** and wraps the real model in a provider that *checks the request size before forwarding it*. The question this answers: **what happens when system prompt + profile + retrieved chunks + question add up to more than the model can hold?** Without a guard, the answer is "the model silently truncates and you get a confidently wrong answer." With buffr's guard, the answer is "it throws a typed error you can catch."

You already know this shape from the frontend: it's a **request payload size limit**. A server that rejects a 5 MB upload with a 413 *before* trying to parse it is doing exactly what `ContextWindowGuardedProvider` does — pre-flight the size, refuse early, fail loud.

---

## The structure pass

Before the mechanics, read the skeleton. Three layers stack between your question and the generated text:

```
  Three layers, one axis traced down them

  axis = "who enforces the token budget?"

  ┌─────────────────────────────────────────────┐
  │ Session layer  — RagQueryAgent / runAgentLoop│  → NOBODY enforces;
  │   assembles system + messages + tools        │    it just builds the string
  └───────────────────────┬─────────────────────┘
       seam ① (the request crosses into the guard)
  ┌───────────────────────▼─────────────────────┐
  │ Guard layer — ContextWindowGuardedProvider   │  → CODE enforces;
  │   estimateContextWindow() → ok / not ok      │    deterministic, pre-flight
  └───────────────────────┬─────────────────────┘
       seam ② (the request crosses into Ollama)
  ┌───────────────────────▼─────────────────────┐
  │ Model layer — gemma2:9b inside Ollama        │  → THE RUNTIME enforces;
  │   silently truncates anything over its limit │    lossy, after the fact
  └──────────────────────────────────────────────┘
```

**One axis — who enforces the token budget?** Trace it top to bottom and the answer flips twice. The session layer doesn't enforce anything; it just concatenates text and hopes. Ollama enforces, but *destructively* — it drops tokens to make things fit and tells you nothing. The middle layer is the one buffr inserts on purpose: **deterministic, pre-flight, fail-loud** enforcement that turns silent truncation into a catchable error.

**The seams:**
- **Seam ①** is where the assembled `ModelRequest` crosses into the guard. This is where the axis-answer flips from "nobody checks" to "code checks." That's the load-bearing boundary — it's the only place you get a chance to refuse before damage is done.
- **Seam ②** is where (if it passed) the request crosses into Ollama. Past this seam enforcement becomes lossy. buffr's whole bet is to make seam ① do the work so seam ② never has to.

The guard exists precisely *because* seam ② is destructive. Map that and the mechanics below are obvious.

---

## How it works

#### Move 1 — the mental model

You know how a controlled `<input maxLength={8192}>` won't accept the 8193rd character — it rejects the overflow at the boundary instead of letting it land and corrupt the field. The context window is that, for a model call. buffr's strategy in one sentence: **estimate the request's token size cheaply, compare it to a fixed budget, and refuse the call before it reaches the model if it won't fit.**

```
  Pattern — pre-flight check, then pass or refuse

         request (system + messages + tools)
                       │
                       ▼
            ┌─────────────────────┐
            │ estimate tokens     │   text.length / 3, rounded up
            │ (~3 chars per token)│
            └──────────┬──────────┘
                       │
              estimate ≤ budget ?
                ┌──────┴───────┐
              yes              no
                │                │
                ▼                ▼
        forward to model   emit warning trace
        (Ollama runs)      + throw ContextWindowExceededError
```

That branch is the entire kernel. Everything below is what fills each side of it.

#### Move 2 — the step-by-step walkthrough

**The window holds four things, and they compete.** Before any code: know what's *in* the 8192-token budget. It is not just the user's question. Every call carries the system prompt, the injected profile, whatever chunks retrieval pulled back, and the question — and they all draw from the same pool.

```
  What competes for 8192 tokens (single call)

  ┌──────────── 8192-token budget ────────────────────────┐
  │ outputReserve (768) — held back for the answer        │
  ├───────────────────────────────────────────────────────┤
  │ system prompt   — "You are a personal knowledge…"     │
  │ injected profile (me.md) — "About the person…"        │ ← grows
  │ retrieved chunks — up to minTopK:4 passages           │ ← grows fastest
  │ tool schemas     — search_knowledge_base definition   │
  │ the question     — what the user actually asked       │
  └───────────────────────────────────────────────────────┘
       available input budget = 8192 − 768 = 7424 tokens
```

The thing to internalize: **a fat profile and fat retrieved chunks come out of the same budget.** A 2000-token `me.md` leaves ~5400 tokens for chunks + question. This is a competition, not four separate allowances.

**Step 1 — wire the guard with a fixed budget.** buffr constructs the model provider by wrapping the raw Gemma provider in the guard. This is the line that sets the ceiling.

```ts
// src/session.ts:46
const model = new ContextWindowGuardedProvider(
  new GemmaModelProvider({ host: cfg.ollamaHost }),
  { maxTokens: 8192 },
);
```

`GemmaModelProvider` is the thing that actually talks to Ollama. `ContextWindowGuardedProvider` is a **decorator** around it — same `ModelProvider` interface, so the agent can't tell the difference, but every `complete()` call now passes through the size check first. `maxTokens: 8192` is the only knob buffr sets; `outputReserve` and `charsPerToken` fall back to defaults (768 and 3).

```
  Decorator — same interface, guard inserted transparently

  RagQueryAgent ──.complete(req)──► ┌─ Guard ──────────────┐
                                    │ check size first     │
                                    │   ok → delegate       │
                                    └────────┬──────────────┘
                                             ▼ .complete(req)
                                    ┌─ GemmaModelProvider ─┐
                                    │  POST → Ollama        │
                                    └───────────────────────┘
   agent never knows a guard is there — it's just a ModelProvider
```

**Step 2 — estimate the input tokens.** When the agent calls `complete()`, the guard's first move is to count. It doesn't run a real tokenizer (that'd cost a round-trip); it approximates by **character length divided by 3**.

```ts
// packages/providers/local/src/context-window-guard.ts:100-103
export function estimateTextTokens(text: string, charsPerToken = 3): number {
  if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
  return Math.ceil(text.length / charsPerToken);   // ← the whole "tokenizer"
}
```

And the text it measures is *everything in the request joined together* — system prompt, every message, and the tool schemas (name + description + JSON schema), so the `search_knowledge_base` definition counts against the budget too:

```ts
// packages/providers/local/src/context-window-guard.ts:91-98
export function estimateModelRequestTokens(request, charsPerToken = 3): number {
  const text = [
    request.system ?? '',
    ...request.messages.map(messageText),
    ...(request.tools ?? []).map(
      (tool) => `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);
}
```

The boundary condition to respect: **~3 chars/token is a heuristic, not the truth.** Gemma's real tokenizer might pack code or rare words at 2 chars/token, so a request the guard thinks is "fine" could still be larger than estimated. The guard is a safety margin, not a precise gauge — which is exactly why `outputReserve` leaves slack.

**Step 3 — compare against the available input budget.** The full 8192 isn't available for input. The guard carves out `outputReserve` (default 768) for the answer the model still has to generate, then checks the estimate against what's left.

```ts
// packages/providers/local/src/context-window-guard.ts:80-88
const estimatedInputTokens = estimateModelRequestTokens(request, charsPerToken);
const availableInputTokens = Math.max(0, maxTokens - outputReserve);  // 8192 − 768 = 7424
return {
  estimatedInputTokens, maxTokens, outputReserve, availableInputTokens,
  ok: estimatedInputTokens <= availableInputTokens,   // ← the verdict
};
```

```
  Execution trace — a borderline request

  maxTokens          = 8192
  outputReserve      = 768
  availableInput     = 8192 − 768            = 7424
  request text length= 21,900 chars
  estimatedInput     = ceil(21900 / 3)       = 7300
  ok                 = 7300 ≤ 7424           = TRUE  → forward

  (same request, profile grew by 600 chars)
  request text length= 22,500 chars
  estimatedInput     = ceil(22500 / 3)       = 7500
  ok                 = 7500 ≤ 7424           = FALSE → refuse
```

The number that bites you is `availableInputTokens`, not `maxTokens`. People forget the reserve and wonder why a "7800-token" request got rejected against an "8192" budget. It was always 7424.

**Step 4 — refuse loudly, or pass through.** This is the branch from Move 1, in real code. When `ok` is false the guard does two things — emits a `warning` trace event (so the trace sink records *why* the call never happened) and throws a typed error. When `ok` is true it simply delegates to the wrapped provider.

```ts
// packages/providers/local/src/context-window-guard.ts:57-70
async complete(request: ModelRequest): Promise<ModelResponse> {
  request.signal?.throwIfAborted();
  const estimate = estimateContextWindow(request, this.options);
  if (!estimate.ok) {
    this.options.trace?.emit({                       // ← seam ①: observable refusal
      type: 'warning',
      capabilityId: this.options.capabilityId,
      message: `Skipping local provider ${this.provider.id}: estimated `
        + `${estimate.estimatedInputTokens} input tokens exceed `
        + `${estimate.availableInputTokens}.`,
      timestamp: timestamp(),
    });
    throw new ContextWindowExceededError(estimate);  // ← typed, carries the estimate
  }
  return this.provider.complete(request);            // ← the request never reaches
}                                                    //   Ollama on the failure path
```

```
  Layers-and-hops — the refusal path vs the pass path

  ┌─ Agent ───┐  hop 1: complete(request)   ┌─ Guard layer ────────┐
  │ runAgent  │ ─────────────────────────►  │ estimate + compare   │
  │ Loop      │  hop 4a: throw ◄──────────  │  not ok →            │
  └───────────┘  ContextWindowExceeded      │   emit warning trace │
        ▲                                   │   throw              │
        │ hop 4b: ModelResponse             └──────────┬───────────┘
        │ (only on the ok path)              hop 2 (ok)│ delegate
        │                                              ▼
        │                                   ┌─ Model layer ────────┐
        └────────────────────────────────  │ Ollama gemma2:9b      │
              hop 3: generated text         │ runs only if it fit   │
                                            └───────────────────────┘
```

The contrast that makes this worth doing: on the failure path, **Ollama is never called.** Compare that to the no-guard world, where Ollama *is* called, quietly drops the front of your prompt to fit, and returns a fluent answer built on a truncated input. The guard converts a silent-correctness bug into a loud `ContextWindowExceededError` that carries the full `estimate` so you can log exactly how far over you were.

#### Move 2 variant — the load-bearing skeleton

Strip the guard to the smallest thing that's still the guard:

```
  Kernel:   estimate(request)  →  compare to (budget − reserve)  →  pass | refuse
```

Name each part by what breaks without it:

- **The estimate.** Drop it and you have no number to compare — the guard degrades to "always pass," i.e. no guard. It's cheap (char count) on purpose; a real tokenizer round-trip per call would cost more than it saves.
- **The output reserve.** Drop it (`outputReserve = 0`) and a request that fits the *input* budget can still leave Gemma no room to *answer* — the model runs out of window mid-generation. The reserve is the part everyone forgets; it's why the real ceiling is 7424, not 8192.
- **The refusal (throw + trace).** Drop it and the guard estimates but forwards anyway — back to silent truncation. The *typed* throw is what makes the failure catchable upstream; the *warning trace* is what makes it visible in the trajectory.

Everything else is hardening: `charsPerToken` is a tunable margin, `capabilityId` is for trace attribution, the `ContextWindowEstimate` payload on the error is for diagnostics. The kernel is just estimate → compare → branch.

#### Move 3 — the principle

**Refuse early at the cheap boundary instead of failing late at the expensive one.** A pre-flight size check that costs a string-length division saves you from a silent-truncation bug that costs you a wrong answer and no error to grep for. This generalizes far past LLMs — it's the 413 before parsing, the schema validation before the DB write, the `maxLength` before the keystroke lands. The model's context window is just an unusually unforgiving version: overflow doesn't error, it *lies*. So you guard it yourself.

---

## Primary diagram

The whole concept in one frame — what's in the window, who checks it, and the two exits.

```
  buffr's context window guard — end to end

  ┌─ Session layer (buffr) ──────────────────────────────────────┐
  │ RagQueryAgent.answer(question)                               │
  │   assembles ONE request from four competing inputs:          │
  │     system prompt · profile(me.md) · chunks(≤4) · question   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ complete(request)
  ┌─ Guard layer (aptkit) — src/session.ts:46 wires this ────────┐
  │ ContextWindowGuardedProvider { maxTokens: 8192 }             │
  │                                                              │
  │   estimatedInput = ceil(text.length / 3)                     │
  │   available      = 8192 − 768 (outputReserve) = 7424         │
  │                                                              │
  │        estimatedInput ≤ 7424 ?                               │
  │         ┌──────────┴───────────┐                            │
  │       yes                      no                            │
  │         │                       │                            │
  │         │              emit warning trace                    │
  │         │              throw ContextWindowExceededError      │
  └─────────┼───────────────────────────────────────────────────┘
            │ delegate (request never truncated)
  ┌─ Model layer (Ollama) ─▼─────────────────────────────────────┐
  │ GemmaModelProvider → gemma2:9b → generated answer            │
  └──────────────────────────────────────────────────────────────┘
```

---

## Elaborate

**Where this comes from.** Transformer attention is quadratic in sequence length, so every model ships with a fixed maximum sequence it was trained and served to handle. Exceed it and there's no graceful path — the serving runtime either errors or, more commonly for local stacks like Ollama, truncates to fit. The "context window" as a first-class budget you manage is a direct consequence of that architectural limit.

**Why 8192 and not bigger.** `gemma2:9b` running locally on a laptop has a real context limit, and bigger windows cost more memory and latency per token. 8192 is a conservative, laptop-friendly ceiling. Note it's a *buffr* choice set in `src/session.ts:46`, not a law — bump `maxTokens` and the guard's math moves with it.

**The honest gap.** The estimator is ~3 chars/token, which is a fine average for English prose but wrong for the tails (dense code, JSON, non-Latin scripts can run hotter). The guard is therefore a *margin*, not a *measurement*. The 768-token output reserve is the slack that absorbs the estimator's error — which is the real reason it exists, beyond just "leave room for the answer."

**What fills the window in practice.** In buffr the biggest variable input is the retrieved chunks. That's why `03-retrieval-and-rag/` matters here: `minTopK: 4` (set in `src/session.ts:43`) is partly a *quality* decision and partly a *budget* decision — fewer, better chunks keep you well under 7424 and leave room for the profile. Chunking strategy upstream directly determines how much of the window each retrieval costs.

**What it connects to.** The profile injection (next door in `02-lost-in-the-middle.md`) competes for this exact budget. Token economics (`01-llm-foundations/06-token-economics.md`) is the cost side of the same tokens. And the whole agent loop (`04-agents-and-tool-use/01-agents-vs-chains.md`) calls `complete()` up to `maxTurns: 6` times — each turn re-pays the system + profile cost against the window.

---

## Project exercises

> **No curriculum file exists in this repo** (`/Users/rein/Public/buffr/.aipe/`), so these carry no `[Bx.y]` IDs — they're named build items, not curriculum-mapped tasks. This concept is **implemented** (the guard is wired and live), so these are **Case A**: deepen and observe an existing mechanism rather than build it from nothing.

### Exercise — Surface the guard's refusal to the user

- **Exercise ID:** CW-A1 (local id; no curriculum)
- **What to build:** Catch `ContextWindowExceededError` in `ChatSession.ask()` and turn it into a friendly message ("That pulled back too much context to fit — try a narrower question") instead of an unhandled throw, logging the `estimate` payload.
- **Why it earns its place:** Right now the typed error exists but buffr does nothing buffr-side with it. Catching it proves you understand the failure path is *catchable* — the entire point of the guard over silent truncation.
- **Files to touch:** `src/session.ts` (the `ask()` body, around lines 60-71).
- **Done when:** an oversized request (force it with a huge profile) returns a graceful string and the `estimate` is logged, instead of crashing the turn.
- **Estimated effort:** <1hr

### Exercise — Instrument the window's headroom every turn

- **Exercise ID:** CW-A2 (local id; no curriculum)
- **What to build:** A small trace/log line per turn recording `estimatedInputTokens` vs `availableInputTokens` (call `estimateContextWindow` yourself, or read it off the trace), so you can see how close each real query runs to 7424.
- **Why it earns its place:** Turns the abstract "competition for the budget" into a measured number on real traffic — you'll find out whether the profile or the chunks dominate.
- **Files to touch:** `src/session.ts`, `src/supabase-trace-sink.ts` (to persist the headroom alongside the existing trace tokens).
- **Done when:** every persisted turn has an `input_tokens_estimate` and `headroom` you can query.
- **Estimated effort:** 1-4hr

### Exercise — Make the chunk count budget-aware

- **Exercise ID:** CW-A3 (local id; no curriculum)
- **What to build:** Cap retrieved-chunk inclusion by remaining budget — after the profile is injected, only include as many chunks as fit under `availableInputTokens`, dropping the lowest-scored first.
- **Why it earns its place:** Directly exercises the "they compete for the same 8192" insight: a fat profile should *shrink* how many chunks you stuff, automatically.
- **Files to touch:** `src/session.ts:43` (the `minTopK` wiring) and wherever chunks are assembled before `answer()`; may need an aptkit-side hook (note: `@rlynjb/aptkit-core` is never edited, so do this on buffr's side by trimming the tool result).
- **Done when:** raising the profile size measurably lowers the number of chunks that reach the model, with no `ContextWindowExceededError`.
- **Estimated effort:** 1-2 days

---

## Interview defense

**Q: What actually happens if a request exceeds the context window, and what does buffr do about it?**

Without a guard, the serving runtime (Ollama here) silently truncates the prompt to fit and returns a fluent but ungrounded answer — a correctness bug with no error. buffr inserts `ContextWindowGuardedProvider` as a decorator that estimates the request size and *refuses before forwarding*, emitting a warning trace and throwing a typed `ContextWindowExceededError`.

```
  silent truncation        vs        loud refusal (buffr)
  ┌──────────────┐                   ┌──────────────┐
  │ overflow →   │                   │ overflow →   │
  │ Ollama cuts  │                   │ guard throws │
  │ → wrong ans  │                   │ → no call    │
  │ → NO error   │                   │ → typed error│
  └──────────────┘                   └──────────────┘
```

**Anchor:** `src/session.ts:46` wires it; `context-window-guard.ts:57-70` is the refuse-or-pass branch.

---

**Q: The budget is 8192. Why would a 7800-token request get rejected?**

Because the full window isn't all yours for input. The guard reserves `outputReserve` (default 768) for the answer the model still has to generate, so the real input ceiling is `8192 − 768 = 7424`. 7800 > 7424, so it's refused. The reserve is the load-bearing part people forget.

```
  8192 budget
  ├── 768  output reserve (held for the answer)
  └── 7424 available for input  ← the number that actually gates you
```

**Anchor:** `context-window-guard.ts:80-88` — `availableInputTokens = max(0, maxTokens − outputReserve)`.

---

**Q: How does the guard count tokens without a tokenizer, and what's the risk?**

It approximates: `ceil(text.length / 3)` over the joined system prompt, messages, and tool schemas. That's cheap (no round-trip) but it's a heuristic — dense code or non-Latin text can pack fewer than 3 chars per token, so a request the guard thinks fits might actually be larger. The 768-token reserve is the slack that absorbs this estimation error.

```
  text ──length/3──► estimate (margin, not measurement)
                       │
              reserve absorbs the error
```

**Anchor:** `context-window-guard.ts:91-103` — `estimateModelRequestTokens` + `estimateTextTokens`.

---

## See also

- `02-lost-in-the-middle.md` — once it fits, *where* in the window you place things.
- `03-prompt-chaining.md` — splitting work so no single call has to hold everything.
- `01-llm-foundations/06-token-economics.md` — the cost of the same tokens this file budgets.
- `03-retrieval-and-rag/11-rag.md` — the retrieved chunks that are the biggest variable input to the window.
- `04-agents-and-tool-use/01-agents-vs-chains.md` — the loop that re-pays the window cost each turn.
