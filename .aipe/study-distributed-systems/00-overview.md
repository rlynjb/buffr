# 00 — Overview: the coordination map of buffr-laptop

## Subtitle

The single-process / multi-remote-dependency topology — *Industry standard*
(it's a client talking to backing services, the most common shape there
is — plain chat talks to two, `/research` and `/investing` add a third,
concurrent one). The distributed-systems word for "this isn't really
distributed" is a **single point of coordination**: one process decides
everything; the remotes only answer.

## The verdict, up front

buffr-laptop is **one Node process** with remote dependencies — still no
peers, no replicas, no second writer, but now three *kinds* of remote
instead of two:

- **Postgres** (`reindb`, schema `agents`), reached over a connection pool
  (`pg.Pool` in `src/db.ts:4`). This is the *only* real client/server boundary
  in the repo. New this cycle: the same pool now also backs
  `agents.decisions` (the decision journal) through `PgJournalStore`
  (`src/pg-journal-store.ts`) — a second consumer of the same boundary, not a
  new one.
- **Ollama**, reached over HTTP for generation (`gemma2:9b`) and embeddings
  (`nomic-embed-text:v1.5`). aptkit owns that client; buffr only passes a host.
- **Up to five web-search APIs** (Google Trends, Brave, Tavily, Google Custom
  Search, Reddit), reached over HTTPS by `/research` and `/investing` —
  **concurrently**, via `Collector.execute()`'s `Promise.all` fan-out. This is
  new this cycle and it's the first place in the repo where more than one
  remote is genuinely in flight at once.

There are **no peers, no replicas, no message queue, no consensus, no leader,
no second writer.** When the distributed-systems lens asks "what stays correct
when a participant is slow, duplicated, stale, or unavailable?" — the honest
answer for most of the inventory is *the question doesn't arise yet, because
there's only one of everything* — with one exception: the web-search fan-out
*does* have more than one of something (five concurrent remotes), and that's
where finding #4 below lives.

```
  buffr-laptop — the chat-path coordination map (one process, two remotes)

  ┌─ Client (one Node process) ──────────────────────────────────────┐
  │   src/cli/chat.tsx  (OpenTUI)                                     │
  │        │ in-process call                                          │
  │   src/session.ts  createChatSession → ask()                      │
  │        │                                                          │
  │   RagQueryAgent (aptkit)   PgVectorStore   SupabaseTraceSink      │
  └────┬───────────────────────────┬──────────────────────┬──────────┘
       │ HTTP                       │ pooled pg conn       │ pooled pg conn
       ▼                            ▼                      ▼
  ┌─ Provider ─────┐         ┌─ Storage ────────────────────────────┐
  │  Ollama        │         │  Postgres  reindb / schema agents    │
  │  gemma2:9b     │         │  documents · chunks · conversations  │
  │  nomic-embed   │         │  messages · profiles                 │
  └────────────────┘         └──────────────────────────────────────┘

  one client decides everything; two remotes only answer.
  no arrow goes sideways — no remote talks to another remote.
```

That diagram is the chat (`ask()`) path — still the whole system for plain
chat. `/research` and `/investing` add a third arrow off the same client box,
to up to five web-search providers **concurrently** (not shown above to keep
it readable) — see `04-scatter-gather-connector-fanout.md` for that map.
Every distributed-systems concept lands on the `client → Postgres` arrow, the
`client → Ollama` arrow, the `client → web-search APIs` fan-out, or it's
`not yet exercised`.

## Ranked findings

The four things worth understanding, in order of consequence:

1. **The app↔Postgres boundary is the only client/server seam — and it's
   fail-fast with no acquire timeout.** The pool (`pg.Pool`) is created with a
   bare connection string and nothing else (`src/db.ts:4`): no
   `connectionTimeoutMillis`, no `statement_timeout`, no acquire timeout. If
   Postgres is slow or the pool is exhausted, `ask()` waits on the default
   behavior — it doesn't deadline-bound the wait. On one device with one user
   this is fine; it's the first thing that needs a deadline the day load shows
   up. → **`01-app-to-postgres-boundary.md`**.

2. **The trace sink buffers async writes and flushes them unordered — but
   replay order is decided at *emit* time, not by the flush race.** Each
   `CapabilityEvent` triggers a fire-and-forget `persistMessage` promise pushed
   into an array (`src/supabase-trace-sink.ts:87`); `flush()` awaits them with
   `Promise.all` (`:92`), so the inserts complete in *whatever* order Postgres
   finishes them. The thing that saves correctness: `created_at` is taken from
   `event.timestamp` at emit time (`:54`, persisted at `src/session.ts` via
   `persistMessage`), so when you `ORDER BY created_at` on replay, you get emit
   order regardless of who won the insert race. **This is sound on one device.
   It is exactly the assumption that breaks under cross-device clock skew** —
   which is the future-RFC point. → **`02-trace-sink-write-buffering.md`**.

3. **Idempotency exists at the storage level (`ON CONFLICT`), not at the
   request level — and nothing retries, so request-level dedup isn't needed
   yet.** `indexDocumentRow` uses `INSERT ... ON CONFLICT (id) DO UPDATE`
   (`src/runtime.ts:14`); the design says the same for `PgVectorStore.upsert`.
   That makes re-indexing the same document safe. But there's no idempotency
   key on the *request* path (`ask()` never retries; a duplicate user turn
   would just insert a second `messages` row). At-most-once delivery, by
   omission of any retry. The new decision journal (`PgJournalStore.create`,
   `src/pg-journal-store.ts:50-84`) is the same story one level further: a
   plain `INSERT` with a server-generated id, no `ON CONFLICT`, safe today
   because nothing retries it either. → covered in `audit.md` and `02`.

4. **New this cycle: `/research` and `/investing` fan out to up to five
   web-search APIs concurrently, and isolate — but don't time-bound — each
   one's failure.** `Collector.execute()`
   (`packages/capabilities/src/collector/index.ts:35-52`) runs every
   configured source's `connector.fetch()` inside `Promise.all`, each wrapped
   in its own `try/catch` so one source's error can't sink the others already
   in flight. Every source across both engines is currently marked
   `optional: true` (`src/session.ts:472-559`), so a full wipeout degrades to
   an empty evidence set rather than a thrown error — `research-flow.ts:85-88`
   catches exactly that case and ends the turn cleanly. What's still missing:
   no `AbortSignal`/timeout is passed into any `connector.fetch()` call, so a
   hung (not failed) source stalls the whole gather. This is the first
   scatter-gather in the repo and the first place more than one remote is
   ever in flight at once. → **`04-scatter-gather-connector-fanout.md`**.

## What's deferred (design, not code)

The parent vision is a **centralized agent layer**: laptop + phone (and other
apps) sharing one Supabase over an HTTP API, with RLS, an Edge Function gateway,
and laptop↔phone memory sync (`agent-layer-plan.md`;
`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`). That
is **design-only, approved-to-capture, implementation-not-started.** The moment
a second writer exists, six of the `not yet exercised` lenses light up at once:
multi-writer consistency, the convention-only `app_id` isolation becoming a real
tenant boundary, request-level idempotency across the network, and — most
sharply — the clock-skew assumption in finding #2. One file walks that future as
forward-looking design: **`03-deferred-two-brain-shared-memory.md`**, clearly
labelled DESIGN-NOT-CODE.

## See also

- `audit.md` — every lens, walked honestly (mostly `not yet exercised`).
- `01-app-to-postgres-boundary.md`, `02-trace-sink-write-buffering.md`,
  `03-deferred-two-brain-shared-memory.md`,
  `04-scatter-gather-connector-fanout.md` — the four deep walks.
- Sibling guides: `study-system-design` (shape/scale), `study-database-systems`
  (Postgres-local consistency), `study-debugging-observability` (reading the
  trajectory back), `study-networking` (the HTTP mechanics of each individual
  connector call that `04` deliberately doesn't re-teach).
