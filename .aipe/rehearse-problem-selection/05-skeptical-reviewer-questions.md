# 05 — Skeptical Reviewer Questions

This is the cross-examination. The first four files built the case; this one stress-tests
it the way a skeptical staff engineer, a hiring panel, or a promo committee would. Coach
posture, no softening: for each question you get the *strong* answer in your voice, the
weak answer to *avoid*, and the one-line anchor you'd say while you sketch. The questions
are ordered hardest-first — if you can hold Q1 and Q2, the rest follow.

## How to use this file

```
  each question, three parts

  ┌─ the question (asked at its sharpest) ───────────────────────────────┐
  │  ▶ STRONG answer — first person, in Rein's voice, documented         │
  │  ▷ WEAK answer  — what NOT to say, and why it loses the room         │
  │  ⚓ anchor       — the one line + citation you say while you draw     │
  └───────────────────────────────────────────────────────────────────────┘
```

The discipline: **never invent to escape a question.** If the honest answer is "that
number doesn't exist yet, here's the gate that produces it," that *is* the strong answer. A
fabricated metric or an invented user dies on the follow-up; a named gap survives it.

---

## Q1 — "One user, one device. This is a toy, not a real problem."

**▶ STRONG:** "It's a *proof problem, not a market problem.* The deliverable is one good
agent with measured eval numbers — not a platform. One user is the correct scope for the
claim I'm actually making, which is 'I can build the engineering under a real RAG agent and
prove it with numbers.' More users would be scope I'd have to defend with evidence I don't
have — the opposite of what a measured portfolio piece is for."

**▷ WEAK:** "Well, it could scale to more users later." — This concedes the frame. You're
now defending a market you explicitly didn't claim. Don't.

**⚓** *One user is the right scope for the claim; more users = scope to defend without
evidence.* `agent-layer-plan.md:6`

```
  proof problem  → one user is correct scope (claim: "I can build + measure")
  market problem → many users you'd have to defend → NOT the claim being made
```

---

## Q2 — "Couldn't you just use Hermes? Why reinvent it?"

**▶ STRONG:** "I evaluated Hermes directly — it's a multi-agent platform on fine-tuned
models and it ships a working agent. But a turnkey tool hides exactly the parts that signal
engineering skill: the provider contract, the RAG pipeline, the evals with numbers. My goal
is to *expose* those, so I built them. I did borrow Hermes' best idea — trajectory capture —
so fine-tuning stays answerable later. I rejected the platform, not the patterns."

**▷ WEAK:** "Hermes is too complicated / I wanted to do it myself." — Sounds like NIH. The
strong version is that buying *defeats the purpose of the project*, with a specific list of
what it hides.

**⚓** *A turnkey tool hides exactly the parts that signal engineering skill.*
`agent-layer-plan.md:25`

---

## Q3 — "Isn't building from scratch just Not-Invented-Here syndrome?"

**▶ STRONG:** "The build is *scoped*. I don't reinvent the agent loop or vector search — I
use AptKit, stock Gemma off-the-shelf, and pgvector for the commodity layers. I built only
the judgment layer: the Gemma provider contract, the from-scratch retrieval pipeline, and
the evals. Reinventing the commodity parts would cost scope and hide the interesting ones.
Build the glue and the judgment; buy the substrate."

**▷ WEAK:** "I built everything myself to really understand it." — Overclaims and signals
poor scoping judgment. The senior move is knowing what *not* to build.

**⚓** *Build the glue and the judgment layer; don't reinvent the loop or vector search.*
`agent-layer-plan.md:35`

---

## Q4 — "You have no eval numbers. How is this 'measured'?"

**▶ STRONG:** "The gate is precision@5 ≥ 0.8, and the harness is wired — precision@k and
recall@k against a labeled set. The number comes from running it. I'm honest about the
gaps: faithfulness uses a rubric judge with Claude as grader so the model doesn't grade
itself, and that's defined in aptkit but not yet wired into buffr. The *deliverable* is the
Phase-4 one-pager — the numbers, the failure breakdown, and the decision made from them. A
named gate with a named gap is stronger than a number I made up."

**▷ WEAK:** "precision@5 is around 0.85." — If you can't reproduce it on demand, this is the
answer that ends the interview. Never quote a number you haven't run.

**⚓** *precision@5 ≥ 0.8 is the gate; the harness is wired, the number comes from running
it; faithfulness is defined-but-unwired, named not hidden.* `agent-layer-plan.md:93`

```
  the decision tree IS the artifact, not any single number:
  ≥0.8 → ship · 50-80% retrieval-bound → fix retrieval ·
  50-80% model-bound → fallback/maybe-FT · <50% → architecture problem
```

---

## Q5 — "You deferred the phone, the sync, the API. Did you give up, or plan?"

**▶ STRONG:** "Planned, and I can prove it: every deferred phase has a named seam it plugs
into. The Edge-Function store plugs into the `VectorStore` contract; RLS plugs into the
`app_id` column already on every table; fine-tuning plugs into the trajectory already
captured. The scaffolding is built; only the policies and adapters are deferred. And the
build order is deliberate — laptop brain first, so the sync/merge problem, the hardest
part, is the *second* thing I solve, not the first."

**▷ WEAK:** "I ran out of time for the phone." — Reframes a deliberate risk-sequencing
decision as a failure to finish. It was a *choice*, made for a documented reason.

**⚓** *Every deferred phase reuses this schema and the VectorStore contract — no rework.*
`...graduation-design.md:188`

---

## Q6 — "Why centralize the agent layer but not the data? Isn't that half a solution?"

**▶ STRONG:** "It's the *right* half. The apps already have good schemas — `app_buffr`,
`contrl`, and so on. Forcing them into one shared data model would be a migration with no
payoff. What's missing is a shared *reasoning* layer. So the `agents` schema holds only RAG
infrastructure — corpus copies, chunks, conversations — and apps write *into* it with their
`app_id` when they want something indexed. Centralize the agent layer; leave the data where
it already works."

**▷ WEAK:** "Centralizing the data was too hard." — It wasn't avoided for difficulty; it was
rejected because it's the wrong design. The apps' schemas are an asset, not an obstacle.

**⚓** *Centralize the agent layer, not the data — apps keep their schemas.*
`agent-layer-plan.md:83`

---

## Q7 — "Why now? Why not wait until you've learned more?"

**▶ STRONG:** "Because the pieces are already shipped and the pivot needs proof *today*. I've
shipped RAG (AdvntrCue), on-device AI (dryrun/contrl), and meta-tooling (aipe) separately —
buffr is the one artifact that composes them into a measured system. Waiting doesn't make
the parts easier to assemble; it lets them age separately while the pivot stays an unbacked
claim. The cost of doing nothing compounds every month."

**▷ WEAK:** "I felt ready." — Not an argument. The strong version is the *compounding cost*
of the unproven pivot plus the *already-shipped* adjacent work ready to compose.

**⚓** *The pieces are shipped; the pivot needs proof today; the cost of doing nothing
compounds.* `me.md` portfolio + file 01.

---

## Q8 — "The whole thing hangs on Gemma, which can't even tool-call. Isn't that fragile?"

**▶ STRONG:** "Yes, and I named it as *the* riskiest piece and de-risked it first. Gemma has
no native tool-calling, so the provider emulates it — render the tool schema into the
prompt, parse the JSON back out. That emulation *is* the engineering, and it's exactly the
kind of hard part a turnkey tool hides. The model itself is swappable: it sits behind the
`ModelProvider` contract with a fallback chain that can put Claude behind Gemma when
tool-calling falls short. Self-hosted means my data and memory are mine — not that one model
is welded in."

**▷ WEAK:** "Gemma works fine for me." — Dismisses a real, documented fragility. Naming the
risk *and* the mitigation (swappable provider + fallback) is the senior answer.

**⚓** *Gemma's missing tool-calling is the riskiest piece, de-risked first; the model is
swappable behind the ModelProvider contract.* `...aptkit-packages-design.md:136`

```
  risk:       Gemma emits no tool_use blocks
  mitigation: emulate (prompt→JSON→parse) + provider-fallback chain (Claude behind Gemma)
  the emulation IS the portfolio signal, not a bug to hide
```

---

## The meta-lesson

```
  the pattern across all eight answers

  every strong answer does the same three things:
    1. names the documented decision (with a citation)
    2. reframes an apparent weakness as a deliberate choice
    3. NEVER invents a number, a user, or a market to escape

  the weak answers all do the same wrong thing:
    they concede the skeptic's frame instead of correcting it
```

The single highest-leverage habit: when a question implies "this is too small / too
hand-built / too unmeasured," **don't apologize and don't inflate.** Name why the small,
hand-built, gate-measured shape is the *correct* shape for the claim you're actually making.
The one-user scope, the from-scratch build, and the not-yet-run number are not the
weaknesses of this project — handled right, they're its three strongest signals.

## See also

- `01-problem-brief.md` — the case these questions stress-test.
- `02-scope-cuts-and-non-goals.md` — the cut reasoning behind Q5 and Q6.
- `03-options-and-opportunity-cost.md` — the build-vs-buy reasoning behind Q2 and Q3.
- `04-success-metrics-and-feedback-loop.md` — the metric honesty behind Q4.
- `.aipe/study-system-design/07-deferred-body.md` — the deferral defense behind Q5.
