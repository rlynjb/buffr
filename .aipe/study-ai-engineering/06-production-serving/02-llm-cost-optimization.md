# LLM cost optimization — and what "cost" means when it's local

*Industry standard pattern; partially exercised in buffr (the
observability substrate is real).*

## Zoom out, then zoom in

This is the richest file in the section, because unlike caching
or rate limiting, **buffr has already built the hard
prerequisite**: it captures per-call token usage on every model
call. That number is dead today — nothing routes on it — but
it's the substrate every cost optimization needs, and it's
sitting in `agents.messages`.

```
  Zoom out — where cost is measured (real) vs acted on (dormant)

  ┌─ Agent loop ────────────────────────────────────────────────┐
  │  RagQueryAgent.answer() → emits model_usage events           │
  └───────────────────────────┬─────────────────────────────────┘
                              │  CapabilityEvent { inputTokens, outputTokens }
  ┌─ Trace layer ─────────────▼─────────────────────────────────┐
  │  ★ SupabaseTraceSink — sums tokens → messages.tokens_used ★  │ ← REAL, here
  │   (src/supabase-trace-sink.ts:73-78)                         │
  └───────────────────────────┬─────────────────────────────────┘
                              │  the number exists…
  ┌─ Routing layer ───────────▼─────────────────────────────────┐
  │  [ NOTHING ROUTES ON IT ]  ← dormant: no cheap-first routing │
  └──────────────────────────────────────────────────────────────┘
```

Now the honest reframe. Standard cost optimization is about
**dollars** — route trivial queries to a cheap model, reserve the
expensive one for hard queries, cache to avoid the bill. buffr
runs Gemma and the embedder *locally on the laptop*, so the
dollar cost is **exactly $0**. The optimization target isn't
money — it's **latency and tokens.** Locally, "cost" = how long
the user waits + how many tokens the model chews. That reframe is
the whole point of this file.

## Structure pass

**Layers:** loop (spends tokens) → trace (measures them, real) →
routing (would act on them, dormant).

**Axis — "cost: what does each query pay, and is the payment
measured or acted on?"**

```
  trace "cost" across the measure→act seam

  ┌─ measured (real) ──┐  seam   ┌─ acted on (dormant) ───────┐
  │ tokens_used summed │ ═══════►│ NOTHING reads tokens_used  │
  │ per call, persisted│ (flips) │ to route or skip work      │
  └────────────────────┘         └────────────────────────────┘
       observability: YES              optimization: NO

  the seam where buffr stops: it sees the cost but never spends
  it differently. that gap IS the Case-B opportunity.
```

The seam is load-bearing because crossing it is the difference
between "I have a dashboard" and "I have a cheaper system." buffr
is on the left side of that seam — which is further than most
local toys get, and exactly the honest place to stand.

## How it works

### Move 1 — the mental model

Cost optimization is **triage**: not every patient needs the
trauma surgeon. A simple lookup ("what's my name") doesn't need
retrieval *and* a 9B-parameter generation; a hard synthesis does.
The pattern is a router that sizes the response to the question —
the same instinct as `01-llm-foundations/07-heuristic-before-llm`
(don't call the model when a regex will do), one altitude up.

```
  the cost-routing kernel — size the work to the question

  question
     │
     ▼
  classify difficulty   ← cheap check: length? keyword? embedding?
     │
     ├─ trivial  ──► skip retrieval / smaller model / canned   (cheap)
     │
     └─ hard     ──► full embed → retrieve → gemma2:9b          (full)
```

### Move 2 — the step-by-step walkthrough

The measurement half is real; the routing half is Case B. Walk
both.

**Step 1 — the model emits a usage event (real).** Every model
call in aptkit emits a `model_usage` CapabilityEvent carrying
input and output token counts. buffr's sink catches it:

```ts
// src/supabase-trace-sink.ts:73-78 (the model_usage case)
case 'model_usage':
  this.push(persistMessage(pool, conversationId, 'model_usage', '', {
    model: `${event.provider}/${event.model}`,
    tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),  // ← the budget unit
    createdAt: at,
  }));
  return;
```

Read line 76: input + output tokens summed into one `tokensUsed`.
That single number — persisted into `messages.tokens_used` by
`persistMessage` (`src/supabase-trace-sink.ts:33`) — is the unit
of buffr's local budget. It's not dollars; it's the thing that
*correlates* with latency, because more tokens = more compute =
more wait on a laptop GPU.

**Step 2 — nothing reads it back (the gap).** Grep `src/` for
`tokens_used` as a read and you get nothing. The number is
write-only today. That's the precise boundary of "partially
exercised": buffr **measures** cost perfectly and **acts on it**
not at all.

```
  the measure→act gap, concretely

  write path (real):   model_usage event → tokens_used column ✓
  read  path (gap):    tokens_used → routing decision        ✗
                       tokens_used → latency dashboard        ✗
                       tokens_used → "this query was wasteful" ✗
```

**Step 3 — the Case-B router: skip retrieval for trivial
queries.** The cheapest optimization isn't a smaller model — it's
*not doing the retrieval at all* when the question doesn't need
the corpus. Today every `ask()` runs the full agent path:

```ts
// src/session.ts:60-71 — every question gets the full treatment
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);  // ← always full: embed+retrieve+gen
  ...
}
```

A pre-check before line 62 — "is this a greeting / a meta
question / under N tokens with no content words?" — could answer
trivially without spending the retrieval embed + the search + the
larger generation. This is the same family as the
heuristic-before-LLM gate, applied to the *retrieval* decision
instead of the model decision.

**Step 4 — the harder route: a smaller model for easy queries.**
Ollama can serve more than one model. A `gemma2:2b` for trivial
queries and `gemma2:9b` for hard ones is a classic cheap-first
route. The model provider is injected at one point
(`src/session.ts:46`), so a router that picks the provider per
question slots in there. The cost you're saving locally is
latency: the 2b model answers in a fraction of the wall-clock
time.

```
  layers-and-hops — Case-B cost router across the session

  ┌─ Session ─────────┐  hop 1: classify(question)   ┌─ Router ──────┐
  │  ask(question)    │ ────────────────────────────►│  trivial?     │
  └───────────────────┘                              └──────┬────────┘
        ▲                                       hop 2a │ trivial
        │ hop 3: answer                                ▼
        │                                       skip retrieval,
        │                                       gemma2:2b  (fast)
        │                                       hop 2b │ hard
        │                                              ▼
        └───────────────────────────────────── full path, gemma2:9b (slow)
```

### Move 2 variant — the load-bearing skeleton

Kernel of cost optimization: **measure cost per unit + classify
the unit + route to the cheapest sufficient path.**

- Drop **measurement** → you optimize blind; you can't prove the
  router helped. (buffr has this — the real part.)
- Drop **classification** → every query takes the same path;
  there's nothing to route. (buffr is here — the gap.)
- Drop **routing** → you measured and classified but still spend
  full price.

Skeleton = measure + classify + route. Caching, batching, and
quantization are hardening on top of a working router.

### Move 2.5 — current state vs future state

```
  Phase A (today)                  Phase B (Case B — act on the number)
  ─────────────                    ────────────────────────────────────
  tokens_used captured per call    same capture, UNCHANGED
  every query: full path           classify before agent.answer()
  no difficulty signal used        trivial → skip retrieval / 2b model
  latency = always the 9b path     latency = sized to the question
```

What doesn't change: the trace sink, the token capture, the
schema. The substrate is already built — Phase B is purely
*reading* a number you already write, plus one branch in
`src/session.ts`.

### Move 3 — the principle

You cannot optimize what you don't measure, and you've half-built
the optimization the moment you measure honestly. buffr made the
right first move — capture `tokens_used` on every call — even
though there's nothing to optimize against locally yet. The
deeper principle: "cost" is whatever's scarce. On a paid API it's
dollars; on a laptop it's the user's patience. Same kernel,
different denominator.

## Primary diagram

```
  buffr cost — measured (real) vs optimized (Case B), one frame

  Loop:     RagQueryAgent.answer() ─► model_usage event
                                          │ inputTokens + outputTokens
  Trace:    SupabaseTraceSink ───────────►│
            tokens_used = sum ─────► messages.tokens_used  ◄── REAL substrate
                                          │
                                   (write-only today)
                                          │
  Routing:  ┌───────────────────────────▼──────────────────┐
            │  Case B: classify(question)                    │
            │   trivial → skip retrieval / gemma2:2b  (fast) │  ◄── DORMANT
            │   hard    → full path / gemma2:9b       (slow) │
            └────────────────────────────────────────────────┘

  local cost = latency + tokens, NOT dollars ($0 on-device)
```

## Elaborate

Cost optimization in LLM apps grew up around the API bill —
cheap-model-first routing (cascade from Haiku-class to
Opus-class, escalating only on low confidence), prompt
compression, and caching all exist to shrink a per-token invoice.
buffr inverts the economics: local serving makes the marginal
dollar cost zero, which sounds like it kills the topic but
actually just **changes the denominator to latency.** A laptop GPU
running a 9B model is the scarce resource; every token it
generates is wall-clock the user feels. So the entire toolkit
transfers — routing, skipping retrieval, smaller models — with
latency swapped in for dollars. And buffr already did the part
most toy projects skip: it measures the unit
(`src/supabase-trace-sink.ts:73-78`). That's why this is the one
"partially exercised" file in the section.

## Project exercises

> No curriculum file present; exercises derived from the
> codebase. Cost *observability* is exercised; cost
> *optimization* is Case B.

### Skip retrieval for trivial queries

- **Exercise ID:** COST-1 (Case B — the cheapest optimization).
- **What to build:** a cheap classifier before `agent.answer()`
  that detects trivial queries (greetings, meta-questions, very
  short no-content questions) and answers without the retrieval
  embed + search.
- **Why it earns its place:** it's the heuristic-before-LLM gate
  applied to retrieval, and it cuts the most latency for the
  least code — a clean "I sized the work to the question" story.
- **Files to touch:** `src/session.ts:60-71` (branch before line
  62).
- **Done when:** a greeting produces a trace with zero retrieval
  tool-calls and visibly lower `tokens_used` than a real query.
- **Estimated effort:** 1–4hr.

### Cheap-model-first router (gemma2:2b vs 9b)

- **Exercise ID:** COST-2 (Case B — the richer route).
- **What to build:** a router that picks `gemma2:2b` for
  classified-easy queries and `gemma2:9b` for hard ones, injected
  at the model-provider construction point.
- **Why it earns its place:** the canonical cascade pattern,
  measured locally in latency, with `tokens_used` as the ground
  truth that the router actually saved compute.
- **Files to touch:** `src/session.ts:46` (provider construction
  — make it per-question), possibly a new `src/model-router.ts`.
- **Done when:** easy queries route to 2b with measurably lower
  latency, and the trace shows which model answered.
- **Estimated effort:** 4hr–1d.

### A latency/token dashboard from the substrate

- **Exercise ID:** COST-3 (Case A — read the number you already
  write).
- **What to build:** a CLI query that reads `messages.tokens_used`
  grouped by conversation/query and reports mean tokens and (with
  a timestamp delta) mean latency.
- **Why it earns its place:** crosses the measure→act seam at its
  cheapest — it makes the dormant column visible without changing
  any serving path.
- **Files to touch:** a new `src/cli/cost-cmd.ts` (mirror
  `src/cli/eval-cmd.ts`), reading `agents.messages`.
- **Done when:** `npm run cost` prints per-query token and
  latency stats.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How do you optimize cost in buffr when it's free to run?**
Answer: locally the dollar cost is zero, so "cost" is latency and
tokens — the user's patience and the GPU's compute. buffr already
captures the right unit: `tokens_used` per call, summed from the
`model_usage` event in `src/supabase-trace-sink.ts:73-78`. The
optimization I'd add is triage — skip retrieval for trivial
queries, and route easy ones to a smaller Ollama model.

**Q: What's the one thing you'd point to as already done right?**
Answer: the measurement substrate. **The load-bearing part people
skip is capturing the cost unit before there's anything to
optimize** — buffr persists per-call tokens write-only today, so
the day routing is worth it, the ground truth to prove it helped
is already in the table.

```
  the one-liner:  local cost = latency + tokens, not $  ·
                  buffr measures it (real), routes on it (Case B)
```

## See also

- `01-llm-caching.md` — the cheapest route of all: don't call the
  model twice for the same question.
- `../01-llm-foundations/07-heuristic-before-llm.md` — the same
  triage instinct, one layer down (skip the model entirely).
- `../01-llm-foundations/06-token-economics.md` — tokens as the
  shared unit of cost and latency.
- `../05-evals-and-observability/04-llm-observability.md` — the
  trace that captures `tokens_used`; the substrate this file
  builds on.
