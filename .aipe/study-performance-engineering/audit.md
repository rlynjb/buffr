# Performance Audit — buffr-laptop (Pass 1)

The 8-lens walk. One `##` per lens. Each names what the code actually does, anchored to
`file:line`, or says `not yet exercised` and explains when it would start to matter. The
final lens ranks the risks. Significant findings cross-link to a Pass 2 pattern file
instead of being re-explained here.

The frame for every verdict: this is a **single-device, single-conversation** RAG agent.
No traffic, no SLA, no concurrency. The dominant per-turn cost is `gemma2:9b` generation
inside Ollama — owned by the model, not by this repo's code.

---

## 1. performance-budget

`not yet exercised` — there is no declared budget anywhere in the repo.

No p95/p99 target, no "a chat turn must complete within N seconds," no egress or token
quota, no memory ceiling. The chat UI (`src/cli/chat.tsx`) shows a spinner and waits as
long as the model takes; nothing enforces or even measures a deadline.

The one number that functions *like* a budget is the context-window guard:
`ContextWindowGuardedProvider(..., { maxTokens: 8192 })` at `src/session.ts:46`. That's a
correctness/cost cap on prompt size, not a latency budget — but it's the only explicit
"this many and no more" in the system.

**When it starts to matter:** the moment buffr serves more than one user, or wants to
promise interactive latency. Today the honest budget is "as fast as a local 9B model
runs," which is inherent and unbudgeted.

---

## 2. measurement-baselines-and-profiling

Partially exercised — one real baseline harness, zero profiling, and a baseline that's
**written to the DB and never read back.**

What exists:

- **A retrieval-quality baseline:** `src/cli/eval-cmd.ts` runs a labeled query set
  (`eval/queries.json`) and prints mean P@1 and R@3 (`eval-cmd.ts:22-33`). This is a
  *quality* baseline, not a *performance* one — it measures whether HNSW returns the right
  docs, not how fast. But it's the closest thing to a repeatable measurement in the repo,
  and it's the right place to bolt a latency timer onto.

- **Latency + token data captured but orphaned:** `SupabaseTraceSink` persists
  `event.durationMs` for every tool call (`src/supabase-trace-sink.ts:69`) and
  `tokensUsed` for every model call (`trace-sink.ts:76`) into `agents.messages`. The data
  lands in the database every turn — and **nothing ever queries it back.** No aggregation,
  no p50/p95, no "embedding got slower this week." The baseline exists as rows nobody reads.

What's missing: no profiler, no flame graph, no CPU/heap sampling, no before/after
evidence on any change. → `05-per-turn-memory-and-trace-cost` covers the write side of
that captured-but-unread data.

**The cheapest win in the whole repo lives here:** `SELECT avg(tokens_used), ...` over
`agents.messages` turns the already-written trace into a real baseline. The instrument is
installed; the dial just isn't being read.

---

## 3. latency-throughput-and-tail-behavior

`not yet exercised` for tail behavior; latency is observable but uncharacterized.

There is no throughput concern: one conversation, one turn at a time, held in-process by
the long-lived Ink session (`src/session.ts:34-76`). No queue, no fan-in, no contention.
"p95/p99" is undefined when N=1 — you need a distribution, and there's one user issuing
one serial request.

The latency that *does* exist, per turn, in order: `persistMessage` (1 INSERT) → embed
query (1 Ollama HTTP call) → HNSW search (1 SQL query) → `gemma2:9b` generation (the big
one, seconds) → `trace.flush()` (several INSERTs) → `memory.remember` (1 embed + 1 upsert).
Generation dominates by orders of magnitude; everything buffr controls is noise next to it.

**When tail behavior starts to matter:** under concurrency. With multiple turns in flight
the pg pool (default size) and Ollama's single-GPU serialization become the queue points.
Today neither is exercised.

---

## 4. cpu-memory-and-allocation

`not yet exercised` as a tuned concern — no measured CPU or memory pressure, no GC tuning,
no allocation profiling.

The notable allocation choice is benign at this scale: `toVectorLiteral` (`pg-vector-store.ts:15-17`)
builds a 768-element vector into a `[0.1,0.2,...]` text string on **every** upsert and
every search. That's a string allocation per vector crossing the pg wire. At hundreds of
chunks it's invisible; at bulk-load scale it's allocation churn worth noticing —
→ `03-per-chunk-insert-loop`.

The heaviest memory consumer by far is the `gemma2:9b` model weights resident in Ollama's
process — gigabytes — but that's Ollama's process, not buffr's, and is inherent to local
generation.

---

## 5. io-network-and-database-bottlenecks

The richest lens — this is where buffr's real performance character lives. Four distinct
I/O patterns, each with its own pattern file:

- **HNSW approximate search** (`pg-vector-store.ts:67-85`): the `<=>` cosine operator +
  `ORDER BY ... LIMIT k` is a sub-linear ANN scan — the main performance win in the system.
  But the index is **untuned**: `sql/001_agents_schema.sql:28-29` creates it with no
  `m` / `ef_construction`, and no `hnsw.ef_search` is ever set at query time.
  → `01-hnsw-approximate-search`.

- **Embedding roundtrip** (`index-cmd.ts:22-26`, the aptkit pipeline): embedding is
  **batched per document** — one `/api/embed` HTTP call carries all of a document's chunks.
  Efficient *within* a file. The real serialization is **across files**: the `for...await`
  loop processes file N+1 only after file N's commit returns, so the GPU sits idle through
  every database write. → `02-embedding-roundtrip`.

- **Per-chunk INSERT loop** (`pg-vector-store.ts:43-57`): `upsert` loops one parameterized
  INSERT per chunk inside a single transaction — no multi-row VALUES, no `COPY`. One wire
  round-trip per chunk. → `03-per-chunk-insert-loop`.

- **Connection pool reuse** (`db.ts:4-6`, `session.ts:39`): one warm `pg.Pool` created at
  session start and reused across every turn. The TCP+auth handshake is amortized to once
  per session — the most load-bearing latency *avoidance* in the repo.
  → `04-connection-pool-reuse`.

Plus the per-turn write amplification: each chat turn does an extra embed+upsert for
`memory.remember` (`session.ts:66`) and the trace sink writes up to 6 event types as
separate INSERTs (`trace-sink.ts:53-85`). → `05-per-turn-memory-and-trace-cost`.

---

## 6. caching-batching-and-backpressure

Mixed: batching is present (per-doc embeds), caching is entirely absent, backpressure is
`not yet exercised`.

- **Batching — present.** Embeddings are batched per document into one HTTP call (the
  aptkit pipeline behind `index-cmd.ts:24`). This is the one batching win the repo has.

- **Caching — absent.** No embed cache, no query cache, no result memoization. The same
  question typed twice re-embeds twice (`session.ts:60-71` → fresh embed every `ask()`),
  and the eval harness re-embeds every query on every run (`eval-cmd.ts:26`). Embeddings
  are deterministic for a fixed model+input — a textbook cacheable cost left on the table.
  → `06-no-caching`.

- **Backpressure — not yet exercised.** No bounded queue, no throttle, no overload mode.
  The trace sink collects pending writes in an unbounded array and `Promise.all`s them at
  flush (`trace-sink.ts:50, 91-93`) — fine for one turn's handful of events, but it's an
  unbounded buffer with no backpressure if event volume ever spiked.

---

## 7. rendering-client-and-mobile-performance

`not yet exercised` in the web/mobile sense — no bundle, no DOM, no 60fps budget.

The client is `src/cli/chat.tsx`, an Ink (React-in-terminal) app. Ink re-renders to the
terminal, which is cheap and never the bottleneck — the user is waiting on `gemma2`, not
on a render. There's no startup-time concern worth measuring (a Node CLI), no main-thread
contention, no mobile constraint. The frame-rate-latency work in Rein's portfolio (contrl)
lives in a different repo; this one has no rendering hot path.

---

## 8. performance-red-flags-audit

Ranked by consequence, each with its evidence — a real anchor or an explicitly-named
missing measurement.

```
  rank  red flag                         evidence                      verdict
  ────  ───────────────────────────────  ────────────────────────────  ─────────────────────
   1    GPU idles between files during   index-cmd.ts:22-26            REAL, fixable now.
        indexing (serial for-await;      (serial loop, embed and       The one place this
        no embed↔write overlap)          write don't overlap)          repo's own code leaves
                                                                        latency on the table.
   2    HNSW untuned (no m /             sql/001:28-29 (no WITH        LATENT. Defaults are
        ef_construction; no ef_search)   clause); no SET hnsw.*         fine now; recall/latency
                                         anywhere                       tradeoff is unmanaged
                                                                        past ~10^5 chunks.
   3    baseline written, never read     trace-sink.ts:69,76 write;    MISSING MEASUREMENT.
                                         no SELECT reads it back        Data is in the DB; the
                                                                        dial is just unread.
   4    no caching — identical query     session.ts:60; eval-cmd.ts:26 LOW. Deterministic
        re-embeds every time             (fresh embed each call)        embeds, trivially
                                                                        cacheable, ~free fix.
   5    per-chunk INSERT round-trips     pg-vector-store.ts:43-57      LOW now. Bites only at
        (no multi-row / COPY)            (one query() per chunk)        bulk-load scale.
   6    write amplification per turn     session.ts:66 + trace-sink    LOW. Extra embed+upsert
        (extra embed+upsert; 6-event     53-85 (≥1 INSERT per event)   + several INSERTs,
        trace)                                                         dwarfed by gemma2.
   7    no performance budget / SLA      (absent everywhere)           ACCEPTED. Correct for a
                                                                        single-device tool.
```

The honest top line: **only red flag #1 is worth acting on at current scale.** #2 and #3
are worth *knowing* — they're the things that bite first when the corpus or the user count
grows. The rest are correctly deprioritized below the inherent cost of running a 9B model
on a laptop.
