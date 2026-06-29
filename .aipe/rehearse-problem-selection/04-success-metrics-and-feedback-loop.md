# 04 — Success Metrics and Feedback Loop

A problem brief that can't say *how you'll know it worked* is a wish. This file names the
observable outcomes, the gate that decides ship-vs-iterate, and the feedback loop that
turns a finished build into a *decision made from evidence.* The single most important
thing here: the metrics are **honest about what exists and what doesn't yet.** The eval
*harness* and the *gate* are documented decisions; the actual *numbers* are produced by
running the gate — and where a number doesn't exist yet, this file says so.

## Zoom out — where success is measured

Success isn't "the agent runs." The loop runs from day one. Success is **a measured
decision** — and the artifact that proves it is a one-pager, not the code.

```
  Zoom out — the metric stack, from "it runs" to "it's proven"

  ┌─ does it RUN? (necessary, not sufficient) ───────────────────────────┐
  │  bounded agent loop completes · tool dispatched · answer returned     │
  │  → this is a TEST, not an eval (agent-layer-plan.md:109)              │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ running ≠ good
  ┌─ is it GOOD? (the eval layer) ▼──────────────────────────────────────┐
  │  ★ precision@5 ≥ 0.8 ★  ·  faithfulness (rubric judge)  ·            │ ← the gate
  │  JSON validity rate                                                   │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ measured → decide
  ┌─ the PORTFOLIO ARTIFACT ──────▼──────────────────────────────────────┐
  │  Phase-4 one-pager: eval numbers + failure breakdown + next action    │
  │  "the write-up matters as much as the code"  agent-layer-plan.md:33   │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The metric that gates everything is **precision@5 ≥ 0.8** before the project moves
forward (`agent-layer-plan.md:93`). But the *deliverable* metric — the one that proves the
career-face pain is solved — is the **Phase-4 one-pager**: the numbers, a failure-category
breakdown, and a chosen next action. The write-up is the portfolio artifact, not the repo.

## Structure pass

**Layers:** tests (does the loop run?) sit below evals (is the answer good?), which sit
below the decision (ship / iterate / fine-tune?). Confusing the layers is a documented
non-goal: *"don't conflate evals (good answers) with tests (loop runs). Both needed"*
(`agent-layer-plan.md:109`).

**Axis — *what does this number actually prove?*** Trace it up the layers:

```
  one axis — "what does this number prove?" — traced up the stack

  ┌─ test layer ─────────────────┐   proves: the machinery works
  │ loop completes, tool fires   │   does NOT prove: the answer is right
  └───────────────┬──────────────┘
  ┌─ eval layer ──▼──────────────┐   proves: retrieval finds the right chunks
  │ precision@5 ≥ 0.8            │   (precision) and the answer is grounded
  │ + faithfulness + JSON valid  │   (faithfulness)
  └───────────────┬──────────────┘
  ┌─ decision layer ▼────────────┐   proves: I can make a build/ship call FROM
  │ ship / iterate / fine-tune   │   evidence — the actual portfolio signal
  └──────────────────────────────┘
```

**Seam:** the load-bearing boundary is between the eval *number* and the *decision rule*.
The number alone is trivia; the decision rule (≥80% → ship, 50–80% retrieval-bound →
improve retrieval, <50% → architecture problem) is what turns measurement into judgment.
That seam is where "played with an LLM" becomes "does AI engineering."

## The metrics — what each one is, what it proves, and its honest status

```
  metric ledger — defined vs produced vs not-yet

  ┌──────────────────────┬────────────────────────────┬──────────────────┐
  │ metric               │ what it proves             │ honest status    │
  ├──────────────────────┼────────────────────────────┼──────────────────┤
  │ precision@5 ≥ 0.8    │ retrieval surfaces the      │ HARNESS wired    │
  │   (the gate)         │ right chunks; the gate      │ (precision@k +   │
  │                      │ before moving forward       │ recall@k); the   │
  │                      │                            │ NUMBER comes from│
  │                      │                            │ running it       │
  ├──────────────────────┼────────────────────────────┼──────────────────┤
  │ faithfulness         │ the answer is grounded in   │ RubricJudge      │
  │   (rubric judge,     │ retrieved context, not      │ EXISTS in aptkit │
  │    Claude as judge)  │ hallucinated                │ but UNWIRED here │
  │                      │                            │ (don't let Gemma │
  │                      │                            │ grade Gemma —    │
  │                      │                            │ circular)        │
  ├──────────────────────┼────────────────────────────┼──────────────────┤
  │ JSON validity rate   │ the Gemma tool-call         │ named as a Phase │
  │                      │ emulation decodes reliably  │ 4 metric; the    │
  │                      │ (the riskiest seam)         │ riskiest surface │
  └──────────────────────┴────────────────────────────┴──────────────────┘
```

**Say the status out loud in the room.** "precision@5 ≥ 0.8 is my gate; the harness is
wired and the number comes from running it. Faithfulness uses a rubric judge with Claude as
the grader so the model doesn't grade itself — that one's defined in aptkit but I haven't
wired it into buffr yet." That honesty is *stronger* than a fabricated number. An invented
metric dies on the first "how did you compute that?"; a named gate with a named gap
survives every follow-up.

## The feedback loop — measurement → decision

### Move 1 — the mental model

You know a CI gate: the test suite goes green or red, and red blocks the merge. The eval
gate is that, but the "red" branches into *diagnoses*, not just pass/fail. The number
doesn't only say "good/bad" — it routes to a *specific next action* based on *why* it
failed.

```
  the eval decision tree — the number routes to an action

  run eval-harness → precision@5, faithfulness, JSON validity
        │
        ▼
   precision@5 ≥ 0.8 ? ──── YES ──► SHIP (it's good enough)
        │ NO
        ▼
   categorize the failures (retrieval miss / bad synthesis / model gap)
        │
        ├─ 50-80%, retrieval-bound  ─► improve retrieval
        ├─ 50-80%, model-bound      ─► escalate via fallback chain;
        │                              consider fine-tuning ONLY if the
        │                              failure pattern is narrow AND
        │                              trajectories can supply data
        └─ < 50%                    ─► ARCHITECTURE problem — don't paper
                                       over it with training
```

This decision tree *is* the portfolio artifact. Anyone can report "precision@5 = 0.82."
The signal is the rule that says what you'd do at 0.65 retrieval-bound vs 0.65 model-bound
vs 0.45 — and the discipline to call <50% an architecture problem instead of reaching for
fine-tuning. Anchor: `agent-layer-plan.md:97`.

### Move 2 — the feedback loop that makes fine-tuning answerable later

```
  why trajectory capture is part of the success loop

  every conversation → persisted to agents.messages (full trajectory)
        │
        ▼  this is the feedback corpus
  if Phase-4 evidence ever demands fine-tuning, the training data already
  exists — capture ships NOW so the fine-tune decision is ANSWERABLE later,
  not assumed   (agent-layer-plan.md:17)
```

The success loop isn't just "measure and ship." It's "measure, decide, and have the data to
revisit the decision when evidence changes." Trajectory capture is the part of the loop that
keeps the *next* decision (fine-tune or not) grounded in data instead of vibes. That's why
it ships in v1b even though fine-tuning is deferred — the loop is designed to keep
feeding itself.

## What "done" means — the success definition, verbatim from the plan

```
  done = the measured one-pager exists

  ✓ Phases 1-4 checked off
  ✓ a written one-pager with: eval numbers + failure-category breakdown +
    a chosen next action
  ✓ the agent runs, retrieves, generates with Gemma, persists everything
  ✓ MEASURED evidence about whether it's good enough to ship or what
    specifically needs to improve

  everything beyond (fine-tuning, gateways, skill auto-gen) is a Phase 5+
  decision made FROM evidence, not toward it
  (agent-layer-plan.md:135)
```

Done is not "it works." Done is "I have measured evidence and a decision made from it."
That's the success metric that maps back to the career-face problem: the pivot is proven
not by a running agent but by a *measured one-pager that shows engineering judgment under
real numbers.*

## The principle

Success metrics are worth defining only if they route to decisions. A number with no
decision rule is trivia; a decision rule with no number is a wish. The strongest success
story names the gate (precision@5 ≥ 0.8), names what each metric proves, is *honest about
which numbers exist and which don't yet*, and points at the decision tree that turns the
number into a next action. And it builds the feedback loop (trajectory capture) that keeps
the *next* decision grounded in evidence too. The deliverable isn't the agent — it's the
measured judgment the agent makes possible.

## Interview defense

**Q: What's your success metric, and do you have the number?**
The gate is precision@5 ≥ 0.8 — the harness is wired (precision@k + recall@k), and the
number comes from running it against a labeled eval set. I'm honest about the gaps:
faithfulness uses a rubric judge with Claude as grader (so the model isn't grading itself),
and that's defined in aptkit but not yet wired into buffr. A named gate with a named gap is
stronger than an invented number. Anchor: `agent-layer-plan.md:93`.

```
  precision@5 ≥ 0.8 = gate (wired)
  faithfulness via Claude-as-judge = defined, unwired (named, not hidden)
```

**Q: Say the number comes back at 0.65. What do you do?**
I categorize the failures first — retrieval miss vs bad synthesis vs model gap. If it's
retrieval-bound, I improve retrieval. If it's model-bound, I escalate via the provider
fallback chain and only consider fine-tuning if the failure pattern is narrow and the
captured trajectories can supply the data. The action depends on *why* it failed, not just
that it did. Anchor: `agent-layer-plan.md:97`.

**Q: Why capture every conversation if you're not fine-tuning?**
So the fine-tune decision is *answerable* later instead of assumed. Trajectory capture ships
now; if Phase-4 evidence ever demands fine-tuning, the training corpus already exists. The
feedback loop is designed to keep feeding the next decision. Anchor: `agent-layer-plan.md:17`.

## See also

- `01-problem-brief.md` — the career-face pain these metrics ultimately prove solved.
- `03-options-and-opportunity-cost.md` — "evals with numbers" as the separator that justified building.
- `.aipe/study-ai-engineering/05-evals-and-observability/` — the eval harness, deep-walked.
- `agent-layer-plan.md:89-135` — the phase plan, the gate, and the "done means" definition.
