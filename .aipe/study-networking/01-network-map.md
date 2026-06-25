# Network Map — every boundary buffr crosses

**The on-the-wire topology** · Project-specific

## Zoom out, then zoom in

Here's the whole thing. buffr is one Node process that you launch from a
terminal. It talks to exactly two things outside itself, and both calls go
*out* — buffr never accepts an inbound connection.

```
  Zoom out — buffr's place in the network

  ┌─ Provider layer (outside the process) ───────────────────────────┐
  │   Postgres reindb (Supabase)        Ollama (gemma2:9b, nomic)     │
  │      ▲  TCP :5432                       ▲  HTTP :11434            │
  └──────┼─────────────────────────────────┼───────────────────────┘
         │                                 │
  ┌─ Network boundary ──────────────────────────────────────────────┐
  │   pg wire protocol over TCP         HTTP/1.1 over TCP            │ ★ THIS FILE ★
  │   (remote, real internet)           (loopback, no NIC)          │
  └──────┼─────────────────────────────────┼───────────────────────┘
         │                                 │
  ┌─ Service layer (the repo) ──────────────────────────────────────┐
  │   src/db.ts createPool              aptkit provider transports   │
  │   src/pg-vector-store.ts            (host from src/config.ts)    │
  │   src/*-trace-sink / profile        repo passes `host` only      │
  └──────┼──────────────────────────────────────────────────────────┘
         │
  ┌─ Entry layer (the CLI) ─────────────────────────────────────────┐
  │   npm run chat (long-lived) | index | eval | migrate            │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a network map answers one question — *what bytes leave this process,
to whom, and in what order?* For buffr the answer is short enough to hold in
your head. Two destinations. Both client-initiated. One remote, one loopback.
That's the map. The rest of this file walks the order the hops fire.

## Structure pass

**Layers.** Four bands: the CLI entry, the repo's service code, the network
boundary, the external providers. The interesting contrast is *who owns the
socket* as you descend.

**Axis — trace "who owns the socket?" down the stack.**

```
  One question, held constant down the layers

  "who holds the socket?"  — trace it downward

  ┌──────────────────────────────────────────┐
  │ CLI: npm run chat (chat.tsx)              │  → owns nothing, just calls
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ service: createPool (src/db.ts)       │  → REPO owns the pg socket
      └──────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ service: GemmaModelProvider(host)     │  → APTKIT owns the HTTP socket;
      └──────────────────────────────────────┘     repo only handed it a string
          ┌──────────────────────────────────┐
          │ boundary: TCP / fetch             │  → the OS owns the file descriptor
          └──────────────────────────────────┘

  the answer flips between the two wires — that flip IS the lesson
```

**Seam.** The load-bearing seam is the one between buffr and aptkit on the
Ollama wire. On the Postgres wire there's no such seam — buffr holds the
`pg.Pool` directly. On the Ollama wire, the seam is `host: cfg.ollamaHost`
(`src/session.ts:40,46`): everything buffr controls is on the left of that
colon; the `fetch`, the headers, the status handling are all on the right,
inside aptkit. If you want to add a timeout to the LLM call, this seam is where
you'd reach — and right now nothing crosses it but a URL string.

## How it works

### Move 1 — the mental model

A network map is just a dependency graph where the edges happen to be sockets.
You already draw these when you sketch which component calls which API. Here
the "components" are processes and the edges are the two wires.

```
  The map's kernel — one node fans out to two

           ┌──────────────┐
           │  buffr CLI   │
           └───┬──────┬───┘
       pg/TCP  │      │  HTTP
        :5432  │      │  :11434
               ▼      ▼
        ┌──────────┐ ┌──────────┐
        │ Postgres │ │  Ollama  │
        │ (remote) │ │ (local)  │
        └──────────┘ └──────────┘

  no edges point INTO buffr. it is a leaf that calls two parents.
```

### Move 2 — walk the hops of one `npm run chat` turn

`chat` splits into two phases: a **once-per-session setup** (`createChatSession`,
`src/session.ts:34`) that builds the pool and providers exactly once, and a
**per-turn** `ask()` that fires every time you press enter. The wire walk below
is one `ask()` turn — but note the pool it rides was opened on the *first* turn
and stays warm for *all* of them. Watch the order; this path touches both wires.

**Setup (once) — build the pg pool (lazy).** `createPool(cfg.databaseUrl)`
(`src/session.ts:39`) constructs the Pool object but opens *no* socket yet.
node-postgres connects lazily on first query. So "create the session" is a no-op
on the wire; the providers (`src/session.ts:40,46`) are likewise just objects
holding a host string.

```
  Layers-and-hops — session setup then warm turns

  ┌─ CLI ─────────┐  build Pool (no socket)         ┌─ Service ────┐
  │ chat.tsx      │ ─────────────────────────────► │ pg.Pool      │
  └───────────────┘  createChatSession()            └──────┬───────┘
                                                           │ cold once
  ┌─ Provider ────┐  first query opens TCP, then   ◄───────┘
  │ Postgres :5432│  STAYS OPEN across every turn ──────────
  └───────────────┘  startConversation() is the first real query
```

**Hop 1 — first query forces the TCP connect (first turn only).**
`startConversation(pool, appId)` (`src/session.ts:55`) — then `persistMessage`
of the user turn (`src/session.ts:61`) — runs `insert ... returning id`. *This*
is the moment the pool dials Postgres: DNS resolve the Supabase host → TCP
handshake → pg startup/auth → query. On every *later* turn this connection is
already warm, so the handshake is skipped entirely — that's finding #1 of the
overview.

**Hop 2 — embed the question over HTTP to Ollama.** Inside `agent.answer()`
(`src/session.ts:62`) the retrieval pipeline calls `OllamaEmbeddingProvider.embed()`,
which (inside aptkit) `fetch`es `POST http://localhost:11434/api/embed`. Loopback
— the bytes never leave the machine's network stack.

**Hop 3 — vector search back over the pg wire.** The 768-dim query vector goes
to `PgVectorStore.search()` → `pool.query(... order by embedding <=> $1 ...)`.
Same pool, same warm TCP connection, new query.

**Hop 4 — generate over HTTP to Ollama.** `GemmaModelProvider` `fetch`es
`POST /api/chat` with the prompt + retrieved chunks. Blocks until Ollama returns
the *entire* answer (no streaming — see `06`).

**Hop 5 — persist the trajectory over the pg wire.** `trace.flush()`
(`src/session.ts:63`) awaits the queued `persistMessage` inserts; then the
best-effort `memory.remember()` (`src/session.ts:66`) embeds the exchange (one
more HTTP embed) and inserts the memory chunk — all on the same warm pool.

**Loop — back to the input prompt.** No `pool.end()` here. The turn returns, Ink
re-renders the input, and the *next* `ask()` reuses the same pool with no new
handshake. Only `/exit` (`src/cli/chat.tsx:19`) calls `session.close()` →
`pool.end()` (`src/session.ts:73`).

So one turn interleaves the two wires: **pg → http → pg → http → pg**. The DB
wire is hit several times on one *reused* connection; the HTTP wire is hit twice
(embed + chat, plus the memory embed) on separate fetches. Across a whole session
that's one TCP handshake amortized over dozens of turns.

### Move 3 — the principle

A network map is the first artifact you draw for *any* system, because every
later question — where's the latency, where's the failure, where's the
attacker — is answered by pointing at an edge. buffr's map is small, but the
discipline is identical whether you have two edges or two hundred: name every
process, name every wire between them, mark the direction. The map you can't
draw is the system you don't understand.

## Primary diagram

The full recap — one `npm run chat` turn, every hop, both wires, in order.
The pool is built once at session start and stays warm across every turn.

```
  npm run chat — one ask() turn over the warm session pool

  ┌─ session setup (once): createChatSession (src/session.ts:34) ────┐
  │ loadConfig → createPool → build providers → RagQueryAgent        │
  │ pool opened on turn 1, then REUSED for every turn below          │
  └───┬──────────────────────────────────────────────────────────────┘
      │ 1  insert conversation/   ┌─ Postgres reindb :5432 (remote) ─┐
      ├─── user message ──────────► agents.conversations/messages    │
      │                          └───────────────────────────────────┘
      │ 2  POST /api/embed        ┌─ Ollama :11434 (loopback) ──────┐
      ├──────────────────────────► nomic-embed-text → 768-dim       │
      │                          └───────────────────────────────────┘
      │ 3  select <=> search      ┌─ Postgres reindb :5432 ─────────┐
      ├──────────────────────────► agents.chunks (HNSW cosine)      │
      │                          └───────────────────────────────────┘
      │ 4  POST /api/chat         ┌─ Ollama :11434 ─────────────────┐
      ├──────────────────────────► gemma2:9b → full answer          │
      │                          └───────────────────────────────────┘
      │ 5  flush + memory.remember┌─ Postgres reindb :5432 ─────────┐
      ├──────────────────────────► agents.messages + memory chunk   │
      │                          └───────────────────────────────────┘
      ▼
   print answer → wait for next turn  (pool stays warm; /exit → pool.end())
```

## Implementation in codebase

**Use cases.** Every CLI is a different subset of this map. `migrate` touches
*only* the pg wire. `index` and `eval` touch pg + the embed HTTP wire but not
chat. `chat` is the only command that touches all of it — and the only one that
holds its pool open across many turns instead of opening and closing per run.

**Code side by side.** The whole map is assembled once in `createChatSession`,
`src/session.ts:39-46`:

```
  src/session.ts  (lines 39–46)

  const pool = createPool(cfg.databaseUrl);            ← pg wire endpoint (warm)
  const embedder = new OllamaEmbeddingProvider(        ← embed HTTP wire
    { model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
  const store = new PgVectorStore({ pool, ... });      ← rides the pg wire
  const pipeline = createRetrievalPipeline({ embedder, store });
  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: cfg.ollamaHost }),   ← chat HTTP wire
    { maxTokens: 8192 });
        │
        └─ both wires are configured here by VALUE: a connection string
           and a host string. that's buffr's entire network config surface.
           swap either string and you've repointed the whole map. built ONCE
           per session, then every ask() turn rides these same objects.
```

The `migrate` path is the minimal map — pg only:

```
  src/migrate.ts  (lines 27–30)

  const pool = createPool(cfg.databaseUrl);   ← only the pg wire exists here
  const sql = await readFile(...);            ← local disk, not network
  await runMigration(pool, sql);              ← one TCP round-trip set
  await pool.end();                           ← close it
```

## Elaborate

The map is small because the *deployment* is small: single device, single
process, single user. The context.md calls this "single-device" and "no Edge
Functions this phase." That phase choice is why there's no edge band, no LB, no
fan-out — the parent `agent-layer-plan.md` vision may add them, but the map you
audit is the map that exists. When buffr graduates to a server (an inbound HTTP
band appears), this file gets a third wire and the seam analysis changes:
suddenly buffr owns a *listening* socket, and CORS, auth, and request timeouts
(`05`, `07`) stop being "not yet exercised."

## Interview defense

**Q: Walk me through every network call in one user request.**

```
  pg(profile) → http(embed) → pg(search) → http(chat) → pg(persist)
       remote      local         remote       local        remote
```

Answer: "Five network round-trips across two wires. Three hit a remote Postgres
over the pg binary protocol on one reused TCP connection; two hit a local
Ollama over plain HTTP, one fetch each. The DB wire is remote so it's where the
latency and the TLS live; the LLM wire is loopback so it's fast and plaintext.
And in `chat` that DB connection is reused across the whole session, so only the
first turn pays the handshake." Anchor: `src/session.ts:55-66`.

**Q: Which wires does buffr actually own?**

Answer: "Only the pg one. `src/db.ts` constructs the `pg.Pool` directly. The
HTTP wire is owned by aptkit's provider transports — buffr hands them a host
string and never sees the `fetch`. That seam is `host: cfg.ollamaHost`." Anchor:
`src/config.ts:14`, `src/session.ts:40,46`.

## Validate

1. **Reconstruct:** draw the two-wire map from memory — name both ports.
2. **Explain:** why does "create the session" open no socket? (lazy connect; the
   first query in `startConversation` forces it — `src/session.ts:55`.)
3. **Apply:** Ollama is down. Which hop fails and which hops already succeeded?
   (Hop 2 embed fails; hop 1's conversation/user-message inserts already
   committed.)
4. **Defend:** why is it fine that buffr doesn't own the HTTP socket? (aptkit's
   provider contract is the seam; buffr's job is configuration, not transport —
   `src/session.ts:40,46`.)

## See also

- `02-dns-routing-and-addressing.md` — localhost vs the remote Supabase host.
- `03-tcp-udp-connections-and-sockets.md` — the pg TCP connection up close.
- `05-http-semantics-caching-and-cors.md` — the two POSTs inside the seam.
- `study-system-design` — where these boundaries *belong* in the architecture.

Updated: 2026-06-24 — Repointed the whole map off the deleted `ask-cmd.ts` onto `src/session.ts`: split Move 2 into once-per-session setup vs per-turn `ask()` hops, reframed the warm pool reused across many turns (only turn 1 pays the TCP handshake), rewired the seam/anchor cites to `src/session.ts:40,46` and `:55-66`, and added the best-effort `memory.remember()` embed hop.
