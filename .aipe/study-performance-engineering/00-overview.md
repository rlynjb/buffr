# Overview — Performance Engineering map for buffr-laptop

The one question this guide answers: **what is measurably slow or expensive, and which change improves it without moving the bottleneck?** And the honest framing up front — at laptop scale, single-device, one user, the dominant cost on every chat turn is `gemma2:9b` generation running inside Ollama. This repo does not own that cost. Everything else here is real, but most of it is deprioritized *because* the generation step dwarfs it. The one place that framing shifts is `/research` and `/investing`: their evidence-gathering step is I/O-bound on external APIs, not on `gemma2:9b`, and it's genuinely concurrent (`07-connector-fan-out.md`) with a real cache in front of it (`08-connector-result-caching.md`) — two new findings this pass, both positive.

## The whole system in one frame

```
  buffr-laptop — where time and money go on one chat turn

  ┌─ CLI layer (OpenTUI) ───────────────────────────────────────┐
  │  src/cli/chat.tsx   user types a question                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │  ask(question)
  ┌─ Session layer ──────────▼──────────────────────────────────┐
  │  src/session.ts  createChatSession()                          │
  │   1. persistMessage(user)        → 1 INSERT                   │
  │   2. agent.answer(question)      → embed + HNSW search + GEN  │ ◄── gemma2:9b
  │   3. trace.flush()               → up to 6 INSERTs            │      DOMINATES
  │   4. memory.remember()           → 1 embed + 1 INSERT         │
  └───────────────────────────┬──────────────────────────────────┘
                  ┌───────────┴────────────┐
        HTTP      │                         │  pg (one warm Pool)
   ┌─ Provider ──▼──────┐         ┌─ Storage ▼──────────────────┐
   │  Ollama            │         │  Postgres + pgvector         │
   │  nomic-embed-text  │         │  agents.chunks (HNSW cosine) │
   │  gemma2:9b  ◄──────┼─cost──► │  agents.messages (trace)     │
   └────────────────────┘         └──────────────────────────────┘
```

The arrows that cost real wall-clock time: the embed roundtrips to Ollama, the HNSW search in pgvector, the generation call (the big one), and the fan-out of INSERTs at the end of the turn. The arrow that costs nothing measurable: anything in TypeScript between them.

## Ranked findings

Ordered by consequence. The verdict is first; the "does it matter at laptop scale" call is the load-bearing part.

| # | Finding | Cost | Matters at laptop scale? |
|---|---------|------|--------------------------|
| 1 | **Approximate nearest-neighbour search (the HNSW index) is untuned** — no `m`, `ef_construction`, or `ef_search` set | The sub-linear search *is the main retrieval win*, but recall/latency runs on pgvector defaults | The win is real and already paid for. Tuning matters only once the corpus grows past a few thousand chunks — `not yet measured`. → `01` |
| 2 | **Connector fan-out is genuinely concurrent, but unbounded per source** — `Collector.execute` runs N connector fetches via `Promise.all` | Positive: wall-clock cost is `max(latency)` across sources, not `Σ(latency)` — a real win on the one part of the pipeline that isn't `gemma2:9b`. Gap: no per-source timeout, so a slow connector sets the batch's tail | Real cost avoided today (2-5 sources). The gap is the thing to watch as more connectors get added. → `07` |
| 3 | **Embedding is serialized across files at index time** — `for...await` in `index-cmd.ts`, GPU idle through each doc's DB writes | One file embeds, then writes, then the next file starts. The embed call itself is already batched per-doc | Indexing is a manual one-shot CLI, not a hot path. Real but low-priority. → `02` |
| 4 | **`upsert` loops one INSERT per chunk inside a txn** — no multi-row INSERT, no COPY | N round-trips to Postgres per document instead of 1 | A 20-chunk doc is 20 INSERTs. Tiny at laptop corpus size; the first thing to fix if indexing ever feels slow. `PgJournalStore`'s single-row writes show this codebase doesn't loop by default — only where the write really is N rows. → `03` |
| 5 | **Per-turn write amplification** — `memory.remember` adds an extra embed+INSERT, the trace sink fan-outs up to 6 INSERTs | Every chat turn does ~8 DB writes + 1 extra embed beyond the answer itself | All of it is dwarfed by generation. The extra embed is the only part on a model; still cheap. → `05` |
| 6 | **No caching on the RAG path** — an identical query re-embeds and re-searches every time | Repeated questions pay the full embed roundtrip again | One user, low repeat rate. A cache would help eval runs more than chat. **Corrected this pass:** this used to also claim web search was uncached — it isn't (see #7). → `06` |
| 7 | **Connector results ARE cached — a TTL decorator around every external API** | Positive, newly documented: `CachedConnector` wraps Brave/Tavily/Google/Reddit/RSS/Trends with a 1hr TTL, shared across `/research` and `/investing` in one session | Directly protects the tightest quota (Google: 100/day). Session-scoped only — cold on every process restart. → `08` |
| 8 | **Connection-pool shutdown used to be unbounded — fixed this pass** — `pool.end()` could hang the CLI on `/exit` | Was: an availability bug, not a latency one — the process could freeze indefinitely. Now: two independent timeouts (1s inside `close()`, 1.5s hard deadline) bound the worst case | Fixed and worth knowing the shape of: bound the shutdown path the same way you'd bound anything else async. → `04` |
| 9 | **`durationMs` + tokens are persisted but never read back** — written to `agents.messages`, never aggregated | The instrumentation exists; the measurement loop doesn't close | This is the gap that makes every "does it matter" answer here an estimate instead of a number — including finding #2 above. → audit lens 2 |

## not yet exercised

Be honest about what this repo has never done, because it changes how much any of the above can be trusted:

- **Load testing** — there is no representative workload runner. The only multi-query path is the eval harness (`eval-cmd.ts`), and that measures *precision*, not latency.
- **Profiling / flamegraphs** — no `--prof`, no `clinic`, no `0x`, no sampling profiler wired in. No before/after evidence exists for any optimization.
- **Performance budgets on the hot path** — no p95/p99 target, no per-turn latency SLO, no cost ceiling. The one budget that does exist (the 1.5s shutdown deadline, finding #8) governs exit, not a turn.
- **A caching layer for the RAG path** — embedding cache and query-result cache are still absent (the connector tier now has one; the retrieval path doesn't). HTTP keep-alive tuning is also unexamined.
- **Tail-behavior measurement** — single-user means no contention, no queueing, no observed tail. p95/p99 are undefined because there's no distribution to measure. The connector fan-out (finding #2) is the one place a tail number would actually be informative, and it's the newest gap.
- **Per-source timeouts on the connector fan-out** — `Promise.all` over N connectors has no bound on any individual source; new since the two research engines landed.
- **Duration on `ProgressEvent`** — the live progress panel's `stage-start`/`stage-done`/`connector-start`/`connector-done` events carry labels and counts but no timestamps, so they don't double as the measurement instrumentation they resemble.

The instrumentation half is further along than the measurement half: the trace sink already captures `durationMs` and token counts per event (`src/supabase-trace-sink.ts:67-78`). Nothing reads them back. Closing that loop is the highest-leverage move in the whole guide — it turns every estimate above into a number, including the new connector-concurrency claim.

## Reading order

`audit.md` next for the full 8-lens walk, then the numbered pattern files in order — `01` through `06` are the original retrieval/indexing/chat-turn findings, `07` and `08` are the two new connector-layer patterns from the research engines. Cross-links to `study-database-systems`, `study-networking`, `study-ai-engineering`, `study-frontend-engineering`, and `study-debugging-observability` throughout.
