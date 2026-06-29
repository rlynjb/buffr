# Token Economics

*Token accounting / cost observability — the cost ledger — Industry standard.*

## Zoom out, then zoom in

Every LLM call has a price, and the price is measured in tokens (`02-tokenization.md`). buffr runs locally, so the dollar price is `$0` — but it still *counts the tokens* and persists them to a database column. That persisted count is buffr's cost ledger, partial but real. Here's where the meter is read and where the number lands.

```
  Zoom out — where tokens get metered and stored in buffr

  ┌─ Agent layer (aptkit) ──────────────────────────────┐
  │  runAgentLoop emits a model_usage event per call     │
  └──────────────────────────┬───────────────────────────┘
                             │  CapabilityEvent{ inputTokens, outputTokens }
  ┌─ Trace sink (buffr) ─────▼───────────────────────────┐
  │  ★ SupabaseTraceSink.emit ★                          │ ← the ledger is written HERE
  │    model_usage → tokens_used = in + out              │
  └──────────────────────────┬───────────────────────────┘
                             │  INSERT
  ┌─ Storage layer (Postgres) ▼──────────────────────────┐
  │  agents.messages.tokens_used  (the cost column)      │
  └──────────────────────────────────────────────────────┘

  the tokens themselves come from: Ollama prompt_eval_count + eval_count
  (gemma toResponse, estimated:false — see 02-tokenization.md)
```

Zoom in: a cost ledger answers "what did this turn cost, and where did it go?" In a paid setup that's dollars. Locally, the dollar axis collapses to zero — but the *token* axis and the *latency* axis are still live. buffr captures tokens (real, from Ollama), pins the model name, and stamps the time. What it can't capture locally is a dollar figure. So this is **partial cost observability**: tokens yes, dollars N/A, and latency is the budget that actually bites.

## Structure pass

The ledger spans three layers. Trace the axis **what unit is the cost measured in?** as it crosses them.

```
  Axis: "what's the cost unit?" — across the metering pipeline

  ┌─ Ollama / gemma2:9b ─────────────────────┐
  │  produces token COUNTS (eval_count etc.) │  unit = TOKENS (raw, exact)
  └─────────────────────┬─────────────────────┘
                        │  seam: gemma toResponse maps counts → usage
  ┌─ aptkit event ──────▼─────────────────────┐
  │  model_usage { inputTokens, outputTokens }│  unit = TOKENS (typed event)
  └─────────────────────┬─────────────────────┘
                        │  seam: trace sink SUMS them
  ┌─ Postgres ──────────▼─────────────────────┐
  │  messages.tokens_used = in + out          │  unit = TOTAL TOKENS (one number)
  └───────────────────────────────────────────┘
       dollars would attach HERE (rate × tokens) — but locally = $0
```

The seam that does the real work is the trace sink: it *sums* `input + output` into a single `tokens_used`. That's a deliberate flattening — it loses the in/out split for the cost column (though the raw event still carries both). The dollar axis would attach at the storage layer, multiplying a per-token rate by the count — but there's no rate locally, so that multiplication is absent. Naming the absent multiplication is the honest core of this file.

## How it works

#### Move 1 — the mental model

You know how an analytics layer fires an event on every meaningful action and a backend writes it to a `events` table you can later query? Token economics is that, where the "event" is "the model ran" and the payload is "how many tokens it ate." The strategy: **on every model call, emit a usage event; persist it keyed to the conversation so you can sum cost per turn, per conversation, per day.**

```
  Pattern — meter-on-every-call, persist to a ledger

  model call ──► emit model_usage { provider, model, in, out }
                          │
                          ▼
                 trace sink: tokens_used = in + out
                          │
                          ▼
            INSERT agents.messages (role='model_usage', tokens_used, model, created_at)
                          │
                          ▼
            later: SELECT sum(tokens_used) ... GROUP BY conversation  ← the report
```

Every call leaves a row. The rows are the ledger. Sum them however you slice.

#### Move 2 — the step-by-step walkthrough

**Where the real token counts come from.** Not estimated — Ollama returns exact counts, and aptkit's Gemma provider maps them into the usage object, flagged `estimated:false`.

```
  toResponse — gemma-provider.ts:116-126 (annotated)

  usage: {
    inputTokens: response.prompt_eval_count,   // ← real prompt tokens (the question + context)
    outputTokens: response.eval_count,          // ← real generated tokens (the answer)
    estimated: false,                           // ← trustworthy: from the tokenizer, not len/3
  }
```

These are the numbers the ledger bills on. Contrast the guard's `len/3` *estimate* from `02-tokenization.md` — that one gates, this one accounts. The `estimated:false` flag is the signal that this is ground truth.

**Where the event becomes a ledger row.** buffr's `SupabaseTraceSink` handles the `model_usage` event and writes it as a message with the token sum.

```
  SupabaseTraceSink.emit — supabase-trace-sink.ts:73-79 (annotated)

  case 'model_usage':
    this.push(persistMessage(pool, conversationId, 'model_usage', '', {
      model: `${event.provider}/${event.model}`,                       // ← 'gemma/gemma2:9b'
      tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),// ← in + out, summed
      createdAt: at,                                                    // ← event timestamp
    }));
    return;
```

Three fields carry the cost story: `model` (which function spent the tokens), `tokensUsed` (how many), `createdAt` (when, for ordering and per-period rollups). The `?? 0` guards a missing count so a partial event still writes a row instead of throwing.

**Where it lands in the schema.** `persistMessage` inserts into `agents.messages`, and `tokens_used` is the column that was previously orphaned.

```
  persistMessage INSERT — supabase-trace-sink.ts:27-36 (annotated)

  insert into agents.messages
    (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
  values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
                                          ↑            ↑
                                     model name   tokens_used = the cost column
```

The sink's own comment (`supabase-trace-sink.ts:39-48`) calls this out: capturing `model_usage` "fills the otherwise-orphaned `tokens_used` column." Before this handler, the column existed but nothing wrote it — the meter existed but wasn't read.

```
  Layers-and-hops — one model call, three hops to the ledger

  ┌─ gemma2:9b ──┐  prompt_eval_count + eval_count   ┌─ aptkit loop ────┐
  │  Ollama      │ ───────────────────────────────── │ emit model_usage │
  └──────────────┘  (estimated:false)                └────────┬─────────┘
                                                              │ inputTokens, outputTokens
                                                              ▼
                                          ┌─ SupabaseTraceSink.emit [trace:73] ─┐
                                          │  tokens_used = in + out             │
                                          └────────┬─────────────────────────────┘
                                                   │ INSERT
                                                   ▼
                          ┌─ Postgres: agents.messages.tokens_used [trace:27] ─┐
                          │  role='model_usage', model='gemma/gemma2:9b'       │
                          └────────────────────────────────────────────────────┘
```

**What's missing — and why that's the honest part.** Three things the local setup can't or doesn't capture:

```
  Comparison — full cost observability vs buffr's partial ledger

  axis          paid cloud setup            buffr (local)
  ───────────── ─────────────────────────── ──────────────────────────
  tokens        captured                     captured ✔  [trace:76]
  in/out split  kept per-row                 SUMMED into one number  ~
  dollars       rate × tokens                $0 — no rate exists  ✗
  latency       a budget                     THE budget (laptop) — durationMs
                                             on tool calls, not yet on the model call
```

Locally the dollar column is genuinely N/A — there's no per-token price to multiply. The real budget that bites is *latency*: a 9B model on a laptop is slow, and that's what you'd actually optimize. buffr captures `durationMs` for tool calls (`supabase-trace-sink.ts:69`) but not yet for the model call itself — a clean Case-B gap.

#### Move 3 — the principle

Token economics is cost observability, and observability is worth building even when the current cost is zero — because the *plumbing* is what survives a change of circumstances. buffr counts tokens it doesn't pay for, so that the day it points at a paid endpoint, the ledger already exists and only a rate multiplication is missing. Capture the meter now; attach the price later. And know which axis actually bites you today: locally it's latency, not dollars.

## Primary diagram

```
  Token economics in buffr — the partial cost ledger, full path

  ┌─ Provider: gemma toResponse [gemma:116] ───────────────────────┐
  │  usage { inputTokens=prompt_eval_count,                        │
  │          outputTokens=eval_count, estimated:false }            │  ← real, not len/3
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ aptkit emits model_usage event
                                  ▼
  ┌─ Sink: SupabaseTraceSink.emit [trace:73] ──────────────────────┐
  │  tokens_used = in + out   |   model = 'gemma/gemma2:9b'        │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ persistMessage INSERT [trace:27]
                                  ▼
  ┌─ Storage: agents.messages ─────────────────────────────────────┐
  │  tokens_used  ·  model  ·  created_at   → SELECT sum(...) report│
  └─────────────────────────────────────────────────────────────────┘
   captured: tokens ✔   |   absent: dollars ✗ ($0 local)   |   real budget: latency
```

## Elaborate

Token economics exists because, on paid APIs, tokens *are* the bill — input tokens and output tokens are usually priced differently (output often costs several times more), so the in/out split is the unit of cost control. That's why "shorter prompts, tighter answers, cache the context" are the standard cost levers. buffr inherits the *measurement* machinery from that world without the bill, which is the right call: the cost of capturing usage is one event handler and one column, and it converts "we have no idea what anything costs" into "we have a per-turn token ledger."

The connections run both ways. Backward to `02-tokenization.md`: the `estimated:false` real counts are exactly the tokenizer's output, distinct from the guard's `len/3` estimate. Forward to `05-evals-and-observability/04-llm-observability.md`: `tokens_used` is one signal in the broader trajectory trace, alongside tool calls, durations, and warnings. And the honest gap — no model-call latency, summed in/out, no dollar rate — is what makes this "partial" rather than "complete" cost observability. The standard upgrade path is: add model-call `durationMs`, keep the in/out split, and (if cloud) attach a rate table.

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **exercised (partially)** — Case A for token capture; Case B for the missing latency and rate.

### EX-06-1 — Capture model-call latency into the ledger

- **Exercise ID:** EX-06-1
- **What to build:** Time the model call and persist its `durationMs` alongside `tokens_used` on the `model_usage` row, so the *real* local budget (latency) is observable, not just tokens. Tool calls already record `durationMs`; the model call doesn't.
- **Why it earns its place:** Latency is the budget that actually bites on a laptop. This turns "partial" cost observability into the part that matters locally.
- **Files to touch:** `src/supabase-trace-sink.ts:73-79` (extend the `model_usage` case to carry a duration); confirm the aptkit `model_usage` event exposes timing, else time it in buffr's session around `agent.answer` at `src/session.ts:62`.
- **Done when:** each `model_usage` row carries a duration and you can `SELECT avg(durationMs)` per conversation.
- **Estimated effort:** 1-4hr

### EX-06-2 — A per-conversation token report

- **Exercise ID:** EX-06-2
- **What to build:** A small CLI/script that queries `agents.messages` and reports total `tokens_used`, input/output split if available, and call count per conversation — turning the ledger rows into an actual report.
- **Why it earns its place:** A ledger no one queries isn't observability. This proves the captured data is usable and surfaces the summed-in/out limitation.
- **Files to touch:** new `scripts/token-report.ts`; reads the schema written by `src/supabase-trace-sink.ts:27-36`. Uses `src/db.ts` for the pool.
- **Done when:** running it prints token totals per conversation from real rows.
- **Estimated effort:** 1-4hr

### EX-06-3 — Preserve the input/output split

- **Exercise ID:** EX-06-3
- **What to build:** Stop flattening `in + out` into one `tokens_used` for the cost picture — persist input and output token counts separately (extra columns or a JSON field on the row), so a future dollar rate (output usually costs more) can be applied correctly.
- **Why it earns its place:** Output tokens are priced higher on real APIs; collapsing the split throws away the information any real cost model needs. Future-proofs the ledger.
- **Files to touch:** `src/supabase-trace-sink.ts:73-79` (carry both counts), and the `agents.messages` schema/migration.
- **Done when:** rows record input and output token counts distinctly; `tokens_used` can still be derived as their sum.
- **Estimated effort:** 1-2 days

## Interview defense

**Q: "buffr is local and free. Why does it count tokens at all?"**

Because the plumbing is what survives a change of circumstances. Capturing usage is one event handler and one column; it converts "we have no idea what anything costs" into a per-turn ledger that's ready the day buffr points at a paid endpoint — only a rate multiplication is then missing.

```
  capture now, price later

  tokens (now) ──► tokens_used column ──[+ rate, if cloud]──► dollars
                   $0 locally, but the meter is read
```

*Anchor:* `tokens_used = in + out` written on every `model_usage` event at `supabase-trace-sink.ts:73-78`.

**Q: "So buffr has full cost observability?"**

Partial. It captures real tokens (Ollama's `prompt_eval_count`/`eval_count`, `estimated:false`) and the model name, but the dollar axis is N/A locally and the in/out split is summed into one number. And the budget that actually bites — latency — isn't captured on the model call yet, only on tool calls.

```
  partial ledger

  tokens ✔   model ✔   dollars ✗(local)   model-latency ✗(yet)
```

*Anchor:* real counts at `gemma-provider.ts:116` (`estimated:false`); the summing flatten at `supabase-trace-sink.ts:76`.

## See also

- `02-tokenization.md` — where the real `prompt_eval_count`/`eval_count` come from vs the estimate.
- `05-streaming.md` — why streaming barely affects the ledger (final usage comes at stream end).
- `../05-evals-and-observability/02-eval-methods.md` — `tokens_used` as one signal in the trajectory trace.
- `08-provider-abstraction.md` — the provider whose `toResponse` produces the usage object.
