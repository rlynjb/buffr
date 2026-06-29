# LLM Cost Optimization

*Industry name: model routing / cascade / cheap-model-first. Type: **Language-agnostic** serving pattern.*

## Zoom out, then zoom in

In a cloud deployment, "cost optimization" means dollars: route the easy 80% of queries to a cheap model and reserve the expensive frontier model for the hard 20%. Buffr breaks that framing on purpose — Ollama is local and free, so the dollar cost of every call is exactly zero. The cost that *does* exist is **latency and compute**: a `gemma2:9b` generation pins your laptop's GPU/CPU for seconds. Here's where routing would sit, and the slot is empty.

```
buffr serving stack — the missing router
┌─────────────────────────────────────────────────────────────┐
│ session.ask()   ◀── ★ MODEL ROUTER would sit here            │  (empty)
├─────────────────────────────────────────────────────────────┤
│ RagQueryAgent.answer()                                       │
├─────────────────────────────────────────────────────────────┤
│ ContextWindowGuardedProvider                                 │
│   └─ GemmaModelProvider  ── ONE model: gemma2:9b, always     │  no choice
├─────────────────────────────────────────────────────────────┤
│ SupabaseTraceSink   model_usage → messages.tokens_used       │  ★ the meter
└─────────────────────────────────────────────────────────────┘
```

There is exactly one model, `gemma2:9b`, and every turn pays its full latency. **This is Case B: no routing is implemented.** But unlike caching, buffr already ships the *measurement substrate* you need before you can route — the token meter. This file reframes "cost" as latency/compute, names the meter, and makes the router the exercise.

## Structure pass — trace *latency cost* across query difficulty

Pick one axis: **how much compute does a query deserve, versus how much it gets?** Trace it across difficulty levels.

```
compute spent vs compute deserved (buffr today)
  "hi"                       │ gemma2:9b full generation │ over-served  ← wasted seconds
  "thanks"                   │ gemma2:9b full generation │ over-served  ← wasted seconds
  "summarize my deploy doc"  │ gemma2:9b full generation │ justified
  "explain this stack trace" │ gemma2:9b full generation │ justified
  ──────────────────────────────────────────────────────────────────────
  no seam: every query gets the 9B model whether it needs it or not
```

There's no seam — that's the problem. A routed system grades difficulty at the top and spends accordingly: trivial → no model or a tiny one; hard → the big model. Buffr gives the 9B model to "hi" and "thanks," each costing the same multi-second generation as a real question. On a laptop that's not a billing line — it's the user staring at a spinner for an answer a regex could have produced instantly.

## How it works

### Move 1 — the mental model: a cascade that escalates only when needed

Routing is a cascade. A cheap stage handles what it can and *escalates* only what it can't. The stages, cheapest first: no model at all (a canned/heuristic answer), then a small fast model, then the full model. Each stage is a filter; only the residue flows down.

```
the cascade — escalate only the residue
  query
    │
  stage 0: heuristic/canned   ── handles "hi","thanks","help"   ── no model
    │ (residue)
  stage 1: small model        ── handles simple lookups         ── fast, cheap compute
    │ (residue)
  stage 2: gemma2:9b          ── handles reasoning/synthesis     ── full compute
```

### Move 2 — the moving parts

#### Bridge: it's a CDN tier, but the "tier" is model size

You already route by cost on the web: serve a static asset from the edge CDN (cheap), hit the origin only on a miss (expensive). Model routing is the same shape, where the "edge" is a heuristic or a small model and the "origin" is `gemma2:9b`. The terminology lead is **model routing (the single-model bypass)** — "bypass" because the only routing decision buffr could make today is *whether to call the one model at all*.

The router's natural home is `session.ask()`, the same slot the heuristic gate (`01-llm-foundations/07`) wants. They're the same mechanism viewed from two angles: the heuristic gate asks "do we need the LLM?"; the router asks "*which* LLM?" — and "none" is a valid answer to both.

#### The meter you already have: `model_usage` → `messages.tokens_used`

You cannot optimize cost you don't measure. Buffr's `SupabaseTraceSink` already captures it. Every model call emits a `model_usage` event, and the sink writes the token count to `agents.messages` (`src/supabase-trace-sink.ts:73–79`):

```ts
// src/supabase-trace-sink.ts:73
case 'model_usage':
  this.push(persistMessage(pool, conversationId, 'model_usage', '', {
    model: `${event.provider}/${event.model}`,
    tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
    createdAt: at,
  }));
  return;
```

```
the meter — every generation lands a measurable row
  GemmaModelProvider.toResponse()  ── usage: {inputTokens, outputTokens}
        │ (emitted as model_usage CapabilityEvent)
  SupabaseTraceSink.emit()
        │
  agents.messages(role='model_usage', model='gemma/gemma2:9b', tokens_used=N)
        │
  ★ this table IS your cost baseline: tokens per turn, by question
```

Those token counts come straight from Ollama's `prompt_eval_count` + `eval_count`, surfaced in `GemmaModelProvider.toResponse()` (`gemma-provider.ts:116–126`). Tokens are the laptop's proxy for compute time: more tokens in/out ≈ more seconds on the GPU. So the meter is real and per-turn — what's missing is anything that *acts* on it.

#### The decision buffr can make today: skip the model entirely

With a single local model and no smaller variant pulled, the only routing buffr can do *right now* is the binary one: route to "no model" for trivial inputs. That's the heuristic-before-LLM gate, and it's the highest-leverage routing decision because skipping the 9B generation saves the most latency. A multi-tier cascade needs a second model in Ollama (e.g. a smaller `gemma2:2b` or a quantized variant) pulled and registered.

### Move 2.5 — current vs future

```
current (buffr today)              │  future (after the exercise)
────────────────────────────────────┼────────────────────────────────────
models available to route to: 1     │  3 tiers: none / small / gemma2:9b
routing decision: none (always 9b)  │  heuristic grades difficulty, escalates
cost meter: model_usage rows EXIST  │  meter drives the router (measured ➜ acted on)
"hi" cost: full 9b generation       │  "hi" → canned, no model, instant
```

The honest gap: the meter is built, the router is not. Buffr *measures* per-turn token cost and does *nothing* with the measurement. That's the defining shape of this concept in buffr — instrumented but not optimized.

### Move 3 — the principle

**Match the compute to the difficulty, and the cheapest correct stage wins.** In dollars or in seconds, the logic is identical: never spend frontier-model effort on a problem a regex solves. Buffr's twist is that "cost" is latency on a shared laptop, not a cloud invoice — which makes the *user-facing* payoff (no spinner for "hi") more visceral than a billing dashboard, even though the mechanism is the same.

## Primary diagram

The full cost story: the live meter, the empty router, and the one routing decision buffr can make today.

```
buffr cost optimization — meter live, router empty
  query ──▶ session.ask()
              │
   ┌──────────┴───────────┐
   │  ★ ROUTER (empty)     │
   │  grade difficulty:    │
   │   trivial → ─────────────────▶ canned answer (no model)   ◀ buffr CAN do this today
   │   simple  → ─────────────────▶ small model (needs 2nd Ollama model)
   │   hard    → ─────────────────▶ gemma2:9b                  ◀ the only path today
   └──────────────────────┘
              │
        GemmaModelProvider ──▶ usage{in,out tokens}
              │
        SupabaseTraceSink ──▶ messages.tokens_used   ◀ ★ THE METER (live, unused by router)
```

## Elaborate

The reason this is **Case B by design** is that the dollar pressure that forces routing in the cloud simply isn't present on a free local model. But the latency pressure *is* — and it's worse, because there's no horizontal scaling to hide behind. One slow generation blocks the one user. So the right first move is not a model cascade; it's the binary "skip the model" route, which is the heuristic gate from Phase 1. Pull a second smaller model only when you have eval evidence that it answers the easy tier acceptably — otherwise you've traded latency for wrong answers, which is a bad trade.

A subtle point for the interview: buffr's token meter measures *cost*, but cost is not *value*. A 2000-token answer isn't four times better than a 500-token one. Routing on token count alone optimizes the wrong thing — you want to route on predicted *difficulty*, using token count only as the after-the-fact compute proxy. The meter is the baseline you measure against, not the signal you route on.

## Project exercises

### Exercise: difficulty-graded model router

- **Exercise ID:** [B5.3] (Phase 5, production-serving)
- **What to build:** A router in `session.ask()` that grades each query and routes it. Tier 0: a heuristic (length, keyword, regex for greetings/thanks) returns a canned answer with no model call. Tier 1 (optional, if a second model is pulled): a small Ollama model for simple lookups. Tier 2: the existing `gemma2:9b` path. Use the `model_usage` rows already captured to prove the router saves compute.
- **Why it earns its place:** It turns the live token meter from a passive log into an active control signal, and it removes the multi-second spinner for trivial inputs — the most visible latency win available on a laptop. Tier 0 alone is shippable without pulling any new model.
- **Files to touch:** `src/session.ts` (the routing fork at the top of `ask()`), a new `src/router.ts` (the difficulty grader), `src/config.ts` if you register a second model host/name. The meter in `src/supabase-trace-sink.ts` is reused as-is.
- **Done when:** A trivial query ("hi") returns instantly with *zero* `model_usage` rows, a substantive query still routes to `gemma2:9b`, and the `agents.messages` token totals over a mixed session are measurably lower than the all-9B baseline.
- **Estimated effort:** Tier 0 only: half a day. With a second model: one to two days (pulling, registering, eval-gating the small tier).

### Exercise: per-turn latency dashboard from the existing meter

- **Exercise ID:** [B5.4] (Phase 5, production-serving)
- **What to build:** A small read-side that aggregates the `model_usage` rows in `agents.messages` into a per-turn and per-session view — tokens in/out, total tokens, and (if you also record wall-clock via the existing `durationMs` on tool events) latency per turn. No new instrumentation; just query and present what's already captured.
- **Why it earns its place:** You can't optimize what you can't see. This makes the *cost baseline* legible, which is the prerequisite for trusting that a router actually helped. It also surfaces which question types are expensive — the data that tells you *where* to route.
- **Files to touch:** A new `src/cli/cost.ts` (or a subcommand under `src/cli/`), reading `agents.messages`; no schema change — `tokens_used`, `model`, and tool `durationMs` already exist.
- **Done when:** Running the command on a real session prints tokens-per-turn and total compute, and the most expensive turns are identifiable by question — giving you the evidence to justify a router.
- **Estimated effort:** Half a day.

## Interview defense

**Q: "How do you control LLM cost in buffr?"**

Honest answer: there's no dollar cost — Ollama is local and free — so the cost I optimize is latency and compute, which on a single laptop is the real constraint. Today there's no routing; every turn pays a full `gemma2:9b` generation, including trivial ones like "hi." What I *do* have is the meter: the trace sink captures per-call token counts into `agents.messages`, which is the baseline any optimization measures against. The first optimization I'd ship is the binary route — skip the model entirely for trivial inputs via a heuristic gate — because skipping the 9B generation is the biggest latency win and needs no new model.

```
buffr cost = latency/compute, not dollars
  meter: model_usage → tokens_used   (BUILT)
  router: grade difficulty, escalate (Case B)
  first move: route trivial → no model (skip the 9B spinner)
```

*Anchor:* "Free model, but not free latency — and latency has no horizontal scaling to hide behind on a laptop."

**Q: "Why not just always use a smaller model to be faster?"**

Because a smaller model trades latency for accuracy, and that's only a good trade if eval evidence shows the small model answers the *easy* tier acceptably. Routing exists precisely so I *don't* have to make that trade globally — easy queries go small, hard ones stay on `gemma2:9b`. Picking one model for everything is the choice routing is designed to avoid.

```
one-model-fits-all is the problem routing solves
  all-small: fast, wrong on hard queries
  all-9b:    correct, slow on trivial queries   ← buffr today
  routed:    small on easy, 9b on hard          ← the goal
```

*Anchor:* "Route on predicted difficulty; measure with tokens; never route on tokens alone."

## See also

- `../01-llm-foundations/07-heuristic-before-llm.md` — the Tier-0 route; the same `session.ask()` slot, viewed as "do we need the LLM" vs "which LLM."
- `../01-llm-foundations/06-token-economics.md` — the token ledger this concept measures against.
- `../01-llm-foundations/08-provider-abstraction.md` — why swapping in a second model is a one-constructor change.
- `01-llm-caching.md` — the sibling lever: a cache *avoids* the call, routing makes the call *cheaper*.
- `../05-evals-and-observability/` — where you eval-gate a smaller model before trusting it on the easy tier.
