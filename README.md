# buffr

Self-hosted personal RAG agent. Ask questions about yourself — your work, stack, preferences, notes — from a terminal chat interface. All data stays on your own Postgres + local Ollama.

## What it does

- Stores documents about you (work, stack, habits, notes) in a pgvector index
- Recalls relevant context each turn using semantic search
- Remembers past conversations — surfaces relevant exchanges from previous sessions
- Traces every agent run to the DB for inspection and improvement
- Runs evals against retrieval quality so you can measure improvements

## Stack

| Layer | Technology |
|-------|-----------|
| LLM | Ollama — Gemma 2 (`gemma2`) |
| Embeddings | Ollama — `nomic-embed-text:v1.5` |
| Vector store | Supabase Postgres + pgvector |
| Agent runtime | `@rlynjb/aptkit-core` |
| Chat TUI | OpenTUI (`@opentui/react`) — requires Bun |
| Language | TypeScript / Node.js (ESM) |

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 20
- [Bun](https://bun.sh) (for the chat TUI — `curl -fsSL https://bun.sh/install | bash`)
- [Ollama](https://ollama.com) running locally with `gemma2` and `nomic-embed-text:v1.5` pulled
- A Supabase (or plain Postgres) database with pgvector enabled

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/reindb
AGENT_APP_ID=laptop
AGENT_DB_SCHEMA=agents
OLLAMA_HOST=http://localhost:11434
```

**3. Run the schema migration**

```bash
npm run migrate
```

This creates the `agents` schema (documents, chunks, conversations, profiles) in your database.

**4. Pull Ollama models**

```bash
ollama pull gemma2
ollama pull nomic-embed-text:v1.5
```

**5. Index your documents**

```bash
npm run index -- eval/corpus/work.md eval/corpus/stack.md eval/corpus/coffee.md
```

Index any `.md` file. Each file becomes a retrievable document. The filename (without extension) is used as the document ID.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run chat` | Open the interactive chat TUI |
| `npm run index -- <file.md> [more.md...]` | Embed and store documents in the vector index |
| `npm run eval` | Score retrieval precision and recall against `eval/queries.json` |
| `npm run migrate` | Create or update the DB schema |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run test` | Run the test suite |

## Chat TUI

```bash
npm run chat
```

The TUI opens in your terminal. Type a question and press Enter. A spinner shows while the agent thinks. Type `/exit` or `/quit` to close.

```
buffr chat — one conversation, held in-process. Type /exit to quit.

> what do I do for work?

you
what do I do for work?

buffr
You work as a software engineer focused on AI agents and
retrieval-augmented generation. Your main project is aptkit,
a TypeScript toolkit for building agents.

> _
```

## Where it gets data

Every answer is assembled from three sources at query time:

```
Your question
     │
     ▼
 Ollama nomic-embed-text  ← embeds your question into a vector
     │
     ▼
 pgvector (Supabase)      ← searches for the closest chunks
     │
     ├── Document chunks  ← .md files you indexed with `npm run index`
     │                      (work.md, stack.md, notes, etc.)
     │
     └── Memory chunks    ← past Q&A pairs from previous sessions,
                             stored in the same vector table (kind=memory)
                             so relevant exchanges surface automatically
     │
     ▼
 Gemma 2 (Ollama)         ← generates the answer using retrieved chunks
                             + your profile (me.md from the DB)
     │
     ▼
 Your answer
```

**Documents** are anything you index with `npm run index`. Each file is chunked, embedded, and stored in `agents.chunks` in Postgres. The agent retrieves the top-4 most relevant chunks per turn.

**Memory** is written automatically after every turn — the question and answer are embedded and stored in the same vector table. Future turns can surface them via the same retrieval tool. You never manage this manually.

**Profile** (`agents.profiles`) is a free-form text field loaded fresh each turn and injected into the system prompt. If you have a `me.md` stored in the DB it shapes every answer — tone, context, priorities.

**Trace** — every agent run (steps, tool calls, token counts, timestamps) is written to `agents.messages` under a `conversations` row. Nothing is lost; you can inspect or replay any run from the DB.

## Questions you can ask

Questions work best when you've indexed documents covering the topic. The agent recalls relevant chunks by semantic similarity.

**About your work and projects**
- `what do I do for work?`
- `what is aptkit and what does it do?`
- `what am I currently building?`
- `what's my main project?`

**About your stack and tools**
- `what programming language do I use?`
- `what's my preferred database?`
- `how do I run local models?`
- `what model do I use for embeddings?`
- `what does my local dev setup look like?`

**About your preferences**
- `how do I take my coffee?`
- `what editor do I use?`
- `what are my preferred hours?`

**Connecting ideas across documents**
- `how does my stack relate to the project I'm building?`
- `what tools in my stack does aptkit use?`
- `summarize everything you know about me`

**From past conversations (memory)**
- `what did we talk about last time?`
- `what did I ask you about embeddings before?`
- `do you remember what I said about X?`

The agent has retrieval-based episodic memory — past exchanges are embedded into the same vector store and surface automatically when relevant.

## Indexing your own documents

Write plain `.md` files and index them:

```bash
npm run index -- my-notes/projects.md my-notes/goals.md
```

Tips for documents that retrieve well:
- One topic per file (work, stack, habits, goals, …)
- Write in first person: `I use...`, `My preference is...`
- Keep files focused — a 200-line grab-bag retrieves worse than five 40-line focused files

## Evals

```bash
npm run eval
```

Runs the queries in `eval/queries.json` against the index and prints `P@1` and `R@3` scores per query. Edit `eval/queries.json` to add your own test cases. Use this after re-indexing or changing the embedding model to confirm retrieval didn't regress.

Example output:

```
what does the author do for work          P@1 1.00  R@3 1.00
what programming stack and tools are used P@1 1.00  R@3 1.00
how does the author take their coffee     P@1 1.00  R@3 1.00

mean P@1 1.00  mean R@3 1.00
```

## Project structure

```
src/
  cli/
    chat.tsx          — OpenTUI chat TUI (bun runtime)
    index-cmd.ts      — indexes .md files into the vector store
    eval-cmd.ts       — scores retrieval precision and recall
  session.ts          — ChatSession: warm pool, agent, episodic memory
  config.ts           — env → Config
  db.ts               — pg Pool factory
  pg-vector-store.ts  — VectorStore implementation over Postgres + pgvector
  profile.ts          — loads your profile (me.md) from the DB
  runtime.ts          — document chunking and indexing
  supabase-trace-sink.ts — traces agent runs to the DB
eval/
  corpus/             — sample documents (work.md, stack.md, coffee.md)
  queries.json        — eval test cases
sql/
  001_agents_schema.sql — schema migration
```
