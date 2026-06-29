# Tokenization

*Subword tokenization · text ↔ token IDs — Industry standard.*

## Zoom out, then zoom in

The model from `01-what-an-llm-is.md` is a function over *tokens*, not characters and not words. Before that function runs, your text gets chopped into tokens; after it runs, tokens get glued back into text. buffr never does this chopping itself — but it estimates it, and it logs the real counts. Here's where both happen.

```
  Zoom out — where tokens enter the picture in buffr

  ┌─ Agent layer ───────────────────────────────────────┐
  │  RagQueryAgent builds {system, messages, tools}      │
  └──────────────────────────┬───────────────────────────┘
                             │  text (chars)
  ┌─ Guard (aptkit local) ───▼───────────────────────────┐
  │  ★ ContextWindowGuardedProvider ★                    │ ← we estimate tokens HERE
  │     estimateTextTokens(text, charsPerToken=3)        │   (~3 chars/token, a guess)
  └──────────────────────────┬───────────────────────────┘
                             │  HTTP /api/chat
  ┌─ Provider / Ollama ──────▼───────────────────────────┐
  │  gemma2:9b tokenizer: text → token IDs → text        │ ← real tokenization HERE
  │  returns prompt_eval_count + eval_count (real counts)│
  └──────────────────────────────────────────────────────┘
```

Zoom in: there are **two** token numbers in buffr, and they're different things. One is an *estimate* the guard computes locally to decide whether the prompt fits (`~3 chars/token`). The other is the *real* count Ollama's tokenizer produces and returns after the call (`prompt_eval_count`, `eval_count`). buffr trusts the estimate to gate, and trusts the real count to bill. Confusing the two is the classic tokenization trap.

## Structure pass

Two layers touch tokens. Trace the axis **how accurate is this token count?** across them.

```
  Axis: "how accurate is this count?" — estimate vs ground truth

  ┌─ Guard layer (pre-call) ─────────────────┐
  │  estimateTextTokens(len/3)               │  accuracy = APPROXIMATE
  │  purpose: gate before sending            │  (deliberately conservative)
  └─────────────────────┬─────────────────────┘
                        │  seam: the HTTP call to Ollama
  ┌─ Ollama layer (post-call) ▼───────────────┐
  │  gemma2:9b real tokenizer                 │  accuracy = EXACT
  │  prompt_eval_count / eval_count           │  (the truth, for billing)
  └───────────────────────────────────────────┘
```

The seam is the HTTP call. *Before* it, you only have an estimate — you can't run Gemma's tokenizer locally without loading the model, so you approximate. *After* it, Ollama hands back the exact counts. The axis flips from "approximate, conservative, cheap" to "exact, authoritative, free (you already paid for the call)." That flip is why the guard uses `3` chars/token (under-estimates length → over-estimates tokens → fails *safe*), while the ledger persists the real numbers.

## How it works

#### Move 1 — the mental model

You know how `"café".length` in JS is 4 but the byte length is 5 because `é` is multibyte? Tokenization is that mismatch, one level up: the unit the model counts in ("tokens") isn't characters and isn't words — it's *subword pieces*, learned from data. Common words are one token; rare words split into several. The strategy: **a fixed vocabulary of subword pieces; greedily match the longest piece at each position.**

```
  Pattern — subword tokenization (BPE-style, what gemma2:9b uses)

  text:    "tokenization isn't hard"
            │
            ▼  longest-match against a learned vocab
  tokens:  [token] [ization] [ isn] ['t] [ hard]
            │        │         │     │     │
            └────────┴─────────┴─────┴─────┘
           common chunk = 1 token; rare word = many tokens
           leading spaces often glue onto the next piece

  rough rule of thumb for English: ~4 characters per token
```

So `~4 chars/token` is the *real-world average* for English text. buffr's guard uses `~3` — a deliberately tighter number, explained below.

#### Move 2 — the step-by-step walkthrough

**The estimate buffr computes before the call.** buffr can't run Gemma's tokenizer without the model loaded, so the guard approximates from string length. This is the only place buffr "tokenizes," and it's a division.

```
  estimateTextTokens — context-window-guard.ts:100-103 (annotated)

  export function estimateTextTokens(text: string, charsPerToken = 3): number {
    if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
    return Math.ceil(text.length / charsPerToken);   // ← chars ÷ 3, round UP
  }
```

`Math.ceil(text.length / 3)`. Note the `3`, not `4`. Using `3` chars/token instead of the real-world `~4` makes the estimate *larger* than reality — you'll think the prompt has more tokens than it does. That's the point: it's a guard, so it should refuse early rather than let a too-big prompt through. Under-counting tokens here would be the dangerous direction.

**What the estimate is summed over.** It's not just the user's question — it's the whole request: system prompt, every message, and the rendered tool schemas.

```
  estimateModelRequestTokens — context-window-guard.ts:91-98 (annotated)

  const text = [
    request.system ?? '',                                 // the system prompt + profile
    ...request.messages.map(messageText),                 // every turn so far
    ...(request.tools ?? []).map((tool) =>                // ← tool schemas count too!
      `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);         // one number for the whole request
```

The tool schemas are serialized to JSON and counted — because Gemma's tool-call emulation (`08-provider-abstraction.md`) renders those same schemas into the prompt as text. They are real input tokens. Forget to count them and your estimate is wrong by exactly the schema size.

**The real counts, after the call.** Ollama runs the actual tokenizer and returns two numbers; aptkit's Gemma provider maps them straight through, marked *not estimated*.

```
  toResponse — gemma-provider.ts:116-126 (annotated)

  usage: {
    inputTokens: response.prompt_eval_count,   // ← real tokens in the prompt
    outputTokens: response.eval_count,          // ← real tokens generated
    estimated: false,                           // ← these are GROUND TRUTH, not a guess
  }
```

`estimated: false` is the contract that tells the rest of the system "trust these — they came from the tokenizer, not from `len/3`." These are the numbers `06-token-economics.md` persists into `messages.tokens_used`. buffr's honesty here is worth naming: it never pretends its `len/3` guess is real; it gates with the guess and bills with the truth.

```
  Layers-and-hops — the two token numbers, where each is born

  ┌─ Guard ──────┐  estimate = ceil(len/3)        ┌─ Ollama ─────────┐
  │ guard.complete│ ──── gate decision ────────────│ gemma2:9b        │
  └──────┬────────┘  (block if > 8192-768)         │ real tokenizer   │
         │                                          └────────┬─────────┘
         │  hop: HTTP only if estimate passes               │ real counts
         │                                                   ▼
         │                              prompt_eval_count + eval_count
         │                                  (estimated: false)
         ▼                                                   │
   trace warning if blocked                                  ▼
                                          messages.tokens_used (the ledger)
```

#### Move 3 — the principle

Tokens are the model's native unit, and you almost never have the exact count until *after* the call — so you keep two numbers: a cheap conservative estimate to gate, and the provider's authoritative count to account. Never let the estimate masquerade as the truth. buffr models this split cleanly: `len/3` to refuse early, `prompt_eval_count`/`eval_count` (`estimated:false`) to bill.

## Primary diagram

```
  Tokenization in buffr — estimate path vs truth path

  text (chars)
     │
     ├─────────────► PRE-CALL: estimateTextTokens(text, 3)        [guard.ts:100]
     │                   = ceil(text.length / 3)  ← conservative
     │                   sum over {system, messages, tool schemas} [guard.ts:91]
     │                   ok if ≤ maxTokens(8192) − outputReserve(768)
     │                       │ fail → throw + emit 'warning' trace
     │                       │ pass
     ▼                       ▼
  ┌─ HTTP /api/chat → Ollama → gemma2:9b ──────────────────────────┐
  │   REAL tokenizer: text → token IDs → generate → text           │
  │   returns prompt_eval_count (in) + eval_count (out)            │
  └────────────────────────────┬───────────────────────────────────┘
                               ▼
        usage { inputTokens, outputTokens, estimated:false }  [gemma:116]
                               │
                               ▼
        messages.tokens_used = in + out  (the real ledger)   [trace-sink:73]
```

## Elaborate

Subword tokenization (BPE / WordPiece / SentencePiece, depending on the model family) was invented to solve a vocabulary problem: a pure-word vocabulary can't handle words it never saw at training time, and a pure-character vocabulary makes sequences far too long. Subwords are the compromise — frequent words stay whole, novel words decompose into known pieces, nothing is unrepresentable.

For buffr the practical consequences are two. First, *token count drives cost and the context budget*, not character count — so `02` feeds directly into `06-token-economics.md` and into `02-context-and-prompts/`. Second, different tokenizers give different counts for the same text, which is exactly why buffr can only *estimate* before the call and must wait for Ollama's authoritative number. If buffr ever swapped `gemma2:9b` for a model with a different tokenizer, the `len/3` constant would want re-tuning, but the real counts would just update themselves.

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **partially exercised** (Case A for the estimate + real-count logging; the tuning is open).

### EX-02-1 — Calibrate the chars-per-token constant against real counts

- **Exercise ID:** EX-02-1
- **What to build:** A script that runs a handful of representative questions through a session, captures the guard's *estimated* input tokens and Ollama's *real* `prompt_eval_count`, and reports the actual chars/token ratio — telling you whether `3` is too tight, about right, or wastefully conservative for buffr's prompts.
- **Why it earns its place:** Turns a magic constant into a measured one; directly informs the context budget in `02-context-and-prompts/`.
- **Files to touch:** new `scripts/calibrate-chars-per-token.ts`; read `src/session.ts:46` and `src/supabase-trace-sink.ts:73-78` (the persisted real counts) — do not edit aptkit's guard.
- **Done when:** the script prints estimated vs real token counts side by side and a suggested `charsPerToken`.
- **Estimated effort:** 1-4hr

### EX-02-2 — Make the guard's charsPerToken configurable from env

- **Exercise ID:** EX-02-2
- **What to build:** Thread a `CONTEXT_CHARS_PER_TOKEN` env var through `loadConfig` and into the `ContextWindowGuardedProvider` options at session construction (aptkit already accepts `charsPerToken`; buffr just doesn't pass it).
- **Why it earns its place:** Lets the calibrated value from EX-02-1 actually take effect without editing aptkit; a clean config seam.
- **Files to touch:** `src/config.ts` (add field), `src/session.ts:46` (pass it into the guard options).
- **Done when:** setting the env var changes the gate threshold, verified by a test feeding a borderline-size prompt.
- **Estimated effort:** <1hr

## Interview defense

**Q: "buffr estimates ~3 chars/token but the rule of thumb is ~4. Bug?"**

No — it's a deliberately conservative gate. Estimating fewer chars per token yields *more* estimated tokens, so the guard refuses borderline-large prompts early rather than letting a too-big one through and failing at the model.

```
  why 3, not 4 — fail safe

  3 chars/tok → MORE est. tokens → blocks sooner       ✔ safe
  4 chars/tok → fewer est. tokens → might let too-big   ✗ risky
```

*Anchor:* `estimateTextTokens(text, charsPerToken = 3)` at `context-window-guard.ts:100`.

**Q: "Does buffr tokenize text itself?"**

No. It *estimates* token count by character length for gating, but the actual tokenization happens inside Ollama/`gemma2:9b`, which returns the real `prompt_eval_count` and `eval_count` marked `estimated:false`.

```
  estimate (buffr) ≠ tokenize (Ollama)

  buffr: len/3 ─► gate
  Ollama: real tokenizer ─► real counts ─► ledger
```

*Anchor:* real counts mapped at `gemma-provider.ts:116-126`; the estimate never claims to be them.

## See also

- `01-what-an-llm-is.md` — why the model counts in tokens at all.
- `06-token-economics.md` — where the real `prompt_eval_count`/`eval_count` get persisted.
- `../02-context-and-prompts/` — the context-window budget those token counts feed.
- `08-provider-abstraction.md` — why tool schemas count as input tokens (they're rendered into the prompt).
