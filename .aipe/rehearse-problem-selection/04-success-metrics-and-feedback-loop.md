# Chapter 4 — Success Metrics and the Feedback Loop

Everything so far justifies *starting* the project. This chapter justifies *finishing* it — by answering the question that turns a hobby into engineering: **how do you know it's good, and when are you done?** This is the line your own plan draws as the biggest separator in the whole field: *"Evals with numbers — precision@5, faithfulness, JSON validity rate. The biggest separator between 'played with an LLM' and 'does AI engineering.'"* A project without a success metric is someone tinkering. A project with a measured number and a decision rule attached to it is someone doing the job. The metric is what makes the *build* decision from Chapter 3 defensible instead of self-indulgent.

```
  THE FEEDBACK LOOP — measure, then decide from evidence

  ┌─ BUILD ───────────────────────────────────────────────┐
  │  index corpus → ask → retrieve → generate → persist   │
  └────────────────────────┬───────────────────────────────┘
                           │  run the ruler
  ┌─ MEASURE ─────────────▼────────────────────────────────┐
  │  precision@5  ·  recall@k  ·  faithfulness (rubric     │
  │  judge, DIFFERENT model)  ·  JSON validity rate        │
  └────────────────────────┬───────────────────────────────┘
                           │  categorize the failures
  ┌─ DECIDE (from evidence, not toward it) ───────▼─────────┐
  │  ≥80% → ship                                           │
  │  50–80% retrieval-bound → improve retrieval            │
  │  50–80% model-bound → fallback chain / maybe fine-tune │
  │  <50% → architecture problem; don't paper over w/      │
  │         training                                       │
  └────────────────────────────────────────────────────────┘
```

That loop is the chapter. The metric tells you where you are; the decision rule tells you what to do; the one-pager is the artifact that proves you closed the loop.

## The headline metric: precision@5 as a gate

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "How do you know your agent is any good?"             │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you have a *number*, or just vibes? And is the      │
  │   number a *gate* that blocks progress, or decoration    │
  │   you report after the fact?                            │
  └─────────────────────────────────────────────────────────┘

The strong answer names a specific metric *and* the threshold you gated on. Your plan sets it: *"Build a 20-item eval set; require precision@5 ≥ 0.8 before Phase 3."*

> "I measure retrieval with precision@5 against a labeled eval set, and I gated on it: precision@5 had to clear 0.8 before I let myself move from the API phase to agent integration. That's the key part — it's not a number I report at the end to look good, it's a *gate* that blocks the next phase. If retrieval can't surface the right chunks in the top 5 at least 80% of the time, there's no point wiring it into the agent, because a good model grounding on bad chunks still gives a bad answer. So 'how do I know it's good' isn't a feeling — it's a threshold that earns the right to keep building, and I built the scorer myself because AptKit didn't have one. I grepped its evals package for precision, recall, ndcg, mrr — nothing. So `scorePrecisionAtK` and `scoreRecallAtK` are mine."

  ┃ "The eval number isn't decoration I report at the end.
  ┃  It's a gate — precision@5 ≥ 0.8 — that blocks the
  ┃  next phase. A number that doesn't block anything
  ┃  isn't a metric, it's a vanity stat."

## The two-axis honesty: retrieval vs faithfulness

This is where you show you understand that *one* number isn't enough — and where you volunteer the gap honestly. precision@5 measures whether you retrieved the right chunks. It does **not** measure whether the answer is actually grounded in them. Those are two different failure surfaces, and conflating them is a junior mistake.

```
  TWO METRICS, TWO FAILURE SURFACES — don't conflate

  ┌─ retrieval quality ───────────────────────────────────┐
  │  precision@5 / recall@k                                │
  │  "did the right chunks reach the model?"               │
  │  ✓ built and measured                                  │
  └────────────────────────┬───────────────────────────────┘
                           │  a good answer needs BOTH
  ┌─ answer faithfulness ─▼────────────────────────────────┐
  │  rubric judge, grounding / no-hallucination dims       │
  │  "did the model actually USE the chunks, or make it    │
  │   up?"  — judged by a DIFFERENT model (Claude), so     │
  │   Gemma doesn't grade Gemma (that number is circular)  │
  └────────────────────────────────────────────────────────┘
```

> "precision@5 only measures whether the right chunks reached the model — not whether the answer is grounded in them. Those are separate failure surfaces. Faithfulness comes from a rubric judge scoring groundedness and no-hallucination, and critically, the judge has to be a *different* model family than the one being graded — Claude judging Gemma, never Gemma grading Gemma, because that number is circular. I'll be honest about the current state: I built and measure the retrieval metric; the faithfulness judge is designed but not yet wired, and it's the single highest-leverage thing I'd add. So I can prove I retrieve the right chunks. I can't yet prove the answer is grounded in them — and I know exactly which number closes that gap."

That honesty is a feature, not a confession. (It's the same gap you name as your top counterfactual in interview-defense Chapter 7 — keeping the two stories consistent is itself a signal.) Naming the metric you *haven't* wired, and naming exactly why it matters, proves you understand the metric better than someone who just reports a green number.

## The decision rule — the actual portfolio artifact

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Okay you have numbers — what do you DO with them?     │
  │    When is the project done?"                           │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do the metrics drive a *decision*, or do they just     │
  │   sit in a README? The senior move is a pre-committed    │
  │   decision rule that turns evidence into action.        │
  └─────────────────────────────────────────────────────────┘

This is the part that's genuinely rare, and it's straight from your plan's Phase 4. The metrics aren't the deliverable — the *decision made from them* is.

> "The metrics drive a pre-committed decision rule, and that decision is the actual deliverable. Phase 4 categorizes every failure — retrieval miss, bad synthesis, or model gap — and the rule is set in advance: 80% or better, ship it; 50 to 80 and retrieval-bound, improve retrieval; 50 to 80 and model-bound, escalate through the fallback chain and consider fine-tuning *only* if the failure pattern is narrow and my captured trajectories can supply the training data; below 50, that's an architecture problem and I don't paper over it with training. The point of pre-committing the rule is that I decide *from* evidence, not *toward* a conclusion I already wanted. 'Done' isn't 'the code runs' — done is a written one-pager with the eval numbers, the failure breakdown, and the chosen next action. That one-pager is the portfolio artifact. The write-up matters as much as the code."

```
  WHEN ARE YOU DONE? — done is the one-pager, not the code

  done  ≠  "the agent runs and answers"
  done  =  Phases 1–4 checked off
           + a written one-pager containing:
             • the eval numbers (precision@5, faithfulness,
               JSON validity)
             • a failure-category breakdown
             • a chosen next action (ship / iterate / fine-tune)

  the agent running is the PREREQUISITE.
  the measured decision is the DELIVERABLE.
```

  ┃ "Done isn't 'the code runs.' Done is a one-pager with
  ┃  the eval numbers, the failure breakdown, and a
  ┃  chosen next action. The decision is the deliverable."

## The third metric, named: JSON validity

Don't forget the operational one. Gemma has no native tool-calling — the provider emulates it by parsing tool calls out of text. JSON validity rate measures whether that emulation actually works, and it's a *different* failure surface again: a flaky answer degrades one response, but a flaky tool-call decode stalls the entire agent loop.

> "There's a third number that's easy to overlook: JSON validity rate. Gemma emits no native tool-calls, so my provider parses them out of text — and if that parse is flaky, the whole loop stalls, not just one answer. So JSON validity isn't a quality metric like precision, it's a *liveness* metric: it tells me whether the agent can act at all. Three numbers, three surfaces — retrieval quality, answer faithfulness, and tool-call liveness."

## When you're cornered

  ╔═════════════════════════════════════════════════════════╗
  ║ IF THEY SAY                                              ║
  ║   "A 20-item eval set is tiny. Those numbers don't        ║
  ║    mean anything."                                      ║
  ║                                                         ║
  ║ DON'T                                                    ║
  ║   Defend 20 items as statistically meaningful. It        ║
  ║   isn't, and claiming so loses the room.                ║
  ║                                                         ║
  ║ DO                                                       ║
  ║   "You're right that 20 items isn't a statistical claim  ║
  ║    — it's a *regression* tripwire and a forcing          ║
  ║    function. The value isn't 'precision is exactly       ║
  ║    0.84'; it's that I built the ruler, gated a phase on  ║
  ║    it, and have a labeled set I can grow. For a one-      ║
  ║    person portfolio project, having ANY measured gate    ║
  ║    is the separator — most personal AI projects have     ║
  ║    none. The honest framing is: small set, real          ║
  ║    discipline, expandable. I'd grow it before I trusted  ║
  ║    the absolute number for a ship decision."            ║
  ╚═════════════════════════════════════════════════════════╝

## The one-page version

**Core claim:** Success is measured, not felt. Three metrics on three surfaces — precision@5 / recall@k (retrieval quality, built and gated at ≥0.8 before Phase 3), faithfulness via a rubric judge run by a *different* model (answer grounding — designed, not yet wired, the top gap), and JSON validity (tool-call liveness, since Gemma's emulated tool-calls can stall the whole loop). The metrics feed a *pre-committed* decision rule (ship / improve retrieval / escalate-or-fine-tune / fix architecture), and "done" is a written one-pager with the numbers, the failure breakdown, and the chosen next action — not "the code runs."

**The questions, one-line answers:**
- "How do you know it's good?" → precision@5 ≥ 0.8, gated as a phase blocker, not reported decoration. I built the scorer; AptKit didn't have one.
- "Is one number enough?" → No — retrieval quality and answer faithfulness are different surfaces. Faithfulness needs a different judge model so it isn't circular.
- "What do you do with the numbers?" → A pre-committed decision rule turns them into a ship/iterate/fine-tune call decided *from* evidence, not toward it.
- "When are you done?" → When the one-pager exists: numbers + failure breakdown + next action. The write-up matters as much as the code.
- "20 items is tiny." → Right — it's a regression tripwire and a forcing function, expandable. Having *any* gate is the separator.

**The pull quote you keep:** *"The eval number isn't decoration — it's a gate that blocks the next phase. A number that doesn't block anything isn't a metric, it's a vanity stat."*

→ Next: Chapter 5, the skeptical reviewer. You've justified the problem, the scope, the build, and the metrics. Now someone tries to take it all apart — and you hold.
