# 00 — Overview: the coordination map of buffr-laptop

## Subtitle

The single-process / two-remote-dependency topology — *Industry standard*
(it's a client talking to two backing services, the most common shape there
is). The distributed-systems word for "this isn't really distributed" is a
**single point of coordination**: one process decides everything; the remotes
only answer.

## The verdict, up front

buffr-laptop is **one Node process** with **two remote dependencies**:

- **Postgres** (`reindb`, schema `agents`), reached over a connection pool
  (`pg.Pool` in `src/db.ts:4`). This is the *only* real client/server boundary
  in the repo.
- **Ollama**, reached over HTTP for generation (`gemma2:9b`) and embeddings
  (`nomic-embed-text:v1.5`). aptkit owns that client; buffr only passes a host.

There are **no peers, no replicas, no message queue, no consensus, no leader,
no second writer.** When the distributed-systems lens asks "what stays correct
when a participant is slow, duplicated, stale, or unavailable?" — the honest
answer for most of the inventory is *the question doesn't arise yet, because
there's only one of everything.*

```
  buffr-laptop — the whole coordination map (one process, two remotes)

  ┌─ Client (one Node process) ──────────────────────────────────────┐
  │   src/cli/chat.tsx  (Ink TUI)                                     │
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

That diagram is the whole system. Every distributed-systems concept either
lands on the `client → Postgres` arrow, the `client → Ollama` arrow, or it's
`not yet exercised`.

## Ranked findings

The three things worth understanding, in order of consequence:

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
   omission of any retry. → covered in `audit.md` and `02`.

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
  `03-deferred-two-brain-shared-memory.md` — the three deep walks.
- Sibling guides: `study-system-design` (shape/scale), `study-database-systems`
  (Postgres-local consistency), `study-debugging-observability` (reading the
  trajectory back).
