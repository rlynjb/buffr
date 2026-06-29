# Reflexion / self-critique — the agent grades its own draft and retries

**Industry name(s):** Reflexion · self-critique loop · self-refine ·
critic-revise. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr answers in one ReAct
pass with no self-critique step. It hasn't hit a measured
answer-quality ceiling that a second pass would close — and a second
pass costs 2-5x tokens, which matters on a local Gemma. (Note: aptkit
*has* a rubric-judge and a separate rubric-improvement agent in the
bundle, but `RagQueryAgent` does not wire them in.)

## Zoom out, then zoom in

Reflexion sits on top of a base reasoning pattern — it doesn't replace
ReAct, it wraps it with a critic.

```
  Zoom out — reflexion wraps a base pattern

  ┌─ Reasoning patterns (SECTION A) ─────────────────────────┐
  │   ReAct produces a draft answer                          │
  │      │ escalate when QUALITY has a measured gap           │
  │      ▼                                                    │
  │   ★ reflexion: critic step → revise → loop (capped) ★     │ ← we are here
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the agent produces a draft, then a critic step asks "is this
correct and complete?" If flawed, it revises and loops — capped, so it
can't spin. The point is a reliability step bolted onto an existing
pattern, not a new way of thinking.

## Structure pass

**Layers.** Two: the producer (the base ReAct loop) and the critic (an
added evaluation step). The critic is a layer above the draft.

**Axis — "where does quality get checked?"** In buffr today, nowhere —
the first draft is the answer. Reflexion adds an explicit check
between draft and return. That added checkpoint is the pattern.

**Seam.** The producer→critic boundary. The critical property of this
seam: a model critiquing *its own* output shares the blind spots that
produced it. That's why the seam is load-bearing and also why the
pattern has a known failure mode.

## How it works

#### Move 1 — the mental model

You know the "are you sure?" follow-up that sometimes makes a model
fix its own mistake? Reflexion automates that into a loop: draft →
critique → revise, until the critique passes or you hit the retry cap.

```
  Pattern — the critique-revise loop

  ┌─────────────────────────────────────────────┐
  │  base pattern (ReAct) produces a draft answer │
  └────────────────────┬─────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────┐
  │  Critic: "is this correct / complete /        │
  │           grounded in the retrieved chunks?"  │
  └──────────┬───────────────────────┬────────────┘
             ▼ good                   ▼ flawed
         return                  revise + loop
                                 (cap the retries)
```

#### Move 2 — the walkthrough (what it would take in buffr)

To add reflexion, you'd insert a critic call after `runAgentLoop`
returns `finalText` (`rag-query-agent.js:50`) and before
`answer.trim()`. The critic would re-read the retrieved chunks and the
draft and judge groundedness — buffr already *says* "ground every
answer in the retrieved chunks and cite their sources"
(`rag-query-agent.js:16-17`), but nothing *verifies* it. A reflexion
loop would close that: if the draft cites a source the retrieval
didn't return, revise.

**The hard limit that decides whether it's worth it.** A model
critiquing its own output shares its blind spots. Self-critique catches
*format* failures (missing citation, wrong shape) and *obvious* errors
well; it catches *subtle reasoning* failures poorly — the same model
that got the reasoning wrong is unlikely to catch it. For a local
Gemma2:9b, that ceiling is real: the critic isn't a sharper model, it's
the same model asked twice. The mitigation, when stakes justify it, is
a *different* model family for the critic — the asymmetric verifier in
`03-multi-agent-orchestration/05-debate-verifier-critic.md`.

**The cost is concrete.** Each revision round is a full extra model
turn — 2-5x tokens for one reliability step. On a cloud model that's a
latency line item; on local Gemma it's wall-clock the user waits
through. buffr hasn't measured a quality gap that justifies it, so it
doesn't pay it.

```
  Comparison — buffr today vs reflexion-wrapped

  buffr today:                      reflexion-wrapped:
    ReAct → draft → return            ReAct → draft
    (citation claimed, unverified)      → critic: grounded? cited?
                                          ├ yes → return
                                          └ no  → revise (cap 2)
```

#### Move 3 — the principle

Reflexion is a reliability tax you pay only where you've measured the
unreliability. It's strongest for catchable failure classes (format,
groundedness) and weakest for the subtle-reasoning failures that share
the producer's blind spots. Adding it without a measured gap buys cost,
not quality.

## Primary diagram

```
  Reflexion (would-be shape in buffr)

  question → ReAct loop → draft answer
                            │
                            ▼
                  ┌─ critic step ──────────────┐
                  │  grounded? cited? complete? │
                  └───────┬───────────┬─────────┘
                          ▼ pass      ▼ fail
                      return      revise → loop (cap 2)
```

## Elaborate

Reflexion (Shinn et al., 2023) framed self-critique as verbal
reinforcement — the agent writes a reflection on its failure and
retries with it in context. The prompt-level mechanics of writing a
good critique prompt live in the prompt-engineering guide
(`.aipe/study-prompt-engineering/`); this file covers reflexion as a
*loop structure* layered on a reasoning pattern. The strongest version
uses a different model family for the critic — which is the bridge to
the verifier-critic topology in SECTION C.

## Interview defense

**Q: Would self-critique improve buffr's answers?**
Only for catchable failure classes. buffr claims grounding and
citations but never verifies them — a critic that re-checks the draft
against the retrieved chunks would catch ungrounded answers. But a
Gemma critiquing Gemma shares blind spots, so it wouldn't catch subtle
reasoning errors, and it costs 2-5x tokens. I'd add it only after
measuring an ungroundedness rate that justified the cost.

```
  draft → critic(grounded?) → revise|return   (cap the loop)
```

**Anchor:** "Self-critique catches format and groundedness well,
subtle reasoning poorly — same model, same blind spots."

## See also

- `03-react.md` — the base pattern reflexion would wrap
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the
  asymmetric, different-model version
- `04-agent-infrastructure/04-agent-evaluation.md` — measuring the gap
  before paying the tax
- LLM-as-judge bias would be covered in
  `study-ai-engineering/.../llm-as-judge.md`
