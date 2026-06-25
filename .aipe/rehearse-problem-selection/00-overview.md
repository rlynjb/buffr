# Problem Selection — buffr-laptop

This is the book you read before anyone asks "why did you build this?" — not "how does it work" (that's the architecture and the study guides) and not "would you do it differently" (that's the interview-defense counterfactuals). This is the layer *underneath* all of those: the case that this problem was worth your time at all. Before the design, before the code, before the eval numbers — **why this problem, why now, why you, and why not just use the thing that already exists.**

You already built the thing. A single-device laptop RAG agent: you index your own markdown into Postgres + pgvector, you ask it questions, it retrieves chunks and grounds an answer from a local Gemma model, on your machine, no cloud. The interview question this book trains is the one that comes *before* the whiteboard: an interviewer leans back and says "okay — but Hermes already does this. Why didn't you just install it?" If you can't answer that in ninety seconds without flinching, none of the architecture talk matters, because you've already conceded that the project was a waste of time.

```
  Where problem-selection sits — the layer under the rest

  ┌─ PROBLEM SELECTION (this book) ───────────────────────────┐
  │  WHY this problem deserves your investment.               │ ← you are here
  │  Build-vs-buy · centralize the agent not the data ·       │
  │  scope discipline · why-her · cost of not solving         │
  └────────────────────────────┬──────────────────────────────┘
                               │ once the problem is justified…
  ┌─ DESIGN DOC ───────────────▼──────────────────────────────┐
  │  HOW the decision is communicated. agent-layer-plan.md,   │
  │  the two design specs, the phase plan.                    │
  └────────────────────────────┬──────────────────────────────┘
                               │ once the design is set…
  ┌─ STUDY GUIDES ─────────────▼──────────────────────────────┐
  │  HOW each pattern works. study-system-design,             │
  │  study-ai-engineering — one concept at a time.            │
  └────────────────────────────┬──────────────────────────────┘
                               │ once you understand it…
  ┌─ INTERVIEW DEFENSE ────────▼──────────────────────────────┐
  │  HOW you defend it under pressure. The pitch, the         │
  │  choices, the counterfactuals.                            │
  └────────────────────────────────────────────────────────────┘
```

You'll return to this stack. Problem selection is the floor. Everything else is built on the claim that the problem was real and worth solving — this book makes that claim defensible.

  ┃ "The hardest question about this project isn't
  ┃  'how does the agent loop work.' It's 'why didn't
  ┃  you just install Hermes.' Answer that first."

## The core thesis — say this when they ask "why build it"

Hold this in one breath. Everything in the five chapters is an expansion of it:

> "I'm a frontend engineer pivoting to AI engineering, and a portfolio needs to *show* the engineering, not hide it. Hermes is a turnkey personal agent — installing it would have given me a working tool and proven nothing about my skill, because a turnkey tool hides exactly the parts that signal it: the provider contract, the RAG pipeline, the centralized schema, the eval numbers. So I built one good agent end-to-end, borrowing Hermes' trajectory-capture *discipline* but none of its platform machinery, and measured it. The deliverable isn't a product. It's evidence — measured evidence — that I can do AI engineering, composed from the work I'd already shipped."

That's the whole book compressed. The chapters below give you the rows behind each clause.

## The book

Five chapters, in order. Each defends one face of the problem-selection decision.

| Ch | Title | The question it defends | The real decision behind it |
|----|-------|--------------------------|-----------------------------|
| 01 | The problem brief | "Why this problem? Why now? Why you?" | Hermes-shaped agent; the pivot is the why-now; the portfolio is the why-her |
| 02 | Scope cuts and non-goals | "Why is it so small? Why not the phone, the platform?" | One agent end-to-end; deferred the two-brain body; centralize the agent, not the data |
| 03 | Options and opportunity cost | "Why build instead of buy? Why not Pinecone, OpenAI, the cloud?" | Build-vs-buy (chose build); do-nothing; off-the-shelf Gemma + pgvector + aptkit |
| 04 | Success metrics and the feedback loop | "How do you know it's good? When are you done?" | precision@5 ≥ 0.8 gate; the Phase 4 one-pager; eval-driven ship/iterate/fine-tune |
| 05 | Skeptical reviewer questions | "Isn't this just a toy? Isn't it résumé-driven?" | The hard objections and the answers that hold |

## How to use it

**First read — in order, one chapter per sitting.** They build. Chapter 1 establishes the problem; Chapter 2 shows the scope discipline that proves you can say no; Chapter 3 is the build-vs-buy crux; Chapter 4 is what separates "played with an LLM" from "does AI engineering"; Chapter 5 is the pressure test.

**Review — skim the strong-vs-weak boxes and the pull quotes.** Each chapter has the same motifs: the "what they're really asking" boxes, the strong-answer block quotes in your voice, the double-bordered "when you're cornered" boxes. Skim those and you've got most of it.

**The night before — read only the strong-answer quotes.** They're written to be said out loud. Every one is in first person, in your voice, grounded in a decision that's actually in `agent-layer-plan.md` or the two design specs. Nothing invented.

## Where this fits with the rest of your prep

This book is the *premise*. The interview-defense book (`.aipe/rehearse-interview-defense/`) defends the project once an interviewer accepts it's worth defending; this book defends the *decision to build it at all*. They share a spine — the build-vs-buy call shows up in interview-defense Chapter 7 as a counterfactual you *don't* regret ("consuming aptkit — NO, right scope"), and here it's the central justification. Read this first. It's the answer to the question that comes before every other question.

  ┃ "Interview defense proves you can own the build.
  ┃  Problem selection proves the build was worth
  ┃  starting. The second question comes first."

A note on honesty before you start. Every claim in this book is grounded in something you actually wrote down — the `agent-layer-plan.md` thesis, the locked decisions in the two design specs, the `me.md` profile. There are **no invented users, no invented market, no invented metrics**. This is a personal portfolio project with one user (you) and a specific, honest purpose: to be the case for a frontend-to-AI pivot. The strong move is never to inflate that into "I'm solving a problem for millions." It's to be exact about what the problem actually is — *your* pivot needs evidence — and to defend that as a completely legitimate reason to build. It is.
