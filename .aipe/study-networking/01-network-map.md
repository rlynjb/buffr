# 01 · Network Map

> The on-the-wire path (three boundary shapes, one of them a fan-out) — Project-specific
> · Industry standard: *system network topology / dataflow map*

## Zoom out, then zoom in

Before any protocol detail, here's the whole forest. buffr-laptop is a single
Node process that talks to three kinds of thing: a database, a local model
server, and — only while `/research` or `/investing` runs — a concurrent
fan-out to up to six real internet APIs. There is still no inbound traffic.
The map *is* the architecture.

```
  Zoom out — where the network boundaries live

  ┌─ Process layer ───────────────────────────────────────────────────┐
  │  one Node ESM process (npm run chat)                               │
  │  OpenTUI ── session.ask() / researchCollect() ── RagQueryAgent     │
  └───────┬──────────────────┬──────────────────────┬─────────────────┘
          │ ★ BOUNDARY 1 ★   │ ★ BOUNDARY 2 ★        │ ★ BOUNDARY 3 ★
          │ pg-wire/:5432    │ HTTP/:11434           │ HTTPS/internet (× up to 6)
          ▼                  ▼                       ▼
  ┌─ Storage ────────┐ ┌─ Provider ────────┐ ┌─ External APIs ──────────────┐
  │ Postgres+pgvector│ │ Ollama (gemma2)   │ │ Reddit · RSS feed (always on)│
  └──────────────────┘ └───────────────────┘ │ Brave/Tavily/Google/Trends   │
                                              │ (optional; key-present       │
                                              │  activates Brave/Tavily/     │
                                              │  Google — Reddit/RSS/Trends  │
                                              │  need no key)                │
                                              └───────────────────────────────┘
```

Zoom in: a "network map" is just the answer to *which sockets open, in which
direction, carrying what.* For buffr there are three boundary **shapes**, all
**outbound** (buffr is always the client, never the server): one warm database
pool, one fixed pair of loopback HTTP calls, and — new since the last pass — a
concurrent fan-out to real internet hosts that only fires while `/research` or
`/investing` is running. The whole rest of this guide is these arrows examined
under different lights.

## Structure pass

**Layers.** Three bands: Process (the Node app), Storage (Postgres), Provider
(Ollama). The two outer bands are reached *across a socket*; everything inside
the Process band is in-memory function calls.

**Axis — trace `who initiates the connection?` across the boundaries.** Hold
that one question constant:

```
  axis = "who opens the socket?"  — traced across all three boundaries

  ┌─ Process ──┐  boundary 1  ┌─ Storage ──┐
  │ buffr      │ ════════════►│ Postgres   │   buffr dials out
  │ (client)   │  pg-wire     │ (listens)  │   → buffr initiates
  └────────────┘              └────────────┘
  ┌─ Process ──┐  boundary 2  ┌─ Provider ─┐
  │ buffr      │ ════════════►│ Ollama     │   buffr dials out
  │ (client)   │  HTTP POST   │ (listens)  │   → buffr initiates
  └────────────┘              └────────────┘
  ┌─ Process ──┐  boundary 3  ┌─ External ─┐
  │ buffr      │ ════════════►│ Reddit,    │   buffr dials out, N at once
  │ (client)   │  HTTPS × N   │ Google, …  │   → buffr initiates every fetch
  └────────────┘  (parallel)  └────────────┘

  the answer never flips: buffr is the client on ALL THREE boundaries.
  nothing ever dials IN to buffr → no inbound server.
```

**Seams.** Three load-bearing seams, each where the axis "who owns the bytes"
flips from buffr's heap to a wire format:

- **Seam 1 — the pg-wire boundary.** Inside the process, a chunk is a JS object.
  Across the seam it's libpq protocol frames over TCP. The contract: SQL text +
  bound parameters out, result rows back. Owned by the connection pool (`pg.Pool`).
- **Seam 2 — the HTTP boundary (loopback).** Inside the process, a prompt is a
  string. Across the seam it's a JSON body in an HTTP/1.1 POST. The contract:
  `{model, messages}` out, `{message}` back. Owned by aptkit's transport, not
  buffr.
- **Seam 3 — the connector boundary (real internet).** Inside the process, a
  query is `{ query, limit, subreddits }` or similar. Across the seam it's a
  connector-specific HTTPS request — a Reddit `search.json` GET, a Google
  Custom Search GET, a Tavily POST, an HTML page scrape for Amazon. The
  contract is `DataConnector<P, D>.fetch(params, opts) → ConnectorResult<D>`
  (`packages/connectors/src/contracts.ts:3-5`) — and unlike seam 2, buffr's
  **own** `@buffr/connectors` package owns every `fetch()` call on this seam,
  not a third-party library.

## How it works

### Move 1 — the mental model

You already know the shape: a `fetch()` from a React component has a loading,
success, and error state, and the network call is the only part that leaves your
process. buffr is that, but the third arm is now a **fan-out** — a single
`Promise.all` that fires several `fetch()`s at once instead of one, the same
way `Promise.all([fetch(a), fetch(b), fetch(c)])` looks in any frontend
data-fetching code you've written. The "map" is all three arms drawn at once,
with the in-process orchestration that fires them in the middle.

```
  Pattern — one process, three outbound arms (the third is a fan-out)

                    ┌──────────────────────────┐
        question ──►│  session.ask() /          │
                    │  MarketResearchEngine     │
                    └───┬──────────┬─────────────┴──────────────────┐
            pg-wire     │          │ HTTP                            │ HTTPS × N (Promise.all)
        ┌───────────────┘          └──────────┐      ┌───────────────┴───────────────┐
        ▼                                      ▼      ▼        ▼        ▼        ▼   ▼
   [ Postgres ]                          [ Ollama ] [Reddit][Google][Brave][Tavily][RSS][Trends]
   retrieval rows, trace writes,    generation + embedding    all fired concurrently,
   profile, memory, decisions       (chat + embed endpoints)  each wrapped in try/catch
                                                               (Collector.execute)
```

### Move 2 — the walkthrough

**The fan-out point is `session.ask()`.** One user turn triggers *both*
outbound paths in sequence. Here's the real code that tees the two clients
(`src/session.ts:674-690`):

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
created once at `src/session.ts:399`. That's the difference between this and the
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
  answer string returned to OpenTUI
```

The numbers are the rough order within a turn; the point is that one keystroke
in the OpenTUI input drives roughly seven wire crossings, split across two protocols.

**`/research` and `/investing` add a third arm: a genuine concurrent fan-out.**
`session.researchCollect()` builds one `MarketResearchSource[]` array — Google
Trends, Brave, Tavily, Google Search, Reddit, each with its own `paramsFor`
(`src/session.ts:520-561`) — then hands it to `MarketResearchEngine.collect()`
(`packages/engines/market-research/src/engine.ts:56-117`), which fires every
source through `Promise.all` (line 76). `/investing` does the same with a
slightly different source list (`InvestingEngine.run()`,
`packages/engines/investing/src/engine.ts:39-45`), but calls
`Collector.execute` once over the whole array instead of once per source — a
cosmetic difference (one call site groups results for a live progress digest,
the other doesn't) that doesn't change the underlying concurrency: every
connector fires at the same moment, none blocks another from *starting*.

```
  Layers-and-hops — one /research turn, connector fan-out

  ┌─ Process ──────────────┐
  │ MarketResearchEngine   │
  │   .collect()           │
  └──┬──────────────────────┘
     │ Promise.all — all hops fire AT ONCE, not in sequence
     │
     │ hop A: GET reddit.com/search.json         ──► ┌─ Reddit ────┐
     │ hop B: GET googleapis.com/customsearch/v1 ──► │ Google      │
     │ hop C: GET api.search.brave.com/…/search  ──► │ Brave       │
     │ hop D: POST api.tavily.com/search         ──► │ Tavily      │
     │ hop E: (google-trends-api → trends server)──► │ Trends      │
     ▼
  each hop: try/catch inside Collector.execute — a rejection here
  becomes a `failed[]` entry, NOT a crash of the other hops
```

A network map is the cheapest high-leverage artifact you can draw for any
system: it tells you every place the system can fail for reasons outside its own
code, and every place a security boundary lives. buffr's map stayed small on
two of its three arms — the pool and the loopback model call are exactly as
contained as before — but the third arm now reaches the open internet, N hosts
at once. Naming that fan-out precisely (what fires together, what one failure
does to the rest) is this update's job.

## Primary diagram

The full recap — all three boundaries, the protocols, the direction, the
absence of anything inbound.

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

  outbound boundary 3 ── HTTPS / TCP :443 × up to 6, concurrent (Promise.all)
     fetch() calls live in buffr's OWN @buffr/connectors package
     fired by Collector.execute during /research and /investing only
     reddit.com · googleapis.com · api.search.brave.com · api.tavily.com
     amazon.com · an RSS feed host · google-trends-api's trends server
     each wrapped in a CachedConnector (1h TTL); no timeout, no AbortSignal
```

## Elaborate

The "one process, N clients, zero inbound" shape is still the canonical
local-first topology: keep all data and all compute reachable without leaving
the box, so the only "network" that matters day-to-day is loopback or a
same-LAN database. The connector fan-out is the one deliberate exception — the
whole point of `/research` and `/investing` is to reach *outside* the box for
evidence, so this arm is supposed to touch the open internet. It comes from
the same instinct as your contrl project (no network in the hot path) for the
core loop, with an explicit, bounded escape hatch for the research engines.
The interesting future question is still whether boundary 1 (Postgres) ever
moves off-device; the moment it does, sslmode and connection latency stop
being theoretical.

## Interview defense

**Q: Walk me through every network call one plain chat turn makes.**

```
  one turn = ~7 wire crossings, 2 protocols (boundaries 1 and 2 only)

  pg-wire:  INSERT user · SELECT vector · INSERT trace · upsert memory
  HTTP:     embed query · chat completion · embed memory
```

Answer: "One turn tees into two outbound clients. The pg-wire path borrows from
a single warm pool — user-message insert, the vector `SELECT`, the trace flush,
the memory upsert. The HTTP path hits Ollama three times — embed the query,
generate the answer, embed the exchange for memory. Nothing inbound; buffr is the
client on both boundaries." Anchor: `src/session.ts:674-690`.

**Q: What changes during `/research` or `/investing`?**

Answer: "A third arm opens: `MarketResearchEngine.collect()` or
`InvestingEngine.run()` fires every configured connector — Reddit, RSS, and
whichever of Brave/Tavily/Google/Trends have API keys — through one
`Promise.all`. They all leave at once, not in sequence, each hitting a
different real internet host over HTTPS. It's the same 'client tee' idea as a
plain turn, just with N HTTP arms instead of one." Anchor:
`packages/engines/market-research/src/engine.ts:76`.

**Q: Where can this map fail for reasons outside buffr's code?**

Answer: "Any of the three boundaries. Postgres unreachable → `pool.connect()`
rejects. Ollama down → `fetch` rejects with a connection error. A connector
down → its promise rejects and lands in `failed[]`, but a connector that just
*hangs* (no reject, no resolve) blocks the whole `Promise.all` forever, since
nothing threads an `AbortSignal` in. All three surface with no retry." Anchor:
the three seams in the structure pass.

## See also

- `03-tcp-udp-connections-and-sockets.md` — boundary 1 in depth (the pool)
- `05-http-semantics-caching-and-cors.md` — boundary 2 in depth (POST JSON)
- `07-timeouts-retries-pooling-and-backpressure.md` — what happens when a hop hangs
- `study-database-systems` — what happens *inside* Postgres after the SELECT lands
