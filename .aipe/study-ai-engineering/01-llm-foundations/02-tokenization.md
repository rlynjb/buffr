# Tokenization

*Industry name: tokenization / subword tokenizer (BPE-family). Type: **Industry standard.***

## Zoom out, then zoom in

The model from file 01 doesn't actually eat characters — it eats integers. Here's where that conversion sits, with the token-budget machinery marked ★.

```
buffr stack — the token boundary
┌───────────────────────────────────────────────────────────┐
│ session.ask() / RagQueryAgent   assemble prompt as TEXT     │
├───────────────────────────────────────────────────────────┤
│ ★ ContextWindowGuardedProvider  estimate tokens vs 8192     │ pre-flight budget
├───────────────────────────────────────────────────────────┤
│ GemmaModelProvider.complete()   sends text over HTTP        │
├───────────────────────────────────────────────────────────┤
│ ★ Ollama tokenizer              TEXT → token integers       │ the real tokenizer
├───────────────────────────────────────────────────────────┤
│ gemma2:9b                       consumes/produces tokens    │
├───────────────────────────────────────────────────────────┤
│ ★ usage: prompt_eval_count / eval_count   token counts back │ the receipt
└───────────────────────────────────────────────────────────┘
```

Tokenization is the unit conversion between your world (strings) and the model's world (integers). You never see the integers in buffr — Ollama does the conversion behind its HTTP wall. But you *do* see the counts come back, and you *do* spend effort guarding a budget measured in tokens. This file is about that budget and where buffr touches it.

## Structure pass — trace *cost* across the boundary

Pick one axis: **what is the unit of cost?** Watch it change as you cross from buffr into Ollama.

```
unit of cost, left → right
  buffr code        │  the wire        │  Ollama
  characters/string │  bytes of JSON   │  TOKENS  ★
  ──────────────────┼──────────────────┼──────────────────
  estimate: len/3   │  (transport)     │  exact: prompt_eval_count
       ▲                                       ▲
   the GUESS                              the TRUTH (the seam flips here)
```

The seam is the HTTP call. On buffr's side, cost is *estimated* in characters-over-three (a cheap proxy). On Ollama's side, cost is *exact*, counted in real tokens. Buffr guards using the guess (before the call) and records using the truth (after the call). The honest fact: **buffr never runs a tokenizer.** It estimates before, reads Ollama's count after, and never sees the integers in between.

## How it works

### Move 1 — the mental model: words are chopped into subword pieces

You already split strings in frontend: `"deploy-now".split("-")`. A tokenizer does the same, but the split points are learned, not on a delimiter — common chunks become single tokens, rare ones get broken up. `"tokenization"` might be `["token", "ization"]`; `"Rein"` might be `["Re", "in"]`. Rough rule of thumb for English: **~4 characters per token, ~0.75 tokens per word.**

```
text → tokens (illustrative; the real ids are Ollama's)
  "search the knowledge base"
        │  tokenizer
        ▼
  ["search", " the", " knowledge", " base"]   ← 4 tokens
        │
        ▼
  [ 1521  ,  290  ,  6843      ,  2362  ]      ← integer ids the model eats
```

The model has a fixed vocabulary (a fixed set of these integers). Your text is just a sequence drawn from it.

### Move 2 — the moving parts

#### Bridge: the context window is a token budget, like a fixed-height div

In frontend, a fixed-height container clips overflow. The context window is that, for tokens: the model can attend to at most N tokens of input+output combined. Overflow doesn't scroll — it gets refused or truncated. Buffr sets that ceiling explicitly at **8192** in `src/session.ts:46`:

```ts
const model = new ContextWindowGuardedProvider(
  new GemmaModelProvider({ host: cfg.ollamaHost }),
  { maxTokens: 8192 },                 // ← the token budget for the whole call
);
```

#### The guard estimates tokens *before* paying for the call

Buffr does not tokenize, so the guard uses a character heuristic to decide whether to even attempt the call. From `ContextWindowGuardedProvider` (`packages/providers/local/src/context-window-guard.ts:57–70` and `:100–103`):

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  const estimate = estimateContextWindow(request, this.options);
  if (!estimate.ok) {                              // estimated tokens > budget
    this.options.trace?.emit({ type: 'warning', /* ...skipping... */ });
    throw new ContextWindowExceededError(estimate);  // ← refuse before the HTTP call
  }
  return this.provider.complete(request);
}

// the heuristic itself:
export function estimateTextTokens(text: string, charsPerToken = 3): number {
  return Math.ceil(text.length / charsPerToken);   // ← chars / 3, NOT a tokenizer
}
```

Annotation that matters: `charsPerToken = 3` is deliberately *conservative* (real English is ~4), so the guard over-estimates and refuses early rather than letting Ollama choke. The available input budget is `maxTokens - outputReserve` (`8192 - 768 = 7424`), reserving room for the answer.

```
the guard's pre-flight math
  estimatedInputTokens = ceil(len(system+messages+tools) / 3)
        │
        ▼
  available = 8192 − 768(reserve) = 7424
        │
   estimated ≤ 7424 ? ──yes──▶ call Ollama
        │
        └──no──▶ throw ContextWindowExceededError  (never pays)
```

#### Ollama returns the *real* counts; buffr surfaces them as usage

After the call, Ollama reports the true token counts. The Gemma provider maps them straight into `usage` (`gemma-provider.ts:116–126`):

```ts
private toResponse(content, response): ModelResponse {
  return {
    content,
    usage: {
      inputTokens: response.prompt_eval_count,   // ← Ollama's exact PROMPT token count
      outputTokens: response.eval_count,         // ← Ollama's exact GENERATED token count
      estimated: false,                          // ← these are TRUTH, not a guess
    },
  };
}
```

`estimated: false` is the honest flag — these aren't the chars/3 guess, they're Ollama's tokenizer counting real tokens. That `usage` block is what flows into the trace sink and lands in `messages.tokens_used` (file 06).

```
the two numbers, before vs after
  BEFORE call │ estimate = len/3   │ estimated: true  (the guard's guess)
  AFTER  call │ prompt_eval_count  │ estimated: false (Ollama's truth)
              │ eval_count         │
```

### Move 3 — the principle that generalizes

> **You budget in tokens, not characters or words, and you usually pay someone else to count them. Estimate to be safe before the call; record the exact count after.**

The character heuristic is fine for a *guard* (over-estimate, fail safe). It is wrong for a *bill* — for that you wait for the provider's real count. Mixing them up (billing on the estimate, or guarding on the post-hoc truth) is a classic foot-gun. Buffr keeps them in their lanes: chars/3 guards, `prompt_eval_count` records.

## Primary diagram

The full round trip of a single call through the token boundary.

```
one call, through the token boundary
  prompt text (system + chunks + question)
        │
        ▼  ESTIMATE: ceil(len/3)  ── > 7424? ──▶ ✗ refuse (ContextWindowExceededError)
        │                                 ≤ 7424
        ▼
  HTTP POST /api/chat  ──────────────────────────────────────┐
        │                                                     │
  ┌─────────────────── Ollama (the real tokenizer) ──────────┴────┐
  │ text → token ids → gemma2:9b → token ids → text                │
  │ counts: prompt_eval_count (in), eval_count (out)               │
  └───────────────────────────────────────────────────────────────┘
        │
        ▼  usage {inputTokens, outputTokens, estimated:false}
  trace sink → messages.tokens_used   (file 06)
```

## Elaborate

- **Origin.** Byte-Pair Encoding (Sennrich 2016) and its descendants (WordPiece, SentencePiece/Unigram) made subword tokenization standard — small enough vocab to handle any text, large enough to keep common words as single tokens. Gemma uses a SentencePiece tokenizer; Ollama ships it inside the model.
- **Adjacent concepts.** *Context window* (sub-section 02 of the guide) is the budget; this file is the unit. *Token economics* (06) is what you do with the counts once you have them. *Sampling* (03) operates on the token-probability distribution this file produces.
- **Honest gap.** Buffr runs **no tokenizer of its own** — not for guarding (it uses chars/3), not for counting (it reads Ollama). If you ever need an exact pre-flight count (e.g. to trim chunks to fit), you'd add a real tokenizer, which buffr currently does not have.
- **What to read next.** File 03 — once text is tokens with a probability each, *sampling* is how one token gets picked.

## Project exercises

### Replace chars/3 with a real tokenizer for the guard

- **Exercise ID:** [B1.3] (Phase 1 — LLM foundations)
- **What to build:** Swap the `charsPerToken` heuristic in the context guard for an actual token count from a Gemma-compatible tokenizer (e.g. `gpt-tokenizer` as an approximation, or call Ollama's tokenize endpoint if available), so the pre-flight estimate matches reality. Buffr currently *only estimates* — this closes the guess-vs-truth gap before the call.
- **Why it earns its place:** Turns the safe-but-crude guard into an accurate one, and forces you to handle "what if my prompt is 1 token over" honestly instead of with a 30% safety margin.
- **Files to touch:** `src/session.ts:46` (pass a custom guard or `charsPerToken`); a new `src/token-count.ts`. Note the guard itself lives in aptkit and is consumed, not edited — you wire a real counter through its options.
- **Done when:** a test prompt of known token length is guarded using the real count, and the `ContextWindowExceededError` fires within ±2 tokens of the true Ollama count.
- **Estimated effort:** 1–4hr

### Surface token usage in the chat TUI

- **Exercise ID:** [B1.4] (Phase 1 — LLM foundations)
- **What to build:** After each turn, read the `tokens_used` that buffr already persists and render a dim `[~1,240 tok]` line under the answer in `chat.tsx`.
- **Why it earns its place:** Makes the token budget visible to the user, which is the first step toward respecting it. Uses real data buffr already captures (`prompt_eval_count + eval_count`).
- **Files to touch:** `src/cli/chat.tsx`; `src/session.ts` (have `ask()` return tokens alongside the answer); read-only against `src/supabase-trace-sink.ts`.
- **Done when:** each `buffr` turn shows a token count sourced from Ollama's real counts, not the chars/3 estimate.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: "How does buffr count tokens, and where can that go wrong?"**

Model answer: Two different ways for two different jobs. Before the call, the context guard *estimates* with `chars/3` — deliberately conservative so it over-estimates and fails safe, refusing the call rather than overflowing the 8192 window. After the call, it reads Ollama's *exact* counts, `prompt_eval_count` and `eval_count`, flagged `estimated:false`. The trap is using the wrong number for the wrong job — billing on the chars/3 guess, or trying to guard with a count you only get after paying. Buffr keeps them separate.

```
two counts, two jobs
  GUARD (before)  │  chars/3, conservative  │  fail-safe, may over-refuse
  RECORD (after)  │  Ollama eval counts     │  exact, billable
  ★ never cross the streams
```

Anchor: *Estimate to guard, count to bill — chars/3 before, `eval_count` after.*

## See also

- `01-what-an-llm-is.md` — the string this file tokenizes is the model's only input.
- `06-token-economics.md` — the `usage` counts produced here become `messages.tokens_used`.
- `03-sampling-parameters.md` — how one token is chosen from the distribution over the vocabulary.
