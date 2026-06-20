# The Database Systems Map

**Industry name(s):** datastore topology / persistence boundary map · **Type:** Language-agnostic

---

## Zoom out, then zoom in

Before any single mechanism, here's the whole storage stack buffr stands on. One Postgres process. One connection pool. A handful of tables, one of which holds a 768-dimensional vector column. That's the entire datastore.

```
  Zoom out — where the datastore sits in buffr

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  index-cmd · ask-cmd · eval-cmd  (src/cli/*.ts)             │
  └──────────────────────────┬──────────────────────────────────┘
                             │  function calls
  ┌─ Persistence layer ──────▼──────────────────────────────────┐
  │  PgVectorStore · indexDocumentRow · trace-sink · profile     │
  │  ★ THIS FILE: the map of how these reach Postgres ★          │ ← we are here
  └──────────────────────────┬──────────────────────────────────┘
                             │  pg.Pool → pooled TCP conn (localhost:5432)
  ┌─ Storage engine ─────────▼──────────────────────────────────┐
  │  Postgres 15+ · pgvector ext · schema agents · db reindb     │
  │  heap pages · WAL · MVCC · btree + HNSW indexes              │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: this file is the map, not the territory. It names the engine, the query paths in and out, and where durability begins and ends — so the rest of the guide has a skeleton to hang mechanisms on. The question it answers: *when buffr writes a chunk or searches for one, what path does that take and where does the data become safe?*

---

## The structure pass

Three layers — CLI, persistence, engine. Trace **one axis** across them: *who owns the data's durability at each level?*

```
  Axis = "who guarantees the bytes survive a crash?"  — traced downward

  ┌───────────────────────────────────────────────┐
  │ CLI layer: index-cmd issues a write            │  → owns NOTHING
  └───────────────────────────────────────────────┘     (fire a query, await)
      ┌─────────────────────────────────────────────┐
      │ Persistence: pool.query() / client BEGIN     │  → owns the TRANSACTION
      └─────────────────────────────────────────────┘     boundary (commit point)
          ┌─────────────────────────────────────────┐
          │ Engine: Postgres writes WAL, fsyncs      │  → owns DURABILITY
          └─────────────────────────────────────────┘     (the bytes are safe here)
```

The answer flips twice. The CLI owns nothing — it awaits a promise. The persistence layer owns *when* a write becomes a unit (a single statement, or a `BEGIN…COMMIT` batch). The engine owns whether the bytes survive a crash. **That second flip — from persistence to engine — is the seam this whole guide circles.** Durability is promised by Postgres at `COMMIT`, not by your code; your code only chooses what's inside the commit.

The load-bearing seam is the `pg.Pool` boundary: above it is TypeScript and promises, below it is SQL and pages. Every read and write in buffr crosses exactly that one seam.

---

## How it works

### Move 1 — the mental model

You know how a `fetch()` is your one chokepoint to a backend — every request, no matter which component fires it, goes through the same client? `pg.Pool` is that chokepoint for storage. Every CLI command builds one pool and threads it everywhere.

```
  The pattern — one pool, fanned out to every persistence call

         createPool(databaseUrl)
                  │
        ┌─────────┴──────────┬───────────────┬──────────────┐
        ▼                    ▼               ▼              ▼
   PgVectorStore       indexDocumentRow  startConversation loadProfile
   .upsert/.search     (documents row)   persistMessage   (read)
        │                    │               │              │
        └──────────┬─────────┴───────────────┴──────────────┘
                   ▼
        pool checks out an idle TCP connection,
        runs SQL, returns the connection to the pool
```

One strategy in one sentence: **share a bounded set of warm connections and rent one per query.** Opening a fresh TCP+TLS+auth connection per query would dominate the latency of a localhost RAG call; the pool amortizes that.

### Move 2 — the walkthrough

**The engine and extension.** Postgres is the storage engine; `pgvector` is a loaded extension (`create extension if not exists vector`) that adds one type (`vector`), three distance operators (`<->`, `<=>`, `<#>`), and the HNSW/IVFFlat index access methods. Bridge from what you know: it's like importing a library that adds both a new column type *and* new operators the planner understands. Without the extension, the `vector(768)` column on the chunks table fails to create — the whole schema migration aborts.

```
  What pgvector adds to vanilla Postgres

  vanilla Postgres        +  pgvector extension
  ────────────────           ────────────────────
  text, int, jsonb, uuid     vector(N)         ← the column type
  =, <, btree, gin           <-> <=> <#>       ← distance operators
  btree, hash, gin, gist     hnsw, ivfflat     ← ANN index methods
```

**The read path (search).** A question becomes an embedding (Ollama, outside Postgres), the embedding becomes a `[0.1,0.2,…]` text literal, and that literal rides into a single `SELECT` ordered by cosine distance with a `LIMIT k`. The engine walks the HNSW graph, returns k rows, and the persistence layer maps them back to citation shapes. One round trip, one connection, one statement.

```
  Read path — query in, top-k out

  ┌─ Persistence ─┐  hop 1: SELECT … ORDER BY embedding <=> $1 LIMIT k
  │ search(vec,k) │ ──────────────────────────────────────────────► ┌─ Engine ──┐
  │               │                                                  │ HNSW walk │
  │  k Hit rows   │ ◄────────────────────────────────────────────── │ + LIMIT   │
  └───────────────┘  hop 2: k rows {id, content, 1-distance score}  └───────────┘
```

**The write path (upsert).** Chunks arrive as a batch. The persistence layer checks out *one* connection, opens `BEGIN`, loops `INSERT … ON CONFLICT DO UPDATE` per chunk, then `COMMIT`. All chunks land atomically or none do. Bridge: it's the difference between `Promise.all([write, write, write])` (independent, partial-failure possible) and a single transaction (all-or-nothing). Here's where it breaks if you skip the transaction: a crash mid-batch leaves half a document indexed, and the retrieval index now lies.

**The durability edge.** When `COMMIT` returns, Postgres has written the change to the WAL and fsynced it (default `synchronous_commit=on`). *That* is the moment the data is safe against a process crash. Before `COMMIT` returns, nothing is guaranteed. This is the seam from the structure pass made concrete.

### Move 3 — the principle

A datastore map is three questions answered in order: *what engine, what paths in and out, where does data become durable.* Answer those and every other mechanism — indexes, isolation, recovery — slots into a layer you've already drawn. buffr's map is unusually small, which is the point: one process, one pool, one durable commit point.

---

## Primary diagram

The full recap — every layer, every path, the durability edge marked.

```
  buffr datastore — full map

  ┌─ CLI ───────────────────────────────────────────────────────────┐
  │  index-cmd          ask-cmd               eval-cmd               │
  └──────┬──────────────────┬─────────────────────┬──────────────────┘
         │ index            │ ask                 │ score
  ┌──────▼──────────────────▼─────────────────────▼─── Persistence ──┐
  │ indexDocumentRow    PgVectorStore          PgVectorStore         │
  │  + pipeline.index    .upsert (BEGIN/COMMIT) .search (1 SELECT)   │
  │  trace-sink.persistMessage   loadProfile                         │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  pg.Pool — rent a warm TCP conn
  ════════════════════════════ SEAM ════════════════════════════════
                             │  SQL (text protocol, $1 params)
  ┌─ Storage engine: Postgres 15+ / pgvector ───────────────────────┐
  │  agents.documents ─ heap ─ PK btree(id)                          │
  │  agents.chunks    ─ heap ─ PK btree(id)                          │
  │                     ├ HNSW(embedding vector_cosine_ops)          │
  │                     └ btree(app_id)                              │
  │  conversations / messages / profiles ─ heap + PK btree           │
  │  ─────────────────────────────────────────────                  │
  │  WAL + fsync at COMMIT  ◄── DURABILITY EDGE (data safe here)     │
  │  MVCC row versions · READ COMMITTED default · no replica         │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every CLI entry builds one pool and shares it. `ask-cmd.ts:19` does `const pool = createPool(cfg.databaseUrl)` then hands that *same* pool to `PgVectorStore`, `loadProfile`, `startConversation`, `persistMessage`, and the trace sink. The map is literally constructed in the first 33 lines of `ask-cmd.ts`.

```
  src/db.ts  (lines 4–6)  — the entire pool factory

  export function createPool(databaseUrl: string): pg.Pool {
    return new pg.Pool({ connectionString: databaseUrl });
  }
       │
       └─ ONLY a connection string. max (default 10), idleTimeoutMillis,
          statement_timeout — all driver defaults. This is the whole
          connection-config surface of the repo. Sizing the pool is
          "not yet exercised."
```

```
  src/cli/ask-cmd.ts  (lines 19–31)  — the map, constructed

  const pool = createPool(cfg.databaseUrl);          ← one pool…
  const store = new PgVectorStore({ pool, ... });    ← …shared to the store
  const profile = await loadProfile(pool, cfg.appId);← …and to profile reads
  const conversationId =
    await startConversation(pool, cfg.appId);        ← …and to trace writes
  const trace = new SupabaseTraceSink({ pool, ... });← …and to the sink
       │
       └─ every storage path in a single `ask` run crosses this one
          pool. The pool IS the seam. Drop it and you'd open a fresh
          TCP+auth handshake per query — fatal to localhost latency.
```

```
  sql/001_agents_schema.sql  (lines 1–2)  — the engine surface

  create extension if not exists vector;   ← adds vector type + <=> + hnsw
  create schema if not exists agents;      ← namespace for every table
       │
       └─ without line 1, `embedding vector(768)` on line 22 fails and the
          whole transactional migration rolls back. The extension IS the
          datastore's defining capability.
```

---

## Elaborate

The "one Postgres instance holds both relational rows and vectors" choice is the same shape as AdvntrCue in your portfolio (pgvector + Drizzle in one Postgres). The alternative — a dedicated vector DB (Pinecone, Qdrant) beside a relational DB — buys independent scaling at the cost of two systems to keep consistent and two round trips to join across. buffr colocates because it's single-device: there's nothing to scale independently, and colocation means a chunk and its source document are one `JOIN` away (when there's a key to join on — see the dropped-FK finding in `05`).

Where to read next: `02` drops below the pool seam into how a `vector(768)` row is physically stored on a page, and `04` walks how the planner turns the `search()` SELECT into an index walk.

---

## Interview defense

**Q: Walk me through every datastore in this system and where data becomes durable.**

One Postgres instance, pgvector extension, schema `agents`. Five tables; the only special one is `chunks` with a `vector(768)` column and an HNSW index. Every read/write goes through one `pg.Pool`. Data becomes durable when `COMMIT` returns — Postgres has WAL-written and fsynced by then under the default `synchronous_commit=on`.

```
  app → pg.Pool → Postgres → WAL fsync at COMMIT = durable
                              ▲
                  the durability edge — not before
```

Anchor: *"One process, one pool, one commit point — durability is Postgres's promise at COMMIT, not my code's."*

**Q: Why one Postgres for both vectors and relational data instead of a dedicated vector store?**

Single-device app — nothing to scale independently, so the operational cost of two systems buys nothing. Colocation keeps a chunk one join from its document and one connection pool to manage.

Anchor: *"Colocate until you have a scaling axis that splits them; buffr never does."*

---

## Validate

1. **Reconstruct:** Draw the three-layer map (CLI / persistence / engine) and mark the durability edge. Where is the one seam every query crosses?
2. **Explain:** Why does `createPool` (`src/db.ts:4-6`) taking only a connection string mean pool sizing is "not yet exercised"?
3. **Apply:** A new CLI command needs to read profiles *and* search chunks. How many pools should it build, and which existing line is the template? (See `ask-cmd.ts:19`.)
4. **Defend:** Someone proposes moving vectors to Pinecone "for scale." Given buffr is single-device, what do you tell them?

---

## See also

- `02-records-pages-and-storage-layout.md` — below the seam: how a vector row sits on a page
- `04-query-planning-and-execution.md` — how the search SELECT becomes an index walk
- `07-wal-durability-and-recovery.md` — the durability edge in detail
- `study-system-design` — which datastore and how it scales (the colocation decision)
- `study-networking` — the TCP/connection lifecycle below the pool seam
