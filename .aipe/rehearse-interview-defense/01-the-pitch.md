# Chapter 1 — The Pitch

In the first ten minutes of every interview, someone asks you to tell them about a project.
This is where most candidates lose the room — not because the project is weak, but because
they ramble. They start at the database, detour into a config decision, and ninety seconds
later the interviewer still doesn't know what the thing *does*. This chapter is about
compression: three pitches, three lengths, each one ending before you've said too much.

You think visually and your ideas arrive fast — that's an advantage here. Lead with the
shape, not the stack. The interviewer needs the picture before the parts.

## The project at a glance

This is what you're compressing. Everything in the pitches below is a projection of this
one frame onto a smaller surface.

```
  buffr-laptop — what it is, in one picture

  ┌──────────────────────────────────────────────────────────────────┐
  │  WHAT          a self-hosted personal RAG agent                   │
  │  WHERE         entirely on my laptop — no cloud in the loop        │
  │  INTERFACE     `npm run chat` — an interactive terminal chat       │
  │                (Ink / React-in-terminal)                          │
  └──────────────────────────────────────────────────────────────────┘
           │ index my own markdown        │ ask a question
           ▼                              ▼
  ┌─ the two paths ──────────────────────────────────────────────────┐
  │  INDEX:  markdown → chunk → embed (768d) → Postgres + pgvector    │
  │  ASK:    question → embed → ANN search → ground → gemma2:9b answer│
  └──────────────────────────────────────────────────────────────────┘
           │ what's notable
           ▼
  ┌─ the three things worth saying ──────────────────────────────────┐
  │  1. answers ONLY from what it retrieved (grounded, cites sources) │
  │  2. remembers across sessions — episodic memory, retrieval-based  │
  │  3. consumes my own toolkit (`@aptkit/aptkit-core`) as a library  │
  └──────────────────────────────────────────────────────────────────┘
```

Hold that picture. The three pitches below are just this diagram read at three speeds.

### The 10-second version (the elevator)

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "So what have you been building?"                             │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you say what a thing IS in one breath, without a stack    │
│   tour? The 10-second pitch is a compression test. If you       │
│   can't do it short, the interviewer assumes you can't do it    │
│   clearly at any length.                                        │
└─────────────────────────────────────────────────────────────────┘
```

> "buffr is a personal RAG agent that runs entirely on my laptop. I index my own notes into
> Postgres, then chat with a local model that answers only from what it retrieved — no cloud,
> no API keys."

That's it. Stop there. The mistake is continuing — adding "and it uses pgvector with an HNSW
index and..." before they've asked. The 10-second pitch *invites* the follow-up; it doesn't
preempt it.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "It's a TypeScript app  │ "buffr is a personal    │
│ that uses Postgres and  │ RAG agent that runs     │
│ pgvector and Ollama and │ entirely on my laptop.  │
│ Ink for the UI and it   │ I index my own notes,   │
│ does retrieval-          │ then chat with a local  │
│ augmented generation    │ model that answers only │
│ with episodic memory    │ from what it            │
│ and..."                 │ retrieved."             │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ It's a stack list, not  │ Leads with what it IS   │
│ a description. The       │ and the one property    │
│ interviewer learns      │ that defines it         │
│ what you imported, not  │ (grounded, local). The  │
│ what you built or why.  │ stack comes later, when │
│ Nouns with no verb.     │ they ask.               │
└─────────────────────────┴─────────────────────────┘
```

> ▸ Lead with what the thing IS and the one property that defines it.
>   The stack is the answer to the *second* question, not the first.

### The 30-second version (the hallway)

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Tell me a bit more about it."                                │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you add a layer of depth without losing the thread?       │
│   The 30-second version adds the HOW and the WHY-it's-          │
│   interesting, but still in shape, not in stack detail.         │
└─────────────────────────────────────────────────────────────────┘
```

> "buffr is the laptop brain of a self-hosted personal RAG agent. I index my own markdown —
> notes, a profile — into Postgres with pgvector, and chat with it through an interactive
> terminal CLI. A local Gemma model answers, but only from what it retrieved from my own
> corpus, so answers stay grounded and cite their sources. The interesting part is that it
> remembers across sessions — past exchanges get embedded back into the same store, so a
> question next week can surface a relevant answer from today. And it consumes a toolkit I
> built and published separately, so buffr itself is a thin layer over a library I own."

Thirty seconds. Notice what's *not* in it: no HNSW, no 768 dimensions, no event types, no
schema. Those are bait for the deep dive. You drop them when asked, not before.

### The 90-second version (the real answer)

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Walk me through a project you're proud of."                  │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you sustain a structured narrative for 90 seconds         │
│   without rambling, and can you make the listener feel the      │
│   shape of the system before the details? This is the real      │
│   opener. Everything after it is follow-up.                     │
└─────────────────────────────────────────────────────────────────┘
```

The discipline here is a fixed arc: **what it is → the two paths → the one hard property →
where I drew my own boundary → what I'd be honest about.** Five beats, roughly fifteen
seconds each.

> "buffr is a self-hosted personal RAG agent — the laptop half of a two-brain idea, where the
> phone half is deferred. Everything runs locally: Ollama serves Gemma 2 9B for generation and
> nomic-embed-text for embeddings, and Postgres with the pgvector extension stores and searches
> them.
>
> There are two paths. Offline, I index my own markdown — it gets chunked, embedded into
> 768-dimension vectors, and upserted into Postgres. Online, every chat turn embeds the
> question, runs an approximate-nearest-neighbour search to pull the top matching chunks, and
> the model answers grounded in exactly those — citing them.
>
> The property I care about most is that it answers *only* from what it retrieved. It's not a
> chatbot with a knowledge base bolted on; retrieval is the substrate. And it remembers across
> sessions — I extract conversation memory through a separate package, embed past exchanges
> back into the same store, so they resurface through the same search tool.
>
> The boundary I'm proud of is that buffr consumes a toolkit I built — `aptkit` — as a versioned
> library, and never edits it. buffr owns about ten files: the Postgres adapter, the trace sink,
> the session. Everything else is the library.
>
> The thing I'd be honest about up front: the model is Gemma, which has no native tool-calling,
> so tool calls are emulated by parsing JSON out of the model's prose. That's the reliability
> ceiling of the whole system, and I can walk you through exactly why."

That last beat is a deliberate move. Volunteering the system's weakest seam at the end of your
pitch reads as senior — it tells the interviewer you know where the bodies are buried and
you're not hiding them. It also *steers* the follow-up toward territory you've rehearsed.

```
"Walk me through a project."
      │
      ▼
You give the 90-second arc, ending on the tool-call ceiling.
      │
      ├─► IF THEY ASK "why local / why not just use the OpenAI API?"
      │     "Two reasons: it's my own data — a personal knowledge
      │      base — so keeping it on-device matters; and I wanted to
      │      own the whole stack to learn it. Cost is a third: zero
      │      marginal cost per query."
      │
      ├─► IF THEY ASK "what's aptkit, and why separate it?"
      │     "It's the toolkit — model provider contract, the agent
      │      loop, the retrieval pipeline, evals. I extracted the
      │      reusable engine UP out of buffr so other apps can consume
      │      it. buffr injects the Postgres adapter DOWN into it. That
      │      round-trip is chapter-3 material — happy to go there."
      │
      └─► IF THEY ASK "you said it remembers — how?"
            "Retrieval-based episodic memory. After each turn I embed
             the exchange back into the SAME vector store, tagged as
             memory. Future questions surface it through the same
             search tool. No separate memory system — it rides the
             retrieval I already have."
```

## When they push past the pitch

The pitch is the one place you should *never* be pushed past your depth — it's your own
project, three sentences, rehearsed. But there's one trap: the interviewer who asks for a
number you don't have.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "How many documents have you indexed? What's ║
║   your retrieval latency? How many users?"               ║
║                                                           ║
║   buffr is a single-operator laptop project. There is no ║
║   user count. You have not benchmarked latency formally.  ║
║   Do NOT invent a number.                                 ║
║                                                           ║
║   Say:                                                    ║
║   "It's a single-operator project — me — so there's no    ║
║    user-scale number to give you. I haven't formally      ║
║    benchmarked retrieval latency; at my corpus size, in   ║
║    the low thousands of chunks, HNSW search is well       ║
║    under the model's generation time, so it's never been  ║
║    the bottleneck. If you want, I can walk through where  ║
║    it WOULD become one as the corpus grows."              ║
║                                                           ║
║   What this signals: you know the difference between a    ║
║   number you measured and a number you'd be guessing at,  ║
║   and you redirect to the scaling reasoning you DO own.   ║
║                                                           ║
║   Do NOT say:                                             ║
║   "Uh, probably a few hundred milliseconds? Maybe         ║
║    thousands of documents?" — inventing a metric you      ║
║    didn't measure is the fastest way to lose trust, and   ║
║    a good interviewer will chase the fake number until    ║
║    it breaks.                                             ║
╚═══════════════════════════════════════════════════════════╝
```

> ┃ Never invent a metric. "I didn't measure that, but here's the
> ┃ reasoning" beats a confident wrong number every time.

## What you'd change about the pitch

The honest reconsideration here isn't about the project — it's about the framing. Early on
you'd have pitched buffr as "a RAG chatbot," which undersells it and invites the "so it's a
ChatGPT wrapper?" dismissal. The stronger frame, which you'd reach for now, leads with
*self-hosted* and *grounded-only* — the two properties that actually distinguish it from a
hosted API call. If you were starting the pitch from scratch, you'd cut the word "chatbot"
entirely; it primes the wrong mental model.

## One-page summary

**Core claim:** The pitch is a compression test. Lead with what buffr *is* and the one
property that defines it — self-hosted, answers only from what it retrieved — and let the
stack come out under follow-up, not in the opener.

**Questions covered:**
- *"So what have you been building?"* → 10s: personal RAG agent, runs on my laptop, answers
  only from what it retrieved.
- *"Tell me more."* → 30s: add the two paths and the cross-session memory, still no stack
  detail.
- *"Walk me through it."* → 90s: five-beat arc — what it is → two paths → grounded-only →
  the aptkit boundary → end on the tool-call ceiling.
- *"How many users / what's your latency?"* → name it as a single-operator project, give no
  invented number, redirect to scaling reasoning.

**Pull quotes:**
- "Lead with what the thing IS and the one property that defines it. The stack is the answer
  to the *second* question."
- "Never invent a metric. 'I didn't measure that, but here's the reasoning' beats a confident
  wrong number every time."

**What you'd change:** Drop the word "chatbot" from the framing — lead with *self-hosted* and
*grounded-only*, the two properties that separate buffr from a hosted API call.
