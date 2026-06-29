# Reflexion / Self-Critique

*Industry names: **Reflexion** / **self-critique** / **self-refine** / **critic loop**. Type label: Industry standard. In this codebase: **Not yet implemented.** (buffr has no critic loop — one ReAct pass produces the answer, nothing grades it.)*

## Zoom out, then zoom in

This is the second rung above buffr's ReAct floor. It wraps a *critic* around the existing
loop. Here is where it would sit.

```
  Where the critic loop would slot in (dashed = NOT YET)

  ┌─ Session (chain) ──────────────────────────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
  ┌╌ ★ CRITIC LOOP (this file — NOT YET) ╌▼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎  draft = reactLoop(q)                                      ╎
  ╎  critique = model.grade(draft)                             ╎
  ╎  if bad: draft = reactLoop(q + critique)   ← retry         ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ ReAct kernel buffr already has ─▼────────────────────────┐
  │  runAgentLoop — run-agent-loop.ts:98-190                  │
  └────────────────────────────────────────────────────────────┘
```

The honest sentence first: **buffr has no critic.** `answer()` returns the first loop's
output directly — `finalText.trim() || FALLBACK_ANSWER` — with no second model pass to grade
or revise it. This file teaches the pattern, its cost, and its one real limit.

## Structure pass

One axis: **trust** — do we trust the first answer, or do we make the model check itself?

```
  Axis = TRUST · who validates the answer before the user sees it

  ReAct (buffr today)     trust the first pass — return finalText directly
  ─────────── ★ SEAM: a second model pass JUDGES the first ★ ───────────
  reflexion               distrust → model critiques + retries (2-5x tokens)
```

The seam is the introduction of a *second model role*: a critic that reads the draft and
decides if it's good enough. buffr trusts the first pass (with retrieval grounding as its
only quality guard). Reflexion withholds that trust and pays 2-5x the tokens to have the
model grade and revise its own work. That multiplier is the whole reason this is a rung you
climb reluctantly.

## How it works

### Move 1 — mental model

Two roles played by the same model: an **actor** that drafts, a **critic** that grades, in a
loop that retries until the critic is satisfied (or a cap is hit). Bridge from frontend:
it's form validation where the *validator and the submitter are the same component* — submit,
read your own error, fix, resubmit.

```
  THE SHAPE — draft, critique, retry

  ┌─ DRAFT ──────────────┐
  │ answer = reactLoop(q) │◀──────────────┐
  └─────────┬────────────┘               │
            ▼                            │ retry with the critique
  ┌─ CRITIQUE ───────────┐               │ appended to the prompt
  │ verdict = grade(answer)│             │
  └─────────┬────────────┘               │
       good │  │ bad ─────────────────────┘
            ▼
  ┌─ RETURN answer ──────┐   (cap retries — same budget discipline as file 02)
  └──────────────────────┘
```

### Pseudocode first — the language-agnostic logic

```
draft = reactLoop(question)               # buffr's current behavior stops HERE
for attempt in 0..maxRevisions:
    critique = model.grade(question, draft)   # 2nd model pass: "is this grounded? complete?"
    if critique.ok: break
    draft = reactLoop(question + critique)     # 3rd+ pass: revise using the critique
return draft
```

Annotation: the cost is in the loop body — `grade` is one extra model call per attempt, and
each failed grade triggers *another* full `reactLoop`. Two revisions can mean five model
calls for one answer. That's the 2-5x.

### What buffr does instead — one pass, no critic

```ts
// rag-query-agent.ts:62-83 (condensed) — the first loop's output IS the answer. No grading.
async answer(question: string): Promise<string> {
  ...
  const { finalText } = await runAgentLoop({ /* maxTurns:6, maxToolCalls:4 */ });
  return finalText.trim() || FALLBACK_ANSWER;   // ← returned raw. No critic pass. No retry on quality.
}
```

```
  buffr (today)          vs    reflexion (the refactor)

  q ──▶ [ReAct] ──▶ answer      q ──▶ [ReAct] ──▶ draft
                                          │
                                          ▼
                                     [CRITIC] ──bad──▶ [ReAct again]
                                          │ good
                                          ▼
                                       answer
```

Annotation: buffr's only quality guard is retrieval grounding — the prompt says "ground
every answer in the retrieved chunks" (`rag-query-agent.ts:24-26`) and `FALLBACK_ANSWER`
catches the empty case. There is no model *grading* the draft. You'd add reflexion when you
log **confidently-wrong** answers that retrieval grounding didn't catch.

### The limit you must name — shared blind spot

The critic is the same model as the actor. If the model is wrong *and confident* about
something — a misread of a retrieved chunk, a reasoning gap — it will grade its own wrong
answer as fine. Self-critique cannot catch errors that live in the model's own blind spot;
it catches *sloppiness* (missed steps, ungrounded claims it can re-check against retrieval),
not *blind spots*.

```
  Shared blind spot — why self-critique has a ceiling

  actor says X (wrong, confident)
        │
        ▼
  critic = SAME model ──▶ "X looks right"   ← cannot see its own blind spot
  → catches: forgot to cite, skipped a sub-question, ungrounded claim
  → misses:  anything the model is confidently wrong about
```

### Move 3 — the principle

**Reflexion buys quality by paying 2-5x tokens for a second model pass — and it only buys
the quality the model can already see.** It fixes sloppiness, not blind spots. Adopt it only
when you've logged confident-but-wrong answers *and* you have a critique signal (like
retrieval grounding) the critic can check against — otherwise you're paying 2-5x for the
model to rubber-stamp itself.

## Primary diagram

Full recap: the critic loop, its cost, its limit, the verdict.

```
  Reflexion — the rung buffr hasn't climbed

  ┌╌ NOT YET in buffr ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎ draft → CRITIQUE → retry      cost: 2-5x tokens          ╎
  ╎ trigger: logged confident-wrong answers grounding missed ╎
  ╎ limit:   SHARED BLIND SPOT — critic = actor              ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ executor = buffr's kernel, reused ──▼────────────────────┐
  │ runAgentLoop   run-agent-loop.ts:98-190                   │
  └────────────────────────────────────────────────────────────┘
  buffr today: ONE pass, grounding-only guard   rag-query:24-26,82
```

Verdict in one line: **a critic loop on top of the existing kernel — 2-5x tokens, catches
sloppiness not blind spots, unjustified until confident-wrong is logged. Not yet.**

## Elaborate

Reflexion (Shinn et al., 2023) and Self-Refine (Madaan et al., 2023) showed iterative
self-critique improving results on reasoning and coding tasks — but the gains depend on a
*verifiable* signal the critic can check against (test pass/fail, retrieval grounding). With
no external signal, self-critique mostly reshuffles. The shared-blind-spot limit is why
production "critic" setups increasingly use a *different* model or an external verifier as
the judge — which then overlaps with multi-agent (Section C, the debate topology) and
LLM-as-judge evaluation (Section D). The self-critique *prompt* mechanics — how you phrase
the grading instruction — live in `study-prompt-engineering`; this file is about the loop
shape and when to pay for it.

Read next: `06-tree-of-thoughts.md` — the most expensive rung, and why buffr correctly skips
it entirely.

## Interview defense

**Q: "Should buffr self-critique its answers?"**

Model answer: "Not yet. buffr returns the first ReAct pass directly
(`rag-query-agent.ts:82`) with retrieval grounding as the only quality guard
(`:24-26`). A reflexion loop would add a critic pass — draft, grade, retry — at 2-5x the
tokens. I'd adopt it only if I logged *confidently-wrong* answers that grounding missed, and
even then I'd note the limit: the critic is the same model, so it shares the actor's blind
spots — it catches sloppiness, not things the model is confidently wrong about. If I needed
to catch blind spots I'd reach for a *different*-model judge, which is Section C territory,
not self-critique."

```
  The defense in one picture

  one pass + grounding (buffr)  ──confident-wrong logged?──▶  add critic (2-5x)
                                                              limit: shared blind spot
```

Anchor: *Reflexion pays 2-5x for the model to grade itself — and can't see its own blind
spots; buffr hasn't logged the failure that justifies it.*

## See also

- `03-react.md` — the floor and the escalation discipline this rung obeys.
- `04-plan-and-execute.md` — the sibling rung that adds a planner instead of a critic.
- `06-tree-of-thoughts.md` — the next, most expensive rung.
- `study-prompt-engineering` → self-critique *prompt* mechanics (deliberately not re-taught here).
- `../04-agent-infrastructure/` → agent evaluation / LLM-as-judge (a *separate*-model judge).
