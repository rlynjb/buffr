# Chapter 1 — The Pitch

In the first ten minutes of every interview, someone asks you to tell
them about a project you built. This is the question most candidates
fumble — not because they don't know their project, but because they
ramble. They start in the middle, backtrack, over-explain the parts
they're proud of, skip the part that actually answers the question, and
two minutes in the interviewer has stopped listening. This chapter is
about compressing buffr into three lengths — 10 seconds, 30 seconds, 90
seconds — so you can hit whichever one the room wants without padding.

The discipline here is harder than it looks. Compression is a skill.
You'll practice cutting buffr down to a sentence, then expanding it
exactly one level at a time, each level adding only what the previous
one earned the right to add.

## The pitch at a glance

The three pitches are nested. Each longer one is the shorter one plus
one more ring of detail — never a different story.

```
  the pitch — three nested rings

  ┌─ 90s: the full answer ──────────────────────────────────────────┐
  │  problem · shape · the interesting decision · the honest limit   │
  │                                                                  │
  │   ┌─ 30s: the hallway version ──────────────────────────────┐    │
  │   │  what it is · the one architectural choice that's        │    │
  │   │  worth naming                                            │    │
  │   │                                                          │    │
  │   │    ┌─ 10s: the elevator ───────────────────────────┐     │    │
  │   │    │  "a self-hosted personal RAG agent that runs   │     │    │
  │   │    │   entirely on my own laptop — local model,     │     │    │
  │   │    │   local Postgres, no cloud API."               │     │    │
  │   │    └────────────────────────────────────────────────┘     │    │
  │   └──────────────────────────────────────────────────────────┘    │
  └──────────────────────────────────────────────────────────────────┘

  expand ONE ring at a time. never start over, never jump rings.
```

Now let's build each ring, and look at how they go wrong.

---

### The 10-second pitch

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "So, what have you been building?" (in passing, in the hall, │
│    in the first thirty seconds before they've sat down)         │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you say what a thing IS in one breath? Do you have a      │
│   one-sentence handle on your own project, or do you need a     │
│   running start? A senior engineer can name the shape of a      │
│   system without warming up.                                    │
└─────────────────────────────────────────────────────────────────┘
```

The strong 10-second pitch, in my voice:

> "It's a self-hosted personal RAG agent — it answers questions over my
> own documents, and it runs entirely on my laptop. Local model through
> Ollama, local Postgres with pgvector for the embeddings. No cloud API
> in the loop."

That's it. Three facts: what it does (RAG over my docs), where it runs
(my laptop, fully local), what's underneath (Ollama + pgvector). The
"no cloud API" is the hook — it's the unusual part, and it invites the
natural follow-up ("why local?") which you *want*, because chapter 3
has that answer loaded.

```
  ┃ The 10-second pitch names the shape and plants one hook.
  ┃ It does not explain. Explaining is the 90-second job.
```

---

### The 30-second pitch

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Tell me a bit about it." (they've sat down, they want the   │
│    shape, not the deep dive yet)                                │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Can you go one level deeper without losing the thread? Do    │
│   you know which ONE architectural decision is worth           │
│   surfacing first — or do you list everything flat?            │
└─────────────────────────────────────────────────────────────────┘
```

The strong 30-second pitch:

> "It's a personal RAG agent that runs entirely on my laptop — I ask it
> questions in a terminal chat, it retrieves from my own indexed
> documents and answers with a local Gemma model. The piece I'm most
> deliberate about: it's built on a toolkit I wrote called aptkit, which
> owns all the contracts — the vector store, the model provider, the
> agent loop — and buffr just implements those contracts against
> Postgres. So the agent doesn't know it's talking to pgvector. It
> thinks it's talking to an interface. That boundary is what lets me
> swap the storage later without touching the agent."

Notice what this adds over the 10-second version: exactly one
architectural idea — the library boundary, the contract seam. Not the
trajectory capture, not the memory system, not the evals. One. The
30-second pitch earns the right to name *one* interesting decision, and
you pick the one that signals systems thinking (the
`VectorStore` contract, `src/pg-vector-store.ts:19`, implementing
aptkit's interface).

#### Weak vs strong — the 30-second version

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "It's a RAG app with a      │ "It runs entirely on my     │
│ chat interface, it uses     │ laptop. The piece I'm most  │
│ pgvector and Ollama and     │ deliberate about: it's      │
│ has conversation memory     │ built on contracts — the    │
│ and trajectory capture and  │ agent doesn't know it's     │
│ profile injection and       │ talking to pgvector, it     │
│ evals, and it's built on    │ thinks it's talking to an   │
│ my own toolkit, and..."     │ interface. That boundary    │
│                             │ lets me swap storage        │
│                             │ later."                     │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ It's a feature list read    │ Picks ONE decision and      │
│ at speed. Six things, all   │ names why it matters. The   │
│ flat, none ranked. The      │ interviewer now has a       │
│ interviewer can't tell      │ thread to pull, and it's a  │
│ what mattered. It signals   │ thread that flatters you.   │
│ "I built a lot" but not "I  │ Signals you know which of   │
│ made decisions."            │ your decisions is           │
│                             │ load-bearing.               │
└─────────────────────────────┴─────────────────────────────┘
```

The weak answer isn't wrong on facts. Every item in it is true. It
fails because it's flat — it presents trajectory capture, memory,
evals, and the toolkit boundary as co-equal, so the interviewer can't
tell what you actually thought hard about. A flat feature list reads as
"I followed a tutorial." A ranked answer reads as "I made calls."

---

### The 90-second pitch

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Tell me about a project you built." (the real one — this is │
│    the opener, and they'll let you run for a minute or two)     │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Can you structure a narrative under no constraints? Given    │
│   free rein, do you build a story with a problem, a shape, a   │
│   decision, and a limit — or do you wander? The lack of a      │
│   specific question is the test. Most candidates fill it with  │
│   noise.                                                        │
└─────────────────────────────────────────────────────────────────┘
```

The 90-second pitch has four beats, in order: **the problem**, **the
shape**, **the interesting decision**, **the honest limit**. That last
beat is the one most candidates skip, and it's the one that separates
senior from mid.

The strong 90-second pitch, in my voice:

> "So the problem I wanted to solve was: I have a lot of my own notes
> and documents, and I wanted to ask questions over them with an agent
> that's actually mine — runs on my hardware, doesn't send my data to a
> cloud API, and gets a little smarter the more I use it.
>
> The shape is a RAG agent. I index my documents into Postgres with
> pgvector, and when I ask a question in a terminal chat, a local Gemma
> model decides whether to call a search tool, retrieves the relevant
> chunks, and synthesizes an answer. Everything's local — Gemma and the
> embedding model both run through Ollama on my machine, and Postgres is
> local too.
>
> The decision I'm most deliberate about is the boundary. I wrote a
> toolkit, aptkit, that owns all the contracts — the vector store, the
> model provider, the agent loop, the trace sink. buffr is the running
> body: it implements those contracts against Postgres and Ollama, but
> it never edits the toolkit. The payoff is concrete — when I graduated
> from an in-memory store to pgvector, the agent loop and the retrieval
> pipeline didn't change one line, because they only ever spoke the
> `VectorStore` interface. And there's a nice round-trip: the
> conversation-memory engine was born in buffr, turned out to be
> general, so I extracted it *up* into the toolkit and now re-consume it
> as a dependency — and it works because that engine never names a
> database, it just takes the store as a parameter.
>
> The honest limit: it's single-device, single-user, single-process.
> One Postgres, one writer, no RLS, no horizontal scale. That's
> deliberate for the phase I'm in — but it's the first thing that would
> have to change the day a second client writes to that database."

That last paragraph is the move. You volunteered the limit. You didn't
wait to be asked. That signals you *know* where the system ends — which
is exactly what a senior interviewer is listening for.

```
  ┃ The 90-second pitch ends on the limit, not the highlight.
  ┃ Volunteering where the system stops is the senior move.
```

#### The follow-up tree off the 90-second pitch

Once you've given the 90, the interviewer picks a thread. Here's where
it goes and what to have ready.

```
  You give the 90-second pitch (ending on "single-device").
        │
        ├─► IF THEY PULL "why local / why no cloud API?"
        │     → chapter 3, the local-models choice. Lead with
        │       privacy + cost + it's a portfolio piece I wanted
        │       to own end-to-end. Name the cost: gemma2:9b is the
        │       reliability ceiling (no native tool calls).
        │
        ├─► IF THEY PULL "the toolkit boundary, tell me more"
        │     → chapter 3, build-vs-buy + library boundary. The
        │       memory extract-up round-trip is your best material
        │       here (src/session.ts:53).
        │
        ├─► IF THEY PULL "what would change for many users?"
        │     → chapter 4, the scale story. Lead with: app_id is
        │       shape-only, no RLS — that's the first thing that
        │       breaks at a second writer.
        │
        └─► IF THEY PULL "walk me through the architecture"
              → chapter 2. Re-draw the master diagram, request
                flow end-to-end, 90 seconds.
```

Every branch lands in a chapter you've rehearsed. That's the point of
the pitch — it's the menu, and every item on it is a dish you can cook.

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   The pitch invites "so how would this work for a thousand   ║
║   users?" — and that's distributed-systems-at-scale, which   ║
║   is genuinely not in your portfolio yet. Don't improvise a  ║
║   sharding strategy you've never built.                      ║
║                                                               ║
║   Say:                                                        ║
║   "Honestly, scaling this horizontally to many users is      ║
║    territory I haven't built in production. I can reason      ║
║    about where it would break first — the single stateful    ║
║    process, the unenforced app_id isolation — but I'd be      ║
║    guessing past that. What I HAVE shipped is the            ║
║    local-first, single-device version, and I made it         ║
║    deliberately to keep that boundary clean for later. Want  ║
║    me to walk the first two bottlenecks I'd expect?"          ║
║                                                               ║
║   What this signals: you know the edge of your own           ║
║   knowledge, you don't fake past it, and you redirect to     ║
║   real ground without sounding defensive. All three are      ║
║   senior signals.                                            ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "Oh, I'd just add a load balancer and shard the database   ║
║    and use Redis for caching and..." — listing infra you've  ║
║    never operated. The interviewer will ask one follow-up    ║
║    and you'll be exposed. Vague confidence in territory you  ║
║    don't own is the fastest way to fail a senior loop.       ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### What you'd change about the pitch itself

If I were re-cutting the pitch today, I'd lead the 90-second version
even harder on the *measured-evals* angle — the whole portfolio thesis
behind buffr is "capture trajectories and measure, don't just play with
an LLM" (`agent-layer-plan.md:30-33`). Right now my pitch leads with the
architecture boundary, which is the strongest *systems* signal, but for
an AI-engineering role specifically, "I wired offline precision@k evals
and I know exactly which eval I haven't built yet (faithfulness)" is the
sharper differentiator. I'd keep the boundary as the second beat and
promote the eval discipline. The current pitch isn't wrong — it's tuned
for a systems audience; I'd retune the opening beat to the role.

---

## One-page summary — Chapter 1

**Core claim:** Compress the project into three nested rings — 10s, 30s,
90s — and expand exactly one ring at a time. The 90-second version ends
on the honest limit, not the highlight.

**The three pitches:**

- **10s** — "Self-hosted personal RAG agent, runs entirely on my laptop:
  local Gemma, local Postgres + pgvector, no cloud API." *(names the
  shape, plants the "why local" hook.)*
- **30s** — Adds exactly one architectural idea: the contract boundary
  (`VectorStore` interface, the agent doesn't know it's pgvector).
- **90s** — Four beats: problem → shape → the toolkit-boundary decision
  (with the memory extract-up round-trip) → the honest limit
  (single-device, no RLS, the first thing to change at a second writer).

**Pull quotes:**

```
  ┃ The 10-second pitch names the shape and plants one hook.
  ┃ It does not explain.

  ┃ The 90-second pitch ends on the limit, not the highlight.
  ┃ Volunteering where the system stops is the senior move.
```

**The trap:** A flat feature list (RAG + memory + evals + trajectory +
toolkit, all co-equal) reads as "followed a tutorial." A ranked answer
that names ONE load-bearing decision reads as "made calls."

**The "I don't know":** When the pitch invites horizontal scale — name
where it breaks first (single stateful process, unenforced `app_id`),
say you haven't built scale in production, redirect to the local-first
version you *did* ship.

**What you'd change:** Retune the opening beat of the 90s pitch toward
the measured-evals thesis for an AI-engineering audience.
