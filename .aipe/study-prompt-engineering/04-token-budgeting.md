# 04 — Token budgeting and context window management

**Industry term:** token budgeting / context-window management · the context guard (`ContextWindowGuardedProvider`) · *Industry standard*

Token counting is not optional. It's the basic hygiene that separates amateur prompt work from professional. buffr does the professional thing in one specific way — it puts a hard ceiling in front of the model and *throws* rather than silently truncating — and skips it in others.

## Zoom out, then zoom in

You've watched a `fetch()` payload grow until a server returns 413. A context window is the same ceiling, except the failure is quieter: the model truncates, or the relevant chunk falls out of attention, and you get a worse answer with no error. buffr makes that failure loud.

```
  Zoom out — where the token budget is enforced

  ┌─ Toolkit layer (RagQueryAgent) ───────────────────────┐
  │  model.complete({ system, messages, tools })          │
  └─────────────────────────┬──────────────────────────────┘
                            │  wrapped request
  ┌─ Guard layer ───────────▼──────────────────────────────┐
  │  ★ ContextWindowGuardedProvider ★  maxTokens: 8192     │ ← we are here
  │  estimate input tokens → ok? pass : THROW              │
  └─────────────────────────┬──────────────────────────────┘
                            │  only if it fits
  ┌─ Provider ──────────────▼──────────────────────────────┐
  │  Gemma 2 9B via Ollama                                 │
  └────────────────────────────────────────────────────────┘
```

Zoom in: token budgeting is allocating a fixed window across system prompt, retrieved context, history, and response — and refusing to overflow it. buffr's allocation is enforced by a guard wrapper with a hard `8192` ceiling.

## Structure pass

**Layers:** the assembled request → the guard's estimate → the model. **Axis — "where do the tokens go, and what happens at the ceiling?":**

```
  axis: "what happens when the prompt approaches the ceiling?"

  ┌─ unguarded provider ─┐ silently truncates → worse answer, no error  ✗
  └─ guarded provider ───┘ estimates, THROWS ContextWindowExceededError ✓
        maxTokens 8192 − outputReserve 768 = 7424 input budget
```

**Seam:** the guard wrapper is the seam where "fits / doesn't fit" flips from a silent quality regression to an explicit error you can catch.

## How it works

### Move 1 — the mental model

A fixed window, partitioned: some for the prompt, some reserved for the answer. The kernel is **estimate input → compare to budget → throw if over.**

```
  The context guard kernel — estimate · compare · throw

  total window: maxTokens 8192
  ┌──────────────────────────────────────────────┐
  │  input budget = 8192 − 768 (outputReserve)    │
  │              = 7424 tokens                     │
  ├──────────────────────────────────────────────┤
  │  estimate = ceil(chars / 3)  over             │
  │    system + messages + tool schemas           │
  └───────────────────┬───────────────────────────┘
                      ▼
              estimate ≤ 7424 ?
              yes → pass through       no → THROW
```

### Move 2 — the walkthrough

**Counting tokens — the cheap estimator.** buffr doesn't run a real tokenizer; it approximates at 3 chars/token over the whole request — system text, every message, and the rendered tool schemas.

```js
// context-window-guard.js:56 — estimateModelRequestTokens
const text = [ request.system ?? '',
  ...request.messages.map(messageText),
  ...(request.tools ?? []).map((t) => `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`),
].join('\n');
return estimateTextTokens(text, 3);   // ceil(text.length / 3)
```

Note what's counted: the tool schemas count against the budget. The emulated tool catalog from [02](02-structured-outputs.md) isn't free — it's prompt tokens, every turn.

**Allocating the budget — reserve for output.** The guard subtracts a 768-token output reserve from the 8192 ceiling, leaving ~7424 for input.

```js
// context-window-guard.js:47
const availableInputTokens = Math.max(0, maxTokens - outputReserve);  // 8192 - 768
return { ..., ok: estimatedInputTokens <= availableInputTokens };
```

**The failure mode, made loud.** When the estimate exceeds the budget, the guard emits a warning and **throws** rather than truncating:

```js
// context-window-guard.js:30
if (!estimate.ok) {
  this.options.trace?.emit({ type: 'warning', message: `Skipping local provider…` });
  throw new ContextWindowExceededError(estimate);
}
```

This is the specific bug the spec names — "a chain that worked on small inputs starts truncating at scale because nobody counted tokens" — pre-empted. buffr chose to fail loudly. The boundary condition: the question + retrieved chunks + profile + tool catalog must collectively fit 7424 tokens, or the turn errors out (and the Ink UI shows `error: …`, `chat.tsx:31`).

**The other compression lever — capped tool results.** Retrieved content is bounded before it ever hits the prompt: tool results truncate at 16,000 chars (`run-agent-loop.js:2`), and search snippets cap at ~160 chars (`search-knowledge-base-tool.js:57`). Retrieval *is* context compression — you don't stuff the whole corpus, you retrieve the top-k relevant chunks.

**Lost-in-the-middle — the positional gotcha.** Even when context fits, content in the middle of a long prompt is poorly attended. buffr puts the profile at the **front** (`injectProfile` position `'start'`, [01](01-anatomy.md)) — a good spot. But retrieved chunks arrive as tool-result messages in the *middle* of the conversation, which is the weakest attention position. On a long multi-tool turn, that's where a relevant chunk can get under-weighted.

### Move 3 — the principle

Count your tokens or the model counts them for you — silently, by dropping the part you needed. The 80% rule: if you're routinely above 80% of the window, you're one model change away from breaking. buffr's hard throw is the professional move — a loud failure you can catch beats a silent one you discover in a bad answer three weeks later.

## Primary diagram

```
  buffr's token budget — one window, partitioned, guarded

  ┌─ assembled request ────────────────────────────────────┐
  │ profile + BASE_SYSTEM + tool catalog + history + Q      │
  └──────────────────────────┬──────────────────────────────┘
                             ▼  estimate ≈ chars/3
  ┌─ ContextWindowGuardedProvider (maxTokens 8192) ────────┐
  │  input budget 7424  |  output reserve 768               │
  │  estimate ≤ 7424 ? ──── yes ──► Gemma     no ──► THROW   │
  └─────────────────────────────────────────────────────────┘
   compression upstream: tool results ≤16k chars, snippets ≤160 chars
```

## Elaborate

Prefix caching — where providers cache the static prefix of a prompt across calls (keep the stable part at the front, [01](01-anatomy.md)'s ordering) — is **not exercised** here: Ollama serving Gemma locally doesn't expose a prompt prefix cache the way Anthropic/OpenAI do. buffr's stable-on-top ordering would *enable* it if the serving layer supported it, so the prompt is cache-ready without a cache. The 3-chars/token heuristic is crude (real tokenizers vary by language and content), which is why the guard reserves a generous 768 for output — slack to absorb the estimate's error. Anthropic's and OpenAI's token-counting endpoints exist precisely because eyeballing chars/token regresses on non-English text.

## Interview defense

**Q: What happens when a prompt is about to overflow the context window?**

In this system it throws, on purpose. A guard wrapper estimates input tokens (≈chars/3) over system + messages + tool schemas, compares against an 8192 ceiling minus a 768 output reserve, and throws `ContextWindowExceededError` if the estimate is over — rather than letting the model silently truncate.

```
  estimate ≤ (8192 − 768) ? pass : THROW   ← loud, catchable
```

Anchor: *"The load-bearing choice is failing loud. Silent truncation gives you a worse answer with no error — you find it weeks later in a bad output. The 80% rule says if you're routinely near the ceiling you're one model change from breaking, so I'd rather catch the overflow at the boundary. And the tool catalog counts against the budget — emulated tool calling isn't free tokens."*

## See also

- [01-anatomy.md](01-anatomy.md) — stable-on-top ordering = cache-ready ordering, profile at the front
- [02-structured-outputs.md](02-structured-outputs.md) — the tool catalog that consumes budget every turn
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — measuring whether a longer prompt actually helped
