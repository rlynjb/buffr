# Chapter 1 — The Problem Brief

Three questions, in order, and you have to land all three: **what's the problem, why now, and why you.** Most engineers can answer "what" — they describe the thing they built. The senior move is answering "why now" and "why you" without hand-waving, because those are the two that prove the project was *chosen* rather than stumbled into. A project you stumbled into is a hobby. A project you chose, for a reason, at a moment when the reason was sharp — that's a portfolio.

```
  THE PROBLEM BRIEF — three questions, one shape

  ┌─ WHAT ────────────────────────────────────────────────┐
  │  a self-hosted personal agent that centralizes your    │
  │  data across your apps and "knows you over time"       │
  │  (Hermes-shaped: lives on your machine, gets smarter)  │
  └────────────────────────┬───────────────────────────────┘
                           │
  ┌─ WHY NOW ─────────────▼────────────────────────────────┐
  │  you are at the pivot point — 7 yrs frontend → AI       │
  │  engineering. The portfolio IS the pivot. No artifact, │
  │  no proof, no pivot. The cost compounds every month.   │
  └────────────────────────┬───────────────────────────────┘
                           │
  ┌─ WHY YOU ─────────────▼────────────────────────────────┐
  │  it composes work you already shipped: AdvntrCue RAG,  │
  │  dryrun/contrl on-device AI, aipe tooling, me.md. This │
  │  is the project that ties the scattered packages into  │
  │  one case for the frontend+AI combination.             │
  └────────────────────────────────────────────────────────┘
```

That's the brief. The rest of the chapter is each box, expanded into the answer you say out loud.

## What the problem actually is

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "So what is this thing?"                               │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you state the problem without reciting features?  │
  │   Do you know the shape of the thing, or just its       │
  │   parts? A features list is a junior answer; a problem  │
  │   statement is a senior one.                             │
  └─────────────────────────────────────────────────────────┘

The north star, in your own design doc's words, is *"an agent that lives across your surfaces, owns a model of you, and acts"* — Hermes' framing of "not a chatbot; an agent that lives on your machine and gets smarter." Don't lead with "it's a RAG app." Lead with the shape:

> "The problem is that my data and my context are scattered across every app I use, and nothing knows me over time. I wanted a self-hosted personal agent — one that centralizes the *agent layer* across my apps, holds a persistent model of me, and runs on my own machine so the data stays mine. It's Hermes-shaped: an agent that lives on your machine and gets smarter, not a chatbot you re-explain yourself to every session."

Notice what that answer does. It names the *pain* (scattered data, no memory, nothing that's actually yours) before it names the solution. The features — pgvector, the agent loop, the trajectory capture — are downstream of that. If you start at the features, the interviewer doesn't know what they're *for*.

  ┃ "Lead with the pain, not the parts. 'My context is
  ┃  scattered and nothing remembers me' is a problem.
  ┃  'It uses pgvector' is a feature."

## Why now — the pivot is the clock

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why build this now? What changed?"                   │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Is there a real forcing function, or did you just     │
  │   have a free weekend? "Why now" is where most          │
  │   personal projects collapse — there's no clock, so     │
  │   the project reads as aimless.                         │
  └─────────────────────────────────────────────────────────┘

This is the one that's specifically *yours*, and it's the strongest card you hold. You are not building this in a vacuum — you're at a deliberate career pivot, and the clock is the pivot itself.

> "I'm seven-plus years into frontend — Vue and React, shipped to FedEx, Amazon, CoreWeave — and I'm deliberately pivoting into AI engineering. The pivot isn't a plan; it's happening now. And a pivot needs proof. I can say 'I do AI engineering' in an interview all day, but the thing that actually moves a hiring manager is an artifact that *shows* it — provider contracts, a RAG pipeline I built, eval numbers I can defend. The cost of not building it isn't zero; it compounds. Every month without the portfolio case is a month I'm pitching the pivot on assertion instead of evidence. So 'why now' is: the pivot is the forcing function, and the longer I wait, the weaker the pitch."

The "cost compounds" framing is the senior move here. A junior says "I had time." A senior names the *cost of not solving it* — and frames it as a compounding cost, not a one-time miss. (The full cost-of-doing-nothing argument is Chapter 3's `do nothing` option; here you just plant the flag.)

```
  WHY NOW — the cost of waiting compounds

  pitch strength
    │
  strong ┤                            ● with portfolio artifact
    │                          ╱
    │                    ╱
    │              ╱
  weak  ┤━━━━━━━━━━━━━━━━━━━━━━━━━━━●  assertion only, drifting down
    │   the pivot started here    every month without proof
    └──────────────────────────────────────────► time
          "I'm pivoting"      "here are the numbers"

  the gap between the two lines IS the cost of not building it
```

## Why you — the project composes what you already shipped

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Why are you the right person to build this — or       │
  │    why does this project make sense for you             │
  │    specifically?"                                       │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Is this a random project, or does it sit on top of    │
  │   real prior work? A project that composes your past    │
  │   shipped work is credible; a from-nothing project      │
  │   reads as a tutorial you followed.                     │
  └─────────────────────────────────────────────────────────┘

This is where you stop being "a frontend engineer who tried an AI project" and become "the engineer for whom this exact project is the obvious next move." The argument is *composition* — every package this agent needs, you've shipped a version of before:

```
  WHY YOU — the agent's packages map to your shipped work

  this agent needs…          you already shipped…
  ─────────────────────       ──────────────────────────────
  RAG / retrieval        ◄──  AdvntrCue (Next.js + pgvector +
                              GPT-4, classic RAG, shipped)
  on-device / local AI   ◄──  dryrun (Gemini Nano on-device),
                              contrl (MediaPipe real-time ML)
  local-first storage    ◄──  buffr (SQLite primary + Supabase
                              mirror), dryrun (GitHub-as-store)
  the skills / tooling   ◄──  aipe (markdown-as-source-of-truth,
                              prompt templates as code)
  a model of you         ◄──  me.md (hand-built profile, now a
                              row in agents.profiles)

  none of these is new to you. the project ties them
  into ONE case for the frontend+AI combination.
```

Said out loud:

> "I'm the right person for this because it composes work I've already shipped, not work I'm learning from scratch. I built classic RAG in AdvntrCue with pgvector and GPT-4. I built on-device AI in dryrun with Gemini Nano and real-time on-device ML in contrl with MediaPipe. I built local-first storage in buffr — SQLite primary, Supabase mirror — and markdown-as-source-of-truth tooling in aipe. And me.md is a model-of-me I hand-built before this project existed. This agent isn't a new skill. It's the project that *ties those five scattered things together* into one coherent case for the frontend-plus-AI combination I'm pivoting into. That's why it's the right project for me specifically — nobody else's portfolio composes exactly these pieces."

  ┃ "The strongest 'why me' isn't 'I'm smart.' It's
  ┃  'I already shipped every piece of this separately —
  ┃  this is the project that composes them.'"

## When you're cornered

  ╔═════════════════════════════════════════════════════════╗
  ║ IF THEY SAY                                              ║
  ║   "This sounds like a personal hobby. Where's the real   ║
  ║    user, the real problem?"                             ║
  ║                                                         ║
  ║ DON'T                                                    ║
  ║   Invent users. Don't claim "thousands of people need   ║
  ║   this." You have one user. Pretending otherwise is the ║
  ║   fastest way to lose the room.                         ║
  ║                                                         ║
  ║ DO                                                       ║
  ║   "There's one user — me — and that's deliberate. The   ║
  ║    real problem this solves isn't a market problem,     ║
  ║    it's a *proof* problem: I need defensible evidence    ║
  ║    that I can do AI engineering, and a self-hosted       ║
  ║    personal agent is the densest single artifact that   ║
  ║    exercises a provider contract, a RAG pipeline, a      ║
  ║    centralized schema, and measured evals all at once.   ║
  ║    The honesty about scope is the point — I built one    ║
  ║    good agent and measured it, instead of faking a       ║
  ║    platform with imaginary users."                      ║
  ╚═════════════════════════════════════════════════════════╝

The trap here is the temptation to inflate. Don't. The honest framing — *this is a portfolio case with one user and a real purpose* — is stronger than a fabricated market, because it's defensible under follow-up and a fabricated market isn't. The moment you claim users you don't have, the interviewer's next question dismantles you.

## The one-page version

**Core claim:** The problem is a self-hosted personal agent that centralizes the agent layer across your apps and knows you over time. *Why now*: you're at a deliberate frontend-to-AI pivot, and the portfolio artifact is the proof the pivot needs — the cost of not building it compounds every month. *Why you*: it composes five things you've already shipped (AdvntrCue RAG, dryrun/contrl on-device AI, buffr local-first, aipe tooling, me.md) into one coherent case.

**The questions, one-line answers:**
- "What is it?" → A Hermes-shaped self-hosted personal agent; centralizes the agent layer, holds a model of you, runs on your machine.
- "Why now?" → The pivot is the clock; without the artifact the pivot is assertion, and that cost compounds.
- "Why you?" → It composes my five shipped projects; nobody else's portfolio composes exactly these.
- "Isn't it a hobby?" → One user, deliberately. The problem is a *proof* problem, not a market problem, and I'm honest about that.

**The pull quote you keep:** *"The strongest 'why me' isn't 'I'm smart' — it's 'I already shipped every piece of this separately, and this is the project that composes them.'"*

→ Next: Chapter 2, the scope cuts. Once they accept the problem is real, they ask why you built so *little* of it. That restraint is its own signal.
