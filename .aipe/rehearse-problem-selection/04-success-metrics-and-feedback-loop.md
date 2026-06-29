# 04 — Success Metrics and the Feedback Loop

A problem you can't measure solving is a problem you can't claim to have solved. This file is
the answer to "how will you *know* it worked?" — and it's the answer that separates "played
with an LLM" from "does AI engineering." The metrics are documented, the gate is real, and the
"one user" framing turns the absence of a market into a structural strength rather than a hole.

## Zoom out — where measurement sits in the system

Success isn't a vibe at the end. It's a ruler wired into the system from day one: every
trajectory is captured, and a labeled eval set scores retrieval and synthesis. Measurement is
its own layer, not an afterthought.

```
  Where measurement lives — a ruler wired into the system

  ┌─ Agent (the thing under test) ────────────────────────────────────┐
  │  ask → retrieve (HNSW) → ground → Gemma answers → cite             │
  └───────────────────────────────┬───────────────────────────────────┘
            every event            │            every answer
            (6 CapabilityEvent     │            on a labeled question
            types)                 ▼
  ┌─ Measurement layer (✦ success lives here ✦) ──────────────────────┐
  │  TRAJECTORY CAPTURE          EVAL HARNESS                          │
  │  agents.messages (full       precision@k · recall@k ·             │
  │  trajectory, replayable)     faithfulness (rubric judge) ·        │
  │                              JSON validity rate                   │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  the numbers
                                  ▼
  ┌─ The Phase-4 DECISION GATE ───────────────────────────────────────┐
  │  ship · improve retrieval · escalate model · rethink architecture │
  │  the decision is made FROM the numbers, not toward them           │
  └───────────────────────────────────────────────────────────────────┘
```

## The metrics — observable, documented, not invented

Three metrics, each measuring a different failure mode. The discipline is that they're
**distinct** — a number that goes up tells you *which* part is working.

```
  Three metrics, three failure modes — they don't overlap

  precision@k / recall@k   ──► is RETRIEVAL finding the right chunks?
  (the labeled eval set)        failure here = retrieval miss
       │
  faithfulness             ──► is the ANSWER grounded in what was retrieved,
  (rubric judge)                or is Gemma making things up?
       │                        failure here = bad synthesis / hallucination
       │
  JSON validity rate       ──► does the weak local model emit tool calls the
  (structured-generation)       loop can actually parse?
                                failure here = model gap (Gemma's messy JSON)
```

The reason three metrics beats one: when quality is bad, **one number can't tell you why.** A
single "is it good?" score sends you guessing. Precision vs faithfulness vs JSON-validity
*localizes the failure* to retrieval, synthesis, or the model — which is exactly what the
Phase-4 decision needs as input.

**The one gate that's a hard number:** `precision@5 ≥ 0.8` before integration. Documented in
the parent plan. It's the line that says "retrieval is good enough to build the agent on top
of." Below it, you fix retrieval before anything else — no point grounding Gemma on chunks
that aren't the right chunks.

**Strong answer, your voice:**
> "I measure three things, and they don't overlap on purpose. Precision and recall@k on a
> labeled set tell me if retrieval is finding the right chunks. Faithfulness — scored by a
> rubric judge — tells me if Gemma's answer is actually grounded or hallucinating.
> JSON-validity rate tells me if the weak local model is emitting tool calls the loop can
> parse. Three metrics, three failure modes. When quality drops, one number can't tell me
> why; these three localize it. And there's a hard gate: precision@5 has to clear 0.8 before
> I build the agent on top of retrieval."

## The feedback loop — the Phase-4 decision gate

This is the artifact that *is* the portfolio piece: not the code, the **decision made from the
evidence.** The loop has four exits, each tied to what the numbers say.

```
  The Phase-4 decision tree — every exit is evidence-driven

  run evals ──► categorize failures (retrieval miss / bad synthesis / model gap)
       │
       ├─ ≥ 80% .................► SHIP. it's good enough; stop.
       │
       ├─ 50–80%, retrieval-bound ► improve RETRIEVAL (chunking, ranking)
       │                            — don't touch the model
       │
       ├─ 50–80%, model-bound .....► ESCALATE via fallback chain; consider
       │                            fine-tuning ONLY if the failure is narrow
       │                            AND captured trajectories can supply data
       │
       └─ < 50% ...................► ARCHITECTURE problem. don't paper over it
                                     with training. rethink the design.
```

The discipline that makes this a *senior* answer: **fine-tuning is gated, not assumed.** The
`< 50%` branch explicitly refuses to "paper over an architecture problem with training" —
which is the exact mistake a junior reaches for first. And the trajectory capture from day one
is what makes the fine-tuning branch *answerable from data* rather than a guess. The loop and
the capture-discipline are the same decision (echoed from `02`).

**Strong answer, your voice:**
> "The feedback loop is a four-way gate on the eval numbers. Above 80%, ship. 50 to 80% and
> retrieval-bound, I fix retrieval and leave the model alone. Model-bound, I escalate through
> a fallback chain and only *consider* fine-tuning if the failure is narrow and my captured
> trajectories can supply the data. Below 50%, it's an architecture problem and I refuse to
> paper over it with training. The write-up — the numbers, the failure breakdown, the chosen
> next action — *is* the portfolio artifact. The decision matters as much as the code."

## "One user is a proof problem, not a market problem" — as a structural strength

This is the move the whole bundle is built around. Most candidates would *apologize* for one
user. You make it the load-bearing strength of the measurement story.

```
  One user — why it's the RIGHT scope for measurement, not a hole

  A MARKET PROBLEM measures:          A PROOF PROBLEM measures:
  ─────────────────────────           ──────────────────────────────
  DAU/MAU, retention, NPS,            precision@k, faithfulness, JSON
  conversion, churn, revenue           validity — does the ENGINEERING work?
       │                                   │
  needs many users to be real         needs ONE corpus + a labeled set —
  (n=1 is statistically empty)        and ZERO market noise in the signal
       │                                   │
  ▼                                   ▼
  inventing these for n=1 is a LIE    these are honest at n=1 — precision@5
  that collapses on question one      on a labeled set means the same thing
                                      whether you have 1 user or 1 million
```

The insight: precision@k, faithfulness, and JSON-validity are **properties of the system, not
of the user base.** They're fully honest at n=1. A market metric (retention, churn) is
statistically empty at n=1 and inventing one is a lie. So choosing a proof problem isn't
settling for less rigor — it's choosing the metrics that *can* be rigorous at this scale, and
removing every confound a real user base would inject. One user is the cleanest possible test
bench for "does the engineering work."

**Strong answer, your voice:**
> "One user isn't a weakness I work around — it's the right scope for what I'm measuring. I'm
> not measuring retention or churn; those are empty at n=1 and I'd be lying if I quoted them.
> I'm measuring precision@k, faithfulness, JSON validity — properties of the *system*, not the
> user base. Those are fully honest with one user, and one user means zero market noise in the
> signal. It's the cleanest test bench for 'does the engineering actually work.' That's a
> proof problem, and I scoped it as one deliberately."

## Primary diagram — the measurement story on one page

Capture, score, decide, and why one user is the right bench — one frame.

```
  SUCCESS — capture → score → decide, one frame

  CAPTURE          SCORE                      DECIDE (Phase-4 gate)
  ───────────      ───────────────────────    ─────────────────────────
  every event ──► precision@k  ─┐             ≥80% ........ ship
  (6 types) to    recall@k      ├─► localize  50–80% ret ... fix retrieval
  agents.         faithfulness  │   the       50–80% mdl ... escalate / FT?
  messages        JSON validity ─┘   failure   <50% ........ rethink arch
                                                   │
  ┌─ why n=1 is the right bench ─────────────────  ▼  ──────────────────┐
  │  these metrics are properties of the SYSTEM, honest at one user,    │
  │  zero market noise — a proof problem, measured cleanly              │
  └─────────────────────────────────────────────────────────────────────┘
```

## The principle

The right success metric matches the *kind* of problem. For a market problem, you measure
behavior across many users; for a proof problem, you measure properties of the system that
hold at any scale — and you refuse to borrow market metrics that go empty at n=1. Measurement
isn't decoration on the end of a build; it's the layer that turns "I made a thing" into "here
is the evidence, here is what it says, and here is the decision I made from it." That last
sentence is the whole difference between a hobby and AI engineering.

## See also

- `01-problem-brief.md` — the proof problem these metrics are honest for
- `02-scope-cuts-and-non-goals.md` — trajectory capture as the smallest-slice item
- `03-options-and-opportunity-cost.md` — measured evals as the payoff of building vs buying
- `05-skeptical-reviewer-questions.md` — "one user proves nothing" answered head-on
- `agent-layer-plan.md` — "Phase 4 — Measure, then decide" and the precision@5 ≥ 0.8 gate
- `.aipe/study-ai-engineering/05-evals-and-observability` — the eval mechanics in this repo
