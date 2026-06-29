# Debate / verifier-critic — agents argue or check to refine quality

**Industry name(s):** multi-agent debate · verifier-critic ·
producer-critic · generator-discriminator. **Type label:** Industry
standard.

**In this codebase: Not yet implemented for the agent — but the
ingredient exists in the bundle.** buffr's `RagQueryAgent` does not run
a critic. Notably, aptkit ships a `rubric-judge` and a separate
`rubric-improvement` agent in the bundle that buffr doesn't wire in —
the verifier-critic shape is one import away, deliberately unused.

## Zoom out, then zoom in — lead with the shape

```
  Debate vs verifier-critic topologies (lead with both)

  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A │◄─►│agent B │          │ producer │──►│ critic   │
  │(propose)│  │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │ reject)  │
       │            │                              └──────────┘
       └─────┬──────┘                    loop until approved
             ▼                           (cap the rounds)
        judge picks
```

Zoom in: a second perspective catches errors the first missed. Debate
is symmetric (two agents argue, a judge picks); verifier-critic is
asymmetric (a producer makes, a critic approves or rejects, loop until
approved). Both cap the rounds or they spin forever.

## Structure pass

**Layers.** Producer and critic (or two debaters plus a judge). The
critic is a layer above the producer's output.

**Axis — "does the checker share the maker's blind spots?"** This is
the load-bearing axis. If the critic is the *same model* as the
producer, it shares the blind spots that produced the error — so it
catches format failures but not subtle reasoning. Using a *different*
model family for the critic is what makes the check independent.

**Seam.** The producer→critic boundary. The contract is the critic's
verdict (approve/reject + reason); the failure is a critic that rubber-
stamps because it can't see what the producer missed.

## How it works

#### Move 1 — the mental model

This is reflexion (`01-reasoning-patterns/05-reflexion-self-critique.md`)
split across two agents instead of one model talking to itself. The key
upgrade: the critic can be a *different* model, so the check isn't just
the producer second-guessing itself.

```
  Pattern — producer-critic loop

  producer → draft
              ▼
         critic: approve | reject(reason)
          ┌─────┴─────┐
          ▼ approve    ▼ reject
        return    producer revises with the reason → loop (cap)
```

#### Move 2 — the walkthrough (the unused ingredient)

**aptkit hands buffr the critic for free.** The bundle exports a
`rubric-judge` and an `agent-rubric-improvement` package
(`node_modules/@rlynjb/aptkit-core/.../@aptkit/evals`,
`.../@aptkit/agent-rubric-improvement`). A verifier-critic buffr would
wire the judge as the critic over `RagQueryAgent`'s draft: produce an
answer, have the judge score its groundedness against the retrieved
chunks, and loop with `agent-rubric-improvement` if it fails. The parts
exist; `RagQueryAgent` just doesn't compose them.

**The different-model rule, for local Gemma.** buffr runs one model:
gemma2:9b. A critic that's *also* gemma2:9b shares its blind spots —
it's the reflexion ceiling again. The honest version uses a different
model family for the critic (a second local model, or a cloud model for
high-stakes answers). On a single-model local setup, debate/critic buys
less than it does in a multi-model system — which is part of why buffr
doesn't run it.

**When it earns its overhead.** High-stakes outputs where a second
perspective measurably catches errors — a developer agent plus a
reviewer agent in a coding system, say. The cost: every round is a full
agent turn. For buffr's personal-knowledge answers, the stakes don't
yet justify doubling the token cost on every turn.

```
  Comparison — reflexion vs verifier-critic

  reflexion (1 model):             verifier-critic (2 agents):
    Gemma drafts → Gemma critiques    producer → DIFFERENT-model critic
    (shares blind spots)              (independent check, if diff family)
```

#### Move 3 — the principle

A second perspective catches errors only to the degree it's
*independent*. Same-model critique catches format and obvious errors;
different-model critique catches more. The pattern earns its per-round
cost on high-stakes outputs and wastes it on low-stakes ones. buffr has
the critic available in the bundle and deliberately doesn't pay for it —
the right call for single-model, low-stakes answers.

## Primary diagram

```
  Verifier-critic (would-be in buffr, using the unused rubric-judge)

  question → RagQueryAgent → draft + retrieved chunks
                                │
                                ▼
                     rubric-judge: grounded? scored?
                      ┌──────────┴──────────┐
                      ▼ pass                 ▼ fail
                   return        agent-rubric-improvement → revise → loop (cap)
```

## Elaborate

Multi-agent debate (Du et al., 2023) showed that several agents
proposing and critiquing converge on better answers than one — but the
gain depends on diversity, which a single model undermines. The
asymmetric verifier-critic is the more practical production form: one
maker, one checker, capped rounds. It shares the self-preference-bias
hazard with LLM-as-judge — a critic from the same model family favors
its own family's style — which is the cross-reference to the
prompt-engineering and (future) ai-engineering judge files.

## Interview defense

**Q: buffr's bundle has a rubric-judge — why isn't it a critic loop?**
Because buffr runs one model. A gemma2:9b critic over a gemma2:9b
producer shares its blind spots, so it'd catch format and groundedness
slips but not subtle reasoning — and it doubles token cost on every
turn. The judge is wired for the precision@k eval, not an inline
verifier. I'd add a critic loop only with a different model family and
a measured quality gap that justified the cost.

```
  producer → critic(approve|reject) → loop   (independence = the point)
```

**Anchor:** "A critic catches errors only as far as it's independent —
same model, same blind spots."

## See also

- `01-reasoning-patterns/05-reflexion-self-critique.md` — the
  single-model version
- `04-agent-infrastructure/04-agent-evaluation.md` — where buffr's
  rubric-judge is actually used
- LLM-as-judge self-preference bias would be in
  `study-ai-engineering/.../llm-as-judge.md`
