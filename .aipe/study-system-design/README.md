# System Design — buffr-laptop

A per-repo system-design guide for **buffr-laptop**: a single-device personal RAG
agent that consumes `@rlynjb/aptkit-core@0.4.1` as a library and adds Postgres+pgvector
persistence plus an interactive chat CLI. The sole interface is `npm run chat`.

This guide teaches the architecture *actually present* in the repo — boundaries, flows,
state ownership, failure handling, and what breaks at scale — anchored to real
`file:line` evidence. It does not teach generic system-design theory, and it never
invents infrastructure the repo doesn't run.

## Reading order

```
  1.  00-overview.md   the whole system in one diagram — read this first
  2.  audit.md         Pass 1: the 8-lens architectural audit, honest gaps named
  3.  01-08            Pass 2: the patterns this repo actually exercises
```

Skim `00-overview.md` and you have the map. Read `audit.md` and you know which lenses
the repo exercises and which it leaves `not yet exercised`. The numbered files are the
deep walks of each load-bearing pattern.

## The patterns this repo exercises (Pass 2)

```
  01-vector-store-adapter.md          PgVectorStore implements aptkit's VectorStore
  02-library-as-dependency-boundary.md  aptkit consumed, never edited; the memory round-trip
  03-trajectory-capture.md            full-signal CapabilityEvent persistence
  04-long-lived-chat-session.md       warm pool, ONE conversation, agent built once
  05-profile-injection-as-context.md  me.md profile → system prompt
  06-retrieval-as-memory.md           episodic memory riding the chunks table
  07-deferred-body.md                 what's gated, and what won't have to change
```

The file list is itself a teaching artifact: a reader who has never opened the repo
learns what's architecturally interesting from these names alone.

## Cross-links — neighboring foundation guides

System design owns the architectural boundaries and tradeoffs. The mechanism-level
teaching belongs to the foundation generators. Where this guide names a mechanism, it
cross-links rather than re-teaching:

- **`study-database-systems`** — how pgvector's HNSW index executes the cosine query,
  what `<=>` does at the storage layer, transaction isolation on the `upsert` batch.
  This guide owns *why* Postgres is the store and what durability boundary it draws;
  the engine internals live there.
- **`study-data-modeling`** — the *shape* of the `agents` schema (the soft FK, the
  `meta jsonb`, the `app_id` tenancy column, chunk-id design). This guide owns where
  state lives and who owns each transition; the normalization and integrity analysis
  lives there.
- **`study-distributed-systems`** — correctness when the laptop and phone brains both
  go live and share one memory plane (the deferred sync/merge problem). This guide
  names the deferred boundary; the coordination mechanics live there.
- **`study-runtime-systems`** — how the warm pool, the sync `emit()` + async `flush()`
  trace sink, and the single-threaded chat session execute inside one Node process.
  This guide owns the session as an architectural boundary; the execution model lives
  there.
- **`study-ai-engineering`** / **`study-agent-architecture`** — the RAG retrieval
  pipeline, the agent loop, the eval harness (precision@k / recall@k), and tool-calling.
  This guide names the seams where buffr injects its adapters; the AI mechanics live
  there.
- **`study-dsa-foundations`** — vector similarity, ANN, cosine distance as algorithms.
  Not re-taught here.

## What this repo is, in one line

> A single off-the-shelf-Gemma RAG agent on aptkit's runtime, persisted to Postgres
> pgvector on one device, capturing every conversation as a full-signal trajectory —
> the laptop brain (v1b) of a deliberately-deferred two-brain body.
