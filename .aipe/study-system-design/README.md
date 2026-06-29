# Study — System Design · buffr-laptop

This guide turns **this repo** — `buffr-laptop`, a single-device personal RAG agent — into a
system-design study. It owns the architecture *actually present in the code*: where data,
state, and work live; how they move; where the boundaries are; and what changes at scale.

It does **not** re-teach foundation topics. Mechanism-level teaching is cross-linked to the
neighboring foundation guides (see the bottom of this file).

## What this repo is, in one sentence

A long-lived terminal chat agent (`npm run chat`) that runs **stock Gemma 2 locally**,
retrieves over **Postgres + pgvector**, and persists every conversation as a replayable
trajectory — built as the *body* on top of `@rlynjb/aptkit-core` (consumed as a library,
never edited here).

## Reading order

```
  1. 00-overview.md   ← start here. one diagram, the whole system, every box labelled.
  2. audit.md         ← the 8-lens system-design audit. what each lens found, or
                        `not yet exercised`. read it second to know the shape.
  3. 01..06           ← the discovered patterns. each is a full concept file —
                        zoom out → structure pass → how it works → interview defense.
```

## The discovered patterns (Pass 2)

Each file is named after a real architectural pattern this repo exercises. The file list
itself is the teaching artifact — a senior engineer skimming it should learn what buffr does
before opening anything.

```
  01-vector-store-adapter.md         ports & adapters — PgVectorStore behind aptkit's
                                     VectorStore contract; the drop-in seam.
  02-retrieval-pipeline.md           index path + query path; embed → store → search → rank.
  03-trajectory-capture.md           full-signal CapabilityEvent sink; every event a row.
  04-library-as-dependency-boundary.md  aptkit as a hard boundary + the memory round-trip
                                     (engine extracted UP, store injected DOWN).
  05-long-lived-chat-session.md      one warm pool, one conversation, agent built once.
  06-profile-injection-as-context.md me.md profile row → system prompt; "your" assistant.
```

## Where the seams are (one-line map)

```
  app code  ──contract──►  aptkit-core  ──adapter──►  buffr's PgVectorStore / TraceSink
  (chat.tsx)  (the boundary you  (run-agent-loop,   (the implementations buffr owns)
               never cross)       retrieval, memory)
                                       │
                                       ▼
                              Postgres + pgvector (reindb, schema `agents`)
```

## Cross-links to the foundation guides

System-design owns boundaries and tradeoffs. The mechanisms underneath are owned elsewhere:

- **`.aipe/study-database-systems/`** — how pgvector executes the cosine query, what HNSW
  does internally, transaction/durability mechanics of the `begin/commit` in `PgVectorStore.upsert`.
- **`.aipe/study-data-modeling/`** — the *shape* of the `agents` schema: the soft-link
  `document_id`, the `meta jsonb`, the memory-rides-on-chunks decision, normalization tradeoffs.
- **`.aipe/study-runtime-systems/`** — the Node event loop, the sync `emit()` / async `flush()`
  split in the trace sink, how the warm `pg.Pool` multiplexes connections.
- **`.aipe/study-networking/`** — the wire calls to Ollama (`/api/chat`, embeddings) and the
  pg TCP connection; timeouts, pooling, retries.
- **`.aipe/study-dsa-foundations/`** — ANN / vector search as an algorithm, cosine distance,
  the priority-queue substrate inside HNSW.

For the standard role-vocabulary of a pattern (port / adapter / client / factory / seam),
the canonical definitions live in `study-software-design` → PATTERN VOCABULARY. This guide
uses those terms and keeps buffr's local names in parens on first use.

## Cross-links to neighboring study guides

- **software-design** (ports & adapters / dependency inversion) — `01` and `04` both lean on
  it; the deep code-altitude treatment of the `VectorStore` port is there.
- **data-modeling** — the schema decisions behind `02` and `03`.
- **ai-engineering** — the RAG pipeline (`02`), evals (`precision@k`), the memory pattern.
- **agent-architecture** — the agent loop, tool-calling, the trajectory-capture thesis (`03`).
