# Study — Networking · buffr-laptop

The transport and protocol behavior this repo actually exercises. Verdict
first: **buffr only owns two wires, and one of them it doesn't even touch
directly.**

```
  The whole network surface of buffr — one picture

  ┌─ CLI process (your laptop) ──────────────────────────────────────┐
  │                                                                   │
  │  npm run ask / index / eval / migrate                             │
  │        │                                                          │
  │        ├──────────────► pg.Pool ──── TCP :5432 ───► Postgres      │  wire 1
  │        │                (src/db.ts)   (Supabase)    reindb         │  REPO OWNS
  │        │                                            pgvector       │
  │        │                                                          │
  │        └──► aptkit provider ──── HTTP :11434 ──► Ollama           │  wire 2
  │             (Gemma / Ollama-     POST /api/chat   gemma2:9b        │  REPO PASSES
  │              EmbeddingProvider)  POST /api/embed   nomic-embed     │  host ONLY
  │             repo passes only `host`; fetch() lives in aptkit       │
  └───────────────────────────────────────────────────────────────────┘

  two boundaries, both client-side, both outbound. no inbound server,
  no browser, no edge, no CORS, no cookies, no websockets of the repo's own.
```

This is a backend/CLI tool. It is a *client* on both wires and a *server* on
neither. That single fact deletes more than half the standard networking
syllabus — and the honest move is to say so loudly rather than invent a load
balancer that isn't there.

## Ranked findings — what carries the weight

1. **The pg Pool is the repo's only first-party network object, and it's
   stock.** `createPool` is `new pg.Pool({ connectionString: databaseUrl })`
   — five lines, zero tuning (`src/db.ts:4-6`). Default pool size (10),
   default no connection/idle/query timeout. Every CLI builds one pool, fires
   its queries, and calls `pool.end()`. This is the most consequential network
   surface in the repo because it's the one buffr can actually change. → see
   `03-tcp-udp-connections-and-sockets.md`, `07-timeouts-retries-pooling-and-backpressure.md`.

2. **The Ollama HTTP wire is real but buffr doesn't hold the socket.** Every
   CLI constructs `new OllamaEmbeddingProvider({ host: cfg.ollamaHost })` and
   `new GemmaModelProvider({ host: cfg.ollamaHost })` (`src/cli/ask-cmd.ts:20,26`).
   The actual `fetch('${host}/api/chat')` / `fetch('${host}/api/embed')` lives
   inside aptkit's `defaultHttpTransport`, not in this repo. buffr's entire HTTP
   surface is the string `http://localhost:11434` in `src/config.ts:14`. → see
   `05-http-semantics-caching-and-cors.md`.

3. **TLS is implicit and off-loaded.** Postgres encryption rides entirely on
   the `DATABASE_URL` connection string (`sslmode=require` is a substring, not
   code); the repo never configures `ssl` on the Pool. Ollama is plaintext
   HTTP — correctly, because it's loopback. → see `04-tls-and-trust-establishment.md`.

4. **No timeouts, no retries, no backpressure of the repo's own.** Not a
   gap to apologize for — a true statement. No `AbortController` is constructed
   at any call-site; the providers *accept* a `signal` but buffr never passes
   one. A hung Ollama or a stalled Postgres connection blocks the CLI
   indefinitely. The Gemma "retry" you'll find is a JSON-correctness re-prompt,
   not a network retry. → see `07-timeouts-retries-pooling-and-backpressure.md`.

5. **Loopback vs remote is the one address seam that matters.** Ollama is
   `localhost` (kernel never hits a NIC); Postgres is a remote Supabase host
   resolved by DNS over the real internet. Same code shape, wildly different
   failure and latency profiles. → see `02-dns-routing-and-addressing.md`.

## Reading order

```
  00  overview               ← you are here
  01  network-map            the full on-the-wire path, both boundaries
  02  dns-routing            localhost vs remote Supabase host resolution
  03  tcp-udp-sockets        pg's TCP connection lifecycle + the pool
  04  tls-and-trust          where encryption is (string), where it isn't (loopback)
  05  http-semantics         POST /api/chat + /api/embed, status handling
  06  websockets-sse         realtime — not yet exercised (and why)
  07  timeouts-retries-pool  the hardening the repo does NOT have
  08  red-flags-audit        ranked network-failure risks
```

## `not yet exercised` — stated plainly

- **Inbound HTTP server** — no Express/Fastify/Next handler. buffr is a CLI;
  nothing listens. (`05`)
- **CORS / cookies / browser cache** — no browser ever calls buffr. (`05`)
- **WebSockets / SSE / streaming** — `ask-cmd.ts` awaits one whole answer and
  prints it; no token stream, no long-lived connection. aptkit *ships* an
  ndjson streamer but buffr's `RagQueryAgent.answer()` path doesn't use it. (`06`)
- **Retries / backoff / jitter** — zero. (`07`)
- **Timeouts** — zero constructed by the repo. (`07`)
- **Connection-pool tuning** — stock `pg.Pool` defaults, nothing set. (`07`)
- **Proxies / CDN / edge / load balancers** — none; the context.md notes "no
  Edge Functions this phase." (`01`, `02`)
- **UDP / raw sockets / HTTP/2 / gRPC** — none. (`03`)

## Cross-links to neighboring guides

- **Database internals** (wire protocol → what Postgres *does* with the bytes:
  storage, HNSW index, MVCC, the `<=>` cosine operator) → `study-database-systems`.
- **Trust boundaries** (whether each wire is *safe* — credential handling,
  `sslmode`, plaintext loopback as an attack surface) → `study-security`.
- **Where boundaries belong** (should Ollama be a sidecar? should the pool be
  shared?) → `study-system-design`.

A finding lives here only when the mechanism is *on the wire*. What Postgres
does after the bytes arrive is database-systems; whether the wire is safe is
security.
