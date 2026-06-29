# Study — Networking · Overview (buffr-laptop)

The whole networking story of this repo fits in one sentence: **two long-lived
outbound clients, no inbound server.** buffr-laptop opens a connection pool
(`pg.Pool`) to Postgres over TCP and makes HTTP requests to a local model server
(Ollama) — and that is the entire wire surface. Nothing listens. Nothing
accepts connections. There is no browser, so there is no CORS, no cookies, no
WebSocket, no SSE. That absence is not a gap to apologize for — it's the shape
of a single-device CLI brain, and naming it precisely is half the lesson.

## The system in one diagram

This is every byte that crosses a socket in buffr. Two outbound paths from one
Node process; both endpoints are on (or reachable from) the same machine.

```
  buffr-laptop — the complete on-the-wire map

  ┌─ Process layer (one Node ESM process) ───────────────────────┐
  │  npm run chat → Ink TUI → createChatSession()                 │
  │     │                                                         │
  │     ├──► PgVectorStore / trace sink / profile  (src/*.ts)     │
  │     │         uses the connection pool (pg.Pool)              │
  │     │                                                         │
  │     └──► RagQueryAgent (aptkit)                               │
  │               uses GemmaModelProvider + OllamaEmbeddingProvider│
  └───────┬───────────────────────────────────┬──────────────────┘
          │ pg-wire over TCP                   │ HTTP/1.1 over TCP
          │ (libpq protocol, port 5432)        │ (POST JSON, port 11434)
          ▼                                    ▼
  ┌─ Storage layer ──────────┐        ┌─ Provider layer ──────────┐
  │  Postgres (reindb)       │        │  Ollama model server      │
  │  pgvector / agents schema│        │  gemma2:9b  (/api/chat)   │
  │  TLS gated by sslmode    │        │  nomic-embed (/api/embed) │
  └──────────────────────────┘        └───────────────────────────┘
```

Everything in this guide hangs off that picture. The connection pool (`pg.Pool`)
owns the left path; aptkit's HTTP transport (`defaultHttpTransport`) owns the
right path; buffr's only contribution to the right path is the host string.

## The ranked findings — what to look at first

Verdict-first. Here is what actually matters on the wire, in order of
consequence:

1. **One warm connection pool (`pg.Pool`) across many turns is the
   load-bearing networking decision.** `createChatSession()` opens the pool once
   (`src/session.ts:39`) and every turn borrows a connection from it. This is the
   single most important wire-level choice in the repo — it's what makes a
   long-lived CLI cheap instead of paying a TCP + TLS + Postgres-auth handshake
   on every keystroke. → `03-tcp-udp-connections-and-sockets.md`,
   `07-timeouts-retries-pooling-and-backpressure.md`.

2. **buffr's HTTP surface is one string.** The actual `fetch()` calls live in
   aptkit (`defaultHttpTransport` → `POST /api/chat`, `POST /api/embed`). buffr
   contributes exactly the host `http://localhost:11434` (`src/config.ts:14`).
   The most surprising thing here: the HTTP client is wired-but-thin — buffr
   never sees a header, a status code, or a response body directly.
   → `05-http-semantics-caching-and-cors.md`.

3. **TLS is configured by connection string, not by code.** There is no
   `ssl: {...}` object anywhere. Whether the pg-wire connection encrypts is
   decided entirely by the `sslmode=` parameter inside `DATABASE_URL`. The repo
   has no opinion in code — the credential carries the policy.
   → `04-tls-and-trust-establishment.md`.

4. **Cancellation is wired in the transport but unused at buffr's layer.**
   aptkit's transports accept an `AbortSignal` and call `signal?.throwIfAborted()`
   — but buffr passes no signal. So a hung `/api/chat` request blocks the turn
   forever. → `07-timeouts-retries-pooling-and-backpressure.md`.

5. **Loopback is the transport for the model server.** `localhost:11434` resolves
   to the loopback interface (`127.0.0.1`/`::1`) — the request never touches a
   network card. → `02-dns-routing-and-addressing.md`.

## Not yet exercised (honest absences)

These are real networking concepts the repo simply does not contain. Each file
says when it would start to matter.

- **No inbound server.** buffr accepts zero connections. No Express, no HTTP
  listener, no port bound for incoming traffic. → it's a CLI process, not a
  service.
- **No CORS, no cookies, no browser policy.** There is no browser in the loop.
  CORS is a browser enforcement; with no browser, it never fires.
  → `05-http-semantics-caching-and-cors.md`.
- **No WebSocket, no SSE, no streaming.** `agent.answer()` returns one whole
  string (`src/session.ts:62`); the model response is awaited in full, not
  streamed token-by-token. → `06-websockets-sse-streaming-and-realtime.md`.
- **No retries, no timeouts, no backoff, no jitter.** A failed `fetch` or a
  dropped pg connection throws straight up to the Ink catch
  (`src/cli/chat.tsx:30`). → `07-timeouts-retries-pooling-and-backpressure.md`.
- **No pool tuning.** `new pg.Pool({ connectionString })` takes node-postgres
  defaults — `max: 10`, no `idleTimeoutMillis` override, no
  `connectionTimeoutMillis`. → `07-timeouts-retries-pooling-and-backpressure.md`.
- **No proxy, no CDN, no edge, no load balancer.** Single device, two direct
  outbound paths. → `02-dns-routing-and-addressing.md`.

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
