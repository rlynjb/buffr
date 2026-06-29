# Interview Defense — buffr-laptop

> The project-level defense book. Eight chapters, read in order at
> least once. Coach voice throughout — I've sat on enough hiring
> committees to tell you what lands in the room and what gets you a
> "thanks, we'll be in touch." This book is about getting you through
> the wide opener ("walk me through what you built") and the follow-ups
> that come after it, days before you sit down for it.

You built a self-hosted personal RAG agent. One process, one Postgres,
one local model, on your own laptop. That's the whole shape, and the
honesty of that shape is your strongest card — you are not going to
pretend buffr is a distributed system, and you are not going to get
caught pretending. What you *are* going to do is own every decision in
it, name the cost you paid for each one, and volunteer the thing you'd
reconsider before the interviewer has to dig for it.

This book pairs with the comprehension guides already in `.aipe/`. The
study guides (`study-system-design/`, `study-ai-engineering/`,
`study-security/`, `study-agent-architecture/`,
`study-database-systems/`) prepare the *deep dive* — the moment an
interviewer drills into HNSW internals or the dropped FK. This book
prepares the *wide opener* — the first ten minutes where you set the
frame. Use both. Study the concept files for depth; rehearse this book
for performance.

---

## The system at a glance — the master diagram

This is the picture you re-anchor to every time the conversation drifts.
It recurs across the chapters. Memorize its shape.

```
  buffr-laptop — the whole system, one frame

  ┌─ TRUSTED: your laptop ────────────────────────────────────────────┐
  │                                                                    │
  │  ┌─ UI (Ink/React TUI) ─────┐   `npm run chat`                     │
  │  │ src/cli/chat.tsx         │   one long-lived conversation        │
  │  │  onSubmit(question)      │   held in-process                    │
  │  └───────────┬──────────────┘                                      │
  │              │ in-process call (no network, no auth hop)           │
  │  ┌─ Session ─▼──────────────┐                                      │
  │  │ src/session.ts ask()     │   warm pg pool, agent built once     │
  │  └───────────┬──────────────┘                                      │
  │              │                                                     │
  │  ┌─ aptkit agent loop (library, never edited) ────────────────────┐│
  │  │ RagQueryAgent.answer()   maxTurns 6, maxToolCalls 4            ││
  │  │   1 tool: search_knowledge_base (read-only allowlist)         ││
  │  │   Gemma decides: tool_call? → synthesize                      ││
  │  └───────────┬───────────────────────────────────────────────────┘│
  │              │ store.search / store.upsert / trace.emit            │
  │  ┌─ buffr adapters ─────────▼─────────────────────────────────────┐│
  │  │ PgVectorStore · SupabaseTraceSink · loadProfile               ││
  │  └───────────┬───────────────────────────────────────────────────┘│
  └──────────────┼─────────────────────────────────────────────────────┘
                 │ DATABASE_URL (full-priv)   │ localhost HTTP
        ┌────────▼─────────┐         ┌─────────▼──────────┐
        │ Postgres reindb  │         │ Ollama (local)     │
        │ schema `agents`  │         │ gemma2:9b (gen)    │
        │ pgvector HNSW    │         │ nomic-embed v1.5   │
        │ documents·chunks │         │   768-dim          │
        │ conversations    │         └────────────────────┘
        │ messages·profiles│
        └──────────────────┘
   chunks holds BOTH: documents AND memory (kind=memory) — one HNSW index
```

That diagram is the spine. Everything in this book hangs on it.

---

## The chapters

```
  the book — 8 chapters, build on each other

  01 — the pitch            first 60 seconds: 10s / 30s / 90s
  02 — the architecture     walk the diagram at a whiteboard in 90s
  03 — the choices          defend every load-bearing tech choice
  04 — the scale story      what breaks first at 10x / 100x
  05 — the failure story    what the system does when things break
  06 — the hard parts       hardest bug · proudest · least confident
  07 — the counterfactuals  what you'd redo starting today
  08 — the AI question      "did you use AI to build this?"
```

| Ch | Covers | The questions it arms you for |
| --- | --- | --- |
| 01 | The pitch | "Tell me about a project you built." |
| 02 | The architecture | "Walk me through the system." "Where does X live?" |
| 03 | The choices | "Why pgvector?" "Why local models?" "Why build this instead of using a tool?" "Why drop the FK?" |
| 04 | The scale story | "What breaks at 10x?" "How would you scale this to many users?" |
| 05 | The failure story | "What happens when Ollama is down?" "What if a write fails halfway?" |
| 06 | The hard parts | "Hardest bug?" "What are you proudest of?" "What part are you least sure about?" |
| 07 | The counterfactuals | "What would you do differently?" |
| 08 | The AI question | "Did you use AI for this?" "Explain this section line by line." |

---

## How to read this book

```
  three passes, three depths

  FIRST READ      one chapter per sitting, front to back, in order.
  ───────────     the prose is where the mechanism gets built.

  REVIEW          skim the chapter-opening diagrams, the side-by-sides,
  ───────         and the pull quotes. ~70% of the content lives in the
                  visual treatments.

  NIGHT-BEFORE    read ONLY the one-page summary at the end of each
  ────────────    chapter. eight pages, twelve hours out.
```

The visual treatments recur in every chapter so your eye learns where
to look:

- The **chapter-opening diagram** — the chapter's visual anchor.
- The **"WHAT THEY'RE REALLY ASKING" callout** (single-line box) —
  before every question, naming the probe under the surface form.
- The **weak / strong side-by-side** — the contrast does the teaching.
- The **"I don't know" recovery box** (double-line box) — the territory
  where you'd get pushed past your depth, and exactly what to say.
- The **follow-up decision tree** — where the conversation can branch.
- The **pull quote** (┃ bar) — the lines you carry into the room.

---

## The one thing to internalize before chapter 1

You are a senior frontend engineer — seven years, FedEx, Amazon,
CoreWeave — building AI-native projects. That is the posture. Not a
junior pretending to be senior. Not a distributed-systems generalist
who'll fold the moment someone asks about multi-region replication.
When the interview wanders into horizontal scale, Kafka, load
balancing under sustained traffic — that's not your portfolio yet, and
the strong move is to say so cleanly and pull the conversation back to
what you *did* ship: RAG, pgvector, local-first, a clean library
boundary, full-signal trajectory capture. The "I don't know" boxes in
this book are pinned to exactly those gaps.

```
  ┃ Own every decision in the system and the cost you paid
  ┃ for it. The honesty is the senior signal — not the
  ┃ size of the system.
```

Start with chapter 1.
