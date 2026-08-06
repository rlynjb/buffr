# Study — Networking · Overview (buffr-laptop)

The whole networking story of this repo still opens with **no inbound
server** — but it no longer closes with "two outbound clients." buffr-laptop
opens one connection pool (`pg.Pool`) to Postgres over TCP, makes a fixed pair
of HTTP calls to a local model server (Ollama), and — new since the last pass —
fans out to up to **six real internet APIs** the moment `/research` or
`/investing` runs: Reddit, Google Custom Search, Brave, Tavily, an RSS feed,
Amazon reviews, and Google Trends. Nothing listens. Nothing accepts
connections. There is still no browser, so there is still no CORS, no cookies,
no WebSocket, no SSE. What changed: the HTTP surface stopped being "one host
string to a loopback model server" and became a concurrent fan-out to the open
internet — real DNS, real TLS, real per-host failure modes. That shift is the
headline of this update.

## The system in one diagram

This is every byte that crosses a socket in buffr. Two always-on outbound
paths (pool + model server) plus a connector fan-out that only fires during
`/research` and `/investing`.

```
  buffr-laptop — the complete on-the-wire map

  ┌─ Process layer (one Node ESM process) ─────────────────────────────┐
  │  npm run chat → OpenTUI → createChatSession()                       │
  │     │                                                               │
  │     ├──► PgVectorStore / PgJournalStore / trace sink (src/*.ts)     │
  │     │         uses the connection pool (pg.Pool)                    │
  │     │                                                               │
  │     ├──► RagQueryAgent (aptkit)                                     │
  │     │         uses GemmaModelProvider + OllamaEmbeddingProvider     │
  │     │                                                               │
  │     └──► MarketResearchEngine / InvestingEngine → Collector         │
  │               fans out to N connectors CONCURRENTLY (Promise.all)   │
  └───────┬────────────────────┬──────────────────────┬────────────────┘
          │ pg-wire/TCP :5432  │ HTTP/TCP :11434       │ HTTPS/TCP :443 (× up to 6, parallel)
          ▼                    ▼                       ▼
  ┌─ Storage ────────┐ ┌─ Provider ─────────┐ ┌─ External APIs ──────────────────┐
  │ Postgres (reindb)│ │ Ollama (gemma2)    │ │ reddit.com · googleapis.com      │
  │ pgvector/agents  │ │ /api/chat /embed   │ │ api.search.brave.com             │
  │ TLS via sslmode  │ │ plaintext loopback │ │ api.tavily.com · amazon.com      │
  └───────────────────┘ └─────────────────────┘ │ (an RSS feed host) · Google Trends│
                                                 └─────────────────────────────────────┘
                                                  real DNS + default-verified TLS,
                                                  each wrapped in a 1h TTL cache
```

Everything in this guide hangs off that picture. The connection pool (`pg.Pool`)
owns the left path; aptkit's HTTP transport (`defaultHttpTransport`) owns the
middle path (buffr contributes only the host string); buffr's **own**
`@buffr/connectors` package owns the right path — six connectors, each
authoring its own `fetch()` call.

## The ranked findings — what to look at first

Verdict-first. Here is what actually matters on the wire, in order of
consequence:

1. **Concurrent connector fan-out tolerates fast failures but not hangs — and
   that gap now spans six external APIs, not one.** `Collector.execute`
   (`packages/capabilities/src/collector/index.ts:35-52`) runs every source
   through `Promise.all`, each wrapped in its own `try/catch` so one connector
   throwing doesn't sink the batch. But `Promise.all` only resolves once *every*
   promise settles — and nothing passes an `AbortSignal` into
   `source.connector.fetch(source.params)`. A connector that never
   resolves (a stalled TCP connection to Reddit, a slow-loading Amazon page)
   blocks the *entire* `/research` or `/investing` turn forever, even though
   five other connectors already succeeded. This is the single most important
   new finding — the fault-tolerance is real but it's a rejection handler, not
   a timeout. → `07-timeouts-retries-pooling-and-backpressure.md`,
   `08-networking-red-flags-audit.md`.

2. **One warm connection pool (`pg.Pool`) across many turns is still the
   load-bearing database decision.** `createChatSession()` opens the pool once
   (`src/session.ts:399`) and every turn — including the new `PgJournalStore`
   queries for `/review` — borrows a connection from it. → `03-tcp-udp-connections-and-sockets.md`,
   `07-timeouts-retries-pooling-and-backpressure.md`.

3. **buffr's HTTP surface grew from one host string to buffr's own connectors
   package.** The Ollama path is still thin — the `fetch()` lives in aptkit's
   `defaultHttpTransport`, and buffr only supplies `http://localhost:11434`
   (`src/config.ts:14`). But the six web connectors in `@buffr/connectors`
   (`packages/connectors/src/discovery/*.ts`) are buffr's **own** code writing
   real `fetch()` calls, parsing real response bodies, and each handling
   non-2xx and malformed-body failures slightly differently.
   → `05-http-semantics-caching-and-cors.md`.

4. **TLS: the pg-wire policy is still a credential string, but the web
   connectors now do real, default-verified HTTPS.** `sslmode=` inside
   `DATABASE_URL` still decides pg-wire encryption with zero TLS code
   (`src/db.ts:4`). What's new: every connector fetch (`reddit.com`,
   `googleapis.com`, `api.search.brave.com`, `api.tavily.com`, `amazon.com`,
   Google's trends servers) goes out over HTTPS with Node's default
   certificate verification — no custom `Agent`, no `rejectUnauthorized:
   false` anywhere in the repo. → `04-tls-and-trust-establishment.md`.

5. **Cancellation is wired in the contract at every layer but used nowhere.**
   aptkit's model transport accepts an `AbortSignal`; every connector's
   `fetch(params, opts)` accepts `FetchOptions.signal`
   (`packages/connectors/src/contracts.ts:15`). buffr passes a signal to
   neither. → `07-timeouts-retries-pooling-and-backpressure.md`.

6. **A bounded teardown was added for the pool.** `session.close()` now races
   `pool.end()` against a 1-second timeout, and `chat.tsx`'s `forceExit()` sets
   a hard 1.5s deadline regardless of whether the pool finishes draining
   (`src/session.ts` `close()`, `src/cli/chat.tsx` `forceExit`). This is the
   first place buffr treats "shut down within N seconds" as a real contract
   rather than an unbounded `await`. → `03-tcp-udp-connections-and-sockets.md`.

7. **Loopback is still the transport for the model server.** `localhost:11434`
   resolves to the loopback interface (`127.0.0.1`/`::1`) — the request never
   touches a network card. This is now the *exception*, not the rule — every
   other outbound HTTP call in the repo leaves the machine.
   → `02-dns-routing-and-addressing.md`.

## Not yet exercised (honest absences)

These are real networking concepts the repo simply does not contain. Each file
says when it would start to matter. Note what moved out of this list this
pass: real DNS and real TLS to remote hosts are no longer absences — the
connector fan-out exercises both. What's still missing:

- **No inbound server.** buffr accepts zero connections. No Express, no HTTP
  listener, no port bound for incoming traffic. → it's a CLI process, not a
  service.
- **No CORS, no cookies, no browser policy.** There is no browser in the loop,
  not even for the six new connectors — they're server-to-server calls from a
  Node CLI. CORS is a browser enforcement; with no browser, it never fires.
  → `05-http-semantics-caching-and-cors.md`.
- **No WebSocket, no SSE, no network streaming.** `agent.answer()` returns one
  whole string (`src/session.ts`); the model response is awaited in full, not
  streamed token-by-token. The new live progress panel (`onProgress`/
  `onStatus` callbacks) *looks* like streaming in the UI but is in-process
  function calls, not a network transport. → `06-websockets-sse-streaming-and-realtime.md`.
- **No per-request timeout, anywhere.** Not on the model call, not on any of
  the six connectors. `Promise.all` in `Collector.execute` tolerates a
  connector that *throws*; it does not tolerate one that *hangs*.
  → `07-timeouts-retries-pooling-and-backpressure.md`,
  `08-networking-red-flags-audit.md`.
- **No retries, no backoff, no jitter — for the model call or any connector.**
  A failed `fetch` or a dropped pg connection throws straight up.
  → `07-timeouts-retries-pooling-and-backpressure.md`.
- **No pool tuning.** `new pg.Pool({ connectionString })` takes node-postgres
  defaults — `max: 10`, no `idleTimeoutMillis` override, no
  `connectionTimeoutMillis`. → `07-timeouts-retries-pooling-and-backpressure.md`.
- **No proxy, no CDN, no edge, no load balancer.** Every connector dials the
  provider's origin directly. → `02-dns-routing-and-addressing.md`.
- **No in-flight request dedupe.** The 1-hour `CachedConnector` TTL cache stops
  *repeat* calls with identical params, but two concurrent identical calls
  issued before the first resolves still both fire.
  → `07-timeouts-retries-pooling-and-backpressure.md`.

## Reading order

```
  00-overview                  ← you are here
  01-network-map               the full path, both directions
  02-dns-routing-and-addressing names, loopback, no edge
  03-tcp-udp-connections-and-sockets   pg-wire over TCP, the pool
  04-tls-and-trust-establishment       sslmode-by-connection-string
  05-http-semantics-caching-and-cors   POST JSON to Ollama; CORS absent
  06-websockets-sse-streaming-and-realtime   all absent, and why
  07-timeouts-retries-pooling-and-backpressure   the pool + every gap
  08-networking-red-flags-audit        ranked risks with evidence
```

## Cross-links to neighboring guides

The partition seam (per the spec): this guide owns **WHAT happens on the wire.**

- `study-database-systems` — owns the pgvector storage engine, the HNSW index,
  the transaction in `PgVectorStore.upsert` (`src/pg-vector-store.ts:38`). This
  guide stops at the socket; that guide picks up inside the database.
- `study-security` — owns **WHETHER** each boundary is safe: secrets in
  `DATABASE_URL`, the no-RLS / no-auth posture, trust of the model server. This
  guide names where TLS is decided; that guide judges whether the decision is
  safe.
