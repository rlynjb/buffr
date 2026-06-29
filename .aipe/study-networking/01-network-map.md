# 01 · Network Map

> The on-the-wire path (the two outbound clients) — Project-specific
> · Industry standard: *system network topology / dataflow map*

## Zoom out, then zoom in

Before any protocol detail, here's the whole forest. buffr-laptop is a single
Node process that talks to exactly two things: a database and a model server.
There is no third hop, no fan-out, no inbound traffic. The map *is* the
architecture.

```
  Zoom out — where the network boundaries live

  ┌─ Process layer ─────────────────────────────────────────────┐
  │  one Node ESM process (npm run chat)                         │
  │  Ink TUI ── session.ask() ── RagQueryAgent                   │
  └───────┬──────────────────────────────────┬──────────────────┘
          │ ★ NETWORK BOUNDARY 1 ★            │ ★ NETWORK BOUNDARY 2 ★
          │ pg-wire / TCP / :5432             │ HTTP / TCP / :11434
          ▼                                   ▼
  ┌─ Storage layer ─────────┐         ┌─ Provider layer ─────────┐
  │  Postgres + pgvector    │         │  Ollama (local models)   │
  └─────────────────────────┘         └──────────────────────────┘
```

Zoom in: a "network map" is just the answer to *which sockets open, in which
direction, carrying what.* For buffr there are two, both **outbound** (buffr is
always the client, never the server). The whole rest of this guide is these two
arrows examined under different lights.

## Structure pass

**Layers.** Three bands: Process (the Node app), Storage (Postgres), Provider
(Ollama). The two outer bands are reached *across a socket*; everything inside
the Process band is in-memory function calls.

**Axis — trace `who initiates the connection?` across the boundaries.** Hold
that one question constant:

```
  axis = "who opens the socket?"  — traced across both boundaries

  ┌─ Process ──┐  boundary 1  ┌─ Storage ──┐
  │ buffr      │ ════════════►│ Postgres   │   buffr dials out
  │ (client)   │  pg-wire     │ (listens)  │   → buffr initiates
  └────────────┘              └────────────┘
  ┌─ Process ──┐  boundary 2  ┌─ Provider ─┐
  │ buffr      │ ════════════►│ Ollama     │   buffr dials out
  │ (client)   │  HTTP POST   │ (listens)  │   → buffr initiates
  └────────────┘              └────────────┘

  the answer never flips: buffr is the client on BOTH boundaries.
  nothing ever dials IN to buffr → no inbound server.
```

**Seams.** Two load-bearing seams, both where the axis "who owns the bytes"
flips from buffr's heap to a wire format:

- **Seam 1 — the pg-wire boundary.** Inside the process, a chunk is a JS object.
  Across the seam it's libpq protocol frames over TCP. The contract: SQL text +
  bound parameters out, result rows back. Owned by the connection pool (`pg.Pool`).
- **Seam 2 — the HTTP boundary.** Inside the process, a prompt is a string.
  Across the seam it's a JSON body in an HTTP/1.1 POST. The contract: `{model,
  messages}` out, `{message}` back. Owned by aptkit's transport, not buffr.

## How it works

### Move 1 — the mental model

You already know the shape: a `fetch()` from a React component has a loading,
success, and error state, and the network call is the only part that leaves your
process. buffr is that, twice — once to a database (over a binary protocol) and
once to a model server (over HTTP). The "map" is just both calls drawn at once,
with the in-process orchestration that fires them in the middle.

```
  Pattern — one process, two outbound clients (a "client tee")

                    ┌──────────────────┐
        question ──►│  session.ask()   │
                    └───┬──────────┬────┘
            pg-wire     │          │     HTTP
        ┌───────────────┘          └───────────────┐
        ▼                                           ▼
   [ Postgres ]                               [ Ollama ]
   retrieval rows, trace writes,         generation + embedding
   profile, memory                       (chat + embed endpoints)
```

### Move 2 — the walkthrough

**The fan-out point is `session.ask()`.** One user turn triggers *both*
outbound paths in sequence. Here's the real code that tees the two clients
(`src/session.ts:60-71`):

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question); // ── pg-wire: INSERT
  const answer = await agent.answer(question);                  // ── HTTP: embed + chat
  await trace.flush();                                          // ── pg-wire: trace rows
  try {
    await memory.remember({ conversationId, question, answer }); // ── HTTP embed + pg-wire upsert
  } catch { /* best-effort */ }
  return answer;
}
```

Read it as a hop sequence. `persistMessage` borrows a pooled connection and
writes a row (boundary 1). `agent.answer` runs the RAG loop, which embeds the
query (boundary 2, `/api/embed`), searches pgvector (boundary 1, a `SELECT`),
then calls the model (boundary 2, `/api/chat`). `trace.flush` writes the
trajectory (boundary 1). `memory.remember` embeds again (boundary 2) and upserts
(boundary 1). One turn, both boundaries crossed multiple times.

**Every boundary-1 hop reuses the same warm pool.** None of these calls opens a
new TCP connection. They all `pool.connect()` or `pool.query()` against the pool
created once at `src/session.ts:39`. That's the difference between this and the
old one-shot `ask` CLI, which opened and closed a connection per invocation. Here
is the layers-and-hops view of a single turn:

```
  Layers-and-hops — one chat turn across both boundaries

  ┌─ Process ─────────┐
  │ session.ask()     │
  └──┬────────────────┘
     │ hop 1: INSERT user msg          (pg-wire) ──► ┌─ Storage ──┐
     │ hop 6: INSERT trace rows        (pg-wire) ──► │  Postgres  │
     │ hop 3: SELECT … <=> vector      (pg-wire) ──► │            │
     │ hop 7: upsert memory chunk      (pg-wire) ──► └────────────┘
     │
     │ hop 2: POST /api/embed (query)  (HTTP)    ──► ┌─ Provider ─┐
     │ hop 4: POST /api/chat           (HTTP)    ──► │  Ollama    │
     │ hop 5: POST /api/embed (memory) (HTTP)    ──► └────────────┘
     ▼
  answer string returned to Ink TUI
```

The numbers are the rough order within a turn; the point is that one keystroke
in the Ink input drives roughly seven wire crossings, split across two protocols.

### Move 3 — the principle

A network map is the cheapest high-leverage artifact you can draw for any
system: it tells you every place the system can fail for reasons outside its own
code, and every place a security boundary lives. buffr's map is small — two
outbound clients — and that smallness is itself the design. A single-device
brain earns its simplicity by refusing to be a server.

## Primary diagram

The full recap — both boundaries, the protocols, the direction, the absence of
anything inbound.

```
  buffr-laptop — complete network map

  inbound:  (none — no listener, no bound port)

  outbound boundary 1 ── pg-wire / TCP :5432 ── Postgres (reindb)
     borrowed from one warm connection pool (pg.Pool), src/db.ts:4
     TLS gated by DATABASE_URL sslmode

  outbound boundary 2 ── HTTP/1.1 / TCP :11434 ── Ollama
     fetch() lives in aptkit defaultHttpTransport
     buffr supplies host string only, src/config.ts:14
     POST /api/chat (gemma2:9b), POST /api/embed (nomic-embed-text)
```

## Elaborate

The "one process, two clients" shape is the canonical local-first topology: keep
all data and all compute reachable without leaving the box, so the only "network"
is loopback or a same-LAN database. It comes from the same instinct as your
contrl project (no network in the hot path) — except buffr does have two hops,
both kept as close as possible. The interesting future question is whether
boundary 1 (Postgres) ever moves off-device; the moment it does, sslmode and
connection latency stop being theoretical.

## Interview defense

**Q: Walk me through every network call one chat turn makes.**

```
  one turn = ~7 wire crossings, 2 protocols

  pg-wire:  INSERT user · SELECT vector · INSERT trace · upsert memory
  HTTP:     embed query · chat completion · embed memory
```

Answer: "One turn tees into two outbound clients. The pg-wire path borrows from
a single warm pool — user-message insert, the vector `SELECT`, the trace flush,
the memory upsert. The HTTP path hits Ollama three times — embed the query,
generate the answer, embed the exchange for memory. Nothing inbound; buffr is the
client on both boundaries." Anchor: `src/session.ts:60-71`.

**Q: Where can this map fail for reasons outside buffr's code?**

Answer: "Either boundary. Postgres unreachable → `pool.connect()` rejects.
Ollama down → `fetch` rejects with a connection error. Both surface as a thrown
error caught in the Ink UI (`src/cli/chat.tsx:30`) — no retry, no fallback."
Anchor: the two seams in the structure pass.

## See also

- `03-tcp-udp-connections-and-sockets.md` — boundary 1 in depth (the pool)
- `05-http-semantics-caching-and-cors.md` — boundary 2 in depth (POST JSON)
- `07-timeouts-retries-pooling-and-backpressure.md` — what happens when a hop hangs
- `study-database-systems` — what happens *inside* Postgres after the SELECT lands
