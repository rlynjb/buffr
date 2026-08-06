# Study — Distributed Systems (applied to buffr-laptop)

The honest verdict first: **buffr-laptop is not a distributed system.** It is
one Node process with remote dependencies — Postgres (over a connection
pool), Ollama (over HTTP), and, new this cycle, up to five web-search APIs
that `/research`/`/investing` now query **concurrently**. There are no peers,
no replicas, no queues, no consensus, no leader election, no second writer.
Most of the distributed-systems lens inventory still comes back
`not yet exercised`, and that is the correct reading, not a gap to paper
over — but the concurrent web-search fan-out is the first genuine instance
of "more than one remote in flight at once, and some subset can fail" this
repo has, so it earns real coverage.

So this guide teaches the coordination that *is* here — the client/server
boundary to Postgres, the async write-buffering in the trace sink, the
storage-level idempotency (`ON CONFLICT`), and the scatter-gather across
concurrent web-search connectors — and it names, honestly, what becomes
relevant the day a second device shows up. That future (laptop + phone
sharing one Supabase) is **design-only, deferred**; one file covers it as
forward-looking design, clearly labelled DESIGN-NOT-CODE.

## Reading order

```
  00-overview.md   ← start here. the coordination map + ranked findings
  audit.md         ← Pass 1: every distributed-systems lens, walked honestly
                       (mostly "not yet exercised")

  Pass 2 — the four things actually worth a deep walk:
  01-app-to-postgres-boundary.md          the only real client/server seam
  02-trace-sink-write-buffering.md        async writes, ordered by event time
  03-deferred-two-brain-shared-memory.md  DESIGN-NOT-CODE — the future
  04-scatter-gather-connector-fanout.md   concurrent web-search fan-out, new this cycle
```

## What's here vs not

| lens | verdict |
| --- | --- |
| client/server boundary (`pg.Pool`) | **present** → `01` |
| partial failure / timeouts / retries | thin — fail-fast, no acquire timeout, nothing retries → audit + `04` |
| idempotency / delivery semantics | storage-level yes (`ON CONFLICT`), request-level no → audit + `02` |
| consistency / staleness | trivially consistent — single writer, single reader → audit |
| replication / partitioning / quorums | `not yet exercised` |
| queues / streams / ordering / backpressure | `not yet exercised` (the trace sink is the closest thing → `02`) |
| clocks / coordination / leadership | logical clock absent; physical `event.timestamp` used for replay order → `02`, audit |
| sagas / outbox / cross-boundary workflows | `not yet exercised` (local transactions only) → audit |
| concurrent fan-out / partial failure across independent remotes | **present, new this cycle** — `/research`/`/investing` scatter-gather across 5 web-search APIs → `04` |

## Cross-links to the sibling guides

This guide owns **correctness across a coordination boundary**. It does not
re-teach what the neighbours own:

- **`study-system-design`** — the architectural shape and scale tradeoffs of
  buffr-laptop (the local-first-with-cloud-mirror design, the boundaries).
  When the question is "what's the shape," go there.
- **`study-database-systems`** — datastore-*local* consistency: Postgres
  transactions, isolation levels, the HNSW index, durability. When the
  question is "what does Postgres guarantee on one box," go there.
- **`study-debugging-observability`** — the trajectory capture in
  `agents.messages` as an *observability* artifact (what the trace sink writes
  and how you'd read it back). This guide covers the *write-ordering
  correctness* of that sink; the observability guide covers reading it.
- **`study-networking`** — the HTTP-level mechanics of each individual
  web-search connector call (retries, backoff, status codes, timeouts). This
  guide covers *coordination across* the five concurrent calls (isolation,
  classification, the missing deadline); the networking guide owns what
  happens inside any one of them.
