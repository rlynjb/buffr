# 01 — The Problem Brief

The core artifact. Before anyone evaluates your *solution*, they evaluate whether the
*problem* was worth solving. This file is the answer to "why this, why now, why you, and what
does it cost to do nothing" — and every line of it is anchored to a documented decision, not
an invented market.

## Zoom out — where the problem sits

The pain isn't in any one app. It's in the *gap between* them. You've shipped five distinct
system shapes (`dryrun`, `buffr`, `contrl`, `aipe`, `AdvntrCue`), each with its own store,
its own context, its own schema. Nothing reasons *across* them. The problem lives in the
empty band labelled "agent layer" below.

```
  Where the problem lives — the missing reasoning band

  ┌─ Your apps (each ships, each isolated) ───────────────────────────┐
  │  buffr        blooming_insights      contrl        AdvntrCue       │
  │  (SQLite)     (its schema)           (on-device)   (pgvector)      │
  └────┬──────────────┬───────────────────┬──────────────┬────────────┘
       │              │                   │              │
       │      each keeps its own data — and that's FINE  │
       ▼              ▼                   ▼              ▼
  ┌─ ✦ THE MISSING LAYER ✦ ───────────────────────────────────────────┐
  │  a single agent that reasons ACROSS apps and knows you over time   │  ← the problem
  │  (today: does not exist; each app answers only from its own data)  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the problem is the absence of a **centralized agent layer (the `agents` schema +
one RAG agent)** — one place that retrieves over your context and accumulates a memory of you
across runs. The shipped `buffr-laptop` is the first persistent instance of that layer:
single device, one user, real Postgres + pgvector behind it.

## 1. The problem, stated as pain

**Who experiences it:** you — a 7-year frontend engineer pivoting into AI engineering. The
pain has two faces, and only one of them is the product.

```
  Two problems wearing one coat — separate them cleanly

  ┌─ Product pain (real, but secondary) ─┐  ┌─ Career pain (the real driver) ─┐
  │ context scattered across apps;       │  │ "7-yr frontend engineer" reads  │
  │ no agent that knows you over time;   │  │ as a frontend engineer until    │
  │ every app answers only from its own  │  │ there's PROOF of the AI-eng      │
  │ silo                                 │  │ combination — and a turnkey tool│
  │                                      │  │ produces no such proof          │
  └──────────────────────────────────────┘  └─────────────────────────────────┘
            the agent solves this                  building the agent solves THIS
```

Be honest in the room about which is load-bearing. The product pain is genuine — a personal
agent that "knows you over time" is a thing you actually want. But the **career pain is the
one that justifies the investment**, and pretending otherwise is the weaker story. You're not
claiming a market; you're claiming a portfolio gap that this specific build closes.

**Strong answer, your voice:**
> "The problem is that my context is scattered across the apps I've built — each keeps its
> own schema, and nothing reasons across them or remembers me between sessions. That's the
> product pain. But the honest driver is a career problem: I've shipped seven years of
> frontend, and on paper that reads as a frontend engineer. The combination I'm pivoting
> into — frontend instincts plus real AI-systems engineering — has no proof artifact yet.
> This build is that proof. I picked a problem where the engineering *is* the deliverable."

## 2. Evidence and current cost — what the repo proves vs what I infer

The spec demands I separate evidence from inference. Here it is, clean.

```
  Evidence (documented / shipped)        Inference (labeled as such)
  ─────────────────────────────────      ───────────────────────────────
  ✓ five distinct system shapes          ~ the apps "would benefit" from a
    shipped (me.md portfolio)              shared agent — not yet wired; this
  ✓ buffr-laptop runs live against         is a design intent, not a measured
    reindb (design spec, 2026-06-19)        outcome
  ✓ agents schema + pgvector + HNSW      ~ "knows you over time" is built
    built and verified                      (memory rides agents.chunks) but
  ✓ trajectory capture from day one        not yet evaluated for recall
    (all 6 CapabilityEvent types)        ~ no second app consumes it yet —
  ✓ Hermes evaluated directly, build       the multi-app value is projected,
    chosen (agent-layer-plan.md)            not realized
```

**The cost of NOT solving it** — and this is the part interviewers reward, because most
candidates skip it:

- **Career cost (the real one):** the pivot stalls. Without a build that exposes a provider
  contract, a RAG pipeline, and eval numbers, the AI-engineering claim is a sentence on a
  résumé with nothing under it. You stay a frontend engineer who "also did some AI stuff."
- **Opportunity cost of the wrong build:** if you'd bought Hermes instead, the *product* would
  exist and the *proof* would not. You'd have solved the secondary problem and left the
  primary one wide open. (Covered in full in `03`.)
- **Compounding cost of deferring decisions wrong:** the embedding dimension (768) and the
  schema shape are one-way doors. Picking them late, after a corpus exists, means a painful
  reindex/migration. The cost of *not* deciding these now compounds with every document
  indexed.

There is no user-churn cost, no revenue cost, no SLA cost — **because there's one user, and
that's deliberate.** Naming that absence honestly is stronger than inventing a number.

## 3. Why now

```
  Why now — three timers, all running

  ┌─ Career timer ──────────┐  the pivot is ACTIVE (me.md: "this is where
  │  pivoting into AI eng    │  you are"). A pivot needs a proof artifact
  │  right now, not someday  │  while it's happening, not after.
  └─────────────────────────┘
  ┌─ Tooling timer ─────────┐  the substrate is finally good enough to build
  │  aptkit shipped the      │  the glue without reinventing the agent loop:
  │  seams; Gemma + pgvector │  VectorStore / ModelProvider contracts, a
  │  + Ollama are here now    │  bounded agent loop, local models that run
  └─────────────────────────┘  on an M-series Mac. None of this existed cheap
                               a few years ago.
  ┌─ One-way-door timer ────┐  embedding dim + schema shape must be chosen
  │  decide before a corpus  │  BEFORE indexing a real corpus. The window to
  │  exists, or pay later     │  decide cheaply is now — see agent-layer-plan
  └─────────────────────────┘  "Open questions … most are one-way doors."
```

**Strong answer, your voice:**
> "Now, because three things line up. My pivot is active — a proof artifact is worth most
> while the transition is happening. The substrate finally exists: aptkit gives me the
> contracts, Gemma and pgvector run locally on my Mac, so I build the judgment layer instead
> of the plumbing. And the irreversible decisions — embedding dimension, schema shape — are
> cheap to make today and expensive once a corpus exists. Waiting doesn't make any of these
> easier."

## 4. Beneficiaries and exclusions

```
  In scope (benefits)                  Out of scope (excluded — on purpose)
  ─────────────────────────────        ─────────────────────────────────────
  • you, one user, one device          ✗ other users / multi-tenant (no RLS
    (app_id = 'laptop')                   this phase — deferred, not forgotten)
  • the AI-engineering portfolio       ✗ the phone half of the two-brain body
    case (the real beneficiary)           (deferred to dodge one-way doors)
  • future apps that COULD consume     ✗ a "platform" of many agents (ship ONE,
    it over HTTP later (designed for,     measure it, then maybe generalize)
    not built yet — labeled inference)  ✗ a market of paying users (there isn't
                                           one, and inventing one would be a lie)
```

The exclusions aren't gaps — every one is a recorded decision with a reason. Centralize the
**agent layer (the reasoning + retrieval), not the data (each app's schema)**: apps keep
their own stores and opt *into* `agents.documents` when they want something indexed. That's a
deliberate boundary, covered in `03`.

## 5. Constraints — visible from the repo

```
  Constraint                     Source                          Bites you when
  ───────────────────────────    ────────────────────────────    ─────────────────
  build locally on M-series Mac  agent-layer-plan + Ollama box   no cloud GPU budget;
                                                                  weak local model is
                                                                  the model you HAVE
  aptkit consumed, never edited  context.md must-not-change       provider/retrieval
                                                                  fixes go UP to aptkit
  embedding dim = 768 forever    nomic-embed-text:v1.5 (one-way)  swapping embedder =
                                                                  full reindex
  one developer, ~4 weeks        agent-layer-plan phase plan      scope discipline is
                                                                  survival, not taste
  Gemma's weak JSON / tool-use   as-built deviations              needed structured-
                                                                  generation + minTopK
                                                                  + filter-key guard
```

The Gemma constraint is the one to *lead* with in an interview, because it's where the
engineering got interesting — a weak local model forced real robustness work (a `minTopK`
floor, ignoring hallucinated filter keys) that a hosted frontier model would have hidden.
That's covered as a strength, not an apology.

## Primary diagram — the brief on one page

The whole justification, one frame: the pain, the two problems, the evidence line, and the
exclusions.

```
  THE PROBLEM BRIEF — one frame

  WHY THIS ──► context scattered across 5 shipped apps; no agent reasons
              across them or remembers you. AND: a 7-yr frontend résumé has
              no proof of the AI-engineering combination.
                    │
  WHY NOW ────►    pivot is active · substrate (aptkit/Gemma/pgvector) is
                    here · one-way doors (768-dim, schema) decide cheap NOW
                    │
  WHY HER ────►    composes the exact portfolio: AdvntrCue (RAG), dryrun &
                    contrl (on-device AI), aipe (meta-tooling). This build
                    is the seam that joins them.
                    │
  COST OF ────►    NOT building = pivot stalls, no proof, "frontend eng who
  NOT DOING        also did AI." Buying Hermes = product exists, proof doesn't.
                    │
  WHY NOT ────►    Hermes hides exactly the parts that signal skill. The
  OFF-THE-SHELF    engineering it abstracts away IS the deliverable. (→ 03)
                    │
                    ▼
            INVEST: one agent, end-to-end, measured. One user = proof scope.
```

## Why her — the strongest single answer

This is the question the whole bundle exists to answer well. The portfolio isn't a list; it's
a set of pieces this one build *composes*.

```
  Why her — the build is the seam joining shipped work

  AdvntrCue  ─┐  classic RAG, pgvector, tool-calling, session memory
  dryrun     ─┤  on-device AI (Gemma Nano) + API fallback, local-first
  contrl     ─┼─►  buffr agent layer = all of these, deliberately, ONCE:
  aipe       ─┤  on-device model + RAG + trajectory capture + the judgment
  buffr (RN) ─┘  layer (ship/iterate/fine-tune from evals)
                 + 7 yrs frontend (the Ink TUI is a frontend engineer's
                   instinct applied to an AI surface)
```

**Strong answer, your voice:**
> "Why me: I've already shipped the pieces this composes. AdvntrCue is classic RAG on
> pgvector with tool-calling and session memory. dryrun and contrl run AI *on-device* with
> fallback. aipe is meta-tooling — describe, diagnose, act. This agent layer is the seam that
> joins them into one system: a local model, a RAG pipeline I built, trajectory capture, and
> a measurement-driven ship-or-iterate decision. And the chat surface is an Ink TUI — that's
> seven years of frontend instinct applied to an AI product surface, not bolted on. The
> combination is the case, and I'm the person who's already shipped every half of it."

## The principle

A problem is worth investment when the *cost of not solving it* is concrete and the
*beneficiary is real* — even when the beneficiary is one person and the benefit is proof
rather than revenue. The discipline isn't inventing a market; it's naming exactly whose pain
this is, what it costs to leave it, and refusing to dress a proof problem up as a market one.
The honest brief is the stronger brief.

## See also

- `02-scope-cuts-and-non-goals.md` — the smallest slice that validates this, and what was cut
- `03-options-and-opportunity-cost.md` — build vs buy (Hermes) vs do-nothing
- `04-success-metrics-and-feedback-loop.md` — how you'll *know* the problem got solved
- `05-skeptical-reviewer-questions.md` — "one user," "off-the-shelf," "just RAG"
- `agent-layer-plan.md` — the documented decisions this brief is grounded in
