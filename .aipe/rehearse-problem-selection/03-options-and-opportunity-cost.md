# 03 — Options and Opportunity Cost

The spec is explicit: include `do nothing` as a real option, and name the opportunity cost of
each road. This is where the **build-vs-buy** decision lives — the single most-tested
problem-selection call in any senior interview. The strength of your answer is that you didn't
build because you hadn't heard of the alternative. **You evaluated Hermes directly and chose
to build anyway** — for a reason that holds.

## Zoom out — the decision tree you actually walked

Every problem-selection decision is a tree of roads not taken. Yours has four real branches,
and the documented call lands on exactly one — for a reason that survives "why not the other
three?"

```
  The build-vs-buy tree — where the documented decision landed

                    "I want a personal agent that knows me over time"
                                        │
          ┌─────────────────┬───────────┴────────┬──────────────────┐
          ▼                 ▼                    ▼                  ▼
     (A) DO NOTHING    (B) BUY/USE         (C) BUILD A          (D) BUILD ONE
                       HERMES              PLATFORM             AGENT, MEASURED
     pivot stalls;     product exists;     scope explodes;      product exists AND
     no proof          PROOF does not      one user, no need    proof exists ◄── HERE
          │                 │                    │                  │
     opp cost:         opp cost:           opp cost:            cost paid:
     the whole         the engineering     4 wks → a platform   ~4 wks of build +
     career pivot      that signals skill  with no second       the eval write-up;
                       stays hidden        agent to justify it  weak local model is
                                                                the model you have
```

## Option A — do nothing

The real baseline. Not "do nothing forever" — "keep shipping frontend, keep the pivot a
sentence on the résumé."

```
  Do nothing — the cost compounds quietly

  today:    7-yr frontend engineer, "pivoting to AI" (a claim)
     │
     ▼  (no proof artifact built)
  6 months: still "pivoting to AI" (still a claim) — the gap between
            claim and evidence hasn't closed; it's the same conversation
            in every interview, with nothing to point at
```

**Opportunity cost:** the entire pivot. The thing that makes "do nothing" a *real* option to
name (not a strawman) is that it's genuinely tempting — frontend work pays, ships, and is
known-good. The cost isn't a fire; it's a slow stall. Naming that honestly is stronger than
pretending the alternative was obviously bad.

**Strong answer, your voice:**
> "Do-nothing is real — I could keep shipping frontend, which pays and ships. The cost isn't
> dramatic, it's a slow stall: 'pivoting to AI' stays a claim with nothing under it. Every
> interview is the same conversation with nothing to point at. That compounding cost is what
> made me commit to building something where the engineering itself is the evidence."

## Option B — buy / use Hermes (the build-vs-buy core)

This is the decision the whole file orbits. The honest, documented call: **you evaluated
Hermes Agent directly and chose to build — because a turnkey tool hides exactly the parts
that signal engineering skill.**

```
  Build vs buy — the asymmetry that decides it

  BUY HERMES                          BUILD ON APTKIT
  ──────────────────────────          ──────────────────────────────────
  ✓ product works sooner              ✓ product works (a few weeks later)
  ✗ provider contract: HIDDEN         ✓ provider contract: you WRITE the
                                        Gemma ModelProvider, tame its messy
                                        JSON via structured-generation
  ✗ RAG pipeline: HIDDEN              ✓ RAG pipeline: chunk, embed, pgvector
                                        + HNSW, retrieval ranking — yours
  ✗ trajectory capture: opaque       ✓ trajectory capture: all 6 event
                                        types persisted, fine-tune answerable
  ✗ evals: someone else's numbers    ✓ evals: precision@k, faithfulness,
                                        JSON validity — YOUR measurement
  ✗ runs Nous's fine-tuned models    ✓ runs stock Gemma 2 — the constraint
    (Llama/Mistral/Qwen fine-tunes)     that forced real robustness work

  the asymmetry: Hermes solves the PRODUCT problem and leaves the PROOF
  problem untouched. For a portfolio case, that's solving the wrong one.
```

**The load-bearing line — say it exactly:**
> "A turnkey tool hides exactly the parts that signal skill."

That's the thesis. Hermes is a multi-agent Python *platform* running Nous Research's own
fine-tuned models. Using it would give me a working agent and zero evidence that I can build
one. The provider contract, the RAG pipeline, the eval harness — the things an interviewer
actually probes — are precisely what Hermes abstracts away. So the build-vs-buy answer
inverts the usual one: **here, "buy" is the cheap-looking option that costs you the entire
reason you're doing this.**

**The counter-discipline — what you DON'T rebuild:**

```
  Build the glue and the judgment. Buy the substrate.

  BUILD (the signal):              REUSE (don't reinvent — that hides nothing):
  • Gemma ModelProvider            • aptkit's agent loop (run-agent-loop)
  • the RAG pipeline               • pgvector + HNSW (vector search)
  • the eval-driven decision       • Gemma off-the-shelf (no pre-training)
```

This is what keeps the build-vs-buy answer from being naive "build everything." You reuse
aptkit's runtime and pgvector's search *because* reinventing them costs scope and hides
nothing interesting. You build the provider, the pipeline, and the judgment layer *because*
that's where the signal is. Knowing which is which is the senior move.

**Strong answer, your voice:**
> "I evaluated Hermes directly — it's the obvious buy. I chose to build, because a turnkey
> tool hides exactly the parts that signal skill. Hermes is a multi-agent platform on Nous's
> fine-tuned models; using it gives me a working agent and zero proof I can build one. The
> provider contract, the RAG pipeline, the eval numbers — the things you'd actually probe in
> this interview — are the parts it abstracts away. But I'm not naive about it: I reuse
> aptkit's agent loop and pgvector's search, because reinventing those costs scope and hides
> nothing. I build the glue and the judgment layer. That's where the signal lives."

## Option C — build a platform

The over-build trap. Tempting because it sounds more impressive; wrong because it's scope with
no buyer.

```
  Platform vs one agent — scope with no second consumer

  PLATFORM:  N agents · sub-agent orchestration · skill auto-generation
             · multi-platform gateways
             opp cost: 4 weeks spent on machinery for an audience of ZERO
             second agents. You'd ship a fleet and measure none of it.

  ONE AGENT: ship it, measure it (precision@k ≥ 0.8 gate), THEN decide
             whether generalizing is even warranted — from evidence.
```

**Opportunity cost:** the eval numbers. A platform spreads four weeks across breadth and
leaves you with no *measured* anything — which is the exact artifact that proves AI
engineering. One agent, measured, beats five agents, unmeasured, every time for this goal.

## Option D — build one agent, measured (the chosen road)

```
  The chosen road — and the THREE sub-decisions inside it

  (1) centralize the AGENT LAYER, not the DATA
      ┌─ apps keep their own schemas (buffr=SQLite, AdvntrCue=pgvector) ─┐
      │  agents schema holds ONLY RAG infra; apps opt IN via documents   │
      └──────────────────────────────────────────────────────────────────┘
      opp cost of the alternative (centralize data): a giant migration,
      every app coupled to one schema, and you own everyone's data model.

  (2) one agent end-to-end, with MEASURED evals — not a platform (see C)

  (3) build locally first on the M-series Mac
      Ollama + gemma2:9b + nomic-embed-text, no cloud GPU bill. The weak
      local model is a FEATURE of the decision: it forced structured-
      generation, a minTopK floor, and a hallucinated-filter-key guard —
      robustness work a hosted frontier model would have hidden.
```

The "centralize the layer, not the data" sub-decision is the one a systems interviewer will
linger on, because it's a real architecture call with a real opportunity cost on the other
side. Centralizing *data* would mean one schema everything migrates into, you owning every
app's data model, and tight coupling. Centralizing the *layer* keeps each app's store
sovereign and makes the agent a consumer they opt into. That's the right seam — and you can
name exactly what the wrong seam would have cost.

## Primary diagram — the option matrix on one page

Every option scored on the two axes that actually matter here: does the *product* exist, and
does the *proof* exist.

```
  OPTION MATRIX — product exists? × proof exists?

                  proof: NO              proof: YES
              ┌────────────────────┬────────────────────────┐
  product:    │  (C) PLATFORM      │                        │
  YES         │  scope, no measure │   (D) ONE AGENT,       │
              │  (B) BUY HERMES    │       MEASURED  ◄── chosen
              │  turnkey hides it  │   build glue + judgment │
              ├────────────────────┼────────────────────────┤
  product:    │  (A) DO NOTHING    │                        │
  NO          │  pivot stalls      │    (impossible — no    │
              │                    │     proof without a    │
              │                    │     build)             │
              └────────────────────┴────────────────────────┘

  only (D) lands in the "both" quadrant. That's the decision.
```

## The principle

Build-vs-buy is not "can I afford to build" — it's "what does buying *cost me* that I actually
need." When the deliverable is a product, buy the parts that aren't your signal. When the
deliverable is *proof of skill*, the turnkey option costs you the proof, and "buy" becomes the
expensive choice wearing a cheap coat. The discipline is the same either way: name what each
road hides, and pick the one that exposes the thing you're actually trying to produce.

## See also

- `01-problem-brief.md` — the proof problem that makes "buy Hermes" the wrong solve
- `02-scope-cuts-and-non-goals.md` — "build the glue, not the platform" as scope
- `04-success-metrics-and-feedback-loop.md` — the measured evals that are option D's payoff
- `05-skeptical-reviewer-questions.md` — "why not just use Hermes" under pressure
- `agent-layer-plan.md` — "Why build it instead of using Hermes (the portfolio thesis)"
