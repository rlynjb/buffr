# 03 — Options and Opportunity Cost

This is the **"why not the off-the-shelf option"** file. Every problem-selection brief that
skips the alternatives is one good question away from collapse: *"couldn't you just use
X?"* The strongest version of this project's case is that the build-vs-buy decision was made
by **evaluating Hermes directly** — not dismissing it from a distance — and choosing to
build *because the value lives in what the tool hides.* This file walks every option,
including `do nothing`, and names the opportunity cost of each.

## Zoom out — the option space

Four real options on the table, scored against the one thing that matters: does it produce
the career-layer evidence?

```
  Zoom out — the options, scored on "does it produce the evidence?"

  ┌─ the goal ───────────────────────────────────────────────────────────┐
  │  evidence that the frontend → AI-engineering pivot is real            │
  └───────────────────────────────┬──────────────────────────────────────┘
            ┌──────────────┬───────┴───────┬──────────────────┐
            ▼              ▼               ▼                  ▼
   ┌─ do nothing ─┐ ┌─ buy: use ─┐ ┌─ buy: assemble ─┐ ┌─ ★ BUILD ★ ─────┐
   │ pivot stays  │ │ Hermes as- │ │ glue SaaS RAG   │ │ provider contract│ ← chosen
   │ unproven     │ │ is         │ │ + hosted tools  │ │ + RAG from       │
   │              │ │            │ │                 │ │ scratch + evals  │
   │ evidence: ✗  │ │ evidence:  │ │ evidence:       │ │ evidence: ✓✓✓    │
   │              │ │ weak ✗     │ │ partial ~       │ │ (the hard parts) │
   └──────────────┘ └────────────┘ └─────────────────┘ └──────────────────┘
```

Zoom in. The decisive axis isn't "which option ships a working agent fastest" — several do.
It's **"which option produces the engineering evidence the pivot needs."** On that axis,
buy collapses: a turnkey tool ships an agent *and hides the parts that signal skill*. Build
wins not despite being more work, but *because* the work is the deliverable.

## Structure pass

**Layers:** each option splits into "does it solve the product-face pain?" and "does it
solve the career-face pain?" The two layers disagree, and that disagreement is the whole
decision.

**Axis — *which pain does this option satisfy?*** Trace it across the options:

```
  one axis — "which pain does it satisfy?" — traced across options

  option            product-face pain     career-face pain (the real one)
  ─────────────────────────────────────────────────────────────────────────
  do nothing        ✗ unsolved            ✗ unsolved
  buy Hermes as-is  ✓ solved              ✗ HIDDEN (tool hides the engineering)
  buy + assemble    ✓ mostly solved       ~ partial (glue isn't the hard parts)
  BUILD             ✓ solved              ✓ solved (exposes provider/RAG/evals)
                                            ▲
                              the axis flips HERE — buy satisfies the product
                              but not the career; build satisfies both
```

**Seam:** the load-bearing boundary is between **"a working agent"** and **"evidence I can
build one."** Buying gets you across the first; only building gets you across the second.
The seam is load-bearing because the axis-answer "which pain is satisfied" flips across it —
and the career-face pain is the one that actually justified the project.

## The options, walked one at a time

### Option 1 — Do nothing

```
  do nothing — the baseline that makes every other option earn its cost

  state: pivot asserted, no artifact
    │
    ▼  cost compounds monthly
  every AI-engineering interview anchors on a claim with no system behind it;
  the adjacent shipped pieces (AdvntrCue, dryrun, contrl, aipe) age separately
  instead of composing into one case
```

**Opportunity cost of do-nothing:** the pivot stays a résumé line. This is the option every
other one is measured against — and it's why "why now" (file 01) has teeth. The cost of *not*
solving isn't zero; it's a compounding gap between a claimed pivot and a proven one.

**Verdict:** rejected. The whole point of the project is that this baseline is unacceptable.

### Option 2 — Buy: use Hermes as-is

This is the option that was **evaluated directly**, not dismissed from a distance — which is
exactly what makes the rejection credible.

```
  Hermes as-is — what it gives you, and what it HIDES

  ┌─ what Hermes is ─────────────────────────────────────────────────────┐
  │  a multi-agent Python PLATFORM: sub-agents, skill auto-generation,    │
  │  multi-platform gateways, running Nous Research's own FINE-TUNED      │
  │  models (Hermes = fine-tunes of Llama/Mistral/Qwen)                   │
  │  agent-layer-plan.md:16                                               │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ using it gives you a working agent…
  ┌─ what it HIDES (the evidence) ▼──────────────────────────────────────┐
  │  ✗ the provider contract (you never write the ModelProvider)         │
  │  ✗ the RAG pipeline (chunking, embeddings, pgvector+HNSW, ranking)   │
  │  ✗ the multi-tenant systems design (RLS, app-scoping)                │
  │  ✗ the evals with NUMBERS — precision@5, faithfulness, JSON validity │
  │     "the biggest separator between 'played with an LLM' and          │
  │      'does AI engineering'"   agent-layer-plan.md:30                  │
  └───────────────────────────────────────────────────────────────────────┘
```

**The decisive line:** *"a turnkey tool hides exactly the parts that signal engineering
skill"* (`agent-layer-plan.md:25`). Hermes would solve the product-face pain perfectly and
leave the career-face pain — the actual reason for the project — completely unsolved.

**Opportunity cost of buying Hermes:** you ship an agent and prove nothing about your
ability to build one. For a product company that'd be the *right* call. For a portfolio
whose entire purpose is to expose engineering judgment, it's the wrong one.

**Verdict:** rejected — *after direct evaluation, for a documented reason.* Note what's
borrowed, though: the project *steals Hermes' patterns*, above all the trajectory-capture
discipline ("capture every conversation as a trajectory now so fine-tuning is answerable
later") — but none of its platform machinery or fine-tuned models
(`agent-layer-plan.md:17`). That's the senior move: learn from the tool you rejected.

### Option 3 — Buy: assemble hosted glue (SaaS RAG + hosted agent framework)

```
  buy + assemble — closer, but still hides the hard parts

  hosted vector DB  +  hosted embedding API  +  agent framework
        │                    │                       │
        └────────────────────┴───────────────────────┘
                             ▼
                a working agent assembled from glue
                             │
         what you'd demonstrate: integration / config
         what you would NOT demonstrate:
           ✗ a provider contract you wrote (Gemma has no native tool-calling
              — emulating it IS the engineering, ...aptkit-packages-design.md:136)
           ✗ RAG built from scratch (the from-scratch pipeline is the signal,
              not a hosted retrieve() call)
```

**Opportunity cost of assembling glue:** you demonstrate that you can wire SaaS together —
a real skill, but not the one the pivot needs to prove. The hardest, most signal-rich parts
(writing a `ModelProvider` for a model with *no* tool-calling, building the retrieval
pipeline over swappable contracts) are exactly the parts a hosted stack does for you.

**Verdict:** rejected. Partial evidence isn't the evidence the pivot needs. The glue path
proves integration; the build path proves engineering.

### Option 4 — Build (chosen)

```
  build — the option where the work IS the deliverable

  ┌─ what building forces you to expose ─────────────────────────────────┐
  │  ✓ a provider contract + real impl — write the Gemma ModelProvider,  │
  │     tame its messy JSON  (agent-layer-plan.md:28)                    │
  │  ✓ a RAG pipeline you actually built — chunk, embed, pgvector+HNSW,  │
  │     retrieval ranking, from scratch (NOT ported from AdvntrCue)      │
  │  ✓ a measurement-driven decision (ship vs iterate vs fine-tune) made │
  │     FROM evidence  (agent-layer-plan.md:32)                          │
  │  ✓ evals with NUMBERS — the separator (agent-layer-plan.md:30)       │
  └───────────────────────────────────────────────────────────────────────┘
```

But note the *balance* — build is not "reinvent everything." The plan is explicit: *"build
the glue and the judgment layer. Don't reinvent the agent loop or vector search — that
costs scope and hides the interesting parts. Use AptKit, use Gemma off-the-shelf, use
pgvector"* (`agent-layer-plan.md:35`). That's the nuance that makes the build decision
credible rather than naive: build the parts that signal skill, buy the commodity
infrastructure. Off-the-shelf Gemma, off-the-shelf pgvector, off-the-shelf agent loop —
*hand-built* provider contract, RAG pipeline, and evals.

**Opportunity cost of building:** more time, and the risk concentrated in the hardest piece
(Gemma's missing tool-calling, `...aptkit-packages-design.md:136`). Both accepted
deliberately — the time *is* the portfolio, and the hard piece is de-risked first.

**Verdict:** chosen. It's the only option that satisfies the career-face pain.

## The opportunity-cost ledger — all four at once

```
  options × cost — the whole decision in one frame

  option            ships agent?  produces evidence?  opportunity cost
  ──────────────────────────────────────────────────────────────────────────
  do nothing        ✗ no          ✗ none              pivot stays unproven,
                                                       cost compounds monthly
  buy Hermes        ✓ yes, fast   ✗ HIDDEN            ship an agent, prove
                                                       nothing about building one
  buy + assemble    ✓ yes         ~ partial          prove integration, not
                                                       the hard engineering
  ★ BUILD ★         ✓ yes         ✓✓✓ the hard parts  more time + risk in the
                                                       Gemma piece — both the point
```

## The principle

Build vs buy is not decided on "which is less work" — it's decided on **which option
produces the thing you actually need.** Here the thing needed is *evidence of engineering
judgment*, and a turnkey tool hides exactly that. The credible version of the decision
evaluates the strongest buy option (Hermes) directly, names precisely what it would hide,
borrows its best pattern (trajectory capture), and builds only the parts that signal skill
while buying the commodity infrastructure. "Build everything" is naive; "buy everything"
produces no evidence; the right call is *build the judgment layer, buy the substrate.*

## Interview defense

**Q: Why not just use Hermes? It already does all of this.**
Because Hermes is the right tool to *use* and the wrong tool for *this goal*. I evaluated it
directly — it's a multi-agent platform on fine-tuned models, and it ships a working agent.
But a turnkey tool hides exactly the parts that signal engineering skill: the provider
contract, the RAG pipeline, the evals with numbers. My goal is to *expose* those, so I built
them — while borrowing Hermes' trajectory-capture discipline. Anchor: `agent-layer-plan.md:25,30`.

```
  buy Hermes → working agent, evidence hidden
  build      → working agent, evidence exposed (the whole point)
```

**Q: Isn't building from scratch just NIH syndrome?**
No — the build is *scoped*. I don't reinvent the agent loop or vector search; I use AptKit,
stock Gemma, and pgvector for the commodity layers. I built only the glue and the judgment
layer — the provider contract, the from-scratch retrieval pipeline, the evals. Reinventing
the commodity parts would cost scope and hide the interesting ones. Anchor:
`agent-layer-plan.md:35`.

**Q: What's the cost of doing nothing — why couldn't you wait?**
Doing nothing leaves the pivot a claim with no artifact, and the cost compounds: every
interview anchors on an unproven assertion while the adjacent pieces I've already shipped
age separately instead of composing into one case. The baseline isn't free. Anchor: file
01, "why now."

## See also

- `01-problem-brief.md` — the career-face vs product-face pain this decision turns on.
- `02-scope-cuts-and-non-goals.md` — "build the judgment layer, buy the substrate," scoped.
- `agent-layer-plan.md:13-35` — the build-vs-buy thesis, the source of this entire file.
