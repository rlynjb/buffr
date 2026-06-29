# Debate / Verifier / Critic

*Industry names: **producer–critic** / **generator–verifier** / **multi-agent debate** / **reviewer agent**. Type label: Industry standard. In this codebase: **Not yet implemented.** (buffr is single-agent; no separate critic exists.)*

## Zoom out, then zoom in

This is the topology for *quality*: one agent produces, another checks. Here is the SHAPE
first.

```
  THE TOPOLOGY — producer feeds critic, critic loops back (★ = the seam)

   input ─▶ ┌──────────┐  draft   ┌──────────┐
            │ PRODUCER  │────────▶│ ★ CRITIC  │
            │ (writes)  │◀────────│ (checks)  │
            └──────────┘ revise   └──────────┘
                 ▲                      │ verdict
                 └── loop until pass ───┘
                                        ▼
                                   accept ─▶ answer
   producer + critic = two loops (Section A skeleton, twice)
```

The topology is the mental model: **a producer and a critic facing each other, with a revise
loop between them.** The "debate" variant is two+ producers arguing and a judge deciding. The
honest sentence: buffr has no separate critic — one agent both retrieves and answers, judging
itself implicitly. This file teaches the producer/critic split and one trap: a critic that
shares the producer's blind spots.

## Structure pass

One axis: **control** — who decides when the answer is good enough?

```
  Axis = CONTROL · the SEAM is moving the "is this good?" judgment to a SEPARATE actor

  single-agent (buffr)   the SAME model that wrote the answer also decides it's done
  ──────────── ★ SEAM: judgment moves to a DIFFERENT actor ★ ──────────
  producer–critic        a SEPARATE critic decides; producer cannot self-approve
```

The whole value of this topology is moving the "is this good?" decision *out* of the actor that
produced the answer. A model judging its own output is a weak check — it's already committed to
its answer. A separate critic with a *different* prompt (or different model) can catch what the
producer can't see. The seam is exactly that separation. But it has a sharp edge (the structure
pass's hidden cost): if the critic is the *same model family* with a *similar* prompt, it shares
the producer's blind spots and rubber-stamps the same errors — separation in name only.

## How it works

### Move 1 — mental model

A producer/critic pair with a revise loop — a code-review cycle for model output. Bridge from
frontend: it's a PR review loop — author opens, reviewer requests changes, author revises,
reviewer approves — except both author and reviewer are agent loops, and you must guard against
the reviewer being a rubber stamp.

```
  THE SHAPE — produce, critique, revise, until pass

   ┌─ PRODUCER ─┐ draft  ┌─ CRITIC ─┐
   │ runAgentLoop│──────▶│runAgentLoop│
   └─────────────┘       └─────┬──────┘
        ▲                      │
        │ "fix X, Y"   pass? ──┤
        └──────────────────────┘ no → revise (bounded! see 09 infinite loop)
                                yes → accept
```

### Producer — generates a draft

The producer is an ordinary agent loop whose job is to *make something*: an answer, a plan,
code. It's exactly buffr's current agent — retrieve and answer.

```
  Producer — a normal agent loop, output is a DRAFT not a final

   input ─▶ PRODUCER (runAgentLoop) ─▶ draft answer
            same shape as buffr's RagQueryAgent, but its output is provisional
```

### Critic — judges with a DIFFERENT lens, and the blind-spot trap

The critic is a second loop with a *different* prompt: "find what's wrong." Its independence is
the entire point — and its fragility. A critic from the same model family that shares the
producer's training blind spots will confidently approve the same mistakes.

```
  Critic — separate lens, but BEWARE shared blind spots

  STRONG critic:  different prompt + (ideally) different model family
                  → catches errors the producer can't see
  WEAK critic:    same model, near-identical prompt
                  → rubber-stamps the SAME blind spots (shared-blind-spot trap)

  ┌─ PRODUCER (Gemma) ─┐      ┌─ CRITIC (Gemma, same prompt) ─┐
  │ "the answer is X"   │────▶│ "looks right to me"            │  ← false confidence
  └─────────────────────┘     └────────────────────────────────┘
```

Annotation: this is the load-bearing warning of the file. The shared-blind-spot problem is the
same bias `study-ai-engineering`'s LLM-as-judge concept covers — a judge from the same model
family inherits the same failure modes. Mitigations: a different model for the critic, an
adversarial "your job is to find the flaw" prompt, or grounding the critic in an external check
(run the code, validate against a schema) rather than another opinion.

### Debate — N producers argue, a judge decides

The debate variant fans out to multiple producers with different stances, lets them critique
each other, then a judge picks. It's fan-out (`04`) whose merge is an argument.

```
  Debate — multiple producers + a judge (fan-out whose merge is an argument)

   ┌─ PRODUCER A ─┐ ┌─ PRODUCER B ─┐
   │ "answer is X" │ │ "answer is Y" │
   └──────┬────────┘ └──────┬────────┘
          └──── critique ────┘
                  ▼
           ┌─ JUDGE ─┐ picks / synthesizes ─▶ answer
           └─────────┘
```

Annotation: debate is expensive (N producers + cross-critique + a judge = many model calls) and
only pays off on genuinely contestable questions. For most tasks a single producer–critic pair
is the better cost/quality point.

### What buffr does instead — implicit self-judgment

buffr's one agent both produces and decides it's done. The success exit *is* the model judging
its own output — a weak self-critique, with no separate lens.

```ts
// rag-query-agent.ts:62-83 — ONE agent: produces AND self-approves via the success exit
const { finalText } = await runAgentLoop({ model, tools, ... maxTurns: 6, maxToolCalls: 4, ... });
// no second loop, no critic — the model's "I'm done" IS the only quality gate
```

Annotation: buffr's quality gate is the success exit (`run-agent-loop.ts:131-135`) — the model
deciding to stop. That's self-judgment, the weak form. A separate critic isn't built because
buffr hasn't measured a synthesis-quality ceiling that a critic would address; when it does,
the parent plan's "faithfulness via a rubric judge" (`agent-layer-plan.md` Phase 4) is the
external-check version of a critic — grounded, not just another opinion.

### Move 3 — the principle

**A critic is only worth its cost if it has a different lens than the producer — otherwise it's
a rubber stamp.** Reach for producer–critic when you've measured a *quality* ceiling (wrong but
confident answers) that the producer can't self-correct. Make the critic independent: different
model, adversarial prompt, or an external grounded check. Bound the revise loop (it can ping-
pong forever — see `09`). And prefer a grounded check (run it, validate it) over "ask another
model if it's good," because opinion-on-opinion shares blind spots.

## Primary diagram

Full recap: the producer/critic loop, the blind-spot trap, the verdict.

```
  Producer–critic — the quality loop and its trap

   PRODUCER ──draft──▶ CRITIC ──verdict──▶ accept ─▶ answer
      ▲                  │
      └─── revise ───────┘  (BOUNDED — infinite revise = 09's failure)

  CRITIC INDEPENDENCE (the whole point):
    strong = different model / adversarial prompt / external grounded check
    weak   = same model + same prompt = shared blind spots (rubber stamp)
  ───────────────────────────────────────────────────────────────
  buffr: NOT YET · self-judgment via success exit (run-agent-loop.ts:131-135)
  external-check version = Phase-4 faithfulness rubric judge (agent-layer-plan.md)
```

Verdict in one line: **the quality topology — a separate critic with a *different* lens, bounded
revise loop — and buffr self-judges via the success exit, no critic yet (not justified until a
synthesis ceiling is measured).**

## Elaborate

Producer–critic is "Reflexion" / "self-refine" promoted to *two agents* instead of one model
self-critiquing (the single-agent version is Section A's reflexion file). Multi-agent debate is
the "Improving Factuality via Debate" line of work; LLM-as-judge is the critic used for
*evaluation* rather than inline correction. The dominant production caveat across all of them is
the shared-blind-spot problem: a same-family judge correlates with the producer's errors, so the
serious systems either use a different model family for the critic, an adversarial prompt, or —
best — replace opinion with an *external* check (execute the code, validate the JSON, query a
ground-truth source). That last move is why buffr's Phase-4 "faithfulness rubric judge" is the
right shape: it grades against retrieved evidence, not against another free-form opinion.

To adopt a critic for buffr, see SECTION F's quality-gate template — it shows adding a critic
loop after the producer with a bounded revise count and an external faithfulness check.

## Interview defense

**Q: "Would adding a critic agent improve buffr's answers?"**

Model answer: "Only if it has a *different lens* than the producer — and only after I've
measured a synthesis-quality ceiling. The trap is the shared-blind-spot problem: a critic that's
the same model with a near-identical prompt just rubber-stamps the same errors — same bias as
LLM-as-judge from the same family. So the critic needs a different model, an adversarial 'find
the flaw' prompt, or, best, an *external* grounded check rather than another opinion. buffr today
self-judges via the success exit (`run-agent-loop.ts:131-135`) — the weak form — and I haven't
measured a ceiling a critic would fix. The right first step is the project's Phase-4 faithfulness
rubric judge (`agent-layer-plan.md`), which grades against retrieved evidence, not against
another free opinion. And whatever I build, the revise loop is bounded — a producer–critic
ping-pong can run forever."

```
  The defense in one picture

  critic with DIFFERENT lens?  ── no ──▶ rubber stamp (shared blind spots)
        │ yes
  produce ─▶ critique ─▶ revise (BOUNDED) ─▶ accept    prefer EXTERNAL grounded check
  buffr: self-judges via success exit · no critic yet
```

Anchor: *A critic only helps if its lens differs from the producer's — same-family same-prompt
critics share blind spots; buffr self-judges via the success exit, no separate critic yet.*

## See also

- `01-when-not-to-go-multi-agent.md` — measure the quality ceiling before adding a critic.
- `04-parallel-fan-out.md` — debate is a fan-out whose merge is an argument + a judge.
- `09-coordination-failure-modes.md` — the bounded-revise requirement (infinite producer–critic
  loop).
- `../01-reasoning-patterns/05-reflexion-self-critique.md` — the single-agent version (one model
  critiquing itself).
- `study-ai-engineering` → LLM-as-judge bias — the shared-blind-spot problem in detail.
- `../06-orchestration-system-design-templates/` (SECTION F) — the quality-gate refactor.
