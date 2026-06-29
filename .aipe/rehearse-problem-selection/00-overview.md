# Problem Selection — buffr, in one picture

This bundle is the **human layer before solution design**: not *how* you built the
laptop brain, but *why this problem deserved your time at all* — and how you'd defend
that choice in a room full of skeptics before you've drawn a single box of architecture.

You already have study guides for the *how* (`study-system-design`,
`study-ai-engineering`). This one rehearses the *why*. The order matters: in a senior
interview, a promo packet, or a staff design review, the person across the table decides
whether the problem was worth solving **before** they grade the solution. Lead with the
solution and you've skipped the question they're actually asking.

```
  where this bundle sits in the rehearse family

  ┌─ rehearse-problem-selection ─────────────────────────┐
  │  WHY this problem deserves investment   ← YOU ARE HERE│
  └───────────────────────────┬──────────────────────────┘
                              │ once the problem is justified…
  ┌─ rehearse-design-doc ─────▼──────────────────────────┐
  │  HOW a significant technical decision is communicated │
  └───────────────────────────┬──────────────────────────┘
  ┌─ rehearse-hackathon-demo ─▼──────────────────────────┐
  │  HOW the resulting value is shown                     │
  └───────────────────────────┬──────────────────────────┘
  ┌─ rehearse-interview-defense ─▼───────────────────────┐
  │  HOW the work is defended under scrutiny              │
  └──────────────────────────────────────────────────────┘
```

## The problem, in one line

> A 7-year frontend engineer pivoting to AI engineering needs **one portfolio artifact
> that proves the combination is real** — and the proof has to be a system she built the
> hard parts of herself, not a tool she configured.

The product is a self-hosted personal agent that centralizes the **agent layer** (not the
data) across her apps and "knows her over time" — Hermes-shaped. But the *problem being
solved* is not "I need a personal assistant." It's **"I need to demonstrate AI-engineering
judgment, and a turnkey tool hides exactly the parts that signal skill."** Hold that
distinction. It's the spine of every file in this bundle.

## The core justification thesis

```
  the one-sentence problem case (memorize this shape)

  ┌─ WHY THIS ──────────────────────────────────────────────────┐
  │  the portfolio value is in the engineering a turnkey tool    │
  │  hides — provider contract, RAG from scratch, evals with     │
  │  numbers — so building beats buying for THIS goal            │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ WHY HER ─────────────────▼─────────────────────────────────┐
  │  7yr frontend (Vue/React, FedEx/Amazon/CoreWeave) + already  │
  │  shipped the adjacent pieces (AdvntrCue RAG, dryrun/contrl   │
  │  on-device AI, aipe) — this composes them into one case      │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ WHY NOW ─────────────────▼─────────────────────────────────┐
  │  mid-pivot: the portfolio is the case for the combination,   │
  │  and the cost of NOT having it compounds every month the     │
  │  pivot stays unproven                                        │
  └─────────────────────────────────────────────────────────────┘
```

## The trap, and how this bundle disarms it

The obvious skeptic's shot: *"You built a personal agent for one user. That's a toy, not
a product. Where's the market?"*

The answer this bundle teaches you to give — and it's a **structural strength, not a
dodge**: **one user is a proof problem, not a market problem.** The deliverable is
*"one good agent with measured eval numbers — not a platform"* (`agent-layer-plan.md:6`).
You're not claiming product-market fit. You're claiming you can build the engineering that
sits under a real AI product and *prove* it works with numbers. A single user is the
right scope for that claim — more users would be scope you'd have to defend without
evidence, which is the opposite of what a measured portfolio piece is for.

## The five questions every file maps back to

```
  the problem-justification checklist — every file answers a subset

  ┌──────────────────┬────────────────────────────────────────────┐
  │ question         │ where it's answered                        │
  ├──────────────────┼────────────────────────────────────────────┤
  │ why this?        │ 01-problem-brief · 03-options              │
  │ why now?         │ 01-problem-brief                           │
  │ why her?         │ 01-problem-brief                           │
  │ cost of NOT       │ 01-problem-brief · 03-options (do nothing) │
  │   solving?        │                                            │
  │ why not buy?     │ 03-options (build vs buy, Hermes)          │
  └──────────────────┴────────────────────────────────────────────┘
```

## Reading order

1. **`01-problem-brief.md`** — the load-bearing file. Who has the pain, the real evidence,
   why now, why her, what it costs to do nothing. This is the file you rehearse most.
2. **`02-scope-cuts-and-non-goals.md`** — the smallest useful slice (one laptop brain,
   measured) and everything deliberately cut. Scope discipline *is* the senior signal.
3. **`03-options-and-opportunity-cost.md`** — build vs buy decided against Hermes
   directly, plus `do nothing` as a real option. The "why not off-the-shelf" file.
4. **`04-success-metrics-and-feedback-loop.md`** — how you'll know it worked.
   precision@5 ≥ 0.8 as the gate, the Phase-4 one-pager as the portfolio artifact.
5. **`05-skeptical-reviewer-questions.md`** — the review-room cross-examination, with the
   answers that hold and the ones that don't.

## What this bundle does NOT invent

Every claim here traces to a documented decision in `agent-layer-plan.md`, the two design
specs under `docs/superpowers/specs/`, or `me.md`. There are **no invented metrics, no
invented users, no invented market size, no invented competitors.** Where a number doesn't
exist yet (the actual eval result), this bundle says so and points at the gate that will
produce it. A problem brief that invents evidence is worse than no brief — it collapses on
the first follow-up question.

## See also

- `agent-layer-plan.md` (buffr root) — the parent vision and the build-vs-buy thesis.
- `docs/superpowers/specs/2026-06-19-aptkit-packages-design.md` — the packages and the deferred body.
- `.aipe/study-system-design/07-deferred-body.md` — the one-way-door reasoning, taught.
- `.aipe/study-ai-engineering/00-overview.md` — the engineering the build exposes.
