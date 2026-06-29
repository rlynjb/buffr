# Chapter 2 — The Architecture

After the pitch, the interviewer says "walk me through the
architecture" or hands you a marker and points at the whiteboard. This
chapter is about drawing buffr from scratch, in 90 seconds, without
stalling — and knowing exactly where they'll interrupt and what to say
when they do. The skill is not memorizing a diagram. It's being able to
*re-derive* it: start with the request, follow it through the layers,
and let each box appear because the request needed it.

You think visually first — this chapter plays to that. You're not
reciting an architecture; you're drawing one and narrating the data as
it moves.

## The architecture — the full diagram

This is the whiteboard you draw. Practice it until you can produce it
left-to-right without thinking, because the act of drawing it *is* the
walkthrough.

```
  buffr-laptop — the architecture you draw at the whiteboard

  UI LAYER                  SESSION LAYER           AGENT LAYER (aptkit)
  ┌────────────────┐        ┌──────────────────┐    ┌─────────────────────┐
  │ Ink/React TUI  │        │ createChatSession│    │ RagQueryAgent       │
  │ src/cli/       │ ask(q) │ src/session.ts   │    │  .answer(q)         │
  │   chat.tsx     │───────►│  warm pg Pool    │───►│  maxTurns 6         │
  │ onSubmit()     │◄───────│  1 conversation  │◄───│  maxToolCalls 4     │
  │ render turn    │ answer │  agent built once│    │  Gemma: tool? →     │
  └────────────────┘        └────────┬─────────┘    │    synthesize       │
                                     │              └──────────┬──────────┘
                          persist /  │  inject adapters down   │ store.search
                          flush /    │                         │ trace.emit
                          remember   ▼                         ▼
  ADAPTER LAYER (buffr)   ┌───────────────────────────────────────────────┐
                          │ PgVectorStore   SupabaseTraceSink   loadProfile│
                          │ src/pg-vector-  src/supabase-       src/       │
                          │   store.ts:19     trace-sink.ts:49    profile.ts│
                          └──────────────────────┬────────────────────────┘
                                                 │ pg.Pool · parameterized SQL
  STORAGE / PROVIDER       ┌──────────────────────▼───────────┐  ┌──────────┐
                          │ Postgres reindb / schema agents   │  │ Ollama   │
                          │  documents · chunks(+memory)      │  │ gemma2:9b│
                          │  conversations · messages         │  │ nomic-   │
                          │  profiles                         │  │  embed   │
                          │  HNSW vector_cosine_ops, 768-dim  │  │  768-dim │
                          └────────────────────────────────────┘  └──────────┘
```

The trick when you draw it: go top to bottom, one layer at a time, and
say what each layer *owns*. UI owns the ephemeral turn list. Session
owns the warm pool and the one conversation. Agent (aptkit's) owns the
loop. Adapters (buffr's) own the translation to Postgres. Storage owns
everything durable. Five layers, five ownership statements.

---

### Question 1 — "Walk me through what happens when you ask a question."

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Walk me through a request end-to-end. I type a question —   │
│    then what?"                                                  │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand your own request flow, or do you only      │
│   know the boxes? Can you name the ORDER of operations and     │
│   which ones are synchronous? A candidate who built the system │
│   can trace one request without hand-waving the middle.        │
└─────────────────────────────────────────────────────────────────┘
```

The request flow is a waterfall with one internal loop. It is *not* a
fan-out — nothing happens in parallel here, and that's worth saying
because it's a deliberate simplicity, not a missing optimization.

The strong answer, in my voice, traced against the real code:

> "I type a question in the Ink TUI and hit enter — that's `onSubmit` in
> `src/cli/chat.tsx`. It calls `session.ask(q)`. The session does four
> things in a fixed order. First, it persists my turn to the `messages`
> table. Second, it runs the agent — `agent.answer(q)`, which is
> aptkit's. Inside that, Gemma decides whether to call the search tool;
> if it does, the tool runs a cosine search over `agents.chunks` and
> hands the chunks back, and Gemma synthesizes an answer. Third, once I
> have the answer in hand, the session flushes the trace — every event
> the agent emitted, the tool call args, the tool results, token usage,
> all into `messages`. Fourth, best-effort, it remembers the exchange —
> embeds the question-and-answer pair and upserts it back into the same
> `chunks` table, tagged as memory. Then the answer renders in the TUI."

The order matters and you should say *why* it's that order
(`src/session.ts:60-71`): persist the user turn first so it's durable
before anything can fail; run the agent to completion; flush the trace
*after* the answer is in hand, not during; remember last and wrapped in
try/catch, because memory is a bonus and must never lose the answer.

```
  the four steps of a turn — fixed, synchronous order

  1. persistMessage(user)   ──► messages   (durable before risk)
  2. agent.answer(q)        ──► [Gemma loop: tool? → synthesize]
  3. trace.flush()          ──► messages×N  (after answer in hand)
  4. memory.remember(q,a)   ──► chunks(kind=memory)  [try/catch]
                                 ▲ best-effort: never lose the answer
```

```
  ┃ The order is the design. Persist first, answer, then
  ┃ flush, then remember — each step placed so a failure
  ┃ in a later one can't undo an earlier one.
```

#### The follow-up tree off the request walk

```
  You finish the four-step request walk.
        │
        ├─► IF THEY ASK "why flush the trace AFTER the answer,
        │   not during?"
        │     → So the answer is in hand before any trace write can
        │       fail. emit() is sync (aptkit's contract); I queue
        │       events and await them in flush() once the turn's done.
        │
        ├─► IF THEY ASK "is any of this parallel?"
        │     → No — it's a deliberate synchronous waterfall. One user,
        │       one turn at a time; there's nothing to fan out. The
        │       only loop is internal: Gemma deciding tool-call vs
        │       synthesize.
        │
        └─► IF THEY ASK "what's the conversation id for?"
              → It threads every message and trace event of a session
                to one conversation row, so the whole trajectory is
                replayable in emit order — created_at comes from the
                event timestamp, not the insert race.
```

---

### Question 2 — "Where does X live? Show me where the boundary is."

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Where's the line between your code and the library? What    │
│    did you write versus what did you import?"                   │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Can you locate the seam? Do you actually understand what you │
│   built versus what you wired together — or did the boundary   │
│   just happen and you can't point at it? This question         │
│   separates "I assembled parts" from "I designed the           │
│   boundary."                                                    │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "The line is the npm package. aptkit owns the contracts and the logic
> — the `VectorStore` interface, the `CapabilityTraceSink` interface, the
> agent loop, the retrieval pipeline, the memory engine. buffr imports
> all of that and never edits it. What buffr owns is the *implementations*
> — `PgVectorStore` implements the vector store contract against
> Postgres, `SupabaseTraceSink` implements the trace contract — plus
> everything deployment-specific: the schema, the pool, the secrets, the
> CLI. You can read the whole boundary in the import list at the top of
> `src/session.ts`: everything from `@rlynjb/aptkit-core` is the library,
> everything from `./` is mine."

That's a genuinely strong answer because you can point at one file
(`src/session.ts:1-11`) and the boundary is *visible* in the imports.
When you can locate a seam in a single screen of code, the interviewer
believes you designed it.

#### Weak vs strong — "where's the boundary"

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I used my own library for  │ "The boundary is the npm    │
│ the agent stuff and then    │ package. aptkit owns the    │
│ built the database part on  │ contracts and logic; buffr  │
│ top. It's pretty modular."  │ implements them against     │
│                             │ Postgres and never edits    │
│                             │ aptkit. You can read it in  │
│                             │ the imports of session.ts:  │
│                             │ aptkit-core is the library, │
│                             │ ./ is mine. The agent never │
│                             │ learns it's talking to      │
│                             │ pgvector."                  │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Pretty modular" is the     │ Names the seam (the package │
│ tell. It's a vibe, not a    │ line), names what's on each │
│ boundary. The interviewer   │ side, points at one file    │
│ can't tell if the           │ where it's visible, and     │
│ separation is real or       │ states the consequence (the │
│ aspirational. No file, no   │ agent is storage-agnostic). │
│ contract, no consequence    │ Concrete the whole way      │
│ named.                      │ down.                       │
└─────────────────────────────┴─────────────────────────────┘
```

---

### Where they'll interrupt — and what to say

A whiteboard walkthrough always gets interrupted. Here are the three
most likely interruptions and the one-liner for each.

```
  You're drawing the architecture.
        │
        ├─► THEY INTERRUPT: "Wait, why is the agent loop in a
        │   separate library?"
        │     → "Reuse. aptkit is consumed by other apps too. If I
        │       welded Postgres config into it, that kills the reuse.
        │       The dependency arrow points at the stable thing."
        │       (defer the deep version to chapter 3.)
        │
        ├─► THEY INTERRUPT: "Memory and documents are in the SAME
        │   table? Why?"
        │     → "So recall surfaces through the search tool I already
        │       built. A memory row is just a chunk tagged
        │       kind=memory. Cost: recall has to over-fetch and
        │       filter by kind in-process, because the VectorStore
        │       contract has no metadata filter."
        │
        └─► THEY INTERRUPT: "There's no API layer? It's just
            direct database calls?"
              → "Right — single process, direct pg, no HTTP
                indirection. The graduation spec called the HTTP API
                YAGNI for one device. The VectorStore contract is
                what makes adding an Edge-Function-backed store later
                a zero-agent-change move."
```

The point of pre-walking these: when the interrupt comes, you answer in
one sentence and keep drawing. You don't lose your place. That composure
is itself a signal.

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   On the architecture, the push usually goes: "What's the    ║
║   internal mechanics of the agent loop — how does it decide   ║
║   to call the tool?" That logic lives in aptkit's            ║
║   run-agent-loop, which YOU wrote — but the model's          ║
║   tool-call DECISION is Gemma's emulated reasoning, and the  ║
║   internals of how Gemma forms that are not yours to claim.  ║
║                                                               ║
║   Say:                                                        ║
║   "The loop itself I wrote — it's a bounded for-loop,        ║
║    maxTurns 6, and it forces a final synthesis once tool     ║
║    calls hit 4. What I DON'T control is how Gemma decides to  ║
║    emit a tool call, because Gemma has no native tool API —   ║
║    I render the tool schema into the system prompt and parse  ║
║    the JSON back out. So the decision is the model            ║
║    reasoning over a prompt, and the reliability of that is    ║
║    exactly the ceiling I measure. I can show you the parse    ║
║    path and the failure mode, but I won't pretend I know the  ║
║    model's internals."                                        ║
║                                                               ║
║   What this signals: you know precisely which parts are       ║
║   your engineering (the bounded loop, the parse) and which    ║
║   are the model's behavior you're working around. That        ║
║   distinction IS the senior AI-engineering signal.            ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "It uses the model's tool-calling to decide..." — Gemma     ║
║   doesn't HAVE native tool-calling here. Claiming it does is  ║
║   a factual error an AI interviewer catches instantly.        ║
╚═══════════════════════════════════════════════════════════════╝
```

```
  ┃ Name which parts are your engineering and which are the
  ┃ model's behavior you engineered around. The line between
  ┃ them is the whole AI-engineering craft.
```

---

### What you'd change about the architecture

If I were redrawing this today, the one structural thing I'd reconsider
is the trace flush model. Right now the trace sink queues writes and
awaits them all in one `Promise.all` at flush time
(`src/supabase-trace-sink.ts:91`) — which means if one insert fails, that
turn's trajectory is partially captured and there's no retry. Since the
trajectory is the *whole portfolio artifact* — the "capture everything now
so fine-tuning is answerable later" thesis — partial capture costs more
here than it looks. I'd make the flush more durable: either write events
inside the same transaction as the answer, or add a retry on the queued
inserts. It's not wrong for one local user, but it's the part of the
architecture where the failure mode undercuts the project's own goal.

---

## One-page summary — Chapter 2

**Core claim:** Re-derive the architecture from the request, not from
memory. Five layers, each with one ownership statement; the request is a
synchronous waterfall with one internal agent loop.

**The questions covered:**

- **"Walk me through a request"** — Four fixed steps:
  persist-user → agent.answer (Gemma loop) → flush trace → remember
  (best-effort). Order is the design (`src/session.ts:60-71`).
- **"Where's the boundary?"** — The npm package line. aptkit owns
  contracts + logic; buffr implements them; visible in `session.ts`
  imports. The agent never learns it's pgvector.
- **The interrupts** — separate library (reuse), shared memory table
  (recall through the existing tool), no API layer (YAGNI for one
  device).

**Pull quotes:**

```
  ┃ The order is the design. Persist first, answer, then flush,
  ┃ then remember.

  ┃ Name which parts are your engineering and which are the
  ┃ model's behavior you engineered around.
```

**The "I don't know":** On agent-loop internals — claim the bounded
loop (yours), disclaim Gemma's decision internals (the model's). Never
say Gemma has native tool-calling; it doesn't, you emulate it.

**What you'd change:** The trace flush — `Promise.all` over queued
inserts means partial trajectory capture on one failed insert, and the
trajectory is the portfolio artifact. Make it more durable.
