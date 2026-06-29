# Overview — Performance Engineering map for buffr-laptop

The one question this guide answers: **what is measurably slow or expensive, and which change improves it without moving the bottleneck?** And the honest framing up front — at laptop scale, single-device, one user, the dominant cost on every chat turn is `gemma2:9b` generation running inside Ollama. This repo does not own that cost. Everything else here is real, but most of it is deprioritized *because* the generation step dwarfs it.

## The whole system in one frame

```
  buffr-laptop — where time and money go on one chat turn

  ┌─ CLI layer (Ink TUI) ───────────────────────────────────────┐
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
| 2 | **Embedding is serialized across files at index time** — `for...await` in `index-cmd.ts`, GPU idle through each doc's DB writes | One file embeds, then writes, then the next file starts. The embed call itself is already batched per-doc | Indexing is a manual one-shot CLI, not a hot path. Real but low-priority. → `02` |
| 3 | **`upsert` loops one INSERT per chunk inside a txn** — no multi-row INSERT, no COPY | N round-trips to Postgres per document instead of 1 | A 20-chunk doc is 20 INSERTs. Tiny at laptop corpus size; the first thing to fix if indexing ever feels slow. → `03` |
| 4 | **Per-turn write amplification** — `memory.remember` adds an extra embed+INSERT, the trace sink fan-outs up to 6 INSERTs | Every chat turn does ~8 DB writes + 1 extra embed beyond the answer itself | All of it is dwarfed by generation. The extra embed is the only part on a model; still cheap. → `05` |
| 5 | **No caching** — an identical query re-embeds and re-searches every time | Repeated questions pay the full embed roundtrip again | One user, low repeat rate. A cache would help eval runs more than chat. → `06` |
| 6 | **`durationMs` + tokens are persisted but never read back** — written to `agents.messages`, never aggregated | The instrumentation exists; the measurement loop doesn't close | This is the gap that makes every "does it matter" answer here an estimate instead of a number. → audit lens 2 |

## not yet exercised

Be honest about what this repo has never done, because it changes how much any of the above can be trusted:

- **Load testing** — there is no representative workload runner. The only multi-query path is the eval harness (`eval-cmd.ts`), and that measures *precision*, not latency.
- **Profiling / flamegraphs** — no `--prof`, no `clinic`, no `0x`, no sampling profiler wired in. No before/after evidence exists for any optimization.
- **Performance budgets** — no p95/p99 target, no per-turn latency SLO, no cost ceiling. Nothing fails when a turn gets slow.
- **A caching layer** — embedding cache, query cache, and HTTP keep-alive tuning are all absent.
- **Tail-behavior measurement** — single-user means no contention, no queueing, no observed tail. p95/p99 are undefined because there's no distribution to measure.

The instrumentation half is further along than the measurement half: the trace sink already captures `durationMs` and token counts per event (`src/supabase-trace-sink.ts:67-78`). Nothing reads them back. Closing that loop is the highest-leverage move in the whole guide — it turns every estimate above into a number.

## Reading order

`audit.md` next for the full 8-lens walk, then the numbered pattern files in order. Cross-links to `study-database-systems`, `study-networking`, and `study-ai-engineering` throughout.
