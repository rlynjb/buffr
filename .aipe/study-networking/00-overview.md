# Networking — Overview

> Study guide for `buffr-laptop`. What actually happens on the wire when
> you run `npm run chat`, where it can fail, and which protocol semantics
> the code relies on. Curriculum-style: concept → mechanism → real
> `file:line` in your repo. Where the repo doesn't exercise something, it
> says `not yet exercised` instead of inventing it.

## The whole network surface in one picture

`buffr-laptop` is a single-process Node CLI. It is a **client to two
servers** and a **server to nobody**. That one sentence is the spine of
this entire guide — keep it in your head.

```
  buffr-laptop on the wire — the whole thing

  ┌─ Process: node (npm run chat) ─────────────────────────────┐
  │                                                            │
  │   src/cli/chat.tsx (Ink TUI)                               │
  │        │ in-process calls, NO network                      │
  │   src/session.ts  ── one warm pool, many turns ──┐         │
  │        │                                         │         │
  │   ┌────▼──────────┐                  ┌────────────▼──────┐  │
  │   │ pg.Pool       │                  │ Ollama providers  │  │
  │   │ (src/db.ts)   │                  │ (aptkit transport)│  │
  │   └────┬──────────┘                  └────────┬──────────┘  │
  └────────┼──────────────────────────────────────┼────────────┘
           │ TCP 5432 (pg wire)                    │ TCP 11434 (HTTP)
           │ TLS by DATABASE_URL sslmode           │ plaintext, loopback
           ▼                                       ▼
  ┌─ Provider: Postgres ──────┐         ┌─ Provider: Ollama ────────┐
  │ reindb / schema agents    │         │ gemma2:9b (generate)      │
  │ pgvector HNSW             │         │ nomic-embed-text (embed)  │
  └───────────────────────────┘         └───────────────────────────┘

  two outbound connections; ZERO inbound. nothing listens.
```

Everything north of the two TCP lines is one OS process with no network
inside it. The Ink terminal UI talks to `session.ts` by function call.
The only bytes that leave the process go down those two pipes: the
Postgres wire protocol on 5432, and HTTP to Ollama on 11434.

## Reading order

Read top to bottom; each file is self-contained but they build.

```
  01-network-map                     the full path, every boundary
  02-dns-routing-and-addressing      how localhost / a DB host resolves
  03-tcp-udp-connections-and-sockets pg wire over TCP + the pool
  04-tls-and-trust-establishment     TLS by connection string, not in code
  05-http-semantics-caching-and-cors HTTP to Ollama; honest absences
  06-websockets-sse-streaming        realtime transports — all absent
  07-timeouts-retries-pooling        pooling present; the rest absent
  08-networking-red-flags-audit      ranked risks, evidence per verdict
```

## The ranked findings

Verdict first. These are the things worth knowing about this repo's
network behavior, most consequential first. Each is walked in full in the
file named.

1. **One warm pool across many turns is the load-bearing network
   decision.** `createChatSession()` builds one `pg.Pool` once
   (`src/session.ts:39`) and every `ask()` borrows-and-returns a
   connection from it. A long-lived Ink session reuses warm TCP+auth'd
   connections instead of paying connect+TLS+auth per turn. → `03`, `07`.

2. **TLS is configured by connection string, never in code.** `src/db.ts`
   passes `connectionString: databaseUrl` straight to `pg.Pool` with no
   `ssl` object. Whether the 5432 connection is encrypted is decided
   entirely by `sslmode=` in `DATABASE_URL`. The code is TLS-agnostic. → `04`.

3. **HTTP to Ollama is plaintext over loopback, and buffr never sees the
   request.** buffr's whole HTTP surface is the host *string*
   `http://localhost:11434` (`src/config.ts:14`). The actual `fetch`,
   headers, and body live inside aptkit's providers. buffr supplies an
   address; aptkit owns the protocol. → `02`, `05`.

4. **No timeouts, no retries, no AbortSignal anywhere.** A hung Postgres
   query or a stalled Ollama generation blocks the turn forever; the Ink
   spinner spins indefinitely. The only safety net is the per-turn
   `try/catch` in `chat.tsx:30` that renders the error string. → `07`, `08`.

5. **buffr listens on nothing.** No HTTP server, no socket server, no
   inbound port. That erases an entire class of concerns — CORS, request
   auth, rate limiting, DDoS — by construction, not by configuration. → `01`, `05`.

## not yet exercised — the honest absences

This repo is a local-first single-device CLI. Large parts of the
networking syllabus simply aren't present. Naming them is the lesson:

- **Inbound server / listening socket** — nothing calls `listen()`. → `01`.
- **DNS resolution of a real hostname** — default host is `localhost`,
  resolved from the hosts file, not DNS. A remote `DATABASE_URL` would be
  the first real resolver hit. → `02`.
- **Proxies, CDN, edge, load balancers** — direct connections only. → `02`.
- **UDP** — both protocols (pg wire, HTTP) are TCP. → `03`.
- **CORS / cookies / browser policy** — no browser, no inbound HTTP. → `05`.
- **WebSocket / SSE / HTTP streaming** — `agent.answer()` returns a
  single resolved string; nothing streams token-by-token. → `06`.
- **Timeouts / retries / backoff / jitter / circuit breakers** — none in
  buffr's code. → `07`.
- **Pool tuning** — `pg.Pool` is constructed with `max`/idle/connection
  timeouts all at library defaults. → `07`.
- **Backpressure / request collapsing / overload control** — single user,
  one turn at a time, gated by the `busy` flag in `chat.tsx:13`. → `07`.

## Cross-links to neighboring guides

This guide owns *what happens on the wire*. It does not re-teach:

- **`study-database-systems`** — owns the storage engine behind 5432:
  HNSW index, pgvector cosine ops, transaction/isolation semantics, the
  `<=>` operator. This guide stops at "bytes reach Postgres"; that guide
  takes over inside Postgres.
- **`study-security`** — owns *whether* each boundary is safe: secret
  handling for `DATABASE_URL`, the `sslmode` trust decision as a security
  posture, the absence of RLS, plaintext loopback as a threat model. This
  guide says *what* the wire does; that guide says whether it's *safe*.
- **`study-system-design`** — owns *where* the network boundaries belong
  in the architecture (the provider-abstraction seam, local-first choice).
```
