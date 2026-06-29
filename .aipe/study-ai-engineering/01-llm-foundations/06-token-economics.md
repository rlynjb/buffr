# Token Economics

*Industry name: token accounting / cost ledger. Type: **Industry standard** (the accounting); **Project-specific** (buffr's local-free twist).*

## Zoom out, then zoom in

Every call spends tokens. *Token economics* is the ledger: who counts them, where they're recorded, what they cost. Here's where buffr's ledger lives, with the recording site marked ★.

```
buffr stack — the token ledger
┌───────────────────────────────────────────────────────────┐
│ GemmaModelProvider   usage{inputTokens, outputTokens}       │ the meter
├───────────────────────────────────────────────────────────┤
│ aptkit agent loop   emits model_usage CapabilityEvent       │ the event
├───────────────────────────────────────────────────────────┤
│ ★ SupabaseTraceSink   model_usage case → persistMessage     │ THE LEDGER WRITE
├───────────────────────────────────────────────────────────┤
│ agents.messages   model, tokens_used = in + out             │ the ledger table
└───────────────────────────────────────────────────────────┘
   (missing: any $ → cost math. Ollama is local & free.)
```

Good news, and it surprises people: **buffr actually keeps the ledger.** Per-call token counts are captured and written to a real Postgres column. The honest caveat: there's no *dollar* math, because `gemma2:9b` runs locally on Ollama — the marginal cost of a token is electricity, not an API invoice. This file is about the real accounting buffr does, and the one column it leaves on the table.

## Structure pass — trace *a token* from meter to ledger

Pick one axis: **the lifecycle of a single token count.** Follow one number from creation to storage.

```
one token count, meter → ledger
  Ollama          │ prompt_eval_count=842, eval_count=210 │ measured
  GemmaProvider   │ usage{inputTokens:842, outputTokens:210, estimated:false} │ wrapped
  agent loop      │ model_usage event {provider, model, in, out} │ emitted
  ★ SupabaseTraceSink │ tokens_used = 842+210 = 1052 │ summed & written
  agents.messages │ row: model='gemma/gemma2:9b', tokens_used=1052 │ STORED (the seam)
```

The seam is the trace sink: that's where a transient in-memory event becomes a durable row. Before it, the count is a fleeting field; after it, it's queryable history. Note the lossy step — input and output are **summed** into one `tokens_used`, so the ledger remembers the total but not the split. That's a real (if minor) information loss to call out.

## How it works

### Move 1 — the mental model: a usage row per call, like a DB audit log

You know audit columns: `created_at`, `updated_by`. Token economics is an audit log for model spend — one row per model call recording who (model), how much (tokens), when (timestamp). The difference from a normal audit log is the cost driver: in a hosted model, `tokens × price` is your bill; locally, it's a usage signal, not an invoice.

```
the ledger row, conceptually
  ┌───────────────┬──────────────────┬─────────────┬─────────────┐
  │ role          │ model            │ tokens_used │ created_at  │
  ├───────────────┼──────────────────┼─────────────┼─────────────┤
  │ 'model_usage' │ 'gemma/gemma2:9b'│ 1052        │ <event ts>  │
  └───────────────┴──────────────────┴─────────────┴─────────────┘
  one row, every model call
```

### Move 2 — the moving parts

#### The meter: Ollama's exact counts, flagged real

The source numbers come from the provider's `usage` block — the same `prompt_eval_count`/`eval_count` from file 02, marked `estimated:false` so the ledger knows these are truth, not the chars/3 guess (`gemma-provider.ts:116–126`). The ledger is only as honest as this flag.

#### The ledger write: the `model_usage` case

`SupabaseTraceSink.emit` handles a `model_usage` event by writing a `messages` row (`src/supabase-trace-sink.ts:73–79`):

```ts
case 'model_usage':
  this.push(persistMessage(pool, conversationId, 'model_usage', '', {
    model: `${event.provider}/${event.model}`,                       // ← 'gemma/gemma2:9b'
    tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),// ← SUM, split is lost
    createdAt: at,
  }));
  return;
```

Annotation that matters: the `?? 0` guards make this robust to a provider that reports only one side, but the `+` collapses input and output into a single number. If you ever want cost (where input and output tokens often have *different* prices on hosted models), you'd need to stop summing here and store both.

```
the write, with its one lossy step
  event {inputTokens:842, outputTokens:210}
        │  (842 ?? 0) + (210 ?? 0)
        ▼
  tokens_used = 1052   ← split GONE; only the total survives
  model = 'gemma/gemma2:9b'
        ▼
  insert into agents.messages (... model, tokens_used ...)
```

#### The ledger table: a real column, previously orphaned

`agents.messages.tokens_used` is an `int` column (`sql/001_agents_schema.sql:48`). The trace sink's own comment notes this column was *"previously dropped on the floor"* and that capturing usage *"fills the otherwise-orphaned tokens_used column."* So this is genuinely wired now — the ledger has data, not just a schema.

```
the ledger table (agents.messages, relevant columns)
  role         text   ← 'model_usage' tags the cost rows
  model        text   ← provider/model
  tokens_used  int    ← in + out (real, not estimated)
  created_at   timestamptz ← event time, for ordering replay
```

### Move 2.5 — current vs future state (the missing $ column)

**Current:** token counts captured per call, summed, stored, queryable. You can `SELECT sum(tokens_used) FROM agents.messages WHERE role='model_usage'` and get a real total. What you *cannot* do: convert that to dollars, or break it down by input vs output, or see a cost-per-conversation dashboard.

**Future:** because Ollama is free, the honest "cost" is throughput/latency, not dollars. The buildable next step is either (a) a `cost-cmd` that aggregates `tokens_used` per conversation, or (b) if buffr ever adds a hosted provider, a `$ = inputTokens × inPrice + outputTokens × outPrice` calc — which would require *un-summing* the trace sink first.

```
current → future
  CURRENT │ tokens_used (sum) per call │ queryable │ NO dollars (local/free)
  FUTURE  │ aggregate per conversation │ dashboard │ + $ only if hosted provider added
           ⚠ dollars need input/output split → stop summing in the trace sink
```

### Move 3 — the principle that generalizes

> **Capture the meter reading whether or not it costs money today — the ledger is cheap, and the day you add a paid provider you'll want the history. But know what you're throwing away: summing input+output saves a column and forfeits cost math.**

Buffr made the right call recording tokens even though they're free — the instrumentation is in place for the day a hosted model gets wired (file 08's whole point is that swap is one constructor). The one wart: the eager sum means "how much did *input context* cost me?" is unanswerable from the current data. That's a deliberate-looking simplification that's actually a future tax.

## Primary diagram

The ledger, end to end, with the lossy sum and the missing dollar step both marked.

```
token economics in buffr
  Ollama: prompt_eval_count + eval_count
        │  GemmaProvider wraps → usage{in, out, estimated:false}   ← the meter (truth)
        ▼
  agent loop emits model_usage {provider, model, inputTokens, outputTokens}
        │
  SupabaseTraceSink.emit (model_usage case)
        │  tokens_used = in + out   ⚠ split discarded
        ▼
  insert agents.messages (role='model_usage', model, tokens_used, created_at)
        │
  query: SELECT sum(tokens_used) ...   ✓ total tokens
        │
        ✗ no $ math (Ollama free) · ✗ no in/out breakdown (summed away)
```

## Elaborate

- **Origin.** Hosted LLM APIs bill per token, usually with input cheaper than output, so "token economics" became a real ops discipline — caching, prompt trimming, output caps all chase the bill. Local models invert the cost: tokens are free, but throughput and VRAM are the constraint.
- **Adjacent concepts.** *Tokenization* (02) produces the counts this file stores. *Caching / cost* (sub-section 06) is where dollar-aware economics would live. *Provider abstraction* (08) — swapping in a hosted provider is what would make dollars real.
- **Honest gap.** No cost dashboard, no dollar conversion, no input/output split in storage. Token *counts* are real and captured; token *cost* is `$0` and unmodeled. Don't claim a "cost ledger" — claim a *token* ledger.
- **What to read next.** File 07 — heuristic-before-LLM, the cheapest possible economy: don't spend the tokens at all.

## Project exercises

### Build a per-conversation token report

- **Exercise ID:** [B1.11] (Phase 1 — LLM foundations) — token capture is **implemented**; this is the next step.
- **What to build:** A `npm run tokens` CLI that queries `agents.messages` and prints tokens-per-conversation and a session total, using the real `tokens_used` buffr already writes.
- **Why it earns its place:** Turns the orphaned-then-filled column into something a human reads, and proves the ledger end to end with a real query.
- **Files to touch:** new `src/cli/tokens-cmd.ts`; read-only against `src/supabase-trace-sink.ts` and `sql/001_agents_schema.sql`.
- **Done when:** the command prints a table of `conversation_id → total tokens` sourced from `role='model_usage'` rows.
- **Estimated effort:** 1–4hr

### Un-sum the ledger to enable cost math

- **Exercise ID:** [B1.12] (Phase 1 — LLM foundations)
- **What to build:** Add `input_tokens` and `output_tokens` columns (or a jsonb usage blob) to the `model_usage` write so the split survives; stop collapsing them in the trace sink. Then a `cost-cmd` that applies a configurable per-token price (default `$0` for Ollama) to show what the same traffic *would* cost on a hosted provider.
- **Why it earns its place:** Removes the future tax this file flags, and makes the "what if we went hosted" question answerable from existing traffic.
- **Files to touch:** `sql/001_agents_schema.sql` (columns); `src/supabase-trace-sink.ts:73–79` (stop summing); new `src/cli/cost-cmd.ts`.
- **Done when:** a `model_usage` row stores input and output separately, and the cost command prints a non-zero hypothetical dollar figure when a price is configured.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: "Does buffr track cost, and how?"**

Model answer: It tracks token *counts*, not dollars. Every model call emits a `model_usage` event with Ollama's real input/output counts (`estimated:false`); the trace sink writes a `messages` row with `model` and `tokens_used = input + output`. So I can query total tokens per conversation. There's no dollar math because `gemma2:9b` runs locally on Ollama — tokens are free. The one honest wart: the trace sink *sums* input and output, so cost math (which prices them differently on hosted models) would first need un-summing. Capturing tokens even though they're free was the right move — the instrumentation is ready the day a paid provider gets swapped in.

```
the honest ledger
  captured │ tokens_used = in + out (real)  │ ✓ queryable
  missing  │ $ conversion                    │ Ollama free
  wart     │ in/out summed away              │ cost math needs the split first
```

Anchor: *Real token ledger, zero-dollar cost — counts captured, the split summed away.*

## See also

- `02-tokenization.md` — where the counts in this ledger come from.
- `07-heuristic-before-llm.md` — the cheapest economy: skip the call entirely.
- `08-provider-abstraction.md` — swapping to a hosted provider is what makes dollars real.
