# Network Map

**Industry name(s):** network topology / connection graph / system
boundary map. **Type:** Language-agnostic.

## Zoom out, then zoom in

Here's the whole thing on one screen. `buffr-laptop` is a single Node
process that opens exactly two outbound connections and accepts zero
inbound ones. Find the boxes that cross a line — those lines are the only
networking that exists in this repo.

```
  Zoom out — where the network boundaries live

  ┌─ UI layer (in-process, NO network) ──────────────────────┐
  │  src/cli/chat.tsx  Ink TUI  →  session.ask(q)             │
  └─────────────────────────────┬─────────────────────────────┘
                                │  function call, same process
  ┌─ Orchestration (in-process) ▼─────────────────────────────┐
  │  src/session.ts  RagQueryAgent · pipeline · memory        │
  │      ★ owns the two clients, holds them across turns ★    │ ← we are here
  └──────┬───────────────────────────────────┬────────────────┘
         │ ★ NETWORK BOUNDARY 1 ★             │ ★ NETWORK BOUNDARY 2 ★
         │ pg wire / TCP 5432                 │ HTTP / TCP 11434
  ┌─ Storage provider ▼───────┐      ┌─ Model provider ▼───────┐
  │  Postgres (reindb)        │      │  Ollama daemon          │
  │  schema agents, pgvector  │      │  gemma2 + nomic-embed   │
  └───────────────────────────┘      └─────────────────────────┘

  inbound boundary: NONE. nothing in this repo calls listen().
```

Zoom in. The concept here is the **network map**: the complete inventory
of every point where bytes leave or enter the process, and what protocol
rides each one. Get this map right and every later file is just zooming
into one box on it. Get it wrong — imagine a stray inbound server you
forgot — and you'll reason about CORS or request auth that doesn't exist.

## Structure pass

Three layers, one axis, two seams.

**Layers.** UI (Ink terminal) → orchestration (`session.ts`) → two
providers (Postgres, Ollama). The top two layers share one OS process;
the providers are separate processes reached over TCP.

**Axis — trust / "does this byte cross a process boundary?"** Hold that
one question down the stack:

```
  axis: "does this hop cross a process boundary?"

  ┌─ chat.tsx → session.ask() ───┐   → NO  (same process, function call)
  └──────────────────────────────┘
  ┌─ session → pg.Pool query ────┐   → YES (TCP to Postgres :5432)
  └──────────────────────────────┘
  ┌─ session → Ollama provider ──┐   → YES (TCP to Ollama :11434)
  └──────────────────────────────┘

  the answer flips exactly twice — those two flips ARE the network
```

**Seams.** The boundary flips from "in-process" to "on-the-wire" in
exactly two places, and both are *vertical seams to a provider*: the
`pg.Pool` handed to `PgVectorStore` / trace sink / memory, and the
`ollamaHost` string handed to aptkit's Ollama providers. Every networking
concern in this repo lives behind one of those two seams. There is no
third.

## How it works

### Move 1 — the mental model

You already know the shape: it's a `fetch()` in a frontend app. Your
React component doesn't *contain* the network — it calls `fetch(url)` and
the runtime owns DNS, TCP, TLS, HTTP. buffr is the same, twice over.
`session.ts` is the "component"; the pool and the Ollama providers are its
two `fetch`-equivalents. The map is just: which calls are local function
calls, and which two punch out to a socket.

```
  The map as a frontier — local calls vs wire calls

   start: chat.tsx onSubmit
     │ local
     ▼
   session.ask(question)
     ├──── local ───► persistMessage ──┐
     ├──── local ───► agent.answer ─────┤
     │                                  │   each of these eventually
     └──── local ───► memory.remember ──┘   bottoms out at ONE of two
                                            wire calls:
       wire call A: pool.query  ──TCP 5432──►  Postgres
       wire call B: provider.*  ──TCP 11434─►  Ollama
```

### Move 2 — walk the boundaries

**Boundary 0: the UI hop that isn't a hop.** `chat.tsx` is React running
in the terminal via Ink. When the user submits, `onSubmit` calls
`session.ask(q)` directly — `src/cli/chat.tsx:28`. No serialization, no
socket, no port. This matters because in a web app this same arrow *would*
be a network hop (browser → API), and a reader carrying web instincts will
look for request auth and CORS here. There's nothing to secure because
nothing crosses.

```
  Boundary 0 — UI to orchestration, in-process

  ┌─ Ink TUI ───────────┐   onSubmit(q): function call   ┌─ session ──┐
  │ chat.tsx:28         │ ──────────────────────────────►│ ask(q)     │
  │ const answer =      │ ◄──────────────────────────────│ returns    │
  │   await session.ask │   resolved Promise<string>     │ string     │
  └─────────────────────┘   (no bytes on any wire)        └────────────┘
```

`src/cli/chat.tsx:62-63` constructs the session and renders the UI in the
same module — one process, top to bottom.

**Boundary 1: orchestration → Postgres, TCP 5432.** `session.ts:39`
builds the pool: `const pool = createPool(cfg.databaseUrl)`. That single
pool is then injected into three consumers — `PgVectorStore`
(`session.ts:41`), the memory engine via the same store (`session.ts:53`),
and the trace sink + `persistMessage` (`session.ts:55-61`). Every one of
them ultimately calls `pool.query(...)` or `pool.connect()`, which is
where bytes hit the pg wire protocol on TCP 5432. The exact line where a
query becomes wire traffic: `src/pg-vector-store.ts` `search()` →
`this.pool.query(...)`.

```
  Boundary 1 — one pool, three consumers, one wire

  ┌─ session.ts ─────────────────────────────────────────────┐
  │  pool = createPool(cfg.databaseUrl)   (line 39)           │
  │     ├─► PgVectorStore   (upsert / search)                 │
  │     ├─► createConversationMemory (shares the store)       │
  │     └─► SupabaseTraceSink + persistMessage                │
  └───────────────────────────────┬───────────────────────────┘
                                  │  pg wire protocol
                                  ▼  TCP 5432
                          ┌─ Postgres reindb ─┐
                          │  schema agents     │
                          └────────────────────┘
```

What's *inside* Postgres — the HNSW index, the `<=>` cosine operator, the
transaction in `upsert()` — belongs to `study-database-systems`. This file
stops at the wire.

**Boundary 2: orchestration → Ollama, TCP 11434.** `session.ts:40` and
`:46` construct the two providers with `host: cfg.ollamaHost`. buffr hands
over a host string and nothing more. The actual HTTP request to
`/api/embeddings` or `/api/generate`, the JSON body, the response parsing —
all of it lives in aptkit's `OllamaEmbeddingProvider` and
`GemmaModelProvider`. buffr's entire contribution to boundary 2 is the
string `http://localhost:11434` from `config.ts:14`.

```
  Boundary 2 — orchestration to Ollama, HTTP over loopback

  ┌─ session.ts ──────────────────────┐
  │ new OllamaEmbeddingProvider(       │
  │   { host: cfg.ollamaHost })  :40   │
  │ new GemmaModelProvider(            │
  │   { host: cfg.ollamaHost })  :46   │
  └───────────────┬────────────────────┘
                  │  aptkit owns the fetch()
                  ▼  HTTP POST, TCP 11434
          ┌─ Ollama daemon ─┐
          │ gemma2:9b        │
          │ nomic-embed      │
          └──────────────────┘
```

**Boundary 3: inbound — there isn't one.** Search the repo: nothing calls
`http.createServer`, `net.createServer`, `app.listen`, or opens a socket
for reading. The Ink app reads stdin and writes stdout — terminal I/O, not
network I/O. So the entire inbound half of networking (accepting
connections, request routing, CORS, listen-port security) is `not yet
exercised`. That's not a gap to apologize for; it's a deliberate
local-first shape (see `me.md`'s buffr entry: SQLite/Postgres primary,
single-device).

### Move 3 — the principle

A network map is worth drawing before you reason about any single
protocol, because **the map tells you which concerns are even in scope.**
buffr has no inbound boundary, so half the networking syllabus is
out-of-scope by construction — and you only know that for sure once
you've drawn the map and found zero `listen()` calls.

## Primary diagram

The full map, every box and every hop labelled.

```
  buffr-laptop — complete network map

  ┌─ Process: node dist/src/cli/chat.js ───────────────────────┐
  │                                                            │
  │  ┌─ UI ───────────┐  onSubmit()    ┌─ Orchestration ─────┐ │
  │  │ chat.tsx       │ ─────────────► │ session.ts          │ │
  │  │ Ink + stdin    │ ◄───────────── │  createChatSession  │ │
  │  └────────────────┘  Promise<str>  │  · pool (db.ts)     │ │
  │       ▲                            │  · Ollama providers │ │
  │       │ terminal I/O               └──────┬──────┬───────┘ │
  │       │ (stdout)                          │      │         │
  └───────┼──────────────────────────────────┼──────┼─────────┘
          │ NOT network              boundary1│      │boundary2
          ▼                          pg/TCP   │      │HTTP/TCP
        user                          5432    ▼      ▼ 11434
                                  ┌─ Postgres ─┐ ┌─ Ollama ──┐
                                  │ reindb     │ │ gemma2    │
                                  │ pgvector   │ │ nomic-emb │
                                  └────────────┘ └───────────┘

  inbound: none · proxies: none · the two TCP lines are the whole network
```

## Elaborate

This shape — a fat local process talking to a couple of backing services
over direct TCP — is the canonical *local-first client*. It predates the
web-app reflex of "everything is an HTTP request to my own API." Among
your five system shapes (`me.md`), this is closest to AdvntrCue's
Postgres-colocated design, except AdvntrCue *also* runs a serverless
inbound API, and buffr deliberately doesn't. Drop the inbound server and
you drop CORS, request auth, and rate limiting from the design — that
deletion is the architecture, not an omission.

## Interview defense

**Q: "Walk me through every network boundary in this app."**

> Two outbound, zero inbound. One Node process: the Ink UI calls the
> session in-process — no network there. The session holds one pg.Pool
> reaching Postgres over the pg wire protocol on TCP 5432, and two Ollama
> providers reaching the local model daemon over HTTP on TCP 11434.
> Nothing listens, so there's no inbound boundary at all.

```
  in-process  │  TCP 5432 (pg wire)  │  TCP 11434 (HTTP)
  UI→session  │  session→Postgres    │  session→Ollama
              │                       │
        the two flips = the whole network; inbound = ∅
```

Anchor: *"Two outbound connections, zero inbound — `session.ts:39-46`
holds both clients."*

**Q: "What's the load-bearing part people forget here?"**

> That the UI→session arrow is *not* a hop. In a web app it would be, and
> you'd reason about auth and CORS on it. Here it's a function call, so
> those concerns don't exist. Forgetting that makes you secure a boundary
> that isn't there and miss that the real boundaries are the two TCP
> sockets.

Anchor: *"`chat.tsx:28` — `await session.ask(q)` is a function call, not a
fetch."*

## See also

- `02-dns-routing-and-addressing.md` — how `localhost` / a DB host on
  these two boundaries resolves to an address.
- `03-tcp-udp-connections-and-sockets.md` — the TCP connections behind
  boundary 1 and the pool that holds them.
- `08-networking-red-flags-audit.md` — what can fail on each boundary.
- `study-system-design` — *where* these boundaries belong in the design.
