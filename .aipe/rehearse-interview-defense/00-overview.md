# Interview Defense — buffr-laptop

This is the book you read in the days before an interview where you'll be asked to walk
through buffr. Not the study guides — those teach you the system. This teaches you to
*perform* the system under pressure, at the project level, in ninety seconds, while
someone tries to find the edge of what you understand.

I've sat on a lot of hiring committees. I've watched strong engineers freeze on "tell me
about a project," and I've watched weaker ones hold a room because they'd rehearsed the
shape of the conversation. The difference is almost never depth of knowledge. It's whether
you've walked the branches before you're standing on them.

You built buffr with heavy AI assistance. So did everyone you're interviewing against. In
2026 that's not the question. The question is whether you understand what you shipped well
enough to own it — every choice, including the ones an AI tool suggested and you accepted.
That posture runs through all eight chapters and gets its own chapter at the end.

## The system at a glance — the picture you carry in

This is the master diagram. Every chapter zooms into one band of it. When you lose your
place in an interview, this is the picture you re-draw on the whiteboard to re-anchor.

```
  buffr-laptop — a self-hosted personal RAG agent, single device, one user

  ┌─ UI layer ────────────────────────────────────────────────────────────┐
  │  the terminal frontend (`src/cli/chat.tsx`) — Ink / React-in-terminal  │
  │    one input box · a scrollback of turns · a "thinking…" spinner       │
  └───────────────────────────────┬────────────────────────────────────────┘
                                  │  session.ask(question)  — in-process call
                                  ▼
  ┌─ Session layer (buffr owns) ───────────────────────────────────────────┐
  │  createChatSession (`src/session.ts`)                                   │
  │    • ONE warm connection pool   • ONE conversation held across turns    │
  │    • agent built ONCE           • per turn: persist → answer → remember │
  └───────┬─────────────────┬───────────────────┬──────────────────────────┘
          │ builds once     │ run per turn      │ remember per turn
          ▼                 ▼                   ▼
  ┌─ aptkit-core (the library — consumed, never edited here) ──────────────┐
  │  the agent (`RagQueryAgent`) — a ReAct loop, ONE read-only tool        │
  │    the model provider (`GemmaModelProvider`) → Ollama gemma2:9b        │
  │    guarded by the context-window guard (8192-token cap)               │
  │    the retrieval pipeline → embeddings via nomic-embed-text:v1.5 (768d)│
  │    the episodic-memory engine (`@aptkit/memory`)                       │
  └───────┬────────────────────────────────────┬──────────────┬───────────┘
          │ the store port (`VectorStore`)      │ trace port   │ same store
          ▼                                     ▼              ▼
  ┌─ Adapter layer (buffr owns) ───────────────────────────────────────────┐
  │  the adapter (`PgVectorStore`)        the trace sink (`SupabaseTrace-   │
  │   implements `VectorStore`            Sink`) — all 6 CapabilityEvent    │
  │   cosine search over pgvector         types → agents.messages           │
  └───────────────────────────────┬────────────────────────────────────────┘
                                  │  node-postgres, direct TCP — no HTTP layer
                                  ▼
  ┌─ Storage layer (Postgres `reindb`, schema `agents`) ───────────────────┐
  │  documents · chunks (vector(768), HNSW cosine index) · conversations   │
  │  messages (full trajectory) · profiles                                 │
  │  ↑ episodic memory ALSO rides the chunks table (meta.kind='memory')    │
  └────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  HTTP (localhost:11434)
  ┌─ Provider layer (Ollama, local box) ───────────────────────────────────┐
  │  gemma2:9b — generation        nomic-embed-text:v1.5 — embeddings 768d  │
  └────────────────────────────────────────────────────────────────────────┘
```

The one line on that diagram that matters most is the seam between aptkit and buffr — the
store port (the `VectorStore` contract). buffr is a thin body wrapped around a thick
library. You own roughly ten files; the library owns the agent loop. Know which side of
that line every claim sits on, and most follow-ups answer themselves.

## The eight chapters

```
  01  the pitch ............. the first 60 seconds, in three lengths
  02  the architecture ...... walk me through the system (whiteboard, 90s)
  03  the choices ........... why this stack — one section per load-bearing choice
  04  the scale story ....... what breaks first at 10x users / 100x data
  05  the failure story ..... LLM down, DB read-only, malformed tool call
  06  the hard parts ........ hardest bug, proudest part, weakest spot
  07  the counterfactuals ... what you'd do differently, volunteered
  08  the AI question ....... did you use AI to build this? (2026 table stakes)
```

| Chapter | The question it arms you for | The pull quote you carry |
|---|---|---|
| 01 | "Tell me about a project you built." | "buffr answers only from what it retrieved, runs entirely on my laptop, and I own every file outside the library." |
| 02 | "Walk me through the architecture." | "Thin body, thick library. The seam is the port." |
| 03 | "Why pgvector / Ollama / Postgres / Ink?" | "I optimized for operational simplicity and owning the whole stack." |
| 04 | "What breaks first at 10x?" | "The reliability ceiling is the emulated tool call, not the database." |
| 05 | "What happens when the model is down?" | "One read-only tool, capped turns, best-effort memory — small blast radius by design." |
| 06 | "What's the part you're least sure of?" | "Faithfulness is unmeasured. I score retrieval, not whether the answer is grounded." |
| 07 | "What would you redo?" | "I'd wire the faithfulness judge before I'd add a single feature." |
| 08 | "Can you explain this line by line?" | "I can. Here's what AI suggested, what I evaluated, and what I'd revisit." |

## How to use this book

**First read** — chapters in order, one per sitting. They build. Chapter 2 assumes you
can pitch (chapter 1); chapter 4 assumes you can draw the architecture (chapter 2).

**Review pass** — skim the chapter-opening diagrams and the pull quotes. The six visual
treatments (opening diagram, "what they're really asking" callout, strong/weak
side-by-side, the double-bordered "I don't know" box, the follow-up decision tree, the
pull quote) carry roughly 70% of the book.

**Night before** — read only the one-page summary at the end of each chapter. Eight pages,
twenty minutes. Then re-draw the master diagram above from memory once.

## Where this sits in the study system

This book is the *wide opener* — the whole project at the whiteboard. The *deep dive* lives
in the concept files under `.aipe/study-system-design/`, `.aipe/study-ai-engineering/`,
`.aipe/study-agent-architecture/`, `.aipe/study-database-systems/`, and
`.aipe/study-security/`. Each of those has its own per-concept Interview defense block for
the moment an interviewer drills into one pattern. Pair them: this book gets you through the
first ten minutes; the concept files get you through the drill-down.

The book grounds every defense in real files. Every path, every line number, every library
version here matches the repo. If a defense can't point at code, it's not in this book.
