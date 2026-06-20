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
  │   npm run ask | index | eval | migrate  (one process per run)   │
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
  │ CLI: npm run ask                          │  → owns nothing, just calls
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
(`src/cli/ask-cmd.ts:20`): everything buffr controls is on the left of that
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

### Move 2 — walk the hops of one `npm run ask`

This is the busiest path; it touches both wires. Watch the order.

**Hop 1 — open the pg pool (lazy).** `createPool(cfg.databaseUrl)` constructs
the Pool object but opens *no* socket yet. node-postgres connects lazily on
first query. So "create the pool" is a no-op on the wire.

```
  Layers-and-hops — ask-cmd startup

  ┌─ CLI ─────────┐  hop A: build Pool (no socket)  ┌─ Service ────┐
  │ ask-cmd.ts    │ ─────────────────────────────► │ pg.Pool      │
  └───────────────┘                                 └──────┬───────┘
                                                           │ still cold
  ┌─ Provider ────┐  hop B: first query opens TCP  ◄───────┘
  │ Postgres :5432│ ─────────────────────────────────────────
  └───────────────┘  loadProfile() is the first real query
```

**Hop 2 — first query forces the TCP connect.** `loadProfile(pool, appId)`
(`src/cli/ask-cmd.ts:27`) runs `select content from agents.profiles ...`. *This*
is the moment the pool dials Postgres: DNS resolve the Supabase host → TCP
handshake → pg startup/auth → query. Everything in finding #1 of the overview
hangs on this hop.

**Hop 3 — embed the question over HTTP to Ollama.** The agent calls the
retrieval pipeline, which calls `OllamaEmbeddingProvider.embed()`, which (inside
aptkit) `fetch`es `POST http://localhost:11434/api/embed`. Loopback — the bytes
never leave the machine's network stack.

**Hop 4 — vector search back over the pg wire.** The 768-dim query vector goes
to `PgVectorStore.search()` → `pool.query(... order by embedding <=> $1 ...)`.
Same pool, same TCP connection (reused from hop 2), new query.

**Hop 5 — generate over HTTP to Ollama.** `GemmaModelProvider` `fetch`es
`POST /api/chat` with the prompt + retrieved chunks. Blocks until Ollama returns
the *entire* answer (no streaming — see `06`).

**Hop 6 — persist the trajectory over the pg wire.** `SupabaseTraceSink` queued
`persistMessage` calls; `trace.flush()` awaits them — more `insert`s on the same
pool.

**Hop 7 — `pool.end()`.** Closes the TCP connection(s). The HTTP "connections"
were per-`fetch` and already closed.

So one `ask` interleaves the two wires: **pg → http → pg → http → pg**. The DB
wire is hit three times on one connection; the HTTP wire is hit twice on two
separate fetches.

### Move 3 — the principle

A network map is the first artifact you draw for *any* system, because every
later question — where's the latency, where's the failure, where's the
attacker — is answered by pointing at an edge. buffr's map is small, but the
discipline is identical whether you have two edges or two hundred: name every
process, name every wire between them, mark the direction. The map you can't
draw is the system you don't understand.

## Primary diagram

The full recap — one `npm run ask`, every hop, both wires, in order.

```
  npm run ask -- "question"  — the full hop sequence

  ┌─ CLI: ask-cmd.ts ───────────────────────────────────────────────┐
  │ loadConfig → createPool → build providers → RagQueryAgent        │
  └───┬──────────────────────────────────────────────────────────────┘
      │ 2  select profile        ┌─ Postgres reindb :5432 (remote) ─┐
      ├──────────────────────────► agents.profiles                  │
      │                          └───────────────────────────────────┘
      │ 3  POST /api/embed        ┌─ Ollama :11434 (loopback) ──────┐
      ├──────────────────────────► nomic-embed-text → 768-dim       │
      │                          └───────────────────────────────────┘
      │ 4  select <=> search      ┌─ Postgres reindb :5432 ─────────┐
      ├──────────────────────────► agents.chunks (HNSW cosine)      │
      │                          └───────────────────────────────────┘
      │ 5  POST /api/chat         ┌─ Ollama :11434 ─────────────────┐
      ├──────────────────────────► gemma2:9b → full answer          │
      │                          └───────────────────────────────────┘
      │ 6  insert messages        ┌─ Postgres reindb :5432 ─────────┐
      ├──────────────────────────► agents.conversations/messages    │
      │                          └───────────────────────────────────┘
      │ 7  pool.end()  → close TCP
      ▼
   print answer, exit
```

## Implementation in codebase

**Use cases.** Every CLI is a different subset of this map. `migrate` touches
*only* the pg wire. `index` and `eval` touch pg + the embed HTTP wire but not
chat. `ask` is the only command that touches all of it.

**Code side by side.** The whole map is assembled in `ask-cmd.ts:19-26`:

```
  src/cli/ask-cmd.ts  (lines 19–26)

  const pool = createPool(cfg.databaseUrl);            ← pg wire endpoint
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
           swap either string and you've repointed the whole map.
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
latency and the TLS live; the LLM wire is loopback so it's fast and plaintext."
Anchor: `src/cli/ask-cmd.ts:27-35`.

**Q: Which wires does buffr actually own?**

Answer: "Only the pg one. `src/db.ts` constructs the `pg.Pool` directly. The
HTTP wire is owned by aptkit's provider transports — buffr hands them a host
string and never sees the `fetch`. That seam is `host: cfg.ollamaHost`." Anchor:
`src/config.ts:14`, `src/cli/ask-cmd.ts:20`.

## Validate

1. **Reconstruct:** draw the two-wire map from memory — name both ports.
2. **Explain:** why does "create the pool" open no socket? (lazy connect; first
   query in `loadProfile` forces it — `src/cli/ask-cmd.ts:27`.)
3. **Apply:** Ollama is down. Which hop fails and which hops already succeeded?
   (Hop 3 fails; hop 2's profile read already committed.)
4. **Defend:** why is it fine that buffr doesn't own the HTTP socket? (aptkit's
   provider contract is the seam; buffr's job is configuration, not transport —
   `src/cli/ask-cmd.ts:20,26`.)

## See also

- `02-dns-routing-and-addressing.md` — localhost vs the remote Supabase host.
- `03-tcp-udp-connections-and-sockets.md` — the pg TCP connection up close.
- `05-http-semantics-caching-and-cors.md` — the two POSTs inside the seam.
- `study-system-design` — where these boundaries *belong* in the architecture.
