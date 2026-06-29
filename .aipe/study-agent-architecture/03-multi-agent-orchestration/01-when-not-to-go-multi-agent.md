# When NOT to Go Multi-Agent

*Industry names: **the escalation gate** / **single-agent-first** / **"do you actually need multi-agent?"**. Type label: Industry standard discipline. In this codebase: IMPLEMENTED as a **decision** — buffr stays single-agent on purpose.*

## Zoom out, then zoom in

This file is the gate every other file in this sub-section sits behind. It is not a topology;
it is the *question you answer before drawing any topology*. Here is where it sits relative to
the catalogue.

```
  The gate guards the whole catalogue — the ★ is this decision

  ┌─ buffr today: ONE agent ───────────────────────────────────┐
  │  RagQueryAgent → runAgentLoop  (single bounded ReAct loop)  │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ ★ THE ESCALATION GATE (this file) ─▼──────────────────────┐
  │  "Is there a SPECIFIC failure single-agent can't fix,      │
  │   and is it decomposable into INDEPENDENT specialties?"    │
  │        NO  ──────────────▶  stay single  ◀── buffr is here │
  │        YES ──────────────▶  open the catalogue below       │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ the topology catalogue (02–08) ──▼────────────────────────┐
  │  supervisor · pipeline · fan-out · debate · swarm · graph  │
  └────────────────────────────────────────────────────────────┘
```

The verdict, first sentence: **buffr stays single-agent, and that is the senior answer.** A
single-agent ReAct loop that hasn't hit a measured quality ceiling has earned *nothing* — and
multi-agent costs 2–5x in tokens, latency, and debug surface for the privilege. This file
teaches you to *decline* with a reason, which is the move interviewers actually score.

## Structure pass

One axis: **decomposability** — can the failing task be split into independent specialties?

```
  Axis = DECOMPOSABILITY · the gate flips on this one question

  not-yet-failing          stay single — no ceiling hit, nothing to decompose
  failing, but ONE skill   stay single — improve the prompt/tool/retrieval
  ──────────── ★ SEAM: the failure splits into SEPARATE jobs ★ ──────────
  failing, MANY skills     multi-agent earns its overhead (now pick a topology)
```

The seam is not "is the task hard" — hard single-skill tasks stay single-agent. The seam is
"does the failure split cleanly into jobs that *different specialists* would each own, with
*little* coordination between them?" If the sub-jobs are tangled (each needs the other's
mid-result constantly), you don't have a fan-out, you have a chatty distributed system —
and you've bought all the overhead with none of the parallelism. buffr's failure mode, when
it fails, is a *single* skill failing (retrieval miss or weak synthesis), so the gate stays
shut. That seam is the whole file.

## How it works

### Move 1 — mental model

The gate is a four-step funnel: **baseline → measure → locate the specific failure → test
decomposability.** Bridge from frontend: it's the same discipline as not reaching for
Redux/a state library until `useState` *measurably* hurts — you don't add the coordination
layer on spec, you add it when a profiled problem demands it.

```
  THE SHAPE — the four-gate funnel (fall through ALL four to go multi-agent)

  ┌─ 1 BUILD single-agent baseline ────────────────────────────┐
  │   buffr: RagQueryAgent + bounded ReAct loop  ✓ done         │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ 2 MEASURE it ───────────▼─────────────────────────────────┐
  │   evals: precision@5, faithfulness, JSON validity          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ 3 LOCATE the specific failure ──▼─────────────────────────┐
  │   "retrieval miss" or "bad synthesis" or "model gap"?      │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ 4 DECOMPOSABLE into independent specialties? ──▼──────────┐
  │   NO  → fix the one skill, STAY SINGLE  ◀── buffr's answer │
  │   YES → NOW open the topology catalogue                    │
  └────────────────────────────────────────────────────────────┘
```

### Gate 1 — build the single-agent baseline first

You cannot evaluate "do I need more agents" without a measured one-agent number. buffr already
has the baseline: one `RagQueryAgent` wrapping one bounded loop.

```
  Gate 1: the baseline already exists — there is exactly ONE actor

   question ─▶ RagQueryAgent.answer() ─▶ runAgentLoop ─▶ answer
                                          (one model, one tool)
              rag-query-agent.ts:62-83 · run-agent-loop.ts:76-202
```

Annotation: buffr clears gate 1 — there is exactly one actor (`run-agent-loop.ts:76-202`,
`runAgentLoop`, one `model.complete` caller). You can't skip this gate. Teams that start
multi-agent have no single-agent number to beat, so they can never prove the second agent
earned its keep.

### Gate 2 — measure before you reach

The trigger to even *consider* multi-agent is a *number*, not a vibe. buffr's measurement plan
is Phase 4 of the parent vision: precision@5, faithfulness via a rubric judge, JSON validity.

```
  Gate 2: a number gates the decision, not intuition

  precision@5 ≥ 0.8 ?  ──┐
  faithfulness  ok ?  ──┼──▶ if the baseline is GOOD → no escalation, ship
  JSON validity ok ?  ──┘     if BAD → go to gate 3 (locate WHICH failure)
              agent-layer-plan.md Phase 4 — measure, then decide
```

Annotation: "decide *from* evidence, not toward it" is the parent doc's exact framing
(`agent-layer-plan.md`). buffr hasn't run the gate-2 measurement that would even open the
question, which alone is enough to stay single.

### Gate 3 — locate the SPECIFIC failure

A bad eval number is not a license to add agents. You categorize *which* failure. The parent
plan's own failure taxonomy is the template: retrieval miss / bad synthesis / model gap.

```
  Gate 3: WHICH failure? — the fix differs per category

  retrieval miss   → fix RETRIEVAL (chunking, embeddings, re-rank)  ── single-agent fix
  bad synthesis    → fix the PROMPT or add a critic pass            ── single-agent fix
  model gap        → escalate model / fallback chain / fine-tune    ── single-agent fix
  ────────────────────────────────────────────────────────────────────
  None of these is "add a second agent." Most ceilings are ONE skill.
```

Annotation: notice every row's fix is still single-agent. The common junior error is "answers
are weak → add a researcher agent and a writer agent." Almost always the real fix is one of
these three single-agent moves. Multi-agent doesn't fix a retrieval miss.

### Gate 4 — is the failure decomposable into independent specialties?

Only here does multi-agent become a candidate — and only if the failure splits into jobs a
*different specialist* would own, with *little* cross-talk.

```
  Gate 4: decomposable = independent jobs, LITTLE coordination

  DECOMPOSABLE ✓                    NOT DECOMPOSABLE ✗
  ┌──────────┐ ┌──────────┐         ┌─────────────────────────┐
  │ legal     │ │ medical  │        │ "research"+"write" that  │
  │ reviewer  │ │ reviewer │        │ need each other's mid-   │
  └──────────┘ └──────────┘        │ result every other step  │
   independent, merge at end        └─────────────────────────┘
   → fan-out earns its overhead       → chatty: all cost, no win
```

Annotation: buffr fails gate 4. A personal-knowledge RAG query is *one* job — retrieve, then
answer. There are no independent specialties to hand to separate agents. So the gate stays
shut and buffr is single-agent **by decision**, not by omission.

### Move 3 — the principle

**Single-agent is the default; multi-agent is an escalation you justify with a measured,
decomposable failure — or you don't take it.** The cost you're buying is concrete: 2–5x the
tokens (every coordinator hop is another model call), more latency, and a debug surface that
multiplies (now a bad answer might be agent A's output, agent B's, the handoff, or the merge).
The senior sentence is "I considered multi-agent and chose single-agent, here is the number
that would change my mind." Say that and you've out-leveled the candidate who drew a
six-agent diagram on spec.

## Primary diagram

Full recap: the gate, the four steps, buffr's verdict at each.

```
  The escalation gate — buffr's answer at every step

  1 BASELINE       ✓ one RagQueryAgent + one bounded loop   (cleared)
       │
  2 MEASURE        ⧗ Phase-4 evals not yet run               (not even open)
       │
  3 LOCATE         → expected failures are SINGLE-skill:
       │             retrieval miss / bad synth / model gap
       │
  4 DECOMPOSABLE?  ✗ a RAG query is ONE job, not many
       │
       ▼
  VERDICT: STAY SINGLE-AGENT (by decision)
  cost avoided: 2–5x tokens · more latency · multiplied debug surface
  what would flip it: a measured, decomposable, multi-specialty failure
```

Verdict in one line: **buffr is a clean ReAct baseline that hasn't hit a ceiling, so the
correct, defensible choice is single-agent — and saying so is the senior move.**

## Elaborate

This gate is the explicit recommendation of every serious multi-agent write-up (Anthropic's
own multi-agent research post leads with "use a single agent until you can't"; the same
discipline runs through LangGraph and the OpenAI Agents SDK docs). The failure these guides
keep flagging is *premature decomposition*: teams split a task into agents before measuring,
then spend weeks debugging coordination bugs that a single agent never had — context bloat,
infinite handoffs, synthesis failures (all in `09`). Every one of those is a cost you only
pay *because* you went multi-agent.

The parent vision (`agent-layer-plan.md`) is itself disciplined about this: "Not a fleet of
agents — ship ONE agent end-to-end, measure it, then maybe generalize." The deferred
two-brain laptop+phone split is named as a *Phase 5+* possibility "made from evidence, not
toward it." That is this gate, written into the project's own thesis.

To actually adopt a topology once the gate opens, see SECTION F's system-design templates —
they show the refactor from buffr's single loop into a supervised or fanned-out shape.

## Interview defense

**Q: "Would multi-agent improve your system?"**

Model answer: "Not yet, and I can defend that precisely. buffr is a single bounded ReAct loop
(`run-agent-loop.ts:76-202`) and I gate multi-agent on four things: a measured baseline, a bad
eval number, a *specific* located failure, and that failure being decomposable into
independent specialties. buffr clears gate 1 but hasn't run the Phase-4 evals (gate 2), and
its expected failures — retrieval miss, weak synthesis, model gap — are each a *single-skill*
fix, not a job for separate agents (gate 3/4). Multi-agent would cost 2–5x in tokens and
multiply my debug surface for zero measured gain. The thing that would flip me: a measured,
decomposable, multi-specialty failure. Until then, 'I considered it and chose single-agent' is
the answer."

```
  The defense in one picture

  baseline + measured?  ── no ──▶ STAY SINGLE (buffr is here)
        │ yes
  specific failure?     ── single-skill ──▶ STAY SINGLE (fix the one skill)
        │ multi-specialty
  decomposable?         ── yes ──▶ NOW pick a topology
```

Anchor: *Single-agent is the default; you escalate only on a measured, decomposable,
multi-specialty failure — buffr has none, so it stays single by decision, not omission.*

## See also

- `02-supervisor-worker.md` — the first topology you'd reach for *after* this gate opens.
- `09-coordination-failure-modes.md` — the concrete costs this gate is protecting you from.
- `../01-reasoning-patterns/04-plan-and-execute.md` — the same "don't escalate on spec"
  discipline, one level down (within a single agent).
- `../06-orchestration-system-design-templates/` (SECTION F) — the refactor templates for when
  the gate opens.
- `agent-layer-plan.md` — the parent thesis: "ship ONE agent, measure, then maybe generalize."
